#!/usr/bin/env bash
# Host cron entry for the fleet link-rot sweep (tools/link-rot/link-sweep.py).
#
# The sweep itself is zero-AI: HTTP plus a regex over anchors. This wrapper adds
# the fleet conventions around it — one run at a time, a rotating log, and Slack
# only for links that broke SINCE the last sweep. Healthy is SILENT, same
# contract as the lint sweep and the engineer pulse: a weekly "still 27 dead
# links" post trains everyone to ignore the channel, and a dead link that
# nobody has fixed is not news.
#
# Notifies on:
#   - a dead internal/cross-site link that was not dead on the previous sweep
#   - a site whose last dead link cleared
#
# Outbound links are NOT swept here. They are slow, they hit third parties from
# this host's IP on a schedule, and their failures are frequently transient or
# bot-blocked — exactly the profile that generates noise instead of signal. Run
# `--outbound` by hand when you actually want that answer.
#
# Env toggles:
#   LINK_SWEEP_NOTIFY=0        no Slack at all (still writes reports + log)
#   LINK_SWEEP_MAX_PAGES=N     pages per site (default 60)
#   LINK_SWEEP_CHANNEL=<chan>  route every alert to one ops channel instead of
#                              fanning out to each site's domain-<host> channel
set -uo pipefail

DOMAINS_ROOT="${FLEET_DOMAINS_ROOT:-/home/jesse/projects/domains}"
TOOL_DIR="$DOMAINS_ROOT/tools/link-rot"
LOG="${LINK_SWEEP_LOG:-$TOOL_DIR/link-sweep.log}"
LOCK="${LINK_SWEEP_LOCK:-$TOOL_DIR/.link-sweep.lock}"
NOTIFY_ENABLED="${LINK_SWEEP_NOTIFY:-1}"
MAX_PAGES="${LINK_SWEEP_MAX_PAGES:-60}"
LOG_MAX_BYTES="${LINK_SWEEP_LOG_MAX_BYTES:-5242880}"

mkdir -p "$TOOL_DIR"

# A slow sweep must never overlap the next tick.
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

# The previous report is the baseline for "what is new". Read it BEFORE the
# sweep overwrites it — link-sweep.py's own --fail-on-new does this internally,
# but this wrapper needs the per-site breakdown to route each alert to the
# right channel.
# Copied to a file, never carried in the environment: the report includes the
# full checked-URL set per site and is comfortably larger than ARG_MAX, so
# exporting it fails the whole script with E2BIG (it did, first run).
PREV="$TOOL_DIR/reports/latest.json"
BASELINE="$TOOL_DIR/.baseline.json"
rm -f "$BASELINE"
[[ -f "$PREV" ]] && cp -f "$PREV" "$BASELINE"

if ! timeout 3600 python3 "$TOOL_DIR/link-sweep.py" --max-pages "$MAX_PAGES" --json \
     >"$TOOL_DIR/.last-run.json" 2>>"$LOG"; then
  rc=$?
  log "sweep failed (exit $rc)"
  exit 0
fi

eval "$(python3 - "$TOOL_DIR/.last-run.json" "$BASELINE" <<'PY'
import json, os, sys, shlex

with open(sys.argv[1]) as fh:
    r = json.load(fh)

baseline_path = sys.argv[2]
prev_raw = ""
if os.path.exists(baseline_path):
    with open(baseline_path) as fh:
        prev_raw = fh.read()

DEAD = {"broken", "unreachable", "page-unreachable"}


# Outbound is not swept by cron, but guard anyway: a hand-run with --outbound
# that happened to write the baseline must not turn into a wall of third-party
# alerts on the next scheduled tick.
def dead_of(findings):
    return {f["url"] for f in findings
            if f["issue"] in DEAD and f["kind"] != "outbound"}


prev = {}
if prev_raw.strip():
    try:
        for s in json.loads(prev_raw).get("sites", []):
            prev[s["site"]] = dead_of(s.get("findings", []))
    except Exception:
        prev = {}

new_by_site, fixed = {}, []
for s in r["sites"]:
    now = dead_of(s.get("findings", []))
    was = prev.get(s["site"])
    if was is None:
        continue          # no history for this site: not "all new"
    fresh = now - was
    if fresh:
        new_by_site[s["site"]] = sorted(fresh)
        continue
    # A link is only "fixed" if this run actually put a request behind it and
    # it passed. Without the intersection, a run with a smaller --max-pages
    # reports every unvisited dead link as cleared — which it did, the first
    # time this wrapper was exercised.
    checked = set(s.get("checked", []))
    recovered = (was - now) & checked
    if was and recovered and not now:
        fixed.append(s["site"])

t = r["totals"]
print(f'SUMMARY="{len(r["sites"])} {t["dead"]} {t["internal_dead"]} {t["cross_site_dead"]} {t["redirect_chains"]}"')
print("NEW_SITES=(%s)" % " ".join(shlex.quote(s) for s in sorted(new_by_site)))
for site, urls in new_by_site.items():
    key = site.replace(".", "_").replace("-", "_")
    print("NEW_URLS_%s=%s" % (key, shlex.quote("\n".join(urls))))
print("FIXED_SITES=(%s)" % " ".join(shlex.quote(s) for s in sorted(fixed)))
PY
)"

read -r n_sites n_dead n_int n_cross n_chain <<<"$SUMMARY"
log "sweep ok — sites=$n_sites dead=$n_dead internal=$n_int cross_site=$n_cross chains=$n_chain new=${#NEW_SITES[@]} fixed=${#FIXED_SITES[@]}"

notify() {
  local site="$1" status="$2" headline="$3" detail="$4"
  [[ "$NOTIFY_ENABLED" == "1" ]] || return 0
  [[ -n "${SLACK_BOT_TOKEN:-}" ]] || return 0
  timeout 30 python3 "$DOMAINS_ROOT/tools/role-notify/notify_role.py" \
    --mode structured --site "$site" --role link-sweep --status "$status" \
    --headline "$headline" --detail "$detail" \
    --channel-env LINK_SWEEP_CHANNEL \
    --channel-default "domain-${site//./-}" >/dev/null 2>&1 || true
}

for site in "${NEW_SITES[@]:-}"; do
  [[ -n "$site" ]] || continue
  key="${site//./_}"; key="${key//-/_}"
  urls_var="NEW_URLS_${key}"
  urls="${!urls_var:-}"
  count="$(printf '%s\n' "$urls" | grep -c . || true)"
  # Cap the detail: a template bug can break a hundred links at once, and a
  # hundred-line Slack card is not more actionable than a ten-line one.
  detail="$(printf '%s' "$urls" | head -10 | sed 's/^/`/; s/$/`/' | paste -sd$'\n' -)"
  (( count > 10 )) && detail="$detail"$'\n'"…and $((count - 10)) more — see tools/link-rot/reports/latest.json"
  notify "$site" warn "$count newly dead link(s) on this site" "$detail"
  log "notified $site (new dead links: $count)"
done

for site in "${FIXED_SITES[@]:-}"; do
  [[ -n "$site" ]] || continue
  notify "$site" ok "All dead links cleared" "Verified by tools/link-rot/link-sweep.py"
  log "notified $site (dead links cleared)"
done

exit 0
