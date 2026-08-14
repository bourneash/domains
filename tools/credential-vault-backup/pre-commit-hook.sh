#!/usr/bin/env bash
# Installed as .git/hooks/pre-commit (see install.sh). Re-snapshots the
# Vaultwarden DB on every commit and folds any change into the commit
# that's already in flight — so the backup is never staler than "your
# last commit to this repo," with zero separate cadence to remember.
#
# Best-effort and silent: never blocks a commit. If the vault container
# isn't running (e.g. working from a different box, or it's down), or
# sqlite3 isn't on PATH, this just skips.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -z "$REPO_ROOT" ] && exit 0

BACKUP_SCRIPT="$REPO_ROOT/tools/credential-vault-backup/backup.sh"
VAULT_DB="/mnt/encrypted/projects/credential-vault/data/db.sqlite3"

[ -x "$BACKUP_SCRIPT" ] || exit 0
[ -f "$VAULT_DB" ] || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0

"$BACKUP_SCRIPT" >/dev/null 2>&1 || exit 0

git -C "$REPO_ROOT" add \
  tools/credential-vault-backup/data/db.sqlite3 \
  tools/credential-vault-backup/docker-compose.yml \
  tools/credential-vault-backup/last-backup.txt \
  2>/dev/null || true

exit 0
