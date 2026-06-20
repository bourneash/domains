# Cron Manager architecture

Read this before editing the panel code. The server is small (~5 modules) and
split by concern. Port **4753**, loopback only.

## Module map (`server/`)

| File | Responsibility |
|---|---|
| `server.js` | Express app + all HTTP routes. `createApp({ root, statusRunner })` is testable (inject a fake docker runner). Entry point listens on `CM_HOST:CM_PORT` (`127.0.0.1:4753`). |
| `discovery.js` | `discoverSystems(root)` — globs sites/tools, parses each crontab, attaches `enabled` per entry. Resolves the real `-cron` container name from each site's `docker-compose.yml` (handles dot-stripping drift like `xxxtea-com`). |
| `crontab.js` | Pure parse/edit of `crontab.docker` text. `parseCrontab`, `extractRole`, and the line mutators (`commentLine`/`uncommentLine`/`editSchedule`/`removeLine`) with optimistic-concurrency (`assertLine` → STALE). |
| `docker.js` | All docker shell-outs: `inspectContainer` (honest state), `confirmHealthy` (post-rebuild poll), `containerLogs`, `containerCreatedAt`, `rebuildCron`. Never throws; returns readable fallbacks. |
| `runinfo.js` | `readLastRuns` (per-role last-run.json), `resolveLogPath` (traversal-safe container→host path), `tailFile`. |
| `public/` | Static UI (`index.html`, `app.js`, `style.css`). Mission-console look, light/dark toggle, inline cron editor, log viewer, rebuild toast. |

## HTTP API

| Method + path | Purpose |
|---|---|
| `GET /api/systems` | All systems with live container health, per-job last-run, `needsRebuild`, log sources. The main poll. |
| `GET /api/cron/describe?expr=` | Validate + plain-English a cron expr (inline editor live feedback). |
| `GET /api/systems/:slug/logs?source=&tail=` | Tail logs. `source` = `container` \| `rebuild` \| `role:<role>`. |
| `POST /api/systems/:slug/jobs/:role/:action` | **Instant role flag.** `action` = `disable` (writes `ops/.<role>-disabled`) \| `enable` (unlinks it). 400 if the system is a tool (no opsDir). |
| `POST /api/systems/:slug/crontab` | **File-mutating.** body `{action, lineIndex, newSchedule, expectedRawLine}`; `action` = comment\|uncomment\|edit\|remove. Returns `{ok, pendingRebuild:true}`. 409 if `expectedRawLine` is stale. |
| `POST /api/systems/:slug/rebuild` | `docker compose build cron && up -d cron` in the system dir, streams output, then `confirmHealthy` polls and a `@@VERDICT ok|fail` line drives the client toast. |

## Discovery & parse rules (the classification that drives everything)

- A **site** has `sites/<slug>/ops/docker/crontab.docker`; `opsDir =
  sites/<slug>/ops`. A **tool** has `tools/<slug>/crontab.docker`; `opsDir =
  null`.
- `parseCrontab` keeps only lines matching 5 valid cron fields + a command
  (prose comments are rejected by `isValidCron`). A leading `#` → `commented:true`.
- `extractRole(command)` returns the token after `run-worker.sh` (regex
  `/run-worker\.sh\s+([A-Za-z0-9._-]+)/`) or `null`. **This is the toggle
  switch:** an entry with a `role` AND a site `opsDir` gets the instant flag
  toggle and its badge reads `ops/.<role>-disabled`; everything else
  (non-role lines, all tool lines) is controlled by comment/uncomment +
  rebuild.
- `enabled` per entry: role lines → `!exists(.<role>-disabled)`; other lines →
  `!commented`.

Consequence: tools and non-role site lines have **no instant pause** — that's by
design, not a bug. Only `run-worker.sh <role>` lines pause live.

## Container state model (`inspectContainer`)

Honest state from `docker ps -a`, never a running/stopped binary:

- `state`: `running` | `created` | `exited` | `restarting` | `paused` | `dead`
  | `never-built` | `unknown`
- `raw`: the human `.Status` string (`"Up 3 hours"`, `"Exited (127) 2 min ago"`)
- `exitCode`: parsed from `(NNN)` when present
- `ok`: true only when `running`
- `failed`: true for states that should NOT persist — `created` (start failed),
  `dead`, `restarting` (crash loop), or `exited` with non-zero code. Drives the
  red badge. This honesty is load-bearing: collapsing it back to grey
  "stopped" is how 5 failed rebuilds once stayed invisible.

`confirmHealthy` polls after `up -d` (`up -d` exiting 0 does NOT mean the
container survived init). `needsRebuild` = `crontab.docker` mtime newer than
`containerCreatedAt` → the baked-in copy is stale.

## `last-run.json` contract

Each site's roles write `ops/board/last-run.json`:
`{ "<role>": { "at": ISO, "exit": code, "log": "/work/ops/logs/...." } }`.
The panel reads it for the Last-run column and per-role log viewing.
`resolveLogPath` translates the container path (`/work/...` or `ops/...`) to a
host path and **refuses anything escaping `sites/<slug>/ops/logs`** (traversal
defense). Not every site writes this file; absence just means a blank Last-run.

## Invariants you must not break (see SKILL.md for the why)

- **HOME invariant** — compose env `HOME: ${HOME:-/home/jesse}`. The panel runs
  `docker compose up cron` for sites *inside its own container*; without HOME
  matching the host, `${HOME}/projects/domains/.env` bind sources resolve to
  `/root/...` and rebuilt cron containers stick in `created` (OCI 127).
- **Same-path bind mount** — repo mounted at the same absolute path inside the
  panel container so site `docker compose build/up` resolves volume sources.
- **Optimistic concurrency** — keep `expectedRawLine`/STALE on crontab edits;
  autonomous roles may rewrite these files mid-session.
- **`statusRunner` injection** — keep docker calls behind the injectable runner
  so `npm test` stays hermetic (no real docker).

## After editing panel code

1. `cd tools/cron-manager && npm test`
2. Rebuild the panel container so the running instance picks up source changes:
   `docker compose up -d --build`. Source edits do NOT reach the live panel
   until rebuild.

## Provenance

Built 2026-06-13 (`feat/cron-manager`). Honest-health + post-rebuild verify
(`fa790b0`), enterprise UI redesign (`3c80993`), HOME-invariant fix (`a30f5e1`).
Portfolio cron conventions live in repo-root `CRON_OPERATIONS.md`.
