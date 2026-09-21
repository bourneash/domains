#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec 9>"/tmp/domains-executive-handoff-checkin.lock"
flock -n 9 || exit 0

cd "$ROOT"
if [[ -z "$(git status --porcelain -- ops/executive/handoffs)" ]]; then
  exit 0
fi

git add -- ops/executive/handoffs
git commit -m "chore: check in executive handoffs"
if [[ "${EXECUTIVE_HANDOFF_PUSH:-1}" == "1" ]]; then
  git push origin HEAD
fi
