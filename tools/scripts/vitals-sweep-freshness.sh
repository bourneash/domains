#!/usr/bin/env bash
# Watchdog for the scheduled web-vitals measurements themselves.
set -uo pipefail
ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
REPORTS="$ROOT/tools/web-vitals/reports"
STATE="${VITALS_FRESHNESS_STATE:-$ROOT/tools/web-vitals/.freshness.state}"
LOG="$ROOT/tools/web-vitals/vitals-freshness.log"
LOCK="$ROOT/tools/web-vitals/.vitals-freshness.lock"
MAX_MOBILE_AGE="${VITALS_MAX_MOBILE_AGE_SEC:-129600}"   # 36h
MAX_DESKTOP_AGE="${VITALS_MAX_DESKTOP_AGE_SEC:-691200}"  # 8d
exec 9>"$LOCK"
flock -n 9 || exit 0
mkdir -p "$(dirname "$LOG")"
log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }
[[ -f "$ROOT/.env" ]] && { SLACK_BOT_TOKEN="$(grep -m1 '^SLACK_BOT_TOKEN=' "$ROOT/.env" | cut -d= -f2-)"; export SLACK_BOT_TOKEN; }
bad=()
for spec in "mobile:$MAX_MOBILE_AGE" "desktop:$MAX_DESKTOP_AGE"; do
  factor="${spec%%:*}"; max="${spec#*:}"; file="$REPORTS/latest-$factor.json"
  if [[ ! -f "$file" ]]; then bad+=("$factor report missing"); continue; fi
  age=$(( $(date +%s) - $(stat -c %Y "$file" 2>/dev/null || echo 0) ))
  (( age > max )) && bad+=("$factor report is ${age}s old (limit ${max}s)")
done
if (( ${#bad[@]} == 0 )); then
  rm -f "$STATE"; log "ok — mobile and desktop reports are fresh"; exit 0
fi
signature="$(printf '%s\n' "${bad[@]}" | sort | tr '\n' '|')"
old="$(cat "$STATE" 2>/dev/null || true)"
log "stale: ${bad[*]}"
[[ "$signature" == "$old" ]] && exit 0
printf '%s' "$signature" > "$STATE"
[[ -z "${SLACK_BOT_TOKEN:-}" ]] && exit 0
detail="$(printf '%s\n' "${bad[@]}" | sed 's/^/• /')"
python3 "$ROOT/tools/role-notify/notify_role.py" --mode structured \
  --site fleet --role web-vitals --status warn \
  --headline "Scheduled web-vitals sweep is stale" --detail "$detail" \
  --channel-env VITALS_SWEEP_CHANNEL --channel-default domain-ops >/dev/null 2>&1 || true
exit 0
