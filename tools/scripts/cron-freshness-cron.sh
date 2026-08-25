#!/usr/bin/env bash
# Tier-2 scheduler-freshness watchdog for every site cron container.
#
# Healthy = SILENT on Slack, same convention as the engineer pulse and the
# image-drift watchdog — a watchdog that posts when it is happy gets muted.
#
# WHY THIS EXISTS SEPARATELY FROM THE CONTAINER HEALTHCHECK
# Each site's cron container now carries a Docker healthcheck
# (`grep -qx supercronic /proc/1/comm`, 120s) plus `labels: autoheal=true`, so
# a DEAD scheduler is detected and restarted by vpn-autoheal without anyone
# looking. That probe is deliberately trivial: ~8ms of CPU, no shell, no
# network, no docker CLI. It cannot see a supercronic that is alive but no
# longer firing — a wedged scheduler, a job holding a lock forever, a crontab
# that parsed to zero jobs. That is the 2026-05-17 failure mode (schedulers
# silently dead for 9 days) and it needs schedule reasoning plus log reads.
#
# Doing THAT per container would be 26 heavyweight probes on a loop, which is
# how the fleet burned itself on checks before (autoheal's baked-in 5s
# HEALTHCHECK firing a runc exec every 5s — see tools/vpn-proxy/docker-compose.yml).
# So the expensive half runs here: one host-side process, every 30 minutes,
# ~2.6s wall for the whole fleet. Cheap liveness in the container, expensive
# freshness on the host. That split is the budget rule — see
# tools/fleet-images/README.md.
#
# The threshold is derived per site from that site's own crontab, never
# hardcoded; the detector (cron-freshness.py) documents how.
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
DETECTOR="$DOMAINS_ROOT/tools/scripts/cron-freshness.py"
LOG="${CRON_FRESHNESS_LOG:-$DOMAINS_ROOT/tools/scripts/cron-freshness.log}"
LOCK="${CRON_FRESHNESS_LOCK:-$DOMAINS_ROOT/tools/scripts/cron-freshness.lock}"
LOG_MAX_BYTES="${CRON_FRESHNESS_LOG_MAX_BYTES:-2097152}"
CHANNEL="${CRON_FRESHNESS_CHANNEL:-domain-ops}"
# Don't re-alert the same wedge every 30 min; one message per this window.
ALERT_COOLDOWN_SEC="${CRON_FRESHNESS_COOLDOWN:-21600}"   # 6h
STATE="${CRON_FRESHNESS_STATE:-$DOMAINS_ROOT/tools/scripts/.cron-freshness.last-alert}"

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

[[ -r "$DETECTOR" ]] || { log "detector not readable at $DETECTOR"; exit 0; }

# Findings on stdout, the COVERAGE line on stderr — captured separately so a
# clean run still records HOW MUCH it actually checked. "exit 0" alone cannot
# distinguish "asserted all 26 sites" from "asserted nothing, every container
# was too young"; logging coverage every run is what keeps the green honest.
cov_file="$(mktemp)"
trap 'rm -f "$cov_file"' EXIT
out="$(python3 "$DETECTOR" 2>"$cov_file")"
rc=$?
coverage="$(grep '^COVERAGE ' "$cov_file" 2>/dev/null | tail -1)"
# Anything else on stderr is a real error from the detector, not coverage.
stderr_noise="$(grep -v '^COVERAGE ' "$cov_file" 2>/dev/null | grep -c . || true)"
if (( stderr_noise > 0 )); then
  log "detector stderr: $(grep -v '^COVERAGE ' "$cov_file" | head -20 | tr '\n' ' ')"
fi

# rc 2 is the detector failing to run at all (can't read sites/). That is a
# real problem with the watchdog itself, and staying quiet about it would
# reproduce the exact silence this whole tier exists to remove.
if (( rc == 2 )); then
  log "DETECTOR ERROR: $out ${coverage:+[$coverage]}"
  NOTIFY ":rotating_light: cron-freshness detector failed to run:
\`\`\`
${out:0:1500}
\`\`\`" "danger"
  exit 0
fi

if (( rc == 0 )); then
  log "ok — no findings [${coverage:-COVERAGE unavailable}]"
  # Clear the cooldown so a NEW wedge alerts immediately rather than being
  # swallowed by a stale timestamp from a previous, already-resolved one.
  rm -f "$STATE"
  exit 0
fi

count="$(printf '%s\n' "$out" | grep -c . || true)"
log "FINDINGS ($count) [${coverage:-COVERAGE unavailable}]:"
printf '%s\n' "$out" | sed 's/^/  /' >> "$LOG"

now="$(date +%s)"
last=0
[[ -f "$STATE" ]] && last="$(cat "$STATE" 2>/dev/null || echo 0)"
[[ "$last" =~ ^[0-9]+$ ]] || last=0
if (( now - last < ALERT_COOLDOWN_SEC )); then
  log "alert suppressed by cooldown ($(( (ALERT_COOLDOWN_SEC - (now - last)) / 60 ))m remaining)"
  exit 0
fi
echo "$now" > "$STATE"

NOTIFY ":alarm_clock: *Cron freshness* — ${count} site scheduler(s) not firing:
\`\`\`
${out:0:2500}
\`\`\`
Tier-1 healthcheck says supercronic is alive on these, so this is a wedge, not a crash — autoheal will not fix it. Check \`docker logs <container>\` for a job that never returned, then \`docker compose restart cron\` in that site." "danger"

exit 0
