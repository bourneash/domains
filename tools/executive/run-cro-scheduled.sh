#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
STATE="$ROOT/tools/executive"
if [[ -e "$STATE/.cro-disabled" ]]; then
  echo "[$(date -Is)] CRO GitHub research disabled"
  exit 0
fi

exec 9>"${CRO_LOCK_FILE:-/tmp/domains-cro.lock}"
flock -n 9 || { echo "[$(date -Is)] CRO research already running"; exit 75; }

mkdir -p "$STATE/logs"
LOG="$STATE/logs/cro.log"
MAX_BYTES="${CRO_LOG_MAX_BYTES:-5242880}"
if [[ -f "$LOG" ]] && (( $(stat -c %s "$LOG") >= MAX_BYTES )); then
  mv -f "$LOG" "$LOG.1"
fi

TIMEOUT="${CRO_TIMEOUT_SECONDS:-900}"
if ! [[ "$TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
  echo "CRO_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 2
fi
exec >>"$LOG" 2>&1
echo "[$(date -Is)] starting CRO GitHub research"
# BusyBox timeout is used by fleet-cron; keep this portable across host and
# container execution. GNU's long --signal/--kill-after spellings fail closed
# before CRO research starts on the production scheduler image.
timeout -s TERM -k 10 "${TIMEOUT}s" \
  node "$STATE/cro.js"
"$STATE/checkin.sh"
