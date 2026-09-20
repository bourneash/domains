#!/usr/bin/env bash
set -euo pipefail

ROOT="${DOMAINS_ROOT:-/home/jesse/projects/domains}"
CREDENTIAL_FILE="$ROOT/tools/env-broker/rendered/tool-fleet-cron.env"
if [[ ! -r "$CREDENTIAL_FILE" ]]; then
  echo "fleet-cron Bing credential render is missing: $CREDENTIAL_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$CREDENTIAL_FILE"
set +a
: "${BING_WEBMASTER_API_KEY:?BING_WEBMASTER_API_KEY is missing from the fleet-cron render}"
exec node "$ROOT/tools/backlink-audit/bing.js" --root "$ROOT"
