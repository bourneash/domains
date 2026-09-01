---
name: fleet-dashboard-dev
description: >-
  Develop, extend, debug, deploy, or operate the Fleet Dashboard at
  tools/fleet-dashboard (Node/Express + vanilla SPA, localhost:4754). Use for
  dashboard tabs/views, API endpoints, Domain Control, agents, containers, Git,
  tasks, cron, auth/FD_TOKEN/login, restarts/rebuilds, live logs, routing, or
  auto-refresh. Carries the architecture, safe deploy and verification workflow,
  security guardrails, operator commands, and commit convention.
---

# Fleet Dashboard — Development

## What it is & where it lives

`tools/fleet-dashboard/` (absolute: `/home/jesse/projects/domains/tools/fleet-dashboard/`)
is a loopback web tool — **Node/Express backend + a single-file vanilla-JS SPA**
(no framework, no build step) — that surfaces and controls the entire domains
fleet at **http://127.0.0.1:4754**.

It is **discovery-driven**: it enumerates `sites/*` and reads each site's
on-disk ops state (crontabs, `ops/.<role>-disabled` flags, `ops/logs/*`, the
engineer pulse) plus live `docker` state. The filesystem + Docker are the source
of truth; there is no database and no registry. New sites/roles appear
automatically.

### Layout

```
tools/fleet-dashboard/
  docker-compose.yml      # service `panel`, container `fleet-dashboard`, 127.0.0.1:4754
  Dockerfile              # node:22-alpine + python3 git docker-cli docker-cli-compose bash
  package.json            # deps: express, js-yaml  (host node_modules is used at runtime — see below)
  server/
    server.js             # Express app + ALL route definitions
    sites.js              # discoverSites(root), isKnownSite(root, slug), siteDir(root, slug)
    audit.js              # engineer audit — SHELLS OUT to tools/engineer-fleet/engineer-status.py --json
    roles.js              # role matrix, per-role log, pause/resume, agents list, run validation
    run.js                # runEngineer / runRole — docker exec into <site>-cron
    containers.js         # docker ps / restart / stop / start / logs / bounce(rebuild) / restart-crons
    git.js                # git status / commit (path-limited) / ignore (gitignore+untrack) / push
    tasks.js              # per-site ops/tasks board CRUD (markdown + frontmatter)
    public/
      index.html          # shell: topbar, (now-hidden) tabs, Agents dropdown, modal
      app.js              # the entire SPA: router, all render*() views, fetch helpers, patterns
      style.css           # component/geometry layer — token-driven, flat single-class selectors
      theme.css           # design system: tokens, surfaces, motion, nav rail, matrix (loaded AFTER style.css)
      shell.js            # vitals rail, command palette, nav rail, motion (loaded AFTER app.js)
```

### The three-layer frontend (read this before restyling anything)

`style.css` is the **component layer**: every rule is a flat single-class
selector driven by the `:root` tokens. `theme.css` loads after it and is the
**design system** — redefining the tokens re-skins the whole app, and its
equal-specificity overrides win on source order. **Restyle in `theme.css`;
touch `style.css` only to change a component's geometry.**

`shell.js` is a **progressive-enhancement layer that knows nothing about
app.js internals**. It only observes the DOM app.js already produces:

- the **nav rail** is a *projection* of the topbar nav, not a fork of it. Each
  rail item is bound to a real `.tab[data-view]` / `.dd-item` node and
  navigates by clicking it; active state is read back off those same nodes. So
  **app.js stays the single source of truth for routes, `NAV_GROUPS` and the
  agent roster** — add a view there and the rail picks it up for free. The old
  topbar nav is still in the DOM, hidden, because app.js owns its handlers.
- `build()` **diffs a signature of the nav's shape** before rebuilding. app.js
  repaints the agents/group menus on every render; rebuilding on each one wiped
  scroll position and cut collapse animations. Don't remove that guard.
- everything interpolated into `innerHTML` there goes through a local `esc()`.
  Labels are read back via `textContent`, so they arrive **decoded** —
  re-injecting them raw would undo app.js's own escaping.
- it also synthesises a `.page-head` for the views app.js renders without one
  (Guides, Tasks, Containers, Git…), rather than editing a dozen render fns.

Two CSS invariants worth knowing: `.card` (and the `dh-panel` / `dhi-panel` /
`soc-table-card` / `compliance-table` / `cm-card` family) is `overflow: auto`,
so a table wider than its card scrolls instead of painting outside it —
`.error-card` stays `visible` for its hover tooltip. And **`th` is deliberately
not `position: sticky`**: most tables live inside a card whose overflow is not
`visible`, which scopes sticky to a non-scrolling container and shoves the
header row down over the first data row.

## Deploy mechanics — THE thing to get right

The repo is **bind-mounted into the container at the same absolute path**, and
compose sets `working_dir` to the host tool dir, so `node server/server.js` runs
the **host** files (and uses the **host** `node_modules`). This dictates exactly
what each kind of change needs:

| You changed… | How to ship it | Why |
|---|---|---|
| `server/public/*` (app.js, style.css, theme.css, shell.js, index.html) | **Nothing** — it's already live. Hard-refresh the page (or wait — open tabs self-update). | Static files served straight from the bind mount. All five are in `assetVersion()`'s fingerprint, so a change to any of them triggers the self-update. |
| `server/*.js` (server.js, roles.js, …) | `tools/fleet-dashboard/bin/fleet-dashboard restart` | Node loads them once at startup; restart re-execs against the bind-mounted host files. **No rebuild.** The operator command supplies the shared env and host Docker GID. |
| `Dockerfile` / new npm dep / new apk pkg | `cd tools/fleet-dashboard && docker compose --env-file ../../.env up -d --build` | Image must be rebuilt; new deps land in the image / host `node_modules`. |

Don't run `docker compose up -d --build` for a JS edit — a plain `restart`
(server) or nothing-but-refresh (static) is correct and far faster.

After any change: **verify** (see below). Then **commit** (see Commit
convention).

### Browser cache gotcha (only bites during dev/verification)

The SPA loads `app.js` once. A normal user reload revalidates via ETag, and open
tabs **self-update** (a `/api/version` poll reloads them when assets change). But
a *persistent* browser context (e.g. the Playwright MCP) can serve a stale
`app.js`. When driving the page for verification, **cache-bust the URL**:
`http://127.0.0.1:4754/?v=<n>#control`.

## Access token (the auth gate) — where to get it

The panel mounts the docker socket **and** joins the shared `vpn-proxy_default`
network, so any container on that network could otherwise hit its API. The gate
is a single shared secret, **`FD_TOKEN`**, and the compose **requires** it
(`FD_TOKEN: ${FD_TOKEN:?…}`) — `docker compose up` fails fast without it. It is
NOT an OAuth/external token; there is nothing to "log into." How it works:

- **Where it lives:** `FD_TOKEN=<hex>` in the gitignored, owner-readable shared
  env at `/home/jesse/projects/domains/.env`. It persists across reboots and
  normal dashboard restarts. Retrieve it only when a browser needs a fresh
  login with `tools/fleet-dashboard/bin/fleet-dashboard token`.
- **Lifecycle command:** use `tools/fleet-dashboard/bin/fleet-dashboard up`,
  `restart`, or `status`. This is the operator entry point: it always supplies
  the shared `.env`, resolves the host Docker GID, and waits for `/healthz`.
  Plain `docker compose up -d` still fails with "FD_TOKEN missing" because
  Compose does not auto-load the repo-root env.
- **Using the dashboard in a browser:** open http://127.0.0.1:4754/ → a login
  overlay ("This dashboard requires an access token") appears → paste the
  `FD_TOKEN` value → it POSTs `/api/login`, which sets an **httpOnly,
  SameSite=Strict cookie**. Its 30-day idle window rolls forward on authenticated
  browser use, so an active operator is not asked again; abandoned sessions
  still expire. The gate acts only on `/api/*`; the static shell loads without
  it (which is why `/` returns 200).
- **Rotation is exceptional, not scheduled renewal.** Rotate only after
  suspected disclosure with
  `tools/fleet-dashboard/bin/fleet-dashboard rotate-token`. It atomically
  replaces the value while preserving `.env` permissions, recreates the panel,
  invalidates existing browser cookies, and deliberately does not print the new
  secret. If recreation fails, the new token remains persisted; fix Docker and
  run `fleet-dashboard up`, then retrieve it with the `token` command. The same
  rotation command initializes `FD_TOKEN` when the shared `.env` exists but the
  token does not.
- **Escape hatch (loopback only):** the gate is skipped when the server binds a
  pure-loopback host. The compose sets `FD_HOST: 0.0.0.0` (so VPN-network
  containers can reach it) — set `FD_HOST: 127.0.0.1` to drop the token
  requirement, at the cost of that reachability. `FD_ALLOW_INSECURE=1` forces an
  unauthenticated non-loopback bind (logs a warning) — don't, unless debugging.
  Enforcement lives in `server/server.js` (~L423–446, the "REFUSING TO START"
  guard).

## Frontend architecture (server/public/app.js)

(For the CSS/shell layers around it, see "The three-layer frontend" above.)

One file. Read it top-to-bottom once; it's organized into sections
(`/* ===== ENGINEERS ===== */`, `ROLES`, `CONTAINERS`, `TASKS`, `SHELL`).

- **Router** — hash-based. `parseHash()` → `{view, agent}`. Routes: `#control`
  (Domain Control matrix), `#agents/<role>` (agent page), `#containers`, `#git`,
  `#tasks`. Legacy aliases: `#roles`→control, `#fleet`→agents/engineer.
  Navigate with `go(view, agent)`. `render()` dispatches to `renderControl` /
  `renderAgent` (→ `renderEngineers` for engineer, else `renderGenericAgent`) /
  `renderContainers` / `renderGit` / `renderTasks`, and sets
  `document.body.dataset.view` (CSS widens `[data-view="control"]`).
- **Smooth auto-refresh** — `FRESH` flag distinguishes a navigation/first-paint
  (show loading placeholders) from an in-place soft refresh (`softRender()`:
  `FRESH=false`, no flash). Each view guards `if (FRESH) app.innerHTML='loading…'`
  and ends with `if (!FRESH) applyUISnap()`. State that must survive a re-render
  is tagged: **`data-rk="<key>"`** preserves open/visible state (details rows,
  panels); **`data-rkh="<key>"`** preserves a lazily-filled element's innerHTML
  (expanded logs). `captureUI()`/`applyUISnap()` snapshot+restore those + scroll.
  Auto-refresh is user-configurable (on by default, interval presets) and
  **skips while a modal is open, an input is focused, or the tab is hidden**.
- **Self-update** — `checkVersion()` polls `/api/version`; on a new build it
  reloads when idle or shows the "Update ready" pill if you're mid-edit.
- **Live-follow logs** — `logFollowTick()` (every 3s) re-tails any open log
  surface (container log panels, agent-page log rows, the role-log modal),
  pinned-to-bottom only if already there. Mark them with `<span class="live-tag">live</span>`.
- **Helpers** — `$`/`$$` (scoped query), `esc()` (ALWAYS escape interpolated
  data — every value in a template literal goes through it), `api(method,url,body)`,
  `toast()`, `gdBusy(btn,on)`, `siteLink(site)` (links to `https://<site>`),
  `agentLabel(role)` (Title Case).

## Backend architecture (server/server.js + modules)

Routes are thin: validate → call a module → JSON. `requireSite` gates every
`:slug` route through `isKnownSite`. Errors carry `e.httpStatus`.

Key endpoints:

- `GET  /api/version` — asset fingerprint (self-update).
- `GET  /api/sites` — discovered site dir names.
- `GET  /api/fleet`, `/api/fleet/history?days=N` — engineer audit (delegates to
  `engineer-status.py --json`; **never re-derive tier/pulse/timeline logic in JS**).
- `POST /api/fleet/:slug/run` — run engineer now.
- `GET  /api/agents` — nav dropdown list (roles on ≥2 sites, engineer first).
- `GET  /api/roles` — the site × role matrix.
- `GET  /api/roles/:slug/:role/log` — tail a role's newest log.
- `POST /api/roles/:slug/:role/:action` — `pause` | `resume` (toggle
  `ops/.<role>-disabled`) | `run` (fire `run-worker.sh <role>`).
- `GET  /api/containers`, `POST /api/containers/restart-crons`,
  `POST /api/containers/:id/:action` (restart|stop|start),
  `GET /api/containers/:id/logs`, `POST /api/sites/:slug/bounce` (rebuild cron).
- `GET/POST/PUT/DELETE /api/git…`, `/api/tasks…`.

**Route ordering matters**: define specific paths BEFORE parameterized ones
(e.g. `/api/containers/restart-crons` before `/api/containers/:id/:action`).

### Load-bearing invariants / guardrails (don't regress these)

- **Container actions are repo-scoped.** `containers.assertDomains()` re-inspects
  a container's compose `working_dir` and refuses anything outside the domains
  repo. Any new container action MUST go through it.
- **Pause/resume & run are worker-role only.** Only roles invoked via
  `run-worker.sh <role>` honour `ops/.<role>-disabled`; `roles.setEnabled` /
  `run.runRole` reject non-worker roles (deployer/scraper/watchdog) with 400.
- **Disabled flags are tracked, conventionally-EMPTY files.** Pause writes an
  empty file (touch), never content — otherwise you create a spurious git diff a
  cron commits. Resume `unlink`s it.
- **Git commits are path-limited** (`git commit -- <paths>`) so the panel never
  sweeps unrelated staged work. Ignoring a *tracked* file needs an index commit
  (guarded against pre-staged changes) because a path-limited commit re-adds the
  working-tree file.
- **The engineer audit is owned by Python.** `audit.js` shells out to
  `tools/engineer-fleet/engineer-status.py`. The `timeline`/`coverage` fields and
  tier logic live there. Change them there, not in the dashboard.

## How to add things (the common tasks)

**Add a new agent page** — usually **zero dashboard work**. Any role scheduled
via `run-worker.sh <role>` on **≥2 sites** automatically: appears in `/api/agents`
→ the Agents dropdown, gets a generic agent page (overview of all sites + per-site
status, last-run, schedule, Logs, Pause/Resume, Run), and a Domain Control matrix
column that links to it. Only the **engineer** is special-cased to a rich page
(`renderEngineers`, backed by the pulse). To give another role a richer bespoke
page, branch it in `renderAgent()` like engineer.

**Add a new top-level tab/view**:
1. `index.html`: add `<button class="tab" data-view="myview">My View</button>`.
2. `app.js`: add `'myview'` to `TOP_VIEWS`, a case in `render()`, and a
   `renderMyView()` that respects `FRESH` and calls `applyUISnap()` when `!FRESH`.
3. Backend: add the route(s) in `server.js` + a module if non-trivial.

**Add an API endpoint**: put the logic in the relevant module (or a new one),
add a thin route in `server.js` (gate with `requireSite` for `:slug` routes),
throw errors with `e.httpStatus`. `restart panel`.

**Add a row action / button**: render the button with a `data-*` payload, wire
it after setting `innerHTML` (re-wire happens every render — that's why open
panels re-bind in the `applyUISnap` follow-up loop). Use `gdBusy()` for the
in-flight state and re-render the view in place on success.

## Domains tab — onboard/offboard, and the host-runner escape hatch

`#domains` (`server/domains.js` + `renderDomains()`) onboards and offboards
domains. It contains **zero domain logic**: every step already lives in
`tools/scripts/*.sh` behind `tools/scripts/domain-manager-cli.sh`
(`add` | `remove` | `status` | `repair` | `deploy` | `bind` | `email` |
`bootstrap`). Never reimplement a step of that flow in JS.

The panel **cannot run those scripts itself** — its container is root, has no
`gh`, no host nvm node, and a root-run `git submodule add` leaves root-owned
objects in the parent repo's `.git` (the known corruption mode). So it uses a
**spool + runner**:

```
POST /api/domains/jobs   → writes tools/fleet-dashboard/data/domain-jobs/<id>.json  (status: queued)
tools/scripts/domain-job-runner.sh  (tools/fleet-cron container, every minute, uid 1000, flock)
                         → runs domain-manager-cli.sh, output to <id>.log, patches the record
GET  /api/domains/jobs/:id → { job, log, truncated }   ← the UI tails this
```

The runner is **containerized** (2026-08-15, `tools/fleet-cron`), not a host
cron entry — see that tool's README.md. It got there because the host
crontab was the wrong place for it (not versioned, not reviewable, invisible
to this dashboard) same as five other fleet-level jobs; `domain-job-runner.sh`
no longer hard-codes a host nvm/pyenv/snap `PATH` — the container's image
provides node ≥ 22 + npm + `gh` directly.

- Job ids are **timestamp-prefixed** (`YYYYMMDD-HHMMSS-xxxxxx`) — the runner
  picks the next queued job by lexical glob order, so the id *is* the queue
  position. Don't change the id format without changing `next_queued()`.
- Records are always **written to a temp file and renamed**. The panel (root)
  and the runner (uid 1000) both rewrite the same file; only the rename works
  across that uid split, and it's also what keeps the poller from reading a
  half-written record.
- The runner polls for ~55s per cron tick, so a queued job starts in ~2s. A
  long bootstrap holds the flock; the next minute's tick just exits.
- **Both sides validate** command + flags + hostname against the same
  allowlist — the spool is a file-backed queue, so neither end trusts the other.
- One live job per domain (`enqueue` 409s otherwise): concurrent runs against
  the same zone is the one way this queue could do real damage.
- **Cancel is queued-only.** Killing a mid-flight CLI leaves the domain
  half-built; recover with Status/Repair instead.
- `runner()` surfaces heartbeat age so the UI says "the runner is down" rather
  than showing a silently stuck queue. If jobs sit in *queued*, check that the
  `fleet-cron` container is up (`docker exec fleet-cron id` → uid 1000) and
  that `tools/fleet-cron/crontab.docker` still has the `domain-job-runner.sh`
  line first.

Same pattern applies to **any** future dashboard action that needs host
identity, host toolchain, or a write to the parent repo's git: spool it, don't
`child_process` it from the panel.

## Verify before committing

Backend (fast, no browser):
```
cd tools/fleet-dashboard
node --check server/<changed>.js              # syntax
bin/fleet-dashboard restart                   # if server/*.js changed
FD_TOKEN="$(bin/fleet-dashboard token)"
curl -s -H "x-fd-token: $FD_TOKEN" http://127.0.0.1:4754/api/<endpoint> | python3 -m json.tool | head
```

Frontend (Playwright MCP): navigate with a **cache-bust** (`/?v=N#control`), then
`browser_evaluate` to assert structure/behaviour (tabs, dropdown, breadcrumbs,
row counts, a click→modal, live-follow re-tail). Screenshot only when layout
matters.

**Test mutations SAFELY — never incur real fleet cost in a test:**
- Run-now / pause-resume: exercise on an **already-paused** worker role —
  `run-worker.sh` sees the disabled flag and no-ops in ~2s (zero tokens). Do a
  **round-trip** (resume→pause, or pause→resume) so fleet state is unchanged.
- Restart-all-crons: verify ONE container restart end-to-end (StartedAt advances)
  and trust the loop; don't mass-bounce the live fleet as a test.
- Always verify the **guardrails** (out-of-repo container → 403, non-worker role
  → 400, unknown site → 404) — these are cheap and high-value.
- If you dirtied a tracked file during testing (e.g. a `.disabled` flag's
  content), restore it: `git -C sites/<site> checkout -- <path>`.

## Commit convention

- Stage **only** this tool: `git add tools/fleet-dashboard/` (the repo has many
  other in-flight changes — never `git add -A`).
- **Write the commit message to a file and use `git commit -F <file>`.** A repo
  hook (`deny-catastrophic.sh`) false-positives on some multi-line `-m`/heredoc
  messages; a message file avoids it. Avoid the literal token `--force` and `×`
  in the message.
- End the message with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Push to `main` (this repo commits directly to main; that's the established
  convention here). Jesse has standing approval to commit + push fleet-dashboard
  work periodically.
- Clean up screenshot artifacts before staging: `rm -rf .playwright-mcp`.

## Quick reference

```
Location   /home/jesse/projects/domains/tools/fleet-dashboard
URL        http://127.0.0.1:4754      Container: fleet-dashboard   Service: panel
Static edit   → just hard-refresh (self-updates)
Start/status  → tools/fleet-dashboard/bin/fleet-dashboard up|status
Server edit   → tools/fleet-dashboard/bin/fleet-dashboard restart
Token/rotate  → tools/fleet-dashboard/bin/fleet-dashboard token|rotate-token
Dockerfile    → cd tools/fleet-dashboard && docker compose --env-file ../../.env up -d --build
Logs          docker logs --tail 50 fleet-dashboard
Tabs       Domain Control(#control) · Agents▾(#agents/<role>) · Containers · Git · Tasks
```
