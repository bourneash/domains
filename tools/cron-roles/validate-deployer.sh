#!/usr/bin/env bash
# validate-deployer.sh <site-dir>
# Regression gate for the cron-direct deployer/submodule Git contract.
set -uo pipefail

SITE="${1:?usage: validate-deployer.sh <site-dir>}"
RUNNER="$SITE/ops/scripts/run-deployer.sh"
ENTRYPOINT="$SITE/ops/docker/entrypoint-worker.sh"
FAILED=0

fail() { echo "FAIL: $*" >&2; FAILED=1; }
pass() { echo "PASS: $*"; }

[[ -f "$RUNNER" ]] || { fail "missing $RUNNER"; exit 1; }
[[ -f "$ENTRYPOINT" ]] || { fail "missing $ENTRYPOINT"; exit 1; }

if grep -Eq '^[[:space:]]*docker compose run .*--entrypoint.*worker' "$RUNNER"; then
  fail "run-deployer.sh overrides the worker entrypoint; this bypasses submodule Git setup"
else
  pass "worker entrypoint is not overridden"
fi

if grep -Eq 'docker compose run[^#\n]*worker[[:space:]]+deployer([[:space:]]|$)' "$RUNNER"; then
  pass "deployer is dispatched as the worker CMD"
else
  fail "expected: docker compose run --rm worker deployer"
fi

if grep -Eq 'deployer\)[[:space:]]+exec bash (/work/)?ops/scripts/deploy\.sh' "$ENTRYPOINT"; then
  pass "worker entrypoint has explicit deployer dispatch"
else
  fail "entrypoint-worker.sh lacks an explicit deployer -> deploy.sh dispatch"
fi

exit "$FAILED"
