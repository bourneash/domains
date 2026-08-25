#!/usr/bin/env bash
# Daily AI-cost analyst — the "what can we improve about our AI usage?" job.
#
#   1. analyst.py builds an evidence packet (ZERO AI: ledger + git before/after
#      per candidate role). This is where the already-fixed detection happens.
#   2. If there are live candidates, one claude -p session reads the packet,
#      verifies against live code, and files tickets via the CLI. The CLI's
#      validation is what keeps telemetry-only guesses out of the queue.
#   3. Slack ONLY when a ticket was actually filed. Healthy is SILENT — the
#      same contract as the engineer pulse and the lint sweep. A daily
#      "nothing to report" post trains everyone to ignore the channel.
#
# Deliberately NOT here: applying anything. This job only ever proposes.
# See ai-optimizer-implement.sh for the (human-approved) apply path.
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
TOOL_DIR="$DOMAINS_ROOT/tools/ai-optimizer"
LOG="${AI_OPT_LOG:-$TOOL_DIR/analyst.log}"
LOCK="${AI_OPT_LOCK:-$TOOL_DIR/.analyst.lock}"
WINDOW_DAYS="${AI_OPT_WINDOW_DAYS:-7}"
MIN_COST="${AI_OPT_MIN_COST:-3.0}"
TOP="${AI_OPT_TOP:-8}"
MAX_TURNS="${AI_OPT_MAX_TURNS:-60}"
TIMEOUT="${AI_OPT_TIMEOUT:-2700}"
NOTIFY_ENABLED="${AI_OPT_NOTIFY:-1}"
LOG_MAX_BYTES="${AI_OPT_LOG_MAX_BYTES:-5242880}"

# Kill switch, same convention as every site role.
[[ -f "$TOOL_DIR/.analyst-disabled" ]] && exit 0

exec 9>"$LOCK"
flock -n 9 || exit 0

if [[ -f "$LOG" ]]; then
  sz="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  [[ "$sz" =~ ^[0-9]+$ ]] && (( sz > LOG_MAX_BYTES )) && mv -f "$LOG" "$LOG.1"
fi
log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

[[ -f "$DOMAINS_ROOT/.env" ]] && { set -a; . "$DOMAINS_ROOT/.env"; set +a; }

log "=== analyst run start (window=${WINDOW_DAYS}d) ==="

# --- 1. Evidence packet (zero AI) ---
PACKET="$(timeout 600 python3 "$TOOL_DIR/analyst.py" \
  --root "$DOMAINS_ROOT" --days "$WINDOW_DAYS" --min-cost "$MIN_COST" --top "$TOP" 2>>"$LOG")"
if [[ -z "$PACKET" ]]; then
  log "analyst.py produced nothing — aborting (no AI spent)"
  exit 0
fi

read -r N_LIVE N_FIXED FLEET_COST <<<"$(python3 - "$PACKET" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
print(len(d.get("candidates_live", [])),
      len(d.get("candidates_likely_already_fixed", [])),
      d.get("fleet_total_cost_usd", 0))
PY
)"
log "packet: live=$N_LIVE already_fixed=$N_FIXED fleet_cost=\$$FLEET_COST"

# Nothing worth a session — the single biggest cost saving this job makes is
# not running the model on a quiet day.
if [[ "${N_LIVE:-0}" == "0" ]]; then
  log "no live candidates — skipping Claude entirely"
  exit 0
fi

BEFORE_COUNT="$(ls -1 "$TOOL_DIR/queue/proposed"/*.md 2>/dev/null | wc -l | tr -d ' ')"

# --- 2. The analyst session ---
export CRON_SITE="_fleet"
export CRON_ROLE="ai-optimizer-analyst"
export REPO_ROOT="$DOMAINS_ROOT"
CLAUDE_TRACKED="$DOMAINS_ROOT/tools/scripts/claude-tracked.sh"

PROMPT="$(cat "$TOOL_DIR/role.md")

## Evidence packet for this run

\`\`\`json
$PACKET
\`\`\`

Today is $(date -Iseconds). Working directory is $DOMAINS_ROOT. Begin."

cd "$DOMAINS_ROOT"
timeout "$TIMEOUT" "$CLAUDE_TRACKED" "$PROMPT" \
  --max-turns "$MAX_TURNS" \
  --dangerously-skip-permissions \
  --model claude-sonnet-4-6 \
  >> "$LOG" 2>&1
rc=$?
log "analyst session exit=$rc"

# --- 3. Notify only on a real new ticket ---
AFTER_COUNT="$(ls -1 "$TOOL_DIR/queue/proposed"/*.md 2>/dev/null | wc -l | tr -d ' ')"
NEW=$(( AFTER_COUNT - BEFORE_COUNT ))
log "proposed tickets: before=$BEFORE_COUNT after=$AFTER_COUNT new=$NEW"

if (( NEW > 0 )) && [[ "$NOTIFY_ENABLED" == "1" ]] && [[ -n "${SLACK_BOT_TOKEN:-}" ]]; then
  DETAIL="$(python3 - <<'PY'
import sys
sys.path.insert(0, "/home/jesse/projects/domains/tools/ai-optimizer/lib")
import ai_optimizer as q
rows = sorted(q.list_tickets(status="proposed"),
              key=lambda r: -(r["measured_cost_usd"] or 0))
for r in rows:
    save = r.get("estimated_savings_usd_per_day")
    scope = "fleet" if r["scope"] == "fleet" else ",".join(r["sites"] or [])
    print(f"• *{r['title']}*")
    print(f"  {scope} · {r.get('role') or '-'} · risk {r.get('risk')} · "
          f"measured ${r['measured_cost_usd']}"
          + (f" · est. save ${save}/day" if save else ""))
PY
)"
  timeout 30 python3 "$DOMAINS_ROOT/tools/role-notify/notify_role.py" \
    --mode structured --site "_fleet" --role "ai-optimizer" --status warn \
    --headline "$NEW new AI-cost finding(s) awaiting your call — $AFTER_COUNT open" \
    --detail "$DETAIL

Review: Fleet Dashboard → Growth → AI Optimizer" \
    --channel-env AI_OPT_CHANNEL \
    --channel-default "domain-ops" >/dev/null 2>&1 || true
  log "notified Slack ($NEW new)"
fi

log "=== analyst run end ==="
exit 0
