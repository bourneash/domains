#!/usr/bin/env bash
# Host-side cron entrypoint. Runs the affiliate sentinel against one or more
# named sites, serially.
#
# WHY THE HOST AND NOT EACH SITE'S CRON CONTAINER
#   1. The shared cron image is Alpine and has no `httpx`, which both the Amazon
#      API client (tools/amz-stats) and the cloak check depend on. Adding it
#      means rebuilding two shared images used by 26 sites.
#   2. The heal path runs the site's real `npm run build` as a gate, and
#      Alpine/musl cannot run workerd — the exact mismatch that deadlocked
#      broadwayshowgirls' engineer build gate.
# Same precedent as the fleet reaper and the cron-freshness sweep, both of which
# moved host-side for equivalent reasons.
#
# Sites are named explicitly rather than globbed, so rollout is one deliberate
# site at a time and there is no central enable-list to drift. Per-site config
# is still zero — every site's settings are derived from the site itself.
#
# Usage:
#   run-fleet.sh reviewtattoo.com [ultrarough.com ...]
#   run-fleet.sh --dry-run reviewtattoo.com
#
# One site's failure must not stop the rest — but "don't stop" was implemented
# as "never notice". Two bugs let this tool crash on EVERY site for days while
# logging success:
#   1. `echo "[$(date -Iseconds)] ... (rc=$?)"` — the command substitution runs
#      during expansion and overwrites $?, so the logged rc was date's, not the
#      sentinel's. It was structurally incapable of logging a failure.
#   2. Nothing aggregated or alerted on per-site failures anyway.
# Now: rc is captured on its own line before anything else runs, infrastructure
# failures (exit 3) are counted separately from findings, and any of them raises
# a Slack alert. Still exits 0 so one bad site cannot abort the fleet sweep.
set -uo pipefail

TOOL_DIR="$(cd "$(dirname "$0")" && pwd)"
DOMAINS_ROOT="$(cd "$TOOL_DIR/../.." && pwd)"
LOG_DIR="$TOOL_DIR/logs"
mkdir -p "$LOG_DIR"

PASSTHRU=()
SITES=()
for arg in "$@"; do
  case "$arg" in
    -*) PASSTHRU+=("$arg") ;;
    *)  SITES+=("$arg") ;;
  esac
done

if [[ "${#SITES[@]}" -eq 0 ]]; then
  echo "usage: $0 [--dry-run|--no-heal] <site.com> [site2.com ...]" >&2
  exit 0
fi

# The fleet .env carries the Amazon Creators credentials and SLACK_BOT_TOKEN.
if [[ -f "$DOMAINS_ROOT/.env" ]]; then
  set -a; . "$DOMAINS_ROOT/.env"; set +a
fi

# Post to the fleet ops channel. Used only for infrastructure failures — per-site
# findings are already reported by the sentinel itself.
alert_fleet() {
  local msg="$1"
  echo "[$(date -Iseconds)] ALERT: $msg" >>"${RUN_LOG:-/dev/stderr}"
  [[ -n "${SLACK_BOT_TOKEN:-}" ]] || return 0
  curl -sS -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H 'Content-type: application/json; charset=utf-8' \
    --data "$(printf '{"channel":"%s","text":%s}' \
      "${SLACK_CHANNEL_FLEET_OPS:-domain-fleet-ops}" \
      "$(printf '%s' "🚨 affiliate-sentinel: $msg" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '"affiliate-sentinel failure"')")" \
    >/dev/null 2>&1 || true
}

STAMP="$(date +%Y-%m-%d)"
RUN_LOG="$LOG_DIR/run-$STAMP.log"

# PREFLIGHT — resolve the interpreter ONCE, before touching any site. Without
# this, a dependency problem is discovered 25 separate times, in 25 tracebacks,
# in a log nobody reads. Fail the whole sweep loudly instead.
if ! PY_RESOLVED="$("$TOOL_DIR/bin/ensure-venv" 2>&1)"; then
  alert_fleet "preflight failed — no usable python. Sweep aborted, ZERO sites checked. $PY_RESOLVED"
  exit 0
fi
echo "[$(date -Iseconds)] preflight OK — interpreter: $PY_RESOLVED" >>"$RUN_LOG"

INFRA_FAILURES=()
CHECKED=0

for site in "${SITES[@]}"; do
  SITE_ROOT="$DOMAINS_ROOT/sites/$site"
  if [[ ! -d "$SITE_ROOT/ops" ]]; then
    echo "[$(date -Iseconds)] $site: not a site repo, skipping" | tee -a "$RUN_LOG"
    continue
  fi

  # One run per site at a time. A heal can take minutes (model turn + full
  # build), and two overlapping runs would race on affiliate.ts and the git
  # index — exactly the corruption an unattended auto-swap must never cause.
  LOCK="$LOG_DIR/.$site.lock"
  (
    flock -n 9 || { echo "[$(date -Iseconds)] $site: already running, skipping" >>"$RUN_LOG"; exit 0; }
    echo "[$(date -Iseconds)] $site: start" >>"$RUN_LOG"
    cd "$SITE_ROOT" || exit 0
    bash "$TOOL_DIR/run-affiliate-sentinel.sh" "${PASSTHRU[@]+"${PASSTHRU[@]}"}" >>"$RUN_LOG" 2>&1
    # Capture rc FIRST, on its own line. Anything else here — including a
    # command substitution inside an echo — silently overwrites it.
    rc=$?
    echo "[$(date -Iseconds)] $site: done (rc=$rc)" >>"$RUN_LOG"
    exit "$rc"
  ) 9>"$LOCK"
  site_rc=$?

  case "$site_rc" in
    0) CHECKED=$((CHECKED + 1)) ;;
    3) INFRA_FAILURES+=("$site (infrastructure)") ;;
    *) INFRA_FAILURES+=("$site (rc=$site_rc)") ;;
  esac
done

if [[ "${#INFRA_FAILURES[@]}" -gt 0 ]]; then
  alert_fleet "$((${#INFRA_FAILURES[@]}))/$(( ${#SITES[@]} )) site(s) did not complete: ${INFRA_FAILURES[*]}. See $RUN_LOG"
elif [[ "$CHECKED" -eq 0 ]]; then
  alert_fleet "sweep ran but checked 0 sites — every site was skipped or locked. See $RUN_LOG"
fi
echo "[$(date -Iseconds)] sweep complete: $CHECKED/${#SITES[@]} site(s) checked, ${#INFRA_FAILURES[@]} failure(s)" >>"$RUN_LOG"

# Keep 30 days of host-side run logs.
find "$LOG_DIR" -name 'run-*.log' -mtime +30 -delete 2>/dev/null

exit 0
