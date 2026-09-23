#!/usr/bin/env bash
# Behavioral regression tests for the principal-engineer result boundary.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SITE_SCRIPT="$ROOT/sites/allthingsmasonic.com/ops/scripts/principal-engineer.sh"
TEMPLATE="$ROOT/tools/cron-roles/archetypes/principal-engineer/scripts/principal-engineer.sh.tmpl"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

run_cases_for() {
  local script="$1" result="$TMP_DIR/result" err="$TMP_DIR/err"
  # Load only the two pure shell helpers from the real wrapper/template; do
  # not source the entrypoint, which would dispatch a real model pass.
  eval "$(sed -n '/^validate_result_contract()/,/^}/p; /^classify_pass_result()/,/^}/p' "$script")"

  cat > "$result" <<'EOF'
PE_STATUS=resolved-real
PE_ROOT_CAUSE=verified cause
PE_FIX=verified fix
PE_HARDENING=verified hardening
PE_ROLLOUT_CANDIDATE=no
EOF
  : > "$err"
  validate_result_contract "$result" \
    || fail "complete PE result rejected by $(basename "$script")"

  printf '%s\n' "You've hit your limit" > "$err"
  classify_pass_result "$result" "$err" 1
  [[ "$RESULT_ROOT_CAUSE" == *"usage limit exhausted"* ]] \
    || fail "account exhaustion was not classified by $(basename "$script")"
  [[ "$RESULT_FIX" == "none — no model work ran" ]] \
    || fail "account exhaustion incorrectly reported work by $(basename "$script")"

  printf '%s\n' "model crashed" > "$err"
  classify_pass_result "$result" "$err" 7
  [[ "$RESULT_ROOT_CAUSE" == *"failed before its final report"* ]] \
    || fail "non-zero CLI failure was not classified by $(basename "$script")"

  printf '%s\n' "useful partial work" > "$result"
  : > "$err"
  classify_pass_result "$result" "$err" 0
  [[ "$RESULT_ROOT_CAUSE" == *"omitted its required PE report block"* ]] \
    || fail "missing PE report was not classified by $(basename "$script")"

  : > "$result"
  if validate_result_contract "$result"; then
    fail "empty PE result was accepted by $(basename "$script")"
  fi
}

run_cases_for "$SITE_SCRIPT"
run_cases_for "$TEMPLATE"
echo "PASS: principal-engineer result-contract cases"
