#!/usr/bin/env bash
# Snapshots the fleet Vaultwarden DB and stages it for git.
#
# What this does NOT do: push. Run `git -C /home/jesse/projects/domains
# add tools/credential-vault-backup/data && git commit && git push`
# yourself (or wire this into a cron role) once you're happy with it.
#
# What's committed: only the sqlite DB (contains Bitwarden's client-side-
# encrypted item blobs — safe-ish to store in a private repo) and the
# compose file (no secrets, uses env var interpolation).
#
# What's deliberately NOT committed (stays local-only on this box, back
# these up yourself, offsite, separately from git):
#   - /mnt/encrypted/projects/credential-vault/.env               (ADMIN_TOKEN)
#   - /mnt/encrypted/projects/credential-vault/automation-account.env (automation master password)
#   - /mnt/encrypted/projects/credential-vault/data/rsa_key.pem   (server signing key; already fleet-.gitignored as *.pem)
#   - ssl/, .session_cache                                        (regenerable / ephemeral)

set -euo pipefail

VAULT_SRC="/mnt/encrypted/projects/credential-vault"
BACKUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_OUT="$BACKUP_DIR/data"

mkdir -p "$DATA_OUT"

# Consistent point-in-time snapshot via SQLite's backup API — NOT a raw
# cp, which can grab a torn copy while the DB is open in WAL mode.
sqlite3 "$VAULT_SRC/data/db.sqlite3" ".backup '$DATA_OUT/db.sqlite3'"

cp "$VAULT_SRC/docker-compose.yml" "$BACKUP_DIR/docker-compose.yml"

echo "Backed up $(sqlite3 "$DATA_OUT/db.sqlite3" 'select count(*) from users') user(s), $(date -u +%FT%TZ)" \
  > "$BACKUP_DIR/last-backup.txt"

echo "Snapshot written to $DATA_OUT/db.sqlite3"
cat "$BACKUP_DIR/last-backup.txt"
