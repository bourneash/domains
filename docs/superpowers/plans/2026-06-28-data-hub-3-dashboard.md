# Data Hub — Plan 3: Fleet Dashboard "Data Hub" Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. NOTE: the fleet-dashboard has NO pytest suite — verification is `curl` (backend) and Playwright MCP `browser_evaluate` (frontend), not unit tests. Each task ends with concrete verification commands.

**Goal:** Add a "Data Hub" tab to the Fleet Dashboard (localhost:4754) that surfaces the hub's live VPN health, the outbound connection (egress) ledger, per-source freshness, dataset inventory, and the source×site subscription matrix — giving Jesse one pane to see *what is being collected, from where, over which path, and who consumes it*.

**Architecture:** A thin backend module `server/datahub.js` fetches the hub API (`http://host.docker.internal:4760`, env-overridable) for live health/egress/sources/datasets and reads `tools/data-hub/registry/*.yaml` (already on the bind-mounted repo, via the existing `js-yaml` dep) to compute the source×site matrix. New `/api/datahub/*` routes expose these. The SPA gets a `Data Hub` tab and a `renderDataHub()` view with five panels, following the dashboard's existing FRESH/softRender/applyUISnap/esc patterns. The dashboard container gains `extra_hosts: host-gateway` so it can reach the host-published hub API.

**Tech Stack:** Node 22 (global `fetch`), Express, js-yaml, vanilla-JS SPA. No build step.

## Global Constraints

- Dashboard lives at `tools/fleet-dashboard`, served at `http://127.0.0.1:4754`. Backend = `server/server.js` + modules; frontend = single-file SPA `server/public/app.js` + `index.html` + `style.css`. NO framework, NO build step.
- Deploy mechanics: static edits (`server/public/*`) are live on refresh; `server/*.js` edits need `docker compose restart panel`; Dockerfile/compose/dep changes need `docker compose up -d --build` (or `up -d` for a compose-only change).
- The hub API is published at host `127.0.0.1:4760`. From inside the dashboard container it is reachable as `http://host.docker.internal:4760` ONLY after adding `extra_hosts: ["host.docker.internal:host-gateway"]` to the dashboard's compose. Make the base URL env-configurable: `DATAHUB_API` (default `http://host.docker.internal:4760`).
- The hub may be DOWN (containers stopped). Every backend call must degrade gracefully: a short timeout (~3s) and a shaped `{ ok: false, error }` response, never a 500 that breaks the tab. The frontend shows a clear "hub unreachable" state, not a crash.
- Registry files read directly from disk: `tools/data-hub/registry/sources.yaml` and `subscriptions.yaml` (absolute: under `FD_DOMAINS_ROOT`). Use the existing `js-yaml`.
- Frontend invariants (do NOT regress): every interpolated value goes through `esc()`; `renderDataHub()` guards `if (FRESH) app.innerHTML = 'loading…'` and calls `applyUISnap()` when `!FRESH`; state that must survive soft-refresh is tagged `data-rk`; auto-refresh already skips while a modal is open / input focused / tab hidden. Reuse `api()`, `$`, `$$`, `esc()`, `toast()`, `siteLink()`.
- Route ordering in server.js: specific paths before parameterized. (All `/api/datahub/*` here are static — no `:param` — so just group them.)
- Read-only tab: it displays hub data; it does NOT mutate hub state. No write endpoints in this plan.
- Commit convention: stage ONLY `git add tools/fleet-dashboard/`; commit via `git commit -F <msgfile>` (a repo hook false-positives on some multi-line `-m`); end message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; remove `.playwright-mcp/` artifacts before staging. Push to main.

---

## File Structure

```
tools/fleet-dashboard/
  docker-compose.yml          # MODIFY: add extra_hosts host-gateway + DATAHUB_API env
  server/
    datahub.js                # NEW: hub API client (health/egress/sources/datasets) + matrix from yaml
    server.js                 # MODIFY: mount /api/datahub/* routes
    public/
      index.html              # MODIFY: add the Data Hub tab button
      app.js                  # MODIFY: TOP_VIEWS + render() case + renderDataHub() (5 panels) + auto-refresh
      style.css               # MODIFY: Data Hub panel styles (badges, matrix grid, egress table)
```

**Responsibilities:** `datahub.js` is the only new backend module — all hub I/O + matrix computation live there; routes stay thin. `renderDataHub()` is one cohesive view function composed of five panel sub-renderers.

---

### Task 1: Backend — `datahub.js` module, routes, container host access

**Files:**
- Create: `tools/fleet-dashboard/server/datahub.js`
- Modify: `tools/fleet-dashboard/server/server.js`
- Modify: `tools/fleet-dashboard/docker-compose.yml`

**Interfaces:**
- Produces (in `datahub.js`, CommonJS like the other modules):
  - `async health()` → hub `/health` JSON, or `{ ok:false, error }` on failure.
  - `async egress(limit=60)` → `{ events:[...] }` or `{ ok:false, error, events:[] }`.
  - `async sources()` → `{ sources:[...] }` or `{ ok:false, error, sources:[] }`.
  - `async datasets()` → `{ datasets:[...] }` or `{ ok:false, error, datasets:[] }`.
  - `matrix()` → `{ sites:[...], rss:[{site, tags, matched_sources:[ids]}], datasets:[{site, keys:[]}], sources:[{id,tags,type,policy,exit}] }` computed from the two registry YAMLs (sync disk read; no hub dependency — works even when the hub is down).
- Routes in server.js: `GET /api/datahub/health`, `/api/datahub/egress`, `/api/datahub/sources`, `/api/datahub/datasets`, `/api/datahub/matrix`.

- [ ] **Step 1: Create `server/datahub.js`**

```javascript
'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const API = process.env.DATAHUB_API || 'http://host.docker.internal:4760';
const ROOT = process.env.FD_DOMAINS_ROOT || `${process.env.HOME || '/home/jesse'}/projects/domains`;
const REG = path.join(ROOT, 'tools', 'data-hub', 'registry');

async function _get(pathname, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${API}${pathname}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`hub ${pathname} → HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function health() { return _get('/health'); }
async function egress(limit = 60) {
  const r = await _get(`/egress?limit=${encodeURIComponent(limit)}`);
  return r.ok === false ? { ...r, events: [] } : r;
}
async function sources() {
  const r = await _get('/sources');
  return r.ok === false ? { ...r, sources: [] } : r;
}
async function datasets() {
  const r = await _get('/datasets');
  return r.ok === false ? { ...r, datasets: [] } : r;
}

function _loadYaml(file, key) {
  try {
    const doc = yaml.load(fs.readFileSync(path.join(REG, file), 'utf8')) || {};
    return doc[key] || (key === 'subscriptions' ? {} : []);
  } catch (e) {
    return key === 'subscriptions' ? {} : [];
  }
}

// Build the source×site matrix purely from the registry on disk (hub-independent).
function matrix() {
  const srcList = _loadYaml('sources.yaml', 'sources');
  const subs = _loadYaml('subscriptions.yaml', 'subscriptions');
  const sources = srcList.map((s) => ({
    id: s.id, tags: s.tags || [], type: s.type || 'rss',
    policy: s.policy || 'vpn', exit: s.exit || 'any',
  }));
  const sites = Object.keys(subs).sort();
  const rss = [];
  const datasets = [];
  for (const site of sites) {
    const sub = subs[site] || {};
    const items = sub.items || {};
    const any = items.tags_any || [];
    const all = items.tags_all || [];
    const matched = sources
      .filter((s) => s.type === 'rss')
      .filter((s) => {
        const t = s.tags;
        const anyOk = any.length ? any.some((x) => t.includes(x)) : false;
        const allOk = all.length ? all.every((x) => t.includes(x)) : false;
        return anyOk || allOk;
      })
      .map((s) => s.id);
    rss.push({ site, tags_any: any, tags_all: all, matched_sources: matched });
    datasets.push({ site, keys: sub.datasets || [] });
  }
  return { sites, sources, rss, datasets };
}

module.exports = { health, egress, sources, datasets, matrix, API };
```

- [ ] **Step 2: Mount routes in `server/server.js`**

Find where other modules are required (top of file) and add:
```javascript
const datahub = require('./datahub');
```
Find where other routes are defined and add this group (these are all static paths, no `:param`):
```javascript
app.get('/api/datahub/health', async (_req, res) => res.json(await datahub.health()));
app.get('/api/datahub/egress', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 60, 300);
  res.json(await datahub.egress(limit));
});
app.get('/api/datahub/sources', async (_req, res) => res.json(await datahub.sources()));
app.get('/api/datahub/datasets', async (_req, res) => res.json(await datahub.datasets()));
app.get('/api/datahub/matrix', (_req, res) => {
  try { res.json(datahub.matrix()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
```

- [ ] **Step 3: Add container host access in `docker-compose.yml`**

Under the `panel` service, add `extra_hosts` and the `DATAHUB_API` env (alongside the existing `environment:` keys):
```yaml
    environment:
      FD_DOMAINS_ROOT: ${HOME:-/home/jesse}/projects/domains
      FD_HOST: 0.0.0.0
      HOME: ${HOME:-/home/jesse}
      DATAHUB_API: http://host.docker.internal:4760
    extra_hosts:
      - "host.docker.internal:host-gateway"
```
(Keep all existing `environment` keys; just add `DATAHUB_API`. Add the `extra_hosts` block at the service level.)

- [ ] **Step 4: Syntax-check, redeploy, and verify**

```bash
cd /home/jesse/projects/domains/tools/fleet-dashboard
node --check server/datahub.js
node --check server/server.js
# compose changed (extra_hosts + env) → recreate the container
docker compose up -d
sleep 3
# hub is up from Plans 1-2; expect real data:
curl -s http://127.0.0.1:4754/api/datahub/health | python3 -m json.tool | head -20
curl -s "http://127.0.0.1:4754/api/datahub/egress?limit=4" | python3 -c "import sys,json; [print(e['exit_node'], e['exit_ip'], e['status'], e['policy'], e['target_host']) for e in json.load(sys.stdin)['events']]"
curl -s http://127.0.0.1:4754/api/datahub/datasets | python3 -m json.tool | head
curl -s http://127.0.0.1:4754/api/datahub/matrix | python3 -c "import sys,json; d=json.load(sys.stdin); print('sites:', d['sites']); print('sources:', len(d['sources'])); [print(r['site'], '→', len(r['matched_sources']), 'rss', d['datasets'][i]['keys']) for i,r in enumerate(d['rss'])]"
```
Expected: `/health` shows `nodes.us`/`nodes.eu` real public IPs (NOT 172.30.x, NOT home IPs); `/egress` shows recent fetches with real exit IPs; `/matrix` lists the 5 sites with their matched RSS source counts + dataset keys. (To prove graceful-degrade: `docker stop datahub-api && curl -s .../api/datahub/health` → `{ "ok": false, "error": ... }`, NOT a 500; then `docker start datahub-api`.)

- [ ] **Step 5: Commit**

```bash
cd /home/jesse/projects/domains
printf '%s\n' "feat(fleet-dashboard): data-hub API client + /api/datahub routes + host access" "" "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" > /tmp/dh-msg-1.txt
git add tools/fleet-dashboard/server/datahub.js tools/fleet-dashboard/server/server.js tools/fleet-dashboard/docker-compose.yml
git commit -F /tmp/dh-msg-1.txt
```

---

### Task 2: Frontend — the Data Hub tab + `renderDataHub()` (five panels)

**Files:**
- Modify: `tools/fleet-dashboard/server/public/index.html`
- Modify: `tools/fleet-dashboard/server/public/app.js`
- Modify: `tools/fleet-dashboard/server/public/style.css`

**Interfaces:**
- Consumes the `/api/datahub/*` routes from Task 1.
- Produces: a `Data Hub` tab routing to `#datahub`, and `renderDataHub()` rendering five panels: (1) VPN Health, (2) Outbound Connection Ledger (egress), (3) Source Freshness, (4) Datasets, (5) Source×Site Matrix.

- [ ] **Step 1: Add the tab button in `index.html`**

After the `tasks` tab button, add:
```html
      <button class="tab" data-view="datahub">Data Hub</button>
```

- [ ] **Step 2: Register the view in `app.js`**

Add `'datahub'` to `TOP_VIEWS`:
```javascript
const TOP_VIEWS = ['control', 'cron', 'containers', 'git', 'tasks', 'datahub'];
```
Add a dispatch case in `render()` (after the `tasks` case):
```javascript
  else if (STATE.view === 'datahub') renderDataHub();
```

- [ ] **Step 3: Implement `renderDataHub()` in `app.js`** (add a new `/* ===== DATA HUB ===== */` section)

```javascript
/* ===== DATA HUB ===== */

function dhBadge(status) {
  const s = String(status || '');
  let cls = 'dh-b';
  if (s === 'ok') cls += ' dh-ok';
  else if (s.startsWith('skipped')) cls += ' dh-skip';
  else if (s === 'error' || s.startsWith('error')) cls += ' dh-err';
  return `<span class="${cls}">${esc(s || '—')}</span>`;
}

function dhPathBadge(policy, exitNode) {
  if (policy === 'direct') return `<span class="dh-path dh-direct">direct</span>`;
  return `<span class="dh-path dh-vpn">vpn:${esc(exitNode || '?')}</span>`;
}

async function renderDataHub() {
  if (FRESH) app.innerHTML = '<div class="muted">loading data hub…</div>';
  const [health, eg, src, ds, mtx] = await Promise.all([
    api('GET', '/api/datahub/health'),
    api('GET', '/api/datahub/egress?limit=80'),
    api('GET', '/api/datahub/sources'),
    api('GET', '/api/datahub/datasets'),
    api('GET', '/api/datahub/matrix'),
  ]);

  const hubDown = health && health.ok === false;
  const HOME_IPS = ['24.55.143.75', '158.173.25.169'];

  // ---- Panel 1: VPN Health ----
  let healthHtml;
  if (hubDown) {
    healthHtml = `<div class="dh-down">⚠ Data hub API unreachable — ${esc(health.error || 'is the datahub-api container running?')}</div>`;
  } else {
    const nodes = health.nodes || {};
    const nodeCell = (name, ip) => {
      const leak = ip && HOME_IPS.includes(ip);
      const cls = !ip ? 'dh-err' : leak ? 'dh-err' : 'dh-ok';
      const label = !ip ? 'down' : leak ? `${esc(ip)} ⚠ LEAK` : esc(ip);
      return `<div class="dh-node"><span class="dh-node-name">${esc(name)}</span> <span class="dh-b ${cls}">${label}</span></div>`;
    };
    healthHtml = `
      <div class="dh-health">
        ${nodeCell('US exit', nodes.us)}
        ${nodeCell('EU exit', nodes.eu)}
        <div class="dh-counts">items <b>${esc(String((health.counts || {}).items ?? '—'))}</b> · skipped <b>${esc(String((health.counts || {}).skipped ?? '—'))}</b></div>
      </div>`;
  }

  // ---- Panel 2: Outbound Connection Ledger ----
  const events = (eg && eg.events) || [];
  const egRows = events.map((e) => `
    <tr>
      <td class="dh-time">${esc((e.ts || '').replace('T', ' ').slice(0, 19))}</td>
      <td>${esc(e.source_id || '')}</td>
      <td class="dh-host">${esc(e.target_host || '')}</td>
      <td>${dhPathBadge(e.policy, e.exit_node)}</td>
      <td class="dh-ip">${esc(e.exit_ip || '—')}</td>
      <td>${dhBadge(e.status)}</td>
      <td class="dh-note">${esc(e.note || '')}</td>
    </tr>`).join('');
  const egressHtml = `
    <table class="dh-egress">
      <thead><tr><th>when</th><th>source</th><th>target</th><th>path</th><th>exit IP</th><th>status</th><th>note</th></tr></thead>
      <tbody>${egRows || '<tr><td colspan="7" class="muted">no egress events yet</td></tr>'}</tbody>
    </table>`;

  // ---- Panel 3: Source Freshness ----
  const srcs = (src && src.sources) || [];
  const srcRows = srcs.map((s) => {
    const st = (s.state || {});
    const stale = st.stale ? ' · <span class="dh-stale">stale</span>' : '';
    return `<tr>
      <td>${esc(s.id)}</td>
      <td>${esc(s.type)}</td>
      <td>${dhBadge(st.status)}${stale}</td>
      <td class="dh-time">${esc((st.last_fetch_at || '').replace('T', ' ').slice(0, 19) || '—')}</td>
    </tr>`;
  }).join('');
  const srcHtml = `
    <table class="dh-sources">
      <thead><tr><th>source</th><th>type</th><th>status</th><th>last fetch</th></tr></thead>
      <tbody>${srcRows || '<tr><td colspan="4" class="muted">no source state</td></tr>'}</tbody>
    </table>`;

  // ---- Panel 4: Datasets ----
  const dss = (ds && ds.datasets) || [];
  const dsRows = dss.map((d) => `<tr>
    <td>${esc(d.dataset_key)}</td><td>${esc(String(d.count))}</td>
    <td class="dh-time">${esc((d.latest_observed_at || '').replace('T', ' ').slice(0, 19))}</td>
  </tr>`).join('');
  const dsHtml = `
    <table class="dh-datasets">
      <thead><tr><th>dataset</th><th>rows</th><th>latest</th></tr></thead>
      <tbody>${dsRows || '<tr><td colspan="3" class="muted">no datasets</td></tr>'}</tbody>
    </table>`;

  // ---- Panel 5: Source×Site Matrix ----
  let matrixHtml = '<div class="muted">no matrix</div>';
  if (mtx && mtx.sites) {
    const rssRows = (mtx.rss || []).map((r) =>
      `<tr><td>${siteLink(r.site)}</td><td><b>${esc(String(r.matched_sources.length))}</b> sources</td><td class="dh-tags">${(r.tags_any || []).map((t) => `<span class="dh-tag">${esc(t)}</span>`).join('')}</td></tr>`
    ).join('');
    const dsRows2 = (mtx.datasets || []).filter((d) => d.keys.length).map((d) =>
      `<tr><td>${siteLink(d.site)}</td><td class="dh-tags">${d.keys.map((k) => `<span class="dh-tag dh-dskey">${esc(k)}</span>`).join('')}</td></tr>`
    ).join('');
    matrixHtml = `
      <div class="dh-matrix-sub">RSS subscriptions (by tag)</div>
      <table class="dh-matrix"><tbody>${rssRows}</tbody></table>
      <div class="dh-matrix-sub">Dataset subscriptions</div>
      <table class="dh-matrix"><tbody>${dsRows2 || '<tr><td class="muted">none</td></tr>'}</tbody></table>`;
  }

  app.innerHTML = `
    <div class="dh-grid">
      <section class="dh-panel" data-rk="dh-health"><h3>VPN Health</h3>${healthHtml}</section>
      <section class="dh-panel dh-wide" data-rk="dh-egress"><h3>Outbound Connection Ledger <span class="live-tag">live</span></h3>${egressHtml}</section>
      <section class="dh-panel" data-rk="dh-sources"><h3>Source Freshness</h3>${srcHtml}</section>
      <section class="dh-panel" data-rk="dh-datasets"><h3>Datasets</h3>${dsHtml}</section>
      <section class="dh-panel dh-wide" data-rk="dh-matrix"><h3>Source × Site Matrix</h3>${matrixHtml}</section>
    </div>`;

  if (!FRESH) applyUISnap();
}
```

- [ ] **Step 4: Add styles in `style.css`** (append a Data Hub block, using existing CSS vars)

```css
/* ===== Data Hub ===== */
.dh-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.dh-panel { background: var(--panel, #161a22); border: 1px solid var(--border, #2a2f3a); border-radius: 8px; padding: 12px 14px; }
.dh-panel h3 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted, #8a93a6); }
.dh-wide { grid-column: 1 / -1; }
.dh-down { color: #ffb454; padding: 8px 0; }
.dh-health { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; }
.dh-node-name { color: var(--muted, #8a93a6); margin-right: 6px; }
.dh-counts { color: var(--muted, #8a93a6); margin-left: auto; }
.dh-b { padding: 1px 7px; border-radius: 10px; font-size: 12px; font-weight: 600; }
.dh-ok { background: rgba(74,222,128,.14); color: #4ade80; }
.dh-skip { background: rgba(250,204,21,.14); color: #facc15; }
.dh-err { background: rgba(248,113,113,.16); color: #f87171; }
.dh-path { padding: 1px 7px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.dh-vpn { background: rgba(96,165,250,.16); color: #60a5fa; }
.dh-direct { background: rgba(167,139,250,.16); color: #a78bfa; }
.dh-egress, .dh-sources, .dh-datasets, .dh-matrix { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.dh-egress th, .dh-sources th, .dh-datasets th { text-align: left; color: var(--muted,#8a93a6); font-weight: 500; padding: 4px 8px; border-bottom: 1px solid var(--border,#2a2f3a); }
.dh-egress td, .dh-sources td, .dh-datasets td, .dh-matrix td { padding: 4px 8px; border-bottom: 1px solid rgba(255,255,255,.04); }
.dh-time, .dh-ip { font-family: ui-monospace, monospace; color: var(--muted,#8a93a6); }
.dh-host { font-family: ui-monospace, monospace; }
.dh-note { color: var(--muted,#8a93a6); }
.dh-stale { color: #facc15; font-size: 11px; }
.dh-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.dh-tag { background: rgba(255,255,255,.06); border-radius: 4px; padding: 0 6px; font-size: 11px; }
.dh-dskey { background: rgba(96,165,250,.14); color: #60a5fa; }
.dh-matrix-sub { color: var(--muted,#8a93a6); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin: 10px 0 4px; }
.dh-egress tbody tr:hover, .dh-sources tbody tr:hover { background: rgba(255,255,255,.03); }
@media (max-width: 980px) { .dh-grid { grid-template-columns: 1fr; } }
```

- [ ] **Step 5: Deploy (static — no rebuild) and verify with Playwright MCP**

Static files are live immediately. Drive the page with a cache-bust URL and assert structure:
```
browser_navigate → http://127.0.0.1:4754/?v=p3#datahub
browser_evaluate:
  () => {
    const tabActive = document.querySelector('.tab[data-view="datahub"]').classList.contains('active');
    const panels = [...document.querySelectorAll('.dh-panel h3')].map(h => h.textContent.trim());
    const egressRows = document.querySelectorAll('.dh-egress tbody tr').length;
    const nodes = [...document.querySelectorAll('.dh-node')].map(n => n.textContent.trim());
    const matrixRows = document.querySelectorAll('.dh-matrix tbody tr').length;
    return { tabActive, panels, egressRows, nodes, matrixRows };
  }
```
Expected: `tabActive=true`; `panels` includes "VPN Health", "Outbound Connection Ledger", "Source Freshness", "Datasets", "Source × Site Matrix"; `egressRows > 0` with real data; `nodes` shows US/EU exit IPs (no "LEAK"); `matrixRows > 0` (the 5 sites). Take one screenshot for layout sanity. Remove `.playwright-mcp/` after.

- [ ] **Step 6: Commit**

```bash
cd /home/jesse/projects/domains
printf '%s\n' "feat(fleet-dashboard): Data Hub tab — health, egress ledger, freshness, datasets, source×site matrix" "" "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" > /tmp/dh-msg-2.txt
rm -rf tools/fleet-dashboard/.playwright-mcp
git add tools/fleet-dashboard/server/public/index.html tools/fleet-dashboard/server/public/app.js tools/fleet-dashboard/server/public/style.css
git commit -F /tmp/dh-msg-2.txt
```

---

### Task 3: Egress live-follow + end-to-end verification

**Files:**
- Modify: `tools/fleet-dashboard/server/public/app.js` (auto-refresh coverage for the egress ledger)

**Interfaces:** Ensures the Data Hub view participates in the dashboard's existing soft auto-refresh so the egress ledger stays current without a manual reload.

- [ ] **Step 1: Confirm auto-refresh covers the Data Hub view**

The dashboard's auto-refresh calls `softRender()` which re-dispatches `render()` for the current view. Because `renderDataHub()` already re-fetches all `/api/datahub/*` on every call and guards on `FRESH`, it auto-refreshes for free. VERIFY this is true by reading the auto-refresh tick code (search `softRender` / the interval in app.js) and confirming it calls `render()` for ALL `TOP_VIEWS` (not a hardcoded subset). If the tick is gated to specific views, add `'datahub'` to that gate. Report what you found; only edit if a gate excludes datahub.

- [ ] **Step 2: Verify live-follow end to end (Playwright MCP)**

```
1. browser_navigate → http://127.0.0.1:4754/?v=p3b#datahub ; wait for .dh-egress.
2. browser_evaluate → capture first egress row's "when"+source text and row count.
3. From a shell (outside the browser): trigger a fresh hub collect so new egress rows appear:
   docker compose --env-file /home/jesse/projects/domains/.env -f /home/jesse/projects/domains/tools/data-hub/docker-compose.yml exec -T collector python -m datahub collect
4. Wait for the dashboard auto-refresh interval (or click the Data Hub tab again), then browser_evaluate again.
5. Assert the egress ledger updated (new top row timestamp ≥ the previous, or row content changed) WITHOUT a full page reload.
```
Expected: the ledger reflects the new collect cycle on the next soft-refresh — proving the "live" tag is truthful. Also confirm: switching to another tab and back preserves no broken state; the hub-down path renders the warning (optional: `docker stop datahub-api`, refresh tab, see "unreachable", `docker start datahub-api`).

- [ ] **Step 3: Final structure assertion + screenshot**

```
browser_evaluate → assert all 5 panels present, egress has the path badges (vpn:us / direct) and real exit IPs, matrix shows all 5 sites with non-empty subscriptions, datasets panel lists the keyless dataset keys (ephemeris, quakes, launches, kindex, solar-xrays, weather-alerts).
```
Take a final screenshot. Remove `.playwright-mcp/`.

- [ ] **Step 4: Commit (only if Step 1 required an edit; else skip)**

```bash
cd /home/jesse/projects/domains
printf '%s\n' "fix(fleet-dashboard): include Data Hub view in auto-refresh tick" "" "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" > /tmp/dh-msg-3.txt
git add tools/fleet-dashboard/server/public/app.js
git commit -F /tmp/dh-msg-3.txt
```

---

## Self-Review

**Spec coverage (vs design doc "Health → Fleet Dashboard" section):**
- Per-source last-fetch + freshness (stale flagged) → Task 2 Panel 3. ✓
- VPN exit IPs + killswitch state; fail-closed skip list → Task 2 Panel 1 (nodes + leak warning) + the egress `skipped` rows. ✓
- Outbound connection ledger ("what went where, over which path, when") → Task 2 Panel 2 (egress table with path badge + exit IP + time). ✓
- Rendered source×site matrix → Task 2 Panel 5 (RSS-by-tag + dataset subscriptions). ✓
- Item/dataset counts → Task 2 Panel 1 counts + Panel 4 datasets. ✓
- Live → Task 3 (auto-refresh coverage + the `live` tag verified truthful). ✓

**Placeholder scan:** No TBD/TODO. Task 3 Step 1/4 are conditional-on-finding (edit only if the auto-refresh tick excludes datahub) with explicit instructions — not an open placeholder.

**Consistency:** Backend route names (`/api/datahub/{health,egress,sources,datasets,matrix}`) match between Task 1 (definition) and Task 2 (consumption). `matrix()` output shape (`sites/sources/rss/datasets`) defined in Task 1 and consumed in Task 2 Panel 5. The egress event fields (`ts, source_id, target_host, policy, exit_node, exit_ip, status, note`) match the hub's `/egress` schema from Plan 1. The graceful-degrade contract (`{ok:false,error}`) is produced in Task 1 and handled in Task 2 (`hubDown`).

**Note for the controller:** the dashboard has no pytest harness — Task verification is `curl` (Task 1) and Playwright MCP `browser_evaluate` (Tasks 2-3). Implementer subagents need Playwright MCP tools (general-purpose agents have them). Deploy nuance: Task 1's compose change needs `docker compose up -d`; Tasks 2-3 are static (`server/public/*`) and live on refresh — no restart.
```
