#!/usr/bin/env bash
set -euo pipefail

# One-shot scheduler entrypoint. The fleet scheduler runs this every six hours;
# the sandbox wrapper supplies the single-flight lock and bounded container.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="$ROOT/tools/executive/logs"
mkdir -p "$LOG_DIR"
exec >>"$LOG_DIR/scheduled.log" 2>&1
if [[ "${EXECUTIVE_FORCE:-0}" != "1" ]]; then
  settings="$(node -e "const s=require('$ROOT/tools/fleet-dashboard/server/eventstore').open('$ROOT'); const x=s.getExecutiveSettings(); const q=s.getChangeQueueSettings(); const enabled=x.queue_execution_enabled === undefined ? q.enabled === true : x.queue_execution_enabled === true; process.stdout.write([x.tick_enabled === true ? '1' : '0', enabled ? '1' : '0'].join('|')); s.close()" 2>/dev/null || printf '0|0')"
  IFS='|' read -r enabled queue_enabled <<<"$settings"
  if [[ "$enabled" != "1" ]]; then
    echo "[$(date -Is)] executive scheduled tick skipped: tick_enabled is false"
    exit 0
  fi
  if [[ "$queue_enabled" == "1" ]]; then
    export EXECUTIVE_ALLOW_QUEUE=1
  else
    export EXECUTIVE_ALLOW_QUEUE=0
  fi
fi
export EXECUTIVE_PASSES="${EXECUTIVE_PASSES:-ceo,cfo,cto,legal,security,reviewer}"
echo "[$(date -Is)] executive scheduled tick start"
"$ROOT/tools/executive/run-sandbox.sh"
"$ROOT/tools/executive/checkin.sh"
echo "[$(date -Is)] executive scheduled tick complete"
