#!/usr/bin/env bash
# resend-test-email.sh — send CF Email Routing verification test for one domain
#
# Sends attempt 1, waits 80s for the CF greylist window, sends retry.
# Returns both Resend message IDs (one per line, prefixed).
#
# Usage:  bash tools/scripts/resend-test-email.sh <domain.tld>
#
# Designed to be called via Claude's Bash tool with run_in_background: true
# (the sleep 80 inside the greylist window would otherwise block the
# foreground call for 80+ seconds).
#
# Sender (notifications@reviewtattoo.com) is the verified Resend domain.
# Recipient is contact@<DOMAIN>, which CF Email Routing forwards to
# jessetamburino@hotmail.com.
set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain.tld>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAINS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

set -a
. "${DOMAINS_ROOT}/.env"
set +a

send() {
  local suffix="$1"
  /usr/bin/curl -sS -X POST "https://api.resend.com/emails" \
    -H "Authorization: Bearer ${RESEND_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"from\":\"notifications@reviewtattoo.com\",\"to\":[\"contact@${DOMAIN}\"],\"subject\":\"CF Email Routing test — ${DOMAIN}${suffix}\",\"text\":\"Verification message from the deploy-domain-project skill. If you see this in your hotmail (inbox or Junk), the CF Email Routing forward for ${DOMAIN} is working.\"}" \
    | /usr/bin/python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("id","ERR:"+str(d)[:120]))'
}

ID1=$(send "")
echo "attempt 1: ${ID1}"

echo "(greylist gap — sleeping 80s before retry)"
sleep 80

ID2=$(send " (retry)")
echo "retry:     ${ID2}"
