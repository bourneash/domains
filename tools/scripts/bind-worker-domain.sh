#!/usr/bin/env bash
# bind-worker-domain.sh — bind custom domain(s) to the CF Worker
#
# Run AFTER: (1) bootstrap-domain.sh  (2) Jesse connects CF Worker to GitHub
# Usage: ./bind-worker-domain.sh <domain.tld>
#
# Binds apex + www to the worker, then smoke-tests the live URL.
set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain.tld>}"
WORKER_NAME="${DOMAIN//./-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAINS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

set -a; . "${DOMAINS_ROOT}/.env"; set +a

ZONE_ID=$(curl -sS "https://api.cloudflare.com/client/v4/zones?name=${DOMAIN}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | \
  python3 -c 'import json,sys; print(json.load(sys.stdin)["result"][0]["id"])')

echo ""
echo "=== bind-worker-domain.sh: ${DOMAIN} ==="
echo "  Worker name : ${WORKER_NAME}"
echo "  Zone ID     : ${ZONE_ID}"
echo ""

for HOST in "${DOMAIN}" "www.${DOMAIN}"; do
  RESP=$(curl -sS -X PUT \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"environment\":\"production\",\"hostname\":\"${HOST}\",\"service\":\"${WORKER_NAME}\",\"zone_id\":\"${ZONE_ID}\"}")
  STATUS=$(echo "${RESP}" | python3 -c \
    'import json,sys; r=json.load(sys.stdin); print("OK — " + r["result"]["hostname"]) if r.get("success") else print("ERROR: " + str(r.get("errors","?"))[:120])')
  echo "  ${HOST}: ${STATUS}"
done

echo ""
echo "Waiting 30s for CF propagation..."
sleep 30

# DoH DNS lookup — port 53 is blocked in sandbox
APEX_IP=$(curl -sS -H "accept: application/dns-json" \
  "https://cloudflare-dns.com/dns-query?name=${DOMAIN}&type=A" | \
  python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["Answer"][0]["data"]) if d.get("Answer") else print("")' 2>/dev/null || echo "")

if [ -z "${APEX_IP}" ]; then
  # Fall back to AAAA
  APEX_IP=$(curl -sS -H "accept: application/dns-json" \
    "https://cloudflare-dns.com/dns-query?name=${DOMAIN}&type=AAAA" | \
    python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["Answer"][0]["data"]) if d.get("Answer") else print("")' 2>/dev/null || echo "")
fi

echo "=== Smoke test ==="
if [ -n "${APEX_IP}" ]; then
  curl -sS -o /dev/null -w "HTTP %{http_code}  https://${DOMAIN}/\n" \
    --resolve "${DOMAIN}:443:${APEX_IP}" "https://${DOMAIN}/"
else
  curl -sS -o /dev/null -w "HTTP %{http_code}  https://${DOMAIN}/\n" "https://${DOMAIN}/" || \
    echo "  (DNS not yet propagated — retry in a few minutes)"
fi

echo ""
echo "=== Done — ${DOMAIN} is live ==="
