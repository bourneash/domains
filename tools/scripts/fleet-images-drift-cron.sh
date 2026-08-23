#!/usr/bin/env bash
# Fleet shared-image drift watchdog.
#
# Runs tools/fleet-images/bin/fleet-doctor on a schedule and alerts only when
# something is actually wrong. Healthy = SILENT on Slack (same convention as
# the engineer pulse) — a watchdog that posts every time it is happy trains
# people to ignore it.
#
# WHY A SCHEDULED GATE AT ALL
# The fleet reached 53 hand-maintained image definitions in 23 substantive
# variants because nothing ever asserted "these should be the same". The
# consolidation is only durable if the invariant is checked continuously:
# every site on the current shared image, crontab bind-mounted with a real
# source file, running as uid 1000, scheduler actually loading jobs. The
# pre-commit guard stops NEW per-site Dockerfiles; this catches everything
# else — a container left on a stale image after a build, a site edited by
# hand, a scheduler that came up loading zero jobs.
#
# The worker probe (--probe-worker) is deliberately NOT used here: it starts a
# container per site, which is fine as a rollout gate but far too heavy every
# few hours. Run it by hand after an image roll.
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
DOCTOR="$DOMAINS_ROOT/tools/fleet-images/bin/fleet-doctor"
LOG="${FLEET_IMAGES_DRIFT_LOG:-$DOMAINS_ROOT/tools/scripts/fleet-images-drift.log}"
LOCK="${FLEET_IMAGES_DRIFT_LOCK:-$DOMAINS_ROOT/tools/scripts/fleet-images-drift.lock}"
LOG_MAX_BYTES="${FLEET_IMAGES_DRIFT_LOG_MAX_BYTES:-2097152}"
CHANNEL="${FLEET_IMAGES_DRIFT_CHANNEL:-domain-ops}"
# Don't re-alert the same failure every tick; one message per this window.
ALERT_COOLDOWN_SEC="${FLEET_IMAGES_DRIFT_COOLDOWN:-21600}"   # 6h
STATE="${FLEET_IMAGES_DRIFT_STATE:-$DOMAINS_ROOT/tools/scripts/.fleet-images-drift.last-alert}"

exec 9>"$LOCK"
flock -n 9 || exit 0

if [[ -f "$LOG" ]]; then
  sz="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  [[ "$sz" =~ ^[0-9]+$ ]] && (( sz > LOG_MAX_BYTES )) && mv -f "$LOG" "$LOG.1"
fi
log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

[[ -f "$DOMAINS_ROOT/.env" ]] && { set -a; . "$DOMAINS_ROOT/.env"; set +a; }
NOTIFY() {
  local text="$1" color="$2"
  [[ -z "${SLACK_BOT_TOKEN:-}" ]] && return 0
  local payload
  payload=$(python3 -c "
import json, sys
print(json.dumps({'channel': sys.argv[1], 'attachments': [{'color': sys.argv[3], 'text': sys.argv[2], 'mrkdwn_in': ['text']}]}))
" "$CHANNEL" "$text" "$color" 2>/dev/null) || return 0
  curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H "Content-Type: application/json" \
    -d "$payload" https://slack.com/api/chat.postMessage >/dev/null 2>&1 || true
}

[[ -x "$DOCTOR" ]] || { log "fleet-doctor not executable at $DOCTOR"; exit 0; }

out="$("$DOCTOR" 2>&1)"
rc=$?
# Strip ANSI so the log and any Slack message are readable.
clean="$(printf '%s' "$out" | sed 's/\x1b\[[0-9;]*m//g')"
summary="$(printf '%s' "$clean" | grep -E '^fleet-doctor:' | tail -1)"

if [[ $rc -eq 0 ]]; then
  log "healthy — ${summary:-no summary}"
  exit 0
fi

# Failure. Include the failing lines AND their site headings so the alert is
# actionable without shelling in.
failures="$(printf '%s' "$clean" | awk '
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/ { site=$0; next }
  /✗|FATAL/ { print (site ? site ": " : "") $0 }
')"
log "FAILED (rc=$rc) — ${summary:-no summary}"
printf '%s\n' "$failures" >> "$LOG"

now="$(date +%s)"
last=0
[[ -f "$STATE" ]] && last="$(cat "$STATE" 2>/dev/null || echo 0)"
[[ "$last" =~ ^[0-9]+$ ]] || last=0
if (( now - last < ALERT_COOLDOWN_SEC )); then
  log "alert suppressed — last alert $(( (now - last) / 60 ))min ago (cooldown $(( ALERT_COOLDOWN_SEC / 3600 ))h)"
  exit 0
fi
echo "$now" > "$STATE"

NOTIFY ":warning: *Fleet shared-image drift detected* — \`fleet-doctor\` is failing.
\`\`\`
${summary}
$(printf '%s' "$failures" | head -12)
\`\`\`
Run \`tools/fleet-images/bin/fleet-doctor\` for the full report. Most drift is fixed by \`tools/fleet-images/bin/fleet-image-build cron --roll\`." "danger"

exit 0
