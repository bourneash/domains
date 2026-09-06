#!/usr/bin/env bash
# Remove the obsolete host-cron tick and host API bootstrap. The versioned
# fleet-cron schedule owns the tick; Docker's restart policy owns the API.
set -euo pipefail

ROOT="${DOMAINS_ROOT:-/home/jesse/projects/domains}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
crontab -l 2>/dev/null \
  | grep -v "social-hub tick" \
  | grep -v "social-hub serve --host" > "$TMP" || true
crontab "$TMP"
echo "removed obsolete host Social Hub jobs; schedule is tools/fleet-cron/crontab.docker"
