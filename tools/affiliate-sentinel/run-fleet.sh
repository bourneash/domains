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
# Always exits 0: one site's failure must not stop the rest, and a failing cron
# tick is a thing someone has to babysit.
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

STAMP="$(date +%Y-%m-%d)"
RUN_LOG="$LOG_DIR/run-$STAMP.log"

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
    echo "[$(date -Iseconds)] $site: done (rc=$?)" >>"$RUN_LOG"
  ) 9>"$LOCK"
done

# Keep 30 days of host-side run logs.
find "$LOG_DIR" -name 'run-*.log' -mtime +30 -delete 2>/dev/null

exit 0
