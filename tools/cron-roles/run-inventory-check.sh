#!/usr/bin/env bash
# Daily fleet sweep of validate-inventory.sh. Alerts only on ERRORs (a role body
# instructing a model to hand work to a sibling that does not exist); WARNs are
# logged, not paged.
#
# Runs host-side and reads only files — no containers, no model, ~1s for the
# whole fleet.
set -uo pipefail

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$TOOL_DIR/../.." && pwd)"
LOG_DIR="$TOOL_DIR/logs"; mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/inventory-$(date +%Y-%m-%d).log"

[[ -f "$ROOT/.env" ]] && { set -a; . "$ROOT/.env"; set +a; }

OUT="$(bash "$TOOL_DIR/validate-inventory.sh" --all 2>&1)"
rc=$?
printf '[%s]\n%s\n' "$(date -Iseconds)" "$OUT" >>"$LOG"

if [[ "$rc" -ne 0 ]]; then
  ERRS="$(printf '%s' "$OUT" | grep -B1 '✗' | grep -vE '^--$' || true)"
  COUNT="$(printf '%s' "$OUT" | grep -c '✗' || echo 0)"
  MSG=":warning: cron-role inventory drift — ${COUNT} role body(ies) reference a sibling that is not installed. Those handoffs silently go nowhere.
\`\`\`
${ERRS}
\`\`\`
Full report: ${LOG}"
  if [[ -n "${SLACK_BOT_TOKEN:-}" ]]; then
    printf '%s' "$MSG" | python3 -c '
import json,os,sys,urllib.request
text=sys.stdin.read()
req=urllib.request.Request("https://slack.com/api/chat.postMessage",
  data=json.dumps({"channel":os.environ.get("SLACK_CHANNEL_FLEET_OPS","domain-fleet-ops"),"text":text}).encode(),
  headers={"Authorization":"Bearer "+os.environ["SLACK_BOT_TOKEN"],"Content-type":"application/json; charset=utf-8"})
try: urllib.request.urlopen(req,timeout=20)
except Exception as e: print("slack post failed:",e,file=sys.stderr)
' >>"$LOG" 2>&1
  fi
fi

find "$LOG_DIR" -name 'inventory-*.log' -mtime +30 -delete 2>/dev/null
exit 0
