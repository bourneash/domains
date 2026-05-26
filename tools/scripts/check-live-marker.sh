#!/usr/bin/env bash
# check-live-marker.sh — poll a live site for a marker string until it's present or absent
#
# Usage:  bash tools/scripts/check-live-marker.sh <domain.tld> <marker> [present|absent] [timeout-sec]
#
# Default mode is "present" — exits when the marker is found in the live HTML.
# Pass "absent" to wait until the marker is gone (used after the cleanup commit).
#
# Uses DoH for resolution because port 53 is firewalled in the sandbox.
# Default timeout 600s (10 min); polls every 15s.
set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain.tld> <marker> [present|absent] [timeout-sec]}"
MARKER="${2:?missing marker}"
MODE="${3:-present}"
TIMEOUT="${4:-600}"

if [ "${MODE}" != "present" ] && [ "${MODE}" != "absent" ]; then
  echo "ERROR: mode must be 'present' or 'absent' (got '${MODE}')" >&2
  exit 2
fi

APEX_IP=$(/usr/bin/curl -sS -H "accept: application/dns-json" \
  "https://cloudflare-dns.com/dns-query?name=${DOMAIN}&type=A" \
  | /usr/bin/python3 -c 'import json,sys;print(json.load(sys.stdin)["Answer"][0]["data"])')

DEADLINE=$(($(date +%s) + TIMEOUT))
while [ "$(date +%s)" -lt "${DEADLINE}" ]; do
  BODY=$(/usr/bin/curl -sS "https://${DOMAIN}/" --resolve "${DOMAIN}:443:${APEX_IP}" || true)
  if [ "${MODE}" = "present" ] && echo "${BODY}" | grep -q -- "${MARKER}"; then
    echo "MARKER PRESENT on https://${DOMAIN}/"
    exit 0
  fi
  if [ "${MODE}" = "absent" ] && ! echo "${BODY}" | grep -q -- "${MARKER}"; then
    echo "MARKER ABSENT on https://${DOMAIN}/"
    exit 0
  fi
  sleep 15
done

echo "TIMEOUT after ${TIMEOUT}s — marker not in expected state ('${MODE}') on https://${DOMAIN}/" >&2
exit 1
