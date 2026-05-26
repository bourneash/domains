#!/usr/bin/env bash
# snapshot-worker-version.sh — print the current top version ID of a CF worker
#
# Usage:  bash tools/scripts/snapshot-worker-version.sh <worker-name>
#
# Used as the BEFORE snapshot in the deploy verification flow. Compare the
# returned ID against poll-worker-deploy.sh's output to detect a new deploy.
set -euo pipefail

WORKER="${1:?Usage: $0 <worker-name>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAINS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

set -a
. "${DOMAINS_ROOT}/.env"
set +a

/usr/bin/curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER}/versions" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  | /usr/bin/python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["items"][0]["id"])'
