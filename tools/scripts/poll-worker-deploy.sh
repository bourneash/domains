#!/usr/bin/env bash
# poll-worker-deploy.sh — wait until a CF worker has a new version different from BEFORE
#
# Usage:  bash tools/scripts/poll-worker-deploy.sh <worker-name> <before-id> [timeout-sec]
#
# Polls every 15s. Exits 0 with the new version ID on stdout when found.
# Exits 1 if no new version appears within the timeout (default 600s).
#
# Designed for run_in_background usage from Claude's Bash tool. The "source"
# field on Workers Builds deploys still reports "wrangler" (because that's
# the CLI Builds invokes), so the only reliable signal for a new deploy is
# "version ID changed since the push."
set -euo pipefail

WORKER="${1:?Usage: $0 <worker-name> <before-id> [timeout-sec]}"
BEFORE="${2:?missing before-id}"
TIMEOUT="${3:-600}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAINS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

set -a
. "${DOMAINS_ROOT}/.env"
set +a

DEADLINE=$(($(date +%s) + TIMEOUT))
while [ "$(date +%s)" -lt "${DEADLINE}" ]; do
  CURRENT=$(/usr/bin/curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER}/versions" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    | /usr/bin/python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["items"][0]["id"])')
  if [ "${CURRENT}" != "${BEFORE}" ]; then
    echo "${CURRENT}"
    exit 0
  fi
  sleep 15
done

echo "TIMEOUT after ${TIMEOUT}s — no new version (still ${BEFORE:0:8})" >&2
exit 1
