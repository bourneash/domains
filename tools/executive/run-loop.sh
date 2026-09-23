#!/usr/bin/env bash
set -euo pipefail

# Long-lived supervisor entrypoint. It owns cadence; run-sandbox.sh owns
# single-flight, isolation, timeout, validation, and trusted application.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INTERVAL_SECONDS="${EXECUTIVE_INTERVAL_SECONDS:-3600}"
[[ "$INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo 'EXECUTIVE_INTERVAL_SECONDS must be a positive integer' >&2; exit 2; }
trap 'exit 0' TERM INT
while :; do
  "$ROOT/tools/executive/run-scheduled.sh" || echo "[$(date -Is)] executive tick failed; will retry next interval" >&2
  sleep "$INTERVAL_SECONDS" &
  wait $! || exit 0
done
