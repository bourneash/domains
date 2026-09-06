#!/usr/bin/env bash
# Called by fleet-cron's versioned schedule. The hub process owns Python and
# platform dependencies; fleet-cron owns when the sweep runs.
set -euo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
DATA_DIR="$DOMAINS_ROOT/tools/social-hub/data"
mkdir -p "$DATA_DIR"
exec 9>"$DATA_DIR/tick.lock"
flock -n 9 || exit 0

if ! docker inspect -f '{{.State.Running}}' social-hub-api 2>/dev/null | grep -qx true; then
  printf '%s social-hub-api is not running\n' "$(date -Iseconds)" >> "$DATA_DIR/tick.log"
  exit 1
fi

docker exec social-hub-api python3 -m social_hub.cli tick --notify --json >> "$DATA_DIR/tick.log" 2>&1
