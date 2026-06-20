# Feature & Improvement Findings — tools/cron-manager

Generated: 2026-06-19 07:49:21
Scope: All layers — backend API, frontend UX, Docker/IaC, tests, ops ergonomics. Benchmarked against best-in-class cron management panels (Cronitor, Healthchecks.io, Grafana's scheduled panels).

## 🚀 Major — missing capabilities

- [ ] **[ux]** **"Run now" manual trigger** — no way to fire a job immediately outside its schedule; this is the most-needed feature during role development and debugging; would need a `POST /api/systems/:slug/jobs/:role/run` that `docker exec <container> bash ops/scripts/run-worker.sh <role>` in the background and streams output, same as rebuild does

- [ ] **[ux]** **Add new cron entry** — the UI only edits/removes/comments existing lines; there is no way to add a fresh cron line without manually editing the file on disk; an "Add job" sheet with the same inline editor (schedule picker + command input) would complete the CRUD surface

- [ ] **[ux]** **Cross-site flat job list / search** — with 40+ sites, finding a specific role requires scrolling through all cards in alphabetical site order; a "All jobs" tab or a top-bar search box that filters by site slug or role name would dramatically reduce navigation time

- [ ] **[ux]** **Next-fire countdown** — the schedule column shows the human description ("Every Monday at 6am") but not when the next fire is; computing `nextDate(expr)` client-side from the cron expression (cronstrue already parses the fields) and showing "in 4h 12m" next to the last-run cell would give operators a real-time sense of job cadence without running a cron-parser library server-side

## ⭐ High-impact improvements

- [ ] **[ux]** **Sort failed/stale containers to the top** — failed and stale cards appear in alphabetical position; with 40+ sites, a failing container at `ultrarough.com` is buried below `totaljerks.com`; float failed → stale → needs-rebuild cards before healthy ones in the `renderBanner` + DOM order

- [ ] **[ux]** **Page title + favicon badge for failure count** — `document.title = failed.length ? \`⚠ ${failed.length} failed — Cron Manager\` : 'Cron Manager'` is a one-liner that lets the operator see failures across browser tabs without returning to the page; add inside `renderBanner`

- [ ] **[ux]** **Search / filter card list** — with 40+ sites a single `<input placeholder="Filter sites…">` in the topbar that does `.card { display: none }` by slug prefix would eliminate scrolling; no server round-trip needed

- [ ] **[ux]** **Live log streaming (SSE)** — the log viewer fetches a static snapshot; watching a rebuild unfold requires manual "Reload" clicks; the rebuild stream already works over plain HTTP chunked — extend the same pattern to container logs via `docker logs -f --tail N` SSE endpoint so the log modal auto-updates without polling

- [ ] **[ux]** **Rebuild confirmation for running containers** — clicking "Rebuild & restart" on a running container with no warning is a disruptive action (kills and restarts the container, interrupting any in-flight job); a brief confirm dialog ("This will restart <container>, briefly interrupting running jobs. Continue?") prevents accidental triggers during peak hours

- [ ] **[ux]** **Job count summary in card header** — adding "3 on / 1 paused" to the card header allows scanning the fleet without opening each job table; currently all cards look identical from the top bar unless you know to look at the badge

- [ ] **[backend]** **`discoverSystems` short-lived cache** — a 2-second in-memory TTL cache on the discovery result would eliminate the event-loop-blocking sync FS scan on back-to-back or concurrent `/api/systems` requests (e.g. page open + auto-poll overlap) with no UX tradeoff; a `Map` keyed by `root` with a timestamp expiry is 8 lines of code

- [ ] **[backend]** **Distinct "docker unreachable" state in the API** — `inspectContainer` returns `state: 'unknown'` when the Docker daemon is unreachable, but the back-compat wrapper and effectively the badge both collapse this to "never-built" (grey); surfacing `unknown` as a distinct yellow/warning badge would help distinguish "container not yet built" from "can't reach Docker" — a useful signal when the daemon crashes

- [ ] **[frontend]** **Persist log tail and wrap preferences** — `logTail` resets to the `selected` default (400) and the wrap checkbox resets to unchecked every time the log modal opens; one `localStorage.getItem/setItem` call per preference preserves the operator's choices across modal opens and page refreshes

## ⚡ Quick wins

- [ ] **[frontend]** **Suppress auto-poll when diff modal is open** — one-liner fix to a confirmed medium bug: add `if (!$('#diffModal').classList.contains('hidden')) return;` in the poll tick callback — `server/public/app.js:451`

- [ ] **[frontend]** **"Copy schedule" button next to cron expression** — a small clipboard icon next to the `expr` span in the schedule cell lets the operator grab the raw cron string without opening the editor; `navigator.clipboard.writeText(e.schedule)` + the existing toast pattern

- [ ] **[frontend]** **"Last rebuild" log source auto-appears after rebuild** — after a successful rebuild the client stores the log in `clientRebuildLog` but the log source selector in the modal only refreshes when the modal is opened; clicking "View log" from the rebuild toast already opens to the right source — but opening Logs from the card footer shows the rebuild source only if `sys.logSources` already included it from the server; the client-side `clientRebuildLog` check in `openLogs` handles this already, so the UX is correct — but `logSources` should also include `rebuild` if the client has it, even on first modal open from a session that did a rebuild (it already does via the `if (clientRebuildLog.has…)` splice in `openLogs`) — **already correct; no action needed**

- [ ] **[frontend]** **Richer "needs rebuild" hint** — the current hint reads "crontab changed — rebuild to apply"; showing the gap ("crontab edited 3m ago, container built 2h ago") would help the operator decide urgency without having to open the diff — `sys.statusText` already contains the container age; `fileMtime` result could be returned in the API response for use client-side

- [ ] **[frontend]** **"Unknown" docker state badge distinct from "never-built"** — `inspectContainer` returns `state:'unknown'` on daemon error but the UI badge logic in `renderSystem` only has explicit handling for `running`, `stale`, and `failed`; `unknown` falls through to a grey "unknown" badge (same color as "never-built") — give `unknown` a yellow/warn badge to signal "something is wrong with Docker" vs "just not built yet"

- [ ] **[frontend]** **Log modal: auto-scroll toggle checkbox** — currently `out.scrollTop = out.scrollHeight` always jumps to the bottom after fetch; when re-reading historical logs the jump is disorienting; a "Auto-scroll" checkbox (default on) that conditionally skips the scroll would match the behavior of Grafana's and journalctl's log viewers

- [ ] **[frontend]** **Loading indicator during `/api/systems` refresh** — the 30-second auto-poll silently replaces all cards; if the fetch is slow (40+ docker ps calls) the page looks stale; a subtle spinner or "Refreshing…" state on the topbar "last updated" timestamp would give feedback that a poll is in flight

- [ ] **[docs]** **Document the `statusRunner` injection point in README** — `createApp({ statusRunner })` is the test seam that lets tests avoid shelling out to docker, but it's not mentioned anywhere outside the source code; a one-line note in the README under "Test" would help anyone writing integration tests for new endpoints

- [ ] **[tests]** **No test for the `rebuildCron` streaming path** — `rebuildCron` is the most complex function in docker.js (spawns a child process, streams output, resolves on close) but has zero test coverage; a fake-spawn test that emits chunks and closes with code 0/1 would catch regressions in the streaming + verdict line logic
