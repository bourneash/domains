# Fleet Analytics Plan 3 — Dashboard, seo-analyst Rewire, Dead Code Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the GA4/Search Console metrics landed in Plan 2 (`/metrics/*` on the data-hub
API, merged to `main` at `ba188e4`) in the Fleet Dashboard as an "Analytics" tab, rewire the
`seo-analyst` cron role to query real GSC data instead of its "Blocked on Jesse" escape hatch and
re-enable it on the 6 sites currently carrying `ops/.seo-analyst-disabled`, and delete the two
pieces of dead code the spec identified (`tools/auth-google/`, already superseded by
`tools/ga4-provision/src/ga4_provision/oauth.py`; and the site-tracker `search_consoles` no-op
stub).

**Architecture:** `tools/fleet-dashboard/server/analytics.js` is a thin degrade-never-throws HTTP
client for the data-hub `/metrics/*` endpoints, following the exact pattern already established by
`tools/fleet-dashboard/server/datahub.js`. `server.js` registers `/api/analytics/*` routes over it.
`public/app.js` gets one new `renderAnalytics()` view function (mirrors `renderDataHub()`) reusing
the existing `.dh-grid`/`.dh-panel` CSS — no new stylesheet needed. The `seo-analyst` role template
gets its GSC escape-hatch lines replaced with a real `curl` against the already-present
`DATAHUB_API` env var (same inline-curl convention the `affiliate-editor` archetype already uses).
Dead code removal is pure deletion — both replacements already exist and ship on `main`.

**Tech Stack:** Node.js (`node:test`, no framework, matching existing `*.test.js` files) for the
dashboard; the fleet's established `curl`-in-role-prompt convention (no new script) for
`seo-analyst`; Python/pytest for the one `site-tracker` test that references the deleted collector.

**IMPORTANT — branch base:** This plan branches from `main`, not from any older feature branch.
Plan 2 (the data-hub `/metrics/*` endpoints and tables this plan depends on) only exists on `main`
as of merge commit `ba188e4` — verify with `git log --oneline -1 main` before starting and create
your worktree/branch from `main`.

## Global Constraints

- Every data-hub client call must degrade to a safe empty shape on failure, never throw — this is
  the established convention in `datahub.js`/`datahub-images.js` and every route built on it.
- No new CSS file or class family for the Analytics tab — reuse `.dh-grid`, `.dh-panel`, `.dh-wide`,
  `.dh-b`/`.dh-ok`/`.dh-err`/`.dh-stale`/`.dh-skip`, `.dh-time`, `.dh-tag` etc. from
  `tools/fleet-dashboard/server/public/style.css:426-458`.
- `seo-analyst` must not gain a shared Python/Node script — GSC access goes through one inline
  `curl` in the role prompt, matching `tools/cron-roles/archetypes/affiliate-editor/role.md.tmpl:25`.
  `DATAHUB_API` is already injected into the `cron` container's environment (confirmed:
  `sites/americastrikes.com/docker-compose.yml:121`) — no compose changes needed on any site.
- Role-file rollouts stay deliberate, not automated (per house rule — no auto re-stamp tool). Use
  the existing `domains-cron-role-seo-analyst` skill's documented **maintain mode** (WIRING.md
  Steps 4, 10, 11 only) per site, one site at a time, reviewing the diff before commit.
- Absence-is-not-zero applies to the dashboard too: `/metrics/summary` omits `ga4`/`gsc` keys
  entirely when that source has no rows for the window — the client must render "no data", never a
  fabricated `0`.
- Dead code deletion only proceeds because the replacement already ships on `main`:
  `tools/ga4-provision/src/ga4_provision/oauth.py`'s docstring says it explicitly ports
  `tools/auth-google/setup.mjs`. Confirm this file exists on `main` before deleting
  `tools/auth-google/` (Task 4, Step 1) — do not delete first and verify after.

---

## File structure

```
tools/fleet-dashboard/server/
  analytics.js                 # new — data-hub /metrics/* HTTP client
  analytics.test.js            # new — unit tests (URL building, degrade, wow() math)
  server.js                    # modify — require + register /api/analytics/* routes
  public/index.html            # modify — add "Analytics" tab button
  public/app.js                # modify — TOP_VIEWS, render() dispatch, renderAnalytics()

tools/cron-roles/archetypes/seo-analyst/
  role.md.tmpl                 # modify — replace "Blocked on Jesse" GSC escape hatch with real pull

sites/<6 disabled sites>/ops/
  roles/seo-analyst.md         # refreshed via maintain-mode re-stamp (Task 3)
  .seo-analyst-disabled        # deleted (Task 3)

tools/auth-google/              # deleted entirely (Task 4)
package.json                    # modify — drop google-auth-library dependency
package-lock.json                # regenerated

tools/site-tracker/src/site_tracker/
  collectors/search_consoles.py  # deleted (Task 5)
  cli.py                          # modify — drop import + COLLECTORS entry
tools/site-tracker/tests/test_api_collectors.py  # modify — drop search_consoles assertions
tools/site-tracker/README.md                      # modify — drop stub-collector line
```

---

### Task 1: `analytics.js` — data-hub `/metrics/*` HTTP client

**Files:**
- Create: `tools/fleet-dashboard/server/analytics.js`
- Create: `tools/fleet-dashboard/server/analytics.test.js`

**Interfaces:**
- Consumes: data-hub `/metrics/ga4`, `/metrics/gsc`, `/metrics/summary`, `/metrics/top`,
  `/metrics/health` (contracts confirmed live on `main` at `tools/data-hub/src/datahub/api.py:180-259`).
- Produces: `health()`, `summary(site, window=28)`, `topGa4(site, metric, window=28, limit=10)`,
  `topGsc(site, metric, window=28, limit=10)`, `wow(site)` — all `async`, all return plain objects,
  never throw. `API` constant (same `DATAHUB_API` env var as `datahub.js`). Task 2 imports these by
  name.

- [ ] **Step 1: Write the failing tests**

```javascript
// tools/fleet-dashboard/server/analytics.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const an = require('./analytics');

test('health() returns the upstream body verbatim on success', async () => {
  global.fetch = async (url) => {
    assert.equal(url, `${an.API}/metrics/health`);
    return { ok: true, status: 200, json: async () => ({ sites: { 'x.com': {} }, generated_at: 't' }) };
  };
  const r = await an.health();
  assert.deepEqual(r, { sites: { 'x.com': {} }, generated_at: 't' });
});

test('health() degrades to {ok:false, sites:{}} when fetch rejects', async () => {
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const r = await an.health();
  assert.equal(r.ok, false);
  assert.deepEqual(r.sites, {});
  assert.match(r.error, /ECONNREFUSED/);
});

test('summary(site, window) builds the correct querystring', async () => {
  let calledUrl = null;
  global.fetch = async (url) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({ site: 'x.com', window_days: 7, has_data: false }) };
  };
  await an.summary('x.com', 7);
  assert.equal(calledUrl, `${an.API}/metrics/summary?site=x.com&window=7`);
});

test('summary() degrades to {has_data:false} on failure, never fabricates data', async () => {
  global.fetch = async () => { throw new Error('down'); };
  const r = await an.summary('x.com');
  assert.equal(r.ok, false);
  assert.equal(r.has_data, false);
});

test('topGa4(site, metric, window, limit) builds source=ga4 querystring', async () => {
  let calledUrl = null;
  global.fetch = async (url) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({ top: [] }) };
  };
  await an.topGa4('x.com', 'sessions', 28, 10);
  assert.equal(calledUrl, `${an.API}/metrics/top?site=x.com&source=ga4&metric=sessions&window=28&limit=10`);
});

test('topGsc(site, metric, window, limit) builds source=gsc querystring', async () => {
  let calledUrl = null;
  global.fetch = async (url) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({ top: [] }) };
  };
  await an.topGsc('x.com', 'clicks', 28, 5);
  assert.equal(calledUrl, `${an.API}/metrics/top?site=x.com&source=gsc&metric=clicks&window=28&limit=5`);
});

test('topGa4()/topGsc() degrade to {top:[]} on failure', async () => {
  global.fetch = async () => { throw new Error('down'); };
  const ga4 = await an.topGa4('x.com', 'sessions');
  const gsc = await an.topGsc('x.com', 'clicks');
  assert.deepEqual(ga4.top, []);
  assert.deepEqual(gsc.top, []);
});

test('_splitWeeks(records) splits the trailing 14 rows into two 7-row buckets by ascending date', () => {
  const records = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.UTC(2026, 6, 20 - i)).toISOString().slice(0, 10);
    records.push({ date: d, sessions: i });
  }
  const { cur, prev } = an._splitWeeks(records);
  assert.equal(cur.length, 7);
  assert.equal(prev.length, 7);
  assert.equal(cur[0].date < cur[6].date, true);
  assert.equal(prev[6].date < cur[0].date, true);
});

test('_splitWeeks(records) handles fewer than 14 rows without throwing', () => {
  const { cur, prev } = an._splitWeeks([{ date: '2026-07-01', sessions: 1 }]);
  assert.equal(cur.length, 1);
  assert.equal(prev.length, 0);
});

test('_sum(rows, keys) sums each key across rows, treating missing values as 0', () => {
  const rows = [{ sessions: 3, users: null }, { sessions: 4 }];
  const out = an._sum(rows, ['sessions', 'users']);
  assert.deepEqual(out, { sessions: 7, users: 0 });
});

test('wow(site) omits ga4/gsc keys entirely when that source has zero rows (absence is not zero)', async () => {
  global.fetch = async (url) => {
    if (url.includes('/metrics/ga4')) return { ok: true, status: 200, json: async () => ({ records: [] }) };
    return { ok: true, status: 200, json: async () => ({ records: [{ date: '2026-07-19', clicks: 5, impressions: 50 }] }) };
  };
  const r = await an.wow('x.com');
  assert.equal('ga4' in r, false);
  assert.equal('gsc' in r, true);
  assert.deepEqual(r.gsc.cur, { clicks: 5, impressions: 50 });
  assert.deepEqual(r.gsc.prev, { clicks: 0, impressions: 0 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd tools/fleet-dashboard && node --test server/analytics.test.js`
Expected: FAIL — `Cannot find module './analytics'`

- [ ] **Step 3: Write the implementation**

```javascript
// tools/fleet-dashboard/server/analytics.js
'use strict';

const API = process.env.DATAHUB_API || 'http://host.docker.internal:4760';

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

async function health() {
  const r = await _get('/metrics/health');
  return r.ok === false ? { ...r, sites: {} } : r;
}

async function summary(site, window = 28) {
  const r = await _get(`/metrics/summary?site=${encodeURIComponent(site)}&window=${encodeURIComponent(window)}`);
  return r.ok === false ? { ...r, has_data: false } : r;
}

async function topGa4(site, metric, window = 28, limit = 10) {
  const qs = `site=${encodeURIComponent(site)}&source=ga4&metric=${encodeURIComponent(metric)}&window=${encodeURIComponent(window)}&limit=${encodeURIComponent(limit)}`;
  const r = await _get(`/metrics/top?${qs}`);
  return r.ok === false ? { ...r, top: [] } : r;
}

async function topGsc(site, metric, window = 28, limit = 10) {
  const qs = `site=${encodeURIComponent(site)}&source=gsc&metric=${encodeURIComponent(metric)}&window=${encodeURIComponent(window)}&limit=${encodeURIComponent(limit)}`;
  const r = await _get(`/metrics/top?${qs}`);
  return r.ok === false ? { ...r, top: [] } : r;
}

async function _series(site, kind, days) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const r = await _get(`/metrics/${kind}?site=${encodeURIComponent(site)}&grain=site&since=${since}&limit=${days + 2}`);
  return r.ok === false ? { ...r, records: [] } : r;
}
async function ga4Series(site, days = 14) { return _series(site, 'ga4', days); }
async function gscSeries(site, days = 14) { return _series(site, 'gsc', days); }

// Split the trailing rows (assumed to already be a ~14-day window) into the
// most-recent 7-row bucket ("cur") and the 7 before it ("prev"), sorted
// ascending by date first. Rows past the trailing 14 are dropped rather than
// silently included in "prev" — callers control the window via the `days`
// argument passed to *Series above.
function _splitWeeks(records) {
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));
  const last14 = sorted.slice(-14);
  const cur = last14.slice(-7);
  const prev = last14.slice(0, Math.max(0, last14.length - 7));
  return { cur, prev };
}

function _sum(rows, keys) {
  const out = {};
  for (const k of keys) out[k] = rows.reduce((s, r) => s + (r[k] || 0), 0);
  return out;
}

const GA4_WOW_KEYS = ['sessions', 'users', 'new_users', 'views', 'conversions'];
const GSC_WOW_KEYS = ['clicks', 'impressions'];

// Week-over-week deltas for one site, computed from raw daily rows (not two
// overlapping /metrics/summary calls) so the two 7-day buckets never double-
// count a day. Absence is not zero: a source key is omitted entirely when
// that source returned zero rows for the trailing window, matching
// /metrics/summary's contract.
async function wow(site) {
  const [ga4, gsc] = await Promise.all([ga4Series(site, 14), gscSeries(site, 14)]);
  const out = { site };
  if (ga4.records && ga4.records.length) {
    const { cur, prev } = _splitWeeks(ga4.records);
    out.ga4 = { cur: _sum(cur, GA4_WOW_KEYS), prev: _sum(prev, GA4_WOW_KEYS) };
  }
  if (gsc.records && gsc.records.length) {
    const { cur, prev } = _splitWeeks(gsc.records);
    out.gsc = { cur: _sum(cur, GSC_WOW_KEYS), prev: _sum(prev, GSC_WOW_KEYS) };
  }
  return out;
}

module.exports = {
  health, summary, topGa4, topGsc, ga4Series, gscSeries, wow,
  _splitWeeks, _sum, API,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd tools/fleet-dashboard && node --test server/analytics.test.js`
Expected: PASS — all 11 tests green

- [ ] **Step 5: Commit**

```bash
git add tools/fleet-dashboard/server/analytics.js tools/fleet-dashboard/server/analytics.test.js
git commit -m "feat(fleet-dashboard): add data-hub /metrics/* client (analytics.js)"
```

---

### Task 2: Wire `/api/analytics/*` routes + Analytics tab UI

**Files:**
- Modify: `tools/fleet-dashboard/server/server.js`
- Modify: `tools/fleet-dashboard/server/public/index.html`
- Modify: `tools/fleet-dashboard/server/public/app.js`

**Interfaces:**
- Consumes: `analytics.js`'s `health`, `summary`, `topGa4`, `topGsc`, `wow` (Task 1). Existing
  globals in `app.js`: `api(method, url, body)` (`app.js:16`), `esc(s)` (`app.js:5`),
  `siteLink(site)` (`app.js:12`), `$`/`$$` DOM helpers, `FRESH`, `applyUISnap()`, `discoverSites`
  (server-side, via `/api/sites`, to populate the site picker).
- Produces: nothing consumed by a later task — this is the UI leaf.

- [ ] **Step 1: Register the routes**

In `tools/fleet-dashboard/server/server.js`, add the require alongside the other route modules
(after line 18, `const datahub = require('./datahub');`):

```javascript
const analytics = require('./analytics');
```

Then add a new route block immediately after the existing `// Data Hub routes` block (after the
`app.get('/api/datahub/matrix', ...)` handler, before the `// Data Hub Images routes` comment):

```javascript
  // Analytics routes — GA4 + Search Console metrics, proxied from the data-hub
  // /metrics/* endpoints (tools/data-hub/src/datahub/api.py). Same degrade-to-200
  // convention as /api/datahub/* above.
  app.get('/api/analytics/health', async (_req, res) => res.json(await analytics.health()));
  app.get('/api/analytics/summary', async (req, res) => {
    const window = Math.max(1, Math.min(parseInt(req.query.window, 10) || 28, 400));
    res.json(await analytics.summary(req.query.site, window));
  });
  app.get('/api/analytics/top', async (req, res) => {
    const window = Math.max(1, Math.min(parseInt(req.query.window, 10) || 28, 400));
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 10, 50));
    const fn = req.query.source === 'gsc' ? analytics.topGsc : analytics.topGa4;
    res.json(await fn(req.query.site, req.query.metric, window, limit));
  });
  app.get('/api/analytics/wow', async (req, res) => res.json(await analytics.wow(req.query.site)));
```

- [ ] **Step 2: Add the tab button**

In `tools/fleet-dashboard/server/public/index.html`, insert after the "Data Hub Images" button
(after line 27):

```html
      <button class="tab" data-view="analytics">Analytics</button>
```

- [ ] **Step 3: Register the view in `app.js`**

In `tools/fleet-dashboard/server/public/app.js`, update `TOP_VIEWS` (line 2127):

```javascript
const TOP_VIEWS = ['control', 'cron', 'containers', 'git', 'tasks', 'taskbudget', 'datahub', 'datahubimages', 'analytics'];
```

Add a dispatch branch after `else if (STATE.view === 'datahubimages') renderDataHubImages();`
(line 2185):

```javascript
  else if (STATE.view === 'analytics') renderAnalytics();
```

- [ ] **Step 4: Write `renderAnalytics()`**

Add this function immediately after `renderDataHub()`/`dhToggleSource()` (after line ~1918, before
the `/* ===== DATA HUB IMAGES ===== */` comment). It keeps module-level state for the currently
selected site so re-renders (auto-refresh) don't reset the picker:

```javascript
/* ===== ANALYTICS ===== */

let ANALYTICS_SITE = null; // persists across soft-refreshes

function anDelta(cur, prev) {
  if (!prev) return '';
  const pct = prev === 0 ? (cur > 0 ? 100 : 0) : Math.round(((cur - prev) / prev) * 100);
  const cls = pct > 0 ? 'dh-ok' : pct < 0 ? 'dh-err' : '';
  const sign = pct > 0 ? '+' : '';
  return ` <span class="dh-b ${cls}">${sign}${pct}% WoW</span>`;
}

async function renderAnalytics() {
  const app = $('#app');
  if (FRESH) app.innerHTML = '<div class="muted">loading analytics…</div>';

  const sitesResp = await api('GET', '/api/sites');
  const sites = (sitesResp && sitesResp.sites) || sitesResp || [];
  const siteNames = sites.map((s) => (typeof s === 'string' ? s : s.domain || s.name)).filter(Boolean).sort();
  if (!ANALYTICS_SITE || !siteNames.includes(ANALYTICS_SITE)) ANALYTICS_SITE = siteNames[0] || null;

  const health = await api('GET', '/api/analytics/health');
  const healthSites = (health && health.sites) || {};

  const healthRows = Object.keys(healthSites).sort().map((site) => {
    const s = healthSites[site] || {};
    const stateCell = (st) => {
      if (!st) return '<span class="dh-b dh-skip">no data</span>';
      const cls = st.stale ? 'dh-stale' : (st.status || '').startsWith('ok') ? 'dh-ok' : 'dh-err';
      return `<span class="dh-b ${cls}">${esc(st.status || 'unknown')}</span> <span class="dh-time">${esc((st.last_fetch_at || '').replace('T', ' ').slice(0, 19) || '—')}</span>`;
    };
    const gate = s.consent_gated ? ' <span class="dh-ovr" title="gated behind explicit visitor consent — reports only consented traffic, reads lower than reality">consent-gated</span>' : '';
    return `<tr><td>${siteLink(site)}${gate}</td><td>${stateCell(s.ga4)}</td><td>${stateCell(s.gsc)}</td></tr>`;
  }).join('');
  const healthHtml = `
    <table class="dh-sources">
      <thead><tr><th>site</th><th>GA4</th><th>Search Console</th></tr></thead>
      <tbody>${healthRows || '<tr><td colspan="3" class="muted">no sites</td></tr>'}</tbody>
    </table>`;

  let detailHtml = '<div class="muted">select a site</div>';
  if (ANALYTICS_SITE) {
    const [summary, wow, topPages, topQueries] = await Promise.all([
      api('GET', `/api/analytics/summary?site=${encodeURIComponent(ANALYTICS_SITE)}&window=28`),
      api('GET', `/api/analytics/wow?site=${encodeURIComponent(ANALYTICS_SITE)}`),
      api('GET', `/api/analytics/top?site=${encodeURIComponent(ANALYTICS_SITE)}&source=ga4&metric=sessions&window=28&limit=10`),
      api('GET', `/api/analytics/top?site=${encodeURIComponent(ANALYTICS_SITE)}&source=gsc&metric=clicks&window=28&limit=10`),
    ]);

    let summaryHtml;
    if (!summary || summary.has_data === false) {
      summaryHtml = '<div class="muted">no data captured yet for this site</div>';
    } else {
      const ga4Line = 'sessions' in summary
        ? `<div>sessions <b>${esc(String(summary.sessions))}</b>${wow.ga4 ? anDelta(wow.ga4.cur.sessions, wow.ga4.prev.sessions) : ''} · users <b>${esc(String(summary.users))}</b> · conversions <b>${esc(String(summary.conversions))}</b></div>`
        : '<div class="muted">no GA4 data</div>';
      const gscLine = 'clicks' in summary
        ? `<div>clicks <b>${esc(String(summary.clicks))}</b>${wow.gsc ? anDelta(wow.gsc.cur.clicks, wow.gsc.prev.clicks) : ''} · impressions <b>${esc(String(summary.impressions))}</b></div>`
        : '<div class="muted">no Search Console data</div>';
      summaryHtml = `${ga4Line}${gscLine}<div class="dh-sub-h">trailing 28 days</div>`;
    }

    const topRows = (label, rows, metric) => (rows.top || []).map((r) =>
      `<tr><td class="dh-host">${esc(r.dim_key)}</td><td><b>${esc(String(r[metric] ?? 0))}</b></td></tr>`
    ).join('') || `<tr><td colspan="2" class="muted">no ${label} data</td></tr>`;

    detailHtml = `
      <section class="dh-panel" data-rk="an-summary"><h3>${siteLink(ANALYTICS_SITE)} — Summary</h3>${summaryHtml}</section>
      <section class="dh-panel" data-rk="an-pages"><h3>Top Pages (sessions)</h3>
        <table class="dh-datasets"><thead><tr><th>page</th><th>sessions</th></tr></thead>
        <tbody>${topRows('page', topPages, 'sessions')}</tbody></table></section>
      <section class="dh-panel" data-rk="an-queries"><h3>Top Queries (clicks)</h3>
        <table class="dh-datasets"><thead><tr><th>query</th><th>clicks</th></tr></thead>
        <tbody>${topRows('query', topQueries, 'clicks')}</tbody></table></section>`;
  }

  const picker = `<select id="an-site-picker">${siteNames.map((s) => `<option value="${esc(s)}" ${s === ANALYTICS_SITE ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>`;

  app.innerHTML = `
    <div class="dh-grid">
      <section class="dh-panel dh-wide" data-rk="an-health"><h3>Capture Freshness — all sites</h3>${healthHtml}</section>
      <section class="dh-panel dh-wide" data-rk="an-picker">${picker}</section>
      ${detailHtml}
    </div>`;

  const picked = $('#an-site-picker');
  if (picked) picked.addEventListener('change', () => { ANALYTICS_SITE = picked.value; softRender(); });

  if (!FRESH) applyUISnap();
}
```

- [ ] **Step 5: Manual verification (no automated DOM test exists for this codebase's view
  functions — `renderDataHub()` has none either; verify by running the dashboard)**

```bash
cd tools/fleet-dashboard && npm start
```

Open `http://127.0.0.1:4754`, click the "Analytics" tab. Expected: the freshness table renders
(showing `no data` badges is fine if `collect-metrics` hasn't run against live GA4/GSC data yet —
that's the correct absence-not-zero behavior, not a bug); switching the site picker re-renders the
detail panels without a full page reload.

- [ ] **Step 6: Commit**

```bash
git add tools/fleet-dashboard/server/server.js tools/fleet-dashboard/server/public/index.html tools/fleet-dashboard/server/public/app.js
git commit -m "feat(fleet-dashboard): add Analytics tab surfacing GA4/GSC metrics"
```

---

### Task 3: `seo-analyst` rewire — real GSC pull, re-enable on 6 sites

**Files:**
- Modify: `tools/cron-roles/archetypes/seo-analyst/role.md.tmpl`
- Modify (per-site, via skill): `sites/{aliencouncil,americastrikes,saveusfarms,ultrarough,weapontester,xxxtea}.com/ops/roles/seo-analyst.md`
- Delete (per-site): `sites/{aliencouncil,americastrikes,saveusfarms,ultrarough,weapontester,xxxtea}.com/ops/.seo-analyst-disabled`

**Interfaces:**
- Consumes: `DATAHUB_API` env var (already injected into every site's `cron` container —
  confirmed `sites/americastrikes.com/docker-compose.yml:121`), data-hub `/metrics/summary` and
  `/metrics/gsc` endpoints (Task 1's contract, no new dashboard dependency here).
- Produces: nothing consumed by a later task.

- [ ] **Step 1: Replace the GSC escape hatch in the archetype**

In `tools/cron-roles/archetypes/seo-analyst/role.md.tmpl`, replace workflow step 1 (lines 41-44):

```markdown
1. **GSC pull:** last 7 days — top queries, top pages, indexing coverage, any spikes or drops.
   Identify the top opportunity-zone queries: positions 5–20 (existing rankings with quick
   improvement potential). Log if GSC credentials are not yet available ("Blocked on Jesse
   — GSC verification pending") and move on.
```

with:

```markdown
1. **GSC pull:** query the data hub directly — it already collects GA4 + Search Console daily
   (`tools/data-hub`, `/metrics/*`). `DATAHUB_API` is pre-set in this container's environment.
   ```bash
   curl -s "${DATAHUB_API}/metrics/summary?site={{BASE_URL_HOST}}&window=7"
   curl -s "${DATAHUB_API}/metrics/gsc?site={{BASE_URL_HOST}}&grain=query&since=$(date -u -d '7 days ago' +%F)&limit=200"
   ```
   `{{BASE_URL_HOST}}` is `{{BASE_URL}}` with the `https://` scheme stripped (the hub keys
   captures by bare host). From the query-grain response, rank by `clicks`/`impressions` to find
   top movers and opportunity-zone queries (position 5–20). If `/metrics/summary` responds
   `"has_data": false` or the `gsc` key is entirely absent from its response, this site is not
   yet verified for Search Console — log "GSC not yet verified for this site (see
   /metrics/health)" and move on. Do not fabricate a zero-traffic report; absence of data is not
   the same as zero traffic.
```

Add the new placeholder to the front-matter-equivalent placeholder list. In
`tools/cron-roles/archetypes/seo-analyst/meta.yml`, update line 18:

```yaml
placeholders: [SITE_NAME, BASE_URL, BASE_URL_HOST, MODEL, SLACK_CHANNEL_VAR, SLACK_CHANNEL_DEFAULT]
```

and add its detection rule after the `BASE_URL` entry (after line 21):

```yaml
  BASE_URL_HOST: "BASE_URL with the https:// scheme stripped, e.g. example.com"
```

Then replace the "Blocked on Jesse" line in the weekly report template (line 86):

```markdown
[If GSC is not yet verified for this site: "GSC not yet verified — see /metrics/health."]
```

- [ ] **Step 2: Commit the archetype change**

```bash
git add tools/cron-roles/archetypes/seo-analyst/role.md.tmpl tools/cron-roles/archetypes/seo-analyst/meta.yml
git commit -m "fix(cron-roles): seo-analyst pulls real GSC data via data-hub, drops Blocked-on-Jesse escape hatch"
```

- [ ] **Step 3: Re-stamp the 6 disabled sites (maintain mode) — one at a time**

For each of `aliencouncil.com`, `americastrikes.com`, `saveusfarms.com`, `ultrarough.com`,
`weapontester.com`, `xxxtea.com`:

```bash
cd sites/<site>
```

Invoke the `domains-cron-role-seo-analyst` skill for this site. Per the skill's own maintain-mode
note (`.claude/skills/domains-cron-role-seo-analyst/SKILL.md:40-41`), because
`ops/roles/seo-analyst.md` already exists here, it runs WIRING.md **Steps 4, 10, 11 only** (refresh
body from the archetype + re-verify sibling awareness) — it will not touch any operator edits
outside the templated body. Review the diff before committing:

```bash
git diff ops/roles/seo-analyst.md
```

Expected: the diff touches only the GSC-pull workflow step and the "Blocked on Jesse" report-
template line — confirm no unrelated content moved. Then:

```bash
git add ops/roles/seo-analyst.md
git commit -m "fix(seo-analyst): refresh role body — real GSC pull via data-hub"
git push
```

- [ ] **Step 4: Remove the kill-switch marker on each of the 6 sites**

Still per-site:

```bash
git rm ops/.seo-analyst-disabled
git commit -m "chore(seo-analyst): re-enable — GSC data now available via data-hub"
git push
```

- [ ] **Step 5: Verify no drift remains**

```bash
cd /home/jesse/projects/domains && bash tools/cron-roles/check-disabled-drift.sh | grep -i seo-analyst
```

Expected: no rows (the script is report-only and lists standing disabled markers — after Step 4 on
all 6 sites, none remain for `seo-analyst`).

---

### Task 4: Delete `tools/auth-google/`

**Files:**
- Delete: `tools/auth-google/setup.mjs`
- Delete: `tools/auth-google/test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json` (regenerated, not hand-edited)

**Interfaces:** None — leaf cleanup, nothing in this repo imports `tools/auth-google/`.

- [ ] **Step 1: Confirm the replacement exists on `main` before deleting anything**

```bash
git show main:tools/ga4-provision/src/ga4_provision/oauth.py | head -5
```

Expected: a docstring mentioning it ports `tools/auth-google/setup.mjs`. Do not proceed to Step 2
if this file is missing or the docstring doesn't confirm the port.

- [ ] **Step 2: Confirm zero inbound references before deleting**

```bash
grep -rl "auth-google" --include="*.md" --include="*.json" --include="*.mjs" --include="*.js" --include="*.py" --include="*.sh" . | grep -v "^\./tools/auth-google/"
```

Expected output: only doc files (`docs/superpowers/plans/2026-07-18-*.md`,
`docs/superpowers/specs/2026-07-18-*.md`) — historical record, safe to leave as-is. If any
non-doc file appears here, stop and investigate before deleting.

- [ ] **Step 3: Delete the directory**

```bash
git rm -r tools/auth-google
```

- [ ] **Step 4: Drop the now-unused dependency**

In `package.json`, remove the `google-auth-library` dependency (it was used only by
`tools/auth-google/test.mjs` — confirmed via
`grep -rl google-auth-library --include='*.json' --include='*.mjs' --include='*.js' .` returning
only `package.json`/`package-lock.json`/the now-deleted `test.mjs`):

```json
{
  "devDependencies": {
    "prettier": "^3",
    "prettier-plugin-astro": "^0.14"
  },
```

(i.e. delete the `"dependencies": { "google-auth-library": "^10.7.0" }` block entirely — if
`devDependencies` was already the next top-level key, the file now starts directly with it.)

- [ ] **Step 5: Regenerate the lockfile**

```bash
npm install
```

Expected: `package-lock.json` updates to drop `google-auth-library` and its transitive deps; no
other dependency changes.

- [ ] **Step 6: Commit**

```bash
git add -A tools/auth-google package.json package-lock.json
git commit -m "chore: delete tools/auth-google — superseded by tools/ga4-provision oauth.py"
```

---

### Task 5: Delete the site-tracker `search_consoles` stub collector

**Files:**
- Delete: `tools/site-tracker/src/site_tracker/collectors/search_consoles.py`
- Modify: `tools/site-tracker/src/site_tracker/cli.py`
- Modify: `tools/site-tracker/tests/test_api_collectors.py`
- Modify: `tools/site-tracker/README.md`

**Interfaces:** None — leaf cleanup.

- [ ] **Step 1: Update the failing-first test — drop the stub's assertions**

In `tools/site-tracker/tests/test_api_collectors.py`, change `test_collectors_page_lists_all_known`
(lines 28-32) to drop `"search_consoles"` from the expected list:

```python
def test_collectors_page_lists_all_known(client):
    r = client.get("/collectors")
    assert r.status_code == 200
    for name in ("filesystem", "http_scrape", "cloudflare", "github"):
        assert name in r.text
```

Delete `test_post_run_returns_200_and_starts` (lines 40-47) entirely — it only exercised the stub
collector's `run()` endpoint.

- [ ] **Step 2: Run the test suite to verify the still-present test fails against old code**

Run: `cd tools/site-tracker && python -m pytest tests/test_api_collectors.py -v`
Expected: `test_collectors_page_lists_all_known` still PASSes (the assertion just got looser), but
this confirms the suite runs clean before the deletion. This step exists to establish a baseline,
not to prove a red state — the deletion itself is what Step 3 verifies.

- [ ] **Step 3: Delete the collector and its registration**

```bash
git rm tools/site-tracker/src/site_tracker/collectors/search_consoles.py
```

In `tools/site-tracker/src/site_tracker/cli.py`, remove line 20 (`    search_consoles,` from the
`from site_tracker.collectors import (...)` block) and line 30
(`    "search_consoles": search_consoles,` from the `COLLECTORS` dict):

```python
from site_tracker.collectors import (
    amazon,
    canary,
    cloudflare,
    filesystem,
    github,
    http_scrape,
    recipes,
)

COLLECTORS = {
    "canary":          canary,
    "filesystem":      filesystem,
    "http_scrape":     http_scrape,
    "cloudflare":      cloudflare,
    "github":          github,
    "recipes":         recipes,
    "amazon":          amazon,
}
```

- [ ] **Step 4: Drop the stale README line**

In `tools/site-tracker/README.md`, delete line 69
(`- Google Search Console / Bing Webmaster — \`collect_search_consoles\` is a v2 stub.`).

- [ ] **Step 5: Run the full site-tracker test suite**

Run: `cd tools/site-tracker && python -m pytest -v`
Expected: PASS, zero references to `search_consoles` remaining
(`grep -rn search_consoles tools/site-tracker/` returns nothing).

- [ ] **Step 6: Commit**

```bash
git add tools/site-tracker/src/site_tracker/cli.py tools/site-tracker/tests/test_api_collectors.py tools/site-tracker/README.md
git commit -m "chore(site-tracker): delete search_consoles no-op stub collector"
```

---

## Final whole-branch check

After all 5 tasks:

```bash
cd tools/fleet-dashboard && npm test
cd ../data-hub && python -m pytest -q
cd ../site-tracker && python -m pytest -q
```

Expected: all green. Then confirm the 6 re-enabled sites show no `check-disabled-drift.sh` rows for
`seo-analyst` (Task 3, Step 5) and that `git log --oneline -8` shows one commit per task plus the
per-site seo-analyst commits, ready for `superpowers:finishing-a-development-branch`.
