# cron-manager — Portfolio Cron Control Panel

**Date:** 2026-06-13
**Status:** Approved (design)
**Location:** `tools/cron-manager/`

## Problem

Many domain projects under `/home/jesse/projects/domains/sites/` run autonomous work via
per-site cron containers (supercronic reading `ops/docker/crontab.docker`). Several
`tools/` also run cron. There is no single place to see **which systems have cron
containers, what they run, and their state** — and no way to enable/disable/edit/remove
an item (e.g. pause a content writer) without hand-editing files per repo.

We want one dashboard that surfaces every cron system across the portfolio, shows what
each runs, and lets the operator pause/resume/edit/remove jobs. It must be **dynamic**:
newly-added domains appear automatically with no config edit.

## Goals

- Discover **all** cron systems automatically (sites + tools), zero per-site config.
- Show, per system: container run-status, every scheduled job, what it runs, a
  human-readable schedule, and whether each job is currently enabled or paused.
- Four verbs per job: **enable**, **disable**, **edit schedule**, **remove**.
- Make the everyday "pause a content writer" action **instant and reversible** with no
  container rebuild.
- Stay safe: confine all writes to known cron files; never bounce a container without an
  explicit click.

## Non-goals (YAGNI)

- No authentication — loopback bind only (same posture as `domain-developer`).
- No creating brand-new roles from the UI. New roles are the job of the
  `domains-agent-cron-role-engineer` skill; the panel links to it.
- No editing the internals of inline flag-triggered deployer lines beyond enable/disable.
- No persistent database. The filesystem is the source of truth.

## Architecture

A small **Node + Express** server, single-page panel, bound to `127.0.0.1` — mirrors the
proven `tools/domain-developer` pattern. Launched either via `docker compose` (like the
other tools) or `node server.js` on the host. It needs the repo on disk (to read/write
cron files) and the Docker socket (to query status and rebuild/restart cron containers).

The **filesystem is the source of truth.** Every read re-scans disk, so newly-added sites
appear the instant their `crontab.docker` exists. No registry, no cache to invalidate.

### Components

- `server/server.js` — Express app: discovery, parsing, status, and the action endpoints.
- `server/discovery.js` — globs cron systems, derives names/paths.
- `server/crontab.js` — parse + rewrite `crontab.docker` (line-preserving).
- `server/docker.js` — `docker ps` status + `docker compose build/up` for a system.
- `server/public/index.html` + `app.js` + `style.css` — the panel UI.
- `docker-compose.yml` + `Dockerfile` — containerized launch (loopback port).
- `README.md` — run instructions and the safety model.

## Discovery (dynamic)

On every request the server globs two roots under the domains repo root:

- `sites/*/ops/docker/crontab.docker`  → **site** cron systems
- `tools/*/crontab.docker`             → **tool** cron systems

For each match, derive:

- **kind**: `site` or `tool`.
- **slug**: the directory name (e.g. `americastrikes.com`, `site-tracker`).
- **compose project / container name**:
  - sites: project `<slug-without-dot>-ops`, cron container `<slug-without-dot>-cron`
    (e.g. `americastrikes.com` → `americastrikes-ops` / `americastrikes-cron`).
  - tools: project/container per the tool's own `docker-compose.yml` (read the
    `name:`/`container_name:` rather than assuming; fall back to the dir name).
- **crontab path** and (sites only) the **ops dir** for disabled-flag files.

A site that follows the standard ops layout shows up automatically — that is the
"new domains are added automatically" requirement, satisfied by globbing rather than a
hand-maintained list.

## Per-system model

For each discovered system the server computes:

- **Container status** via `docker ps --filter name=<container> --format ...`:
  `running` | `stopped` | `never-built` (image/container absent).
- **Cron entries** by parsing `crontab.docker`:
  - Skip blank lines, comment lines (`#…`), and env assignments
    (`COMPOSE_PROJECT_NAME=…`).
  - For each remaining line capture `{ scheduleExpr, rawLine, command }`.
  - **role** extraction: if the command matches `run-worker.sh <role>`, role = `<role>`.
    Otherwise role = `null` and we show a derived label from the command (covers the
    tools' inline commands and the flag-triggered deployer one-liners).
  - **lineIndex** so a rewrite can target the exact line.
- **Enabled state** per entry:
  - sites with a real `role`: paused iff `ops/.<role>-disabled` exists.
  - lines without a role (tools, inline deployer): paused iff the line is commented out.
- **Human schedule**: translate the 5-field cron expr to plain English
  ("every 2h, 6am–10pm ET") using a small cron-descriptor dependency
  (e.g. `cronstrue`). Timezone is `America/New_York` for sites (set in
  `Dockerfile.cron`), surfaced as a note.

## Actions (the four verbs)

| Verb | Mechanism | Goes live |
|---|---|---|
| **Disable** (role) | `touch <ops>/.<role>-disabled` | Instant — `run-worker.sh` honors it on the next tick. No rebuild. |
| **Enable** (role) | remove that flag file | Instant. |
| **Disable** (no-role line, tools/inline) | comment out the line in `crontab.docker` | Needs rebuild + restart. |
| **Enable** (no-role line) | uncomment the line | Needs rebuild + restart. |
| **Edit schedule** | rewrite that entry's line (schedule field only) in `crontab.docker` | Needs rebuild + restart. |
| **Remove** | delete the line from `crontab.docker` | Needs rebuild + restart. |

Because `crontab.docker` is `COPY`'d into the cron image (`Dockerfile.cron`), any change
to the file is **not live** until that system's cron container is rebuilt and restarted.
The UI therefore:

- Performs role-based **enable/disable** instantly (the everyday path — no bounce).
- For file-mutating actions (edit, remove, no-role disable), writes the change and marks
  the system **"pending rebuild"** with a one-click **Rebuild & restart cron** button that
  runs `docker compose build cron && docker compose up -d cron` for that system and
  streams output back to the panel.

## Data flow

1. Browser `GET /api/systems` → server globs, parses, queries docker → returns JSON array
   of systems with their entries + status + pending-rebuild flags.
2. UI renders one card per system; each entry row shows schedule (human + raw), what it
   runs, enabled toggle, edit, remove.
3. Toggle role job → `POST /api/systems/:slug/jobs/:role/disable|enable` → touch/rm flag →
   returns updated entry. (Instant.)
4. Edit/remove/no-role-toggle → `POST /api/systems/:slug/crontab` with the line change →
   server rewrites the single line, preserving the rest of the file byte-for-byte → marks
   system pending-rebuild.
5. Rebuild → `POST /api/systems/:slug/rebuild` → streams `docker compose` output (SSE or
   chunked) → clears pending-rebuild on success.

## Error handling & safety

- **Path confinement:** every write resolves the target and asserts it is exactly the
  discovered `crontab.docker` or a `<ops>/.<role>-disabled` path inside `sites/*/ops` or a
  `tools/*` crontab. Anything outside is refused.
- **Line-preserving rewrites:** edit/remove operate on a single indexed line; header,
  comments, env lines, and jitter offsets are untouched. Edit validates the new cron
  expression (5 fields) before writing.
- **No silent container bounce:** rebuild/restart only happens on an explicit button press;
  the response streams `docker compose` stdout/stderr so failures are visible.
- **Missing docker / not running:** status degrades to `never-built`/`stopped` with a
  clear label rather than erroring the whole page.
- **Concurrent edits:** read-modify-write reads the file fresh immediately before writing;
  if the line at `lineIndex` no longer matches the expected `rawLine`, reject with a
  "file changed, reload" error rather than clobbering.

## Testing

- **crontab.js unit tests:** parse fixtures from the real sites (americastrikes
  multi-role, xxxtea jittered, shoptopless single-line, sinderella locks, a tool inline
  command); assert correct entries, role extraction, comment/env skipping. Round-trip:
  disable→enable and edit→revert reproduce the original file byte-for-byte.
- **discovery.js unit tests:** a temp dir with fake `sites/*/ops/docker/crontab.docker`
  and `tools/*/crontab.docker` → assert correct slugs, kinds, container names, and that a
  newly-created dir is picked up on re-scan.
- **path-confinement tests:** attempts to write outside the allowed paths are rejected.
- **docker.js:** mocked `docker` calls map output to running/stopped/never-built.
- Manual smoke: launch panel, confirm all 8 sites + 3 tools render, pause/resume a role
  flag and verify the file on disk, edit a schedule and confirm pending-rebuild gating.

## Known systems at design time

Sites (8): americastrikes.com, aliencouncil.com, reviewtattoo.com, shoptopless.com,
sinderella.org, ultrarough.com, weapontester.com, xxxtea.com.
Tools (3): site-tracker, cf-stats, gh-stats.

These are the seed set; discovery is dynamic and will pick up any future additions.
