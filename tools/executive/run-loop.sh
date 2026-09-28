#!/usr/bin/env bash
set -euo pipefail

# Long-lived supervisor entrypoint. It owns cadence; run-sandbox.sh owns
# single-flight, isolation, timeout, validation, and trusted application.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# The owner operating policy is a 15-minute delivery pulse. A longer default
# turns an empty or failed pass into a one-hour silent gap; operators can still
# explicitly choose a different interval through EXECUTIVE_INTERVAL_SECONDS.
INTERVAL_SECONDS="${EXECUTIVE_INTERVAL_SECONDS:-900}"
[[ "$INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo 'EXECUTIVE_INTERVAL_SECONDS must be a positive integer' >&2; exit 2; }
trap 'exit 0' TERM INT
while :; do
  "$ROOT/tools/executive/run-scheduled.sh" || echo "[$(date -Is)] executive tick failed; will retry next interval" >&2
  sleep "$INTERVAL_SECONDS" &
  wait $! || exit 0
done
