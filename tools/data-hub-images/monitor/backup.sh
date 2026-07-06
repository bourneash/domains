#!/usr/bin/env bash
# Nightly backup of the data-hub-images library: a consistent SQLite snapshot +
# the blob store, to a host-mounted dir that survives loss of the data volume.
# Runs in the collector container (has /data + /backups). Rotates, keeps KEEP.
# NOT `set -e`: one failing step (locked DB, disk hiccup) must not skip the rest
# of the backup — each risky command degrades to a warning and we continue.
set -uo pipefail

DB="${DATAHUB_IMAGES_DB_PATH:-/data/images.db}"
BLOBS="${DATAHUB_IMAGES_BLOB_DIR:-/data/blobs}"
DEST="${DATAHUB_IMAGES_BACKUP_DIR:-/backups}"
KEEP="${DATAHUB_IMAGES_BACKUP_KEEP:-7}"
[ "$KEEP" -ge 1 ] 2>/dev/null || KEEP=1   # never let a bad KEEP wipe every backup
# Timestamp is passed in (containers here can't rely on a fixed TZ); default UTC now.
STAMP="$(date -u +%Y%m%d-%H%M%S)"

mkdir -p "$DEST"
log() { echo "[$(date -Iseconds)] backup: $*"; }

# 1. Consistent DB snapshot via sqlite's online backup (safe while WAL is live).
# Each step is guarded so a failure here still lets the blob archive + rotation run.
if [ -f "$DB" ]; then
  ok=1
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB" ".backup '$DEST/images-$STAMP.db'" || { log "WARNING: sqlite3 .backup failed"; ok=0; }
  else
    # No sqlite3 binary — fall back to Python's backup API (always present).
    python3 - "$DB" "$DEST/images-$STAMP.db" <<'PY' || { log "WARNING: python sqlite backup failed"; ok=0; }
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
s = sqlite3.connect(src); d = sqlite3.connect(dst)
with d: s.backup(d)
s.close(); d.close()
PY
  fi
  if [ "$ok" = 1 ]; then
    if gzip -f "$DEST/images-$STAMP.db"; then
      log "DB snapshot -> images-$STAMP.db.gz ($(du -h "$DEST/images-$STAMP.db.gz" | cut -f1))"
    else
      log "WARNING: gzip of DB snapshot failed"
    fi
  fi
else
  log "WARNING: DB $DB not found — skipping DB snapshot"
fi

# 2. Blob store archive.
if [ -d "$BLOBS" ]; then
  if tar -czf "$DEST/blobs-$STAMP.tar.gz" -C "$(dirname "$BLOBS")" "$(basename "$BLOBS")"; then
    log "blobs -> blobs-$STAMP.tar.gz ($(du -h "$DEST/blobs-$STAMP.tar.gz" | cut -f1))"
  else
    log "WARNING: blob archive failed"
  fi
else
  log "WARNING: blob dir $BLOBS not found — skipping blob archive"
fi

# 3. Rotate: keep the newest KEEP of each kind.
for prefix in images blobs; do
  ls -1t "$DEST/$prefix-"* 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f "$old"; log "pruned $(basename "$old")"
  done
done

log "backup complete ($(ls -1 "$DEST"/images-* 2>/dev/null | wc -l) DB snapshots retained)"
