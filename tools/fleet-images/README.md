# tools/fleet-images — the fleet's two shared site images

Every site in the fleet runs the same two containers:

| Image | Role | Lifetime |
|---|---|---|
| `fleet-site-cron:latest` | supercronic scheduler, one long-lived container per site | long-lived, recreated on roll |
| `fleet-site-worker:latest` | one-shot role runner, `docker compose run --rm worker <role>` | seconds; already cattle |

These replace **53 hand-maintained per-site Dockerfiles**.

## Why this exists

Before consolidation (measured 2026-08-23):

- **27 `Dockerfile.cron`** in 10 md5 variants. The drift was *cosmetic*: 26 of 27 were
  functionally identical — same `alpine:3.20.6`, same packages, same supercronic release
  and checksum, same uid-1000 `ops` — differing only in layer arrangement.
- **26 `Dockerfile.worker`** in **23 distinct variants**, and this drift was **substantive**:
  five bases across two libc implementations (`node:22-alpine`, `-slim`, `-bookworm-slim`,
  `python:3.12-slim`).
- **27 `entrypoint-cron.sh`**, 21 of which were byte-identical once the site name was
  normalised out.

Three concrete failures came out of that:

1. **The musl/glibc landmine.** `@cloudflare/workerd` needs glibc (`fcntl64`,
   `_dl_find_object`), and the `@astrojs/cloudflare` adapter spawns workerd to prerender.
   Eleven sites were on Alpine *and* running wrangler in ops, ten with scheduled deployers.
   broadwayshowgirls.com already deadlocked its engineer build gate on this — and a bot
   "fixed" it by gutting the gate, which hid the real fault. newmomshop.com independently
   hit it and pinned a runtime contract literally named `2026-07-31-glibc`.
   **The shared worker image is Debian. Do not move it to Alpine.**
2. **Baked crontabs drift silently.** The schedule was `COPY`'d into each image, so
   rescheduling needed a rebuild. weapontester.com ran a `find … -delete` that ate
   `.gitkeep` for four days after the fix was committed, because nothing rebuilt it.
3. **Every fleet-wide change was 27 hand edits**, which is why nobody made them.

## Layout

```
tools/fleet-images/
  VERSION                  version stamped into both images' labels
  cron/Dockerfile          the shared scheduler image
  cron/entrypoint.sh       shared cron entrypoint (absorbs all 6 old variants)
  worker/Dockerfile        the shared role-runner image (glibc)
  worker/entrypoint.sh     dispatcher — finds the site's own worker script
  bin/fleet-image-build    build -> SMOKE -> promote :latest, and --roll
  bin/fleet-image-smoke    ~32 assertions; the gate that guards :latest
  bin/fleet-image-bases    show / bump the pinned base-image digests
  bin/fleet-site-migrate   move ONE site onto the shared images
  bin/fleet-doctor         the executable spec; the gate
  precommit_check.sh       blocks NEW per-site Dockerfiles
```

## Everyday operations

```bash
# Change something in a shared image, then roll the fleet onto it:
vim tools/fleet-images/worker/Dockerfile
tools/fleet-images/bin/fleet-image-build worker --version 1.1.0
tools/fleet-images/bin/fleet-image-build cron --roll        # recreate cron containers
tools/fleet-images/bin/fleet-doctor                          # must be 0 failed

# Reschedule a site — NO rebuild, that's the point:
vim sites/<site>/ops/docker/crontab.docker
(cd sites/<site> && docker compose restart cron)

# Migrate a site that isn't on the shared images yet:
tools/fleet-images/bin/fleet-site-migrate <site> --both --dry-run   # review
tools/fleet-images/bin/fleet-site-migrate <site> --both
(cd sites/<site> && docker compose up -d --force-recreate cron)
tools/fleet-images/bin/fleet-doctor <site>
```

## Two things guard every change

**The smoke gate.** `fleet-image-build` builds the version tag, runs
`fleet-image-smoke` against it, and only then moves `:latest`. A failing image
leaves `:latest` exactly where it was, so the fleet keeps running the last
image known to work. Every regression this migration shipped — a missing venv
path, no Playwright browser story, a presence-guard that never matched, a root
user — is now caught in ~15 seconds instead of in production. `--skip-smoke`
exists for debugging a failing build, not for shipping past a red gate.

**Digest-pinned bases.** Both Dockerfiles pin `FROM ... @sha256:...`, so a
rebuild months from now cannot silently produce a different image. The cost is
that security updates stop arriving for free; `fleet-image-bases --check` runs
weekly (crontab job 12) and says when the upstream tag has moved, and
`--update` rewrites the pins. Bumping is deliberate, reviewed and smoke-gated.

## Hardening

Applied to the images and to all 26 sites' compose, and asserted by
`fleet-image-smoke` (images) and `fleet-doctor` (live containers), so none of it
can silently regress.

| Control | Where | Why |
|---|---|---|
| `uid 1000`, no sudo | image | root writes corrupt `.git/objects`; claude-code refuses root |
| **0 setuid/setgid binaries** | worker image | the base ships 14 (`su`, `mount`, `chsh`, `gpasswd`, …). No role uses one. Bits are cleared, not files deleted, so ordinary calls still work |
| `cap_drop: [ALL]` | both services | nothing here needs a single capability — verified against a 1156-page astro build, Playwright chromium, sharp, git, and the scheduler driving the docker socket |
| `no-new-privileges` | both services | blocks setuid escalation even if a future base reintroduces a setuid binary |
| `pids_limit` | 512 cron / 2048 worker | a fork bomb in one role cannot take the host down |
| `mem_limit` | 1g cron / 8g worker | one runaway build cannot starve the other 25 sites. Generous on purpose: the heaviest measured build peaks around 30 MB |
| no baked secrets | image | credentials arrive as runtime mounts, never in a layer |

Every value above was verified **not to break the fleet before being applied** —
that testing is the reason `cap_drop: ALL` is safe to state rather than hope.

### The risk that is NOT mitigated, and why

Each site's cron container mounts `/var/run/docker.sock` read-write. That is
**root-equivalent on the host**: anything that can reach that socket can start a
privileged container and own the box. It is not mitigated because it cannot be —
the scheduler's entire job is `docker compose run --rm worker <role>`.

A socket proxy (the fleet already runs `tecnativa/docker-socket-proxy` for
secscan) would need `containers create/start/attach/delete` + `images` + `exec`
enabled to work at all, which is precisely the set that grants container escape.
It would look like a control and provide close to none, so it is deliberately
not used here — writing it down beats security theatre.

What actually bounds this risk is everything upstream of the socket: the images
run unprivileged with no capabilities, the code they execute comes from this
repo, and roles are individually kill-switchable via `ops/.<role>-disabled`.
**Treat the site cron containers as inside the host's trust boundary, because
they are.**

## The tagging model — read before changing it

Sites reference the plain `:latest` tag, **not** a pinned version. That looks wrong and is
deliberate: pinning versions in 27 compose files makes every roll a 27-file edit, which is
exactly the pressure that produced 53 divergent files. Instead:

- each build stamps an immutable `org.domains.fleet.version` label,
- a version-tagged image (`fleet-site-cron:1.0.0`) is kept as a rollback,
- **`fleet-doctor` asserts every running container's image ID equals the current `:latest`
  image ID**, so drift is loud rather than silent.

One-place rolls plus drift detection is the cattle property we want. Pinning in 27 places
is the illusion of it.

A running container does **not** pick up a new image — a scheduler mid-job should not
vanish underneath itself. `fleet-image-build --roll` recreates them (`up -d
--force-recreate`, never `restart`, because `restart` reuses the container's creation-time
image and would silently preserve the drift).

## Rules

- **No site conditionals in the shared entrypoints.** Anything that varies per site arrives
  as environment or a bind mount. Site conditionals are how 27 copies happened.
- **Never bake the crontab.** It is bind-mounted at `/etc/crontab.docker`.
- **uid 1000, never root.** A root-owned write into the bind-mounted repo corrupts
  `.git/objects` in a way that needs sudo to undo — already done to four sites. `claude-code`
  also refuses `--dangerously-skip-permissions` as root.
- **Need something the shared image lacks?** Add it to the shared image. A site that needs
  its own image is a finding about the shared one, not a private workaround.
- **Healthcheck budget — no interval below 60s, and nothing but a local predicate.** A
  container healthcheck may read `/proc`, a file, or a signal. It may not curl, hit the
  network, shell out to the docker CLI, or run a build. It runs on every container, forever;
  the fleet has burned itself on this twice — `willfarrell/autoheal`'s baked-in **5s**
  HEALTHCHECK firing a runc exec every 5s, and fleet-smoke's per-site HTTP sweeps. Anything
  needing HTTP, cross-container state, or schedule reasoning belongs in a host-side sweep
  (`tools/scripts/cron-freshness-cron.sh` is the model: one process for the whole fleet,
  every 30 min, instead of 26 probes on a loop).
- **A healthcheck that cannot fail is worse than none.** It reports green through an
  outage. `pgrep -f <name>` is the trap: `-f` matches the whole command line, and the
  probe's own `sh -c "pgrep -f <name>"` contains the name, so it always finds itself and
  exits 0. It shipped that way on two site cron containers and on `vpn-autoheal`, and
  `pgrep -f NOSUCHPROCXYZ` exited 0 on all three. Prove a new probe can fail — run it with
  a deliberately wrong target and confirm a nonzero exit — before trusting its green.
- **A healthcheck without `labels: autoheal=true` is decoration.** Docker never restarts a
  container for going unhealthy; `vpn-autoheal` (`tools/vpn-proxy`) is what turns unhealthy
  into a restart. Add the probe and the label together or neither.

## Related

- `tools/domain-developer/` — the `dd-*` developer workers; same cattle model, migrated first.
  `bin/dd-doctor` is the pattern `fleet-doctor` follows.
- `tools/scripts/gc-docker.sh` — reclaims the build exhaust these rebuilds produce.
- `tools/scripts/reclaim-docker-volumes.sh` — the ONLY sanctioned way to delete a
  volume on this host. Proves regenerability from the volume's own contents before
  deleting; `docker volume prune` stays forbidden after the 2026-05-30 cache loss.
- `tools/cron-roles/` — the role archetypes the worker image runs.
