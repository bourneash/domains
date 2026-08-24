# fleet-dashboard — security posture

## RESOLVED 2026-08-23: no longer runs as root

```
uid:       1000 (node)      <- matches host `jesse`, which owns the repos
groups:    node, 1004       <- 1004 = host docker group, for socket access
cap_drop:  [ALL]
no-new-privileges: yes
privileged: false
```

Previously this ran as **root** with the entire monorepo mounted read-write and
the docker socket — the highest-risk container on the host. It runs
`git add`/`commit`/`push` against those repos from the Git tab, so every such
write landed in `.git` owned by root. That is the documented way this fleet has
already corrupted `.git/objects` on four sites, and it is unrecoverable without
`sudo`, which is unavailable on this host.

### What the change actually needed

`node:22-alpine` already ships `node` at **uid 1000 / gid 1000** — the same uid
that owns the repos on the host — so no uid remapping was required. Three
couplings had to move with it:

1. `chown -R node:node /app` in the Dockerfile (`COPY` + `npm install` ran as
   root and left it root-owned).
2. **SSH.** OpenSSH resolves `~/.ssh` from the **passwd** home dir, not `$HOME`
   — `/home/node` for this user. The key mount moved `/root/.ssh` →
   `/home/node/.ssh` and `GIT_SSH_COMMAND` was repointed to match. Missing this
   is the failure mode that would have broken every push silently.
3. **Docker socket.** The socket is `root:docker`; uid 1000 reaches it through
   `group_add: ["${DOCKER_GID}"]`, not through capabilities — which is why
   `cap_drop: ALL` is safe here.

### Verified after the switch

- `docker exec fleet-dashboard id` -> `uid=1000(node) ... groups=...,1004`
- HTTP 200 on `/api/version`, `/api/sites`, `/api/containers`
- Containers tab: 160 containers visible (socket works)
- Git tab: `git status` works; `git ls-remote origin` authenticates to GitHub
  over SSH (push path proven, not assumed)
- **The corruption vector itself:** a container-side `git hash-object -w` into
  the real repo produced a `.git/objects` entry owned by `jesse:jesse`, not
  root. This is the assertion that matters — everything else is a proxy for it.
- The 3 pre-existing root-owned files under `data/` were chown'd to 1000:1000
  through a root container (no host sudo needed; `sudo -n` is unavailable here).

Rollback image kept as `fleet-dashboard:rollback-root` if ever needed.

## RESOLVED 2026-08-23: the rest of the service tier too

Every domains-owned container now runs as uid 1000 with `cap_drop: [ALL]` and
`no-new-privileges`. Converted in the same pass:

| Container | Was | Now |
|---|---|---|
| `datahub-api` / `datahub-collector` | root | uid 1000, cap_drop ALL |
| `datahub-images-api` / `-collector` | root | uid 1000, cap_drop ALL |
| `product-feed-api` | root | uid 1000, cap_drop ALL |
| `fleet-cron` | uid 1000, no cap_drop | uid 1000, cap_drop ALL |

The images (`tools/{data-hub,data-hub-images,product-feed}/Dockerfile`) gained a
`useradd -u 1000` + `chown /app /data` + `USER` block, matching the pattern
`tools/product-feed/Dockerfile.collector` already used.

**The non-obvious part — named volumes.** Docker only applies image-time
ownership to a volume when that volume is EMPTY. These three services keep live
SQLite databases in long-standing named volumes, all root-owned, so the images
alone would not have fixed anything: the services would have started cleanly and
then failed at the first write with *"attempt to write a readonly database"* —
a runtime error, not a startup crash, i.e. exactly the kind of failure that
looks fine in `docker ps`. The volumes were stopped, backed up, and chown'd to
1000:1000 out of band before the rebuild. **Any future service converted this
way needs the same out-of-band chown.**

Verified: all six report uid 1000; `/health` returns 200 on 4760/4770/4761 both
on loopback and over the container network; the dashboard's own
`/api/datahub/health` and `/api/datahub-images/health` return real data; and a
direct SQLite `CREATE/INSERT/DROP` round-trip succeeded against each live
database — the write path proven, not inferred from a healthy-looking process.

## Deliberate exception: `credential-vault`

Still runs as root, and is staying that way for now.

- It is a **third-party upstream image** (`vaultwarden/server:latest`) that runs
  as root by design; overriding the user means owning that decision across every
  upstream bump.
- It mounts **only its own data directory** (`/mnt/encrypted/.../data`, outside
  the monorepo) plus a read-only SSL dir. It touches no git repo, so it carries
  **none** of the `.git` corruption risk that motivated this work.
- It is the fleet's credential store. Breaking it breaks social-poster and every
  vault-backed role, and the failure mode of a bad chown on an encrypted volume
  is worse than the risk being mitigated.

Revisit if it ever gains a repo mount. Until then the containment is the
loopback-only port and the isolated data dir.
