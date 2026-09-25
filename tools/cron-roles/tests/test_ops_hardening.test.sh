#!/usr/bin/env bash
# Contract tests for fleet-wide principal/deployer hardening.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

python3 "$ROOT/tools/cron-roles/tests/test_build_lock_contract.py" \
  || fail "fleet build-lock contract failed"

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
  grep -q 'RUNTIME_PATHSPECS' "$script" || fail "stale principal dirty-tree preflight: $script"
  grep -q -- '--untracked-files=all' "$script" || fail "principal preflight misses untracked edits: $script"
  ! grep -q 'git status --porcelain -- site/ ops/ \.github/' "$script" \
    || fail "principal preflight includes runtime bookkeeping: $script"
done

# Saltwater News has Workers Builds verification enabled. Keep the critical
# fail-closed contracts regression-tested because this script is site-specific
# and is not regenerated from the archetype on every fleet change.
saltwater_deploy="$ROOT/sites/saltwaternews.com/ops/scripts/deploy.sh"
bash -n "$saltwater_deploy" || fail "saltwaternews deploy verifier syntax error"
grep -q 'CLOUDFLARE_BUILDS_READ_TOKEN' "$saltwater_deploy" \
  || fail "saltwaternews verifier lacks least-privilege token hook"
grep -q 'VERIFY_BASE_SHA' "$saltwater_deploy" \
  || fail "saltwaternews verifier lacks pushed-range base"
grep -q 'per_page=100&page=1' "$saltwater_deploy" \
  || fail "saltwaternews verifier does not request sufficient build history"
grep -q 'CF_API_ERROR' "$saltwater_deploy" \
  || fail "saltwaternews verifier hides Cloudflare API errors"
grep -q 'DEPLOY_ALLOW_UNCONFIRMED_BUILD=1' "$saltwater_deploy" \
  || fail "saltwaternews emergency override is not explicitly logged"

principal_template="$ROOT/tools/cron-roles/archetypes/principal-engineer/scripts/principal-engineer.sh.tmpl"
bash -n <(sed 's/{{[^}]*}}/placeholder/g' "$principal_template") \
  || fail "principal-engineer template syntax error"
grep -q 'validate_result_contract' "$principal_template" \
  || fail "principal-engineer template lacks result-contract validator"
grep -q 'classify_pass_result' "$principal_template" \
  || fail "principal-engineer template lacks pass-failure classifier"
grep -q 'SYNC_ALERT_AFTER' "$principal_template" \
  || fail "principal-engineer template lacks sync defer threshold"
grep -q 'good resolved' "$principal_template" \
  || fail "principal-engineer template does not force resolved Slack delivery"
bma_principal="$ROOT/sites/blackmarketapparel.com/ops/scripts/principal-engineer.sh"
grep -q 'SYNC_ALERT_AFTER' "$bma_principal" \
  || fail "BMA sync defer threshold missing"
grep -q 'record_sync_defer' "$bma_principal" \
  || fail "BMA sync defer state tracking missing"
grep -q 'clear_sync_defer' "$bma_principal" \
  || fail "BMA sync defer state reset missing"
grep -q 'behind=.*ahead=' "$bma_principal" \
  || fail "BMA sync defer diagnostics missing"

for script in "${principals[@]}"; do
  grep -q 'good resolved' "$script" \
    || fail "principal-engineer success notification does not force Slack delivery: $script"
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

allthings_engineer="$ROOT/sites/allthingsmasonic.com/ops/scripts/run-engineer.sh"
bash -n "$allthings_engineer" || fail "allthingsmasonic engineer syntax error"
grep -q 'ENGINEER_UNPUSHED_COMMIT_GRACE_SECS' "$allthings_engineer" \
  || fail "allthingsmasonic engineer grace period is not configurable"
grep -q 'UNPUSHED_COMMIT_GRACE_SECS=1200' "$allthings_engineer" \
  || fail "allthingsmasonic engineer grace period lacks safe default"
grep -q 'could not determine commit age' "$allthings_engineer" \
  || fail "allthingsmasonic engineer git timestamp failure is not fail-closed"
grep -q 'head_commit_age.*-gt.*UNPUSHED_COMMIT_GRACE_SECS' "$allthings_engineer" \
  || fail "allthingsmasonic engineer grace boundary missing"

allthings_principal="$ROOT/sites/allthingsmasonic.com/ops/scripts/principal-engineer.sh"
grep -q 'validate_result_contract' "$allthings_principal" \
  || fail "allthingsmasonic principal wrapper lacks result-contract gate"
grep -q 'classify_pass_result' "$allthings_principal" \
  || fail "allthingsmasonic principal wrapper lacks pass-failure classifier"

engineer_template="$ROOT/tools/cron-roles/archetypes/engineer/scripts/run-engineer.sh.tmpl"
bash -n <(sed 's/{{[^}]*}}/placeholder/g' "$engineer_template") \
  || fail "engineer template syntax error"
grep -q 'archive_failed_pass' "$engineer_template" \
  || fail "engineer template does not archive truncated passes"
grep -q 'PREPASS_SHIPPABLE_DIRTY' "$engineer_template" \
  || fail "engineer template lacks pre-existing-edit safety guard"
grep -q 'RESUME_CONTEXT' "$engineer_template" \
  || fail "engineer template does not tell retries where to resume"
grep -q 'TASK_BUDGET_BUFFER=10' "$engineer_template" \
  || fail "engineer template uses unbuffered task estimates"

# Any wrapper using the stderr-preserving implementation must carry the same
# result gate. This catches partial template stamps without forcing legacy
# wrappers onto a fleet-wide rollout in the same change.
for script in "${principals[@]}"; do
  if grep -q 'PASS_ERR=' "$script"; then
    grep -q 'validate_result_contract' "$script" \
      || fail "stderr-preserving principal wrapper lacks result-contract gate: $script"
    grep -q 'classify_pass_result' "$script" \
      || fail "stderr-preserving principal wrapper lacks pass-failure classifier: $script"
  fi
done

bash "$ROOT/tools/cron-roles/tests/test_principal_engineer_result_contract.test.sh" \
  || fail "principal-engineer result-contract regression tests failed"

# Exercise the real grace-window function at both sides of the boundary and
# verify that a missing git timestamp fails closed.
git_fixture="$(mktemp -d)"
trap 'rm -rf "$git_fixture"' EXIT
git -C "$git_fixture" init -q
git -C "$git_fixture" config user.name test
git -C "$git_fixture" config user.email test@example.invalid
old_commit_date="$(date -u -d '30 minutes ago' '+%Y-%m-%dT%H:%M:%SZ')"
GIT_AUTHOR_DATE="$old_commit_date" GIT_COMMITTER_DATE="$old_commit_date" \
  git -C "$git_fixture" commit --allow-empty -qm stale
(
  cd "$git_fixture"
  ISSUES=()
  note_issue() { ISSUES+=("$1"); }
  UNPUSHED_COMMIT_GRACE_SECS=1200
  eval "$(sed -n '/^report_unpushed_commits()/,/^}/p' "$allthings_engineer")"
  report_unpushed_commits 1
  [ "${#ISSUES[@]}" -eq 1 ] || exit 1
) || fail "stale unpushed commit was not reported"

fresh_commit_date="$(date -u -d '5 minutes ago' '+%Y-%m-%dT%H:%M:%SZ')"
GIT_AUTHOR_DATE="$fresh_commit_date" GIT_COMMITTER_DATE="$fresh_commit_date" \
  git -C "$git_fixture" commit --allow-empty -qm fresh
(
  cd "$git_fixture"
  ISSUES=()
  note_issue() { ISSUES+=("$1"); }
  UNPUSHED_COMMIT_GRACE_SECS=1200
  eval "$(sed -n '/^report_unpushed_commits()/,/^}/p' "$allthings_engineer")"
  report_unpushed_commits 1 >/dev/null
  [ "${#ISSUES[@]}" -eq 0 ] || exit 1
) || fail "fresh unpushed commit did not receive grace"

(
  cd "$git_fixture"
  git checkout -q --orphan empty
  git rm -rfq . 2>/dev/null || true
  ISSUES=()
  note_issue() { ISSUES+=("$1"); }
  UNPUSHED_COMMIT_GRACE_SECS=1200
  eval "$(sed -n '/^report_unpushed_commits()/,/^}/p' "$allthings_engineer")"
  report_unpushed_commits 1 >/dev/null
  [ "${#ISSUES[@]}" -eq 1 ] || exit 1
) || fail "missing git timestamp did not fail closed"

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
