#!/usr/bin/env bash
# Fleet-cron Job 16 — asserts the HOST-side fleet-cron watchdog actually ran.
#
# The other half of the pair. fleet-cron cannot check its own freshness (a
# wedged scheduler is what would fail to run the check), so
# fleet-cron-freshness-host.sh runs from the host crontab. Host cron's failure
# mode is that a wiped crontab is SILENT — the exact thing the fleet-cron
# migration existed to eliminate — so the fleet asserts the host is still
# doing its job, and the host asserts the fleet is. Neither side is trusted to
# notice its own absence.
#
# Identical in shape to fleet-test-freshness.sh (job 13), which does this for
# the tool-test sweep. If you are changing one, look at the other.
#
# Healthy = SILENT. Alerts once per cooldown window while the report is stale.
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
REPORT="${FLEET_CRON_FRESHNESS_REPORT:-$DOMAINS_ROOT/tools/fleet-cron/.host-freshness-report}"
STAMP="${FLEET_CRON_HOST_WATCHDOG_STAMP:-$DOMAINS_ROOT/tools/scripts/.fleet-cron-host-watchdog.alerted}"
# The host job runs every 15 min; 1h is four misses, well clear of a slow run
# or a reboot without crying wolf.
MAX_AGE_SEC="${FLEET_CRON_HOST_MAX_AGE_SEC:-3600}"
COOLDOWN_SEC="${FLEET_CRON_HOST_ALERT_COOLDOWN_SEC:-21600}"   # 6h

if [[ -f "$DOMAINS_ROOT/.env" ]]; then
  SLACK_BOT_TOKEN="$(grep -m1 '^SLACK_BOT_TOKEN=' "$DOMAINS_ROOT/.env" | cut -d= -f2-)"
  export SLACK_BOT_TOKEN
fi

now="$(date +%s)"
if [[ -f "$REPORT" ]]; then
  age=$(( now - $(stat -c %Y "$REPORT") ))
  (( age <= MAX_AGE_SEC )) && { rm -f "$STAMP"; exit 0; }
  detail="Last host check: $(date -d "@$(stat -c %Y "$REPORT")" -Iseconds) ($((age / 60))m ago, threshold $((MAX_AGE_SEC / 60))m)."
else
  detail="No report at $REPORT — the host-side watchdog has never completed."
fi

if [[ -f "$STAMP" ]]; then
  (( now - $(stat -c %Y "$STAMP") < COOLDOWN_SEC )) && exit 0
fi
touch "$STAMP"

[[ -n "${SLACK_BOT_TOKEN:-}" ]] || exit 0
timeout 30 python3 "$DOMAINS_ROOT/tools/role-notify/notify_role.py" \
  --mode structured --site fleet --role fleet-cron-host-watchdog --status warn \
  --headline "The host-side fleet-cron watchdog has stopped running" \
  --detail "$detail" \
  --detail "Check the host crontab (\`crontab -l | grep fleet-cron-freshness\`) and $DOMAINS_ROOT/tools/scripts/fleet-cron-freshness.log. Until it is back, NOTHING is watching fleet-cron itself — and fleet-cron is what runs every other fleet sweep." \
  --channel-env FLEET_CRON_FRESHNESS_CHANNEL --channel-default domain-ops >/dev/null 2>&1 || true
