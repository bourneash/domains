#!/usr/bin/env bash
# Lifecycle rule for SecurityScanner's temp-scans directories: purge any
# scan-* dir older than RETENTION_DAYS (default 14).
#
# WHY THIS EXISTS (not just a normal retention knob): SecurityScanner's own
# internal cleanup service (backend/executor/cleanup_service.py) is supposed
# to sweep orphaned scan-* dirs hourly, but its process runs with zero
# effective capabilities (CapEff=0) inside the executor container, so its
# in-process shutil.rmtree calls fail with PermissionError on files it
# doesn't own (uid mismatch, no DAC_OVERRIDE) — it's been silently failing
# every hour on every instance on this host. `docker exec` (used here)
# starts a FRESH process with the container's full default capability set,
# which is why this works where the in-process cleanup doesn't. This script
# is a safety-net workaround, not a fix for that underlying app bug — see
# project_secscan_temp_scans_cleanup_broken memory for the real root cause.
#
# Runs against every secscan-*-executor container found on the host, so new
# SecurityScanner instances are covered automatically with no script edit.
set -uo pipefail

RETENTION_DAYS="${RETENTION_DAYS:-14}"
LOG="/home/jesse/projects/domains/tools/scripts/purge-secscan-temp-scans.log"

for c in $(docker ps --format '{{.Names}}' | grep -- '-executor$' | grep '^secscan-'); do
  before="$(docker exec "$c" bash -c "find /app/temp-scans -maxdepth 1 -type d -name 'scan-*' 2>/dev/null | wc -l" 2>/dev/null || echo '?')"
  docker exec "$c" bash -c "find /app/temp-scans -maxdepth 1 -type d -name 'scan-*' -mtime +${RETENTION_DAYS} -print0 2>/dev/null | xargs -0 -r rm -rf" 2>>"$LOG"
  after="$(docker exec "$c" bash -c "find /app/temp-scans -maxdepth 1 -type d -name 'scan-*' 2>/dev/null | wc -l" 2>/dev/null || echo '?')"
  if [ "$before" != "$after" ]; then
    echo "$(date -Iseconds) [$c] scan dirs: $before -> $after (purged dirs older than ${RETENTION_DAYS}d)" >> "$LOG"
  fi
done
