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

## Still open — the rest of the service tier

`datahub-api`, `datahub-collector` and `product-feed-api` also run as **root**,
and the service tier broadly has no hardening (0/10 `cap_drop`, most lack
`no-new-privileges`). None of them mount a repo read-write, so **none carry the
`.git` corruption risk that made the dashboard urgent** — this is hygiene, not
an incident waiting to happen. Worth one sweep using the same recipe above.
