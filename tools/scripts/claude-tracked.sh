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

set +e
claude -p "${ARGS[@]}" --output-format json > "$TMP_JSON"
STATUS=$?
set -e

# ---- Single same-run retry on a zero-cost, zero-token failure (2026-08-23) ----
# Fleet audit found ~2s exit=1 failures scattered across sites (americastrikes,
# rodhat, sinderella), model=null, is_error=true, total_cost_usd=0 — the `claude`
# binary itself erroring before any billable work started (network preflight
# above already passed, so it's not the DNS-outage case). Every prior
# occurrence self-healed on the site's own next scheduled cron tick, which for
# hourly roles means up to ~an hour of lost turnaround for zero reason — a
# retry here is free (nothing was billed) and safe (nothing was done, so
# nothing to duplicate). Retrying only on a verified zero-cost failure, never
# on a real error that may have done partial billable work.
if [[ "$STATUS" -ne 0 ]]; then
  ZERO_COST_FAILURE=$(python3 -c "
import json, sys
try:
    with open('$TMP_JSON', encoding='utf-8') as fh:
        data = json.load(fh)
except Exception:
    print('0'); sys.exit()
cost = data.get('total_cost_usd') or 0
print('1' if data.get('is_error') and not cost else '0')
" 2>/dev/null || echo 0)
  if [[ "$ZERO_COST_FAILURE" == "1" ]]; then
    echo "claude-tracked.sh: zero-cost failure (exit=$STATUS) — retrying once (CRON_SITE=$CRON_SITE CRON_ROLE=$CRON_ROLE)" >&2
    sleep 3
    set +e
    claude -p "${ARGS[@]}" --output-format json > "$TMP_JSON"
    STATUS=$?
    set -e
  fi
fi

python3 - "$TMP_JSON" "$LEDGER" "$CRON_SITE" "$CRON_ROLE" "$STATUS" "$requested_model" "$requested_max_turns" "$REPO_ROOT" <<'PYEOF'
import json
import subprocess
import sys
import time

tmp_path, ledger_path, site, role, status, requested_model, requested_max_turns, repo_root = sys.argv[1:9]

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
PYEOF

exit "$STATUS"
