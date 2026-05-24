#!/usr/bin/env bash
# setup-cf-email.sh — configure CF email routing for a domain
#
# Idempotent: safe to re-run. Useful for domains that were skipped
# during bootstrap-domain.sh (e.g., zone was pending/not yet in CF).
# Usage: ./setup-cf-email.sh <domain.tld>
set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain.tld>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAINS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DEST="jessetamburino@hotmail.com"

set -a; . "${DOMAINS_ROOT}/.env"; set +a

ZONE_RESP=$(curl -sS "https://api.cloudflare.com/client/v4/zones?name=${DOMAIN}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
ZONE_ID=$(echo "${ZONE_RESP}" | python3 -c \
  'import json,sys; r=json.load(sys.stdin)["result"]; print(r[0]["id"]) if r else print("")')

if [ -z "${ZONE_ID}" ]; then
  echo "ERROR: CF zone not found for ${DOMAIN}. Add the domain to CF first."
  exit 1
fi

CF_STATUS=$(echo "${ZONE_RESP}" | python3 -c \
  'import json,sys; r=json.load(sys.stdin)["result"]; print(r[0]["status"]) if r else print("")')
echo "Zone: ${ZONE_ID}  (${CF_STATUS})"

# Enable
RESP=$(curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/enable" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
echo "Enable routing: $(echo "${RESP}" | python3 -c \
  'import json,sys; r=json.load(sys.stdin); print("OK") if r.get("success") else print(str(r.get("errors","?"))[:100])')"

# Specific rules
for ADDR in contact takedown; do
  RESP=$(curl -sS -X POST \
    "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/rules" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${ADDR} forward\",\"enabled\":true,\"matchers\":[{\"type\":\"literal\",\"field\":\"to\",\"value\":\"${ADDR}@${DOMAIN}\"}],\"actions\":[{\"type\":\"forward\",\"value\":[\"${DEST}\"]}]}")
  echo "${ADDR}@${DOMAIN}: $(echo "${RESP}" | python3 -c \
    'import json,sys; r=json.load(sys.stdin); print("OK") if r.get("success") else print(str(r.get("errors","?"))[:100])')"
done

# Catch-all
RESP=$(curl -sS -X PUT \
  "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/rules/catch_all" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"catch-all forward\",\"enabled\":true,\"matchers\":[{\"type\":\"all\"}],\"actions\":[{\"type\":\"forward\",\"value\":[\"${DEST}\"]}]}")
echo "catch-all: $(echo "${RESP}" | python3 -c \
  'import json,sys; r=json.load(sys.stdin); print("OK") if r.get("success") else print(str(r.get("errors","?"))[:100])')"

echo "Done — email routing configured for ${DOMAIN}"
