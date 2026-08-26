#!/usr/bin/env bash
# AI Optimizer implementer — applies ONE human-approved cost fix, canary-first.
#
# Runs only against queue/approved/. Nothing reaches this script that a human
# has not explicitly approved in the Fleet Dashboard.
#
# GUARDRAILS (each one is here for a reason, do not casually relax them):
#   * ONE ticket per run. Blast radius over throughput.
#   * ONE canary site per run, even for a fleet-scope ticket. After the canary
#     verifies, a NEW fan-out ticket is filed that needs its own approval —
#     two human yeses for anything that touches the whole fleet. This is the
#     shape Jesse asked for in June 2026 when he rejected a one-shot fleet
#     re-stamp tool: the risk was "clobbering legitimate per-site tuning".
#   * risk:high tickets are NEVER auto-applied. They are left approved and
#     flagged for a human to drive by hand.
#   * A dirty working tree aborts the run — we will not mix our change into
#     someone else's uncommitted work, and we must be able to revert cleanly.
#   * The session commits; only THIS script pushes, and only after the commit
#     is confirmed to exist.
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
TOOL_DIR="$DOMAINS_ROOT/tools/ai-optimizer"
LOG="${AI_IMPL_LOG:-$TOOL_DIR/implement.log}"
LOCK="${AI_IMPL_LOCK:-$TOOL_DIR/.implement.lock}"
MAX_TURNS="${AI_IMPL_MAX_TURNS:-50}"
TIMEOUT="${AI_IMPL_TIMEOUT:-3000}"
NOTIFY_ENABLED="${AI_IMPL_NOTIFY:-1}"
DRY_RUN="${AI_IMPL_DRY_RUN:-0}"
LOG_MAX_BYTES="${AI_IMPL_LOG_MAX_BYTES:-5242880}"

[[ -f "$TOOL_DIR/.implement-disabled" ]] && exit 0

exec 9>"$LOCK"
flock -n 9 || exit 0

if [[ -f "$LOG" ]]; then
  sz="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  [[ "$sz" =~ ^[0-9]+$ ]] && (( sz > LOG_MAX_BYTES )) && mv -f "$LOG" "$LOG.1"
fi
log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

[[ -f "$DOMAINS_ROOT/.env" ]] && { set -a; . "$DOMAINS_ROOT/.env"; set +a; }

# Give claude -p a writable config dir — fleet-cron's ~/.claude is RO and every
# Bash tool call would otherwise die with EROFS. See the helper for the full why.
source "$DOMAINS_ROOT/tools/scripts/ai-optimizer-claude-env.sh"
ai_optimizer_claude_env

# --- Pick the oldest approved, auto-appliable ticket -----------------------
PICK="$(python3 - <<'PY'
import sys
sys.path.insert(0, "/home/jesse/projects/domains/tools/ai-optimizer/lib")
import ai_optimizer as q
rows = q.list_tickets(status="approved")
# risk:high never auto-applies — a human drives those.
ok = [r for r in rows if (r.get("risk") or "").lower() != "high"]
ok.sort(key=lambda r: (r.get("created") or "", r["file"]))
if not ok:
    blocked = [r for r in rows if (r.get("risk") or "").lower() == "high"]
    print("NONE|" + ("|".join(r["file"] for r in blocked)))
else:
    r = ok[0]
    site = (r.get("sites") or ["-"])[0]
    print(f"{r['file']}|{site}|{r.get('scope')}|{len(r.get('sites') or [])}")
PY
)"

IFS='|' read -r TICKET CANARY SCOPE NSITES <<<"$PICK"
if [[ "$TICKET" == "NONE" ]]; then
  [[ -n "$CANARY" ]] && log "no auto-appliable ticket (risk:high awaiting a human: $CANARY)"
  exit 0
fi
log "=== implementing $TICKET (canary=$CANARY scope=$SCOPE sites=$NSITES) ==="

if [[ "$DRY_RUN" == "1" ]]; then
  log "DRY_RUN=1 — would implement $TICKET on $CANARY; stopping"
  exit 0
fi

# --- Refuse to work on a dirty tree ---------------------------------------
SITE_DIR="$DOMAINS_ROOT/sites/$CANARY"
if [[ "$CANARY" != "-" && -d "$SITE_DIR" ]]; then
  WORK_DIR="$SITE_DIR"
else
  WORK_DIR="$DOMAINS_ROOT"
fi

# --- Skip if a prior run already committed this ticket ---------------------
# A commit can land (and get pushed) but the ticket still gets left in
# approved/ if the session's shell dies right after (EROFS tmpdir, a DNS
# blip on push-check, an auth outage) before it can move the file. Every
# retry after that re-runs a no-op session and re-fires the Slack alert.
# implement.md requires the implementer to cite the ticket id in its commit
# message, so check for that before spending another session on it.
EXISTING_SHA="$(git -C "$WORK_DIR" log --all --grep="$TICKET" --format=%H -1 2>/dev/null)"
if [[ -n "$EXISTING_SHA" ]]; then
  log "ticket already applied in existing commit ${EXISTING_SHA:0:8} — closing without a new session"
  python3 "$TOOL_DIR/cli.py" move "$TICKET" --to applied \
    --commit "${EXISTING_SHA:0:8}" --by "ai-optimizer-implement" \
    --note "detected already applied (pre-check) on $CANARY" >>"$LOG" 2>&1
  exit 0
fi

if [[ "$CANARY" != "-" && -d "$SITE_DIR" ]]; then
  if [[ -n "$(git -C "$SITE_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
    log "ABORT: $CANARY has uncommitted changes — refusing to mix our change into them"
    exit 0
  fi
else
  if [[ -n "$(git -C "$DOMAINS_ROOT" status --porcelain --untracked-files=no -- tools/ 2>/dev/null)" ]]; then
    log "ABORT: tools/ has uncommitted changes — refusing to mix our change into them"
    exit 0
  fi
fi
BEFORE_SHA="$(git -C "$WORK_DIR" rev-parse HEAD 2>/dev/null)"
# Snapshot untracked paths so a later revert can delete ONLY what this session
# created. A blanket `git clean -fd` would also take untracked files that were
# already here before we ran (the start-of-run dirty check deliberately ignores
# untracked, so there can legitimately be some).
BEFORE_UNTRACKED="$(git -C "$WORK_DIR" ls-files --others --exclude-standard | sort)"

TICKET_BODY="$(python3 "$TOOL_DIR/cli.py" show "$TICKET" 2>>"$LOG")"
if [[ -z "$TICKET_BODY" ]]; then
  log "ABORT: could not read ticket $TICKET"
  exit 0
fi

# --- The implementer session ----------------------------------------------
export CRON_SITE="_fleet"
export CRON_ROLE="ai-optimizer-implement"
export REPO_ROOT="$DOMAINS_ROOT"
CLAUDE_TRACKED="$DOMAINS_ROOT/tools/scripts/claude-tracked.sh"

PROMPT="$(cat "$TOOL_DIR/implement.md")

## The approved ticket

\`\`\`
$TICKET_BODY
\`\`\`

## This run

- Canary site: **$CANARY**  (ticket scope: $SCOPE, names $NSITES site(s))
- Work in: $WORK_DIR
- Change ONLY this site. Do not fan out.

Today is $(date -Iseconds). Begin."

cd "$WORK_DIR"
timeout "$TIMEOUT" "$CLAUDE_TRACKED" "$PROMPT" \
  --max-turns "$MAX_TURNS" \
  --dangerously-skip-permissions \
  --model claude-sonnet-4-6 \
  >> "$LOG" 2>&1
rc=$?
AFTER_SHA="$(git -C "$WORK_DIR" rev-parse HEAD 2>/dev/null)"
log "implementer session exit=$rc  before=$BEFORE_SHA after=$AFTER_SHA"

notify() {
  [[ "$NOTIFY_ENABLED" == "1" && -n "${SLACK_BOT_TOKEN:-}" ]] || return 0
  timeout 30 python3 "$DOMAINS_ROOT/tools/role-notify/notify_role.py" \
    --mode structured --site "_fleet" --role "ai-optimizer" --status "$1" \
    --headline "$2" --detail "$3" \
    --channel-env AI_OPT_CHANNEL --channel-default "domain-ops" >/dev/null 2>&1 || true
}

# --- No commit means nothing was applied ----------------------------------
if [[ "$BEFORE_SHA" == "$AFTER_SHA" ]]; then
  # Abandoned (ticket didn't match reality) or failed. Either way the ticket
  # stays approved for a human to look at — we do NOT silently reject it.
  if [[ -n "$(git -C "$WORK_DIR" status --porcelain)" ]]; then
    # Revert BOTH tracked edits and any new files the session created. The
    # first cut only ran `git checkout -- .`, which reverts tracked files and
    # leaves untracked ones behind — the 2026-08-25 run left an orphan
    # ops/scripts/filter-feed.py sitting in the tree after its edits were
    # rolled back, i.e. a half-applied change that no ticket describes. Either
    # the whole change lands as a commit or none of it stays.
    log "session left uncommitted changes and no commit — reverting to keep the tree clean"
    git -C "$WORK_DIR" checkout -- . 2>>"$LOG"
    AFTER_UNTRACKED="$(git -C "$WORK_DIR" ls-files --others --exclude-standard | sort)"
    while IFS= read -r f; do
      [[ -n "$f" ]] || continue
      log "removing session-created file: $f"
      rm -f "$WORK_DIR/$f" 2>>"$LOG"
    done < <(comm -13 <(printf '%s\n' "$BEFORE_UNTRACKED") <(printf '%s\n' "$AFTER_UNTRACKED"))
  fi
  log "no commit produced — leaving $TICKET approved for human review"
  notify warn "AI-cost fix not applied: $TICKET" \
    "The implementer produced no commit (abandoned or failed). Ticket left *approved* for a human. See tools/ai-optimizer/implement.log"
  exit 0
fi

# --- Push, then record the ticket as applied ------------------------------
if ! git -C "$WORK_DIR" push >>"$LOG" 2>&1; then
  log "push FAILED — commit $AFTER_SHA is local only"
  notify fail "AI-cost fix committed but PUSH FAILED" \
    "Ticket \`$TICKET\` on *$CANARY*, commit \`${AFTER_SHA:0:8}\` is local-only. Needs a human."
  exit 0
fi

# Bump the submodule pointer so the change is actually visible fleet-side.
if [[ "$WORK_DIR" != "$DOMAINS_ROOT" ]]; then
  git -C "$DOMAINS_ROOT" add "sites/$CANARY" >>"$LOG" 2>&1
  git -C "$DOMAINS_ROOT" commit -q -m "chore: bump $CANARY pointer — ai-optimizer applied $TICKET" >>"$LOG" 2>&1
  git -C "$DOMAINS_ROOT" push >>"$LOG" 2>&1 || log "parent-repo push failed (submodule commit is pushed)"
fi

python3 "$TOOL_DIR/cli.py" move "$TICKET" --to applied \
  --commit "${AFTER_SHA:0:8}" --by "ai-optimizer-implement" \
  --note "applied to canary $CANARY" >>"$LOG" 2>&1
log "APPLIED $TICKET on $CANARY as ${AFTER_SHA:0:8}"

# --- Canary verified: ask for a SECOND approval before fanning out --------
# This is the gate that makes fleet-wide changes safe: the canary is real,
# committed, and pushed, and a human still has to say yes again before the
# same change touches any other site.
FANOUT_NOTE=""
if [[ "$SCOPE" == "fleet" || "${NSITES:-1}" -gt 1 ]]; then
  FANOUT="$(python3 - "$TICKET" "$CANARY" "${AFTER_SHA:0:8}" <<'PY'
import sys
sys.path.insert(0, "/home/jesse/projects/domains/tools/ai-optimizer/lib")
import ai_optimizer as q
ticket, canary, sha = sys.argv[1], sys.argv[2], sys.argv[3]
src = None
for st in q.STATUSES:
    fp = q.status_dir(st) / ticket
    if fp.exists():
        src = q.load(fp)[0]
        break
if not src:
    print("ERR no source ticket"); raise SystemExit(0)
rest = [s for s in (src.get("sites") or []) if s != canary]
meta = {
    "title": f"Fan out: {src.get('title')}",
    # A DIFFERENT finding_class so it does not dedupe against its own parent.
    "finding_class": f"{src.get('finding_class')}-fanout",
    "scope": src.get("scope"), "sites": rest or src.get("sites") or [],
    "role": src.get("role"),
    "window_from": src.get("window_from"), "window_to": src.get("window_to"),
    "measured_cost_usd": src.get("measured_cost_usd"),
    "estimated_savings_usd_per_day": src.get("estimated_savings_usd_per_day"),
    "risk": src.get("risk") or "medium",
    "verified_current_code": True,
    "verified_git_check": f"canary {canary} applied as {sha} and verified by the implementer's own build gate",
    "evidence_files": src.get("evidence_files") or [],
}
body = (f"## Fan-out request\n\nThe canary (**{canary}**) is applied and verified "
        f"as `{sha}`.\n\nThis ticket asks for the SAME change on: "
        f"{', '.join(rest) if rest else '(remaining sites)'}\n\n"
        f"Approving this authorises the rest. Deny it to keep the change on the canary only.\n\n"
        f"## Original\n\n{src.get('title')}\n")
fp, outcome = q.file_ticket(meta, body)
print(f"{outcome}|{fp.name}")
PY
)"
  log "fan-out ticket: $FANOUT"
  FANOUT_NOTE="

A *fan-out* ticket was filed for the remaining sites — it needs its own approval before anything else changes."
fi

notify ok "AI-cost fix applied to $CANARY" \
  "Ticket \`$TICKET\` → commit \`${AFTER_SHA:0:8}\` on *$CANARY*.$FANOUT_NOTE

Fleet Dashboard → Growth → AI Optimizer"
log "=== implement run end ==="
exit 0
