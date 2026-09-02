#!/usr/bin/env bash
# Host cron entry for the fleet web-vitals sweep (tools/web-vitals/vitals-sweep.py).
#
# Zero AI: Lighthouse against local headless Chrome. This wrapper adds the fleet
# conventions — one run at a time, a rotating log, and Slack only for metrics
# that REGRESSED since the last run. Healthy is SILENT, same contract as the
# lint and link sweeps.
#
# Budget breaches are deliberately NOT alerted. Eight sites are over budget as
# of the first baseline (2026-09-01) and will be until someone does the work; a
# weekly card repeating that fact is how a channel gets muted. A regression —
# a site that was fine last week and is not now — is the thing worth waking up
# for. Read the standing breaches from reports/latest.json or the Vitals view.
#
# The sweep is serial by design and takes ~20 min fleet-wide. Scheduled early
# so it does not compete with the site build/deploy roles for host CPU; the
# numbers are only comparable when the box is quiet.
#
# Env toggles:
#   VITALS_SWEEP_NOTIFY=0        no Slack at all (still writes reports + log)
#   VITALS_SWEEP_DESKTOP=1       measure desktop instead of the mobile default
#   VITALS_SWEEP_CHANNEL=<chan>  route every alert to one ops channel instead of
#                                fanning out to each site's domain-<host> channel
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
TOOL_DIR="$DOMAINS_ROOT/tools/web-vitals"
LOG="${VITALS_SWEEP_LOG:-$TOOL_DIR/vitals-sweep.log}"
LOCK="${VITALS_SWEEP_LOCK:-$TOOL_DIR/.vitals-sweep.lock}"
NOTIFY_ENABLED="${VITALS_SWEEP_NOTIFY:-1}"
DESKTOP="${VITALS_SWEEP_DESKTOP:-0}"
LOG_MAX_BYTES="${VITALS_SWEEP_LOG_MAX_BYTES:-5242880}"

mkdir -p "$TOOL_DIR"

exec 9>"$LOCK"
flock -n 9 || exit 0

if [[ -f "$LOG" ]]; then
  log_size="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  if [[ "$log_size" =~ ^[0-9]+$ ]] && (( log_size > LOG_MAX_BYTES )); then
    mv -f "$LOG" "$LOG.1"
  fi
fi

log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

[[ -f "$DOMAINS_ROOT/.env" ]] && { set -a; . "$DOMAINS_ROOT/.env"; set +a; }

ARGS=(--json)
[[ "$DESKTOP" == "1" ]] && ARGS+=(--desktop)

# vitals-sweep.py computes regressions itself against reports/latest.json, so
# unlike the link sweep this wrapper does not need to hold its own baseline —
# it only needs to read back what the sweep decided.
if ! timeout 5400 python3 "$TOOL_DIR/vitals-sweep.py" "${ARGS[@]}" \
     >"$TOOL_DIR/.last-run.json" 2>>"$LOG"; then
  rc=$?
  log "sweep failed (exit $rc)"
  exit 0
fi

eval "$(python3 - "$TOOL_DIR/.last-run.json" <<'PY'
import json, sys, shlex

with open(sys.argv[1]) as fh:
    r = json.load(fh)

t = r["totals"]
print(f'SUMMARY="{t["sites"]} {t["errors"]} {t["regressed"]} {t["over_budget"]} {t["a11y_failing"]}"')

regressed = {}
for s in r["sites"]:
    if s.get("error") or not s.get("regressions"):
        continue
    m = s["metrics"]
    lines = []
    for k in s["regressions"]:
        v = m.get(k)
        lines.append(f"{k}: now {v}")
    regressed[s["site"]] = lines

print("REGRESSED_SITES=(%s)" % " ".join(shlex.quote(s) for s in sorted(regressed)))
for site, lines in regressed.items():
    key = site.replace(".", "_").replace("-", "_")
    print("REGRESSED_%s=%s" % (key, shlex.quote("\n".join(lines))))

# A site Lighthouse could not measure at all is its own signal: the sweep is
# blind there, which is different from the site being fine.
errs = [s["site"] for s in r["sites"] if s.get("error")]
print("ERROR_SITES=(%s)" % " ".join(shlex.quote(s) for s in sorted(errs)))
PY
)"

read -r n_sites n_err n_reg n_budget n_a11y <<<"$SUMMARY"
log "sweep ok — sites=$n_sites unmeasurable=$n_err regressed=$n_reg over_budget=$n_budget a11y_failing=$n_a11y"

notify() {
  local site="$1" status="$2" headline="$3" detail="$4"
  [[ "$NOTIFY_ENABLED" == "1" ]] || return 0
  [[ -n "${SLACK_BOT_TOKEN:-}" ]] || return 0
  timeout 30 python3 "$DOMAINS_ROOT/tools/role-notify/notify_role.py" \
    --mode structured --site "$site" --role vitals-sweep --status "$status" \
    --headline "$headline" --detail "$detail" \
    --channel-env VITALS_SWEEP_CHANNEL \
    --channel-default "domain-${site//./-}" >/dev/null 2>&1 || true
}

for site in "${REGRESSED_SITES[@]:-}"; do
  [[ -n "$site" ]] || continue
  key="${site//./_}"; key="${key//-/_}"
  var="REGRESSED_${key}"
  detail="$(printf '%s' "${!var:-}" | sed 's/^/`/; s/$/`/' | paste -sd$'\n' -)"
  notify "$site" warn "Web vitals regressed since the last sweep" "$detail"
  log "notified $site (regressed)"
done

for site in "${ERROR_SITES[@]:-}"; do
  [[ -n "$site" ]] || continue
  notify "$site" warn "Lighthouse could not measure this site" \
    "The sweep is blind here — see tools/web-vitals/vitals-sweep.log"
  log "notified $site (unmeasurable)"
done

exit 0
