#!/usr/bin/env bash
# run-watchdog.sh — cron-container entrypoint for the self-healing watchdog.
#
# Mirrors run-deployer.sh's cost discipline: the CHEAP half (active probes,
# incident gather, cooldown/eligibility) runs right here in the lightweight cron
# container (bash + python3 + curl — no worker spin, 0 API cost). Only when an
# eligible OPEN incident exists do we spin a worker container (which has claude +
# node + npm) to run the full watchdog repair pass.
#
# watchdog.sh --detect-only exits:
#   0  → healthy, or everything is cooling down / escalated → done, no spin.
#   10 → an eligible incident needs a model repair → spin the worker.
#   *  → unexpected error → spin the worker anyway (fail safe; worst case a
#        no-op repair run).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
LOG="ops/logs/watchdog-$(date -u +%Y%m%d).log"
mkdir -p ops/logs

# Cheap detection in the cron container.
WATCHDOG_DETECT_ONLY=1 bash ops/scripts/watchdog.sh
rc=$?

if [[ "$rc" -eq 0 ]]; then
  exit 0   # healthy / nothing eligible — no worker spin
fi

echo "[$(date -Iseconds)] run-watchdog: detect rc=$rc — spinning worker for repair pass" >> "$LOG"

# Full repair pass in the worker container (has claude + node + npm + git).
# Signal kills (130/143) are infrastructure events, not failures.
set +e
docker compose run --rm --entrypoint bash worker ops/scripts/watchdog.sh
wd_exit=$?
set -e
if [[ "$wd_exit" -eq 130 || "$wd_exit" -eq 143 ]]; then
  echo "[$(date -Iseconds)] run-watchdog: worker killed by signal (exit=$wd_exit) — not an error" >> "$LOG"
  exit 0
fi
exit "$wd_exit"
