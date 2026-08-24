# HANDOFF — move fleet-level host cron into a container

> **Superseded 2026-08-23.** Per-site `ops/docker/Dockerfile.cron`,
> `Dockerfile.worker` and `entrypoint-cron.sh` no longer exist. All 26 sites run
> two shared images built from `tools/fleet-images/` (`fleet-site-cron`,
> `fleet-site-worker`), and the crontab is BIND-MOUNTED rather than baked, so
> rescheduling needs no rebuild. References to those per-site files below are
> retained for historical context only — see `tools/fleet-images/README.md`.


**Status:** DONE — 2026-08-15. All six jobs migrated to `tools/fleet-cron`,
verified per §8, host crontab reduced to the two `@reboot` lines plus the
untouched `home_energy` line. See `README.md` for the operating doc going
forward; this file is kept for the incident/design history that motivated it.
**Owner:** unassigned (Jesse will spin an agent)
**Written:** 2026-08-15
**Repo:** `/home/jesse/projects/domains` (branch `main`, commits go direct to main)

---

## 1. The problem

Six cross-cutting fleet jobs run from **jesse's host crontab** on this one
machine. That is not reusable, not reviewable, not versioned with the code, and
invisible to the Fleet Dashboard. If the host is rebuilt or the work moves to
another box, every one of them silently disappears — and several of them are the
*watchdogs* whose whole job is to notice silence.

The repo's own host crontab header already says this is the wrong place:

```
# WRONG PLACE FOR PROJECT CRONS
# ...This host crontab is reserved for host-level bootstrap tasks only (@reboot).
```

…and then six recurring project jobs were added under it anyway. This task
fixes that.

**Goal:** every job below runs from a container defined in this repo, on the
same supercronic pattern every site already uses, with **at most one**
`@reboot` line left in the host crontab.

---

## 2. Exact current state — the inventory

Read with `crontab -l`. Verbatim schedules, as of 2026-08-15:

| # | Schedule | Script (all under `tools/scripts/`) | Purpose |
|---|---|---|---|
| 1 | `*/10 * * * *` | `ensure-fleet-cron.sh` (131 ln) | Self-heal: `docker compose up -d --no-deps cron` for any site scheduler that is not running |
| 2 | `15 4 * * *` | `purge-secscan-temp-scans.sh` (31 ln) | `docker exec` into every `secscan-*-executor`, delete `scan-*` dirs older than 14d |
| 3 | `7,22,37,52 * * * *` | `reap-stuck-workers-fleet.sh` (158 ln) | Force-kill one-shot `docker compose run` worker containers that outlived their role |
| 4 | `*/15 * * * *` | `check-claude-auth.sh` (143 ln) | Probe the shared Claude OAuth session; Slack `#domain-ops` after 2 consecutive failures |
| 5 | `20 6 * * *` | `lint-sweep-cron.sh` (119 ln) | Fleet prettier parse/format sweep; writes `tools/lint-fleet/reports/latest.json`; Slacks on change |
| 6 | `* * * * *` | `domain-job-runner.sh` (235 ln) | Drain the Fleet Dashboard Domains-tab onboard/offboard spool |

Also present, **explicitly out of scope** — do not touch:

```
@reboot /home/jesse/projects/home_energy/scripts/cron-reboot.sh
```

Different project. Leave it alone.

**No systemd units are involved.** `systemctl --user list-timers` shows only
`launchpadlib-cache-clean`, `prune-playwright-results`, `rotate-gitlab-token` —
none of them fleet jobs. `/etc/cron.d/` holds only distro packages. The host
crontab is the entire surface area.

---

## 3. Per-job dossier — what actually couples each one to the host

Read each script's header comment before touching it; they carry the incident
history that justifies their existence. Summary of the couplings that matter:

### 1. `ensure-fleet-cron.sh` — ⚠️ THE HARD ONE, read §4
- Needs: docker socket (RW — it runs `docker compose up`), `sites/*` bind at
  the **same absolute path** (compose resolves bind specs host-side), each
  site's `ops/scripts/notify-slack.sh`.
- Writes: `tools/scripts/ensure-fleet-cron.log`, `.lock`,
  `.ensure-fleet-cron-alerts/`.
- Already `flock`-guarded and bounded with `timeout`. Container-safe as code.
- **Chicken-and-egg:** this is the thing that heals dead schedulers. Putting it
  inside a container that can itself die is circular. See §4.

### 2. `purge-secscan-temp-scans.sh`
- Needs: docker socket only (`docker ps` + `docker exec`).
- Cleanest containerization of the six. Do this one first as the pilot.

### 3. `reap-stuck-workers-fleet.sh`
- Needs: docker socket, `/home/jesse/projects/domains/.env` (RO, for
  `SLACK_BOT_TOKEN`), `docker inspect` label reads.
- Hard-codes `/home/jesse/projects/domains/.env` at line 54 — parameterize it
  to `${DOMAINS_ROOT}` while you are in there.

### 4. `check-claude-auth.sh`
- Needs: `~/.claude/.credentials.json` (RO), `.env` (RO, Slack), `python3`,
  `curl`, network egress to slack.com.
- Mount credentials RO exactly as the site workers already do:
  `${HOME}/.claude/.credentials.json:/home/ops/.claude/.credentials.json:ro`.
- **Careful:** this is the fleet's only fast detector for the outage documented
  in `project_fleet_outage_2026-08_oauth_expiry` (a week of silent fleet-wide
  failure). Do not leave it un-scheduled for any window during migration.

### 5. `lint-sweep-cron.sh`
- Needs: `python3`, the repo RW-ish (writes `tools/lint-fleet/reports/`), `.env`
  (Slack), `tools/role-notify/notify_role.py`.
- Easy. No docker socket needed.

### 6. `domain-job-runner.sh` — ⚠️ heaviest image requirement
- Added 2026-08-15 alongside the Fleet Dashboard **Domains** tab
  (`tools/fleet-dashboard/server/domains.js`; see the `fleet-dashboard-dev`
  skill, section "Domains tab").
- Needs, because it shells out to `domain-manager-cli.sh` → `bootstrap-domain.sh`
  / `full-bootstrap.sh` / `remove-domain.sh`:
  - **`gh` CLI** (repo create / view / archive). Auth via `GITHUB_TOKEN` from
    `.env` — already present there; `gh` reads `GH_TOKEN`/`GITHUB_TOKEN`.
  - **node ≥ 22 + npm** (`npm install`, `npm ci`, `astro build`, `wrangler deploy`).
  - `python3`, `curl`, `git`, `openssh-client`, `flock`.
  - The parent repo mounted **RW at the same absolute path** — it runs
    `git submodule add`.
  - `~/.ssh` RO (the `github-bourneash` alias).
- **MUST run as uid 1000.** A root-run `git submodule add` leaves root-owned
  objects in the parent repo's `.git` — the corruption already open in
  `project_git_objects_root_corruption`. The per-site cron image's `ops` user
  (uid 1000, group 1000, plus `docker_host` gid 1004) is exactly right.
- `PATH` in the script currently hard-codes host paths
  (`/home/jesse/.nvm/versions/node/v23.7.0/bin`, `/home/jesse/.pyenv/shims`,
  `/snap/bin`). **Delete that line's host assumptions** and let the image
  provide the toolchain; keep an override env var if you want.
- Spool lives at `tools/fleet-dashboard/data/domain-jobs/` (gitignored via
  `tools/fleet-dashboard/.gitignore` → `data/`). The dashboard container (root)
  writes job records; the runner (uid 1000) replaces them by **temp-file +
  rename**. That rename is load-bearing across the uid split — do not "simplify"
  it into an in-place write.

---

## 4. The one genuine design problem: who heals the healer?

`ensure-fleet-cron.sh` exists because on 2026-07-06 a `docker-ce` apt upgrade
bounced dockerd and `restart: unless-stopped` did **not** bring the site
schedulers back — 18h of silent fleet-wide outage. If you move it into a
container, the same failure mode takes out the healer too.

Pick one and state the choice in your commit message:

**Option A (recommended) — one `@reboot` + a self-heal for the healer.**
Move all six jobs into the container. Keep exactly one host line:

```
@reboot /home/jesse/projects/domains/tools/fleet-cron/ensure-up.sh
```

…a ~10-line script that runs `docker compose up -d` for the fleet-cron stack.
Then let the fleet-cron container's own `ensure-fleet-cron.sh` job additionally
verify *itself* is the running container (trivially true) **and** have the
Fleet Dashboard surface the container's health, so a dead healer is visible in
the UI within a refresh. This is the smallest host footprint that still
survives a reboot.

**Option B — systemd unit instead of `@reboot`.**
A `systemd --user` unit with `Restart=always` + `WantedBy=default.target` and
`loginctl enable-linger jesse`. Stronger recovery than `@reboot`, but it is
still host state that is not in the repo, and the repo has no systemd
precedent. Only pick this if you can commit the unit file to the repo and
install it from a script.

**Option C — leave `ensure-fleet-cron.sh` on the host, containerize the other
five.** Honest and safe, but it does not satisfy "get that off the host asap."
Fall back to this only if A proves unworkable, and say so explicitly.

Do **not** invent a second watchdog container to watch the first one. That is
turtles all the way down and Jesse will reject it.

---

## 5. Target architecture

Create **`tools/fleet-cron/`** — a tools-level scheduler container, following
the pattern every site already uses. There is no tools-level cron container in
the repo yet; you are establishing it. Thirteen `tools/*/docker-compose.yml`
files already exist as style references (`tools/data-hub`, `tools/product-feed`,
`tools/fleet-dashboard`).

**Copy the proven pattern from `sites/americastrikes.com`** — read these three
files in full before writing anything:

- `sites/americastrikes.com/ops/docker/Dockerfile.cron` — alpine + supercronic
  v0.2.34 (sha-pinned), `ops` user uid 1000 / gid 1000, `docker_host` group
  **gid 1004** (matches host `docker` group — verify with `getent group docker`),
  `USER ops`.
- `sites/americastrikes.com/ops/docker/entrypoint-cron.sh` — sources
  `.env.shared`, then `exec supercronic -passthrough-logs /etc/crontab.docker`.
- `sites/americastrikes.com/docker-compose.yml` (the `cron` service) — the
  same-absolute-path bind mount, `HOME` matching the host's, `restart:
  unless-stopped`, `security_opt: no-new-privileges:true`.

### Proposed layout

```
tools/fleet-cron/
  README.md              # what runs here and why it is not on the host
  docker-compose.yml     # service `cron`, container `fleet-cron`
  Dockerfile             # alpine + supercronic + toolchain, USER ops (uid 1000)
  crontab.docker         # the six schedules, verbatim cadences from §2
  entrypoint.sh          # source .env, then exec supercronic
  ensure-up.sh           # the single @reboot host line (Option A)
  HANDOFF.md             # this file — delete or mark DONE when finished
```

### Load-bearing container requirements

- `container_name: fleet-cron`, `restart: unless-stopped`,
  `security_opt: [no-new-privileges:true]`.
- **`USER ops` (uid 1000).** Non-negotiable — see
  `feedback_worker_containers_run_as_uid1000` and §3.6.
- Repo bind-mounted **at the same absolute path** as the host
  (`/home/jesse/projects/domains:/home/jesse/projects/domains`), RW.
  `HOME=/home/jesse` in the environment, same reason the site cron containers
  do it: `docker compose` bind specs are resolved by the host daemon.
- `/var/run/docker.sock` RW (compose v2 breaks with `:ro`).
- `${HOME}/.ssh:ro`, `${HOME}/.claude/.credentials.json:ro`,
  `${HOME}/.docker` (for image builds triggered by `ensure-fleet-cron.sh`).
- `TZ: America/New_York` — the cadences above are wall-clock local and some
  (04:15, 06:20) are deliberately off-peak. Getting TZ wrong silently shifts them.
- Bring up with `docker compose --env-file ../../.env up -d` so `.env`
  interpolation works, matching `tools/fleet-dashboard`'s documented invocation.

### Image contents

Alpine base + `bash curl python3 git openssh-client docker-cli
docker-cli-compose tzdata ca-certificates flock(util-linux) github-cli nodejs
npm`. Verify `gh` and a node ≥ 22 are actually available in Alpine's repos at
the pinned version; if `github-cli` is not packaged, install the release tarball
with a sha256 check the way the Dockerfile already does for supercronic.

⚠️ This image is heavier than the per-site cron image because job 6 needs the
full node + gh toolchain. If that bloat is objectionable, the acceptable split
is **two services in the same compose file** (`cron` for jobs 1–5, `domain-jobs`
for job 6) — not two directories.

---

## 6. Migration plan

Do it in this order. Verify each step before starting the next; never have a
job scheduled in both places, and never have one scheduled in neither.

1. **Scaffold** `tools/fleet-cron/` (Dockerfile, compose, entrypoint, empty
   crontab). Build. Confirm the container starts, stays up, and that
   `docker exec fleet-cron id` reports **uid=1000**.
2. **Pilot with job 2** (`purge-secscan-temp-scans.sh`, docker-socket-only).
   Add it to `crontab.docker`, comment it out of the host crontab, verify one
   real firing in `docker logs fleet-cron`.
3. **Jobs 3 and 5** (`reap-stuck-workers-fleet.sh`, `lint-sweep-cron.sh`).
   Same move-and-verify. Confirm Slack still posts from inside the container.
4. **Job 4** (`check-claude-auth.sh`). Verify the credentials mount resolves and
   a forced-failure path still reaches `#domain-ops` **before** removing the
   host line — this one is a watchdog, a silent migration failure is invisible.
5. **Job 6** (`domain-job-runner.sh`). Strip the host `PATH` hard-code. Verify
   end-to-end with a **read-only** command first:
   queue `status <existing-domain.com>` from the Domains tab and confirm
   queued → running → done, exit 0, log captured, and `id -u` = 1000 in the log
   header. Only then consider a real onboard.
6. **Job 1** (`ensure-fleet-cron.sh`) last, per the §4 decision. Add
   `ensure-up.sh` + the single `@reboot` host line in the same change.
7. **Clean the host crontab** down to the `home_energy` `@reboot` line plus at
   most your one `@reboot`. Keep the existing "WRONG PLACE FOR PROJECT CRONS"
   header — it is now finally true.

---

## 7. Do not break these

- **Container actions stay repo-scoped.** Anything that acts on containers must
  keep the `working_dir`-inside-the-repo check pattern
  (`tools/fleet-dashboard/server/containers.js` → `assertDomains()`).
- **`.env` / `.env.shared` are secrets.** `.env.shared` is gitignored and
  chmod 400 fleet-wide (`feedback_env_shared_must_be_gitignored`,
  `feedback_env_shared_locked_read_only`). Mount RO. Never commit either.
- **`.monorepo-tools` bind mounts must stay gitignored** — a container-side
  commit otherwise sweeps the whole shared `tools/` tree into a site repo
  (`feedback_site_containers_need_monorepo_tools_mount`).
- **Per-file staging, never `git add -A`** (`feedback_commit_push_on_completion`).
  The repo routinely carries unrelated in-flight work.
- **crontab.docker is baked into site cron images** — edits need an image
  rebuild, not just a restart (`project_cron_image_drift_2026-08-10`). Your new
  image inherits this trap. Either document it loudly in the README **or**
  bind-mount `crontab.docker` live (the `amputeenews` variant) so edits take
  effect on restart. Prefer the bind-mount; the baked-in version has already
  cost the fleet unscheduled jobs.
- **Do not change any job's cadence** during the migration. Same wall-clock
  schedule, different host. One variable at a time.
- **Do not rewrite the job scripts' logic.** They carry incident history in
  their headers. The only edits sanctioned here are: removing host-path
  hard-codes, and parameterizing `DOMAINS_ROOT`.

---

## 8. Verification

Per job, after moving:

```bash
docker logs --tail 100 fleet-cron          # supercronic logs every firing
docker exec fleet-cron id                  # MUST be uid=1000(ops)
crontab -l                                 # the line is gone from the host
```

Plus the job-specific proof:

| Job | Proof it still works |
|---|---|
| 1 | `docker stop <site>-cron`, wait a tick, confirm it comes back + the log entry |
| 2 | Log shows a before/after `scan-*` count per `secscan-*-executor` |
| 3 | Log shows the `docker ps` one-shot sweep running (0 reaped is a valid pass) |
| 4 | Forced-failure path posts to `#domain-ops`; recovery message follows |
| 5 | `tools/lint-fleet/reports/latest.json` mtime advances after 06:20 |
| 6 | Domains tab: `status <domain>` goes queued → running → done, exit 0 |

**Full-stack regression:** `cd tools/fleet-dashboard && NODE_ENV=test node --test`
— 97 tests, must stay at 0 failures.

**Rollback:** the host crontab lines are the rollback. Keep each one
**commented out**, not deleted, until every job has proven itself through at
least one natural firing (job 5 needs a day; do not rush it). Uncomment to
revert instantly.

---

## 9. Acceptance criteria

- [ ] `crontab -l` contains no recurring `tools/scripts/*` lines — at most one
      `@reboot` for the fleet-cron stack, plus the untouched `home_energy` line.
- [ ] All six jobs run from `tools/fleet-cron/`, committed to the repo.
- [ ] `docker exec fleet-cron id` → uid 1000.
- [ ] Each job has had at least one verified natural firing (§8 table).
- [ ] `tools/fleet-cron/README.md` documents what runs there, the crontab-edit
      workflow (rebuild vs restart), and the §4 decision that was taken.
- [ ] `domain-job-runner.sh` no longer hard-codes host `PATH`s, and the
      `fleet-dashboard-dev` skill's "Domains tab" section is updated to say the
      runner is containerized (it currently documents a host cron).
- [ ] `project_fleet_smoke_health_checks` / Fleet Dashboard surfaces the
      `fleet-cron` container so a dead healer is visible without shelling in.
- [ ] Full `node --test` suite still green.
- [ ] Committed per-file and pushed to `main`.

---

## 10. Context you should load first

- Skill `fleet-dashboard-dev` — especially the **Domains tab** section, which
  documents job 6's spool protocol end-to-end.
- `sites/americastrikes.com/ops/docker/` — the pattern being copied.
- Memory: `feedback_worker_containers_run_as_uid1000`,
  `project_git_objects_root_corruption`, `project_cron_image_drift_2026-08-10`,
  `project_fleet_outage_2026-08_oauth_expiry`,
  `feedback_env_shared_must_be_gitignored`, `reference_cron_stagger_map`,
  `feedback_commit_push_on_completion`.
- Each of the six scripts' header comments. They are unusually good; they
  explain the incident each job exists to prevent.
