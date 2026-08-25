#!/usr/bin/env bash
# Host-side watchdog for fleet-cron itself — the scheduler-of-schedulers.
#
# WHY THIS RUNS ON THE HOST AND NOT IN THE FLEET
# Every other freshness check runs inside fleet-cron (job 15,
# cron-freshness-cron.sh, which covers all 26 site schedulers). fleet-cron
# cannot cover ITSELF from in there: a wedged fleet-cron is precisely the thing
# that would fail to run the sweep that would have reported it. Self-checking
# would be circular by construction, so this one line lives on the host.
#
# It mirrors the fleet-test pattern exactly, in the opposite direction:
# fleet-test's sweep runs on the host and fleet-cron job 13 asserts its report
# landed. Here the check runs on the host and fleet-cron job 16 asserts THIS
# report landed — so a wiped host crontab (host cron's silent failure mode, the
# thing the fleet-cron migration existed to kill) is itself noticed. Each side
# watches the other; neither is trusted to notice its own absence.
#
# Healthy = SILENT on Slack, same contract as every other fleet sweep.
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
DETECTOR="$DOMAINS_ROOT/tools/scripts/cron-freshness.py"
LOG="${FLEET_CRON_FRESHNESS_LOG:-$DOMAINS_ROOT/tools/scripts/fleet-cron-freshness.log}"
LOCK="${FLEET_CRON_FRESHNESS_LOCK:-$DOMAINS_ROOT/tools/scripts/fleet-cron-freshness.lock}"
# The report fleet-cron job 16 asserts the freshness of. Its mtime IS the
# heartbeat — if this file goes stale, the host stopped checking.
REPORT="${FLEET_CRON_FRESHNESS_REPORT:-$DOMAINS_ROOT/tools/fleet-cron/.host-freshness-report}"
STATE="${FLEET_CRON_FRESHNESS_STATE:-$DOMAINS_ROOT/tools/scripts/.fleet-cron-freshness.state}"
LOG_MAX_BYTES="${FLEET_CRON_FRESHNESS_LOG_MAX_BYTES:-2097152}"
CHANNEL="${FLEET_CRON_FRESHNESS_CHANNEL:-domain-ops}"
ALERT_COOLDOWN_SEC="${FLEET_CRON_FRESHNESS_COOLDOWN:-21600}"   # 6h
# How many restarts inside the rolling window before it counts as churn.
RESTART_WINDOW_SEC="${FLEET_CRON_RESTART_WINDOW_SEC:-21600}"   # 6h
RESTART_MAX="${FLEET_CRON_RESTART_MAX:-4}"

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

# ── restart churn ───────────────────────────────────────────────────────────
# `.State.RestartCount` counts ONLY restart-policy restarts, so an API-driven
# `docker restart` leaves it at 0 — which is exactly what fleet-cron was
# observed doing on 2026-08-25 (four starts in two hours, RestartCount=0, no
# autoheal action, nothing in the host crontab or the dashboard action log to
# explain it). The detector's flap check keys off RestartCount and therefore
# cannot see this class at all. Tracking StartedAt across runs can, and it
# makes the NEXT unexplained restart attributable to a 15-minute window instead
# of needing forensics.
started_at="$(docker inspect -f '{{.State.StartedAt}}' fleet-cron 2>/dev/null || true)"
now="$(date +%s)"
prev_started=""; restarts=""
if [[ -f "$STATE" ]]; then
  prev_started="$(sed -n '1p' "$STATE" 2>/dev/null || true)"
  restarts="$(sed -n '2p' "$STATE" 2>/dev/null || true)"
fi
if [[ -n "$started_at" && -n "$prev_started" && "$started_at" != "$prev_started" ]]; then
  log "fleet-cron RESTARTED (StartedAt ${prev_started} -> ${started_at}) — nothing in this repo asks for that"
  restarts="${restarts:+$restarts }$now"
fi
# Drop restart stamps older than the rolling window.
kept=""
for stamp in ${restarts:-}; do
  [[ "$stamp" =~ ^[0-9]+$ ]] || continue
  (( now - stamp <= RESTART_WINDOW_SEC )) && kept="${kept:+$kept }$stamp"
done
restarts="$kept"
printf '%s\n%s\n' "$started_at" "$restarts" > "$STATE"
restart_count="$(printf '%s\n' $restarts | grep -c . || true)"

# ── freshness ───────────────────────────────────────────────────────────────
cov_file="$(mktemp)"
trap 'rm -f "$cov_file"' EXIT
out="$(python3 "$DETECTOR" --fleet-cron 2>"$cov_file")"
rc=$?
coverage="$(grep '^COVERAGE ' "$cov_file" 2>/dev/null | tail -1)"

if (( restart_count >= RESTART_MAX )); then
  out="${out:+$out
}fleet-cron: restarted ${restart_count}x in the last $(( RESTART_WINDOW_SEC / 3600 ))h with RestartCount=0 — something outside the restart policy is bouncing the scheduler"
  rc=1
fi

# Heartbeat: written on EVERY completed run, healthy or not. fleet-cron job 16
# asserts this file's mtime, so it must not be conditional on the verdict —
# only on this script having actually finished.
{
  echo "checked_at=$(date -Iseconds)"
  echo "fleet_cron_started_at=${started_at:-unknown}"
  echo "restarts_in_window=${restart_count}"
  echo "coverage=${coverage:-unavailable}"
  echo "rc=${rc}"
  [[ -n "$out" ]] && printf 'findings<<EOF\n%s\nEOF\n' "$out"
} > "$REPORT"

if (( rc == 2 )); then
  log "DETECTOR ERROR: $out"
  NOTIFY ":rotating_light: fleet-cron freshness detector failed to run:
\`\`\`
${out:0:1200}
\`\`\`" "danger"
  exit 0
fi

if (( rc == 0 )); then
  log "ok — fleet-cron firing [${coverage:-COVERAGE unavailable}] restarts_in_window=${restart_count}"
  exit 0
fi

log "FINDINGS [${coverage:-COVERAGE unavailable}]:"
printf '%s\n' "$out" | sed 's/^/  /' >> "$LOG"

last=0
[[ -f "$STATE.alert" ]] && last="$(cat "$STATE.alert" 2>/dev/null || echo 0)"
[[ "$last" =~ ^[0-9]+$ ]] || last=0
if (( now - last < ALERT_COOLDOWN_SEC )); then
  log "alert suppressed by cooldown ($(( (ALERT_COOLDOWN_SEC - (now - last)) / 60 ))m remaining)"
  exit 0
fi
echo "$now" > "$STATE.alert"

NOTIFY ":alarm_clock: *fleet-cron itself is not healthy* — this is the scheduler that runs every other fleet sweep, including the one that watches the 26 site schedulers:
\`\`\`
${out:0:2000}
\`\`\`
Nothing else is watching fleet-cron. Check \`docker logs fleet-cron\` and \`docker ps -a --filter name=fleet-cron\`." "danger"

exit 0
