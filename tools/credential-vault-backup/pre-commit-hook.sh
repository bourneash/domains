#!/usr/bin/env bash
# Called by the repository's shared tools/git-hooks/pre-commit hook. Re-snapshots
# the Vaultwarden DB on every monorepo commit and folds any change into the
# commit that's already in flight — so the backup is never staler than the
# last commit made on a machine that has the live vault mounted.
#
# A machine without the vault mount skips cleanly. If the DB is available,
# failures are loud and block the commit: silently committing a stale vault
# snapshot defeats the purpose of this backup.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -z "$REPO_ROOT" ] && exit 0

BACKUP_SCRIPT="$REPO_ROOT/tools/credential-vault-backup/backup.sh"
VAULT_DB="${VAULTWARDEN_DB:-/mnt/encrypted/projects/credential-vault/data/db.sqlite3}"

[ -x "$BACKUP_SCRIPT" ] || exit 0
[ -f "$VAULT_DB" ] || exit 0
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "Vaultwarden backup: live DB is present but sqlite3 is unavailable; commit blocked." >&2
  exit 1
fi

if ! VAULTWARDEN_DB="$VAULT_DB" "$BACKUP_SCRIPT" >/dev/null; then
  echo "Vaultwarden backup: snapshot failed; commit blocked." >&2
  exit 1
fi

if ! git -C "$REPO_ROOT" add \
  tools/credential-vault-backup/data/db.sqlite3 \
  tools/credential-vault-backup/docker-compose.yml \
  tools/credential-vault-backup/last-backup.txt \
  2>/dev/null; then
  echo "Vaultwarden backup: snapshot could not be staged; commit blocked." >&2
  exit 1
fi

exit 0
