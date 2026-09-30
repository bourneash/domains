#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOCK="${ROOT}/tools/executive/data/operating-worker.lock"
exec 9>"$LOCK"
flock -n 9 || exit 75
export FD_DOMAINS_ROOT="$ROOT"
export NO_COLOR=1
exec node "$ROOT/tools/executive/operating-worker.js"
