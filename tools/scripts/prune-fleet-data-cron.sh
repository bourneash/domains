#!/usr/bin/env bash
# Fleet local-data retention sweep — the cron entry point.
#
# Healthy = SILENT on Slack, same contract as the lint / git / image / cron-
# freshness sweeps. A retention job that announces every nightly run is a job
# that gets muted, and a muted job is one nobody notices failing.
#
# WHAT THIS CLOSES
# Nothing on this host had a retention step. tools/cf-stats/out reached 423 MB
# across 112 daily JSONL files growing ~5 MB/day, and sites/*/ops/logs reached
# 74,185 files on a root filesystem already at 70%. Neither had a prune, a
# rotate, or a size cap anywhere in the tool or in any crontab.
#
# The detector (prune-fleet-data.py) COMPRESSES, it does not delete — cf-stats
# is the only historical Cloudflare record on this host and nothing backs it
# up, and the role logs are the audit trail for autonomous publishing runs.
# Read that script's docstring before changing what is in scope; in particular
# the *.jsonl ledgers under ops/logs are deliberately excluded because
# tools/ai-usage/aggregate.py and tools/engineer-fleet/engineer-status.py read
# them as data.
#
# Companion change: tools/cf-grafana/ingest.py now globs `.jsonl.gz` as well
# as `.jsonl`. Those two must stay in step — compressing ledgers under an
# ingester that only sees plain .jsonl would silently drop fleet history from
# the Grafana dashboards without erroring anywhere.
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
DETECTOR="$DOMAINS_ROOT/tools/scripts/prune-fleet-data.py"
LOG="${FLEET_PRUNE_LOG:-$DOMAINS_ROOT/tools/scripts/prune-fleet-data.log}"
LOCK="${FLEET_PRUNE_LOCK:-$DOMAINS_ROOT/tools/scripts/prune-fleet-data.lock}"
LOG_MAX_BYTES="${FLEET_PRUNE_LOG_MAX_BYTES:-2097152}"
CHANNEL="${FLEET_PRUNE_CHANNEL:-domain-ops}"
RETAIN_DAYS="${FLEET_PRUNE_RETAIN_DAYS:-30}"
# One informational post when a run reclaims at least this much — the first
# run reclaims ~280 MB and that IS worth seeing once. Steady state is a few
# MB/day and stays silent.
NOTIFY_MIN_MB="${FLEET_PRUNE_NOTIFY_MIN_MB:-500}"

EXTRA=()
[[ "${1:-}" == "--dry-run" ]] && EXTRA+=(--dry-run)

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

# Report on stdout, one machine-readable SUMMARY line on stderr — same split
# as cron-freshness.py, so a clean run still records HOW MUCH it moved rather
# than just exiting 0.
sum_file="$(mktemp)"
trap 'rm -f "$sum_file"' EXIT
out="$(python3 "$DETECTOR" --retain-days "$RETAIN_DAYS" "${EXTRA[@]+"${EXTRA[@]}"}" 2>"$sum_file")"
rc=$?
summary="$(grep '^SUMMARY ' "$sum_file" 2>/dev/null | tail -1)"

# rc 2 is the sweep failing to start at all (unreadable root, bad args). That
# is a problem with the retention job itself and staying quiet about it would
# reproduce exactly the silence this job exists to remove.
if (( rc != 0 )); then
  log "SWEEP ERROR (rc=$rc): $(printf '%s' "$out" | head -5 | tr '\n' ' ') $(head -3 "$sum_file" | tr '\n' ' ')"
  NOTIFY ":rotating_light: Fleet data-retention sweep failed to run (rc=$rc):
\`\`\`
${out:0:1200}
\`\`\`
See \`tools/scripts/prune-fleet-data-cron.sh\`." "danger"
  exit 0
fi

log "${summary:-SUMMARY unavailable}"
printf '%s\n' "$out" | sed 's/^/  /' >> "$LOG"

# Per-file failures (a bad gzip round-trip, an unreadable tar) leave the
# original in place and are counted, not raised — but a run with errors must
# still be visible, because the failure mode is "space silently stops being
# reclaimed" and that looks identical to "nothing was in range".
errors="$(printf '%s' "$summary" | grep -oE 'errors=[0-9]+' | cut -d= -f2)"
[[ "$errors" =~ ^[0-9]+$ ]] || errors=0
if (( errors > 0 )); then
  NOTIFY ":warning: Fleet data-retention sweep completed with *${errors} error(s)* — those files were left untouched, so they will be retried on the next run. Details in \`tools/scripts/prune-fleet-data.log\`." "warning"
  exit 0
fi

bytes="$(printf '%s' "$summary" | grep -oE 'total_bytes=[0-9]+' | cut -d= -f2)"
[[ "$bytes" =~ ^[0-9]+$ ]] || bytes=0
if (( bytes >= NOTIFY_MIN_MB * 1024 * 1024 )); then
  mb="$(python3 -c "print(f'{$bytes/1048576:.0f}')" 2>/dev/null || echo '?')"
  NOTIFY ":package: Fleet data-retention sweep reclaimed *${mb} MB* — cf-stats/gh-stats ledgers older than ${RETAIN_DAYS}d gzipped in place, site role logs rolled into per-day tarballs. Nothing deleted; everything is still readable. See \`tools/scripts/prune-fleet-data.py\`." "good"
fi

exit 0
