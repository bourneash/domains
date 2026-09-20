# tools/fleet-scheduler

One DB-backed scheduler container that replaces the ~38 per-site `fleet-site-cron` containers
(each was a supercronic + docker-cli + docker.sock container). Schedules live in SQLite and are
edited live from Fleet Dashboard → **Ops → Scheduler** (or the CLI); no crontab edit, no rebuild,
no container restart.

Measured at cutover: 325 jobs / 38 sites. The scheduler idles at ~20 MiB, ~0% CPU, 3 PIDs.

## Why not just supercronic ×38

* 38 containers each holding `docker.sock` = 38 root-equivalent footholds; now 1.
* No global view: nothing could say "only N Claude workers at once" or "pause everything".
  The old design let every heavy role start on the same minute boundary (load avg ~16 on 96 cores).
* Schedules were 38 bind-mounted files; a change = edit file + restart that container.

## Design

```
Fleet Dashboard (Ops▸Scheduler)  ──/api/scheduler/*──►  fleet-scheduler :4790  ──►  SQLite (WAL, /data)
   allowlisted proxy, dashboard auth,                     asyncio loop: timer heap → bounded queue → subprocess
   token never reaches the browser                        docker.sock, sites/ rw, per-site .env.shared overlays
```

* **Single writer.** Only the scheduler process touches the DB. Every API call is marshalled onto
  the one asyncio loop thread — no locks, no races.
* **Timer heap + event-driven wakeups.** Sleeps until the next fire (max 15 s so clock jumps self-correct);
  API writes wake it immediately.
* **Bounded queue.** Job `class`: `light` (in-container probes: watchdog, deployer, prune, curl) vs
  `heavy` (spawns a worker container / Claude). Caps (live-editable): `light_cap` 96, `heavy_cap` 12,
  `site_heavy_cap` 2. Excess fires queue by (priority, scheduled time) and are dropped as
  `skipped_queue` if they wait past `queue_timeout_s` (default = the job's own interval, 5–60 min).
  Light is deliberately large: watchdog scripts `sleep` up to ~15 min of per-site stagger before doing
  anything; a small cap would pin slots on sleepers.
* **No overlap.** A fire while the previous run is still queued/running is recorded `skipped_overlap`
  (same as supercronic's default), never stacked.
* **Misfires.** Tick > `misfire_grace_s` late (default 120 s) → recorded `missed`, not fired. On restart a
  tick missed within grace is caught up once. Schedule edits and adoption reset `last_fire_ts`, so nothing
  "catches up" across a change.
* **Cron semantics.** Vixie rules (dom/dow OR when both restricted). DST: fixed-hour jobs fire once on the
  first occurrence / skip a nonexistent time; hour-wildcard jobs (`*/15 * * * *`) run on real elapsed time
  through fall-back. Cross-checked against `croniter` on 400 random expressions
  (`CROSSCHECK=1`, needs croniter), and every one of the fleet's real schedules parses.
* **Execution parity.** `cwd = sites/<site>`, `.env.shared` sourced then `/bin/sh -c <command>` — the same
  env the legacy entrypoint + supercronic gave jobs. The scheduler's own env (its API token!) is **not**
  passed to jobs; only `PATH HOME LANG DOCKER_* FLEET_WORKER_*` + the job's crontab env lines.
* **Kill semantics.** Each job runs in its own process group; timeout/cancel/shutdown → SIGTERM the group,
  SIGKILL after 30 s. No orphaned grandchildren. `init: true` reaps zombies.
* **Adoption gate.** Imported jobs are inert until a site is *adopted*. `adopt` = stop legacy cron
  container → take over → remove legacy (atomic, in-service; refuses if the site's `.env.shared` /
  `.monorepo-tools` overlays aren't mounted). `<data>/adopted/<site>` markers make
  `tools/scripts/ensure-fleet-cron.sh` and `fleet-doctor` leave adopted sites alone.

## Hardening

* uid 1000, `cap_drop: ALL`, `no-new-privileges`, read-only rootfs (+tmpfs), `mem_limit 48g`, `pids_limit 8192`.
* API: bearer token (≥24 chars, constant-time compare, refuses to start without), 64 KiB body cap, socket
  timeouts, ≤16 concurrent handlers, strict field validation with bounds. Commands set via API must match
  `bash (ops/scripts|.monorepo-tools)/<x>.sh [simple args]` — no shell metacharacters; arbitrary legacy
  one-liners can only enter through the local `import` CLI. Not published beyond `127.0.0.1:4790` and the
  internal `fleet-control` network.
* Every mutation is in the `audit` table. Startup: `PRAGMA quick_check`, orphaned `running` rows → `lost`.
  Every 6 h: prune (healthy light runs 7 d, everything else 30 d), integrity check, `VACUUM INTO` backup (7 kept).
* Healthcheck fails if the loop stalls; docker restarts it.

## Operate

```bash
tools/fleet-scheduler/bin/fleet-scheduler up            # render mounts + build + start (always rebuilds — don't skip it)
tools/fleet-scheduler/bin/fleet-scheduler import        # load every crontab.docker (idempotent, inert until adopted)
tools/fleet-scheduler/bin/fleet-scheduler adopt <site>  # cutover one site
tools/fleet-scheduler/bin/fleet-scheduler release <site># rollback: back to the legacy container
tools/fleet-scheduler/bin/fleet-scheduler jobs|runs [site] | run <site> <job> | pause | resume | status | logs
tools/fleet-scheduler/bin/fleet-scheduler export <site> # DB → crontab text (audit / rollback aid)
```

After adding a site or changing its overlays: `up` again (re-renders `docker-compose.generated.yml`).
Tests: `cd tools/fleet-scheduler && python3 -m unittest discover -s tests` (57) and
`cd tools/fleet-dashboard && node --test server/scheduler.test.js`.

## Not covered yet

* `tools/fleet-cron` (fleet-level jobs: purge, reaper, auth check, social-hub tick, …) still runs on
  supercronic; it's the natural next tenant. `ensure-fleet-cron.sh` there only heals *non-adopted* sites.
* `amputeenews.com` runs its legacy cron as root and calls `claude` directly; migrate its root-ownership
  first. Sites whose `.env.shared`/`.monorepo-tools` mountpoints don't exist are skipped by `render-compose`.
* Site `docker-compose.yml` files still define the `cron` service (kept as the rollback path); remove after
  a site has run clean for a while.
