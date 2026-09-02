#!/usr/bin/env bash
# claude-tracked.sh: drop-in wrapper around `claude -p` that records real
# token usage/cost for the Fleet Dashboard AI Usage tab.
#
# Usage: identical to a normal `claude -p` invocation, e.g.
#   claude-tracked.sh "$PROMPT" --max-turns 15 --dangerously-skip-permissions --model claude-sonnet-4-6
#
# Requires two env vars from the caller (both already known at every
# call site — repo basename / the role name run-role.sh is dispatching):
#   CRON_SITE   e.g. americastrikes.com
#   CRON_ROLE   e.g. affiliate-editor
# Optional:
#   REPO_ROOT   defaults to $(pwd) — used to locate ops/logs/
#
# Behavior:
#   - Runs the real `claude` binary with any caller-supplied flags, but forces
#     --output-format json (any --output-format the caller passed is ignored/
#     overridden) so usage/cost survive.
#   - Prints .result to stdout, so existing `>> "$LOG"` / `| tee -a "$LOG"`
#     callers see the same human-readable text they saw with --output-format text.
#   - Appends one JSON line to ops/logs/token-usage-<UTC date>.jsonl with
#     site, role, model, token counts, cost, duration, and turn count.
#   - Exits with the real `claude` exit code.

set -euo pipefail

if [[ -z "${CRON_SITE:-}" || -z "${CRON_ROLE:-}" ]]; then
  echo "claude-tracked.sh: CRON_SITE and CRON_ROLE must be exported by the caller" >&2
  exit 64
fi

REPO_ROOT="${REPO_ROOT:-$(pwd)}"
LOG_DIR="$REPO_ROOT/ops/logs"
mkdir -p "$LOG_DIR"
LEDGER="$LOG_DIR/token-usage-$(date -u +%Y-%m-%d).jsonl"

# Strip any --output-format (and its value) the caller passed — we own that flag.
ARGS=()
skip_next=0
requested_model=""
requested_max_turns=""
for arg in "$@"; do
  if [[ $skip_next -eq 1 ]]; then
    skip_next=0
    continue
  fi
  case "$arg" in
    --output-format)
      skip_next=1
      continue
      ;;
    --output-format=*)
      continue
      ;;
  esac
  ARGS+=("$arg")
done

# Keep the caller's intent alongside Claude's observed modelUsage result.  The
# CLI may resolve aliases or apply account-level routing, so the two fields are
# intentionally separate rather than overwriting the observed model below.
for ((i = 0; i < ${#ARGS[@]}; i++)); do
  case "${ARGS[$i]}" in
    --model)
      requested_model="${ARGS[$((i + 1))]:-}"
      ;;
    --model=*)
      requested_model="${ARGS[$i]#--model=}"
      ;;
    --max-turns)
      requested_max_turns="${ARGS[$((i + 1))]:-}"
      ;;
    --max-turns=*)
      requested_max_turns="${ARGS[$i]#--max-turns=}"
      ;;
  esac
done

# ── never let a role fall through to the CLI's default model ────────────────
# A role that passes no --model gets whatever `claude -p` defaults to. On this
# host that is settings.json's "model": "sonnet" — an ALIAS, not a version. It
# silently re-points at whatever the latest Sonnet is, so the fleet's agent
# runtime can change under 29 scheduled services without a single line of code
# changing, and the AI-usage audit reports them as "Claude CLI default
# (unpinned)".
#
# Measured 2026-08-23: 29 scheduled services across 17 sites were unpinned.
# They came from a common shape — run-role.sh sets MODEL per role in a
# `case "$ROLE"` block, and any role missing from that block falls through with
# MODEL="" and no flag. Six different dispatch shapes exist across the fleet,
# so pinning each site separately would have been 17 fragile edits; every one
# of those 29 calls goes through THIS wrapper, so one default here covers all
# of them and every future role that forgets.
#
# Behaviour-neutral on the day it landed: the "sonnet" alias already resolved
# to claude-sonnet-4-6, which is also the fleet's dominant pin (22 engineers,
# 26 watchdogs, 7 seo-analysts). This stops the drift; it does not change what
# runs today.
#
# An explicit --model from the caller always wins — this only fills a gap.
# Override the fleet default with CLAUDE_TRACKED_DEFAULT_MODEL.
FLEET_DEFAULT_MODEL="${CLAUDE_TRACKED_DEFAULT_MODEL:-claude-sonnet-4-6}"
if [[ -z "$requested_model" ]]; then
  requested_model="$FLEET_DEFAULT_MODEL"
  ARGS+=(--model "$FLEET_DEFAULT_MODEL")
  echo "claude-tracked.sh: no --model from caller (CRON_SITE=$CRON_SITE CRON_ROLE=$CRON_ROLE) — pinning fleet default $FLEET_DEFAULT_MODEL" >&2
fi

# ---- Network preflight (2026-08-19 DNS-outage hardening) ----
# Single choke point for every caller fleet-wide (run-role.sh, run-engineer.sh,
# watchdog.sh, run-news-writer.sh, run-breaking-news.sh, run-product-scout.sh,
# run-guide-writer.sh/-seeder.sh, run-catalog-editor.sh, deploy.sh, ...) — this
# is the ONE claude-tracked.sh in the repo, bind-mounted into every container.
# 2026-08-19: a host reboot broke container DNS; every 30-min engineer/watchdog
# tick still ran the full `claude -p` call, hung ~200s on dead DNS, then
# failed — 120+ wasted calls fleet-wide in a day, zero work done. That case is
# now guarded per-caller in run-engineer.sh/watchdog.sh too, but any other
# role hitting the same outage was NOT — fixing it here closes that for good,
# for every caller, present and future, in one place. A dead network never
# reaches `claude -p`; it's logged to the ledger as a real (zero-cost) failed
# attempt and returned fast so the caller's normal retry-next-tick logic runs.
if ! curl -sS --connect-timeout 3 --max-time 5 -o /dev/null "https://api.anthropic.com/" 2>/dev/null; then
  echo "claude-tracked.sh: network preflight failed — skipping claude -p call (CRON_SITE=$CRON_SITE CRON_ROLE=$CRON_ROLE)" >&2
  python3 - "$LEDGER" "$CRON_SITE" "$CRON_ROLE" "$requested_model" "$requested_max_turns" <<'PYEOF'
import json, sys, time
ledger_path, site, role, requested_model, requested_max_turns = sys.argv[1:6]
record = {
    "recorded_at_unix": int(time.time()),
    "site": site,
    "role": role,
    "model": None,
    "requested_model": requested_model or None,
    "requested_max_turns": int(requested_max_turns) if requested_max_turns.isdigit() else None,
    "subtype": "network_preflight_failed",
    "is_error": True,
    "exit_status": 78,
    "num_turns": None,
    "duration_ms": None,
    "total_cost_usd": 0,
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "session_id": None,
}
with open(ledger_path, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(record, sort_keys=True) + "\n")
PYEOF
  exit 78
fi

TMP_JSON="$(mktemp)"
trap 'rm -f "$TMP_JSON"' EXIT

# Claude Code 2.1.x reports several account-level failures with the internally
# contradictory shape `subtype=success, is_error=true, exit=1`.  The useful
# explanation lives only in `.result` (for example, "out of extra usage" or
# "OAuth access token has expired").  Classify that field explicitly instead
# of treating every zero-cost failure as a transient CLI crash.
classify_claude_result() {
  python3 - "$1" <<'PYEOF'
import json
import re
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        data = json.load(fh)
except Exception:
    print("parse_error")
    raise SystemExit

if not data.get("is_error"):
    print("none")
    raise SystemExit

message = str(data.get("result") or "")
if re.search(r"out of (?:extra )?usage|usage limit|limit reached.*resets|resets .*(?:am|pm)", message, re.I):
    print("account_usage_exhausted")
elif (
    re.search(r"not logged in|please run /login|failed to authenticate|authentication_error", message, re.I)
    or re.search(r"oauth.*(?:expired|revoked|could not be refreshed|refresh failed)", message, re.I)
    or re.search(r"invalid.*api.?key", message, re.I)
):
    print("authentication_failed")
elif not (data.get("total_cost_usd") or 0):
    print("zero_cost_failure")
else:
    print("execution_failure")
PYEOF
}

# ---- Cross-container OAuth refresh mutex (2026-09-01) ----
# Every worker container in the fleet bind-mounts the SAME
# ~/.claude/.credentials.json read-write. The CLI reads that file at startup and,
# when the access token is close to expiry, refreshes it -- and the refresh
# ROTATES the refresh token. If two containers read the file before either has
# rotated, the second one presents a refresh token the server has already
# retired, which reads as token reuse and revokes the whole family. Everyone in
# the window then dies on "401 OAuth access token has been revoked".
#
# That is exactly what happened on 2026-09-01 12:00 UTC: 22 promoter containers
# started within 5 seconds of each other (the archetype had shipped a literal
# `0 8 * * 2,5` and every install stamped it verbatim), and took two unrelated
# roles down with them. Staggering the crons makes it improbable; this makes it
# impossible, for any co-firing from any cause.
#
# The lock is held only across the CLI's startup/auth window, NOT for the whole
# session -- serializing every model call fleet-wide would be far worse than the
# bug. One process at a time reads-and-maybe-rotates the credential; the next
# one starts afterwards and therefore reads the rotated file rather than a stale
# copy of it.
#
# flock(2) on the bind-mounted lock file works across containers because they
# share the host inode. Lock failures are fail-CLOSED by default. Running
# unlocked after a missing mount, missing flock binary, or queue timeout would
# silently recreate the refresh-token race this mutex exists to prevent. The
# explicit `none` value remains available for controlled diagnostics/tests.
CLAUDE_AUTH_LOCK="${CLAUDE_AUTH_LOCK:-$HOME/.claude/.credentials.lock}"
# Window/wait are sized against each other on purpose. The auth handshake is one
# HTTPS round trip at process start -- the 2026-09-01 failures all died 2.0-2.6s
# in -- so 12s is generous cover. The wait must then exceed (worst realistic
# burst - 1) * window, or the tail of a burst times out. The default wait is
# sized for the former 22-site burst: 22 * 12s = 264s, inside 600s.
# Raise the wait, not the window, if a role set ever grows past ~50 sites.
CLAUDE_AUTH_LOCK_WAIT="${CLAUDE_AUTH_LOCK_WAIT:-600}"    # seconds to queue behind others
CLAUDE_AUTH_WINDOW="${CLAUDE_AUTH_WINDOW:-12}"           # seconds to hold past process start

run_claude_locked() {
  local lockfd="" pid rc=0 waited=0

  # `exec {fd}>file` must carry NO other redirection: `exec` with redirections
  # and no command applies them to the SHELL, permanently -- an appended
  # `2>/dev/null` here silently discards every later diagnostic this script
  # writes, including the claude CLI's own stderr. So probe writability first
  # and let the exec stand alone.
  if [[ "${CLAUDE_AUTH_LOCK}" != "none" ]] && command -v flock >/dev/null 2>&1; then
    if [[ -e "$CLAUDE_AUTH_LOCK" ]] || : > "$CLAUDE_AUTH_LOCK" 2>/dev/null; then
      exec {lockfd}>>"$CLAUDE_AUTH_LOCK" || lockfd=""
    fi
  fi

  if [[ "${CLAUDE_AUTH_LOCK}" != "none" && -z "$lockfd" ]]; then
    if [[ "${CLAUDE_AUTH_LOCK_FAIL_OPEN:-0}" == "1" ]]; then
      echo "claude-tracked.sh: auth mutex unavailable — proceeding unlocked by explicit override (CRON_SITE=$CRON_SITE CRON_ROLE=$CRON_ROLE)" >&2
    else
      echo "claude-tracked.sh: auth mutex unavailable — refusing to start Claude (lock=$CLAUDE_AUTH_LOCK, CRON_SITE=$CRON_SITE CRON_ROLE=$CRON_ROLE)" >&2
      return 75
    fi
  fi

  if [[ -n "$lockfd" ]]; then
    if ! flock -w "$CLAUDE_AUTH_LOCK_WAIT" -x "$lockfd" 2>/dev/null; then
      exec {lockfd}>&-
      lockfd=""
      if [[ "${CLAUDE_AUTH_LOCK_FAIL_OPEN:-0}" == "1" ]]; then
        echo "claude-tracked.sh: auth mutex timed out after ${CLAUDE_AUTH_LOCK_WAIT}s — proceeding unlocked by explicit override (CRON_SITE=$CRON_SITE CRON_ROLE=$CRON_ROLE)" >&2
      else
        echo "claude-tracked.sh: auth mutex timed out after ${CLAUDE_AUTH_LOCK_WAIT}s — refusing to start Claude (CRON_SITE=$CRON_SITE CRON_ROLE=$CRON_ROLE)" >&2
        return 75
      fi
    fi
  fi

  # NOTE: this function must not touch `set -e`. The callers below wrap it in
  # their own `set +e`, and re-enabling errexit in here would leak out and abort
  # the script the moment a failing call returned -- losing the ledger row for
  # exactly the failures the ledger exists to record.
  claude -p "${ARGS[@]}" --output-format json > "$TMP_JSON" &
  pid=$!

  if [[ -n "$lockfd" ]]; then
    # Release as soon as the auth window has passed, or earlier if the call has
    # already finished (the ~2s auth failures this guards against exit well
    # inside the window).
    while (( waited < CLAUDE_AUTH_WINDOW )) && kill -0 "$pid" 2>/dev/null; do
      sleep 1
      waited=$(( waited + 1 ))
    done
    flock -u "$lockfd" 2>/dev/null || true
    exec {lockfd}>&-
  fi

  wait "$pid"
  rc=$?
  return "$rc"
}

set +e
run_claude_locked
STATUS=$?
set -e

FAILURE_CLASS="$(classify_claude_result "$TMP_JSON")"

# ---- Single same-run retry on a zero-cost, zero-token failure (2026-08-23) ----
# Fleet audit found ~2s exit=1 failures scattered across sites (americastrikes,
# rodhat, sinderella), model=null, is_error=true, total_cost_usd=0 — the `claude`
# binary itself erroring before any billable work started (network preflight
# above already passed, so it's not the DNS-outage case). Every prior
# occurrence self-healed on the site's own next scheduled cron tick, which for
# hourly roles means up to ~an hour of lost turnaround for zero reason — a
# retry here is free (nothing was billed) and safe (nothing was done, so
# nothing to duplicate). Retrying only on an UNCLASSIFIED zero-cost failure,
# never on deterministic account exhaustion/authentication errors (which do
# not heal three seconds later) or a real error that may have done partial
# billable work.
#
# parse_error also retries here (2026-08-26): every worker container copies
# the HOST's ~/.claude.json into its own /home/ops/.claude.json on startup
# (see entrypoint-worker.sh). A concurrent host-side `claude` write can leave
# that shared file transiently non-JSON, which the CLI reports as a
# "Configuration error" text blob instead of JSON — our own parse failure,
# not a real model error. Observed 2026-08-26 06:00-06:05 hitting three sites
# (americastrikes, reviewtattoo, totaljerks) at once from one bad host write;
# the host file self-healed within minutes on its own next `claude` call. A
# same-run retry a few seconds later is free (nothing was billed) and usually
# lands after the host file has been rewritten cleanly.
if [[ "$STATUS" -ne 0 ]]; then
  if [[ "$FAILURE_CLASS" == "zero_cost_failure" || "$FAILURE_CLASS" == "parse_error" ]]; then
    echo "claude-tracked.sh: $FAILURE_CLASS (exit=$STATUS) — retrying once (CRON_SITE=$CRON_SITE CRON_ROLE=$CRON_ROLE)" >&2
    sleep "${CLAUDE_TRACKED_RETRY_DELAY_SECONDS:-3}"
    set +e
    run_claude_locked
    STATUS=$?
    set -e
    FAILURE_CLASS="$(classify_claude_result "$TMP_JSON")"
  fi
fi

python3 - "$TMP_JSON" "$LEDGER" "$CRON_SITE" "$CRON_ROLE" "$STATUS" "$requested_model" "$requested_max_turns" "$REPO_ROOT" "$FAILURE_CLASS" <<'PYEOF'
import json
import subprocess
import sys
import time

tmp_path, ledger_path, site, role, status, requested_model, requested_max_turns, repo_root, failure_class = sys.argv[1:10]
failure_class = None if failure_class == "none" else failure_class

# ---- Model-drift alert (2026-08-20) ----
# The CLI may resolve --model to something other than what was requested
# (account-level routing, alias resolution). Usually harmless, but the
# 2026-08-19 americastrikes.com incident showed it silently swapping a
# requested sonnet-4-6 into claude-opus-4-7[1m] on ~20% of breaking-news
# calls — 5-60x the intended per-token cost, undetected for weeks because
# nothing compared requested vs. actual. This flags any requested/actual
# family mismatch (opus vs sonnet vs haiku) in the ledger record AND
# posts a one-line best-effort Slack alert so it surfaces same-day, not
# next month's manual audit. Never fails the run over this — notify is
# fire-and-forget.
def _model_family(name):
    if not name:
        return None
    lowered = name.lower()
    for family in ("opus", "sonnet", "haiku"):
        if family in lowered:
            return family
    return None


def _check_model_drift(requested_model, actual_model, site, role, repo_root):
    req_family = _model_family(requested_model)
    actual_family = _model_family(actual_model)
    if not req_family or not actual_family or req_family == actual_family:
        return False
    notify = f"{repo_root}/ops/scripts/notify-slack.sh"
    channel = "domain-" + site.replace(".", "-")
    text = (
        f":rotating_light: *{site}* `{role}` requested `{requested_model}` "
        f"but the CLI ran `{actual_model}` — model drift, check cost impact."
    )
    try:
        subprocess.run(
            [notify, channel, text, "danger"],
            timeout=10, check=False,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass
    return True

try:
    with open(tmp_path, encoding="utf-8") as fh:
        raw = fh.read()
    data = json.loads(raw)
except (OSError, json.JSONDecodeError):
    data = None

if data is not None:
    sys.stdout.write(data.get("result", ""))
    error_message = " ".join(str(data.get("result") or "").split())[:500] or None
    usage = data.get("usage", {}) or {}
    model_usage = data.get("modelUsage", {}) or {}
    # modelUsage can hold more than one model per session — e.g. Claude
    # Code's own auto-compact/summarization step runs on a small internal
    # model separately from whatever --model the caller requested. Picking
    # next(iter(...)) grabbed whichever key happened to serialize first,
    # which on long/near-context-limit sessions was consistently the
    # compaction model (observed: reviewtattoo.com content-writer logged
    # "model": "claude-haiku-4-5-20251001" against a --model
    # claude-sonnet-4-6 request on every run that hit max-turns — 2026-08-15
    # investigation). Pick by total token volume instead so the recorded
    # model reflects who actually did the work, not compaction noise.
    def _model_tokens(entry):
        if not isinstance(entry, dict):
            return 0
        return sum(v for v in entry.values() if isinstance(v, (int, float)))
    model = None
    if model_usage:
        model = max(model_usage, key=lambda m: _model_tokens(model_usage[m]))
    model = model or data.get("model")
    model_drift = _check_model_drift(requested_model, model, site, role, repo_root)
    record = {
        "recorded_at_unix": int(time.time()),
        "site": site,
        "role": role,
        "model": model,
        "model_usage": model_usage or None,
        "model_drift": model_drift,
        "requested_model": requested_model or None,
        "requested_max_turns": int(requested_max_turns) if requested_max_turns.isdigit() else None,
        "subtype": data.get("subtype"),
        "failure_class": failure_class,
        "error_message": error_message if data.get("is_error") else None,
        "is_error": data.get("is_error"),
        "exit_status": int(status),
        "num_turns": data.get("num_turns"),
        "duration_ms": data.get("duration_ms"),
        "total_cost_usd": data.get("total_cost_usd"),
        "input_tokens": usage.get("input_tokens"),
        "output_tokens": usage.get("output_tokens"),
        "cache_creation_input_tokens": usage.get("cache_creation_input_tokens"),
        "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
        "session_id": data.get("session_id"),
    }
else:
    # claude produced no parseable JSON (crash, timeout kill, etc). Still
    # record the attempt so the ledger reflects failed calls, not silence.
    record = {
        "recorded_at_unix": int(time.time()),
        "site": site,
        "role": role,
        "model": None,
        "requested_model": requested_model or None,
        "requested_max_turns": int(requested_max_turns) if requested_max_turns.isdigit() else None,
        "subtype": "parse_error",
        "failure_class": failure_class or "parse_error",
        "error_message": None,
        "is_error": True,
        "exit_status": int(status),
        "num_turns": None,
        "duration_ms": None,
        "total_cost_usd": None,
        "input_tokens": None,
        "output_tokens": None,
        "cache_creation_input_tokens": None,
        "cache_read_input_tokens": None,
        "session_id": None,
    }

with open(ledger_path, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(record, sort_keys=True) + "\n")

# ── explain a failure IN THE ROLE LOG, not only in the ledger ───────────────
# Role wrappers alert Slack by quoting the last few lines of the role log. Until
# now the reason for a failure only ever reached the LEDGER, so an alert read:
#
#     :x: newmomshop.com engineer failed (exit=1)
#     --- Wrote 19 picks ... [run-role] engineer: invoking Claude --- exit=1
#
# ...which is indistinguishable from a crash. The actual cause was
# subtype=error_max_turns: the role hit its 21-turn cap on a large task, and the
# NEXT scheduled run completed the work normally. Benign, self-healing, and
# alarming for no reason — someone reading that at 8pm cannot tell it apart from
# a broken deploy.
#
# Printing the reason on stderr puts it in the role log, so every existing
# alerter picks it up with no per-site change — the same central-fix approach
# used for the model pin.
if record.get("is_error") or int(status or 0) != 0:
    sub = record.get("subtype") or "unknown"
    failure = record.get("failure_class") or sub
    turns = record.get("num_turns")
    cap = requested_max_turns or "?"
    EXPLAIN = {
        "account_usage_exhausted": (
            "the shared Claude account is out of usage; no model work ran. "
            "The fleet auth monitor owns the outage/recovery alert."
        ),
        "authentication_failed": (
            "the shared Claude credentials are expired, revoked, or logged out; no model work ran. "
            "The fleet auth monitor owns the outage/recovery alert."
        ),
        "zero_cost_failure": "the Claude CLI failed before model execution; no tokens were spent.",
        # Deliberately no longer says "the next scheduled run normally finishes
        # the work". On 2026-09-02 girlpain's engineer hit this cap and the next
        # seven runs did NOT finish the work — they re-entered the same repair
        # loop, because a role that is stuck cannot tell itself apart from a role
        # that is merely slow, and this message told everyone reading the channel
        # to expect the former to resolve itself. Raising the cap on a looping
        # role just buys the loop more turns.
        "error_max_turns": (
            f"hit its turn cap ({turns}/{cap}) — the run was truncated, NOT a crash. "
            "If this is the FIRST time for this role, the next run usually finishes "
            "the work and no action is needed. If it REPEATS, the role is looping "
            "on something it cannot fix and a bigger cap will not help — read "
            "ops/board/ and the last run's log and find what it keeps retrying."
        ),
        "error_during_execution": "the model errored mid-run; usually transient, retried next tick.",
        "network_preflight_failed": "no network before the call was made — no tokens were spent.",
        "parse_error": "the CLI returned output this wrapper could not parse; see the raw log.",
    }
    why = EXPLAIN.get(failure, EXPLAIN.get(sub, f"subtype={sub}"))
    detail = record.get("error_message")
    if detail:
        why = f"{why} Claude said: {detail}"
    print(
        f"claude-tracked.sh: FAILURE REASON — {why} "
        f"(site={site} role={role} class={failure} subtype={sub} turns={turns} exit={status})",
        file=sys.stderr,
    )
PYEOF

exit "$STATUS"
