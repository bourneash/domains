#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOCK_FILE="${EXECUTIVE_OVERWATCH_LOCK_FILE:-$ROOT/tools/executive/data/overwatch-worker.lock}"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "[$(date -Is)] exec overwatch already running"; exit 75; }
export FD_DOMAINS_ROOT="$ROOT"
export NO_COLOR=1
exec node "$ROOT/tools/executive/overwatch-worker.js"
