# fleet-backup

Offsite snapshots of the fleet's **unreproducible state**, to Cloudflare R2.

    backup.py --dry-run
    backup.py                       # snapshot + upload + verify + prune
    backup.py --list
    backup.py --drill               # prove the newest archives actually restore
    backup.py --restore cf-stats --into /tmp/restore

## Why

Git covers the code. Nothing covered the state:

| group | what would be lost |
|---|---|
| `cf-stats` | the only historical Cloudflare record anywhere — ~5 MB/day of JSONL |
| `data-hub` / `data-hub-images` | collected feeds + GA4/GSC metrics; re-collection cannot recover the past |
| `site-tracker` | hand-entered per-site verification facts |
| `gatus-history` | uptime history — the input to any future SLO |
| `dashboard-actionlog` | the only record of which agent pushed or restarted what |
| `registry` | `fleet.yaml`, the env-broker allowlist, the test roster |

`tools/credential-vault-backup` covers Vaultwarden and nothing else.

## Design

**Secrets can never enter an archive.** The `never` list in `manifest.yaml` is
asserted against every file as it is added and **aborts the run** on a match —
it is not a filter. A backup tool that quietly skips a credential file and
reports success is how a fleet's secrets end up in an offsite bucket nobody
audits. `tools/env-broker/rendered/` and every `.env` are on that list; the
env-broker *policy* file is backed up because an allowlist is not a secret.

**Docker volumes are first-class.** data-hub and data-hub-images keep their
SQLite databases in named volumes, not on a host path. A filesystem-only walk
silently excludes exactly the two databases the fleet's analytics run on — and
reports success. Those groups are tarred out of a throwaway container instead.

**Incremental where it matters.** cf-stats and gh-stats append and never
rewrite, so they ship only files modified since the last successful run.
Re-uploading 80 MB nightly is waste.

**Verified, not assumed.** Every upload is read back — length and a sha256 in
object metadata — before the run is recorded. A group that fails verification
does not update its state, so the next run re-sends it.

**Restore is staged, never in place.** `--restore` refuses to unpack over the
live repo; you name a staging directory and reconcile by hand. `--drill`
downloads each group's newest archive into a temp dir and unpacks it, because
a backup nobody has restored is a hypothesis.

## Out of scope

The 61 GB of working media under `sites/*/Artwork` and friends. That needs a
lifecycle policy and an object store of its own, not a nightly tarball.

## Credentials

R2 via the `CF_S3_API_ENDPOINT` / `CF_ACCESS_KEY_ID` / `CF_SECRET_ACCESS_KEY`
already in the shared `.env`. Bucket `fleet-backup` is created on first run.
Retention: 30 days, pruned after each successful run.
