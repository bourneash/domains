# Credential Vault Backup

Git-backed backup of the fleet's Vaultwarden instance
(`/mnt/encrypted/projects/credential-vault/`, see
`.claude/skills/skills-domain-social-setup/SKILL.md`). The vault lives on
one local LUKS-encrypted disk with no other replication — if that disk
dies, this is the only recovery path.

## What's here

- `data/db.sqlite3` — a point-in-time snapshot of the vault's sqlite DB,
  taken via `sqlite3 .backup` (not a raw file copy — the source is opened
  in WAL mode by the running container, so a raw `cp` can grab a torn
  copy). All item contents in here are Bitwarden client-side-encrypted
  blobs (same as what's on screen in the source vault before you unlock
  it) — safe-ish for a private repo, but still treat it as sensitive.
- `docker-compose.yml` — copy of the source compose file, no secrets.
- `last-backup.txt` — timestamp + user count from the most recent run.

## What's NOT here (on purpose)

Stays local-only on this box. Back these up yourself, offsite, separately
from git — restoring `data/db.sqlite3` above is useless without them:

- `/mnt/encrypted/projects/credential-vault/.env` — `ADMIN_TOKEN`
- `/mnt/encrypted/projects/credential-vault/automation-account.env` —
  `AUTOMATION_EMAIL` / `AUTOMATION_PASSWORD`, the automation account's
  login. This is the credential that actually unlocks a restored copy of
  `data/db.sqlite3` without a human — it's the one most worth keeping safe.
- Jesse's personal vault login (whatever he used at `https://localhost:9280`
  in the browser — in Bitwarden's model the account password *is* the
  master password, there's no separate one).
- `/mnt/encrypted/projects/credential-vault/data/rsa_key.pem` — server
  signing key. Already excluded by the repo's fleet-wide `*.pem`
  `.gitignore` rule. Not required for recovery: Vaultwarden regenerates it
  on first boot if missing, which just invalidates existing sessions.

## Updating the snapshot

Runs automatically on every commit to this repo via a pre-commit hook
(install once per clone/box):

```bash
tools/credential-vault-backup/install.sh
```

To snapshot manually instead: `tools/credential-vault-backup/backup.sh`.

## Restore procedure (tested 2026-08-14)

```bash
mkdir -p /path/to/restore/data
cp tools/credential-vault-backup/data/db.sqlite3 /path/to/restore/data/
cp tools/credential-vault-backup/docker-compose.yml /path/to/restore/
# then in /path/to/restore/:
#   - drop in a fresh self-signed ssl/cert.pem + key.pem (or generate new)
#   - set ADMIN_TOKEN in .env from your offsite copy
#   - docker compose up -d
#   - log in with the automation account (or Jesse's) creds from your offsite copy
```

Verified end-to-end: snapshot → fresh container on an isolated data dir →
`bw login` as the automation account → successfully listed all vault items
back out, decrypted. No `rsa_key.pem` needed; Vaultwarden regenerated one
on boot.
