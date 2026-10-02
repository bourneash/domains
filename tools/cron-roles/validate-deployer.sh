#!/usr/bin/env bash
# validate-deployer.sh <site-dir>
# Regression gate for the cron-direct deployer/submodule Git contract.
set -uo pipefail

SITE="${1:?usage: validate-deployer.sh <site-dir>}"
RUNNER="$SITE/ops/scripts/run-deployer.sh"
DEPLOY="$SITE/ops/scripts/deploy.sh"
ENTRYPOINT="$SITE/ops/docker/entrypoint-worker.sh"
CRONTAB="$SITE/ops/docker/crontab.docker"
FAILED=0

fail() { echo "FAIL: $*" >&2; FAILED=1; }
pass() { echo "PASS: $*"; }

[[ -f "$RUNNER" ]] || { fail "missing $RUNNER"; exit 1; }
[[ -f "$DEPLOY" ]] || { fail "missing $DEPLOY"; exit 1; }
[[ -f "$ENTRYPOINT" ]] || { fail "missing $ENTRYPOINT"; exit 1; }
[[ -f "$CRONTAB" ]] || { fail "missing $CRONTAB"; exit 1; }

for script in "$RUNNER" "$DEPLOY" "$ENTRYPOINT"; do
  if bash -n "$script"; then
    pass "shell syntax: $script"
  else
    fail "invalid shell syntax: $script"
  fi
done

# Check active logical lines, not documentation or commented-out wiring.
# Join shell continuations so formatting a command across lines is harmless.
# This is a static wiring check, not a shell interpreter; never source scripts.
active_lines() {
  awk '
    /^[[:space:]]*#/ && line == "" { next }
    {
      if (sub(/\\$/, "")) { line = line $0; next }
      print line $0
      line = ""
    }
    END { if (line != "") print line }
  ' "$1"
}

# Consume the complete input: grep -q can close its pipe early and make awk
# fail with SIGPIPE under pipefail on a long script.
matches_active() { active_lines "$1" | grep -E "$2" >/dev/null; }

if matches_active "$CRONTAB" '^[[:space:]]*([^[:space:]#]+[[:space:]]+){5}bash[[:space:]]+ops/scripts/run-deployer\.sh([[:space:]]|$)'; then
  pass "crontab invokes run-deployer.sh"
else
  fail "crontab.docker has no active run-deployer.sh schedule"
fi

if matches_active "$RUNNER" '(^|[;&|])[[:space:]]*docker[[:space:]]+compose[[:space:]]+run[[:space:]][^#]*--entrypoint([=[:space:]])[^#]*[[:space:]]worker([[:space:]]|$)'; then
  fail "run-deployer.sh overrides the worker entrypoint; this bypasses submodule Git setup"
else
  pass "worker entrypoint is not overridden"
fi

if matches_active "$RUNNER" '^[[:space:]]*docker[[:space:]]+compose[[:space:]]+run[[:space:]][^#]*[[:space:]]worker[[:space:]]+deployer([[:space:]]|$)'; then
  pass "deployer is dispatched as the worker CMD"
else
  fail "expected: docker compose run --rm worker deployer"
fi

if matches_active "$ENTRYPOINT" '^[[:space:]]*deployer\)[[:space:]]+exec[[:space:]]+bash[[:space:]]+(/work/)?ops/scripts/deploy\.sh([[:space:];]|$)'; then
  pass "worker entrypoint has explicit deployer dispatch"
else
  fail "entrypoint-worker.sh lacks an explicit deployer -> deploy.sh dispatch"
fi

exit "$FAILED"
