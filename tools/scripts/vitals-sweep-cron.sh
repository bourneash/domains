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

mkdir -p "$TOOL_DIR"
exec 9>"$LOCK"
flock -n 9 || exit 0

if [[ -f "$LOG" ]]; then
  size="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  [[ "$size" =~ ^[0-9]+$ ]] && (( size > LOG_MAX_BYTES )) && mv -f "$LOG" "$LOG.1"
fi
log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

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
  exit 0
fi

events="$(python3 - "$report" "$STATE" "$FORM_FACTOR" <<'PY'
import json, os, sys, tempfile
from pathlib import Path

report = json.loads(sys.argv[1])
state_path = Path(sys.argv[2])
factor = sys.argv[3]
try:
    previous = json.loads(state_path.read_text()) if state_path.exists() else {}
except Exception:
    previous = {}

active = {}
for row in report.get('sites', []):
    site = row.get('site')
    if not site:
        continue
    if row.get('error'):
        active[site] = 'error:' + str(row['error'])
        continue
    warnings = row.get('warnings') or []
    if warnings:
        active[site] = 'warning:' + ';'.join(sorted(str(w) for w in warnings))
        continue
    if row.get('status') == 'skipped':
        continue
    metrics = row.get('metrics') or {}
    flags = sorted(set(row.get('budget_breaches') or []) | set(row.get('regressions') or []))
    if flags:
        active[site] = ','.join(sorted(set(flags)))

old = previous.get('active') or {}
for site, signature in sorted(active.items()):
    if old.get(site) == signature:
        continue
    row = next((x for x in report.get('sites', []) if x.get('site') == site), {})
    if row.get('error'):
        headline = f'{factor} vitals sweep could not measure site'
        detail = str(row['error'])
    else:
        m = row.get('metrics') or {}
        if str(signature).startswith('warning:'):
            headline = f'{factor} web-vitals configuration needs attention'
            detail = str(signature)[len('warning:'):]
        else:
            headline = f'{factor} web vitals need attention'
            detail = f"flags={signature}; performance={m.get('performance')}; LCP={m.get('lcp_ms')}ms; CLS={m.get('cls')}"
    print(json.dumps({'status':'warn','site':site,'headline':headline,'detail':detail}))
for site in sorted(set(old) - set(active)):
        print(json.dumps({'status':'ok','site':site,'headline':f'{factor} web vitals recovered','detail':'The latest sweep has no active budget, regression, or measurement errors.'}))

tmp = state_path.with_suffix('.tmp')
tmp.write_text(json.dumps({'at': report.get('at'), 'form_factor': factor, 'active': active}, indent=2))
tmp.replace(state_path)
PY
)"

summary="$(python3 -c 'import json,sys; r=json.loads(sys.argv[1]); t=r["totals"]; print("sites=%s skipped=%s warnings=%s errors=%s regressed=%s over_budget=%s a11y=%s" % (t["sites"],t.get("skipped",0),t.get("warnings",0),t["errors"],t["regressed"],t["over_budget"],t["a11y_failing"]))' "$report")"
log "sweep ok form_factor=$FORM_FACTOR $summary"

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
