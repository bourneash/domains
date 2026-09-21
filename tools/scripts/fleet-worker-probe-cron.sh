#!/usr/bin/env bash
# Nightly shared-worker dispatch probe; no role is invoked and no Claude call occurs.
set -uo pipefail

ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
DOCTOR="${FLEET_WORKER_PROBE_DOCTOR:-$ROOT/tools/fleet-images/bin/fleet-doctor}"
LOG="${FLEET_WORKER_PROBE_LOG:-$ROOT/tools/scripts/fleet-worker-probe.log}"
LOCK="${FLEET_WORKER_PROBE_LOCK:-$ROOT/tools/scripts/fleet-worker-probe.lock}"
STATE="${FLEET_WORKER_PROBE_STATE:-$ROOT/tools/scripts/.fleet-worker-probe.last-alert}"
CHANNEL="${FLEET_WORKER_PROBE_CHANNEL:-domain-ops}"
COOLDOWN="${FLEET_WORKER_PROBE_COOLDOWN:-86400}"

exec 9>"$LOCK"
flock -n 9 || exit 0
mkdir -p "$(dirname "$LOG")"
log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }
[[ -x "$DOCTOR" ]] || { log "missing doctor: $DOCTOR"; exit 1; }
out="$($DOCTOR --probe-worker 2>&1)"; rc=$?
clean="$(printf '%s' "$out" | sed 's/\x1b\[[0-9;]*m//g')"
summary="$(printf '%s' "$clean" | grep -E '^fleet-doctor:' | tail -1)"
log "probe rc=$rc ${summary:-no summary}"
(( rc == 0 )) && exit 0

failures="$(printf '%s\n' "$clean" | awk '
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/ { site=$0; next }
  /✗|FATAL/ { print (site ? site ": " : "") $0 }
')"
printf '%s\n' "$failures" >> "$LOG"
now="$(date +%s)"; last=0
[[ -f "$STATE" ]] && last="$(cat "$STATE" 2>/dev/null || echo 0)"
[[ "$last" =~ ^[0-9]+$ ]] || last=0
(( now - last < COOLDOWN )) && exit 1
printf '%s\n' "$now" > "$STATE"

if [[ -n "${SLACK_BOT_TOKEN:-}" ]]; then
  payload="$(python3 -c 'import json,sys; print(json.dumps({"channel":sys.argv[1],"attachments":[{"color":"danger","text":sys.argv[2],"mrkdwn_in":["text"]}]}))' "$CHANNEL" ":warning: *Fleet worker dispatch probe failed* — \`fleet-doctor --probe-worker\`\n\\\`\\\`\\\`\n${summary}\n$(printf '%s' "$failures" | head -12)\n\\\`\\\`\\\`" 2>/dev/null)" || true
  [[ -n "$payload" ]] && curl -sS --max-time 15 -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" -H 'Content-Type: application/json' --data "$payload" https://slack.com/api/chat.postMessage >/dev/null 2>&1 || true
fi
exit 1
