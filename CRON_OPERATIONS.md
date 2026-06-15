# Cron Operations — Portfolio Conventions

How the autonomous cron/ops layer works across domain sites, and the
invariants that keep it from breaking. Read this before touching any
`ops/docker/` file or the `cron-manager` tool.

Managed visually by **`tools/cron-manager`** (http://127.0.0.1:4753) — view
status, pause/resume roles, edit schedules, rebuild containers, tail logs.

## The two-container model (per site)

Each site with autonomy has, under `sites/<domain>/`:

- **`docker-compose.yml`** — defines a `cron` service and a `worker` service.
- **`ops/docker/Dockerfile.cron`** — long-running container running
  [supercronic](https://github.com/aptible/supercronic) against
  `ops/docker/crontab.docker`. It does NOT run the roles itself; on schedule
  it invokes `docker compose run --rm worker <role>` against the host daemon.
- **`ops/docker/Dockerfile.worker`** — the image each role runs in. Runs as
  **`USER ops`, `HOME=/home/ops`** (UID 1000). This is where `claude -p`
  executes a role.
- **`ops/scripts/run-role.sh`** — the role entrypoint, container-aware (see
  below). `run-worker.sh` / `run-deployer.sh` wrap it from the crontab.

Naming convention: project `<stem>-ops`, containers `<stem>-cron` /
`<stem>-worker` (stem = domain's first label, e.g. `americastrikes`).
`cron-manager` reads the real `container_name` from compose rather than
assuming the stem, so a drifted name (cf. CF stripping dots → `xxxtea-com`)
won't be missed.

## THE invariant: `${HOME}` must resolve to the host home

Bind-mount **sources** are resolved by the **host** Docker daemon, so any
`${HOME}`/`${PWD}` in a compose volume spec must resolve to a real **host**
path at the moment `docker compose` runs.

Compose files mount shared creds like:

```yaml
- ${HOME:-/home/jesse}/projects/domains/.env:${PWD:-/abs/site/path}/.env.shared:ro
```

This breaks the moment something runs `docker compose up` with `HOME` set to
the wrong value. Two places this matters:

1. **The cron-manager panel** spawns `docker compose up cron` *inside its own
   container*. That container therefore sets `HOME=/home/jesse` explicitly
   (`tools/cron-manager/docker-compose.yml`). Without it, `HOME` defaulted to
   `/root`, the bind source became `/root/projects/domains/.env` (nonexistent
   on the host), Docker auto-created it as a directory, and the cron container
   died in `created` with an OCI "mount directory onto file" error
   (exit 127). This was the 2026-06-15 incident.
2. **`run-role.sh`** sets `HOME` per environment: in-container it must be
   `${HOME:-/home/ops}` (matching `Dockerfile.worker`'s `USER ops`); on the
   host it's `/home/jesse`. The `:-/root` fallback some sites carried was
   wrong (and the comment claiming "HOME is /root" was stale) — corrected to
   `/home/ops`.

**Rule of thumb:** never assume `HOME`. Whoever invokes `docker compose` for a
site must have `HOME` pointing at the real host home, or the bind sources
resolve to garbage. Prefer `${HOME:-/home/jesse}` (compose) and
`${HOME:-/home/ops}` (in-worker) fallbacks.

## Dockerfile.cron standard (pin + verify)

All cron images pin the base and verify the supercronic binary:

```dockerfile
FROM alpine:3.20.6
...
RUN wget -O /usr/local/bin/supercronic \
    https://github.com/aptible/supercronic/releases/download/v0.2.34/supercronic-linux-amd64 \
    && echo "a51b340a83c5bd035742f0d7191555f9663876405e494dbf824537d64f3e39c6  /usr/local/bin/supercronic" | sha256sum -c \
    && chmod +x /usr/local/bin/supercronic
```

Pinning the patch (`3.20.6`, not `3.20`) keeps rebuilds reproducible; the
`sha256sum -c` is a supply-chain check that fails the build on a tampered or
swapped binary. When bumping supercronic, update the version AND the SHA in
all sites.

## Disabling a role

Two mechanisms (both surfaced in cron-manager):

- **Instant, no rebuild** — a `.<role>-disabled` flag file in `ops/`.
  `run-role.sh`/discovery honor it. This is the preferred toggle.
- **Schedule edit / comment** — editing `crontab.docker` requires a
  `Rebuild & restart cron` to take effect (the crontab is baked into the
  image via `COPY`).

## Changes take effect on rebuild

`docker compose build cron` reads the **local working tree**, so edits to
`Dockerfile.cron` / `crontab.docker` / `entrypoint-cron.sh` go live on the
next rebuild — independent of git commit/push. Use cron-manager's
"Rebuild & restart cron" (it now verifies the container actually reached
`running` afterward and surfaces the failure + logs if not).

## Deferred / not normalized (intentionally)

These drift across sites but were left alone — they are behavior-correct as-is
and churning working deployer logic across live autonomous sites is riskier
than the cosmetic gain:

- Deployer gate syntax: `[ ! -f .deploy-needed ] ||` vs `[ -f .deploy-needed ] &&`
  vs an externalized `run-deployer.sh` (americastrikes, with retry cap). All
  semantically equivalent.
- Log/lock prune retention windows (14 vs 30 days).
- `Dockerfile.worker` weight: sinderella (vLLM + Python venv + Playwright) and
  americastrikes (Playwright Chromium) are legitimately heavier than the lean
  `node:22-slim` baseline.
