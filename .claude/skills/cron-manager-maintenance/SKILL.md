---
name: cron-manager-maintenance
description: >-
  Maintain, debug, and extend the portfolio Cron Manager at tools/cron-manager
  (the loopback panel on port 4753 that pauses/resumes/edits cron jobs across
  every site and tool in the domains repo). Use this skill WHENEVER the work
  touches cron-manager OR autonomous-ops scheduling, even if the user doesn't
  name the tool — e.g. "the pause toggle doesn't actually stop the job / it
  still fired", "disabled in the panel but it's still running", "a role keeps
  firing after I disabled it", "add <site> to the cron manager", "the panel
  shows the wrong status / never-built / a role won't pause", "edit a cron
  schedule from the panel", "rebuild the cron container", anything about
  ops/.<role>-disabled flags, run-worker.sh / run-role.sh kill-switches, the
  crontab.docker files, or how a site's autonomous roles get scheduled and
  stopped. This skill carries the architecture, the load-bearing invariants,
  and ready-to-run verification scripts so changes don't silently break a
  pause that the UI still reports as working.
---

# Cron Manager Maintenance

## What this system is

`tools/cron-manager/` is a loopback web panel (Node/Express, port **4753**) that
surfaces every cron container across the domains portfolio and lets you control
jobs without SSH-ing into containers. It is **discovery-driven**: on every
request it globs `sites/*/ops/docker/crontab.docker` and `tools/*/crontab.docker`,
so new systems appear automatically with no registry to maintain. The filesystem
is the source of truth.

Run it: `cd tools/cron-manager && npm start` (host) or `docker compose up -d --build`
(panel at `http://127.0.0.1:4753`). Tests: `npm test` (node:test).

## The one thing you must internalize: control mechanisms vs. effect

The panel has **two** ways to change a job, and they take effect very
differently. Confusing them is the #1 source of "I toggled it but nothing
changed" bugs — including the original incident this skill was written from.

| Panel action | What it writes | When it takes effect | Applies to |
|---|---|---|---|
| **Pause / Resume a role** | `ops/.<role>-disabled` flag file | **Instant** — next scheduled fire is skipped | lines that call `run-worker.sh <role>` on a *site* |
| **Edit / Remove / Comment a line** | rewrites `crontab.docker` | **Only after "Rebuild & restart cron"** | non-role lines, and **all tool jobs** |

Why the split: `crontab.docker` is `COPY`'d into the cron image at build time, so
editing it on disk changes nothing in the running container until the image is
rebuilt and the container recreated. The flag file, by contrast, is read live
because the project is **bind-mounted** into the cron container — so a flag
toggle needs no rebuild.

### The load-bearing invariant (this is what silently breaks)

The flag file only *does* anything if the site's **`run-worker.sh` actually
checks it and no-ops**. The panel writing `ops/.<role>-disabled` and reading it
back for the badge is a closed loop that looks correct *even when the job keeps
running* — because the thing that skips the job lives in the site's shell
script, not in the panel.

**Therefore: every site's `ops/scripts/run-worker.sh` MUST contain the
kill-switch, and as defense-in-depth so MUST `ops/scripts/run-role.sh`.** If a
site is missing it, the panel will show "disabled" while the role keeps firing
and updating its last-run — a cosmetic-only pause. This is exactly the bug that
existed on 7 of 8 sites before 2026-06-16.

The exact kill-switch blocks (and where they go) are in
`references/kill-switch-invariant.md`. Read it before adding a site or touching
either script.

## When you arrive, orient first

Run the bundled audits before changing anything — they tell you the real state:

```bash
# 1. Is every site's pause actually wired? (static + syntax + functional)
bash .claude/skills/cron-manager-maintenance/scripts/verify-killswitch.sh

# 2. Is any role silently paused right now? (stale .<role>-disabled flags,
#    cross-referenced against active crontab lines)
bash .claude/skills/cron-manager-maintenance/scripts/audit-disabled-flags.sh
```

`verify-killswitch.sh` is the regression guard: if it reports any site as
`NO-CHECK` or a functional test fails, the panel's pause is lying for that site.
Always run it after editing any `run-worker.sh` / `run-role.sh`, and after adding
a new site.

## Troubleshooting playbook

Work the symptom, not a guess. (Full systematic approach: investigate root
cause before any fix.)

### "I disabled a role in the panel but it still runs / still shows last-run"
The classic cosmetic-pause bug. The flag is being written but not honored.
1. Confirm the flag exists: `ls -la sites/<site>/ops/.<role>-disabled`
2. Confirm the script honors it: `grep -n disabled sites/<site>/ops/scripts/run-worker.sh`
3. If absent → port the kill-switch from `references/kill-switch-invariant.md`
   into `run-worker.sh` (and `run-role.sh`). No rebuild needed — bind-mounted,
   live next fire.
4. Verify: `bash .../scripts/verify-killswitch.sh`

### "A role unexpectedly stopped running"
Likely a stale `ops/.<role>-disabled` left from earlier panel testing. Run
`audit-disabled-flags.sh`; it flags any **active** crontab role that currently
has a disable flag. Re-enable by deleting the flag (or the panel's Resume).
Note flags are often `root`-owned (the panel container runs as root) — that's
normal, not corruption.

### "I edited a schedule / removed a line but the container didn't change"
Expected: file-mutating actions are rebuild-gated. Click **Rebuild & restart
cron** for that system (or `cd` to the system dir and
`docker compose build cron && docker compose up -d cron`). The panel shows a
**needs-rebuild** chip when `crontab.docker` mtime is newer than the container's
created time.

### "Panel shows a red badge / 'never-built' / failed status"
The status is honest (real docker state, not a guess). See the state model in
`references/architecture.md`. Most failed rebuilds trace to the **HOME
invariant** below.

### A direct `docker compose run --rm worker <role>` line bypasses the pause
The panel only offers an instant toggle for `run-worker.sh <role>` lines
(`extractRole` matches that exact pattern). A direct `docker compose run` line
is parsed as a non-role line — no instant toggle, only comment+rebuild. The
`run-role.sh` defense-in-depth check still catches it *if the role name matches
a flag*. Prefer routing scheduled roles through `run-worker.sh` so pause works
uniformly.

## Adding a new site to the panel

There is nothing to register — discovery is automatic once the site has
`ops/docker/crontab.docker`. But the site is only *controllable* if it satisfies
the invariants:

1. `ops/scripts/run-worker.sh` contains the kill-switch (so pause works).
2. `ops/scripts/run-role.sh` contains the kill-switch (defense-in-depth).
3. The site's `docker-compose.yml` cron service bind-mounts the project at the
   same absolute path and sets `working_dir` there (so flag edits are live and
   `run-worker.sh <role>` resolves). Pattern: `${PWD}:${PWD}` + `working_dir: ${PWD}`.
4. The cron `container_name` ends in `-cron` (discovery prefers the real
   `container_name:` ending in `-cron`, falling back to `<stem>-cron`).

Then run `verify-killswitch.sh` and confirm the new site reports all-green.

## Working on the panel code itself

The server is small and split by concern. Read `references/architecture.md` for
the module map, the HTTP API, the container state model, and the `last-run.json`
contract before editing. Keep these guarantees intact:

- **HOME invariant** (compose env `HOME: ${HOME:-/home/jesse}`): the panel runs
  `docker compose up cron` *inside its own container*; site compose files mount
  `${HOME}/projects/domains/.env` resolved by the host daemon, so HOME must equal
  the host's. Without it the bind source becomes `/root/...` and rebuilt cron
  containers get stuck in `created` (OCI exit 127). Don't remove it.
- **Same-path bind mount**: the repo is mounted at the *same* absolute path
  inside the panel container so `docker compose build/up` for a site resolves its
  volume sources.
- **Honest status**: never collapse the real docker state back into a
  running/stopped binary — that's how 5 silent failures once hid.
- **Optimistic-concurrency on crontab edits**: edits pass `expectedRawLine` and
  reject with 409 STALE if the file changed. Keep it; it prevents clobbering
  edits made by an autonomous role mid-session.
- After changing server logic, run `npm test` and rebuild the panel container
  (`docker compose up -d --build`) — source edits don't reach the running panel
  until rebuild.

## Submodule discipline (sites are git submodules)

Each `sites/*` is its own `bourneash/*` submodule on branch `main`, usually full
of in-flight autonomous-agent work. When committing an infra fix into one:
**`git add <the specific file>` only — never `git add -A`**, and don't bump the
parent repo's submodule pointer (the sites' own deployer loops own that). End
commit messages with the `Co-Authored-By` trailer. Pushing triggers that site's
CF Workers Build, so it's outward-facing — confirm with the user unless told to
proceed.

## Reference material

- `references/kill-switch-invariant.md` — the exact kill-switch blocks for
  `run-worker.sh` and `run-role.sh`, where they anchor, and why. **Read before
  touching either script or adding a site.**
- `references/architecture.md` — panel module map, HTTP API, container state
  model, discovery/parse rules, `last-run.json` contract. Read before editing
  panel code.
- `scripts/verify-killswitch.sh` — static + syntax + functional check that every
  site's pause is real. The regression guard.
- `scripts/audit-disabled-flags.sh` — list every current `.<role>-disabled` flag
  with owner/age, and flag any *active* role that's silently paused.
