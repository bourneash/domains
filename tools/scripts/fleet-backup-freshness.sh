#!/usr/bin/env bash
# Fleet-cron Job 19 — asserts the offsite backup actually ran.
#
# The backup (tools/fleet-backup/backup.py) runs from the HOST crontab because
# it needs boto3, which is not in this Alpine container. Host cron's failure
# mode is a silent wipe. This is the half that makes that loud: the host runs
# the backup, the fleet notices when it stops.
#
# A backup that quietly stopped is indistinguishable from a working one right
# up until you need it.
#
# Healthy = SILENT. One alert per cooldown window while it is stale.
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
TOOL_DIR="$DOMAINS_ROOT/tools/fleet-backup"
STATE="$TOOL_DIR/state.json"
STAMP="$TOOL_DIR/.freshness-alerted"
MAX_AGE_SEC="${FLEET_BACKUP_MAX_AGE_SEC:-172800}"     # 48h — a daily job plus slack
COOLDOWN_SEC="${FLEET_BACKUP_ALERT_COOLDOWN_SEC:-86400}"

now="$(date +%s)"
if [[ -f "$STATE" ]]; then
  age=$(( now - $(stat -c %Y "$STATE") ))
  (( age <= MAX_AGE_SEC )) && { rm -f "$STAMP"; exit 0; }
  detail="Last successful backup: $(date -d "@$(stat -c %Y "$STATE")" -Iseconds) ($((age / 3600))h ago)."
else
  detail="No state file at $STATE — the backup has never completed on this host."
fi

if [[ -f "$STAMP" ]] && (( now - $(stat -c %Y "$STAMP") < COOLDOWN_SEC )); then
  exit 0
fi
touch "$STAMP"

if [[ -f "$DOMAINS_ROOT/.env" ]]; then
  SLACK_BOT_TOKEN="$(grep -m1 '^SLACK_BOT_TOKEN=' "$DOMAINS_ROOT/.env" | cut -d= -f2-)"
  export SLACK_BOT_TOKEN
fi
[[ -n "${SLACK_BOT_TOKEN:-}" ]] || exit 0

timeout 30 python3 "$DOMAINS_ROOT/tools/role-notify/notify_role.py" \
  --mode structured --site fleet --role fleet-backup --status warn \
  --headline "The fleet offsite backup has stopped running" \
  --detail "$detail" \
  --detail "Check \`crontab -l | grep fleet-backup\` and $TOOL_DIR/backup.log. cf-stats history, the data-hub and site-tracker databases, Gatus uptime and the dashboard action log are unprotected until this is back." \
  --channel-env FLEET_TEST_CHANNEL --channel-default domain-ops >/dev/null 2>&1 || true
