#!/usr/bin/env bash
# Scheduled Lighthouse sweep for the fleet web-vitals contract.
#
# Healthy is silent.  A site alerts only when a budget/regression/error
# signature appears or clears, so a noisy lab instrument cannot train ops to
# ignore it.  Mobile is the primary baseline; desktop is a separate weekly
# comparison and never overwrites latest-mobile.json.
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
TOOL_DIR="$DOMAINS_ROOT/tools/web-vitals"
FORM_FACTOR="${1:-mobile}"
[[ "$FORM_FACTOR" == mobile || "$FORM_FACTOR" == desktop ]] || exit 2
LOG="${VITALS_SWEEP_LOG:-$TOOL_DIR/vitals-sweep-${FORM_FACTOR}.log}"
LOCK="${VITALS_SWEEP_LOCK:-$TOOL_DIR/.vitals-sweep-${FORM_FACTOR}.lock}"
STATE="${VITALS_SWEEP_STATE:-$TOOL_DIR/.vitals-sweep-${FORM_FACTOR}.state.json}"
NOTIFY_ENABLED="${VITALS_SWEEP_NOTIFY:-1}"
LOG_MAX_BYTES="${VITALS_SWEEP_LOG_MAX_BYTES:-5242880}"
WARN_SECONDS="${VITALS_SWEEP_WARN_SECONDS:-1800}"
DURATION_STATE="${VITALS_SWEEP_DURATION_STATE:-$TOOL_DIR/.vitals-sweep-${FORM_FACTOR}.slow}"

mkdir -p "$TOOL_DIR"
exec 9>"$LOCK"
flock -n 9 || exit 0

if [[ -f "$LOG" ]]; then
  size="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  [[ "$size" =~ ^[0-9]+$ ]] && (( size > LOG_MAX_BYTES )) && mv -f "$LOG" "$LOG.1"
fi
log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }
notify_event() {
  local status="$1" headline="$2" detail="$3"
  [[ "$NOTIFY_ENABLED" == 1 ]] || return 0
  timeout 30 python3 "$DOMAINS_ROOT/tools/role-notify/notify_role.py" \
    --mode structured --site fleet --role web-vitals --status "$status" \
    --headline "$headline" --detail "$detail" \
    --channel-env VITALS_SWEEP_CHANNEL --channel-default domain-ops \
    >/dev/null 2>&1 || true
}

if [[ -f "$DOMAINS_ROOT/.env" ]]; then
  SLACK_BOT_TOKEN="$(grep -m1 '^SLACK_BOT_TOKEN=' "$DOMAINS_ROOT/.env" | cut -d= -f2-)"
  VITALS_SWEEP_CHANNEL="${VITALS_SWEEP_CHANNEL:-$(grep -m1 '^VITALS_SWEEP_CHANNEL=' "$DOMAINS_ROOT/.env" | cut -d= -f2-)}"
  export SLACK_BOT_TOKEN VITALS_SWEEP_CHANNEL
fi

args=(--json)
[[ "$FORM_FACTOR" == desktop ]] && args+=(--desktop)
report="$(timeout "${VITALS_SWEEP_TIMEOUT:-2400}" python3 "$TOOL_DIR/vitals-sweep.py" "${args[@]}" 2>>"$LOG")"
rc=$?
if (( rc != 0 )) || [[ -z "$report" || "${report:0:1}" != "{" ]]; then
  log "sweep failed form_factor=$FORM_FACTOR exit=$rc"
  notify_event fail "Scheduled $FORM_FACTOR web-vitals sweep failed" \
    "The fleet sweep did not produce a report (exit=$rc). Inspect $LOG."
  exit 0
fi

events="$(python3 - "$report" "$STATE" "$FORM_FACTOR" "$TOOL_DIR" <<'PY'
import json, sys
from pathlib import Path

report = json.loads(sys.argv[1])
state_path = Path(sys.argv[2])
factor = sys.argv[3]
sys.path.insert(0, sys.argv[4])
from alert_state import transition
try:
    previous = json.loads(state_path.read_text()) if state_path.exists() else {}
except Exception:
    previous = {}

events, state = transition(report, previous, factor)
for event in events:
    print(json.dumps(event))

tmp = state_path.with_suffix('.tmp')
tmp.write_text(json.dumps(state, indent=2))
tmp.replace(state_path)
PY
)"

duration="$(python3 -c 'import json,sys; print(float(json.loads(sys.argv[1]).get("duration_seconds", 0)))' "$report")"
summary="$(python3 -c 'import json,sys; r=json.loads(sys.argv[1]); t=r["totals"]; print("sites=%s skipped=%s warnings=%s errors=%s regressed=%s over_budget=%s a11y=%s" % (t["sites"],t.get("skipped",0),t.get("warnings",0),t["errors"],t["regressed"],t["over_budget"],t["a11y_failing"]))' "$report")"
log "sweep ok form_factor=$FORM_FACTOR duration=${duration}s $summary"
if awk "BEGIN { exit !($duration >= $WARN_SECONDS) }"; then
  log "sweep slow form_factor=$FORM_FACTOR duration=${duration}s threshold=${WARN_SECONDS}s"
  if [[ ! -f "$DURATION_STATE" ]]; then
    printf '%s\n' "$duration" > "$DURATION_STATE"
    notify_event warn "Scheduled $FORM_FACTOR web-vitals sweep is slow" \
      "The fleet sweep took ${duration}s (warning threshold ${WARN_SECONDS}s)."
  fi
else
  rm -f "$DURATION_STATE"
fi

while IFS= read -r event; do
  [[ -n "$event" ]] || continue
  eval "$(python3 - "$event" <<'PY'
import json, shlex, sys
r=json.loads(sys.argv[1])
for k in ('status','site','headline','detail'):
    print(f'{k.upper()}={shlex.quote(str(r.get(k, "")))}')
PY
)"
  [[ "$NOTIFY_ENABLED" == 1 ]] || continue
  timeout 30 python3 "$DOMAINS_ROOT/tools/role-notify/notify_role.py" \
    --mode structured --site "$SITE" --role web-vitals --status "$STATUS" \
    --headline "$HEADLINE" --detail "$DETAIL" \
    --channel-env VITALS_SWEEP_CHANNEL --channel-default "domain-${SITE//./-}" \
    >/dev/null 2>&1 || true
done <<< "$events"

exit 0
