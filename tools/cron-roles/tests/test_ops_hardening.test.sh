#!/usr/bin/env bash
# Contract tests for fleet-wide principal/deployer hardening.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

principals=("$ROOT"/sites/*/ops/scripts/principal-engineer.sh)
deployers=("$ROOT"/sites/*/ops/scripts/run-deployer.sh)
watchdogs=("$ROOT"/sites/*/ops/scripts/watchdog.sh)
emitters=("$ROOT"/sites/*/ops/scripts/emit-incident.sh)
[ "${#principals[@]}" -gt 0 ] || fail "no principal-engineer scripts found"
[ "${#deployers[@]}" -gt 0 ] || fail "no run-deployer scripts found"

for script in "${principals[@]}"; do
  bash -n "$script" || fail "syntax error: $script"
  grep -q 'redact_guardrail_terms' "$script" || fail "missing redactor: $script"
  grep -q "\[redaction unavailable\]" "$script" || fail "redactor is not fail-closed: $script"
  grep -q 'safe_note' "$script" || fail "reopen_incident does not sanitize: $script"
  grep -q 'safe_outcome' "$script" || fail "mark_incident does not sanitize: $script"
done

for script in "${deployers[@]}"; do
  bash -n "$script" || fail "syntax error: $script"
  grep -q 'mv .deploy-needed.failed .deploy-needed' "$script" || continue
  grep -q 'mv .deploy-needed .deploy-needed.failed' "$script" || continue
  grep -q $'mv .deploy-needed.failed .deploy-needed\n    touch .deploy-needed' "$script" \
    || fail "recovery mtime reset missing: $script"
  grep -q $'mv .deploy-needed .deploy-needed.failed\n  touch .deploy-needed.failed' "$script" \
    || fail "retry-cap mtime reset missing: $script"
done

for script in "${watchdogs[@]}" "${emitters[@]}"; do
  bash -n "$script" || fail "syntax error: $script"
  grep -q 'redact_guardrail_terms' "$script" || fail "metadata writer missing redactor: $script"
  grep -q "\[redaction unavailable\]" "$script" || fail "metadata redactor is not fail-closed: $script"
done

for script in "$ROOT"/sites/*/ops/scripts/deploy.sh; do
  bash -n "$script" || fail "syntax error: $script"
  grep -q 'BUILD_CONFIRMED=0' "$script" || continue
  grep -q 'cf-build-unconfirmed' "$script" || fail "deploy verification can fall back silently: $script"
done

smoke="$ROOT/sites/blackmarketapparel.com/ops/scripts/run-smoke-tests.sh"
deploy="$ROOT/sites/blackmarketapparel.com/ops/scripts/deploy.sh"
grep -q 'journal/the-new-uniform' "$smoke" || fail "BMA journal smoke route missing"
grep -q 'journal/black-is-not-basic' "$smoke" || fail "BMA journal smoke route missing"
grep -q 'journal/one-good-accessory' "$smoke" || fail "BMA journal smoke route missing"
grep -q 'run-smoke-tests.sh https://blackmarketapparel.com \"\$PUSHED_SHA\"' "$deploy" \
  || fail "deployer does not pass pushed SHA to smoke tests"

# Verify the timestamp operation used by the wrappers really resets the
# cooldown after an mv, rather than merely appearing in source text.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
touch -d '2 hours ago' "$tmp/.deploy-needed.failed"
mv "$tmp/.deploy-needed.failed" "$tmp/.deploy-needed"
touch "$tmp/.deploy-needed"
age=$(( $(date +%s) - $(stat -c %Y "$tmp/.deploy-needed") ))
[ "$age" -lt 5 ] || fail "recovery timestamp was not reset"

# Integration-test the real BMA retry wrapper in an isolated temporary site.
# The fake docker command forces the deploy attempt to fail without touching a
# checkout or invoking a real container.
fixture="$(mktemp -d)"
trap 'rm -rf "$tmp" "$fixture"' EXIT
mkdir -p "$fixture/sites/example.com/ops/scripts" "$fixture/tools/cron-roles"
cp "$ROOT/sites/blackmarketapparel.com/ops/scripts/run-deployer.sh" \
  "$fixture/sites/example.com/ops/scripts/run-deployer.sh"
cp "$ROOT/tools/cron-roles/repo-mutation-lock.sh" "$fixture/tools/cron-roles/"
mkdir -p "$fixture/bin"
cat > "$fixture/bin/docker" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$fixture/bin/docker"

pushd "$fixture/sites/example.com" >/dev/null
touch -d '2 hours ago' .deploy-needed
echo 5 > .deploy-attempts
PATH="$fixture/bin:$PATH" bash ops/scripts/run-deployer.sh || fail "retry-cap wrapper failed"
[ -f .deploy-needed.failed ] || fail "retry cap did not park the deploy flag"
cap_age=$(( $(date +%s) - $(stat -c %Y .deploy-needed.failed) ))
[ "$cap_age" -lt 5 ] || fail "retry-cap timestamp was not reset"

touch -d '2 hours ago' .deploy-needed.failed
if PATH="$fixture/bin:$PATH" bash ops/scripts/run-deployer.sh; then
  fail "recovered deploy unexpectedly succeeded with failing docker"
fi
[ -f .deploy-needed ] || fail "failed cooldown recovery did not restore deploy flag"
recovery_age=$(( $(date +%s) - $(stat -c %Y .deploy-needed) ))
[ "$recovery_age" -lt 5 ] || fail "recovery timestamp was not reset in integration test"
popd >/dev/null

echo "PASS: ops hardening contracts (${#principals[@]} principals, ${#deployers[@]} deployers)"
