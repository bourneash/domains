#!/usr/bin/env bash
# Daily domain-renewal collection (tools/registrar/collect_registrar.py).
#
# Runs INSIDE the fleet-cron container (see tools/fleet-cron/crontab.docker):
# it needs only python3 stdlib, the repo mount, and outbound HTTPS, all of
# which that container has. No boto3, no node — so unlike the backup and
# tool-test jobs this one does not have to live on the host crontab.
#
# Renewals are the portfolio's largest recurring hard cost and nothing tracked
# them before this. The collector writes tools/registrar/cache/latest.json; the
# Fleet Dashboard's parked-inventory panel and /api/registrar read that cache,
# so the panel never makes a live Cloudflare call to render.
#
# Healthy = SILENT, same contract as every other sweep here. It alerts only on:
#   - a domain whose auto-renew is OFF and whose renewal is inside 90 days
#     (the date alone is not news; the date WITHOUT auto-renew is)
#   - the collector failing outright, which would leave the panel serving
#     silently ageing dates
#
# Env toggles:
#   REGISTRAR_NOTIFY=0        no Slack (still refreshes the cache + log)
#   REGISTRAR_CHANNEL=<chan>  override the ops channel
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
TOOL_DIR="$DOMAINS_ROOT/tools/registrar"
LOG="${REGISTRAR_LOG:-$TOOL_DIR/registrar.log}"
LOCK="${REGISTRAR_LOCK:-$TOOL_DIR/.registrar.lock}"
NOTIFY_ENABLED="${REGISTRAR_NOTIFY:-1}"
LOG_MAX_BYTES="${REGISTRAR_LOG_MAX_BYTES:-2097152}"

mkdir -p "$TOOL_DIR"

exec 9>"$LOCK"
flock -n 9 || exit 0

if [[ -f "$LOG" ]]; then
  sz="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  [[ "$sz" =~ ^[0-9]+$ ]] && (( sz > LOG_MAX_BYTES )) && mv -f "$LOG" "$LOG.1"
fi
log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

# collect_registrar.py reads CF_ACCOUNT_ID / CF_API_TOKEN from the process env
# or, failing that, straight out of the repo .env (which is chmod 400 and owned
# by uid 1000 — the same uid this container runs as).
[[ -f "$DOMAINS_ROOT/.env" ]] && { set -a; . "$DOMAINS_ROOT/.env" 2>/dev/null; set +a; }

if ! timeout 600 python3 "$TOOL_DIR/collect_registrar.py" --json \
     >"$TOOL_DIR/.last-run.json" 2>>"$LOG"; then
  rc=$?
  log "collection failed (exit $rc)"
  # A failed collection IS worth saying out loud: the dashboard keeps happily
  # serving the last cache, so a silent failure means slowly-ageing renewal
  # dates presented as current.
  if [[ "$NOTIFY_ENABLED" == "1" && -n "${SLACK_BOT_TOKEN:-}" ]]; then
    timeout 30 python3 "$DOMAINS_ROOT/tools/role-notify/notify_role.py" \
      --mode structured --site _fleet --role registrar --status warn \
      --headline "Domain renewal collection failed" \
      --detail "The dashboard is now serving an ageing cache. See tools/registrar/registrar.log" \
      --channel-env REGISTRAR_CHANNEL --channel-default "domain-ops" >/dev/null 2>&1 || true
  fi
  exit 0
fi

eval "$(python3 - "$TOOL_DIR/.last-run.json" <<'PY'
import json, shlex, sys

with open(sys.argv[1]) as fh:
    r = json.load(fh)
t = r["totals"]
print(f'SUMMARY="{t["domains"]} {t["due_90d"]} {t["due_30d"]} {t["auto_renew_off"]} {t["needs_attention"]}"')
print(f'UNRETRIEVABLE={t.get("unretrievable") or 0}')

# Only the genuinely actionable set: auto-renew OFF and actually due. A domain
# renewing itself in 20 days needs nobody, and alerting on it every day until
# it renews is how a channel gets muted.
act = [d for d in r["domains"] if d.get("attention")]
lines = [
    f'{d["domain"]} — {(d["expires_at"] or "?")[:10]} ({d["days_to_renewal"]}d), auto-renew OFF'
    for d in act
]
print("ACT_COUNT=%d" % len(act))
print("ACT_DETAIL=%s" % shlex.quote("\n".join(lines)))
PY
)"

read -r n_dom n_90 n_30 n_off n_act <<<"$SUMMARY"
log "ok — domains=$n_dom due90=$n_90 due30=$n_30 auto_renew_off=$n_off attention=$n_act unretrievable=$UNRETRIEVABLE"

if [[ "$ACT_COUNT" -gt 0 && "$NOTIFY_ENABLED" == "1" && -n "${SLACK_BOT_TOKEN:-}" ]]; then
  detail="$(printf '%s' "$ACT_DETAIL" | sed 's/^/`/; s/$/`/' | paste -sd$'\n' -)"
  timeout 30 python3 "$DOMAINS_ROOT/tools/role-notify/notify_role.py" \
    --mode structured --site _fleet --role registrar --status warn \
    --headline "$ACT_COUNT domain(s) need a renewal decision — auto-renew is OFF" \
    --detail "$detail" \
    --channel-env REGISTRAR_CHANNEL --channel-default "domain-ops" >/dev/null 2>&1 || true
  log "notified ($ACT_COUNT need attention)"
fi

exit 0
