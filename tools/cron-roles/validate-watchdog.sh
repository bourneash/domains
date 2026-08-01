#!/usr/bin/env bash
# validate-watchdog.sh [site...] — periodic fleet-wide watchdog health check.
#
# For every site with the watchdog installed (or the sites named on the
# command line), proves — for real, not just by reading files — that:
#   1. the crontab line is baked into the LIVE cron image (the sinderella
#      guard: a crontab.docker edit with no `docker compose build cron` is
#      invisible and this is the #1 way a watchdog install silently rots)
#   2. a healthy tick runs clean ("no open incidents", 0 tokens, no worker spun)
#   3. the incident -> repair-loop mechanics actually work: seeds a synthetic
#      incident and drives it through WATCHDOG_DRY_RUN=1 (no real model call,
#      no build, no push — see watchdog.sh's own DRY_RUN handling), then
#      confirms it resolved and cleans up after itself.
#
# This is intentionally NOT a test of the site's actual deploy pipeline —
# it never spins a real repair worker (that costs tokens and, against a
# synthetic incident, produces a bogus "fix" for a bug that doesn't exist —
# see the weirdgirlstore validation run 2026-07-31 for exactly why). Run this
# as often as you like; it's read-only on everything except a transient
# ops/health/ dir it creates and removes itself.
#
# Usage:
#   tools/cron-roles/validate-watchdog.sh                 # every site with watchdog installed
#   tools/cron-roles/validate-watchdog.sh weapontester.com rc-9.com   # just these
#
# Exit code = number of FAILed sites (0 = all clean).

set -uo pipefail

DOMAINS_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$DOMAINS_ROOT"

if [ "$#" -gt 0 ]; then
  SITES=("$@")
else
  SITES=()
  for d in sites/*/; do
    s="$(basename "$d")"
    # Require the full archetype signature, not just a same-named script —
    # amputeenews.com has an unrelated pre-existing ops/scripts/run-watchdog.sh
    # (a plain URL health-check dispatcher) that isn't our self-healing archetype.
    if [ -f "sites/$s/ops/scripts/run-watchdog.sh" ] \
       && [ -f "sites/$s/ops/scripts/watchdog.sh" ] \
       && [ -f "sites/$s/ops/scripts/emit-incident.sh" ] \
       && [ -f "sites/$s/ops/roles/watchdog.md" ]; then
      SITES+=("$s")
    fi
  done
fi

printf '%-24s %-10s %-10s %-10s %s\n' "SITE" "CRONTAB" "HEALTHY" "REPAIR-LOOP" "NOTES"
printf '%-24s %-10s %-10s %-10s %s\n' "----" "-------" "-------" "-----------" "-----"

fail_count=0

for site in "${SITES[@]}"; do
  SITE_DIR="$DOMAINS_ROOT/sites/$site"
  NOTES=""
  CRONTAB_STATUS="FAIL"
  HEALTHY_STATUS="FAIL"
  REPAIR_STATUS="FAIL"
  SITE_FAILED=0

  if [ ! -d "$SITE_DIR" ] || [ ! -f "$SITE_DIR/ops/scripts/run-watchdog.sh" ]; then
    printf '%-24s %-10s %-10s %-10s %s\n' "$site" "-" "-" "-" "no watchdog installed — skipped"
    continue
  fi

  # Container naming isn't fully uniform fleet-wide — try the obvious short
  # name (site basename minus TLD) first, then fall back to whatever compose
  # actually resolves.
  SHORT="${site%%.*}"
  CTR="${SHORT}-cron"
  if ! docker inspect "$CTR" >/dev/null 2>&1; then
    CTR="$(cd "$SITE_DIR" && docker compose ps -q cron 2>/dev/null | xargs -r docker inspect -f '{{.Name}}' 2>/dev/null | sed 's#^/##')"
  fi

  if [ -z "$CTR" ] || ! docker inspect "$CTR" >/dev/null 2>&1; then
    printf '%-24s %-10s %-10s %-10s %s\n' "$site" "FAIL" "-" "-" "cron container not found/running"
    fail_count=$((fail_count + 1))
    continue
  fi

  # 1. Crontab line live where the cron container actually reads it. Most
  #    sites COPY crontab.docker into /etc/crontab.docker at image-build time
  #    (needs `docker compose build cron` to pick up an edit — the "sinderella
  #    guard"). At least one site (amputeenews.com) instead points supercronic
  #    straight at the bind-mounted ops/docker/crontab.docker with no bake
  #    step — always live, no rebuild needed. Check both; either counts.
  #    grep -r (not cat) so a /etc/crontabs *directory* some sites have doesn't
  #    poison the exit code the way `cat` on a directory does; capture into a
  #    var first so pipefail can't blame an unrelated upstream failure for
  #    what's actually a clean grep miss (or hit).
  CRONTAB_MATCH="$(docker exec "$CTR" sh -c \
    'grep -rl run-watchdog\.sh /etc/*crontab* 2>/dev/null; grep -l run-watchdog\.sh ops/docker/crontab.docker 2>/dev/null' \
    || true)"
  if [ -n "$CRONTAB_MATCH" ]; then
    CRONTAB_STATUS="ok"
  else
    NOTES="$NOTES crontab line missing from live image (needs docker compose build cron);"
    SITE_FAILED=1
  fi

  # 2. Healthy tick — must be clean before we intentionally dirty it.
  HEALTHY_OUT="$(docker exec "$CTR" bash ops/scripts/run-watchdog.sh 2>&1)"
  if echo "$HEALTHY_OUT" | grep -qi 'no open incidents'; then
    HEALTHY_STATUS="ok"
  else
    NOTES="$NOTES pre-existing open incident(s) — see 'docker exec $CTR bash ops/scripts/run-watchdog.sh';"
    SITE_FAILED=1
    # Don't seed a synthetic incident on top of a real open one — skip repair-loop check.
    printf '%-24s %-10s %-10s %-10s %s\n' "$site" "$CRONTAB_STATUS" "$HEALTHY_STATUS" "SKIP" "$NOTES"
    fail_count=$((fail_count + SITE_FAILED))
    continue
  fi

  # 3. Repair-loop mechanics, fully dry — no model call, no build, no push.
  docker exec "$CTR" bash ops/scripts/emit-incident.sh \
    --role validate-watchdog --class synthetic-probe --severity high \
    --summary "periodic validation probe ($(date -Iseconds))" >/dev/null 2>&1

  DRY_OUT="$(docker exec -e WATCHDOG_DRY_RUN=1 -e WATCHDOG_FAKE_REPAIR=recover "$CTR" \
    bash ops/scripts/watchdog.sh 2>&1)"

  # Always clean up the synthetic incident regardless of outcome.
  docker exec "$CTR" rm -rf ops/health >/dev/null 2>&1

  if echo "$DRY_OUT" | grep -qiE 'resolved|recover'; then
    REPAIR_STATUS="ok"
  else
    NOTES="$NOTES dry-run repair did not resolve — see full output;"
    SITE_FAILED=1
  fi

  printf '%-24s %-10s %-10s %-10s %s\n' "$site" "$CRONTAB_STATUS" "$HEALTHY_STATUS" "$REPAIR_STATUS" "${NOTES:-clean}"
  fail_count=$((fail_count + SITE_FAILED))
done

echo
if [ "$fail_count" -eq 0 ]; then
  echo "All watchdog installs validated clean."
else
  echo "$fail_count site(s) need attention — see NOTES above."
fi
exit "$fail_count"
