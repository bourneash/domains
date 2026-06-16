#!/usr/bin/env bash
# validate-install.sh <site-dir> <role-name>
# Asserts a cron role is fully + correctly installed. Exit 0 = pass, non-0 = fail.
set -uo pipefail

SITE="${1:?usage: validate-install.sh <site-dir> <role-name>}"
ROLE="${2:?usage: validate-install.sh <site-dir> <role-name>}"
fail() { echo "FAIL: $*" >&2; exit 1; }

ROLE_FILE="$SITE/ops/roles/$ROLE.md"
[ -f "$ROLE_FILE" ] || fail "role file missing: $ROLE_FILE"

# 1. No unresolved placeholders anywhere in the stamped role file.
if grep -q '{{' "$ROLE_FILE"; then
  fail "unresolved {{placeholder}} in $ROLE_FILE"
fi

# 2. run-role.sh has a dispatch branch for this role.
grep -qE "(\"$ROLE\"|$ROLE[|)])" "$SITE/ops/scripts/run-role.sh" \
  || fail "no dispatch branch for '$ROLE' in run-role.sh"

# 3. crontab.docker has a schedule line invoking this role.
grep -qE "run-worker\.sh +$ROLE( |\$)" "$SITE/ops/docker/crontab.docker" \
  || fail "no crontab line for '$ROLE' in crontab.docker"

# 4. The running cron container actually has the line (the sinderella guard).
#    Skipped with a loud warning if docker or the container is unavailable.
CRON_CTR="$(cd "$SITE" && docker compose ps -q cron 2>/dev/null)"
if [ -n "$CRON_CTR" ]; then
  docker exec "$CRON_CTR" crontab -l 2>/dev/null | grep -q "$ROLE" \
    || docker exec "$CRON_CTR" sh -c 'cat /etc/*crontab* /app/crontab* 2>/dev/null; true' \
       | grep -q "$ROLE" \
    || fail "cron container is live but '$ROLE' line is NOT in it — image is stale, rebuild did not take"
else
  echo "WARN: cron container not running for $SITE — skipped live-container check (rebuild+verify before declaring done)"
fi

echo "PASS: $ROLE installed in $SITE"
