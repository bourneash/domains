#!/usr/bin/env bash
# check-disabled-drift.sh — fleet-wide visibility into cron-role kill-switches.
#
# The kill-switch pattern (ops/.<role>-disabled marker, honored by
# run-worker.sh/run-role.sh) works correctly everywhere it's installed —
# this is NOT a bug scanner. Its only job is to surface roles that have been
# silently paused for a long time, since a marker file makes no noise on its
# own and a role disabled during a June incident is easy to forget in July.
#
# Read-only. Reports only — never touches a marker or crontab.
set -uo pipefail

DOMAINS_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STALE_DAYS="${STALE_DAYS:-7}"
NOW=$(date +%s)

printf '%-24s %-20s %8s   %s\n' "SITE" "ROLE" "AGE(d)" "STATUS"
printf '%-24s %-20s %8s   %s\n' "----" "----" "------" "------"

found_any=0
for site_dir in "$DOMAINS_ROOT"/sites/*/; do
  site="$(basename "$site_dir")"
  [ -d "$site_dir/ops" ] || continue
  shopt -s nullglob
  markers=("$site_dir"ops/.*-disabled)
  shopt -u nullglob
  [ "${#markers[@]}" -eq 0 ] && continue

  crontab_file="$site_dir/ops/docker/crontab.docker"

  for marker in "${markers[@]}"; do
    found_any=1
    base="$(basename "$marker")"                # .<role>-disabled
    role="${base#.}"; role="${role%-disabled}"

    mtime=$(stat -c %Y "$marker" 2>/dev/null || stat -f %m "$marker" 2>/dev/null)
    age_days=$(( (NOW - mtime) / 86400 ))

    # A live (uncommented) crontab line calling this role is expected —
    # that's how the kill-switch is designed to work. Flag it only as a
    # staleness signal, not a conflict.
    live_cron="no matching cron line"
    if [ -f "$crontab_file" ] && grep -qE "run-(worker|role)\.sh +${role}( |\$)" "$crontab_file"; then
      live_cron="live cron entry present"
    fi

    status="ok (${live_cron})"
    if [ "$age_days" -ge "$STALE_DAYS" ]; then
      status="STALE ${age_days}d — review: re-enable or remove role (${live_cron})"
    fi

    printf '%-24s %-20s %8s   %s\n' "$site" "$role" "$age_days" "$status"
  done
done

if [ "$found_any" -eq 0 ]; then
  echo "No disable markers found fleet-wide."
fi
