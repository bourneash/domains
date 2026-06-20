#!/usr/bin/env bash
# verify-killswitch.sh — prove the Cron Manager's pause is REAL for every site.
#
# The panel pauses a role by writing ops/.<role>-disabled, but that only stops
# the job if the site's run-worker.sh (and, defense-in-depth, run-role.sh)
# actually check the flag and exit early. The panel can show "disabled" while
# the role keeps firing if those scripts don't honor it. This script catches
# exactly that drift.
#
# For each discovered site it runs three checks on run-worker.sh AND run-role.sh:
#   1. STATIC   — does the script contain a `.${ROLE}-disabled` check?
#   2. SYNTAX   — bash -n
#   3. FUNCTION — with a temp flag present the script must exit 0 with the
#                 DISABLED message before any docker call; with no flag a bogus
#                 role must advance PAST the kill-switch (no false skip).
#
# Exit 0 = every site all-green. Exit 1 = at least one site's pause is broken.
# Safe to run anytime; creates/removes only a temp .<role>-disabled flag.
set -uo pipefail

# Resolve repo root: walk up until we find sites/ (works from anywhere).
ROOT="$(cd "$(dirname "$0")" && pwd)"
while [[ "$ROOT" != "/" && ! -d "$ROOT/sites" ]]; do ROOT="$(dirname "$ROOT")"; done
if [[ ! -d "$ROOT/sites" ]]; then echo "could not locate repo root (no sites/ dir)"; exit 2; fi
cd "$ROOT"

# Stub docker so a kill-switch that fails to skip is caught reaching docker,
# and so we never actually build/run a worker during verification.
STUB="$(mktemp -d)"; trap 'rm -rf "$STUB"' EXIT
printf '#!/bin/sh\necho "DOCKER-CALLED: $*"\nexit 0\n' > "$STUB/docker"
chmod +x "$STUB/docker"
export PATH="$STUB:$PATH"

fail=0
printf '%-22s %-10s %-10s %-12s\n' "SITE/SCRIPT" "STATIC" "SYNTAX" "FUNCTIONAL"
printf '%-22s %-10s %-10s %-12s\n' "-----------" "------" "------" "----------"

for c in sites/*/ops/docker/crontab.docker; do
  [[ -e "$c" ]] || continue
  site="$(echo "$c" | cut -d/ -f2)"
  for script in run-worker.sh run-role.sh; do
    f="sites/$site/ops/scripts/$script"
    label="$site/$script"
    if [[ ! -f "$f" ]]; then
      printf '%-22s %-10s %-10s %-12s\n' "$label" "MISSING" "-" "-"; fail=1; continue
    fi

    # 1. STATIC
    if grep -q '${ROLE}-disabled' "$f"; then static="ok"; else static="NO-CHECK"; fail=1; fi

    # 2. SYNTAX
    if bash -n "$f" 2>/dev/null; then syntax="ok"; else syntax="BAD"; fail=1; fi

    # 3. FUNCTIONAL — disabled path skips, enabled path doesn't false-skip.
    func="ok"
    flag="sites/$site/ops/.killtest_verify-disabled"
    : > "$flag"
    out_dis="$(bash "$f" killtest_verify 2>&1)"; rc_dis=$?
    rm -f "$flag"
    if ! { echo "$out_dis" | grep -q "DISABLED" && [[ $rc_dis -eq 0 ]] \
           && ! echo "$out_dis" | grep -q "DOCKER-CALLED"; }; then
      func="SKIP-FAIL"; fail=1
    fi
    # No flag + bogus role must NOT print DISABLED (no false skip).
    out_en="$(bash "$f" killtest_verify_noflag 2>&1)"
    if echo "$out_en" | grep -q "DISABLED"; then func="FALSE-SKIP"; fail=1; fi

    printf '%-22s %-10s %-10s %-12s\n' "$label" "$static" "$syntax" "$func"
  done
done

echo
if [[ $fail -eq 0 ]]; then
  echo "ALL GREEN — every site's pause is wired and functional."
else
  echo "FAILURES above — a NO-CHECK/MISSING/SKIP-FAIL/FALSE-SKIP means the panel's"
  echo "pause is cosmetic-only for that script. Fix per references/kill-switch-invariant.md."
fi
exit $fail
