#!/usr/bin/env bash
# check-worker-names.sh — verify local wrangler.jsonc names match deployed CF workers.
# Usage: ./tools/scripts/check-worker-names.sh
# Requires: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in env or .env

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Load shared .env if not already set
if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]] && [[ -f "$REPO_ROOT/.env" ]]; then
  set -a; source "$REPO_ROOT/.env"; set +a
fi

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" || -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "ERROR: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set" >&2; exit 1
fi

# Fetch all deployed worker names from CF
CF_WORKERS=$(curl -sf \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts?per_page=100" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  | python3 -c "import sys,json; [print(s['id']) for s in json.load(sys.stdin).get('result') or []]")

DRIFT=0
for wrangler in "$REPO_ROOT"/sites/*/site/wrangler.json*; do
  site=$(basename "$(dirname "$(dirname "$wrangler")")")
  local_name=$(python3 -c "
import json, re, sys
txt = open('$wrangler').read()
txt = re.sub(r'//.*', '', txt); txt = re.sub(r',(\s*[}\]])', r'\1', txt)
print(json.loads(txt).get('name',''))
" 2>/dev/null)
  [[ -z "$local_name" ]] && continue
  if echo "$CF_WORKERS" | grep -qx "$local_name"; then
    echo "OK    $site → $local_name"
  else
    echo "DRIFT $site → local='$local_name' not found on CF" >&2
    DRIFT=$((DRIFT + 1))
  fi
done

[[ $DRIFT -eq 0 ]] && echo "All worker names match." || { echo "$DRIFT drift(s) found." >&2; exit 1; }
