#!/bin/sh
# Rotate vpn-random's Gluetun tunnel without recreating its container.
set -eu

interval="${ROTATION_INTERVAL_SECONDS:-900}"
control_url="${GLUETUN_CONTROL_URL:-http://vpn-random:8000}"
api_key="${GLUETUN_CONTROL_API_KEY:?GLUETUN_CONTROL_API_KEY must be set}"

if ! case "$interval" in ''|*[!0-9]*) false ;; *) [ "$interval" -ge 60 ] ;; esac; then
  echo "ROTATION_INTERVAL_SECONDS must be an integer >= 60" >&2
  exit 2
fi

rotate() {
  now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "$now rotating vpn-random tunnel"

  # The kill switch remains active while the tunnel is stopped, so consumers
  # fail closed during the short reconnect window instead of leaking direct
  # traffic. Gluetun chooses a server from its unrestricted PIA server list.
  wget -qO- --method=PUT --header='Content-Type: application/json' \
    --header="X-API-Key: $api_key" \
    --body-data='{"status":"stopped"}' "$control_url/v1/vpn/status" >/dev/null
  sleep 2
  wget -qO- --method=PUT --header='Content-Type: application/json' \
    --header="X-API-Key: $api_key" \
    --body-data='{"status":"running"}' "$control_url/v1/vpn/status" >/dev/null

  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') rotation requested"
}

echo "vpn-random-rotator started; interval=${interval}s"
while :; do
  sleep "$interval"
  rotate || echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') rotation failed; will retry next interval" >&2
done
