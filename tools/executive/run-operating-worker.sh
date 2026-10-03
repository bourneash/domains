#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/tools/executive/iteration-guard.sh"
SLOTS="${OPERATING_WORKER_SLOTS:-3}"
[[ "$SLOTS" =~ ^[1-9][0-9]*$ ]] || { echo "invalid OPERATING_WORKER_SLOTS" >&2; exit 2; }
export FD_DOMAINS_ROOT="$ROOT"
export NO_COLOR=1
pids=()
for slot in $(seq 1 "$SLOTS"); do
  (
    lock="${ROOT}/tools/executive/data/operating-worker.lock.${slot}"
    exec 9>"$lock"
    flock -n 9 || exit 75
    OPERATING_WORKER_SLOT="$slot" exec node "$ROOT/tools/executive/operating-worker.js"
  ) &
  pids+=("$!")
done
status=0
for pid in "${pids[@]}"; do
  code=0
  wait "$pid" || code=$?
  if [[ "$code" -ne 0 && "$code" -ne 75 ]]; then status="$code"; fi
done
exit "$status"
