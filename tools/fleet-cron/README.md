# tools/fleet-cron

Fleet-level scheduler container. Runs the six cross-cutting jobs that used to
live on jesse's host crontab — self-heal for site schedulers, the SecurityScanner
temp-scans purge, the stuck-worker reaper, the Claude Code auth watchdog, the
lint sweep, and the Fleet Dashboard domain-jobs drainer. Migrated 2026-08-15;
see `HANDOFF.md` for the full brief this was built from.

Same supercronic pattern every site's `ops/docker/Dockerfile.cron` already
uses, based on `node:22-alpine` instead of bare `alpine` because job 6
(`domain-job-runner.sh`) needs node ≥ 22 + npm + `gh` to drive
`domain-manager-cli.sh`. This makes the image heavier than a per-site cron
image. If that bloat becomes a real problem, split into two services in this
same compose file — `cron` for jobs 1–5, `domain-jobs` for job 6 alone on a
lighter base — not two directories. Not done here; one container was simpler
and the extra ~150MB hasn't cost anything yet.

## What runs here

| # | Schedule | Script | Purpose |
|---|---|---|---|
| 1 | `*/10 * * * *` | `tools/scripts/ensure-fleet-cron.sh` | Self-heal: brings up any site's cron container that isn't running |
| 2 | `15 4 * * *` | `tools/scripts/purge-secscan-temp-scans.sh` | Purge SecurityScanner `scan-*` dirs older than 14d, every `secscan-*-executor` |
| 3 | `7,22,37,52 * * * *` | `tools/scripts/reap-stuck-workers-fleet.sh` | Force-kill one-shot worker containers that outlived their role run |
| 4 | `*/15 * * * *` | `tools/scripts/check-claude-auth.sh` | Probe the shared Claude OAuth session; alert `#domain-ops` after 2 consecutive failures |
| 5 | `20 6 * * *` | `tools/scripts/lint-sweep-cron.sh` | Fleet prettier parse/format sweep |
| 6 | `* * * * *` | `tools/scripts/domain-job-runner.sh` | Drain the Fleet Dashboard Domains-tab onboard/offboard spool |

Cadences are unchanged from the host-crontab entries they replace. Each
script's own header comment carries the incident that justifies its
existence — read those before touching the logic.

## Why this exists, not a host crontab

The repo's host crontab is documented as "reserved for host-level bootstrap
tasks only (@reboot)" — these six jobs are project logic and belong versioned
with the code, reviewable in a PR, and visible to the Fleet Dashboard, none of
which a host crontab entry gives you. See `HANDOFF.md` §1 for the full case.

## The one design call: who heals the healer?

Job 1 (`ensure-fleet-cron.sh`) is the thing that notices a dead site
scheduler and brings it back. Moving it into a container that can itself die
is circular. **Chosen: Option A** from `HANDOFF.md` §4 — move all six jobs
in here, and leave exactly **one** host crontab line:

```
@reboot /home/jesse/projects/domains/tools/fleet-cron/ensure-up.sh
```

`restart: unless-stopped` handles a dockerd bounce (the actual 2026-07-06
incident this job exists for). `ensure-up.sh` handles a cold host reboot —
same belt-and-suspenders gap `home_energy/scripts/cron-reboot.sh` covers for
that stack. Ordinary "is fleet-cron alive right now" visibility is the Fleet
Dashboard's Containers tab, not a second watchdog — **do not build one to
watch this one.**

## Editing the schedule

`crontab.docker` is **bind-mounted live**, not baked into the image:

```
vi crontab.docker
docker compose restart cron   # no rebuild needed, no downtime beyond the restart
```

This is the `amputeenews` variant of the per-site cron pattern, chosen
deliberately — the baked-in version (every other site's cron image) has
already cost the fleet unscheduled jobs after silent edits that nobody
rebuilt for (see `project_cron_image_drift_2026-08-10`). A **Dockerfile or
entrypoint.sh** change is the only thing that needs a rebuild:

```
docker compose build cron && docker compose up -d cron
```

## Bring up / operate

```
cd tools/fleet-cron
docker compose --env-file ../../.env up -d      # first bring-up / after a reboot
docker compose logs -f cron                       # supercronic passthrough logs, every firing
docker exec fleet-cron id                          # MUST be uid=1000(ops)
docker compose restart cron                        # after a crontab.docker edit
docker compose down                                 # full teardown
```

## Load-bearing details

- **`USER ops` (uid 1000).** Non-negotiable across every fleet worker
  container — a root-run `git submodule add` (job 6) or `docker compose up`
  (job 1) leaves root-owned objects in a repo's `.git`
  (`feedback_worker_containers_run_as_uid1000`,
  `project_git_objects_root_corruption`).
- **Repo mounted at the same absolute host path, RW.** Jobs 1 and 3 invoke
  `docker compose up` / `docker inspect` against OTHER sites' compose files
  from inside this container — the daemon (host-side) resolves those files'
  bind specs against the host filesystem, so paths only line up if this
  container sees the repo at the identical path.
- **`HOME` is overridden to the HOST's home**, for the same reason as the
  repo mount: nested `docker compose` invocations build `${HOME}`-based bind
  specs that the daemon resolves against the host. This means `/home/jesse`
  inside the container is NOT the `ops` user's native home (`/home/ops`) —
  Docker would otherwise auto-create it root-owned as an implicit mount
  parent, which broke job 4's `claude -p` (couldn't write `~/.claude.json`,
  hung until timeout instead of failing fast). Fixed with a named volume
  (`fleet_cron_home`) pre-chowned to `ops` in the Dockerfile, mounted at that
  same path, with the more specific `.ssh` / `.claude/.credentials.json`
  binds layered on top.
- **`.env` is read directly**, not via a `.env.shared` mount indirection —
  because the repo is mounted at the same absolute path, `$DOMAINS_ROOT/.env`
  already IS the real file. No symlink trick needed (contrast with the
  per-site worker containers, which only mount their own site's repo).
- **`docker.sock` mounted RW.** Compose v2 breaks with `:ro`.
- Claude Code CLI is installed in the image (`@anthropic-ai/claude-code`,
  pinned to the same version as `sites/americastrikes.com/ops/docker/Dockerfile.worker`)
  — job 4 calls `claude -p` directly against the mounted OAuth session.

## Visibility

The Fleet Dashboard's Containers tab picks this container up automatically —
no dashboard code changes needed. `server/containers.js`'s `list()` matches
any container whose compose `working_dir` is inside the domains repo, and
this compose project's working dir (`tools/fleet-cron`) qualifies. It shows
up with `kind: cron`, `scope: tool`, `slug: fleet-cron`. A dead or restarting
`fleet-cron` container is visible there within a refresh — that satisfies the
"who watches the healer" visibility requirement without a second watchdog.

## Rollback

Every host crontab line this replaced is commented out, not deleted (see
`crontab -l`) — uncomment the relevant line and `docker compose down` here to
revert instantly.

## Known follow-up (out of scope for this migration)

A 7th line — `35 6 * * * tools/scripts/registry-drift-cron.sh` — landed on
the host crontab the same day as this migration (fleet-registry work,
unrelated commit) and was NOT part of the six-job brief this tool was built
from. It has the same "wrong place" problem. Left on the host deliberately —
folding it in was out of scope for this change; migrate it here in a
follow-up.
