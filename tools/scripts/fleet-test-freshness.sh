#!/usr/bin/env bash
# Fleet-cron Job 13 — asserts the tool-test sweep actually ran.
#
# The sweep (fleet-test-cron.sh) runs from the HOST crontab because its
# dependency toolchain lives in the host's pyenv 3.11.10 and that interpreter
# is glibc-2.38-linked: it will not load in fleet-cron (Alpine/musl) or in
# fleet-site-worker (bookworm, glibc 2.36 — verified). Host cron's failure mode
# is that a wiped crontab is silent, which is exactly what the fleet-cron
# migration existed to eliminate. This job buys that back: the host runs the
# sweep, the fleet notices when the host stops.
#
# Healthy = SILENT. Alerts once per cooldown window while the report is stale.
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
TOOL_DIR="$DOMAINS_ROOT/tools/fleet-test"
REPORT="$TOOL_DIR/reports/latest.json"
STAMP="$TOOL_DIR/.freshness-alerted"
MAX_AGE_SEC="${FLEET_TEST_MAX_AGE_SEC:-93600}"      # 26h — a daily job plus slack
COOLDOWN_SEC="${FLEET_TEST_ALERT_COOLDOWN_SEC:-86400}"

if [[ -f "$DOMAINS_ROOT/.env" ]]; then
  SLACK_BOT_TOKEN="$(grep -m1 '^SLACK_BOT_TOKEN=' "$DOMAINS_ROOT/.env" | cut -d= -f2-)"
  export SLACK_BOT_TOKEN
fi

now="$(date +%s)"
if [[ -f "$REPORT" ]]; then
  age=$(( now - $(stat -c %Y "$REPORT") ))
  (( age <= MAX_AGE_SEC )) && { rm -f "$STAMP"; exit 0; }
  detail="Last report: $(date -d "@$(stat -c %Y "$REPORT")" -Iseconds) ($((age / 3600))h ago)."
else
  detail="No report at $REPORT — the sweep has never completed on this host."
fi

# Don't re-post every day while it stays broken.
if [[ -f "$STAMP" ]]; then
  (( now - $(stat -c %Y "$STAMP") < COOLDOWN_SEC )) && exit 0
fi
touch "$STAMP"

[[ -n "${SLACK_BOT_TOKEN:-}" ]] || exit 0
timeout 30 python3 "$DOMAINS_ROOT/tools/role-notify/notify_role.py" \
  --mode structured --site fleet --role fleet-test --status warn \
  --headline "The fleet tool-test sweep has stopped running" \
  --detail "$detail" \
  --detail "Check the host crontab (\`crontab -l | grep fleet-test\`) and $TOOL_DIR/fleet-test.log. Nothing is testing tools/ until this is back." \
  --channel-env FLEET_TEST_CHANNEL --channel-default domain-ops >/dev/null 2>&1 || true
