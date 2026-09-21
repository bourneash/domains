#!/usr/bin/env bash
set -euo pipefail

# One-shot scheduler entrypoint. Install this from the fleet scheduler/cron;
# the sandbox wrapper supplies the single-flight lock and bounded container.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="$ROOT/tools/executive/logs"
mkdir -p "$LOG_DIR"
exec >>"$LOG_DIR/scheduled.log" 2>&1
if [[ "${EXECUTIVE_FORCE:-0}" != "1" ]]; then
  enabled="$(node -e "const s=require('$ROOT/tools/fleet-dashboard/server/eventstore').open('$ROOT'); process.stdout.write(s.getExecutiveSettings().tick_enabled === true ? '1' : '0'); s.close()" 2>/dev/null || printf '0')"
  if [[ "$enabled" != "1" ]]; then
    echo "[$(date -Is)] executive scheduled tick skipped: tick_enabled is false"
    exit 0
  fi
fi
echo "[$(date -Is)] executive scheduled tick start"
"$ROOT/tools/executive/run-sandbox.sh"
echo "[$(date -Is)] executive scheduled tick complete"
