'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s =>
  String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

let STATE = {
  view: 'control',
  agent: null,
  agentPage: null,
  sites: [],
  agents: [],
  taskSite: null,
  siteSlug: null,
  gitSlug: null,
  gitTab: 'operations',
  controlFilter: null,
  controlSort: null,
};
let AGENT_HEALTH = null;
let ACCESS_LEVEL = 'operator';
let ROUTE_EPOCH = 0;
class StaleRouteError extends Error {
  constructor() {
    super('route changed while data was loading');
    this.name = 'StaleRouteError';
  }
}
function routeIs(view, agent = undefined, agentPage = undefined) {
  return (
    STATE.view === view &&
    (agent === undefined || STATE.agent === agent) &&
    (agentPage === undefined || (STATE.agentPage || null) === agentPage)
  );
}
const EXEC_RUN = { poller: null };
const EXEC_RUN_UI = {
  q: '',
  status: 'all',
  sort: 'started_at',
  dir: -1,
  page: 1,
  pageSize: 25,
  selected: null,
};
const EXEC_INBOX = { browserNotified: false };
const EXEC_INBOX_UI = { q: '', status: 'all', page: 1, pageSize: 10 };
const EXEC_CASE_UI = { q: '', state: 'all', selected: null };
const CN_FILTER = { q: '', status: 'all', kind: 'all' };
const DEPLOY_FILTER = { q: '', status: 'all' };
const GIT_FILTER = { q: '', status: 'all' };
const GH_FILTER = { q: '' };
const GH_PAGE_SIZE = 50;
let GH_PAGE = 1;
let GH_FILTER_TIMER = null;
// Route/bootstrap changes can trigger two renders close together (for example
// when the live stream opens while the initial hash is settling). Reuse the
// same short-lived read rather than starting a second identical fan-out.
let EXECUTIVE_LOAD_CACHE = null;
let EXECUTIVE_DRAFT_SAVE_TIMER = null;

function notifyExecutiveBrowser(notifications = []) {
  if (EXEC_INBOX.browserNotified || !notifications.length || !('Notification' in window)) return;
  EXEC_INBOX.browserNotified = true;
  let unseen;
  try {
    unseen = notifications.filter(
      item => !localStorage.getItem(`fd-executive-notification:${item.notification_id}`)
    );
    unseen
      .slice(0, 3)
      .forEach(item =>
        localStorage.setItem(`fd-executive-notification:${item.notification_id}`, '1')
      );
  } catch {
    unseen = notifications;
  }
  if (!unseen.length) return;
  if (Notification.permission === 'granted') {
    try {
      new Notification(
        unseen.length === 1 ? unseen[0].title : `${unseen.length} executive updates`,
        {
          body:
            unseen.length === 1
              ? unseen[0].body
              : 'Open the Executive page to review the latest responses.',
        }
      );
    } catch {}
  }
}

function pollExecutiveRun() {
  if (EXEC_RUN.poller) return;
  const tick = async () => {
    EXEC_RUN.poller = null;
    if (
      !['executive', 'agent'].includes(STATE.view) ||
      (STATE.view === 'agent' && STATE.agent !== 'executive')
    )
      return;
    try {
      const status = await api('GET', '/api/executive/run-status');
      if (status.active) {
        EXEC_RUN.poller = setTimeout(tick, 5000);
      } else {
        softRender();
      }
    } catch {
      EXEC_RUN.poller = setTimeout(tick, 8000);
    }
  };
  EXEC_RUN.poller = setTimeout(tick, 1500);
}

function agentLabel(role) {
  if (String(role) === 'update') return 'Editorial updates';
  if (String(role) === 'product-manager-fleet') return 'PM · Fleet tooling';
  if (String(role) === 'product-manager-sites') return 'PM · Managed sites';
  const acronyms = { ai: 'AI', ceo: 'CEO', cfo: 'CFO', cro: 'CRO', cto: 'CTO', seo: 'SEO' };
  return String(role)
    .split('-')
    .map(w => acronyms[w.toLowerCase()] || w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// The agents endpoint has returned both a bare array and an envelope
// ({ agents: [...] }) across dashboard versions. Keep the shared navigation
// state iterable so a response-shape change cannot interrupt the whole SPA.
function normalizeAgentList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.agents)) return value.agents;
  return [];
}

function executiveActorLabel(actor) {
  if (String(actor) === 'researcher') return 'CRO';
  if (String(actor) === 'product-manager-fleet') return 'PM · Fleet tooling';
  if (String(actor) === 'product-manager-sites') return 'PM · Managed sites';
  return ['CEO', 'CTO', 'CFO'].includes(String(actor || '').toUpperCase())
    ? String(actor).toUpperCase()
    : agentLabel(actor);
}

// The site dir name is the live domain — link straight to it (new tab).
function siteLink(site) {
  return `<span class="site-link-wrap"><a class="site-link" href="https://${esc(site)}" target="_blank" rel="noopener noreferrer" title="Open https://${esc(site)}">${esc(site)}<span class="ext">↗</span></a><a class="site-console-link" href="#site/${encodeURIComponent(site)}" title="Open ${esc(site)} command center" aria-label="Open ${esc(site)} command center">⌘</a></span>`;
}

// F5: quick-links to the other portfolio tools that operate on this same site —
// site-tracker's per-site detail page (:4742/site/<slug>) and the
// domain-developer sandboxed dev panel (:7777/, no per-site deep link exists
// there today so it just opens the panel root).
function toolLinks(site) {
  const s = encodeURIComponent(site);
  return (
    `<span class="tool-links">` +
    `<a href="http://127.0.0.1:4742/site/${s}" target="_blank" rel="noopener noreferrer" title="Open ${esc(site)} in site-tracker">tracker↗</a>` +
    `<a href="http://127.0.0.1:7777/" target="_blank" rel="noopener noreferrer" title="Open the domain-developer panel">dev↗</a>` +
    `</span>`
  );
}

// Shared dot-legend chip (used by the Domain Control, Containers, and Deploys
// tally headers) — a colored .rdot swatch (reusing the role-matrix state
// colors: fresh=green, overdue=red, paused=gray) followed by a label.
function dotLegend(st, txt) {
  return `<span class="rdot r-${st}"></span> ${txt}`;
}

// F6: fleet-wide site filter (topbar input). Any row rendered with
// data-fleet-row + data-site="<slug>" is shown/hidden as the operator types.
// Re-applied at the end of every view that opts in, since a re-render replaces
// the DOM (and any hidden state on it).
function applyFleetFilter() {
  const input = $('#fleet-filter');
  const q = (STATE.view === 'builds' ? CF_BUILDS.filter : (input && input.value) || '')
    .trim()
    .toLowerCase();
  const clear = $('#fleet-filter-clear');
  if (clear) clear.hidden = !q;
  const rows = $$('[data-fleet-row]');
  rows.forEach(el => {
    const site = (el.dataset.site || '').toLowerCase();
    el.classList.toggle('fleet-hidden', Boolean(q) && !site.includes(q));
  });
  const count = $('#fleet-filter-count');
  if (count) {
    const visible = rows.filter(row => !row.classList.contains('fleet-hidden')).length;
    count.textContent = q
      ? `${visible}/${rows.length} rows`
      : rows.length
        ? `${rows.length} rows`
        : '';
    count.setAttribute(
      'aria-label',
      q ? `${visible} of ${rows.length} matching rows` : 'All rows shown'
    );
    if (STATE.view === 'builds' && CF_BUILDS.cache?.data && q) {
      const datasets = [
        CF_BUILDS.cache.data.byRepo || [],
        CF_BUILDS.cache.data.builds || [],
        CF_BUILDS.cache.data.triggers || [],
      ];
      const matching = datasets.reduce(
        (total, rows) =>
          total +
          rows.filter(row =>
            String(row.repo || '')
              .toLowerCase()
              .includes(q)
          ).length,
        0
      );
      count.textContent = `${matching} matching records`;
      count.setAttribute('aria-label', `${matching} matching records across Build Usage registers`);
    }
  }
  globalThis.updateTaskBudgetPagination?.();
}

function clearFleetFilter() {
  const input = $('#fleet-filter');
  if (!input) return;
  input.value = '';
  try {
    localStorage.removeItem('fd.fleet-filter');
  } catch {}
  if (STATE.view === 'builds') {
    CF_BUILDS.filter = '';
    CF_BUILDS.pages = { repos: 1, builds: 1, triggers: 1 };
    clearTimeout(CF_BUILDS.filterTimer);
    renderCloudflareBuilds();
  } else applyFleetFilter();
  input.focus();
}

// Any URL that reaches an href must be proven http(s) first. Stored profile
// URLs are already scheme-checked server-side, but a custom platform's
// urlTemplate is operator-supplied, so `javascript:` could otherwise reach the
// DOM through the derived link. esc() stops attribute-breakout, not the scheme.
function safeHref(u) {
  try {
    const p = new URL(u, location.origin);
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.href : '';
  } catch {
    return '';
  }
}

const API_TIMEOUT_MS = 60000;
async function api(method, url, body) {
  const requestEpoch = ROUTE_EPOCH;
  const opt = { method, headers: {} };
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeout = setTimeout(() => controller?.abort(), API_TIMEOUT_MS);
  if (controller) opt.signal = controller.signal;
  if (body !== undefined) {
    opt.headers['content-type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  try {
    const r = await fetch(url, opt);
    if (r.status === 401) {
      showLogin();
      throw new Error('authentication required');
    }
    const txt = await r.text();
    let data;
    try {
      data = txt ? JSON.parse(txt) : null;
    } catch {
      data = txt;
    }
    if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
    if (requestEpoch !== ROUTE_EPOCH) throw new StaleRouteError();
    return data;
  } catch (e) {
    if (e?.name === 'AbortError')
      throw new Error(`Request timed out after ${API_TIMEOUT_MS / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// Optional panels must never hold an entire view hostage. Keep the primary
// dashboard usable when an auxiliary collector is slow, offline, or being
// restarted; the panel can simply render its empty state for this refresh.
function apiOptional(method, url, fallback, timeoutMs = 2500) {
  const requestEpoch = ROUTE_EPOCH;
  return Promise.race([
    api(method, url),
    new Promise(resolve => setTimeout(() => resolve(fallback), timeoutMs)),
  ])
    .then(value => {
      if (requestEpoch !== ROUTE_EPOCH) throw new StaleRouteError();
      return value;
    })
    .catch(error => {
      // A stale/rotated browser session must not look like a healthy empty
      // dataset. `api()` has already opened the login overlay for 401s; let the
      // error propagate so the caller cannot render misleading zero counts.
      if (error?.message === 'authentication required' || error?.name === 'StaleRouteError')
        throw error;
      return fallback;
    });
}

/* ---- auth gate (F1) ---- */
function showLogin() {
  const o = $('#login-overlay');
  if (o) o.classList.remove('hidden');
  const t = $('#login-token');
  if (t) t.focus();
}
function hideLogin() {
  const o = $('#login-overlay');
  if (o) o.classList.add('hidden');
}
async function submitLogin(e) {
  e.preventDefault();
  const err = $('#login-err');
  if (err) err.textContent = '';
  const token = ($('#login-token') || {}).value || '';
  try {
    await api('POST', '/api/login', { token }); // sets the httpOnly cookie on success
    hideLogin();
    location.reload(); // re-fetch everything now that we're authed
  } catch (ex) {
    if (err)
      err.textContent = ex.message === 'authentication required' ? 'Invalid token' : ex.message;
  }
}

function toast(msg, kind = 'ok') {
  const t = $('#toast');
  if (!t) return;
  toast._queue ||= [];
  const item = { msg: String(msg ?? ''), kind: kind === 'err' || kind === 'error' ? 'err' : 'ok' };
  const tail = toast._queue[toast._queue.length - 1];
  if (toast._active && tail?.msg === item.msg && tail?.kind === item.kind) return;
  toast._queue.push(item);
  toast._queue = toast._queue.slice(-5);
  toast._next();
}
toast._next = function () {
  const t = $('#toast');
  if (!t || toast._active || !toast._queue?.length) return;
  const item = toast._queue.shift();
  const message = $('#toast-message', t) || t;
  message.textContent = item.msg;
  t.className = `toast show ${item.kind}`;
  toast._active = true;
  clearTimeout(toast._t);
  toast._t = setTimeout(toast._dismiss, 3200);
};
toast._dismiss = function () {
  const t = $('#toast');
  if (!t) return;
  clearTimeout(toast._t);
  toast._active = false;
  t.className = 'toast';
  toast._next();
};
globalThis.fleetToast = toast;

function applyAccessLevel(level) {
  ACCESS_LEVEL = level === 'viewer' ? 'viewer' : 'operator';
  document.body.dataset.access = ACCESS_LEVEL;
  const actions = $('.actions');
  if (!actions) return;
  const badge = $('.access-badge', actions) || document.createElement('span');
  if (!badge.parentNode) {
    badge.className = 'access-badge';
    actions.insertBefore(badge, actions.firstChild);
  }
  badge.className = `access-badge ${ACCESS_LEVEL === 'viewer' ? 'is-viewer' : 'is-operator'}`;
  badge.textContent = ACCESS_LEVEL === 'viewer' ? 'Read-only' : 'Operator';
  badge.title =
    ACCESS_LEVEL === 'viewer'
      ? 'Viewer credential: mutations are disabled'
      : 'Operator credential: mutations enabled';
  actions.insertBefore(badge, actions.firstChild);
}

function stamp() {
  const updated = $('#updated');
  if (updated) {
    updated.textContent = 'Updated ' + new Date().toLocaleTimeString();
    updated.dataset.state = 'fresh';
    updated.title = 'Latest successful dashboard refresh';
  }
  $('#app')?.setAttribute('aria-busy', 'false');
  $$('[data-fd-stale-transient]').forEach(banner => banner.remove());
}

// Keep the last usable page visible during background refresh failures. A
// transient API outage should not erase filters, expanded rows, or an active
// operator workflow; the next successful render removes this notice via stamp().
function isStaleRouteError(message) {
  return (
    message instanceof StaleRouteError ||
    message?.name === 'StaleRouteError' ||
    (typeof message === 'string' && message.includes('route changed while data was loading'))
  );
}

function renderViewError(target, message) {
  if (isStaleRouteError(message)) return;
  if (!target) return;
  $('#app')?.setAttribute('aria-busy', 'false');
  const text = String(message || 'The view could not be refreshed.');
  const updated = $('#updated');
  if (updated) {
    updated.dataset.state = FRESH ? 'error' : 'stale';
    updated.title = FRESH
      ? 'The latest dashboard refresh failed'
      : 'Showing the last successful dashboard refresh';
  }
  if (!FRESH && target.firstElementChild) {
    target.querySelector('[data-fd-stale-transient]')?.remove();
    const banner = document.createElement('div');
    banner.className = 'fd-stale-banner';
    banner.dataset.fdStaleTransient = 'true';
    banner.setAttribute('role', 'alert');
    banner.innerHTML = `<strong>Showing the last successful data</strong><span>${esc(text)}</span><button class="btn sm" type="button" data-fd-stale-retry>Try again</button>`;
    banner.querySelector('[data-fd-stale-retry]').addEventListener('click', () => {
      if (typeof globalThis.fleetRetryView === 'function') globalThis.fleetRetryView();
    });
    target.prepend(banner);
    toast('Refresh failed; showing the last successful data', 'err');
    return;
  }
  target.innerHTML = `<div class="error-box">${esc(text)}</div>`;
}
globalThis.fleetRenderViewError = renderViewError;

/* Shared reading-density preference. The dashboard has many dense operational
 * views, so this belongs to the shell rather than any one renderer. */
function densityCfg() {
  let value = null;
  try {
    value = localStorage.getItem('fd.density');
  } catch {
    // Storage can be blocked by privacy mode; density is non-essential.
  }
  return value === 'compact' ? 'compact' : 'comfortable';
}
function applyDensityUI() {
  const density = densityCfg();
  document.body.dataset.density = density;
  const button = $('#density-toggle');
  if (!button) return;
  button.textContent = density === 'compact' ? 'Density: Compact' : 'Density: Comfortable';
  button.setAttribute(
    'aria-label',
    `Dashboard density: ${density}. Activate to switch to ${density === 'compact' ? 'comfortable' : 'compact'} spacing.`
  );
  button.setAttribute('aria-pressed', String(density === 'compact'));
}
function toggleDensity() {
  try {
    localStorage.setItem('fd.density', densityCfg() === 'compact' ? 'comfortable' : 'compact');
  } catch {
    // Keep the current session usable even when preferences cannot persist.
  }
  applyDensityUI();
}

/* Shared color-theme preference. Keep this at the application shell level so
 * every route, modal, and background refresh inherits the same presentation. */
function themeCfg() {
  try {
    const saved = localStorage.getItem('fd.theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {}
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function applyThemeUI() {
  const theme = themeCfg();
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'light' ? '#f4f7fb' : '#070910');
  const button = $('#theme-toggle');
  if (!button) return;
  const next = theme === 'light' ? 'dark' : 'light';
  button.textContent = theme === 'light' ? '☾ Dark' : '☼ Light';
  button.title = `Switch to ${next} theme`;
  button.setAttribute('aria-label', `Switch to ${next} theme`);
  button.setAttribute('aria-pressed', String(theme === 'light'));
}
function toggleTheme() {
  const next = themeCfg() === 'light' ? 'dark' : 'light';
  try {
    localStorage.setItem('fd.theme', next);
  } catch {}
  applyThemeUI();
}

function watchSystemTheme() {
  const media = matchMedia('(prefers-color-scheme: light)');
  media.addEventListener?.('change', () => {
    try {
      if (localStorage.getItem('fd.theme')) return;
    } catch {}
    applyThemeUI();
  });
}

/* ---- persisted collapsible panels ---- */
// Shared by any view that wants operator-controlled density. The render helper
// owns the markup and the wire helper owns localStorage, so future panels only
// need a stable id rather than another view-specific persistence implementation.
const UI_COLLAPSE_KEY = 'fd.ui.collapsed-panels.v1';
const UI_COLLAPSED = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_COLLAPSE_KEY) || '[]');
    return new Set(Array.isArray(saved) ? saved : []);
  } catch {
    return new Set();
  }
})();

function uiSaveCollapsed() {
  try {
    localStorage.setItem(UI_COLLAPSE_KEY, JSON.stringify([...UI_COLLAPSED]));
  } catch {}
}

function collapsiblePanel(id, titleHtml, bodyHtml, className = 'dh-panel') {
  const collapsed = UI_COLLAPSED.has(id);
  const bodyId = `ui-panel-${id.replace(/[^a-z0-9_-]/gi, '-')}`;
  return `<section class="${esc(className)} ui-collapsible${collapsed ? ' is-collapsed' : ''}" data-collapse-panel="${esc(id)}">
    <div class="ui-collapse-head">
      <h3>${titleHtml}</h3>
      <button class="ui-collapse-toggle" type="button" aria-expanded="${!collapsed}" aria-controls="${esc(bodyId)}" title="${collapsed ? 'Expand panel' : 'Collapse panel'}">
        <span aria-hidden="true">${collapsed ? '▸' : '▾'}</span><span class="sr-only">${collapsed ? 'Expand' : 'Collapse'} panel</span>
      </button>
    </div>
    <div class="ui-collapse-body${collapsed ? ' hidden' : ''}" id="${esc(bodyId)}">${bodyHtml}</div>
  </section>`;
}

function wireCollapsiblePanels(root = document) {
  $$('.ui-collapse-toggle', root).forEach(button =>
    button.addEventListener('click', () => {
      const panel = button.closest('[data-collapse-panel]');
      if (!panel) return;
      const id = panel.dataset.collapsePanel;
      const collapsed = !UI_COLLAPSED.has(id);
      if (collapsed) UI_COLLAPSED.add(id);
      else UI_COLLAPSED.delete(id);
      uiSaveCollapsed();
      panel.classList.toggle('is-collapsed', collapsed);
      $('.ui-collapse-body', panel)?.classList.toggle('hidden', collapsed);
      button.setAttribute('aria-expanded', String(!collapsed));
      button.title = collapsed ? 'Expand panel' : 'Collapse panel';
      const icon = $('span[aria-hidden="true"]', button);
      const label = $('.sr-only', button);
      if (icon) icon.textContent = collapsed ? '▸' : '▾';
      if (label) label.textContent = `${collapsed ? 'Expand' : 'Collapse'} panel`;
    })
  );
}

/* ===================== FLEET ===================== */
function tier(b) {
  const map = { aligned: 'b-green', PARTIAL: 'b-yellow', LEGACY: 'b-purple', none: 'b-gray' };
  return `<span class="badge ${map[b] || 'b-gray'}">${esc(b)}</span>`;
}
function feats(r) {
  const f = (on, ch) => `<span class="${on ? 'on' : 'off'}">${on ? ch : '·'}</span>`;
  return `<span class="feat">${f(r.lock, 'L')}${f(r.pulse, 'P')}${f(r.daily, 'D')}</span>`;
}
function pulseBadge(r) {
  if (!r.engineer) return '<span class="muted">—</span>';
  const s = r.status || '—';
  const cls =
    s === 'green' ? 'b-green' : s === 'work' ? 'b-blue' : s === 'issue' ? 'b-red' : 'b-gray';
  return `<span class="badge ${cls}">${esc(s)}</span>`;
}
function ageCell(r) {
  if (r.pulse_age == null) return '<span class="muted">—</span>';
  const s = Math.round(r.pulse_age);
  const txt =
    s < 90
      ? `${s}s`
      : s < 5400
        ? `${Math.floor(s / 60)}m`
        : s < 172800
          ? `${Math.floor(s / 3600)}h`
          : `${Math.floor(s / 86400)}d`;
  const stale = r.pulse_age > 35 * 60;
  return `<span class="${stale ? 'flag' : ''}">${txt}${stale ? ' !' : ''}</span>`;
}
function sparkline(series) {
  if (!series || !series.length) return '';
  return `<span class="spark">${series.map(v => `<i class="${v ? '' : 'bad'}" style="height:${v ? 14 : 6}px"></i>`).join('')}</span>`;
}
// Health timeline: one cell per scheduled 30-min run (last 24h) — 2=ran healthy,
// 1=ran with an issue/cf-down, 0=missed (cron didn't fire).
function healthBar(tl) {
  if (!tl || !tl.length) return '';
  const cls = c => (c === 2 ? 'h-ok' : c === 1 ? 'h-bad' : 'h-miss');
  return `<span class="hbar">${tl.map(c => `<i class="${cls(c)}"></i>`).join('')}</span>`;
}
function healthCell(h) {
  if (!h) return '<span class="muted">—</span>';
  const tl = Array.isArray(h.timeline) ? h.timeline : null;
  if (!tl) return `<span class="${h.coverage < 70 ? 'flag' : 'muted'}">${h.coverage}%</span>`;
  const ok = tl.filter(c => c === 2).length;
  const bad = tl.filter(c => c === 1).length;
  const miss = tl.filter(c => c === 0).length;
  const shown = tl.length;
  const pct = shown ? Math.round((100 * ok) / shown) : 0;
  const cls = pct >= 90 ? 'muted' : pct >= 70 ? 'warn' : 'flag';
  const tip = `last 24h: ${ok} healthy · ${bad} issue · ${miss} missed (of ${shown} runs) · 3-day coverage ${h.coverage}%`;
  return `<span class="hcell" title="${esc(tip)}">${healthBar(tl)}<span class="${cls} hpct">${pct}%</span></span>`;
}
function agentHealthCell(h) {
  if (!h) return '<span class="muted">—</span>';
  const current =
    !h.enabled || h.state === 'paused'
      ? '<span class="muted">paused</span>'
      : h.state === 'fresh'
        ? '<span class="health-now">healthy now</span>'
        : h.state === 'never'
          ? '<span class="health-attention">needs first run</span>'
          : `<span class="health-attention">${esc(STATE_LABEL[h.state] || h.state || 'needs attention')}</span>`;
  const history = [];
  if (h.failed) history.push(`${h.failed} failed`);
  if (h.missed) history.push(`${h.missed} missed`);
  const historyLabel = history.length ? `7d history: ${history.join(' · ')}` : '7d history: clear';
  const detail = `Current: ${h.state || 'unknown'} · ${historyLabel} · ${h.expected} expected · ${h.observed} observed · ${fmtUSD(h.costUsd)} AI cost${h.drift ? ' · prompt/runner drift' : ''}`;
  return `<span class="agent-health-summary" title="${esc(detail)}">${current}<br><span class="agent-health-history">${esc(historyLabel)}</span><br><span class="muted">${fmtUSD(h.costUsd)}${h.drift ? ' · drift' : ''}</span></span>`;
}

function editorialCadenceLabel(cadence) {
  return { frequent: 'Frequent', daily: 'Daily', weekly: 'Weekly' }[cadence] || 'Scheduled';
}

function editorialTelemetryCell(e, role = '', secondary = false) {
  if (!e) return '<span class="muted">—</span>';
  const publication = e.publication
    ? `published ${fmtAge((Date.now() - e.publication.at) / 1000)} ago`
    : 'no publication recorded';
  const deploy = e.deploy?.failedMarker
    ? '<span class="flag">deploy failed</span>'
    : e.deploy?.pending
      ? '<span class="flag">deploy pending</span>'
      : e.deploy?.state === 'success'
        ? '<span class="health-now">deployed</span>'
        : '<span class="muted">deploy unknown</span>';
  const outcome = e.noOp ? 'no-op' : e.outcome;
  const alert = e.alerts?.length
    ? `<span class="flag"> · ${e.alerts.length} alert${e.alerts.length === 1 ? '' : 's'}</span>`
    : '';
  const title = `${role ? `${role}; ` : ''}${publication}; latest run ${outcome}; source ${e.source?.state || 'unknown'}; ${e.publication?.slug || 'no article slug'}`;
  const roleLabel = role ? `${secondary ? 'secondary · ' : ''}${role}` : '';
  return `<span class="editorial-telemetry" title="${esc(title)}"><span>${role ? `<span class="badge b-gray">${esc(roleLabel)}</span> ` : ''}${esc(publication)}</span><br><span>${deploy} · ${esc(outcome)} · source ${esc(e.source?.state || 'unknown')}${alert}</span></span>`;
}

async function renderEngineers() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading fleet audit…</div></div>';
  let rows,
    hist = [],
    roleData,
    healthData;
  try {
    [rows, hist, roleData, healthData] = await Promise.all([
      api('GET', '/api/fleet'),
      api('GET', '/api/fleet/history?days=3').catch(() => []),
      api('GET', '/api/roles').catch(() => ({ sites: [] })),
      api('GET', '/api/agents/engineer/health').catch(() => null),
    ]);
  } catch (e) {
    if (!routeIs('agent', 'engineer', null)) return;
    renderViewError(app, `Audit failed: ${e.message}`);
    return;
  }
  if (!routeIs('agent', 'engineer', null)) return;
  const histBy = Object.fromEntries(hist.map(h => [h.site, h]));
  const healthBy = Object.fromEntries(
    (healthData?.rows || []).map(h => [`${h.site}:${h.role || 'engineer'}`, h])
  );

  const eng = rows.filter(r => r.engineer);
  const tiers = {};
  eng.forEach(r => {
    tiers[r.tier] = (tiers[r.tier] || 0) + 1;
  });
  const summary = Object.entries(tiers)
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');
  const stale = eng.filter(r => r.pulse_age && r.pulse_age > 35 * 60).map(r => r.site);
  const engineerSites = new Set(eng.map(r => r.site));
  const notEnrolled = (STATE.sites.length ? STATE.sites : rows.map(r => r.site)).filter(
    site => !engineerSites.has(site)
  );
  const suggestedSchedule = eng.find(r => r.cron)?.cron || '0 */2 * * *';
  AGENT_HEALTH = healthData;

  const body = rows
    .map(r => {
      const h = histBy[r.site];
      const ah = healthBy[`${r.site}:engineer`];
      const cf =
        r.cf == null
          ? '<span class="muted">—</span>'
          : r.cf
            ? '<span class="badge b-green">ok</span>'
            : '<span class="badge b-red">DOWN</span>';
      const cron = r.cron
        ? `<span class="mono">${esc(r.cron)}</span>`
        : '<span class="muted">—</span>';
      const flags = [...(r.flags || [])];
      if (r.engineer && !r.cron_up) flags.unshift('no-cron-container');
      const flagHtml = flags.length ? `<span class="flag">${esc(flags.join(', '))}</span>` : '';
      const cover = healthCell(h);
      const tasksBtn = `<button type="button" class="btn sm tasks-link" data-site="${esc(r.site)}" title="Tasks${r.queue ? ` ${r.queue}` : ''} — open ${esc(r.site)}'s task board">📋 Tasks${r.queue ? ` <span class="qn">${r.queue}</span>` : ''}</button>`;
      const engineerCell = (roleData.sites || []).find(s => s.site === r.site)?.cells?.engineer;
      const runBtn = r.engineer
        ? `<button type="button" class="btn sm run-eng" data-site="${esc(r.site)}"${r.cron_up ? '' : ' disabled title="cron container not running"'}>▶ Run</button> `
        : '';
      const pauseBtn =
        r.engineer && engineerCell?.worker
          ? `<button type="button" class="btn sm ${engineerCell.enabled ? 'danger' : 'primary'} ag-toggle" data-site="${esc(r.site)}" data-role="engineer" data-enabled="${engineerCell.enabled ? 1 : 0}">${engineerCell.enabled ? '⏸ Pause' : '▶ Resume'}</button> `
          : '';
      const actions = r.engineer
        ? runBtn +
          pauseBtn +
          tasksBtn +
          (ah
            ? ` <button class="btn sm ag-health-details" type="button" aria-expanded="false" data-site="${esc(r.site)}" data-role="engineer">Expand</button>`
            : '') +
          ` <button type="button" class="btn sm danger ag-remove" data-site="${esc(r.site)}" data-role="engineer">Remove</button>`
        : tasksBtn;
      return `<tr>
      <td class="site">${siteLink(r.site)}</td>
      <td>${tier(r.tier)}</td>
      <td>${r.engineer ? feats(r) : '<span class="muted">—</span>'}</td>
      <td>${cron}</td>
      <td>${pulseBadge(r)}</td>
      <td>${ageCell(r)}</td>
      <td class="mono">${r.render ? esc(r.render) : '—'}</td>
      <td>${cf}</td>
      <td class="mono">${r.queue || 0}</td>
      <td><div>${cover}</div><div class="agent-health-7d">${agentHealthCell(ah)}</div></td>
      <td>${flagHtml}</td>
      <td class="run-cell">${actions}</td>
    </tr>${ah ? healthDetailRow(ah, 12) : ''}`;
    })
    .join('');

  // [label, full-name, tooltip] — tooltip shows on hover over the header.
  const COLHELP = [
    [
      'Site',
      'Site',
      'Portfolio site (a submodule under sites/). Every row is one site; rows without an engineer show — in most columns.',
    ],
    [
      'Tier',
      'Archetype tier',
      'How aligned this engineer is with the current bash archetype. aligned = fully on the current archetype with every feature; PARTIAL = bash runner present but missing a feature; LEGACY = old generic engineer (role.md, no bash runner); none = no engineer installed.',
    ],
    [
      'Feat',
      'Features',
      'Which engineer safety features are wired. L = work-lock (serializes the Claude pass so two engineers never run at once), P = liveness-pulse (writes a status pulse every tick), D = daily-summary. Lit = on, · = off.',
    ],
    [
      'Cron',
      'Cron schedule',
      'The crontab schedule the engineer runs on (e.g. 12,42 * * * * = :12 and :42 past every hour). — = no cron line found.',
    ],
    [
      'Pulse',
      'Pulse status',
      "The engineer's self-reported status from its most recent tick. green = healthy and idle, work = it did work this tick, issue = it found a problem, — = no pulse yet.",
    ],
    [
      'Age',
      'Pulse age',
      'Time since the last pulse was written (s/m/h/d). ! flag = older than 35 minutes, meaning the engineer may be wedged or its cron container is down.',
    ],
    [
      'Rnd',
      'Render check',
      'True-render health check of the live site (Playwright in-container): passes / total checks. e.g. 1/1 = the live page rendered correctly on the last tick.',
    ],
    [
      'CF',
      'Cloudflare',
      'Cloudflare deploy/edge status. ok = the Worker is serving the live site; DOWN = the live site did not respond on the last check.',
    ],
    [
      'Q',
      'Queue',
      'Number of open tasks assigned to this engineer (assigned_role: engineer) waiting in the task backlog.',
    ],
    [
      'Health',
      'Run health (24h)',
      'One square per scheduled 30-min run over the last 24 hours — green = ran healthy, red = ran but reported an issue or Cloudflare was down, gray = the run was missed (the cron did not fire). The % is the healthy share of those runs (green = ≥90%, amber 70–90%, red <70%). Hover the cell for exact counts and the 3-day coverage figure.',
    ],
    [
      'Flags',
      'Flags',
      'Audit warnings for this row, e.g. no-cron-container (engineer installed but its cron container is not running) or archetype drift. Empty = no warnings.',
    ],
    [
      'Actions',
      'Actions',
      "▶ Run fires this engineer immediately — the exact command cron runs (bash ops/scripts/run-worker.sh engineer) inside the site's cron container, detached; the work-lock makes a mid-pass click no-op safely, and ▶ Run is disabled when the cron container is down. 📋 Tasks jumps to this site's task board (the number is its open engineer-queue count).",
    ],
  ];
  const thead = COLHELP.map(
    ([label, name, tip]) =>
      `<th class="th-help" title="${esc(name)} — ${esc(tip)}">${esc(label)}</th>`
  ).join('');

  app.innerHTML = `
    ${breadcrumb('engineer')}
    <div class="page-head"><div><h2 class="page-title">Engineer</h2><span class="muted">${eng.length} sites run this agent — live pulse, render, Cloudflare, queue</span></div><button type="button" class="btn" id="engineer-refresh">↻ Refresh</button></div>
    <div class="task-toolbar">
      <strong>${eng.length} engineers</strong>
      <span class="muted">${esc(summary)}</span>
      ${stale.length ? `<span class="flag">⚠ stale pulse: ${esc(stale.join(', '))}</span>` : ''}
      <span class="ag-enrollment-gap">· ${notEnrolled.length} not enrolled <button class="crumb-link ag-missing-toggle" type="button" aria-expanded="false">show sites</button></span>
      <button id="fleet-help-toggle" class="btn sm" style="margin-left:auto" title="Help — show / hide the column key">? Help</button>
    </div>
    ${engineerHealthPanel(healthData)}
    <div class="card ag-missing-panel hidden" id="ag-missing-panel">
      <div class="ag-missing-head"><strong>Sites not enrolled in Engineer</strong><span class="muted">${notEnrolled.length} sites</span></div>
      ${
        notEnrolled.length
          ? `<ul class="ag-missing-list">${notEnrolled.map(site => `<li><span>${siteLink(site)}</span><button class="btn sm ag-enroll" type="button" data-site="${esc(site)}" data-role="engineer" data-schedule="${esc(suggestedSchedule)}">Enroll</button></li>`).join('')}</ul>`
          : '<p class="muted ag-missing-empty">Every discovered site is enrolled in Engineer.</p>'
      }
    </div>
    <div id="fleet-help" class="help-panel hidden" data-rk="fleet-help">
      <div class="help-grid">
        ${COLHELP.map(([label, name, tip]) => `<div class="help-item"><span class="help-col">${esc(label)}</span><span class="help-name">${esc(name)}</span><span class="help-tip">${esc(tip)}</span></div>`).join('')}
      </div>
      <div class="help-foot">
        <b>Status legend</b> —
        Tier: <span class="badge b-green">aligned</span> <span class="badge b-yellow">PARTIAL</span> <span class="badge b-purple">LEGACY</span> <span class="badge b-gray">none</span> ·
        Pulse: <span class="badge b-green">green</span> <span class="badge b-blue">work</span> <span class="badge b-red">issue</span> ·
        CF: <span class="badge b-green">ok</span> <span class="badge b-red">DOWN</span> ·
        Hover any column header for the same description.
      </div>
    </div>
    <div class="card agent-table-wrap"><table class="agent-table">
      <thead><tr>${thead}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <p class="muted" style="margin-top:12px">Feat: <b>L</b>=work-lock <b>P</b>=liveness-pulse <b>D</b>=daily-summary · Age <b>!</b> = pulse &gt; 35m (possibly wedged) · Health: <i class="hkey h-ok"></i> healthy <i class="hkey h-bad"></i> issue <i class="hkey h-miss"></i> missed — one per 30-min run, last 24h. <a id="fleet-help-link" class="filter-clear" style="margin-left:0">full column key →</a></p>`;
  $('#engineer-refresh').addEventListener('click', () => renderEngineers());
  const helpBox = $('#fleet-help');
  const toggleHelp = () => helpBox.classList.toggle('hidden');
  $('#fleet-help-toggle').addEventListener('click', toggleHelp);
  $('#fleet-help-link').addEventListener('click', () => {
    helpBox.classList.remove('hidden');
    helpBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  const missingToggle = $('.ag-missing-toggle');
  const missingPanel = $('#ag-missing-panel');
  if (missingToggle && missingPanel)
    missingToggle.addEventListener('click', () => {
      const open = missingPanel.classList.toggle('hidden') === false;
      missingToggle.setAttribute('aria-expanded', String(open));
      missingToggle.textContent = open ? 'hide sites' : 'show sites';
    });
  $$('.ag-enroll').forEach(button =>
    button.addEventListener('click', () => {
      beginRoleEnrollment(button.dataset.site, button.dataset.role, button.dataset.schedule);
    })
  );
  $$('.ag-remove').forEach(button =>
    button.addEventListener('click', () =>
      removeRoleEnrollment(button.dataset.site, button.dataset.role, button)
    )
  );
  $$('.ag-toggle').forEach(button =>
    button.addEventListener('click', () =>
      toggleRole(button.dataset.site, button.dataset.role, button.dataset.enabled === '1')
    )
  );
  $$('.ag-health-toggle').forEach(b =>
    b.addEventListener('click', () =>
      toggleRole(b.dataset.site, 'engineer', b.dataset.enabled === '1')
    )
  );
  $$('.ag-health-run').forEach(b =>
    b.addEventListener('click', () => runAgent(b.dataset.site, 'engineer', b))
  );
  $$('.ag-health-details').forEach(b => b.addEventListener('click', () => toggleHealthDetail(b)));
  $('.ag-health-pause')?.addEventListener('click', () =>
    bulkAgentHealthAction('engineer', 'pause')
  );
  $('.ag-health-rerun')?.addEventListener('click', () => bulkAgentHealthAction('engineer', 'run'));
  $$('.run-eng').forEach(b => b.addEventListener('click', () => runEngineerNow(b.dataset.site, b)));
  $$('.tasks-link').forEach(b => b.addEventListener('click', () => openSiteTasks(b.dataset.site)));
  wireCrumbs();
  if (!FRESH) applyUISnap();
  stamp();
}

// Jump from an engineer row straight to that site's task board.
function openSiteTasks(site) {
  TASK.mode = 'board';
  STATE.taskSite = site;
  go('tasks');
}

function agentHealthOverview(data, currentRows = []) {
  const summary = data.summary || {};
  const rows = Array.isArray(currentRows) ? currentRows : [];
  const enrolled = summary.enrolled ?? rows.length;
  const fresh = rows.filter(row => row.enabled !== false && row.state === 'fresh').length;
  const attention = rows.filter(
    row => row.enabled !== false && ['stale', 'overdue', 'never'].includes(row.state)
  ).length;
  const paused = rows.filter(row => row.enabled === false || row.state === 'paused').length;
  const current = attention ? `${attention} need attention` : `${fresh}/${enrolled} healthy now`;
  const history = [];
  if (summary.failed) history.push(`${summary.failed} historical failures`);
  if (summary.missed) history.push(`${summary.missed} missed slots`);
  if (summary.drifted) history.push(`${summary.drifted} prompt/runner drifted`);
  return {
    current,
    currentDetail: `${fresh} healthy · ${attention} need attention${paused ? ` · ${paused} paused` : ''}`,
    history: history.length ? history.join(' · ') : 'no issues recorded',
  };
}

function agentHealthPanel(data, currentRows = []) {
  if (!data) return '';
  const overview = agentHealthOverview(data, currentRows);
  const familyControls = data.family
    ? '<span class="muted">Controls remain on each site\'s exact editorial profile.</span>'
    : '<button class="btn sm ag-health-pause" type="button">Pause current issues</button><button class="btn sm ag-health-rerun" type="button">Rerun historical failures</button>';
  return `<details class="card ag-health"><summary><strong>Current health</strong><span class="ag-health-summaryline"><span class="health-now">${esc(overview.current)}</span><span class="ag-health-history">7d history: ${esc(overview.history)}</span></span></summary>
    <div class="task-toolbar ag-health-toolbar"><span><b>Now</b> ${esc(overview.currentDetail)}</span><span><b>7d history</b> ${data.summary.expected} expected · ${data.summary.observed} observed · ${data.summary.failed} failed · ${data.summary.missed} missed</span><span>${data.summary.drifted} prompt/runner drifted</span>${familyControls}</div>
    <p class="muted ag-health-note">Current status is shown first. The seven-day counts are historical context and do not mean a site is failing now. Expected slots come from the active cron schedule; paused roles are excluded. Expand a row for execution history and recent failures. AI cost comes from the tracked usage ledger.</p></details>`;
}

function engineerHealthPanel(data) {
  return agentHealthPanel(data, data?.rows || []);
}

function healthDetailRow(row, colspan = 10) {
  const failures = (row.failures || []).length
    ? row.failures
        .map(
          f =>
            `<li><span class="mono">${esc(f.file)}</span> — ${esc(f.summary || 'failure recorded')}</li>`
        )
        .join('')
    : '<li class="muted">No recent failures recorded.</li>';
  const slots = (row.execution?.slots || []).slice(-12).reverse();
  const history = slots.length
    ? slots
        .map(
          slot =>
            `<li><span class="badge ${slot.status === 'ok' ? 'b-green' : slot.status === 'missed' ? 'b-red' : slot.status === 'failed' ? 'b-yellow' : 'b-gray'}">${esc(slot.status)}</span> ${esc(fmtDate(slot.at))}${slot.observedAt ? ` <span class="muted">observed ${esc(fmtDate(slot.observedAt))}</span>` : ''}</li>`
        )
        .join('')
    : '<li class="muted">No expected run slots in this window.</li>';
  return `<tr class="ag-health-detail hidden" data-health-detail="${esc(row.site)}:${esc(row.role || '')}"><td colspan="${colspan}"><div class="ag-health-detail-grid"><span><b>Schedule</b><br><span class="mono">${esc(row.schedule)}</span></span><span><b>Last run</b><br>${row.last ? esc(fmtDate(row.last)) : '—'}</span><span><b>Runner</b><br><span class="mono">${esc(row.runner)}</span></span><span><b>Prompt hash</b><br><span class="mono">${esc(row.promptHash || 'missing')}</span></span><span><b>AI calls</b><br>${row.calls} · ${fmtUSD(row.costUsd)}</span><span><b>Execution history</b><br><span class="muted">${row.expected} expected · ${row.missed} missed · ${row.unknown} unknown</span><ul>${history}</ul></span><span><b>Recent failures</b><br><ul>${failures}</ul></span></div></td></tr>`;
}

function toggleHealthDetail(button) {
  const row = $(
    `tr.ag-health-detail[data-health-detail="${CSS.escape(`${button.dataset.site}:${button.dataset.role || ''}`)}"]`
  );
  if (!row) return;
  const open = row.classList.toggle('hidden') === false;
  button.textContent = open ? 'Collapse' : 'Expand';
  button.setAttribute('aria-expanded', String(open));
}

function beginRoleEnrollment(site, role, schedule) {
  AUTO_SITE = site;
  AUTO_ROLE_DRAFT = { site, role, schedule: schedule || '0 */2 * * *' };
  go('automation');
}

async function rebuildCronForSite(site) {
  const res = await fetch(`/api/cron/systems/${encodeURIComponent(site)}/rebuild`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  const text = await res.text();
  if (!res.ok || !text.includes('@@VERDICT ok'))
    throw new Error(text.slice(-500) || `rebuild failed (${res.status})`);
}

async function removeRoleEnrollment(site, role, btn) {
  if (
    !(await globalThis.fleetConfirm?.({
      title: 'Remove role enrollment',
      message: `Remove ${role} from ${site}? This unschedules the role and clears its pause flag; the prompt is retained for recovery and the cron container will be rebuilt.`,
      confirmLabel: 'Remove enrollment',
      danger: true,
    }))
  )
    return;
  gdBusy(btn, true);
  try {
    await api(
      'DELETE',
      `/api/automation/${encodeURIComponent(site)}/roles/${encodeURIComponent(role)}`
    );
    toast(`${agentLabel(role)} removed from ${site}; rebuilding cron…`);
    await rebuildCronForSite(site);
    toast(`${agentLabel(role)} removed from ${site}`);
    softRender();
  } catch (e) {
    toast(`Remove failed: ${e.message}`, 'err');
    gdBusy(btn, false);
  }
}

async function bulkAgentHealthAction(role, action) {
  const rows = (AGENT_HEALTH?.rows || []).filter(
    row =>
      row.worker &&
      row.enabled &&
      (action === 'pause' ? ['stale', 'overdue'].includes(row.state) : row.failed > 0)
  );
  if (!rows.length)
    return toast(
      action === 'pause' ? 'No current issues to pause' : 'No historical failures to rerun'
    );
  const verb = action === 'pause' ? 'Pause' : 'Rerun';
  const scope = action === 'pause' ? 'current issues' : 'historical failures';
  if (
    !(await globalThis.fleetConfirm?.({
      title: `${verb} ${role} health actions`,
      message: `${verb} ${scope} for ${role} on ${rows.length} site(s)? ${rows.map(row => row.site).join(', ')}`,
      confirmLabel: `${verb} sites`,
    }))
  )
    return;
  const failed = [];
  for (const row of rows) {
    try {
      await api(
        'POST',
        `/api/roles/${encodeURIComponent(row.site)}/${encodeURIComponent(role)}/${action}`
      );
    } catch (e) {
      failed.push(`${row.site}: ${e.message}`);
    }
  }
  toast(
    `${verb}d ${rows.length - failed.length}/${rows.length} ${role}${failed.length ? ` · failed: ${failed.join('; ')}` : ''}`,
    failed.length ? 'err' : undefined
  );
  if (!failed.length) softRender();
}

async function runEngineerNow(site, btn) {
  if (btn.disabled) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const r = await api('POST', `/api/fleet/${encodeURIComponent(site)}/run`);
    toast(`engineer triggered on ${site} (${r.container})`);
    btn.textContent = '✓ sent';
    setTimeout(() => {
      btn.textContent = orig;
      btn.disabled = false;
    }, 5000);
  } catch (e) {
    toast(`run failed: ${e.message}`, 'err');
    btn.textContent = orig;
    btn.disabled = false;
  }
}

/* ===================== GIT ===================== */
// ---- Git Hygiene ------------------------------------------------------------
// Control surface for tools/fleet-git. Everything on this board is a call into
// the SAME library the hourly cron sweep runs, so a decision made here and a
// decision made unattended cannot drift apart. The board itself is cheap to
// poll: it reads the last sweep report and the review queue off disk and makes
// no git calls of its own — only the two buttons do.
async function renderGitHygiene() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading hygiene board…</div></div>';
  let b;
  try {
    b = await api('GET', '/api/git/hygiene');
  } catch (e) {
    renderViewError(app, `Hygiene board failed: ${e.message}`);
    return;
  }

  const last = b.lastSweep;
  const summary = (last && last.summary) || [];
  const notClean = summary.filter(r => !r.clean);
  const clean = summary.filter(r => r.clean).length;
  const blocked = (last && last.blocked) || [];
  const skipped = (last && last.skipped) || [];
  const q = b.queue || [];

  const when = last ? `${esc(last.at)}` : 'never';
  const head = `
    ${gitPageTabs('hygiene')}
    <section class="gh-summary" aria-label="Git hygiene summary">
      <div class="gh-stat"><strong>${summary.length}</strong><span>Repositories swept</span></div>
      <div class="gh-stat gh-stat-good"><strong>${clean}</strong><span>Clean</span></div>
      <div class="gh-stat ${notClean.length ? 'gh-stat-warn' : 'gh-stat-good'}"><strong>${notClean.length}</strong><span>Repos needing review</span></div>
      <div class="gh-stat ${blocked.length ? 'gh-stat-bad' : 'gh-stat-good'}"><strong>${blocked.length}</strong><span>Blocked paths</span></div>
      <div class="gh-stat ${skipped.length ? 'gh-stat-warn' : 'gh-stat-good'}"><strong>${skipped.length}</strong><span>Skipped repos</span></div>
      <div class="gh-stat gh-stat-meta"><strong>${b.policy.rules.length}</strong><span>Policy rules · ${b.policy.ignoreBlock.length} managed ignore lines</span></div>
    </section>
    <div class="gh-toolbar" role="group" aria-label="Git hygiene actions">
      <strong>Git Hygiene</strong>
      <span class="muted">last sweep: ${when}${last ? ` · ${last.repos} repos · ${q.length} paths awaiting decision` : ''}</span>
      <button class="btn sm" type="button" id="gh-refresh">↻ Refresh</button>
      <button class="btn sm" type="button" id="gh-audit"${b.running ? ' disabled' : ''}>Audit (dry run)</button>
      <button class="btn sm" type="button" id="gh-sweep"${b.running ? ' disabled' : ''}>⚙ Sweep now</button>
    </div>`;

  const blockedCard = blocked.length
    ? `<div class="card gh-panel"><h2>⛔ Blocked — credential-shaped paths</h2><div class="table-wrap"><table>
        <thead><tr><th>Site</th><th>Path</th><th>Why</th></tr></thead><tbody>${blocked
          .map(
            x =>
              `<tr><td class="site">${esc(x.slug)}</td><td class="mono">${esc(x.path)}</td><td>${esc(x.reason)}</td></tr>`
          )
          .join('')}</tbody></table></div>
        <p class="muted">A repo with a blocked path is not committed, ignored or pushed at all until this is cleared by hand.</p></div>`
    : '';

  const skipCard = skipped.length
    ? `<div class="card gh-panel"><h2>Skipped repos</h2><div class="table-wrap"><table>
        <thead><tr><th>Site</th><th>Why</th></tr></thead><tbody>${skipped
          .map(x => `<tr><td class="site">${esc(x.slug)}</td><td>${esc(x.why)}</td></tr>`)
          .join('')}</tbody></table></div></div>`
    : '';

  const query = GH_FILTER.q.trim().toLowerCase();
  const filteredQueue = q
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item }) =>
        !query || `${item.slug} ${item.path} ${item.reason || ''}`.toLowerCase().includes(query)
    );
  const pageCount = Math.max(1, Math.ceil(filteredQueue.length / GH_PAGE_SIZE));
  GH_PAGE = Math.min(Math.max(1, GH_PAGE), pageCount);
  const pageItems = filteredQueue.slice((GH_PAGE - 1) * GH_PAGE_SIZE, GH_PAGE * GH_PAGE_SIZE);
  const queueRows = pageItems.length
    ? pageItems
        .map(
          ({
            item: i,
            index: n,
          }) => `<tr class="gh-queue-row" data-gh-i="${n}" data-gh-search="${esc(`${i.slug} ${i.path} ${i.reason || ''}`.toLowerCase())}" data-fleet-row data-site="${esc(i.slug)}">
      <td class="site">${esc(i.slug)}</td>
      <td class="mono">${esc(i.path)}</td>
      <td><span class="muted">${esc(i.reason)}</span></td>
      <td class="mono muted">${esc((i.first_seen || '').slice(0, 10))}</td>
      <td class="nowrap">
        <button type="button" class="btn sm gh-act" data-act="commit" data-i="${n}" title="Commit this path once">Commit</button>
        <button type="button" class="btn sm gh-act" data-act="ignore" data-i="${n}" title="Add to this repo's .gitignore and untrack it">Ignore</button>
        <button type="button" class="btn sm gh-act" data-act="always-commit" data-i="${n}" title="Commit AND add a policy rule so this class never asks again">Always commit</button>
        <button type="button" class="btn sm gh-act" data-act="always-ignore" data-i="${n}" title="Ignore AND add a policy rule so this class never asks again">Always ignore</button>
        <button type="button" class="btn sm gh-act" data-act="dismiss" data-i="${n}" title="Drop from the queue without touching the repo">Dismiss</button>
      </td></tr>`
        )
        .join('')
    : `<tr><td colspan="5" class="muted">${query ? 'No review items match this search.' : 'Nothing to review — policy covered every dirty path in the fleet.'}</td></tr>`;

  const stateRows = summary.length
    ? summary
        .map(
          r => `<tr data-fleet-row data-site="${esc(r.slug)}">
        <td class="site">${esc(r.slug)}</td>
        <td>${r.clean ? '<span class="badge b-green">clean</span>' : '<span class="badge b-yellow">dirty</span>'}</td>
        <td>${r.commits || 0}</td>
        <td>${r.pushed ? '<span class="badge b-blue">pushed</span>' : '<span class="muted">—</span>'}</td>
        <td>${r.review ? `<span class="badge b-yellow">${r.review}</span>` : '<span class="muted">0</span>'}</td>
        <td>${r.errors ? `<span class="badge b-red">${r.errors}</span>` : '<span class="muted">0</span>'}</td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="6" class="muted">No sweep has been recorded yet. Run one above.</td></tr>';

  app.innerHTML = `${head}${blockedCard}
    <div class="gh-controls" role="group" aria-label="Search hygiene queue"><label class="gh-search"><span class="sr-only">Search review queue</span><input id="gh-search" class="cm-input" type="search" placeholder="Search site, path, or reason…" value="${esc(GH_FILTER.q)}" autocomplete="off" /></label><span id="gh-filter-count" class="muted" role="status" aria-live="polite" data-total="${filteredQueue.length}" data-page-count="${pageCount}"></span></div>
    <div class="card gh-panel"><h2>Review queue (${filteredQueue.length} paths)</h2><div class="matrix-scroll-hint" role="note">Swipe horizontally to review paths and choose an action</div><div class="table-wrap" tabindex="0" role="region" aria-label="Git hygiene review queue"><table>
      <thead><tr><th>Site</th><th>Path</th><th>Why it needs you</th><th>Since</th><th>Decision</th></tr></thead>
      <tbody>${queueRows}</tbody></table></div>
      <div class="gh-pagination" aria-label="Git hygiene review pages"><span class="muted">Page ${GH_PAGE} of ${pageCount} · showing ${pageItems.length} of ${filteredQueue.length}</span><button type="button" class="btn sm" id="gh-page-prev" ${GH_PAGE <= 1 ? 'disabled' : ''}>← Previous</button><button type="button" class="btn sm" id="gh-page-next" ${GH_PAGE >= pageCount ? 'disabled' : ''}>Next →</button></div>
      <details class="gh-help"><summary>What the “Always…” decisions do</summary><p>"Always…" writes a rule into <span class="mono">tools/fleet-git/policy.json</span> so the whole class is handled unattended from the next sweep on.</p></details>
    </div>
    ${skipCard}
    <div class="card gh-panel"><h2>Last sweep</h2><div class="matrix-scroll-hint" role="note">Swipe horizontally to inspect each repository result</div><div class="table-wrap" tabindex="0" role="region" aria-label="Git hygiene last sweep results"><table>
      <thead><tr><th>Site</th><th>Tree</th><th>Commits</th><th>Remote</th><th>Review</th><th>Errors</th></tr></thead>
      <tbody>${stateRows}</tbody></table></div></div>
    <div class="card gh-panel"><h2>Policy</h2>
      <p class="muted">${b.policy.rules.length} rules · managed .gitignore block: ${b.policy.ignoreBlock.length} lines ·
      max ${b.policy.limits.max_files_per_commit} files/commit</p>
      <button class="btn sm" type="button" id="gh-ignore-sync">Preview .gitignore adoption</button>
      <button class="btn sm" type="button" id="gh-ignore-sync-apply">Adopt managed block fleet-wide</button>
    </div>`;

  $('#gh-refresh').addEventListener('click', () => renderGitHygiene());
  const sweepBtn = async apply => {
    const btn = apply ? $('#gh-sweep') : $('#gh-audit');
    btn.disabled = true;
    btn.textContent = apply ? 'Sweeping…' : 'Auditing…';
    try {
      const rep = await api('POST', '/api/git/hygiene/sweep', { apply });
      toast(
        `${apply ? 'Sweep' : 'Audit'}: ${rep.dirty.length} repo(s) not clean, ${rep.reviewCount} to review` +
          (rep.errors.length ? `, ${rep.errors.length} error(s)` : ''),
        rep.errors.length || rep.blocked.length ? 'err' : 'ok'
      );
    } catch (e) {
      toast(e.message, 'err');
    }
    renderGitHygiene();
  };
  $('#gh-audit').addEventListener('click', () => sweepBtn(false));
  $('#gh-sweep').addEventListener('click', async () => {
    if (
      await globalThis.fleetConfirm?.({
        title: 'Sweep Git hygiene fleet-wide',
        message:
          'Commit, ignore, and push everything recognized by the hygiene policy across the whole fleet?',
        confirmLabel: 'Sweep fleet',
      })
    )
      sweepBtn(true);
  });
  $('#gh-search').addEventListener('input', e => {
    GH_FILTER.q = e.target.value;
    GH_PAGE = 1;
    clearTimeout(GH_FILTER_TIMER);
    GH_FILTER_TIMER = setTimeout(() => softRender(), 150);
  });
  applyGitHygieneFilter();
  $('#gh-page-prev').addEventListener('click', () => {
    GH_PAGE = Math.max(1, GH_PAGE - 1);
    softRender();
  });
  $('#gh-page-next').addEventListener('click', () => {
    GH_PAGE += 1;
    softRender();
  });

  $$('.gh-act').forEach(btn =>
    btn.addEventListener('click', async () => {
      const item = q[Number(btn.dataset.i)];
      const act = btn.dataset.act;
      const remember = act.startsWith('always-');
      const decision = act === 'dismiss' ? 'dismiss' : act.replace('always-', '');
      let glob = true;
      if (remember) {
        // The rule is only as good as its glob — let the operator widen
        // "ops/tasks/hold/x.md" into "ops/tasks/**" before it is written.
        glob = await globalThis.fleetTextPrompt?.({
          title: 'Remember Git hygiene rule',
          label: 'Rule pattern (glob)',
          placeholder: item.path,
          required: true,
          submitLabel: 'Use this rule',
        });
        if (!glob) return;
      }
      const scope = remember
        ? (await globalThis.fleetConfirm?.({
            title: 'Choose rule scope',
            message:
              'Apply this remembered rule to the whole fleet? Canceling keeps it limited to this site.',
            confirmLabel: 'Apply fleet-wide',
          }))
          ? 'fleet'
          : 'site'
        : 'site';
      btn.disabled = true;
      try {
        await api('POST', '/api/git/hygiene/resolve', {
          slug: item.slug,
          path: item.path,
          decision,
          remember: remember ? glob : false,
          scope,
          untrack: decision === 'ignore',
        });
        toast(`${item.slug}: ${item.path} → ${decision}`, 'ok');
      } catch (e) {
        toast(e.message, 'err');
      }
      renderGitHygiene();
    })
  );

  const syncBtn = async apply => {
    try {
      const r = await api('POST', '/api/git/hygiene/ignore-sync', { apply });
      toast(
        r.changed.length
          ? `${apply ? 'Updated' : 'Would update'} ${r.changed.length} .gitignore: ${r.changed.map(c => c.slug).join(', ')}`
          : 'Every repo already matches the managed block',
        'ok'
      );
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  $('#gh-ignore-sync').addEventListener('click', () => syncBtn(false));
  $('#gh-ignore-sync-apply').addEventListener('click', async () => {
    if (
      await globalThis.fleetConfirm?.({
        title: 'Adopt managed ignore rules',
        message: 'Write the fleet-managed .gitignore block into every site repository?',
        confirmLabel: 'Adopt ignore block',
      })
    )
      syncBtn(true);
  });

  applyFleetFilter();
  stamp();
}

function applyGitHygieneFilter() {
  const count = $('#gh-filter-count');
  if (count) {
    const total = Number(count.dataset.total || 0);
    const pageCount = Number(count.dataset.pageCount || 1);
    count.textContent = `${total} matching · page ${GH_PAGE}/${pageCount}`;
  }
}

async function renderGit() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Scanning repos…</div></div>';
  let rows;
  try {
    rows = await api('GET', '/api/git');
  } catch (e) {
    renderViewError(app, `Git scan failed: ${e.message}`);
    return;
  }

  const dirtyCount = rows.filter(r => r.dirty > 0).length;
  const pushCount = rows.filter(r => r.needsPush).length;
  const pullCount = rows.filter(r => r.needsPull).length;
  // Surface repositories that need operator action before the clean fleet.
  // Keep alphabetical order within each state so the list remains predictable.
  const gitRank = r =>
    !r.isRepo
      ? 0
      : r.dirty > 0
        ? 1
        : r.syncState === 'diverged-behind' || r.behind
          ? 2
          : r.ahead
            ? 3
            : r.syncState === 'no-upstream'
              ? 4
              : 5;
  rows.sort((a, b) => gitRank(a) - gitRank(b) || String(a.slug).localeCompare(String(b.slug)));

  const body = rows
    .map(r => {
      if (!r.isRepo)
        return `<tr><td class="site">${esc(r.slug)}</td><td colspan="5"><span class="muted">${esc(r.error || 'not a repo')}</span></td></tr>`;
      const dirty =
        r.dirty > 0
          ? `<span class="badge b-yellow">${r.dirty} uncommitted</span>`
          : '<span class="badge b-green">clean</span>';
      const sync = [];
      if (r.ahead) sync.push(`<span class="badge b-blue">↑${r.ahead}</span>`);
      if (r.behind) sync.push(`<span class="badge b-red">↓${r.behind}</span>`);
      if (!r.ahead && !r.behind) sync.push('<span class="muted">synced</span>');
      const shaCls =
        {
          synced: 'b-green',
          ahead: 'b-yellow',
          'diverged-behind': 'b-red',
          'no-upstream': 'b-blue',
        }[r.syncState] || 'b-blue';
      const shaLine = `<span class="badge ${shaCls}" title="local vs remote SHA">${esc(r.localSha || '—')} / ${esc(r.remoteSha || '—')}</span>`;
      const stashBadge = r.stashCount
        ? ` <a href="#git/${encodeURIComponent(r.slug)}/stashes" class="badge b-blue" title="${r.stashCount} stash(es)">📦 ${r.stashCount}</a>`
        : '';
      const repoLink = r.remoteWebUrl
        ? ` <a href="${esc(r.remoteWebUrl)}" target="_blank" rel="noopener" class="rcol-link" title="Open repo on GitHub">↗</a>`
        : '';
      const gitStatus = r.dirty > 0 ? 'dirty' : r.syncState === 'synced' ? 'synced' : r.syncState;
      return `<tr class="git-row" data-slug="${esc(r.slug)}" data-git-name="${esc(`${r.slug} ${r.branch || ''}`.toLowerCase())}" data-git-status="${esc(gitStatus)}" data-fleet-row data-site="${esc(r.slug)}" role="button" tabindex="0" aria-expanded="false" aria-controls="gd-${esc(r.slug)}">
      <td class="site">${esc(r.slug)}${repoLink} <span class="muted">▸</span></td>
      <td class="mono">${esc(r.branch || '—')} ${shaLine}${stashBadge}</td>
      <td>${dirty}</td>
      <td>${sync.join(' ')}<span class="sr-only">Open repository details</span></td>
    </tr>
    <tr class="git-detail-row hidden" data-detail="${esc(r.slug)}" data-rk="git:${esc(r.slug)}"><td colspan="4"><div class="git-detail" id="gd-${esc(r.slug)}" data-rkh="git:${esc(r.slug)}"></div></td></tr>`;
    })
    .join('');
  app.innerHTML = `
    ${gitPageTabs('operations')}
    <section class="git-summary" aria-label="Git fleet summary">
      <div class="git-stat"><strong>${rows.length}</strong><span>Repositories</span></div>
      <div class="git-stat git-stat-good"><strong>${rows.length - dirtyCount}</strong><span>Clean trees</span></div>
      <div class="git-stat ${dirtyCount ? 'git-stat-warn' : 'git-stat-good'}"><strong>${dirtyCount}</strong><span>Dirty trees</span></div>
      <div class="git-stat ${pushCount ? 'git-stat-warn' : 'git-stat-good'}"><strong>${pushCount}</strong><span>Need push</span></div>
      <div class="git-stat ${pullCount ? 'git-stat-bad' : 'git-stat-good'}"><strong>${pullCount}</strong><span>Need pull</span></div>
      <div class="git-actions"><button type="button" class="btn sm" id="git-refresh">↻ Refresh</button><button type="button" class="btn sm" id="pull-all"${pullCount ? '' : ' disabled title="Pull all unavailable — nothing to pull"'}>⇩ Pull all${pullCount ? ` (${pullCount})` : ''}</button><button type="button" class="btn sm" id="push-all"${pushCount ? '' : ' disabled title="Push all unavailable — nothing to push"'}>⇧ Push all${pushCount ? ` (${pushCount})` : ''}</button></div>
    </section>
    <div class="git-controls" role="group" aria-label="Filter repositories">
      <label class="git-search"><span class="sr-only">Search repositories</span><input id="git-search" class="cm-input" type="search" placeholder="Search repository or branch…" value="${esc(GIT_FILTER.q)}" autocomplete="off" /></label>
      <label><span class="sr-only">Repository status</span><select id="git-status" class="cm-input"><option value="all">All states</option><option value="dirty">Dirty tree</option><option value="synced">Synced</option><option value="ahead">Need push</option><option value="behind">Need pull</option><option value="diverged-behind">Diverged</option><option value="no-upstream">No upstream</option></select></label>
      <span id="git-filter-count" class="muted" role="status" aria-live="polite"></span>
    </div>
    <div class="card aii-table"><div class="matrix-scroll-hint" role="note">Swipe horizontally to compare branch, working-tree, and remote status</div><div class="table-wrap" tabindex="0" role="region" aria-label="Fleet repository status"><table><caption class="sr-only">Fleet repository status</caption>
      <thead><tr><th>Site</th><th>Branch</th><th>Working tree</th><th>Remote</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;

  $('#git-refresh').addEventListener('click', () => renderGit());
  $$('.git-row').forEach(tr =>
    tr.addEventListener('click', e => {
      if (e.target.closest('a')) return;
      toggleGitDetail(tr.dataset.slug);
    })
  );
  $$('.git-row').forEach(tr =>
    tr.addEventListener('keydown', e => {
      if (e.target.closest('a') || !['Enter', ' '].includes(e.key)) return;
      e.preventDefault();
      toggleGitDetail(tr.dataset.slug);
    })
  );
  const pa = $('#push-all');
  if (pa) pa.addEventListener('click', pushAllSites);
  const pua = $('#pull-all');
  if (pua) pua.addEventListener('click', pullAllSites);
  $('#git-status').value = GIT_FILTER.status;
  $('#git-search').addEventListener('input', e => {
    GIT_FILTER.q = e.target.value;
    applyGitFilter();
  });
  $('#git-status').addEventListener('change', e => {
    GIT_FILTER.status = e.target.value;
    applyGitFilter();
  });
  applyGitFilter();
  if (!FRESH) applyUISnap();
  // applyUISnap re-injects the saved innerHTML of any expanded detail but not its
  // event listeners — re-wire the live ops for every still-open detail panel.
  $$('.git-detail-row:not(.hidden)').forEach(r => {
    const box = $(`#gd-${CSS.escape(r.dataset.detail)}`);
    if (box && box.querySelector('.gd-files, .gd-push')) wireGitOps(r.dataset.detail, box);
  });
  applyFleetFilter();
  stamp();
}

function applyGitFilter() {
  const q = GIT_FILTER.q.trim().toLowerCase();
  const rows = $$('.git-row');
  const visible = rows.filter(row => {
    const matchesQuery = !q || (row.dataset.gitName || '').includes(q);
    const matchesStatus =
      GIT_FILTER.status === 'all' || row.dataset.gitStatus === GIT_FILTER.status;
    const show = matchesQuery && matchesStatus;
    row.classList.toggle('git-filter-hidden', !show);
    const detail = $(`tr[data-detail="${CSS.escape(row.dataset.slug || '')}"]`);
    if (detail && !show) detail.classList.add('hidden');
    return show;
  });
  const count = $('#git-filter-count');
  if (count) count.textContent = `${visible.length}/${rows.length} shown`;
}

function gitPageTabs(active) {
  return `<nav class="git-page-tabs" aria-label="Git workspace">
    <a class="git-page-tab${active === 'operations' ? ' active' : ''}" ${active === 'operations' ? 'aria-current="page"' : ''} href="#git">Repository Operations</a>
    <a class="git-page-tab${active === 'hygiene' ? ' active' : ''}" ${active === 'hygiene' ? 'aria-current="page"' : ''} href="#git/hygiene">Fleet Hygiene</a>
  </nav>`;
}

/* ===================== TASK BUDGET ===================== */
// Writer-role turn-budget audit: static (configured) vs. computed (derived
// from the next backlog task's own estimated_turns) --max-turns per
// site/role, plus dead-role backlog task drift (assigned_role with no
// matching ops/roles/*.md). Delegates to tools/task-budget/turn_budget.py
// audit --json (server/taskbudget.js) — same "shell out to the Python CLI,
// render here" pattern as the Engineers view.
let TB_PAGE_SIZE = window.matchMedia?.('(max-width: 700px)').matches ? 10 : 20;

async function renderTaskBudget() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Auditing writer-role turn budgets…</div></div>';
  let sites;
  try {
    sites = await api('GET', '/api/task-budget');
  } catch (e) {
    renderViewError(app, `Task-budget audit failed: ${e.message}`);
    return;
  }

  let roleRows = 0,
    driftRows = 0,
    deadRoleRows = 0;
  const siteBlocks = sites
    .filter(s => s.roles.length || s.dead_role_tasks.length)
    .sort((a, b) => {
      const risk = site =>
        site.dead_role_tasks.length * 3 +
        site.roles.filter(
          role =>
            role.static_max_turns != null &&
            role.computed_max_turns != null &&
            Math.abs(role.static_max_turns - role.computed_max_turns) >= 10
        ).length;
      return risk(b) - risk(a) || a.site.localeCompare(b.site);
    })
    .map(s => {
      const siteDrift = s.roles.filter(
        role =>
          role.static_max_turns != null &&
          role.computed_max_turns != null &&
          Math.abs(role.static_max_turns - role.computed_max_turns) >= 10
      ).length;
      const rows = s.roles
        .map(r => {
          roleRows++;
          const drift =
            r.static_max_turns != null &&
            r.computed_max_turns != null &&
            Math.abs(r.static_max_turns - r.computed_max_turns) >= 10;
          if (drift) driftRows++;
          const staticBadge =
            r.static_max_turns != null
              ? `<span class="badge b-blue">${r.static_max_turns}</span>`
              : '<span class="muted">—</span>';
          const computedBadge =
            r.computed_max_turns != null
              ? `<span class="badge ${drift ? 'b-yellow' : 'b-green'}">${r.computed_max_turns}</span>`
              : '<span class="muted">no eligible task</span>';
          const installed = r.role_installed
            ? ''
            : ' <span class="badge b-red" title="assigned_role with no matching ops/roles/*.md">dead role</span>';
          const dispatch =
            r.dispatch === 'wrapper'
              ? `<span class="muted mono" title="${esc(r.wrapper_script || '')}">wrapper</span>`
              : '<span class="muted">run-role.sh</span>';
          return `<tr>
        <td class="mono">${esc(r.role)}${installed}</td>
        <td>${staticBadge}</td>
        <td>${computedBadge}</td>
        <td>${dispatch}</td>
        <td>${r.next_task ? esc(r.next_task) : '<span class="muted">—</span>'}</td>
      </tr>`;
        })
        .join('');
      const deadTasks = s.dead_role_tasks
        .map(d => {
          deadRoleRows++;
          return `<div class="muted">⚠ <span class="mono">${esc(d.file)}</span> → assigned_role: <span class="mono">${esc(d.assigned_role)}</span> (no such role installed — never picked up)</div>`;
        })
        .join('');
      return `<details class="card tb-site-card" data-fleet-row data-site="${esc(s.site)}">
      <summary class="tb-site-summary"><strong>${esc(s.site)}</strong><span class="muted">${s.roles.length} roles</span><span class="badge ${siteDrift ? 'b-yellow' : 'b-gray'}">${siteDrift} drift</span><span class="badge ${s.dead_role_tasks.length ? 'b-red' : 'b-gray'}">${s.dead_role_tasks.length} unassigned</span></summary>
      <div class="tb-site-content">
      ${
        rows
          ? `<div class="table-wrap"><table>
        <caption class="sr-only">${esc(s.site)} task budget roles</caption>
        <thead><tr><th>Role</th><th>Static</th><th>Computed</th><th>Dispatch</th><th>Next task</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
          : ''
      }
      ${deadTasks ? `<div class="tb-dead-tasks">${deadTasks}</div>` : ''}
      </div>
    </details>`;
    })
    .join('');

  app.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">Task Budget</h2><span class="muted">Configured versus computed writer-role turn budgets, including roles that cannot be dispatched.</span></div><button type="button" class="btn" id="task-budget-refresh">↻ Refresh</button></div>
    <section class="tb-summary" aria-label="Task budget audit summary">
      <div class="tb-stat"><strong>${sites.filter(s => s.roles.length || s.dead_role_tasks.length).length}</strong><span>Sites with audit data</span></div>
      <div class="tb-stat tb-stat-good"><strong>${roleRows}</strong><span>Roles inspected</span></div>
      <div class="tb-stat ${driftRows ? 'tb-stat-warn' : 'tb-stat-good'}"><strong>${driftRows}</strong><span>Budget drift</span></div>
      <div class="tb-stat ${deadRoleRows ? 'tb-stat-bad' : 'tb-stat-good'}"><strong>${deadRoleRows}</strong><span>Dead-role tasks</span></div>
      <div class="tb-stat tb-stat-meta"><strong>±10 turns</strong><span>Drift threshold · fleet search filters sites</span></div>
    </section>
    <nav class="tb-pagination" aria-label="Task budget site pages"><span id="tb-page-status" class="muted" role="status" aria-live="polite"></span><label class="muted">Sites per page <select id="tb-page-size" class="cm-input" aria-label="Task budget sites per page">${[10, 20, 40].map(size => `<option value="${size}" ${size === TB_PAGE_SIZE ? 'selected' : ''}>${size}</option>`).join('')}</select></label><button type="button" class="btn sm" id="tb-page-prev" aria-label="Previous task budget sites" disabled>← Previous</button><button type="button" class="btn sm" id="tb-page-next" aria-label="Next task budget sites">Next →</button></nav>
    ${siteBlocks || '<div class="empty">No sites with backlog-driven roles found.</div>'}`;
  $('#task-budget-refresh').addEventListener('click', () => renderTaskBudget());
  const budgetCards = $$('.tb-site-card', app);
  const budgetPageSize = $('#tb-page-size');
  let budgetPage = 1;
  let lastFleetQuery = ($('#fleet-filter')?.value || '').trim().toLowerCase();
  const updateBudgetPage = () => {
    if (!$('#tb-page-status')) return;
    const query = ($('#fleet-filter')?.value || '').trim().toLowerCase();
    if (query !== lastFleetQuery) {
      lastFleetQuery = query;
      budgetPage = 1;
    }
    const matchingCards = budgetCards.filter(card => !card.classList.contains('fleet-hidden'));
    const pageSize = Number(budgetPageSize.value) || TB_PAGE_SIZE;
    const pageCount = Math.ceil(matchingCards.length / pageSize);
    budgetPage = Math.min(budgetPage, Math.max(1, pageCount));
    const start = (budgetPage - 1) * pageSize;
    const visible = new Set(matchingCards.slice(start, start + pageSize));
    budgetCards.forEach(card => card.classList.toggle('tb-page-hidden', !visible.has(card)));
    $('#tb-page-status').textContent = matchingCards.length
      ? `Showing sites ${start + 1}–${Math.min(start + pageSize, matchingCards.length)} of ${matchingCards.length}`
      : 'No sites match the current filter';
    $('#tb-page-prev').disabled = budgetPage <= 1 || !pageCount;
    $('#tb-page-next').disabled = !pageCount || budgetPage >= pageCount;
  };
  globalThis.updateTaskBudgetPagination = updateBudgetPage;
  budgetPageSize.addEventListener('change', () => {
    TB_PAGE_SIZE = Number(budgetPageSize.value) || 10;
    budgetPage = 1;
    updateBudgetPage();
  });
  $('#tb-page-prev').addEventListener('click', () => {
    budgetPage--;
    updateBudgetPage();
  });
  $('#tb-page-next').addEventListener('click', () => {
    budgetPage++;
    updateBudgetPage();
  });
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

/* ===================== AI INVENTORY ===================== */
async function renderAIInventory() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Tracing scheduled AI dispatches…</div></div>';
  let data;
  try {
    data = await api('GET', '/api/ai-inventory');
  } catch (e) {
    renderViewError(app, `AI inventory failed: ${e.message}`);
    return;
  }

  const s = data.summary || {};
  const aiBacked = s.ai || 0;
  const services = s.services || 0;
  const noAi = Math.max(0, services - aiBacked);
  const enabled = Math.max(0, aiBacked - (s.disabled || 0));
  const providerClass = r =>
    r.provider === 'None' ? 'b-gray' : r.policy === 'Local' ? 'b-purple' : 'b-blue';
  const status = r =>
    r.status === 'DISABLED'
      ? `<span class="badge b-gray" title="${esc(r.disabled_flag || '')}">disabled</span>`
      : '<span class="badge b-green">enabled</span>';
  const rows = (data.rows || [])
    .map(
      r => `<tr data-fleet-row data-site="${esc(r.domain)}">
    <td>${siteLink(r.domain)}</td>
    <td class="mono">${esc(r.service)}</td>
    <td><span class="badge ${providerClass(r)}">${esc(r.provider)}</span></td>
    <td class="mono">${esc(r.model)}</td>
    <td>${status(r)}${r.conditional ? ' <span class="badge b-yellow" title="Deterministic preflight; model is not called on every tick">conditional</span>' : ''}</td>
    <td><span class="mono muted" title="${esc(r.source)}">${esc(r.dispatch)}</span></td>
    <td>${esc(r.purpose)}${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}</td>
  </tr>`
    )
    .join('');
  const inventorySites = [...new Set((data.rows || []).map(row => row.domain))].sort();

  app.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">AI Inventory</h2><span class="muted">dispatch-aware provider and model audit of scheduled fleet services</span></div><button type="button" class="btn" id="ai-inventory-refresh">↻ Refresh</button></div>
    <section class="aii-summary" aria-label="AI inventory summary">
      <div class="aii-stat"><strong>${aiBacked}</strong><span>AI-backed services</span></div>
      <div class="aii-stat aii-stat-good"><strong>${enabled}</strong><span>Enabled</span></div>
      <div class="aii-stat"><strong>${s.remote || 0}</strong><span>Remote providers</span></div>
      <div class="aii-stat"><strong>${s.local || 0}</strong><span>Local providers</span></div>
      <div class="aii-stat ${s.disabled ? 'aii-stat-warn' : 'aii-stat-good'}"><strong>${s.disabled || 0}</strong><span>Disabled</span></div>
      <div class="aii-stat aii-stat-meta"><strong>${noAi}</strong><span>No-AI services · ${s.conditional || 0} conditional</span></div>
    </section>
    <div class="aii-controls" role="search" aria-label="Search AI services">
      <label>Find a service <input type="search" id="aii-search" aria-label="Search AI inventory by service, provider, model, dispatch, or function" placeholder="Service, provider, model, dispatch…"></label>
      <label>Site <select id="aii-site" aria-label="Filter AI inventory by site"><option value="">All sites</option>${inventorySites.map(site => `<option value="${esc(site)}">${esc(site)}</option>`).join('')}</select></label>
      <span id="aii-result-count" class="muted" role="status" aria-live="polite"></span>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <caption class="sr-only">AI service inventory</caption>
      <thead><tr><th>Site</th><th>Service</th><th>Provider</th><th>Model</th><th>Status</th><th>Dispatch</th><th>Function</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div></div>
    <details class="aii-help"><summary>How to interpret AI inventory</summary><p>“Claude CLI default (unpinned)” and aliases such as <span class="mono">sonnet</span>/<span class="mono">haiku</span> can change without a repository change. Conditional services run deterministic gates before spending model tokens. Rows marked no-AI remain visible to make classifier decisions auditable.</p></details>`;
  $('#ai-inventory-refresh').addEventListener('click', () => renderAIInventory());
  const inventoryTable = $('table', app);
  const inventoryRows = [...inventoryTable.tBodies[0].rows];
  inventoryRows.forEach(row => row.classList.add('aii-paginated-row'));
  const inventoryPageSize = 20;
  let inventoryPage = 0;
  const inventoryPager = document.createElement('nav');
  inventoryPager.className = 'aii-pagination';
  inventoryPager.setAttribute('aria-label', 'AI service inventory pages');
  inventoryPager.innerHTML =
    '<button type="button" class="btn sm" data-aii-page="prev" aria-controls="aii-inventory-table">← Previous</button><span class="muted" id="aii-page-status" aria-live="polite"></span><button type="button" class="btn sm" data-aii-page="next" aria-controls="aii-inventory-table">Next →</button>';
  inventoryTable.id = 'aii-inventory-table';
  inventoryTable.closest('.table-wrap').after(inventoryPager);
  const updateInventoryPage = () => {
    const query = $('#aii-search').value.trim().toLocaleLowerCase();
    const site = $('#aii-site').value;
    const filteredRows = inventoryRows.filter(
      row =>
        (!site || row.dataset.site === site) &&
        (!query || row.textContent.toLocaleLowerCase().includes(query))
    );
    const pageCount = Math.ceil(filteredRows.length / inventoryPageSize);
    inventoryPage = Math.min(inventoryPage, Math.max(0, pageCount - 1));
    const start = inventoryPage * inventoryPageSize;
    const visibleRows = new Set(filteredRows.slice(start, start + inventoryPageSize));
    inventoryRows.forEach(row => {
      row.hidden = !visibleRows.has(row);
    });
    $('#aii-result-count').textContent = filteredRows.length
      ? `Showing ${start + 1}–${Math.min(start + inventoryPageSize, filteredRows.length)} of ${filteredRows.length} services`
      : 'No services match these filters';
    $('#aii-page-status').textContent = pageCount
      ? `Page ${inventoryPage + 1} of ${pageCount}`
      : 'No pages';
    $('[data-aii-page="prev"]').disabled = inventoryPage === 0;
    $('[data-aii-page="next"]').disabled = !pageCount || inventoryPage >= pageCount - 1;
  };
  $('#aii-search').addEventListener('input', () => {
    inventoryPage = 0;
    updateInventoryPage();
  });
  $('#aii-site').addEventListener('change', () => {
    inventoryPage = 0;
    updateInventoryPage();
  });
  $('[data-aii-page="prev"]').addEventListener('click', () => {
    inventoryPage--;
    updateInventoryPage();
  });
  $('[data-aii-page="next"]').addEventListener('click', () => {
    inventoryPage++;
    updateInventoryPage();
  });
  updateInventoryPage();
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

/* ===================== PRODUCT FEED ===================== */
// tools/product-feed — shared, tagged product-candidate queue. Sites push
// sourced+judged candidates in, tagged subscribers claim/publish them one
// at a time. See that tool's README + the product-feed-dev skill.
function pfStatusBadge(status) {
  const cls =
    status === 'published'
      ? 'b-green'
      : status === 'claimed'
        ? 'b-yellow'
        : status === 'queued'
          ? 'b-gray'
          : 'b-red';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

async function renderProductFeed() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading product feed…</div></div>';
  const [health, stats, subs, products] = await Promise.all([
    api('GET', '/api/product-feed/health'),
    api('GET', '/api/product-feed/inventory-stats'),
    api('GET', '/api/product-feed/subscriptions'),
    api('GET', '/api/product-feed/products?limit=30'),
  ]);

  let healthHtml = '';
  if (health.ok === false) {
    healthHtml = `<div class="dh-down">⚠ product-feed API unreachable — ${esc(health.error || 'is the product-feed-api container running? (cd tools/product-feed && docker compose up -d)')}</div>`;
  }

  const subRows = (Array.isArray(subs) ? subs : [])
    .map(s => {
      const availableLabel = s.error
        ? `<span class="muted" title="${esc(s.error)}">—</span>`
        : `<span class="mono">${s.available ?? '—'} / ${s.target_available_depth ?? '—'}</span>`;
      const queueDepth = (s.queued || 0) + (s.publishing || 0);
      return `<tr data-fleet-row data-site="${esc(s.site)}">
      <td>${siteLink(s.site)}</td>
      <td>${(s.tags_any || []).map(t => `<span class="badge b-gray">${esc(t)}</span>`).join(' ')}</td>
      <td>${availableLabel}</td>
      <td class="mono">${s.reviewing || 0}</td>
      <td class="mono">${queueDepth}${s.max_queue_depth ? ` / ${s.max_queue_depth}` : ''}</td>
      <td class="mono">${s.published || 0}</td>
      <td class="mono">${s.rejected || 0}</td>
    </tr>`;
    })
    .join('');

  const productItems = (products && products.items) || [];
  const subscriptionRows = Array.isArray(subs) ? subs : [];
  const feedDeficits = subscriptionRows.filter(
    s =>
      s.available != null &&
      s.target_available_depth != null &&
      s.available < s.target_available_depth
  ).length;
  const feedQueue = subscriptionRows.reduce((n, s) => n + (s.queued || 0) + (s.publishing || 0), 0);
  const feedPublished = subscriptionRows.reduce((n, s) => n + (s.published || 0), 0);
  const feedRejected = subscriptionRows.reduce((n, s) => n + (s.rejected || 0), 0);
  const productRows = productItems
    .map(p => {
      const safeUrl =
        typeof p.amazon_url === 'string' && /^https?:\/\//i.test(p.amazon_url)
          ? p.amazon_url
          : `https://www.amazon.com/dp/${encodeURIComponent(p.asin || '')}`;
      return `<tr data-fleet-row>
    <td class="mono">${esc(p.last_verified_at || '')
      .slice(0, 16)
      .replace('T', ' ')}</td>
    <td><a href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer">${esc(p.title || p.asin)} ↗</a></td>
    <td class="mono">${esc(p.asin)}</td>
    <td>${esc(p.price || '—')}</td>
    <td>${p.rating == null ? '—' : `${esc(p.rating)} (${esc(p.review_count || 0)})`}</td>
    <td>${(p.tags || []).map(t => `<span class="badge b-gray">${esc(t)}</span>`).join(' ')}</td>
  </tr>`;
    })
    .join('');

  app.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">Product Feed</h2><span class="muted">Verified Amazon inventory for independent site publishing queues</span></div><button type="button" class="btn" id="product-feed-refresh">↻ Refresh</button></div>
    ${healthHtml}
    <section class="pf-summary" aria-label="Product feed summary">
      <div class="pf-stat"><strong>${subscriptionRows.length}</strong><span>Subscribed sites</span></div>
      <div class="pf-stat ${feedDeficits ? 'pf-stat-warn' : 'pf-stat-good'}"><strong>${feedDeficits}</strong><span>Queues below target</span></div>
      <div class="pf-stat"><strong>${feedQueue}</strong><span>Queued / publishing</span></div>
      <div class="pf-stat pf-stat-good"><strong>${feedPublished}</strong><span>Published</span></div>
      <div class="pf-stat ${feedRejected ? 'pf-stat-bad' : 'pf-stat-good'}"><strong>${feedRejected}</strong><span>Rejected</span></div>
      <div class="pf-stat pf-stat-meta"><strong>${stats.products || 0}</strong><span>Verified products</span></div>
    </section>
    <div class="card pf-panel">
      <h3>Subscriptions</h3>
      <div class="matrix-scroll-hint" role="note">Swipe horizontally to compare tags, inventory targets, queues, and outcomes</div>
      <div class="table-wrap"><table><caption class="sr-only">Product feed subscriptions and queue health</caption>
        <thead><tr><th>Site</th><th>Selection tags</th><th>Available / target</th><th>Reviewing</th><th>Selected queue / max</th><th>Published</th><th>Rejected</th></tr></thead>
        <tbody>${subRows || '<tr><td colspan="7" class="muted">No subscriptions registered — see registry/subscriptions.yaml</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="card pf-panel">
      <h3>Recently verified products <span class="muted pf-panel-count">Showing ${productItems.length} most recent</span></h3>
      <div class="matrix-scroll-hint" role="note">Swipe horizontally to inspect price, rating, and product tags</div>
      <div class="table-wrap"><table><caption class="sr-only">Most recently verified Amazon products</caption>
        <thead><tr><th>Verified</th><th>Exact Amazon product</th><th>ASIN</th><th>Price</th><th>Rating</th><th>Tags</th></tr></thead>
        <tbody>${productRows || '<tr><td colspan="6" class="muted">No verified products yet; collector will top up deficient subscriptions.</td></tr>'}</tbody>
      </table></div>
    </div>
    <details class="pf-help"><summary>How the product feed is maintained</summary><p>Subscriptions define each site's selection tags and target inventory depth. The collector fills deficits, routes products through review, and only publishes verified records; rejected items remain visible in the queue totals for auditability.</p></details>`;
  $$('.pf-panel .table-wrap', app).forEach(wrap => {
    const table = $('table', wrap);
    if (!table) return;
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', table.caption?.textContent?.trim() || 'Product feed table');
  });
  $('#product-feed-refresh').addEventListener('click', () => renderProductFeed());
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

/* ===================== AI USAGE ===================== */
// Real token usage/cost, rolled up from the per-site ledgers written by
// tools/scripts/claude-tracked.sh (server/aiusage.js -> tools/ai-usage/aggregate.py).
// Sites not yet migrated to the tracked wrapper (see tools/cron-roles/WIRING.md
// Step 6.5) show up under "not yet instrumented" rather than being hidden —
// most of the fleet will be in that bucket until sites are migrated one at a time.
function fmtTokens(n) {
  return (n || 0).toLocaleString();
}
function fmtUSD(n) {
  return `$${(n || 0).toFixed(2)}`;
}

function fmtDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

// Hover-help for table headers: title attr, plus a dotted underline (CSS)
// so it's discoverable without a legend.
function aiuTh(label, help) {
  return `<th class="aiu-th-help" title="${esc(help)}">${esc(label)}</th>`;
}
const AI_USAGE = { range: '7d', granularity: 'hour', from: '', to: '', site: '', role: '' };

// Quick-select presets for the Time range dropdown. Each carries its own
// sensible default granularity (short windows default to hourly bars, long
// ones to daily) — overridable any time via the Hourly/Daily toggle.
const AIU_PRESETS = [
  { key: 'today', label: 'Today', granularity: 'hour', days: 0 },
  { key: 'yesterday', label: 'Yesterday', granularity: 'hour', days: 1, single: true },
  { key: '24h', label: 'Last 24 hours', granularity: 'hour', days: 1 },
  { key: '3d', label: 'Last 3 days', granularity: 'hour', days: 2 },
  { key: '7d', label: 'Last 7 days', granularity: 'hour', days: 6 },
  { key: '30d', label: 'Last 30 days', granularity: 'day', days: 29 },
  { key: '90d', label: 'Last 90 days', granularity: 'day', days: 89 },
  { key: 'all', label: 'All time', granularity: 'day', days: null },
  { key: 'custom', label: 'Custom range…', granularity: null },
];

function utcDay(offset = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}
function aiUsageWindow(range) {
  const preset = AIU_PRESETS.find(p => p.key === range);
  if (!preset || range === 'custom') return { from: AI_USAGE.from, to: AI_USAGE.to };
  if (preset.days == null) return { from: '', to: '' };
  if (preset.single) return { from: utcDay(preset.days), to: utcDay(preset.days) };
  return { from: utcDay(preset.days), to: utcDay() };
}
function usageTotals(rows) {
  const totals = {
    calls: 0,
    errors: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_cost_usd: 0,
  };
  rows.forEach(row =>
    Object.keys(totals).forEach(key => {
      totals[key] += Number(row[key]) || 0;
    })
  );
  const cacheDenominator = totals.input_tokens + totals.cache_read_input_tokens;
  totals.cache_hit_ratio = cacheDenominator
    ? totals.cache_read_input_tokens / cacheDenominator
    : null;
  return totals;
}
function groupUsage(rows, key) {
  const groups = new Map();
  rows.forEach(row => {
    const value = row[key];
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  });
  return [...groups.entries()].map(([value, items]) => ({ [key]: value, ...usageTotals(items) }));
}
// Shared with the drag-to-zoom wiring below — the overlay math has to agree
// with the bar geometry pixel-for-pixel (viewBox units == px, see .aiu-chart
// in style.css: fixed height, 100% width).
const AIU_CHART_GEOM = { width: 760, height: 190, left: 44, bottom: 28, top: 12 };

function usageChart(rows, bucket) {
  if (!rows.length)
    return '<div class="aiu-chart-empty">No tracked usage for this selection.</div>';
  const { width, height, left, bottom, top } = AIU_CHART_GEOM;
  const max = Math.max(...rows.map(r => r.total_cost_usd), 0.01);
  const plotH = height - top - bottom;
  const step = (width - left - 10) / rows.length;
  const barW = Math.max(3, Math.min(28, step * 0.66));
  const bars = rows
    .map((r, index) => {
      const h = Math.max(2, (r.total_cost_usd / max) * plotH);
      const x = left + index * step + (step - barW) / 2;
      const y = height - bottom - h;
      const value = r[bucket];
      const label = bucket === 'hour' ? value.slice(11, 16) : value.slice(5);
      const showLabel =
        rows.length <= (bucket === 'hour' ? 48 : 31) || index === 0 || index === rows.length - 1;
      return `<g><title>${esc(value)}: ${fmtUSD(r.total_cost_usd)} · ${r.calls} calls · ${fmtTokens(r.input_tokens + r.output_tokens)} tokens</title><rect class="aiu-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2"/>${showLabel ? `<text class="aiu-chart-label" x="${(x + barW / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle">${esc(label)}</text>` : ''}</g>`;
    })
    .join('');
  const svg = `<svg id="aiu-chart-svg" class="aiu-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${bucket === 'hour' ? 'Hourly' : 'Daily'} AI usage cost chart"><line class="aiu-axis" x1="${left}" y1="${height - bottom}" x2="${width - 8}" y2="${height - bottom}"/><text class="aiu-chart-value" x="2" y="${top + 9}">${fmtUSD(max)}</text>${bars}</svg>`;
  return `<div id="aiu-chart-wrap" class="aiu-chart-wrap"><div id="aiu-chart-dragbox" class="aiu-chart-dragbox"></div>${svg}</div>`;
}

// Click-and-drag zoom, Grafana-style: drag a range on the chart to set the
// custom from/to window to the dragged buckets' day span. Re-wired every
// render (the old svg node — and its listeners — is discarded with
// innerHTML); the document-level move/up listeners are the only ones that
// outlive a render, so they ride an AbortController we replace each time.
let AIU_DRAG_ABORT = null;
function aiuChartVX(svg, clientX) {
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  if (!rect.width) return vb.x;
  return vb.x + ((clientX - rect.left) / rect.width) * vb.width;
}
function aiuChartIndexAt(vx, len) {
  const { left, width } = AIU_CHART_GEOM;
  const step = (width - left - 10) / len;
  return Math.max(0, Math.min(len - 1, Math.floor((vx - left) / step)));
}
function wireChartZoom(rows, bucket) {
  AIU_DRAG_ABORT?.abort();
  AIU_DRAG_ABORT = new AbortController();
  const { signal } = AIU_DRAG_ABORT;
  const svg = $('#aiu-chart-svg');
  const wrap = $('#aiu-chart-wrap');
  const box = $('#aiu-chart-dragbox');
  if (!svg || !wrap || !box || rows.length < 2) return;
  let drag = null;
  const setBox = (vxA, vxB) => {
    const lo = Math.min(vxA, vxB);
    const hi = Math.max(vxA, vxB);
    box.style.display = 'block';
    box.style.left = `${(lo / AIU_CHART_GEOM.width) * 100}%`;
    box.style.width = `${Math.max(0.3, ((hi - lo) / AIU_CHART_GEOM.width) * 100)}%`;
  };
  svg.addEventListener(
    'pointerdown',
    e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      drag = { startClientX: e.clientX, startVx: aiuChartVX(svg, e.clientX) };
      svg.setPointerCapture?.(e.pointerId);
      setBox(drag.startVx, drag.startVx);
      wrap.classList.add('dragging');
      e.preventDefault();
    },
    { signal }
  );
  document.addEventListener(
    'pointermove',
    e => {
      if (!drag) return;
      setBox(drag.startVx, aiuChartVX(svg, e.clientX));
    },
    { signal }
  );
  document.addEventListener(
    'pointerup',
    e => {
      if (!drag) return;
      const moved = Math.abs(e.clientX - drag.startClientX);
      const endVx = aiuChartVX(svg, e.clientX);
      const startIdx = aiuChartIndexAt(drag.startVx, rows.length);
      const endIdx = aiuChartIndexAt(endVx, rows.length);
      drag = null;
      box.style.display = 'none';
      wrap.classList.remove('dragging');
      if (moved < 6) return; // too small to be a drag — leave it to the native <title> hover
      const lo = Math.min(startIdx, endIdx);
      const hi = Math.max(startIdx, endIdx);
      AI_USAGE.range = 'custom';
      AI_USAGE.from = rows[lo][bucket].slice(0, 10);
      AI_USAGE.to = rows[hi][bucket].slice(0, 10);
      renderAIUsage();
    },
    { signal }
  );
  document.addEventListener(
    'pointercancel',
    e => {
      if (!drag) return;
      drag = null;
      box.style.display = 'none';
      wrap.classList.remove('dragging');
      svg.releasePointerCapture?.(e.pointerId);
    },
    { signal }
  );
}

async function renderAIUsage() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Aggregating AI token usage…</div></div>';
  if (AI_USAGE.range !== 'custom') Object.assign(AI_USAGE, aiUsageWindow(AI_USAGE.range));
  let data;
  const params = new URLSearchParams();
  if (AI_USAGE.from) params.set('from', AI_USAGE.from);
  if (AI_USAGE.to) params.set('to', AI_USAGE.to);
  try {
    data = await api('GET', `/api/ai-usage${params.size ? `?${params}` : ''}`);
  } catch (e) {
    renderViewError(app, `AI usage aggregation failed: ${e.message}`);
    return;
  }

  const rawRoles = data.by_site_role || [];
  const sites = [...new Set(rawRoles.map(r => r.site))].sort();
  const roles = [
    ...new Set(rawRoles.filter(r => !AI_USAGE.site || r.site === AI_USAGE.site).map(r => r.role)),
  ].sort();
  if (AI_USAGE.role && !roles.includes(AI_USAGE.role)) AI_USAGE.role = '';
  const activeRows = rawRoles.filter(
    r =>
      (!AI_USAGE.site || r.site === AI_USAGE.site) && (!AI_USAGE.role || r.role === AI_USAGE.role)
  );
  const s = usageTotals(activeRows);
  const bucket = AI_USAGE.granularity === 'hour' ? 'hour' : 'day';
  const timedRows = data[bucket === 'hour' ? 'by_hour_site_role' : 'by_day_site_role'] || [];
  const filteredPeriods = groupUsage(
    timedRows.filter(
      r =>
        (!AI_USAGE.site || r.site === AI_USAGE.site) && (!AI_USAGE.role || r.role === AI_USAGE.role)
    ),
    bucket
  ).sort((a, b) => a[bucket].localeCompare(b[bucket]));
  const siteRows = groupUsage(activeRows, 'site').sort(
    (a, b) => b.total_cost_usd - a.total_cost_usd
  );
  const roleRows = activeRows.slice().sort((a, b) => b.total_cost_usd - a.total_cost_usd);
  const rawSummary = data.summary || {};
  const runtimeModels = (data.by_model || [])
    .slice()
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd);
  const requestedModels = (data.by_requested_model || [])
    .slice()
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd);
  const usageAlerts = (data.alerts || []).slice(0, 10);
  const usageIncidents = data.incidents || [];
  const ledgerDiagnostics = data.diagnostics || {};
  const modelDriftCalls = rawSummary.model_drift_calls || 0;
  const modelDriftCostUsd = rawSummary.model_drift_cost_usd || 0;
  const modelDriftRows = (data.by_site_role_model_drift || [])
    .slice()
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd);
  const mixedCompactionCalls = rawSummary.mixed_compaction_calls || 0;
  const mixedCompactionCostUsd = rawSummary.mixed_compaction_cost_usd || 0;
  const wiredAwaiting = rawSummary.sites_wired_awaiting_first_run || [];
  const notWired = rawSummary.sites_not_wired || [];
  const noAiRole = rawSummary.sites_no_ai_role || [];
  const coverageRows = (data.coverage || [])
    .filter(r => !AI_USAGE.site || r.site === AI_USAGE.site)
    .map(r => {
      const label =
        r.status === 'reporting'
          ? 'reporting'
          : r.status === 'wired_awaiting_first_run'
            ? 'wired — awaiting first call'
            : r.status === 'not_wired'
              ? 'untracked call path'
              : 'no AI call path';
      const badge =
        r.status === 'reporting' ? 'b-green' : r.status === 'not_wired' ? 'b-red' : 'b-gray';
      return `<tr data-fleet-row data-site="${esc(r.site)}"><td>${siteLink(r.site)}</td><td><span class="badge ${badge}">${esc(label)}</span></td></tr>`;
    })
    .join('');

  const siteTableRows = siteRows
    .map(
      r => `<tr data-fleet-row data-site="${esc(r.site)}">
    <td>${siteLink(r.site)}</td>
    <td>${r.calls}</td>
    <td>${r.errors ? `<span class="badge b-red">${r.errors}</span>` : '<span class="muted">0</span>'}</td>
    <td class="mono">${fmtTokens(r.input_tokens)}</td>
    <td class="mono">${fmtTokens(r.output_tokens)}</td>
    <td class="mono">${fmtTokens(r.cache_read_input_tokens)}</td>
    <td class="mono">${fmtTokens(r.cache_creation_input_tokens)}</td>
    <td class="mono">${r.cache_hit_ratio != null ? `${Math.round(r.cache_hit_ratio * 100)}%` : '<span class="muted">—</span>'}</td>
    <td class="mono">${fmtUSD(r.total_cost_usd)}</td>
  </tr>`
    )
    .join('');

  const roleTableRows = roleRows
    .map(
      r => `<tr data-fleet-row data-site="${esc(r.site)}">
    <td>${siteLink(r.site)}</td>
    <td class="mono">${esc(r.role)}</td>
    <td>${r.calls}</td>
    <td class="mono">${fmtTokens(r.input_tokens)}</td>
    <td class="mono">${fmtTokens(r.output_tokens)}</td>
    <td class="mono">${fmtUSD(r.total_cost_usd)}</td>
  </tr>`
    )
    .join('');

  const periodRows = filteredPeriods
    .map(
      r => `<tr>
    <td class="mono">${esc(r[bucket])}</td>
    <td>${r.calls}</td>
    <td class="mono">${fmtTokens(r.input_tokens + r.output_tokens)}</td>
    <td class="mono">${fmtUSD(r.total_cost_usd)}</td>
  </tr>`
    )
    .join('');
  const runtimeModelRows = runtimeModels
    .map(
      r =>
        `<tr><td>${esc(r.provider)}</td><td class="mono">${esc(r.model)}</td><td>${r.calls}</td><td class="mono">${fmtTokens(r.output_tokens)}</td><td class="mono">${fmtUSD(r.total_cost_usd)}</td></tr>`
    )
    .join('');
  const requestedModelRows = requestedModels
    .map(
      r =>
        `<tr><td class="mono">${esc(r.requested_model)}</td><td>${r.calls}</td><td class="mono">${fmtUSD(r.total_cost_usd)}</td></tr>`
    )
    .join('');
  const alertOutcomeBadge = r => {
    if (r.hit_max_turns) return '<span class="badge b-gray">turn cap</span>';
    if (r.model_drift)
      return `<span class="badge b-red">model drift</span>${r.is_error ? ' <span class="badge b-red">failed</span>' : ''}`;
    if (r.actionable) return '<span class="badge b-red">failed</span>';
    return '<span class="badge b-gray">transient</span>';
  };
  const alertRows = usageAlerts
    .map(
      r => `<tr>
    <td>${siteLink(r.site)}</td>
    <td class="mono">${esc(r.role)}</td>
    <td>${alertOutcomeBadge(r)}</td>
    <td class="mono">${r.model_drift ? `${esc(r.requested_model || '?')} → ${esc(r.model || '?')}` : `${r.num_turns || 0}/${r.requested_max_turns || '—'}`}</td>
    <td class="mono">${fmtUSD(r.total_cost_usd)}</td>
  </tr>`
    )
    .join('');
  const incidentRows = usageIncidents
    .map(
      r => `<tr>
    <td><span class="badge ${r.severity >= 3 ? 'b-red' : 'b-gray'}">${esc(r.alert_kind)}</span></td>
    <td class="mono">${esc(r.failure_class || '—')}</td>
    <td>${r.calls}</td>
    <td>${r.sites.length}</td>
    <td class="mono">${fmtUSD(r.total_cost_usd)}</td>
    <td class="mono">${esc(r.first_day)} → ${esc(r.last_day)}</td>
  </tr>`
    )
    .join('');

  const modelDriftRowsHtml = modelDriftRows
    .map(
      r => `<tr>
    <td>${siteLink(r.site)}</td>
    <td class="mono">${esc(r.role)}</td>
    <td>${r.calls}</td>
    <td class="mono">${fmtUSD(r.total_cost_usd)}</td>
  </tr>`
    )
    .join('');

  const diagnosticsCount =
    usageAlerts.length +
    usageIncidents.length +
    notWired.length +
    modelDriftRows.length +
    (ledgerDiagnostics.malformed_json || 0) +
    (ledgerDiagnostics.invalid_records || 0);
  const diagnosticsBadge = diagnosticsCount
    ? `<span class="badge b-red">${diagnosticsCount}</span>`
    : `<span class="badge b-green">clean</span>`;

  app.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">AI Usage</h2><span class="muted">real token usage/cost captured by tools/scripts/claude-tracked.sh, aggregated fleet-wide</span></div><button type="button" class="btn" id="aiu-refresh">↻ Refresh</button></div>
    <div class="aiu-controls" aria-label="AI usage filters">
      <label>Time range
        <select id="aiu-quick-select">${AIU_PRESETS.map(
          p =>
            `<option value="${esc(p.key)}" ${AI_USAGE.range === p.key ? 'selected' : ''}>${esc(p.label)}</option>`
        ).join('')}</select>
      </label>
      <div class="aiu-granularity" role="group" aria-label="Usage resolution">
        ${[
          ['hour', 'Hourly'],
          ['day', 'Daily'],
        ]
          .map(
            ([value, label]) =>
              `<button class="btn sm aiu-granularity-btn ${AI_USAGE.granularity === value ? 'active' : ''}" data-granularity="${value}">${label}</button>`
          )
          .join('')}
      </div>
      ${
        AI_USAGE.range === 'custom'
          ? `<label>From <input id="aiu-from" type="date" value="${esc(AI_USAGE.from)}"></label>
      <label>To <input id="aiu-to" type="date" value="${esc(AI_USAGE.to)}"></label>
      <button id="aiu-apply-custom" class="btn sm">Apply dates</button>`
          : ''
      }
      <label>Site <select id="aiu-site"><option value="">All reporting sites</option>${sites.map(site => `<option value="${esc(site)}" ${AI_USAGE.site === site ? 'selected' : ''}>${esc(site)}</option>`).join('')}</select></label>
      <label>Role <select id="aiu-role"><option value="">All roles</option>${roles.map(role => `<option value="${esc(role)}" ${AI_USAGE.role === role ? 'selected' : ''}>${esc(role)}</option>`).join('')}</select></label>
    </div>
    <section class="aiu-summary" aria-label="AI usage summary">
      <div class="aiu-stat aiu-stat-cost"><strong>${fmtUSD(s.total_cost_usd)}</strong><span>Tracked spend</span></div>
      <div class="aiu-stat"><strong>${s.calls || 0}</strong><span>Calls</span></div>
      <div class="aiu-stat"><strong>${fmtTokens((s.input_tokens || 0) + (s.output_tokens || 0))}</strong><span>Input + output tokens</span></div>
      <div class="aiu-stat"><strong>${s.cache_hit_ratio != null ? `${Math.round(s.cache_hit_ratio * 100)}%` : '—'}</strong><span>Cache hit</span></div>
      <div class="aiu-stat"><strong>${rawSummary.sites_instrumented || 0}<small>/${rawSummary.sites_total || 0}</small></strong><span>Sites instrumented</span></div>
    </section>
    ${
      modelDriftCalls
        ? `<div class="aiu-notice aiu-notice-danger" role="alert">⚠ <strong>${modelDriftCalls} call${modelDriftCalls === 1 ? '' : 's'}</strong> resolved to a different model family than requested this period (${fmtUSD(modelDriftCostUsd)} — see "Alerts &amp; coverage" below). Caught by claude-tracked.sh's requested-vs-actual model check.</div>`
        : ''
    }
    ${
      mixedCompactionCalls
        ? `<div class="aiu-notice" role="note">ℹ <strong>${mixedCompactionCalls} call${mixedCompactionCalls === 1 ? '' : 's'}</strong> included multiple model families (${fmtUSD(mixedCompactionCostUsd)}). These are tracked as mixed compaction usage, not model drift, when the requested family is present.</div>`
        : ''
    }
    <div class="card aiu-chart-card">
      <div class="task-toolbar"><strong>${bucket === 'hour' ? 'Hourly' : 'Daily'} spend</strong><span class="muted">Hover a bar for cost, calls, and tokens · drag across bars to zoom into that range. Times are UTC.</span>${AI_USAGE.range === 'custom' ? '<button id="aiu-reset-zoom" class="btn sm">↺ Reset zoom</button>' : ''}</div>
      ${usageChart(filteredPeriods, bucket)}
    </div>
    <div class="card aiu-panel">
      <div class="task-toolbar"><strong>Runtime model resolution</strong><span class="muted">Observed model comes from Claude's response; requested model is the caller's flag. Differences expose alias/routing drift.</span></div>
      ${
        runtimeModelRows
          ? `<div class="table-wrap"><table><thead><tr>${aiuTh('Provider', 'AI provider/runtime that served the call.')}${aiuTh('Observed model', "Model Claude's response actually reports it ran — read from the API response, not the caller's --model flag.")}${aiuTh('Calls', 'Number of tracked claude -p invocations in this selection.')}${aiuTh('Output tok', 'Output tokens generated by the model.')}${aiuTh('Cost', 'total_cost_usd reported by the CLI for these calls.')}</tr></thead><tbody>${runtimeModelRows}</tbody></table></div>`
          : '<div class="empty">No model records yet.</div>'
      }
      ${
        requestedModelRows
          ? `<div class="task-toolbar aiu-subhead"><strong>Requested models</strong></div><div class="table-wrap"><table><thead><tr>${aiuTh('Requested model', 'Model alias/name the caller asked for via --model.')}${aiuTh('Calls', 'Number of tracked claude -p invocations in this selection.')}${aiuTh('Cost', 'total_cost_usd reported by the CLI for these calls.')}</tr></thead><tbody>${requestedModelRows}</tbody></table></div>`
          : ''
      }
    </div>
    <div class="card aiu-panel">
      <div class="task-toolbar"><strong>By site</strong></div>
      ${
        siteTableRows
          ? `<div class="table-wrap"><table>
        <thead><tr>${aiuTh('Site', 'Site slug (sites/<name>).')}${aiuTh('Calls', 'Number of tracked claude -p invocations in this selection.')}${aiuTh('Errors', 'Calls that returned is_error = true.')}${aiuTh('Input tok', 'Input tokens billed (excludes cache read/write tokens).')}${aiuTh('Output tok', 'Output tokens generated by the model.')}${aiuTh('Cache read', "Tokens served from Anthropic's prompt cache — cheaper than fresh input tokens.")}${aiuTh('Cache write', 'Tokens written to the prompt cache on this call (cache_creation_input_tokens).')}${aiuTh('Cache hit', 'Share of (input + cache-read) tokens that came from cache: cache_read / (input + cache_read).')}${aiuTh('Cost', 'total_cost_usd reported by the CLI for these calls.')}</tr></thead>
        <tbody>${siteTableRows}</tbody>
      </table></div>`
          : '<div class="empty">No tracked usage yet.</div>'
      }
    </div>
    <div class="card aiu-panel">
      <div class="task-toolbar"><strong>By site &amp; role</strong></div>
      ${
        roleTableRows
          ? `<div class="table-wrap"><table>
        <thead><tr>${aiuTh('Site', 'Site slug (sites/<name>).')}${aiuTh('Role', 'Cron role that made the call (e.g. writer, engineer, watchdog).')}${aiuTh('Calls', 'Number of tracked claude -p invocations in this selection.')}${aiuTh('Input tok', 'Input tokens billed (excludes cache read/write tokens).')}${aiuTh('Output tok', 'Output tokens generated by the model.')}${aiuTh('Cost', 'total_cost_usd reported by the CLI for these calls.')}</tr></thead>
        <tbody>${roleTableRows}</tbody>
      </table></div>`
          : '<div class="empty">No tracked usage yet.</div>'
      }
    </div>
    <div class="card aiu-panel">
      <div class="task-toolbar"><strong>By ${bucket === 'hour' ? 'hour' : 'day'}</strong></div>
      ${
        periodRows
          ? `<div class="table-wrap"><table>
        <thead><tr>${aiuTh(bucket === 'hour' ? 'Hour (UTC)' : 'Day (UTC)', 'Bucket start, UTC.')}${aiuTh('Calls', 'Number of tracked claude -p invocations in this selection.')}${aiuTh('Total tokens', 'Input + output tokens for the period (excludes cache read/write).')}${aiuTh('Cost', 'total_cost_usd reported by the CLI for these calls.')}</tr></thead>
        <tbody>${periodRows}</tbody>
      </table></div>`
          : `<div class="empty">${bucket === 'hour' ? 'No timestamped usage in this selection.' : 'No tracked usage yet.'}</div>`
      }
    </div>
    <details class="card aiu-diagnostics">
      <summary><strong>Alerts &amp; coverage</strong> ${diagnosticsBadge} <span class="muted">cost-control alerts, wiring gaps, and which sites are/aren't instrumented</span></summary>
      <div class="aiu-diagnostics-body">
        ${
          usageIncidents.length
            ? `
        <div class="task-toolbar aiu-subhead"><strong>Alert incidents</strong><span class="muted">Grouped by failure category so fleet-wide outages remain visible above the individual-call sample.</span></div>
        <div class="table-wrap"><table><thead><tr>${aiuTh('Category', 'Normalized alert category.')}${aiuTh('Failure class', 'Producer failure classification.')}${aiuTh('Calls', 'Number of affected calls.')}${aiuTh('Sites', 'Number of affected sites.')}${aiuTh('Cost', 'Total cost of affected calls.')}${aiuTh('Window', 'First and last ledger day.')}</tr></thead><tbody>${incidentRows}</tbody></table></div>`
            : ''
        }
        ${
          usageAlerts.length
            ? `
        <div class="task-toolbar aiu-subhead"><strong>Recent cost-control alerts</strong><span class="muted">runs that hit the turn cap, errored, or resolved to a different model than requested — highest severity first, last 10</span></div>
        <div class="table-wrap"><table><thead><tr>${aiuTh('Site', 'Site slug (sites/<name>).')}${aiuTh('Role', 'Cron role that made the call.')}${aiuTh('Outcome', 'Why this call is flagged: hit the turn cap, errored, or resolved to a different model than requested.')}${aiuTh('Detail', 'Model drift shows requested → actual model; otherwise shows turns used / requested max turns.')}${aiuTh('Cost', 'total_cost_usd reported by the CLI for this call.')}</tr></thead><tbody>${alertRows}</tbody></table></div>`
            : ''
        }
        ${
          modelDriftRows.length
            ? `
        <div class="task-toolbar aiu-subhead"><strong>Model drift by site &amp; role</strong><span class="muted">requested model resolved to a different family (opus/sonnet/haiku) than the CLI actually ran — see claude-tracked.sh</span></div>
        <div class="table-wrap"><table><thead><tr>${aiuTh('Site', 'Site slug (sites/<name>).')}${aiuTh('Role', 'Cron role that made the call.')}${aiuTh('Calls', 'Calls where the resolved model family differed from the requested one.')}${aiuTh('Cost', 'total_cost_usd reported by the CLI for these calls.')}</tr></thead><tbody>${modelDriftRowsHtml}</tbody></table></div>`
            : ''
        }
        ${notWired.length ? `<div class="aiu-notice aiu-notice-danger" role="alert">⚠ Has AI cron calls but NOT wired to claude-tracked.sh (${notWired.length}): ${notWired.map(esc).join(', ')}. See <span class="mono">tools/cron-roles/WIRING.md</span> Step 6.5.</div>` : ''}
        ${wiredAwaiting.length ? `<div class="aiu-notice" role="note">Wired, awaiting first cron fire (${wiredAwaiting.length}): ${wiredAwaiting.map(esc).join(', ')}.</div>` : ''}
        ${noAiRole.length ? `<div class="aiu-notice" role="note">No AI cron role at all — nothing to track (${noAiRole.length}): ${noAiRole.map(esc).join(', ')}.</div>` : ''}
        ${ledgerDiagnostics.malformed_json || ledgerDiagnostics.invalid_records ? `<div class="aiu-notice aiu-notice-danger" role="alert">⚠ Ledger quality: ${ledgerDiagnostics.malformed_json || 0} malformed JSON line${ledgerDiagnostics.malformed_json === 1 ? '' : 's'}, ${ledgerDiagnostics.invalid_records || 0} invalid record${ledgerDiagnostics.invalid_records === 1 ? '' : 's'} skipped.</div>` : ''}
        <div class="task-toolbar aiu-subhead aiu-subhead-late"><strong>Fleet tracking coverage</strong><span class="muted">Every site, including ones with no AI call path.</span></div>
        <div class="table-wrap"><table><thead><tr>${aiuTh('Site', 'Site slug (sites/<name>).')}${aiuTh('Tracking status', 'Whether this site’s AI calls are wired to claude-tracked.sh and have ledger data — see tools/cron-roles/WIRING.md Step 6.5.')}</tr></thead><tbody>${coverageRows}</tbody></table></div>
      </div>
    </details>`;
  const aiuFilterLabels = {
    'aiu-quick-select': 'Select AI usage time range',
    'aiu-from': 'AI usage start date',
    'aiu-to': 'AI usage end date',
    'aiu-site': 'Filter AI usage by site',
    'aiu-role': 'Filter AI usage by role',
  };
  Object.entries(aiuFilterLabels).forEach(([id, label]) => {
    const control = $(`#${id}`);
    if (control) control.setAttribute('aria-label', label);
  });
  const aiuTableLabels = [
    'Runtime model resolution',
    'Requested model usage',
    'AI usage by site',
    'AI usage by site and role',
    `AI usage by ${bucket === 'hour' ? 'hour' : 'day'}`,
    'AI usage alert incidents',
    'Recent AI usage alerts',
    'AI usage tracking coverage',
  ];
  $$('.aiu-panel table, .aiu-diagnostics table', app).forEach((table, index) => {
    if (!table.querySelector('caption')) {
      const caption = document.createElement('caption');
      caption.className = 'sr-only';
      caption.textContent = aiuTableLabels[index] || 'AI usage data table';
      table.prepend(caption);
    }
    const wrap = table.closest('.table-wrap');
    const panel = table.closest('.aiu-panel, .aiu-diagnostics');
    if (wrap && panel && !$('.aiu-scroll-hint', panel)) {
      const hint = document.createElement('div');
      hint.className = 'aiu-scroll-hint';
      hint.setAttribute('role', 'note');
      hint.textContent = 'Swipe horizontally to inspect all columns';
      wrap.before(hint);
    }
  });
  const aiuPageSize = 20;
  $$('.aiu-panel table, .aiu-diagnostics table', app).forEach((table, index) => {
    const rows = [...table.tBodies].flatMap(body => [...body.rows]);
    if (rows.length <= aiuPageSize) return;
    const label = table.caption?.textContent || 'AI usage table';
    const tableId = `aiu-table-${index}`;
    table.id = tableId;
    rows.forEach(row => row.classList.add('aiu-paginated-row'));
    const pager = document.createElement('nav');
    pager.className = 'aiu-pagination';
    pager.setAttribute('aria-label', `${label} pages`);
    pager.innerHTML = `<span class="aiu-page-status" aria-live="polite"></span><div><button type="button" class="btn sm" data-aiu-page="prev" aria-controls="${tableId}">← Previous</button><button type="button" class="btn sm" data-aiu-page="next" aria-controls="${tableId}">Next →</button></div>`;
    table.closest('.table-wrap').after(pager);
    let page = 0;
    const status = $('.aiu-page-status', pager);
    const previous = $('[data-aiu-page="prev"]', pager);
    const next = $('[data-aiu-page="next"]', pager);
    const updatePage = () => {
      const pageCount = Math.ceil(rows.length / aiuPageSize);
      const start = page * aiuPageSize;
      rows.forEach((row, rowIndex) => {
        row.hidden = rowIndex < start || rowIndex >= start + aiuPageSize;
      });
      status.textContent = `${start + 1}–${Math.min(start + aiuPageSize, rows.length)} of ${rows.length}`;
      previous.disabled = page === 0;
      next.disabled = page >= pageCount - 1;
    };
    previous.addEventListener('click', () => {
      page = Math.max(0, page - 1);
      updatePage();
    });
    next.addEventListener('click', () => {
      page = Math.min(Math.ceil(rows.length / aiuPageSize) - 1, page + 1);
      updatePage();
    });
    updatePage();
  });
  $('#aiu-quick-select').addEventListener('change', event => {
    const key = event.target.value;
    AI_USAGE.range = key;
    const preset = AIU_PRESETS.find(p => p.key === key);
    if (key !== 'custom') {
      Object.assign(AI_USAGE, aiUsageWindow(key));
      if (preset && preset.granularity) AI_USAGE.granularity = preset.granularity;
    }
    renderAIUsage();
  });
  $$('.aiu-granularity-btn').forEach(button =>
    button.addEventListener('click', () => {
      AI_USAGE.granularity = button.dataset.granularity;
      renderAIUsage();
    })
  );
  $('#aiu-refresh').addEventListener('click', () => renderAIUsage());
  $('#aiu-site').addEventListener('change', event => {
    AI_USAGE.site = event.target.value;
    AI_USAGE.role = '';
    renderAIUsage();
  });
  $('#aiu-role').addEventListener('change', event => {
    AI_USAGE.role = event.target.value;
    renderAIUsage();
  });
  const applyCustom = $('#aiu-apply-custom');
  if (applyCustom)
    applyCustom.addEventListener('click', () => {
      const from = $('#aiu-from').value;
      const to = $('#aiu-to').value;
      if (!from || !to || from > to) {
        toast('Choose a valid start and end date', 'error');
        return;
      }
      AI_USAGE.from = from;
      AI_USAGE.to = to;
      renderAIUsage();
    });
  const resetZoom = $('#aiu-reset-zoom');
  if (resetZoom)
    resetZoom.addEventListener('click', () => {
      AI_USAGE.range = '7d';
      AI_USAGE.granularity = 'hour';
      Object.assign(AI_USAGE, aiUsageWindow('7d'));
      renderAIUsage();
    });
  wireChartZoom(filteredPeriods, bucket);
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

/* ===================== DEPLOYS ===================== */
// F27: dedicated panel for the CF deploy-health poller (server/deployhealth.js)
// — today it only folds into the deployer role-matrix cell tooltip; this
// surfaces the raw {live, version, deployedAt, error} per site in a table so a
// CF-side deploy failure is visible without hovering a dot or opening devtools.
async function renderDeployHealth() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div class="page-head"><div><h2 class="page-title">Deploys</h2><span class="muted">Production deployment telemetry and build state across the fleet</span></div></div><div role="status" aria-live="polite"><div class="loading">Loading deploy health…</div></div>';
  let d;
  try {
    d = await api('GET', '/api/deploy-health');
  } catch (e) {
    renderViewError(app, `Deploy health failed: ${e.message}`);
    return;
  }

  const sites = Object.values(d.sites || {}).sort((a, b) => a.slug.localeCompare(b.slug));
  const counts = sites.reduce((out, site) => {
    const key =
      site.status || (site.live === true ? 'live' : site.live === false ? 'behind' : 'unknown');
    out[key] = (out[key] || 0) + 1;
    return out;
  }, {});
  const live = counts.live || 0;
  const opsOnly = counts['ops-only'] || 0;
  const deploying = counts.deploying || 0;
  const behind = counts.behind || 0;
  const failed = counts.failed || 0;
  const unknown = counts.unknown || 0;

  const body = sites
    .map(s => {
      const status =
        s.status || (s.live === true ? 'live' : s.live === false ? 'behind' : 'unknown');
      const badgeClass =
        {
          live: 'b-green',
          'ops-only': 'b-blue',
          deploying: 'b-yellow',
          behind: 'b-yellow',
          failed: 'b-red',
          unknown: 'b-gray',
        }[status] || 'b-gray';
      const badgeLabel =
        {
          live: 'live',
          'ops-only': 'ops-only',
          deploying: 'deploying',
          behind: 'site changes pending',
          failed: 'build failed',
          unknown: 'unknown',
        }[status] || status;
      const badge = `<span class="badge ${badgeClass}">${badgeLabel}</span>`;
      const deployedAt = s.deployedAt ? new Date(s.deployedAt * 1000).toLocaleString() : '—';
      return `<tr class="deploy-row" data-fleet-row data-site="${esc(s.slug)}" data-deploy-name="${esc(`${s.slug} ${s.worker || ''} ${s.reason || s.error || ''}`.toLowerCase())}" data-deploy-status="${esc(status)}">
      <td class="site">${siteLink(s.slug)}</td>
      <td class="mono muted">${esc(s.worker || '—')}</td>
      <td>${badge}</td>
      <td class="mono">${s.version != null ? esc(String(s.version)) : '—'}</td>
      <td class="mono muted">${esc(deployedAt)}</td>
      <td>${esc(s.reason || s.error || '—')}</td>
    </tr>`;
    })
    .join('');

  const swept = d.lastSweep ? fmtAge((Date.now() - d.lastSweep) / 1000) + ' ago' : 'never';
  app.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">Deploys</h2><span class="muted">Production status is based on the latest deployable site commit; ops-only commits do not count as deploy failures.</span></div><button type="button" class="btn" id="deploy-refresh">↻ Refresh</button></div>
    <section class="deploy-summary-grid" aria-label="Deployment summary">
      <div class="deploy-stat deploy-stat-good"><strong>${live}</strong><span>Live</span></div>
      <div class="deploy-stat"><strong>${opsOnly}</strong><span>Ops-only</span></div>
      <div class="deploy-stat deploy-stat-warn"><strong>${deploying + behind}</strong><span>Pending / deploying</span></div>
      <div class="deploy-stat ${failed ? 'deploy-stat-bad' : 'deploy-stat-good'}"><strong>${failed}</strong><span>Build failed</span></div>
      <div class="deploy-stat ${unknown ? 'deploy-stat-warn' : ''}"><strong>${unknown}</strong><span>Unknown</span></div>
      <div class="deploy-stat deploy-stat-meta"><strong>${esc(swept)}</strong><span>Last sweep · ${sites.length} sites</span></div>
    </section>
    <div class="deploy-controls" role="group" aria-label="Filter deployments">
      <label class="deploy-search"><span class="sr-only">Search deployments</span><input id="deploy-search" class="cm-input" type="search" placeholder="Search site, worker, or status detail…" value="${esc(DEPLOY_FILTER.q)}" autocomplete="off" /></label>
      <label><span class="sr-only">Deployment status</span><select id="deploy-status" class="cm-input"><option value="all">All statuses</option><option value="live">Live</option><option value="ops-only">Ops-only</option><option value="deploying">Deploying</option><option value="behind">Site changes pending</option><option value="failed">Build failed</option><option value="unknown">Unknown</option></select></label>
      <span id="deploy-filter-count" class="muted" role="status" aria-live="polite"></span>
    </div>
    <div class="card deploy-table"><div class="matrix-scroll-hint" role="note">Swipe horizontally to compare deployment status, versions, and errors</div><div class="table-wrap" tabindex="0" role="region" aria-label="Deployment health by site"><table>
      <caption class="sr-only">Deployment health by site</caption>
      <thead><tr><th>Site</th><th>Worker</th><th>Status</th><th>Version</th><th>Deployed at</th><th>Error</th></tr></thead>
      <tbody>${body || '<tr><td colspan="6" class="muted">No deploy-health data yet — either no CF credentials are configured, or the poller hasn\'t swept yet.</td></tr>'}</tbody>
    </table></div></div>
    <details class="deploy-help"><summary>How deployment status is determined</summary><p><b>live</b> = the latest deployable <code>site/</code> commit is serving. <b>ops-only</b> = newer operational files do not affect production. <b>deploying</b>/<b>site changes pending</b> = production may need a build, but failure is not confirmed. <b>build failed</b> = Cloudflare reported a failed build. <b>unknown</b> = telemetry is unavailable. Refreshed every 5 minutes in the background.</p></details>`;
  $('#deploy-refresh').addEventListener('click', () => renderDeployHealth());
  $('#deploy-status').value = DEPLOY_FILTER.status;
  $('#deploy-search').addEventListener('input', e => {
    DEPLOY_FILTER.q = e.target.value;
    applyDeployFilter();
  });
  $('#deploy-status').addEventListener('change', e => {
    DEPLOY_FILTER.status = e.target.value;
    applyDeployFilter();
  });
  applyDeployFilter();
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

function applyDeployFilter() {
  const q = DEPLOY_FILTER.q.trim().toLowerCase();
  const rows = $$('.deploy-row');
  const visible = rows.filter(row => {
    const matchesQuery = !q || (row.dataset.deployName || '').includes(q);
    const matchesStatus =
      DEPLOY_FILTER.status === 'all' || row.dataset.deployStatus === DEPLOY_FILTER.status;
    const show = matchesQuery && matchesStatus;
    row.classList.toggle('deploy-filter-hidden', !show);
    return show;
  });
  const count = $('#deploy-filter-count');
  if (count) count.textContent = `${visible.length}/${rows.length} shown`;
}

/* ===================== CLOUDFLARE BUILDS ===================== */
// Live Workers Builds configuration plus a persisted seven-day build/commit
// history. The server refreshes Cloudflare hourly; this view only
// reads the sanitized cache, so auto-refresh is cheap.
const CF_BUILDS = {
  days: 7,
  pageSize: 10,
  pages: { repos: 1, builds: 1, triggers: 1 },
  cache: null,
  filter: '',
  filterTimer: null,
};

function cfbMinutes(value) {
  const n = Number(value) || 0;
  return n >= 1000
    ? `${Math.round(n).toLocaleString()} min`
    : `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })} min`;
}

function cfbDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return '—';
  return s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function cfbUnitPrice(value) {
  return `$${(Number(value) || 0).toFixed(3)}`;
}

function cfbRepoLink(account, repo) {
  const href = safeHref(
    `https://github.com/${encodeURIComponent(account || 'bourneash')}/${encodeURIComponent(repo)}`
  );
  return href
    ? `<a class="site-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(repo)}<span class="ext">↗</span></a>`
    : esc(repo || 'unknown');
}

function cfbCommitLink(build) {
  if (!build.commitHash) return '<span class="muted">—</span>';
  const href = safeHref(
    `https://github.com/${encodeURIComponent(build.providerAccount || 'bourneash')}/${encodeURIComponent(build.repo)}/commit/${encodeURIComponent(build.commitHash)}`
  );
  const short = build.commitHash.slice(0, 7);
  return href
    ? `<a class="mono cfb-commit" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(short)}</a>`
    : `<span class="mono">${esc(short)}</span>`;
}

function cfbBadge(outcome) {
  if (outcome === 'success') return '<span class="badge b-green">success</span>';
  if (outcome === 'fail' || outcome === 'terminated')
    return `<span class="badge b-red">${esc(outcome)}</span>`;
  return `<span class="badge b-gray">${esc(outcome || 'running')}</span>`;
}

function cfbChart(rows) {
  if (!rows.length) return '<div class="cfb-chart-empty">No builds in this period.</div>';
  const max = Math.max(...rows.map(row => Number(row.minutes) || 0), 1);
  return `<div class="cfb-chart" role="img" aria-label="Daily Cloudflare build minutes">
    ${rows
      .map(row => {
        const height = Math.max(2, Math.round(((Number(row.minutes) || 0) / max) * 100));
        const label = new Date(`${row.day}T00:00:00Z`).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        });
        return `<div class="cfb-day" title="${esc(`${row.day}: ${row.builds} builds · ${cfbMinutes(row.minutes)} · ${row.failed} failed`)}">
          <div class="cfb-bar-wrap"><i class="cfb-bar${row.failed ? ' has-fail' : ''}" style="height:${height}%"></i></div>
          <span>${esc(label)}</span>
        </div>`;
      })
      .join('')}
  </div>`;
}

async function renderCloudflareBuilds({ force = false } = {}) {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading Cloudflare build telemetry…</div></div>';
  let data;
  try {
    if (!force && CF_BUILDS.cache?.days === CF_BUILDS.days) data = CF_BUILDS.cache.data;
    else {
      data = await api('GET', `/api/cloudflare-builds?days=${CF_BUILDS.days}&limit=300`);
      CF_BUILDS.cache = { days: CF_BUILDS.days, data };
    }
  } catch (e) {
    renderViewError(app, `Cloudflare Builds telemetry failed: ${e.message}`);
    return;
  }
  const summary = data.summary || {};
  const pricing = data.pricing || {};
  const repos = data.byRepo || [];
  const builds = data.builds || [];
  const triggers = data.triggers || [];
  const fleetQuery = CF_BUILDS.filter;
  const pageSize = window.matchMedia('(max-width: 680px)').matches
    ? CF_BUILDS.pageSize
    : Math.max(CF_BUILDS.pageSize, 25);
  const cfbPage = (key, rows) => {
    const filtered = fleetQuery
      ? rows.filter(row =>
          String(row.repo || '')
            .toLowerCase()
            .includes(fleetQuery)
        )
      : rows;
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    CF_BUILDS.pages[key] = Math.min(CF_BUILDS.pages[key], pageCount);
    const start = (CF_BUILDS.pages[key] - 1) * pageSize;
    return {
      rows: filtered.slice(start, start + pageSize),
      nav:
        pageCount > 1
          ? `<nav class="cfb-pagination" aria-label="${key} pages"><span class="muted" role="status" aria-live="polite">Showing ${start + 1}–${Math.min(start + pageSize, filtered.length)} of ${filtered.length}</span><button type="button" class="btn sm" data-cfb-page="${key}" data-delta="-1" ${CF_BUILDS.pages[key] <= 1 ? 'disabled' : ''}>← Previous</button><button type="button" class="btn sm" data-cfb-page="${key}" data-delta="1" ${CF_BUILDS.pages[key] >= pageCount ? 'disabled' : ''}>Next →</button></nav>`
          : '',
    };
  };
  const repoPage = cfbPage('repos', repos);
  const buildPage = cfbPage('builds', builds);
  const triggerPage = cfbPage('triggers', triggers);
  const lastSweep = data.lastSweep
    ? `${fmtAge((Date.now() - data.lastSweep) / 1000)} ago`
    : 'waiting for first sweep';
  const policyHealthy = summary.triggers && summary.compliantTriggers === summary.triggers;
  const projectedOver = Number(summary.projectedOverageUsd) || 0;

  const repoRows = repoPage.rows
    .map(row => {
      const policy = row.policyOk
        ? '<span class="badge b-green">filtered</span>'
        : '<span class="badge b-red">review</span>';
      const cache = row.cacheOk
        ? '<span class="badge b-green">on</span>'
        : '<span class="badge b-yellow">partial/off</span>';
      return `<tr data-fleet-row data-site="${esc(row.repo)}">
        <td>${cfbRepoLink(row.providerAccount, row.repo)}</td>
        <td class="mono muted">${esc((row.workers || []).join(', ') || '—')}</td>
        <td>${row.builds.toLocaleString()}</td>
        <td class="mono">${cfbMinutes(row.minutes)}</td>
        <td class="mono">${cfbDuration(row.averageSeconds)}</td>
        <td>${row.successRate == null ? '—' : `${(row.successRate * 100).toFixed(1)}%`}</td>
        <td>${policy}</td>
        <td>${cache}</td>
        <td class="mono muted">${row.latestOn ? esc(new Date(row.latestOn).toLocaleString()) : '—'}</td>
      </tr>`;
    })
    .join('');

  const buildRows = buildPage.rows
    .map(build => {
      const firstLine = String(build.commitMessage || '(no commit message)').split('\n')[0];
      return `<tr data-fleet-row data-site="${esc(build.repo)}">
        <td class="mono muted">${esc(build.createdOn ? new Date(build.createdOn).toLocaleString() : '—')}</td>
        <td>${cfbRepoLink(build.providerAccount, build.repo)}</td>
        <td>${cfbCommitLink(build)}</td>
        <td class="cfb-message" title="${esc(build.commitMessage || '')}">${esc(firstLine)}</td>
        <td class="mono muted">${esc(build.branch || '—')}</td>
        <td>${cfbBadge(build.outcome)}</td>
        <td class="mono">${cfbDuration(build.durationSeconds)}</td>
        <td class="mono muted">${esc(build.source || '—')}</td>
      </tr>`;
    })
    .join('');

  const triggerRows = triggerPage.rows
    .map(trigger => {
      const ok =
        trigger.root === 'site' &&
        JSON.stringify(trigger.pathIncludes) === JSON.stringify(['site/*', '.deploy-probe']) &&
        JSON.stringify(trigger.pathExcludes) === JSON.stringify(['ops/*']) &&
        trigger.caching;
      const kind = (trigger.branchIncludes || []).includes('main') ? 'production' : 'preview';
      return `<tr data-fleet-row data-site="${esc(trigger.repo)}">
        <td>${cfbRepoLink(trigger.providerAccount, trigger.repo)}</td>
        <td class="mono">${esc(trigger.worker)}</td>
        <td><span class="badge ${kind === 'production' ? 'b-blue' : 'b-purple'}">${kind}</span></td>
        <td class="mono">${esc((trigger.pathIncludes || []).join(', ') || '—')}</td>
        <td class="mono">${esc((trigger.pathExcludes || []).join(', ') || '—')}</td>
        <td>${trigger.caching ? '<span class="badge b-green">on</span>' : '<span class="badge b-yellow">off</span>'}</td>
        <td>${ok ? '<span class="badge b-green">compliant</span>' : '<span class="badge b-red">drift</span>'}</td>
        <td class="mono muted">${trigger.modifiedOn ? esc(new Date(trigger.modifiedOn).toLocaleString()) : '—'}</td>
      </tr>`;
    })
    .join('');

  app.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">Build Usage</h2><span class="muted">Cloudflare Workers Builds · commits, minutes, cost projection, and live trigger policy</span></div><button type="button" class="btn" id="cfb-refresh">↻ Refresh</button></div>
    <div class="cfb-controls" aria-label="Build history range">
      <div class="seg">
        ${[7].map(days => `<button class="seg-btn cfb-range ${CF_BUILDS.days === days ? 'active' : ''}" data-days="${days}">${days}d</button>`).join('')}
      </div>
      <span class="muted">Cloudflare cache refreshed ${esc(lastSweep)}${data.refreshing ? ' · refreshing now' : ''}</span>
      <span class="cm-spacer"></span>
      ${policyHealthy ? '<span class="badge b-green">fleet policy healthy</span>' : `<span class="badge b-red">${summary.triggers - summary.compliantTriggers} trigger(s) drifted</span>`}
    </div>
    ${data.error ? `<div class="empty cfb-error">Latest Cloudflare refresh warning: ${esc(data.error)}</div>` : ''}
    <div class="cfb-stats">
      <div class="cfb-stat" style="--cfb-c:var(--a1)"><span>Builds · ${CF_BUILDS.days}d</span><strong>${(summary.builds || 0).toLocaleString()}</strong><small>${summary.activeRepos || 0} active repositories</small></div>
      <div class="cfb-stat" style="--cfb-c:var(--purple)"><span>Minutes · ${CF_BUILDS.days}d</span><strong>${Math.round(summary.minutes || 0).toLocaleString()}</strong><small>${cfbDuration(summary.averageSeconds)} average</small></div>
      <div class="cfb-stat" style="--cfb-c:var(--green)"><span>Success rate</span><strong>${summary.successRate == null ? '—' : `${(summary.successRate * 100).toFixed(1)}%`}</strong><small>${summary.failed || 0} failed or terminated</small></div>
      <div class="cfb-stat" style="--cfb-c:var(--yellow)"><span>Month to date</span><strong>${Math.round(summary.monthMinutes || 0).toLocaleString()}</strong><small>of ${(pricing.includedMinutes || 0).toLocaleString()} included minutes</small></div>
      <div class="cfb-stat" style="--cfb-c:${projectedOver ? 'var(--yellow)' : 'var(--green)'}"><span>Projected month</span><strong>${Math.round(summary.projectedMinutes || 0).toLocaleString()}</strong><small>${fmtUSD(projectedOver)} estimated Builds overage</small></div>
      <div class="cfb-stat" style="--cfb-c:${policyHealthy ? 'var(--green)' : 'var(--red)'}"><span>Live configuration</span><strong>${summary.compliantTriggers || 0}/${summary.triggers || 0}</strong><small>${summary.productionTriggers || 0} production · ${summary.previewTriggers || 0} preview</small></div>
    </div>
    <section class="card cfb-chart-card">
      <div class="task-toolbar"><strong>Daily build minutes</strong><span class="muted">UTC · red caps indicate at least one failed build</span></div>
      ${cfbChart(data.byDay || [])}
    </section>
    ${collapsiblePanel('cfbuilds.repos', `Repository usage <span class="badge b-gray">${repos.length}</span>`, `<div class="cfb-table"><table><caption class="sr-only">Repository build usage</caption><thead><tr><th>Repository</th><th>Worker</th><th>Builds</th><th>Minutes</th><th>Average</th><th>Success</th><th>Watch paths</th><th>Cache</th><th>Latest build</th></tr></thead><tbody>${repoRows || '<tr><td colspan="9" class="muted">No repositories found.</td></tr>'}</tbody></table></div>${repoPage.nav}`, 'card cfb-panel')}
    ${collapsiblePanel('cfbuilds.commits', `Recent builds &amp; commits <span class="badge b-gray">${builds.length}</span>`, `<div class="cfb-table"><table><caption class="sr-only">Recent builds and commits</caption><thead><tr><th>Started</th><th>Repository</th><th>Commit</th><th>Message</th><th>Branch</th><th>Outcome</th><th>Duration</th><th>Trigger</th></tr></thead><tbody>${buildRows || '<tr><td colspan="8" class="muted">No builds in this period.</td></tr>'}</tbody></table></div>${buildPage.nav}`, 'card cfb-panel')}
    ${collapsiblePanel('cfbuilds.triggers', `Live trigger inventory <span class="badge b-gray">${triggers.length}</span>`, `<div class="cfb-table"><table><caption class="sr-only">Live Cloudflare build triggers</caption><thead><tr><th>Repository</th><th>Worker</th><th>Environment</th><th>Included paths</th><th>Excluded paths</th><th>Cache</th><th>Policy</th><th>Modified</th></tr></thead><tbody>${triggerRows || '<tr><td colspan="8" class="muted">No connected triggers found.</td></tr>'}</tbody></table></div>${triggerPage.nav}`, 'card cfb-panel')}
    <p class="muted cfb-foot">Build durations are calculated from Cloudflare's running/stopped timestamps. Cost is an estimate using ${pricing.includedMinutes || 0} included minutes and ${cfbUnitPrice(pricing.overagePerMinuteUsd)} per overage minute; Cloudflare Billing remains authoritative. Build history is retained locally for 7 days and refreshed hourly; live trigger policy remains current.</p>`;

  $('#cfb-refresh').addEventListener('click', () => renderCloudflareBuilds({ force: true }));
  $$('.cfb-range').forEach(button =>
    button.addEventListener('click', () => {
      CF_BUILDS.days = Number(button.dataset.days) || 30;
      CF_BUILDS.cache = null;
      CF_BUILDS.pages = { repos: 1, builds: 1, triggers: 1 };
      renderCloudflareBuilds();
    })
  );
  wireCollapsiblePanels(app);
  $$('[data-cfb-page]', app).forEach(button =>
    button.addEventListener('click', () => {
      const key = button.dataset.cfbPage;
      CF_BUILDS.pages[key] = Math.max(1, CF_BUILDS.pages[key] + Number(button.dataset.delta));
      renderCloudflareBuilds();
    })
  );
  if (!FRESH) applyUISnap();
  const fleetFilterInput = $('#fleet-filter');
  if (fleetFilterInput && fleetFilterInput.value.trim().toLowerCase() !== CF_BUILDS.filter)
    fleetFilterInput.value = CF_BUILDS.filter;
  applyFleetFilter();
  stamp();
}

/* ===================== HEALTH ===================== */
// Rolled-up view of tools/fleet-gatus (server/gatushealth.js) — the fleet's
// uptime/content-check monitor. Deliberately terse: only failing checks are
// listed by name, passing ones collapse into a single count, so a healthy
// fleet reads as one glance of green badges, not a wall of 👍 bullets.
//
// Fleet-wide (2026-08-20): every site with an ops/smoke.yaml is monitored —
// a site is only absent below if it has no smoke.yaml or is disabled there.
async function renderHealth() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div class="page-head"><div><h2 class="page-title">Health</h2><span class="muted">Live uptime and content checks across the fleet</span></div></div><div role="status" aria-live="polite"><div class="loading">Loading site health…</div></div>';
  let d;
  try {
    d = await api('GET', '/api/gatus');
  } catch (e) {
    renderViewError(app, `Health check data failed to load: ${e.message}`);
    return;
  }

  const order = d.order || [];
  const sites = d.sites || {};
  const healthy = order.filter(g => sites[g].failing === 0).length;
  const unhealthy = order.length - healthy;
  const totalChecks = order.reduce((sum, site) => sum + (sites[site].total || 0), 0);
  const failingChecks = order.reduce((sum, site) => sum + (sites[site].failing || 0), 0);

  const cards = order
    .map(g => {
      const s = sites[g];
      const badge =
        s.failing === 0
          ? '<span class="badge b-green">healthy</span>'
          : `<span class="badge b-red">${s.failing} failing</span>`;
      const failingRows = s.checks
        .filter(c => !c.success)
        .map(
          c => `<tr data-fleet-row data-site="${esc(g)}">
          <td class="mono muted">${esc(c.name)}</td>
          <td>${c.statusCode != null ? esc(String(c.statusCode)) : '<span class="muted">no response</span>'}</td>
          <td class="muted">${c.errors.length ? esc(c.errors.join('; ')) : ''}</td>
        </tr>`
        )
        .join('');
      return `<div class="card health-card" data-fleet-row data-site="${esc(g)}">
        <div class="health-card-head">
          <h2 class="page-title">${siteLink(g)}</h2>
          <span class="muted">${badge} · ${s.passing}/${s.total} checks green</span>
        </div>
        ${
          failingRows
            ? `<div class="table-wrap"><table><caption class="sr-only">Failing health checks</caption><thead><tr><th>Failing check</th><th>Status</th><th>Detail</th></tr></thead><tbody>${failingRows}</tbody></table></div>`
            : ''
        }
      </div>`;
    })
    .join('');

  const swept = d.lastSweep ? fmtAge((Date.now() - d.lastSweep) / 1000) + ' ago' : 'never';
  const errNote = d.error
    ? `<p class="muted" style="color:var(--red)">Gatus poller error: ${esc(d.error)} — showing last known state.</p>`
    : '';

  app.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">Health</h2><span class="muted">Live uptime checks via <a class="inline-help-link" href="http://127.0.0.1:8580" target="_blank" rel="noopener noreferrer">Gatus</a> (tools/fleet-gatus) — 5-min interval, alerts on state change only.</span></div><button type="button" class="btn" id="health-refresh">↻ Refresh</button></div>
    <section class="health-summary" aria-label="Health summary">
      <div class="health-stat"><strong>${order.length}</strong><span>Sites monitored</span></div>
      <div class="health-stat health-stat-good"><strong>${healthy}</strong><span>Healthy sites</span></div>
      <div class="health-stat ${unhealthy ? 'health-stat-bad' : ''}"><strong>${unhealthy}</strong><span>Sites needing attention</span></div>
      <div class="health-stat ${failingChecks ? 'health-stat-bad' : 'health-stat-good'}"><strong>${failingChecks}<small>/${totalChecks}</small></strong><span>Failing checks</span></div>
      <div class="health-stat health-stat-meta"><strong>${esc(swept)}</strong><span>Last sweep${d.stale ? ' · stale' : ''}</span></div>
    </section>
    ${errNote}
    ${cards || '<div class="empty">No sites monitored — check that tools/fleet-gatus is running and its config has been generated.</div>'}
    <details class="health-help"><summary>How site health is measured</summary><p>Every site with an <code>ops/smoke.yaml</code> is auto-discovered here. One check type isn't representable yet (0xroulette.com's module-graph check) and currently has no automated coverage — see <code>tools/fleet-gatus/README.md</code>.</p></details>`;
  $('#health-refresh').addEventListener('click', () => renderHealth());
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

/* ===================== ERRORS ===================== */
// Fleet-wide error/warn rollup (server/errorscan.js) — a background poller
// tails every in-repo container's docker logs and classifies crit/error/warn
// lines. This is the "what's broken right now" view so nobody has to open
// Containers and read raw tails one at a time to notice a site is erroring.
function errLevelBadge(level) {
  if (level === 'crit') return '<span class="badge b-red">crit</span>';
  if (level === 'error') return '<span class="badge b-red">error</span>';
  if (level === 'warn') return '<span class="badge b-yellow">warn</span>';
  return '<span class="badge b-green">clean</span>';
}

const ERRORS_UI = { q: '', level: '', scope: '', sort: 'count1h', dir: -1, page: 1, pageSize: 25 };
let ERROR_DRAWER_RETURN_FOCUS = null;

function errorSortValue(r, key) {
  if (key === 'name' || key === 'slug' || key === 'lastLevel' || key === 'lastLine')
    return String(r[key] || '').toLowerCase();
  return Number(r[key]) || 0;
}

function errorSortButton(key, label) {
  const active = ERRORS_UI.sort === key;
  const arrow = active ? (ERRORS_UI.dir < 0 ? '↓' : '↑') : '↕';
  return `<th aria-sort="${active ? (ERRORS_UI.dir < 0 ? 'descending' : 'ascending') : 'none'}"><button class="error-sort${active ? ' active' : ''}" data-error-sort="${key}" type="button" title="Sort by ${esc(label)}">${esc(label)} <span aria-hidden="true">${arrow}</span></button></th>`;
}

function ensureErrorDrawer() {
  let shell = $('#error-drawer-shell');
  if (shell) return shell;
  shell = document.createElement('div');
  shell.id = 'error-drawer-shell';
  shell.className = 'err-drawer-shell hidden';
  shell.innerHTML = `<div class="err-drawer-backdrop" data-error-drawer-close></div><aside class="err-drawer" role="dialog" aria-modal="true" aria-labelledby="err-drawer-title" aria-describedby="err-drawer-subtitle"><div class="err-drawer-head"><div><h2 id="err-drawer-title">Error logs</h2><span id="err-drawer-subtitle" class="muted"></span></div><button id="err-drawer-close" class="icon-btn" type="button" data-error-drawer-close aria-label="Close error logs">×</button></div><div class="err-drawer-toolbar"><button id="err-drawer-copy" class="btn sm" type="button">Copy logs</button><button id="err-drawer-refresh" class="btn sm" type="button">↻ Refresh</button><span class="muted">retained matching lines</span><span id="err-drawer-status" class="sr-only" role="status" aria-live="polite"></span></div><pre id="err-drawer-log" class="err-drawer-log">Select a container to view its logs.</pre></aside>`;
  document.body.appendChild(shell);
  $$('[data-error-drawer-close]', shell).forEach(el =>
    el.addEventListener('click', closeErrorDrawer)
  );
  $('#err-drawer-refresh', shell).addEventListener('click', () =>
    openErrorDrawer(shell.dataset.id)
  );
  $('#err-drawer-copy', shell).addEventListener('click', () =>
    copyErrorText($('#err-drawer-log', shell).textContent, 'Logs')
  );
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !shell.classList.contains('hidden')) closeErrorDrawer();
  });
  return shell;
}

function closeErrorDrawer() {
  const shell = $('#error-drawer-shell');
  if (!shell) return;
  shell.classList.add('hidden');
  const returnFocus = ERROR_DRAWER_RETURN_FOCUS;
  ERROR_DRAWER_RETURN_FOCUS = null;
  if (returnFocus?.isConnected && !returnFocus.closest('.hidden')) returnFocus.focus();
}

async function copyErrorText(value, label) {
  if (!value || value === 'Select a container to view its logs.') return;
  try {
    await navigator.clipboard.writeText(value);
    toast(`${label} copied`);
  } catch {
    const area = document.createElement('textarea');
    area.value = value;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    toast(`${label} copied`);
  }
}

async function openErrorDrawer(id) {
  const shell = ensureErrorDrawer();
  if (shell.classList.contains('hidden')) {
    const active = document.activeElement;
    ERROR_DRAWER_RETURN_FOCUS = active instanceof HTMLElement ? active : null;
  }
  shell.dataset.id = id;
  shell.classList.remove('hidden');
  const row = $(`tr.err-row[data-error-id="${CSS.escape(id)}"]`);
  $('#err-drawer-title', shell).textContent = row?.dataset.name || 'Error logs';
  $('#err-drawer-subtitle', shell).textContent = row?.dataset.site
    ? `${row.dataset.site} · live retained log`
    : 'tool container · live retained log';
  const log = $('#err-drawer-log', shell);
  const status = $('#err-drawer-status', shell);
  log.classList.add('async-loading');
  log.setAttribute('aria-busy', 'true');
  if (status) status.textContent = 'Loading retained logs';
  log.textContent = 'Loading…';
  log.textContent = await fetchErrorLines(id);
  log.classList.remove('async-loading');
  log.setAttribute('aria-busy', 'false');
  if (status) status.textContent = 'Retained logs loaded';
  requestAnimationFrame(() => {
    if (!shell.classList.contains('hidden')) $('#err-drawer-close', shell)?.focus();
  });
}

async function renderErrors() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div class="page-head"><div><h2 class="page-title">Errors</h2><span class="muted">Fleet-wide retained log scan and alert review</span></div></div><div role="status" aria-live="polite"><div class="loading">Loading error scan…</div></div>';
  let d;
  try {
    d = await api('GET', '/api/errors');
  } catch (e) {
    renderViewError(app, `Error scan failed: ${e.message}`);
    return;
  }

  const rows = (d.containers || []).map(r => ({ ...r, slug: r.scope === 'site' ? r.slug : '' }));
  const q = ERRORS_UI.q.trim().toLowerCase();
  const filtered = rows.filter(r => {
    const haystack = [r.name, r.slug, r.lastLevel, r.lastLine].join(' ').toLowerCase();
    return (
      (!q || haystack.includes(q)) &&
      (!ERRORS_UI.level || (r.lastLevel || 'clean') === ERRORS_UI.level) &&
      (!ERRORS_UI.scope || r.scope === ERRORS_UI.scope)
    );
  });
  filtered.sort((a, b) => {
    const av = errorSortValue(a, ERRORS_UI.sort),
      bv = errorSortValue(b, ERRORS_UI.sort);
    const cmp =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv));
    return cmp * ERRORS_UI.dir;
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / ERRORS_UI.pageSize));
  ERRORS_UI.page = Math.min(ERRORS_UI.page, pageCount);
  const start = (ERRORS_UI.page - 1) * ERRORS_UI.pageSize;
  const pageRows = filtered.slice(start, start + ERRORS_UI.pageSize);

  const noisy1h = rows.filter(r => r.count1h > 0).length;
  const noisy24h = rows.filter(r => r.count24h > 0).length;
  const crit24h = rows.reduce((n, r) => n + r.crit24h, 0);
  const activeAlerts = d.activeAlerts || [];
  const postFailures = d.postFailures || [];
  const postFailureGroups = [];
  const postFailureIndex = new Map();
  postFailures.forEach(f => {
    // The table intentionally shows an 80-character preview; use that same
    // visible signature for grouping so repeated deliveries with hidden tail
    // differences do not reintroduce duplicate-looking rows.
    const preview = String(f.textPreview || '').slice(0, 80);
    const key = `${f.channel || ''}\u0000${f.error || ''}\u0000${preview}`;
    const existing = postFailureIndex.get(key);
    if (existing) {
      existing.count++;
      existing.latestAt = Math.max(existing.latestAt || 0, f.at || 0);
    } else {
      const group = { ...f, textPreview: preview, count: 1, latestAt: f.at || 0 };
      postFailureIndex.set(key, group);
      postFailureGroups.push(group);
    }
  });

  const body = pageRows
    .map(r => {
      const level = r.count24h > 0 ? r.lastLevel : null;
      const when = r.lastAt ? fmtAge((Date.now() - r.lastAt) / 1000) + ' ago' : '—';
      return `<tr class="err-row" data-error-id="${esc(r.id)}" data-name="${esc(r.name)}" data-site="${esc(r.slug)}" data-last-line="${esc(r.lastLine || '')}" data-fleet-row role="button" tabindex="0" title="Click to view retained logs">
      <td class="mono">${esc(r.name)}${r.activeAlert ? ' <span class="badge b-red" title="errorscan considers this an open alert — a Slack post (threshold or all-clear) may still be pending or may have failed silently">🔔 active</span>' : ''}</td>
      <td>${r.scope === 'site' ? `<span class="site">${esc(r.slug)}</span>` : '<span class="muted">tool</span>'}</td>
      <td>${r.count1h ? `<span class="badge b-red">${r.count1h}</span>` : '<span class="muted">0</span>'}</td>
      <td>${r.count24h ? `<span class="badge ${r.count1h ? 'b-red' : 'b-yellow'}">${r.count24h}</span>` : '<span class="muted">0</span>'}</td>
      <td>${errLevelBadge(level)}</td>
      <td class="mono muted">${esc(when)}</td>
      <td class="mono muted err-line-cell"><span class="err-snippet" data-tooltip="${esc(r.lastLine || 'No matching line')}" title="${esc(r.lastLine || 'No matching line')}">${esc((r.lastLine || '—').slice(0, 90))}</span><button class="btn sm err-copy" data-id="${esc(r.id)}" type="button" aria-label="Copy last line for ${esc(r.name)}" title="Copy the full last line">Copy</button></td>
      <td class="err-actions"><button class="btn sm err-toggle" data-id="${esc(r.id)}" type="button" aria-label="Open retained logs for ${esc(r.name)}">📜 Logs</button></td>
    </tr>`;
    })
    .join('');

  const swept = d.lastSweep ? fmtAge((Date.now() - d.lastSweep) / 1000) + ' ago' : 'never';
  app.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">Errors</h2><span class="muted">Fleet-wide log scan — error/warn lines tailed from every in-repo container's docker logs.</span></div><button type="button" class="btn" id="errors-refresh">↻ Refresh</button></div>
    <section class="error-summary" aria-label="Error scan summary">
      <div class="error-stat"><strong>${rows.length}</strong><span>Containers scanned</span></div>
      <div class="error-stat ${noisy1h ? 'error-stat-bad' : 'error-stat-good'}"><strong>${noisy1h}</strong><span>Reporting errors · 1h</span></div>
      <div class="error-stat ${noisy24h ? 'error-stat-warn' : 'error-stat-good'}"><strong>${noisy24h}</strong><span>With events · 24h</span></div>
      <div class="error-stat ${crit24h ? 'error-stat-bad' : 'error-stat-good'}"><strong>${crit24h}</strong><span>Critical lines · 24h</span></div>
      <div class="error-stat error-stat-meta"><strong>${esc(swept)}</strong><span>Last sweep · ${filtered.length} matching</span></div>
    </section>
    ${
      activeAlerts.length
        ? `<div class="card error-card error-banner error-banner-bad" role="alert"><div class="cn-log-head">🔔 ${activeAlerts.length} open alert(s) — errorscan hasn't seen a clean sweep since these last crossed threshold</div><p class="muted">${activeAlerts.map(esc).join(', ')}</p></div>`
        : ''
    }
    ${
      postFailures.length
        ? `<div class="card error-card error-banner error-banner-warn" role="alert"><div class="cn-log-head">⚠️ ${postFailures.length} failed Slack post(s) across ${postFailureGroups.length} failure pattern(s) — an alert or all-clear that never reached Slack</div><div class="table-wrap"><table>
      <caption class="sr-only">Deduplicated failed Slack delivery patterns</caption><thead><tr><th>Latest</th><th>Events</th><th>Channel</th><th>Error</th><th>Message</th></tr></thead>
      <tbody>${postFailureGroups
        .map(
          f =>
            `<tr><td class="mono muted">${esc(fmtAge((Date.now() - f.latestAt) / 1000) + ' ago')}</td><td><span class="badge b-yellow">${f.count}</span></td><td class="mono">${esc(f.channel || '—')}</td><td class="mono">${esc(f.error || '—')}</td><td class="mono muted">${esc((f.textPreview || '').slice(0, 80))}</td></tr>`
        )
        .join('')}</tbody>
    </table></div></div>`
        : ''
    }
    <div class="task-toolbar errors-toolbar" role="group" aria-label="Error scan filters">
      <label>Search<input id="errors-q" class="cm-input" type="search" placeholder="Container, site, log text…" value="${esc(ERRORS_UI.q)}" autocomplete="off"></label>
      <label>Level<select id="errors-level" class="cm-input"><option value="">All levels</option>${['crit', 'error', 'warn', 'clean'].map(l => `<option value="${l}" ${ERRORS_UI.level === l ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Scope<select id="errors-scope" class="cm-input"><option value="">All containers</option><option value="site" ${ERRORS_UI.scope === 'site' ? 'selected' : ''}>Site containers</option><option value="tool" ${ERRORS_UI.scope === 'tool' ? 'selected' : ''}>Tool containers</option></select></label>
      <label>Per page<select id="errors-page-size" class="cm-input">${[10, 25, 50, 100].map(n => `<option value="${n}" ${ERRORS_UI.pageSize === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    </div>
    <div class="card error-card error-table"><div class="table-wrap"><table><caption class="sr-only">Container error summary and retained log actions</caption>
      <thead><tr>${errorSortButton('name', 'Container')}${errorSortButton('slug', 'Site')}${errorSortButton('count1h', '1h')}${errorSortButton('count24h', '24h')}${errorSortButton('lastLevel', 'Level')}${errorSortButton('lastAt', 'Last')}${errorSortButton('lastLine', 'Last line')}<th>Actions</th></tr></thead>
      <tbody>${body || `<tr><td colspan="8" class="muted">${rows.length ? 'No containers match the current filters.' : 'No containers scanned yet — the poller sweeps every 3 minutes in the background.'}</td></tr>`}</tbody>
    </table></div></div>
    <div class="activity-pagination error-pagination"><span class="muted">${filtered.length ? `Showing ${start + 1}–${Math.min(start + ERRORS_UI.pageSize, filtered.length)} of ${filtered.length}` : 'Showing 0 containers'}</span><button id="errors-prev" class="btn sm" type="button" ${ERRORS_UI.page <= 1 ? 'disabled' : ''}>← Previous</button><span class="activity-page-count">Page ${ERRORS_UI.page} of ${pageCount}</span><button id="errors-next" class="btn sm" type="button" ${ERRORS_UI.page >= pageCount ? 'disabled' : ''}>Next →</button></div>
    <details class="error-help"><summary>How errors are classified</summary><p>Classifies lines matching <b>error/exception/traceback/failed/failure</b> (error), <b>panic/fatal/out of memory</b> (crit), or <b>warn(ing)</b> (warn). Successful Astro route output and explicit zero-failure summaries are suppressed. One-off workers remain visible here, while Slack alerts come only from persistent site containers to avoid duplicates. Rolling ~26h retention, refreshed every 3 minutes.</p></details>`;

  $('#errors-refresh').addEventListener('click', () => renderErrors());
  wireErrorRows();
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

function wireErrorRows() {
  $$('.err-row').forEach(row => {
    row.addEventListener('click', e => {
      if (!e.target.closest('button')) openErrorDrawer(row.dataset.errorId);
    });
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openErrorDrawer(row.dataset.errorId);
      }
    });
  });
  $$('.err-toggle').forEach(b =>
    b.addEventListener('click', e => {
      e.stopPropagation();
      openErrorDrawer(b.dataset.id);
    })
  );
  $$('.err-copy').forEach(b =>
    b.addEventListener('click', async e => {
      e.stopPropagation();
      const row = b.closest('.err-row');
      await copyErrorText(row?.dataset.lastLine || '', 'Last line');
    })
  );
  $$('.error-sort').forEach(b =>
    b.addEventListener('click', () => {
      const key = b.dataset.errorSort;
      if (ERRORS_UI.sort === key) ERRORS_UI.dir *= -1;
      else {
        ERRORS_UI.sort = key;
        ERRORS_UI.dir = ['name', 'slug', 'lastLevel', 'lastLine'].includes(key) ? 1 : -1;
      }
      ERRORS_UI.page = 1;
      renderErrors();
    })
  );
  $('#errors-q').addEventListener('change', e => {
    ERRORS_UI.q = e.target.value;
    ERRORS_UI.page = 1;
    renderErrors();
  });
  $('#errors-level').addEventListener('change', e => {
    ERRORS_UI.level = e.target.value;
    ERRORS_UI.page = 1;
    renderErrors();
  });
  $('#errors-scope').addEventListener('change', e => {
    ERRORS_UI.scope = e.target.value;
    ERRORS_UI.page = 1;
    renderErrors();
  });
  $('#errors-page-size').addEventListener('change', e => {
    ERRORS_UI.pageSize = Number(e.target.value) || 25;
    ERRORS_UI.page = 1;
    renderErrors();
  });
  $('#errors-prev').addEventListener('click', () => {
    ERRORS_UI.page--;
    renderErrors();
  });
  $('#errors-next').addEventListener('click', () => {
    ERRORS_UI.page++;
    renderErrors();
  });
}

async function fetchErrorLines(id) {
  try {
    const r = await api('GET', `/api/errors/${encodeURIComponent(id)}/lines?limit=500`);
    return r.lines.length
      ? r.lines.map(l => `${new Date(l.tsMs).toISOString()} [${l.level}] ${l.line}`).join('\n')
      : '(no matched lines in the retained window)';
  } catch (e) {
    return `error: ${e.message}`;
  }
}

/* ===================== ACTIVITY ===================== */
// F14: read-only view over the durable audit trail (GET /api/actions, backed
// by server/actionlog.js) — every mutating dashboard request, newest first.
function activitySiteFromPath(p) {
  const m = String(p || '').match(
    /^\/api\/(?:roles|git|tasks|fleet|sites|cron\/systems)\/([^/?]+)/
  );
  return m ? decodeURIComponent(m[1]) : null;
}

const ACTIVITY_UI = { q: '', status: '', method: '', sort: 'ts', dir: -1, page: 1, pageSize: 50 };
let activityFilterTimer = null;

function activitySortValue(a, key) {
  if (key === 'ts') return new Date(a.ts || 0).getTime() || 0;
  if (key === 'site') return activitySiteFromPath(a.path) || '';
  if (key === 'status') return Number(a.status) || 0;
  if (key === 'ms') return Number(a.ms) || 0;
  return String(a[key] || '').toLowerCase();
}

function activitySortButton(key, label) {
  const active = ACTIVITY_UI.sort === key;
  const arrow = active ? (ACTIVITY_UI.dir < 0 ? '↓' : '↑') : '↕';
  return `<th aria-sort="${active ? (ACTIVITY_UI.dir < 0 ? 'descending' : 'ascending') : 'none'}"><button class="activity-sort${active ? ' active' : ''}" data-activity-sort="${key}" type="button" title="Sort by ${esc(label)}">${esc(label)} <span aria-hidden="true">${arrow}</span></button></th>`;
}

async function renderActivity() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading action log…</div></div>';
  let data;
  try {
    data = await api('GET', '/api/actions?limit=300');
  } catch (e) {
    renderViewError(app, `Action log read failed: ${e.message}`);
    return;
  }

  const rows = (data.actions || []).map(a => ({ ...a, site: activitySiteFromPath(a.path) || '' }));
  const q = ACTIVITY_UI.q.trim().toLowerCase();
  const filtered = rows.filter(a => {
    const haystack = [a.actor, a.method, a.path, a.site, a.status, a.ip].join(' ').toLowerCase();
    return (
      (!q || haystack.includes(q)) &&
      (!ACTIVITY_UI.status || (a.ok ? 'ok' : 'failed') === ACTIVITY_UI.status) &&
      (!ACTIVITY_UI.method || String(a.method || '').toUpperCase() === ACTIVITY_UI.method)
    );
  });
  filtered.sort((a, b) => {
    const av = activitySortValue(a, ACTIVITY_UI.sort),
      bv = activitySortValue(b, ACTIVITY_UI.sort);
    const cmp =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv));
    return cmp * ACTIVITY_UI.dir;
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / ACTIVITY_UI.pageSize));
  ACTIVITY_UI.page = Math.min(ACTIVITY_UI.page, pageCount);
  const start = (ACTIVITY_UI.page - 1) * ACTIVITY_UI.pageSize;
  const pageRows = filtered.slice(start, start + ACTIVITY_UI.pageSize);
  const failed = rows.filter(a => !a.ok).length;
  const succeeded = rows.length - failed;
  const writes = rows.filter(a =>
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(a.method || '').toUpperCase())
  ).length;
  const latest = rows[0]?.ts
    ? fmtAge((Date.now() - new Date(rows[0].ts).getTime()) / 1000) + ' ago'
    : 'none yet';

  const body = pageRows
    .map(a => {
      const site = a.site;
      return `<tr${site ? ` data-fleet-row data-site="${esc(site)}"` : ''}>
      <td class="mono muted">${esc((a.ts || '').replace('T', ' ').slice(0, 19))}</td>
      <td class="mono">${esc(a.actor)}</td>
      <td class="mono">${esc(a.method)}</td>
      <td class="mono">${esc(a.path)}</td>
      <td>${site ? esc(site) : '<span class="muted">—</span>'}</td>
      <td><span class="badge ${a.ok ? 'b-green' : 'b-red'}">${a.status}</span></td>
      <td class="mono muted">${a.ms != null ? `${a.ms}ms` : '—'}</td>
      <td class="mono muted">${esc(a.ip || '—')}</td>
    </tr>`;
    })
    .join('');

  app.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">Activity</h2><span class="muted">durable audit trail of every mutating dashboard action — newest first</span></div><button type="button" class="btn" id="activity-refresh">↻ Refresh</button></div>
    <section class="activity-summary" aria-label="Activity audit summary">
      <div class="activity-stat"><strong>${rows.length}</strong><span>Actions loaded</span></div>
      <div class="activity-stat activity-stat-good"><strong>${succeeded}</strong><span>Succeeded</span></div>
      <div class="activity-stat ${failed ? 'activity-stat-bad' : 'activity-stat-good'}"><strong>${failed}</strong><span>Failed</span></div>
      <div class="activity-stat"><strong>${writes}</strong><span>Mutations</span></div>
      <div class="activity-stat activity-stat-meta"><strong>${esc(latest)}</strong><span>Latest event · ${filtered.length} matching</span></div>
    </section>
    <div class="task-toolbar activity-toolbar" role="group" aria-label="Activity filters">
      <label>Search<input id="activity-q" class="cm-input" type="search" placeholder="Path, actor, site…" value="${esc(ACTIVITY_UI.q)}" autocomplete="off"></label>
      <label>Status<select id="activity-status" class="cm-input"><option value="">All statuses</option><option value="ok" ${ACTIVITY_UI.status === 'ok' ? 'selected' : ''}>Succeeded</option><option value="failed" ${ACTIVITY_UI.status === 'failed' ? 'selected' : ''}>Failed</option></select></label>
      <label>Method<select id="activity-method" class="cm-input"><option value="">All methods</option>${['POST', 'PUT', 'PATCH', 'DELETE'].map(m => `<option value="${m}" ${ACTIVITY_UI.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <label>Per page<select id="activity-page-size" class="cm-input">${[25, 50, 100].map(n => `<option value="${n}" ${ACTIVITY_UI.pageSize === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <strong class="activity-count">${filtered.length} matching</strong>
    </div>
    <div class="card activity-table"><div class="table-wrap"><table>
      <caption class="sr-only">Operator activity audit trail</caption>
      <thead><tr>${activitySortButton('ts', 'Time')}${activitySortButton('actor', 'Actor')}${activitySortButton('method', 'Method')}${activitySortButton('path', 'Path')}${activitySortButton('site', 'Site')}${activitySortButton('status', 'Status')}${activitySortButton('ms', 'Duration')}${activitySortButton('ip', 'IP')}</tr></thead>
      <tbody>${body || `<tr><td colspan="8" class="muted">${rows.length ? 'No actions match the current filters.' : 'No actions recorded yet.'}</td></tr>`}</tbody>
    </table></div></div>
    <div class="activity-pagination"><span class="muted">${filtered.length ? `Showing ${start + 1}–${Math.min(start + ACTIVITY_UI.pageSize, filtered.length)} of ${filtered.length}` : 'Showing 0 actions'}</span><button id="activity-prev" class="btn sm" type="button" ${ACTIVITY_UI.page <= 1 ? 'disabled' : ''}>← Previous</button><span class="activity-page-count">Page ${ACTIVITY_UI.page} of ${pageCount}</span><button id="activity-next" class="btn sm" type="button" ${ACTIVITY_UI.page >= pageCount ? 'disabled' : ''}>Next →</button></div>
    <details class="activity-help"><summary>What this audit trail records</summary><p>Every completed POST/PUT/DELETE to the dashboard's API, including rejected attempts (401/403). <b>Actor</b> is a non-reversible fingerprint of the caller's token/cookie, never the secret itself.</p></details>`;
  $('#activity-refresh').addEventListener('click', () => renderActivity());
  $('#activity-q').addEventListener('input', e => {
    ACTIVITY_UI.q = e.target.value;
    ACTIVITY_UI.page = 1;
    clearTimeout(activityFilterTimer);
    activityFilterTimer = setTimeout(() => renderActivity(), 250);
  });
  $('#activity-status').addEventListener('change', e => {
    ACTIVITY_UI.status = e.target.value;
    ACTIVITY_UI.page = 1;
    renderActivity();
  });
  $('#activity-method').addEventListener('change', e => {
    ACTIVITY_UI.method = e.target.value;
    ACTIVITY_UI.page = 1;
    renderActivity();
  });
  $('#activity-page-size').addEventListener('change', e => {
    ACTIVITY_UI.pageSize = Number(e.target.value) || 50;
    ACTIVITY_UI.page = 1;
    renderActivity();
  });
  $$('.activity-sort').forEach(btn =>
    btn.addEventListener('click', () => {
      const key = btn.dataset.activitySort;
      if (ACTIVITY_UI.sort === key) ACTIVITY_UI.dir *= -1;
      else {
        ACTIVITY_UI.sort = key;
        ACTIVITY_UI.dir = key === 'ts' ? -1 : 1;
      }
      ACTIVITY_UI.page = 1;
      renderActivity();
    })
  );
  $('#activity-prev').addEventListener('click', () => {
    ACTIVITY_UI.page--;
    renderActivity();
  });
  $('#activity-next').addEventListener('click', () => {
    ACTIVITY_UI.page++;
    renderActivity();
  });
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

/* ===================== DEV SANDBOXES ===================== */
// Per-site sandboxed Claude/ttyd dev containers, folded in from the
// standalone domain-developer tool so it stops being a separate URL an
// operator has to remember exists. Backed by server/devsandbox.js.
const DS = { sites: [], dockerAvailable: true, open: new Map() }; // open: site -> 'term'|'dev'|'logs'
const DS_FILTER = { q: '', status: 'all' };

function dsStatusBadge(status) {
  if (status === 'running') return '<span class="badge b-green">running</span>';
  if (status === 'absent') return '<span class="badge b-gray">absent</span>';
  return `<span class="badge b-red">${esc(status)}</span>`;
}

async function renderDevSandbox() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading dev sandboxes…</div></div>';
  let d;
  try {
    d = await api('GET', '/api/devsandbox/sites');
  } catch (e) {
    renderViewError(app, `Dev sandbox list failed: ${e.message}`);
    return;
  }
  DS.sites = d.sites || [];
  DS.dockerAvailable = d.dockerAvailable !== false;

  const running = DS.sites.filter(s => s.status === 'running').length;
  const exists = DS.sites.filter(s => s.status !== 'absent').length;

  const warn = !DS.dockerAvailable
    ? `<div class="alert" style="margin-bottom:12px">Docker daemon unreachable — every site below shows "absent" because sandbox state can't be queried, not because containers were removed. Start is disabled until Docker is back.</div>`
    : '';

  const body = DS.sites
    .map(s => {
      const acts = [];
      if (s.status === 'running') {
        acts.push(
          `<button class="btn sm ds-open" data-site="${esc(s.name)}" data-tab="term">🖥 Terminal</button>`
        );
        acts.push(
          `<button class="btn sm ds-open" data-site="${esc(s.name)}" data-tab="dev">▶ Dev preview</button>`
        );
        acts.push(
          `<button class="btn sm ds-open" data-site="${esc(s.name)}" data-tab="logs">📜 Dev logs</button>`
        );
        acts.push(
          `<button class="btn sm danger ds-act" data-site="${esc(s.name)}" data-act="stop">⏹ Stop</button>`
        );
      } else {
        acts.push(
          `<button class="btn sm primary ds-act" data-site="${esc(s.name)}" data-act="start"${DS.dockerAvailable ? '' : ' disabled'}>▶ Start</button>`
        );
        if (s.status !== 'absent')
          acts.push(
            `<button class="btn sm danger ds-act" data-site="${esc(s.name)}" data-act="remove">🗑 Remove</button>`
          );
      }
      const openTab = DS.open.get(s.name);
      return `<tr class="cn-row ds-row" data-ds-name="${esc(s.name.toLowerCase())}" data-ds-status="${esc(s.status)}" data-fleet-row data-site="${esc(s.name)}">
      <td class="site">${siteLink(s.name)}</td>
      <td>${dsStatusBadge(s.status)}</td>
      <td class="mono muted">${s.ttydPort ? ':' + s.ttydPort : '—'}</td>
      <td class="mono muted" id="ds-stat-${esc(s.name)}">—</td>
      <td class="cn-actions">${acts.join(' ')}</td>
    </tr>
    <tr class="cn-detail-row${openTab ? '' : ' hidden'}" data-detail="ds:${esc(s.name)}" data-rk="ds:${esc(s.name)}"><td colspan="5">
      <div id="ds-panel-${esc(s.name)}"></div>
    </td></tr>`;
    })
    .join('');

  app.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">Dev Sandboxes</h2><span class="muted">per-site sandboxed Claude + ttyd dev containers — folded in from domain-developer</span></div><button type="button" class="btn" id="ds-refresh">↻ Refresh</button></div>
    <section class="ds-summary" aria-label="Dev sandbox summary">
      <div class="ds-stat"><strong>${DS.sites.length}</strong><span>Sites provisioned</span></div>
      <div class="ds-stat ds-stat-good"><strong>${running}</strong><span>Running</span></div>
      <div class="ds-stat ${exists - running ? 'ds-stat-warn' : 'ds-stat-good'}"><strong>${exists - running}</strong><span>Stopped</span></div>
      <div class="ds-stat"><strong>${DS.sites.length - exists}</strong><span>Not provisioned</span></div>
      <div class="ds-stat ${DS.dockerAvailable ? 'ds-stat-good' : 'ds-stat-bad'}"><strong>${DS.dockerAvailable ? 'Ready' : 'Offline'}</strong><span>Docker control plane</span></div>
    </section>
    <div class="task-toolbar">
      <span class="cm-spacer"></span>
      <button class="btn sm" id="ds-stats">📊 Stats</button>
      <button class="btn sm" id="ds-stop-all">⏹ Stop all</button>
      <button class="btn sm" id="ds-remove-stopped">🧹 Remove stopped</button>
      <button class="btn sm" id="ds-clean-orphans">🗑 Clean orphans</button>
    </div>
    <div class="ds-controls" role="group" aria-label="Filter dev sandboxes">
      <label class="ds-search"><span class="sr-only">Search sandbox sites</span><input id="ds-search" class="cm-input" type="search" placeholder="Search sandbox sites…" value="${esc(DS_FILTER.q)}" autocomplete="off" /></label>
      <label><span class="sr-only">Sandbox status</span><select id="ds-status" class="cm-input"><option value="all">All statuses</option><option value="running">Running</option><option value="stopped">Stopped</option><option value="absent">Not provisioned</option></select></label>
      <span id="ds-filter-count" class="muted" role="status" aria-live="polite"></span>
    </div>
    ${warn}
    <div class="card"><div class="table-wrap"><table>
      <caption class="sr-only">Development sandbox status</caption>
      <thead><tr><th>Site</th><th>Status</th><th>ttyd</th><th>CPU · Mem · PIDs</th><th>Actions</th></tr></thead>
      <tbody>${body || '<tr><td colspan="5" class="muted">No sites found.</td></tr>'}</tbody>
    </table></div></div>
    <p class="muted" style="margin-top:12px">Each sandbox bind-mounts ONLY that site's directory — the rest of the fleet stays protected. Memory/CPU/PIDs are capped per container. Unauthenticated worker containers still run with <code>--dangerously-skip-permissions</code> inside their own sandbox; this tab itself is behind the same token gate as the rest of the dashboard.</p>`;

  $('#ds-refresh').addEventListener('click', () => renderDevSandbox());
  wireDevSandboxRows();
  $('#ds-status').value = DS_FILTER.status;
  $('#ds-search').addEventListener('input', e => {
    DS_FILTER.q = e.target.value;
    applyDevSandboxFilter();
  });
  $('#ds-status').addEventListener('change', e => {
    DS_FILTER.status = e.target.value;
    applyDevSandboxFilter();
  });
  applyDevSandboxFilter();
  for (const [site, tab] of DS.open) dsRenderPanel(site, tab);
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

function applyDevSandboxFilter() {
  const q = DS_FILTER.q.trim().toLowerCase();
  const rows = $$('.ds-row');
  const visible = rows.filter(row => {
    const show =
      (!q || (row.dataset.dsName || '').includes(q)) &&
      (DS_FILTER.status === 'all' ||
        row.dataset.dsStatus === DS_FILTER.status ||
        (DS_FILTER.status === 'stopped' &&
          row.dataset.dsStatus !== 'running' &&
          row.dataset.dsStatus !== 'absent'));
    row.classList.toggle('ds-filter-hidden', !show);
    const detail = row.nextElementSibling;
    if (detail && !show) detail.classList.add('hidden');
    return show;
  });
  const count = $('#ds-filter-count');
  if (count) count.textContent = `${visible.length}/${rows.length} shown`;
}

function reloadDevSandbox() {
  FRESH = false;
  UISNAP = captureUI();
  return renderDevSandbox();
}

function wireDevSandboxRows() {
  $$('.ds-act').forEach(b =>
    b.addEventListener('click', () => dsAction(b.dataset.site, b.dataset.act, b))
  );
  $$('.ds-open').forEach(b =>
    b.addEventListener('click', () => dsToggleTab(b.dataset.site, b.dataset.tab))
  );
  $('#ds-stats')?.addEventListener('click', dsShowStats);
  $('#ds-stop-all')?.addEventListener('click', dsStopAll);
  $('#ds-remove-stopped')?.addEventListener('click', dsRemoveStopped);
  $('#ds-clean-orphans')?.addEventListener('click', dsCleanOrphans);
}

async function dsAction(site, act, btn) {
  if (
    act === 'remove' &&
    !(await globalThis.fleetConfirm?.({
      title: 'Remove dev sandbox',
      message: `Remove the dev sandbox for ${site}? Site code and Claude state are untouched.`,
      confirmLabel: 'Remove sandbox',
      danger: true,
    }))
  )
    return;
  gdBusy(btn, true);
  try {
    await api('POST', `/api/devsandbox/${encodeURIComponent(site)}/${act}`);
    toast(
      `${act === 'start' ? 'Started' : act === 'stop' ? 'Stopped' : 'Removed'} ${site} sandbox`
    );
    await reloadDevSandbox();
  } catch (e) {
    toast(`${act} failed: ${e.message}`, 'err');
    gdBusy(btn, false);
  }
}

function dsToggleTab(site, tab) {
  const row = $(`tr[data-detail="ds:${CSS.escape(site)}"]`);
  if (DS.open.get(site) === tab) {
    DS.open.delete(site);
    row.classList.add('hidden');
    return;
  }
  DS.open.set(site, tab);
  row.classList.remove('hidden');
  dsRenderPanel(site, tab);
}

function dsRenderPanel(site, tab) {
  const s = DS.sites.find(x => x.name === site);
  const el = $(`#ds-panel-${CSS.escape(site)}`);
  if (!el || !s) return;
  if (tab === 'term') {
    if (!s.ttydUrl) {
      el.innerHTML = '<div class="empty">Terminal not available — sandbox is not running.</div>';
      return;
    }
    el.innerHTML = `<iframe class="ds-frame" src="${esc(s.ttydUrl)}" allow="clipboard-read; clipboard-write"></iframe>`;
  } else if (tab === 'dev') {
    if (!s.devUrl) {
      el.innerHTML = '<div class="empty">Dev preview not available — sandbox is not running.</div>';
      return;
    }
    el.innerHTML = `
      <div class="cn-log-toolbar muted">
        <span>expects <code>npm run dev</code> on port 4321 in the container</span>
        <span class="cm-spacer"></span>
        <a href="${esc(s.devUrl)}" target="_blank" rel="noopener">↗ ${esc(s.devUrl)}</a>
      </div>
      <iframe class="ds-frame" src="${esc(s.devUrl)}"></iframe>`;
  } else if (tab === 'logs') {
    el.innerHTML = `<pre class="cn-logs-box async-loading" id="ds-logs-${esc(site)}">Loading…</pre>`;
    dsFetchDevLogs(site);
  }
}

async function dsFetchDevLogs(site) {
  const box = $(`#ds-logs-${CSS.escape(site)}`);
  if (!box) return;
  try {
    const r = await fetch(`/api/devsandbox/${encodeURIComponent(site)}/dev/logs?n=400`);
    box.classList.remove('async-loading');
    box.textContent = await r.text();
  } catch (e) {
    box.classList.remove('async-loading');
    box.textContent = `error: ${e.message}`;
  }
}

async function dsShowStats() {
  let r;
  try {
    r = await api('GET', '/api/devsandbox/stats');
  } catch (e) {
    toast(`stats failed: ${e.message}`, 'err');
    return;
  }
  for (const c of r.containers || []) {
    const el = $(`#ds-stat-${CSS.escape(c.site)}`);
    if (el) el.textContent = `${c.cpu} · ${c.mem} · ${c.pids}p`;
  }
  if (!r.containers || !r.containers.length) toast('No running sandboxes');
}

async function dsStopAll() {
  if (
    !(await globalThis.fleetConfirm?.({
      title: 'Stop all dev sandboxes',
      message: 'Stop every running dev sandbox?',
      confirmLabel: 'Stop all',
      danger: true,
    }))
  )
    return;
  try {
    const r = await api('POST', '/api/devsandbox/stop-all');
    if (r.errors && r.errors.length)
      toast(`Some sites failed to stop: ${r.errors.map(e => e.site).join(', ')}`, 'err');
    else toast(`Stopped ${r.stopped.length} sandbox(es)`);
    await reloadDevSandbox();
  } catch (e) {
    toast(`stop-all failed: ${e.message}`, 'err');
  }
}

async function dsRemoveStopped() {
  if (
    !(await globalThis.fleetConfirm?.({
      title: 'Remove stopped sandboxes',
      message:
        'Remove every non-running dev sandbox container? Site code and Claude state are untouched.',
      confirmLabel: 'Remove stopped',
      danger: true,
    }))
  )
    return;
  try {
    const r = await api('POST', '/api/devsandbox/remove-stopped');
    if (r.errors && r.errors.length)
      toast(`Some containers failed to remove: ${r.errors.map(e => e.site).join(', ')}`, 'err');
    else toast(`Removed ${r.removed.length} container(s)`);
    await reloadDevSandbox();
  } catch (e) {
    toast(`remove-stopped failed: ${e.message}`, 'err');
  }
}

async function dsCleanOrphans() {
  let o;
  try {
    o = await api('GET', '/api/devsandbox/orphans');
  } catch (e) {
    toast(`orphan check failed: ${e.message}`, 'err');
    return;
  }
  if (!o.stalePorts.length && !o.danglingContainers.length) {
    toast('No orphans found');
    return;
  }
  const msg = [
    o.danglingContainers.length
      ? `Remove ${o.danglingContainers.length} dangling container(s): ${o.danglingContainers.join(', ')}`
      : null,
    o.stalePorts.length
      ? `Prune ${o.stalePorts.length} stale port allocation(s): ${o.stalePorts.join(', ')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');
  if (
    !(await globalThis.fleetConfirm?.({
      title: 'Clean sandbox orphans',
      message: msg,
      confirmLabel: 'Clean orphans',
      danger: true,
    }))
  )
    return;
  try {
    const r = await api('POST', '/api/devsandbox/orphans/cleanup');
    if (r.errors && r.errors.length)
      toast(`Some cleanup steps failed: ${r.errors.map(e => e.site).join(', ')}`, 'err');
    else toast('Orphans cleaned up');
    await reloadDevSandbox();
  } catch (e) {
    toast(`cleanup failed: ${e.message}`, 'err');
  }
}

/* ===================== SITE FACTS ===================== */
// SEO/trust/branding/ads/legal checks + Amazon ASIN health + manual
// annotations, folded in from the standalone site-tracker tool.
const SF = { open: new Set() };

function sfCellClass(state) {
  return state === 'green' ? 'r-fresh' : state === 'yellow' ? 'r-overdue' : 'r-paused';
}

async function renderSiteFacts() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div class="page-head"><h2 class="page-title">Site Facts</h2><span class="muted">Fleet-wide presence and freshness evidence</span></div><div role="status" aria-live="polite"><div class="loading">Loading site facts…</div></div>';
  let d;
  try {
    d = await api('GET', '/api/sitefacts');
  } catch (e) {
    renderViewError(app, `Site facts failed: ${e.message}`);
    return;
  }

  const swept = d.lastSweep
    ? fmtAge((Date.now() - d.lastSweep) / 1000) + ' ago'
    : 'never (first sweep is still running — hourly checks, give it a minute)';
  const factStates = d.rows.flatMap(row => d.families.map(family => row.cells[family]));
  const present = factStates.filter(state => state === 'green').length;
  const missing = factStates.filter(state => state === 'yellow').length;
  const pending = factStates.length - present - missing;

  const body = d.rows
    .map(row => {
      const cells = d.families
        .map(
          fam =>
            `<td><span class="rdot ${sfCellClass(row.cells[fam])}" title="${esc(fam)}: ${esc(row.cells[fam])}"></span></td>`
        )
        .join('');
      const open = SF.open.has(row.site);
      return `<tr data-fleet-row data-site="${esc(row.site)}">
      <td class="site"><button type="button" class="table-link sf-open" data-site="${esc(row.site)}">${esc(row.site)}</button></td>
      ${cells}
    </tr>
    <tr class="cn-detail-row${open ? '' : ' hidden'}" data-detail="sf:${esc(row.site)}" data-rk="sf:${esc(row.site)}"><td colspan="${d.families.length + 1}">
      <div id="sf-panel-${esc(row.site)}"></div>
    </td></tr>`;
    })
    .join('');

  app.innerHTML = `
    <div class="page-head"><h2 class="page-title">Site Facts</h2><span class="muted">SEO/trust/branding/ads/legal presence checks + Amazon ASIN health — swept hourly, ${d.rows.length} sites</span><button type="button" class="btn" id="sitefacts-refresh">↻ Refresh</button></div>
    <section class="sf-summary" aria-label="Site facts coverage summary">
      <div class="sf-stat"><strong>${d.rows.length}</strong><span>Sites monitored</span></div>
      <div class="sf-stat sf-stat-good"><strong>${present}</strong><span>Checks present</span></div>
      <div class="sf-stat ${missing ? 'sf-stat-warn' : 'sf-stat-good'}"><strong>${missing}</strong><span>Checks missing</span></div>
      <div class="sf-stat ${pending ? 'sf-stat-meta' : 'sf-stat-good'}"><strong>${pending}</strong><span>Awaiting data</span></div>
      <div class="sf-stat sf-stat-meta"><strong>${esc(swept)}</strong><span>Last sweep · ${d.families.length} fact families</span></div>
    </section>
    <div class="card sf-table-card"><div class="table-wrap"><table class="sf-table">
      <thead><tr><th>Site</th>${d.families.map(f => `<th>${esc(f)}</th>`).join('')}</tr></thead>
      <tbody>${body || '<tr><td colspan="99" class="muted">No sites found.</td></tr>'}</tbody>
    </table></div></div>
    <details class="sf-help"><summary>How to read Site Facts</summary><p>Click a site name for the fact-by-fact breakdown, Amazon ASIN health, and manual annotations. <span class="sf-legend sf-legend-present"><i></i>Present</span><span class="sf-legend sf-legend-pending"><i></i>Not yet checked</span><span class="sf-legend sf-legend-missing"><i></i>Missing</span>. These are presence checks, not outages.</p></details>`;

  $('#sitefacts-refresh').addEventListener('click', () => reloadSiteFacts());
  $$('.sf-open').forEach(a =>
    a.addEventListener('click', e => {
      e.preventDefault();
      sfToggle(a.dataset.site);
    })
  );
  for (const site of SF.open) sfRenderPanel(site);
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

function reloadSiteFacts() {
  FRESH = false;
  UISNAP = captureUI();
  return renderSiteFacts();
}

function sfToggle(site) {
  const row = $(`tr[data-detail="sf:${CSS.escape(site)}"]`);
  if (SF.open.has(site)) {
    SF.open.delete(site);
    row.classList.add('hidden');
    return;
  }
  SF.open.add(site);
  row.classList.remove('hidden');
  sfRenderPanel(site);
}

async function sfRenderPanel(site) {
  const el = $(`#sf-panel-${CSS.escape(site)}`);
  if (!el) return;
  el.innerHTML = '<span class="async-loading">Loading…</span>';
  let d;
  try {
    d = await api('GET', `/api/sitefacts/${encodeURIComponent(site)}`);
  } catch (e) {
    el.innerHTML = `<span class="muted">failed: ${esc(e.message)}</span>`;
    return;
  }

  const factRows = d.rows
    .map(
      r => `<tr>
    <td class="mono muted">${esc(r.key)}</td>
    <td>${esc(r.describe)}</td>
    <td>${r.value === true ? '<span class="badge b-green">yes</span>' : r.value === false ? '<span class="badge b-red">no</span>' : '<span class="badge b-gray">unknown</span>'}</td>
  </tr>`
    )
    .join('');

  const tlsRow =
    d.tlsExpiryDays != null
      ? `<span class="${d.tlsExpiryDays < 7 ? 'flag' : d.tlsExpiryDays < 30 ? 'warn' : ''}">${d.tlsExpiryDays}d</span>`
      : '<span class="muted">unknown</span>';

  const amz = d.amz || {};
  const amzLine =
    amz.asin_count != null
      ? `${amz.asin_count} ASINs · ${amz.oos_count ?? 0} OOS · ${amz.delisted_count ?? 0} delisted · last scan ${esc(amz.last_scan || '—')}`
      : '<span class="muted">no amz-stats data for this site</span>';

  const manualRows = Object.entries(d.manual || {})
    .map(
      ([k, v]) => `<tr>
    <td class="mono muted">${esc(k)}</td>
    <td id="sf-manual-${esc(site)}-${esc(k)}">${esc(v.value)}</td>
    <td class="mono muted">${esc(v.setAt || '—')}</td>
    <td><button class="btn sm danger sf-manual-del" data-site="${esc(site)}" data-key="${esc(k)}">delete</button></td>
  </tr>`
    )
    .join('');

  el.innerHTML = `
    <div class="cn-log-toolbar muted"><span>checked ${d.checkedAt ? fmtAge((Date.now() - d.checkedAt) / 1000) + ' ago' : 'never yet'} · TLS expiry: ${tlsRow}</span></div>
    <div class="table-wrap"><table class="sf-detail-table"><tbody>${factRows}</tbody></table></div>
    <div class="section-title" style="margin-top:12px">Amazon affiliate health</div>
    <p class="muted">${amzLine}</p>
    <div class="section-title" style="margin-top:12px">Manual annotations</div>
    <div class="table-wrap"><table class="sf-detail-table"><tbody>${manualRows || '<tr><td colspan="4" class="muted">none yet</td></tr>'}</tbody></table></div>
    <form class="sf-manual-form" data-site="${esc(site)}" style="margin-top:8px;display:flex;gap:6px">
      <input type="text" class="cm-input sf-manual-key" placeholder="key (e.g. adsense_status)" pattern="[-a-zA-Z0-9._]+" required />
      <input type="text" class="cm-input sf-manual-value" placeholder="value" maxlength="500" required />
      <button type="submit" class="btn sm primary">add / update</button>
    </form>`;

  $$(`.sf-manual-del[data-site="${CSS.escape(site)}"]`).forEach(b =>
    b.addEventListener('click', () => sfDeleteManual(site, b.dataset.key))
  );
  el.querySelector('.sf-manual-form')?.addEventListener('submit', e => {
    e.preventDefault();
    sfSetManual(site, el);
  });
}

async function sfSetManual(site, panelEl) {
  const key = panelEl.querySelector('.sf-manual-key').value.trim();
  const value = panelEl.querySelector('.sf-manual-value').value.trim();
  try {
    await api(
      'POST',
      `/api/sitefacts/${encodeURIComponent(site)}/manual/${encodeURIComponent(key)}`,
      { value }
    );
    toast(`Set manual.${key} for ${site}`);
    await sfRenderPanel(site);
  } catch (e) {
    toast(`Save failed: ${e.message}`, 'err');
  }
}
async function sfDeleteManual(site, key) {
  if (
    !(await globalThis.fleetConfirm?.({
      title: 'Delete site fact',
      message: `Delete manual.${key} for ${site}?`,
      confirmLabel: 'Delete fact',
      danger: true,
    }))
  )
    return;
  try {
    await api(
      'DELETE',
      `/api/sitefacts/${encodeURIComponent(site)}/manual/${encodeURIComponent(key)}`
    );
    toast(`Deleted manual.${key}`);
    await sfRenderPanel(site);
  } catch (e) {
    toast(`Delete failed: ${e.message}`, 'err');
  }
}

const gitCls = k =>
  k === 'untracked'
    ? 'unt'
    : k.includes('staged')
      ? 'stg'
      : k === 'deleted' || k === 'D'
        ? 'del'
        : 'mod';

async function toggleGitDetail(slug) {
  const row = $(`tr[data-detail="${CSS.escape(slug)}"]`);
  const box = $(`#gd-${CSS.escape(slug)}`);
  const trigger = $(`tr.git-row[data-slug="${CSS.escape(slug)}"]`);
  if (!row.classList.contains('hidden')) {
    row.classList.add('hidden');
    trigger?.setAttribute('aria-expanded', 'false');
    return;
  }
  row.classList.remove('hidden');
  trigger?.setAttribute('aria-expanded', 'true');
  box.innerHTML = '<span class="async-loading">Loading…</span>';
  await fillGitDetail(slug, box);
}

async function fillGitDetail(slug, box) {
  let s;
  try {
    s = await api('GET', `/api/git/${encodeURIComponent(slug)}`);
  } catch (e) {
    box.innerHTML = `<span class="flag">${esc(e.message)}</span>`;
    return;
  }
  renderGitDetail(slug, box, s);
}

function renderGitDetail(slug, box, s) {
  const lc = s.lastCommit
    ? `<span class="gd-last muted">last commit <span class="mono">${esc(s.lastCommit.hash)}</span> · ${esc(s.lastCommit.subject)} · ${esc(s.lastCommit.when)}</span>`
    : '';
  const pushBtn = `<button type="button" class="btn sm gd-push"${s.ahead ? '' : ' disabled title="Push unavailable — nothing to push"'}>⇧ Push${s.ahead ? ` ${s.ahead}` : ''}</button>`;
  const pullBtn = `<button type="button" class="btn sm gd-pull"${s.behind ? '' : ' disabled title="Pull unavailable — nothing to pull"'}>⇩ Pull${s.behind ? ` ${s.behind}` : ''}</button>`;

  if (!s.files.length) {
    box.innerHTML = `<div class="gd-head">${lc}</div>
      <div class="muted gd-clean">working tree clean${s.behind ? ` · ${s.behind} behind` : ''}</div>
      <div class="gd-commit">${pushBtn} ${pullBtn}</div><div class="gd-result"></div>
    <details class="gd-branches" data-rk="git-branches:${esc(slug)}">
      <summary>Branches</summary>
      <div class="gd-branches-body" data-rkh="git-branches-body:${esc(slug)}"><span class="muted">click to load…</span></div>
    </details>`;
    wireGitOps(slug, box);
    return;
  }

  const fileRows = s.files
    .map(
      f => `<div class="gd-file-wrap">
    <label class="gd-file">
      <input type="checkbox" class="gd-sel" value="${esc(f.path)}" checked />
      <span class="code chip ${gitCls(f.kind)}" title="${esc(f.kind)}">${esc(f.code)}</span>
      <span class="gd-path" title="${esc(f.kind)}">${esc(f.path)}</span>
      <button type="button" class="gd-diff" data-path="${esc(f.path)}" title="Show the diff for this file">diff</button>
      <button type="button" class="gd-ignore" data-path="${esc(f.path)}" title="Add to .gitignore and commit the .gitignore">ignore</button>
    </label>
    <pre class="gd-diff-out hidden" data-diff="${esc(f.path)}"></pre>
    </div>`
    )
    .join('');

  const meta = [
    `${s.files.length} changed`,
    s.staged ? `${s.staged} staged` : '',
    s.untracked ? `${s.untracked} untracked` : '',
    s.ahead ? `${s.ahead} to push` : '',
    s.behind ? `${s.behind} behind` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  box.innerHTML = `
    <div class="gd-head"><span class="section-title" style="margin:0">${esc(meta)}</span>${lc}</div>
    <div class="gd-controls"><a class="gd-all" data-v="1">select all</a><a class="gd-all" data-v="0">none</a></div>
    <div class="gd-files">${fileRows}</div>
    <div class="gd-commit">
      <input class="gd-msg" placeholder="commit message for the selected files…" />
      <button type="button" class="btn sm primary gd-commit-btn">Commit selected</button>
      ${pushBtn} ${pullBtn}
    </div>
    <div class="gd-result"></div>
    <details class="gd-branches" data-rk="git-branches:${esc(slug)}">
      <summary>Branches</summary>
      <div class="gd-branches-body" data-rkh="git-branches-body:${esc(slug)}"><span class="muted">click to load…</span></div>
    </details>`;
  wireGitOps(slug, box);
}

function wireGitOps(slug, box) {
  $$('.gd-all', box).forEach(a =>
    a.addEventListener('click', () =>
      $$('.gd-sel', box).forEach(c => {
        c.checked = a.dataset.v === '1';
      })
    )
  );
  $$('.gd-ignore', box).forEach(b =>
    b.addEventListener('click', e => {
      e.preventDefault();
      gitIgnore(slug, box, b.dataset.path, b);
    })
  );
  $$('.gd-diff', box).forEach(b =>
    b.addEventListener('click', e => {
      e.preventDefault();
      toggleGitFileDiff(slug, box, b.dataset.path, b);
    })
  );
  const cb = $('.gd-commit-btn', box);
  if (cb) cb.addEventListener('click', () => gitCommit(slug, box, cb));
  const pb = $('.gd-push', box);
  if (pb) pb.addEventListener('click', () => gitPush(slug, box, pb));
  const plb = $('.gd-pull', box);
  if (plb) plb.addEventListener('click', () => gitPull(slug, box, plb));
  const brDetails = $('.gd-branches', box);
  if (brDetails) {
    brDetails.addEventListener(
      'toggle',
      () => {
        if (brDetails.open) loadGitBranches(slug, brDetails);
      },
      { once: false }
    );
    // applyUISnap restores this <details> already-open with its previously-rendered
    // (and dataset.loaded="1"-stamped) innerHTML, but that markup carries no live
    // listeners. Clear the stamp so loadGitBranches' own guard doesn't no-op, forcing
    // a genuine reload + rewire of the branch rows/delete buttons.
    if (brDetails.open) {
      const body = $('.gd-branches-body', brDetails);
      if (body) body.dataset.loaded = '';
      loadGitBranches(slug, brDetails);
    }
  }
}

async function loadGitBranches(slug, detailsEl) {
  const body = $('.gd-branches-body', detailsEl);
  if (!body || body.dataset.loaded === '1') return;
  body.innerHTML = '<span class="async-loading">Loading…</span>';
  let b;
  try {
    b = await api('GET', `/api/git/${encodeURIComponent(slug)}/branches`);
  } catch (e) {
    body.innerHTML = `<span class="flag">${esc(e.message)}</span>`;
    return;
  }
  body.dataset.loaded = '1';
  renderGitBranches(slug, body, b);
}

function renderGitBranches(slug, body, b) {
  const localRows =
    b.local
      .map(br => {
        const tags = [
          br.current ? '<span class="badge b-blue">current</span>' : '',
          br.merged
            ? '<span class="badge b-green">merged</span>'
            : '<span class="badge b-yellow">unmerged</span>',
        ]
          .filter(Boolean)
          .join(' ');
        const sync =
          br.ahead || br.behind
            ? `<span class="muted">${br.ahead ? `↑${br.ahead}` : ''}${br.behind ? ` ↓${br.behind}` : ''}</span>`
            : '';
        const canDelete = br.merged && !br.current && br.name !== b.defaultBranch;
        const delBtn = canDelete
          ? `<button type="button" class="btn sm gd-branch-del" data-branch="${esc(br.name)}">delete</button>`
          : '';
        return `<div class="gd-branch-row"><span class="mono">${esc(br.name)}</span> ${tags} <span class="muted">${esc(br.upstream || 'no upstream')}</span> ${sync} ${delBtn}</div>`;
      })
      .join('') || '<div class="muted">no local branches</div>';
  const remoteRows = b.remoteOnly
    .map(
      r =>
        `<div class="gd-branch-row"><span class="mono">${esc(r.name)}</span> <span class="muted">remote-only</span></div>`
    )
    .join('');
  body.innerHTML = `<div class="gd-branch-list">${localRows}</div>${remoteRows ? `<div class="section-title" style="margin:8px 0 4px">Remote-only</div><div class="gd-branch-list">${remoteRows}</div>` : ''}`;
  $$('.gd-branch-del', body).forEach(btn =>
    btn.addEventListener('click', () => deleteGitBranch(slug, body, btn))
  );
}

async function deleteGitBranch(slug, body, btn) {
  const branch = btn.dataset.branch;
  if (
    !(await globalThis.fleetConfirm?.({
      title: 'Delete merged branch',
      message: `Delete merged branch "${branch}" on ${slug}?`,
      confirmLabel: 'Delete branch',
      danger: true,
    }))
  )
    return;
  gdBusy(btn, true);
  try {
    await api(
      'DELETE',
      `/api/git/${encodeURIComponent(slug)}/branches/${encodeURIComponent(branch)}`
    );
    toast(`Deleted branch ${branch}`);
    body.dataset.loaded = '0';
    const r = await api('GET', `/api/git/${encodeURIComponent(slug)}/branches`);
    body.dataset.loaded = '1';
    renderGitBranches(slug, body, r);
  } catch (e) {
    toast(`delete failed: ${e.message}`, 'err');
    gdBusy(btn, false);
  }
}

// F5: toggle the per-file diff preview (working tree vs HEAD; whole file if new).
async function toggleGitFileDiff(slug, box, p, btn) {
  const pre = $(`.gd-diff-out[data-diff="${CSS.escape(p)}"]`, box);
  if (!pre) return;
  if (!pre.classList.contains('hidden')) {
    pre.classList.add('hidden');
    return;
  }
  pre.classList.remove('hidden');
  pre.classList.add('async-loading');
  pre.textContent = 'Loading diff…';
  try {
    const r = await api(
      'GET',
      `/api/git/${encodeURIComponent(slug)}/diff?path=${encodeURIComponent(p)}`
    );
    pre.textContent = r.diff || (r.untracked ? '(new file — no diff)' : '(no changes vs HEAD)');
    pre.classList.remove('async-loading');
  } catch (e) {
    pre.textContent = `diff failed: ${e.message}`;
    pre.classList.remove('async-loading');
  }
}

function gdBusy(btn, on) {
  if (!btn) return;
  if (on) {
    btn._orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
  } else {
    btn.disabled = false;
    if (btn._orig) btn.textContent = btn._orig;
  }
}

async function refreshGitAfterOp(slug, box) {
  let s;
  try {
    s = await api('GET', `/api/git/${encodeURIComponent(slug)}`);
  } catch {
    return;
  }
  renderGitDetail(slug, box, s);
  const row = $(`tr.git-row[data-slug="${CSS.escape(slug)}"]`);
  if (!row) return;
  const tds = row.querySelectorAll('td');
  if (tds[1]) {
    const shaCls =
      { synced: 'b-green', ahead: 'b-yellow', 'diverged-behind': 'b-red', 'no-upstream': 'b-blue' }[
        s.syncState
      ] || 'b-blue';
    const shaLine = `<span class="badge ${shaCls}" title="local vs remote SHA">${esc(s.localSha || '—')} / ${esc(s.remoteSha || '—')}</span>`;
    tds[1].innerHTML = `<span class="mono">${esc(s.branch || '—')}</span> ${shaLine}`;
  }
  if (tds[2])
    tds[2].innerHTML =
      s.dirty > 0
        ? `<span class="badge b-yellow">${s.dirty} uncommitted</span>`
        : '<span class="badge b-green">clean</span>';
  if (tds[3]) {
    const sync = [];
    if (s.ahead) sync.push(`<span class="badge b-blue">↑${s.ahead}</span>`);
    if (s.behind) sync.push(`<span class="badge b-red">↓${s.behind}</span>`);
    if (!s.ahead && !s.behind) sync.push('<span class="muted">synced</span>');
    tds[3].innerHTML = sync.join(' ');
  }
}

async function gitCommit(slug, box, btn) {
  const paths = $$('.gd-sel', box)
    .filter(c => c.checked)
    .map(c => c.value);
  const msg = ($('.gd-msg', box) || {}).value ? $('.gd-msg', box).value.trim() : '';
  if (!paths.length) {
    toast('Select at least one file to commit', 'err');
    return;
  }
  if (!msg) {
    toast('Enter a commit message', 'err');
    return;
  }
  gdBusy(btn, true);
  try {
    await api('POST', `/api/git/${encodeURIComponent(slug)}/commit`, { paths, message: msg });
    toast(`Committed ${paths.length} file(s) on ${slug}`);
    await refreshGitAfterOp(slug, box);
  } catch (e) {
    toast(`commit failed: ${e.message}`, 'err');
    gdBusy(btn, false);
  }
}

async function gitIgnore(slug, box, p, btn) {
  if (
    !(await globalThis.fleetConfirm?.({
      title: 'Ignore Git path',
      message: `Add "${p}" to ${slug}'s .gitignore and commit it? A tracked file will also be removed from the index.`,
      confirmLabel: 'Ignore path',
    }))
  )
    return;
  gdBusy(btn, true);
  try {
    const r = await api('POST', `/api/git/${encodeURIComponent(slug)}/ignore`, { path: p });
    toast(
      r.noop ? `${p} already ignored` : `Ignored ${p}${r.tracked ? ' (untracked + committed)' : ''}`
    );
    await refreshGitAfterOp(slug, box);
  } catch (e) {
    toast(`ignore failed: ${e.message}`, 'err');
    gdBusy(btn, false);
  }
}

async function gitPush(slug, box, btn) {
  gdBusy(btn, true);
  try {
    await api('POST', `/api/git/${encodeURIComponent(slug)}/push`);
    toast(`Pushed ${slug}`);
    await refreshGitAfterOp(slug, box);
  } catch (e) {
    toast(`push failed: ${e.message}`, 'err');
    gdBusy(btn, false);
  }
}

async function gitPull(slug, box, btn) {
  gdBusy(btn, true);
  try {
    await api('POST', `/api/git/${encodeURIComponent(slug)}/pull`);
    toast(`Pulled ${slug}`);
    await refreshGitAfterOp(slug, box);
  } catch (e) {
    toast(`pull failed: ${e.message}`, 'err');
    gdBusy(btn, false);
  }
}

// F6: push every site that's ahead of origin, one call, sequential on the server.
async function pushAllSites() {
  const btn = $('#push-all');
  if (
    !(await globalThis.fleetConfirm?.({
      title: 'Push all sites',
      message: 'Push every site that is ahead of origin? Each pushed site deploys on push.',
      confirmLabel: 'Push all sites',
    }))
  )
    return;
  gdBusy(btn, true);
  toast('Pushing all sites that need it…');
  try {
    const r = await api('POST', '/api/git/push-all');
    const failed = (r.results || []).filter(x => !x.ok);
    toast(
      `Pushed ${r.pushed}/${r.total}${failed.length ? ` · ${failed.length} failed` : ''}`,
      failed.length ? 'err' : 'ok'
    );
    softRender();
  } catch (e) {
    toast(`push-all failed: ${e.message}`, 'err');
    gdBusy(btn, false);
  }
}

// F25: pull every site that's behind origin, one call, sequential on the
// server (git.pullAll mirrors git.pushAll exactly).
async function pullAllSites() {
  const btn = $('#pull-all');
  if (
    !(await globalThis.fleetConfirm?.({
      title: 'Pull all sites',
      message:
        'Pull every site that is behind origin? Repositories with uncommitted changes are skipped.',
      confirmLabel: 'Pull all sites',
    }))
  )
    return;
  gdBusy(btn, true);
  toast('Pulling all sites that need it…');
  try {
    const r = await api('POST', '/api/git/pull-all');
    const failed = (r.results || []).filter(x => !x.ok);
    toast(
      `Pulled ${r.pulled}/${r.total}${failed.length ? ` · ${failed.length} failed` : ''}`,
      failed.length ? 'err' : 'ok'
    );
    softRender();
  } catch (e) {
    toast(`pull-all failed: ${e.message}`, 'err');
    gdBusy(btn, false);
  }
}

/* ===================== GIT STASHES ===================== */
async function renderGitStashes(slug) {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading stashes…</div></div>';
  if (!slug) {
    app.innerHTML = '<div class="empty">No site specified.</div>';
    return;
  }
  let list;
  try {
    list = await api('GET', `/api/git/${encodeURIComponent(slug)}/stashes`);
  } catch (e) {
    renderViewError(app, `Failed to load stashes: ${e.message}`);
    return;
  }

  const rows =
    list
      .map(
        s => `
    <div class="card" style="margin-bottom:10px" data-rk="stash:${esc(s.ref)}">
      <div class="gd-head">
        <span class="mono">${esc(s.ref)}</span>
        <span>${esc(s.message)}</span>
        <span class="muted">${esc(s.when)}</span>
        <button type="button" class="btn sm gs-diff" data-index="${s.index}">view diff</button>
        <button type="button" class="btn sm gs-drop" data-index="${s.index}">drop</button>
      </div>
      <pre class="gd-diff-out hidden" data-stash-diff="${s.index}"></pre>
    </div>`
      )
      .join('') || '<div class="empty">No stashes for this repo.</div>';

  app.innerHTML = `
    <div class="page-head task-page-head">
      <div>
        <h2 class="page-title">Tasks</h2>
        <span class="muted">Track work across the fleet or open one site’s board for hands-on triage.</span>
      </div>
    </div>
    <div class="task-toolbar">
      <a href="#git">← back to Git</a>
      <strong style="margin-left:12px">${esc(slug)} — ${list.length} stash(es)</strong>
    </div>
    ${rows}`;

  $$('.gs-diff', app).forEach(b =>
    b.addEventListener('click', () => toggleStashDiff(slug, b.dataset.index))
  );
  $$('.gs-drop', app).forEach(b =>
    b.addEventListener('click', () => dropStashUI(slug, b.dataset.index))
  );
  if (!FRESH) applyUISnap();
  stamp();
}

async function toggleStashDiff(slug, index) {
  const pre = $(`.gd-diff-out[data-stash-diff="${index}"]`);
  if (!pre) return;
  if (!pre.classList.contains('hidden')) {
    pre.classList.add('hidden');
    return;
  }
  pre.classList.remove('hidden');
  pre.classList.add('async-loading');
  pre.textContent = 'Loading diff…';
  try {
    const r = await api('GET', `/api/git/${encodeURIComponent(slug)}/stashes/${index}/diff`);
    pre.textContent = r.diff || '(empty diff)';
    pre.classList.remove('async-loading');
  } catch (e) {
    pre.textContent = `diff failed: ${e.message}`;
    pre.classList.remove('async-loading');
  }
}

async function dropStashUI(slug, index) {
  if (
    !(await globalThis.fleetConfirm?.({
      title: 'Drop Git stash',
      message: 'Drop this stash? This cannot be undone.',
      confirmLabel: 'Drop stash',
      danger: true,
    }))
  )
    return;
  try {
    await api('DELETE', `/api/git/${encodeURIComponent(slug)}/stashes/${index}`);
    toast('Stash dropped');
    FRESH = true;
    await renderGitStashes(slug);
  } catch (e) {
    toast(`drop failed: ${e.message}`, 'err');
  }
}

/* ===================== ROLES ===================== */
function fmtAge(secs) {
  if (secs == null) return '';
  const s = Math.round(secs);
  return s < 90
    ? `${s}s`
    : s < 5400
      ? `${Math.floor(s / 60)}m`
      : s < 172800
        ? `${Math.floor(s / 3600)}h`
        : `${Math.floor(s / 86400)}d`;
}
const STATE_RANK = { overdue: 3, stale: 2, never: 1, fresh: 0, paused: -1 };
let ROLEMATRIX = null;
let ROLE_OPEN = null; // {site, role} while the role-log modal is open (for live-follow)

// Live-follow: every few seconds, re-tail any open log surface (container log
// panels on the Containers tab, and the role-log modal). Stops itself when the
// tab is hidden or nothing is open.
function logFollowTick() {
  if (document.hidden) return;
  if (STATE.view === 'containers') {
    $$('.cn-detail-row:not(.hidden)').forEach(r => {
      const box = $(`#cl-${CSS.escape(r.dataset.detail)}`);
      if (box) fetchContainerLog(r.dataset.detail, box);
    });
  }
  if (STATE.view === 'agent' && STATE.agent && STATE.agent !== 'engineer') {
    $$('.ag-detail-row:not(.hidden)').forEach(r => {
      const box = $(`#al-${CSS.escape(r.dataset.detail)}`);
      if (box) fetchAgentLog(r.dataset.detail, STATE.agent, box);
    });
  }
  if (STATE.view === 'errors') {
    const drawer = $('#error-drawer-shell');
    if (drawer && !drawer.classList.contains('hidden') && drawer.dataset.id) {
      fetchErrorLines(drawer.dataset.id).then(text => {
        if (!drawer.classList.contains('hidden') && drawer.dataset.id)
          $('#err-drawer-log', drawer).textContent = text;
      });
    }
  }
  if (ROLE_OPEN && !$('#modal').classList.contains('hidden'))
    fetchRoleLog(ROLE_OPEN.site, ROLE_OPEN.role);
}

// Domain Control view state. Module-level so a soft refresh (or a redraw
// after a filter click) keeps the operator's sort/filter choice.
const CONTROL = { sort: 'name', filter: 'all' };

// Per-site roll-up of every role's state — drives the Health column, the row
// sort and the filter counts. Paused roles are excluded from the denominator:
// a deliberately-off role is not a health problem.
function siteRollup(s) {
  const t = { fresh: 0, stale: 0, overdue: 0, paused: 0, never: 0 };
  Object.values(s.cells).forEach(c => {
    t[c.state]++;
  });
  const live = t.fresh + t.stale + t.overdue + t.never;
  return {
    ...t,
    live,
    problems: t.stale + t.overdue + t.never,
    // weighted so "worst first" leads with hard failures, not with whichever
    // site happens to have the most no-log roles
    severity: t.overdue * 5 + t.stale * 2 + t.never,
    pct: live ? Math.round((t.fresh / live) * 100) : null,
  };
}

const STATE_ORDER = ['fresh', 'stale', 'overdue', 'never', 'paused'];

// A stacked proportional bar. Used both per-site (Health column) and per-role
// (under each column header) so a bad row and a bad column read the same way.
function stateBar(t, cls) {
  const segs = STATE_ORDER.filter(k => t[k] > 0)
    .map(k => `<i class="r-${k}" style="flex:${t[k]}"></i>`)
    .join('');
  return `<span class="${cls}">${segs || '<i class="r-none" style="flex:1"></i>'}</span>`;
}

async function renderControl() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Reading role status…</div></div>';
  let data;
  try {
    data = await api('GET', '/api/roles');
  } catch (e) {
    renderViewError(app, `Roles read failed: ${e.message}`);
    return;
  }
  ROLEMATRIX = data;
  CONTROL.filter = ['all', 'fresh', 'attention', 'paused'].includes(STATE.controlFilter)
    ? STATE.controlFilter
    : 'all';
  CONTROL.sort = ['name', 'health'].includes(STATE.controlSort) ? STATE.controlSort : 'name';

  app.innerHTML = `
    <div class="page-head">
      <div><h2 class="page-title">Fleet role coverage</h2><span class="muted">one row per site · role issues include stale, overdue, or missing logs; paused roles are separate</span></div>
      <button type="button" class="btn" id="control-refresh">↻ Refresh</button>
    </div>
    <div id="ctl-bar"></div>
    <div id="ctl-matrix"></div>
    <details class="ctl-help">
      <summary>How to read this</summary>
      <p class="muted">Each cell is one role scheduled on one site.
      ${dotLegend('fresh', 'ran within its cadence')} ·
      ${dotLegend('stale', 'overdue &gt;1×')} ·
      ${dotLegend('overdue', 'overdue &gt;2×')} ·
      ${dotLegend('paused', 'paused (.&lt;role&gt;-disabled)')} ·
      ${dotLegend('never', 'scheduled, no log found')} ·
      <span class="rdot r-none">·</span> not installed.
      <b>Health</b> is the share of a site's non-paused roles that are fresh.
      Bespoke per-site roles are grouped under <b>other</b>.
      The <b>deployer</b> column reflects deploy health (main vs origin):
      ${dotLegend('fresh', 'live or ops-only changes')} ·
      ${dotLegend('stale', 'deploying or site changes pending')} ·
      ${dotLegend('overdue', 'confirmed build failure')}.</p>
    </details>
    <div id="parked-inventory"></div>`;

  $('#control-refresh').addEventListener('click', () => renderControl());
  controlDraw();
  renderParked(); // fills #parked-inventory once its fetch lands — never blocks the matrix
  if (!FRESH) applyUISnap();
  stamp();
}

// Builds the toolbar + matrix from the cached ROLEMATRIX. Split out of
// renderControl so a sort/filter click repaints instantly without refetching.
function controlDraw() {
  const data = ROLEMATRIX;
  if (!data) return;
  const sites = data.sites;

  // Columns = roles scheduled on ≥2 sites (common roles); per-site singletons
  // (e.g. a site's bespoke writers) collapse into a trailing "other" cell.
  const count = {};
  sites.forEach(s =>
    Object.keys(s.cells).forEach(r => {
      count[r] = (count[r] || 0) + 1;
    })
  );
  const core = data.roles.filter(r => count[r] >= 2);
  const coreSet = new Set(core);

  const rolled = sites.map(s => ({ s, r: siteRollup(s) }));
  const nFreshSites = rolled.filter(x => x.r.problems === 0 && x.r.live > 0).length;
  const nAttention = rolled.filter(x => x.r.problems > 0).length;
  const nPaused = rolled.filter(x => x.r.paused > 0).length;

  let rows = rolled;
  if (CONTROL.filter === 'fresh') rows = rows.filter(x => x.r.fresh > 0);
  else if (CONTROL.filter === 'attention') rows = rows.filter(x => x.r.problems > 0);
  else if (CONTROL.filter === 'paused') rows = rows.filter(x => x.r.paused > 0);
  rows =
    CONTROL.sort === 'health'
      ? rows
          .slice()
          .sort(
            (a, b) =>
              b.r.severity - a.r.severity ||
              (a.r.pct ?? 101) - (b.r.pct ?? 101) ||
              a.s.site.localeCompare(b.s.site)
          )
      : rows.slice().sort((a, b) => a.s.site.localeCompare(b.s.site));

  const seg = (k, label, n) =>
    `<button type="button" class="seg-btn${CONTROL.filter === k ? ' active' : ''}" data-ctl-filter="${k}" aria-pressed="${CONTROL.filter === k}">${label}<span class="ctl-n">${n}</span></button>`;

  $('#ctl-bar').innerHTML = `
    <section class="ctl-summary" aria-label="Fleet role coverage summary">
      <div class="ctl-stat ctl-stat-good"><strong>${nFreshSites}</strong><span>Fully green sites</span></div>
      <div class="ctl-stat ${nAttention ? 'ctl-stat-warn' : 'ctl-stat-good'}"><strong>${nAttention}</strong><span>Sites with role issues</span></div>
      <div class="ctl-stat ${nPaused ? 'ctl-stat-paused' : 'ctl-stat-good'}"><strong>${nPaused}</strong><span>Sites with paused roles</span></div>
    </section>
    <div class="ctl-bar">
      <div class="seg sm">
        ${seg('all', 'All sites', sites.length)}
        ${seg('fresh', 'Has fresh roles', rolled.filter(x => x.r.fresh > 0).length)}
        ${seg('attention', 'Role issues', nAttention)}
        ${seg('paused', 'Has paused', nPaused)}
      </div>
      <div class="seg sm">
        <button type="button" class="seg-btn${CONTROL.sort === 'name' ? ' active' : ''}" data-ctl-sort="name" aria-pressed="${CONTROL.sort === 'name'}">A–Z</button>
        <button type="button" class="seg-btn${CONTROL.sort === 'health' ? ' active' : ''}" data-ctl-sort="health" aria-pressed="${CONTROL.sort === 'health'}">Worst first</button>
      </div>
      <span class="ctl-count muted">${rows.length} of ${sites.length} sites · ${core.length} common roles</span>
    </div>`;

  const agentSet = new Set((STATE.agents || []).map(a => a.role));
  // F13: fleet-wide pause/resume per role, next to the column header. Only
  // shown when at least one site's cell for this role is worker-controllable
  // (the same gate roles.setEnabled() enforces server-side); the icon/action
  // reflects the majority state so one click flips the whole column.
  const head =
    '<th class="rsite-h">Site</th><th class="rhealth-h">Health</th>' +
    core
      .map(r => {
        const cells = sites.map(s => s.cells[r]).filter(Boolean);
        const controllable = cells.filter(c => c.worker);
        const anyEnabled = controllable.some(c => c.enabled);
        const bulkBtn = controllable.length
          ? `<button type="button" class="rcol-bulk" data-role="${esc(r)}" data-act="${anyEnabled ? 'pause' : 'resume'}" aria-label="${anyEnabled ? 'Pause' : 'Resume'} ${esc(r)} on all ${controllable.length} site(s)" title="${anyEnabled ? 'Pause' : 'Resume'} ${esc(r)} on all ${controllable.length} site(s)">${anyEnabled ? '⏸' : '▶'}</button>`
          : '';
        const label = agentSet.has(r)
          ? `<a class="rcol-link" data-role="${esc(r)}" title="Open the ${esc(agentLabel(r))} agent page">${esc(agentLabel(r))}</a>`
          : `<span>${esc(agentLabel(r))}</span>`;
        // per-role fleet roll-up, so an unhealthy COLUMN is as visible as an
        // unhealthy row without reading every dot in it
        const rt = { fresh: 0, stale: 0, overdue: 0, paused: 0, never: 0 };
        cells.forEach(c => rt[c.state]++);
        const tip = STATE_ORDER.filter(k => rt[k])
          .map(k => `${rt[k]} ${STATE_LABEL[k] || k}`)
          .join(' · ');
        return `<th class="rcol"><span class="rcol-t">${label}${bulkBtn}</span>${stateBar(rt, 'rcol-bar')}<span class="rcol-tip">${esc(tip)}</span></th>`;
      })
      .join('') +
    '<th class="rcol"><span class="rcol-t"><span>Other</span></span></th>';

  const body = rows
    .map(({ s, r: roll }) => {
      const cells = core
        .map(r => {
          const c = s.cells[r];
          if (!c) return '<td class="rcell"><span class="rdot r-none">·</span></td>';
          // tint the cell itself so clusters of trouble read as a heatmap
          const hot = c.state === 'overdue' || c.state === 'stale' ? ` hot-${c.state}` : '';
          return `<td class="rcell${hot}">${roleDot(s.site, r, c)}</td>`;
        })
        .join('');
      const others = Object.keys(s.cells).filter(r => !coreSet.has(r));
      let otherCell = '<td class="rcell"><span class="rdot r-none">·</span></td>';
      if (others.length) {
        const worst = others.reduce(
          (a, r) => (STATE_RANK[s.cells[r].state] > STATE_RANK[a] ? s.cells[r].state : a),
          'paused'
        );
        const tip = others
          .map(
            r =>
              `${r}: ${s.cells[r].state}${s.cells[r].age != null ? ` (${fmtAge(s.cells[r].age)})` : ''}`
          )
          .join('\n');
        otherCell = `<td class="rcell"><span class="rcount r-${worst}" title="${esc(tip)}">${others.length}</span></td>`;
      }
      const htip = STATE_ORDER.filter(k => roll[k])
        .map(k => `${roll[k]} ${STATE_LABEL[k] || k}`)
        .join(' · ');
      const tone = roll.problems === 0 ? 'ok' : roll.overdue ? 'bad' : 'warn';
      const health = `<td class="rhealth" title="${esc(htip)}">
          ${stateBar(roll, 'rh-bar')}
          <span class="rh-n rh-${tone}">${roll.pct == null ? '—' : roll.pct + '%'}</span>
        </td>`;
      return `<tr data-fleet-row data-site="${esc(s.site)}"><td class="rsite">${siteLink(s.site)}<details class="rmatrix-tools"><summary aria-label="More tools for ${esc(s.site)}" title="More site tools">•••</summary>${toolLinks(s.site)}</details></td>${health}${cells}${otherCell}</tr>`;
    })
    .join('');

  $('#ctl-matrix').innerHTML = rows.length
    ? `<div class="card rmatrix-card"><div class="matrix-scroll-hint" role="note">Swipe horizontally to inspect all role columns · Site stays pinned</div><table class="rmatrix"><caption class="sr-only">Fleet role coverage matrix</caption>
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table></div>`
    : '<div class="card"><div class="empty">No site matches this filter.</div></div>';

  $$('.rdot[data-site]').forEach(d => {
    const open = () => openRole(d.dataset.site, d.dataset.role);
    d.addEventListener('click', open);
    d.addEventListener('keydown', e => {
      if (!['Enter', ' '].includes(e.key)) return;
      e.preventDefault();
      open();
    });
  });
  $$('.rcol-link').forEach(a => a.addEventListener('click', () => go('agent', a.dataset.role)));
  $$('.rcol-bulk').forEach(b =>
    b.addEventListener('click', e => {
      e.stopPropagation();
      bulkToggleRole(b.dataset.role, b.dataset.act);
    })
  );
  $$('[data-ctl-filter]').forEach(b =>
    b.addEventListener('click', () => {
      CONTROL.filter = b.dataset.ctlFilter;
      controlDraw();
    })
  );
  $$('[data-ctl-sort]').forEach(b =>
    b.addEventListener('click', () => {
      CONTROL.sort = b.dataset.ctlSort;
      controlDraw();
    })
  );
  applyFleetFilter();
}

/* ---- retention policy (F20/F43) ----
 * tools/retention/policy.yaml is the single declaration of how long the fleet
 * keeps each class of data. This view reads it and can change retain_days.
 *
 * delete_after_days is deliberately NOT editable here. On this host retention
 * means COMPRESS, not delete: cf-stats is the only historical record of
 * Cloudflare traffic anywhere and nothing backs it up, and the role logs are
 * the audit trail for autonomous publishing runs. Both compress 10-15x, so
 * archiving reclaims essentially all of the space and loses nothing. Enabling
 * deletion should require opening the file and reading that reasoning.
 */
async function renderRetention() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading retention policy…</div></div>';
  let d;
  try {
    d = await api('GET', '/api/retention');
  } catch (e) {
    renderViewError(app, `Could not load retention policy: ${e}`);
    return;
  }
  if (!d.ok) {
    renderViewError(app, d.error || 'Policy unreadable.');
    return;
  }

  const rows = d.classes
    .map(
      c => `
    <tr>
      <td><b>${esc(c.label)}</b><div class="muted">${c.paths.map(esc).join('<br>')}</div></td>
      <td>${esc(c.method || '-')}</td>
      <td>
        <input class="retention-days" type="number" min="1" max="3650" value="${c.retain_days}"
               data-retain="${esc(c.name)}" aria-label="Raw retention days for ${esc(c.label)}">
        <span class="muted">days</span>
      </td>
      <td>${c.delete_after_days == null ? '<span class="muted">never deleted</span>' : `<span class="r-overdue">after ${c.delete_after_days}d</span>`}</td>
      <td class="muted">${esc(c.why || '')}${c.never_touch.length ? `<div>never touches: ${c.never_touch.map(esc).join(', ')}</div>` : ''}</td>
    </tr>`
    )
    .join('');
  const pathCount = d.classes.reduce((sum, c) => sum + c.paths.length, 0);
  const deletionEnabled = d.classes.some(c => c.delete_after_days != null);

  app.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">Retention</h2><span class="muted">how long the fleet keeps each class of data</span></div><button type="button" class="btn" id="retention-refresh">↻ Refresh</button></div>
    <section class="retention-summary" aria-label="Retention policy summary">
      <div class="retention-stat"><strong>${d.classes.length}</strong><span>Policy classes</span></div>
      <div class="retention-stat"><strong>${d.defaults.retain_days}<small>d</small></strong><span>Default raw retention</span></div>
      <div class="retention-stat"><strong>${pathCount}</strong><span>Declared paths</span></div>
      <div class="retention-stat ${deletionEnabled ? 'retention-stat-warn' : 'retention-stat-good'}"><strong>${deletionEnabled ? 'On' : 'Off'}</strong><span>Deletion policy</span></div>
      <div class="retention-stat retention-stat-meta"><strong>04:45</strong><span>Nightly application</span></div>
    </section>
    <div class="retention-toolbar" role="group" aria-label="Retention policy actions">
      <div><strong>Policy file</strong><span class="muted mono">${esc(d.path)}</span></div>
      <button class="btn primary" id="retention-save" type="button">Save changes</button>
      <span id="retention-msg" class="muted" role="status" aria-live="polite"></span>
    </div>
    <div class="card retention-table"><div class="matrix-scroll-hint" role="note">Swipe horizontally to review retention classes and policy details</div><div class="table-wrap" tabindex="0" role="region" aria-label="Retention policy by data class"><table class="rmatrix">
      <caption class="sr-only">Retention policy by data class</caption><thead><tr><th>Class</th><th>Method</th><th>Keep raw</th><th>Deletion</th><th>Why</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div></div>
    <details class="retention-help"><summary>How the policy is applied</summary><p>Retention means <b>compress, not delete</b>. Files past the window are gzipped (stats ledgers) or rolled into one archive per site per day (role logs), verified, and kept. <b>Deletion is file-only</b> and off everywhere; an undeclared path is reported, never swept. The policy is applied nightly at 04:45 by <code>tools/scripts/prune-fleet-data.py</code>.</p></details>`;

  $('#retention-refresh')?.addEventListener('click', () => renderRetention());
  $('#retention-save')?.addEventListener('click', async () => {
    const msg = $('#retention-msg');
    const inputs = $$('[data-retain]');
    let changed = 0,
      failed = 0;
    for (const el of inputs) {
      const klass = el.dataset.retain;
      const want = parseInt(el.value, 10);
      const was = d.classes.find(c => c.name === klass);
      if (!was || want === was.retain_days) continue;
      try {
        const r = await api('POST', '/api/retention', { class: klass, retain_days: want });
        if (r.ok) changed++;
        else {
          failed++;
          msg.textContent = r.error || 'rejected';
        }
      } catch {
        failed++;
      }
    }
    if (msg && !failed) msg.textContent = changed ? `Saved ${changed} change(s).` : 'No changes.';
    if (changed) renderRetention();
  });
  stamp();
}

/* ---- fleet-doctor (F33) ----
 * The fleet's container/image invariants, from tools/fleet-images/bin/fleet-doctor.
 * The script stays the source of truth; this only renders what it reported.
 *
 * A TRUNCATED sweep is rendered as a failure, not a result with a footnote.
 * fleet-doctor exists because "all green" over an incomplete sweep is the exact
 * lie that let 53 hand-maintained image definitions accumulate, so the panel
 * must not be able to show a reassuring green bar over 1 of 33 sites.
 */
async function renderDoctor() {
  const app = $('#app');
  app.innerHTML = `<div class="page-head"><div><h2 class="page-title">Doctor</h2><span class="muted">container &amp; image invariants \u00b7 fleet-wide</span></div><button type="button" class="btn" id="doctor-refresh">↻ Refresh</button></div><div role="status" aria-live="polite"><div class="loading">Loading fleet doctor\u2026</div></div>`;

  let d;
  try {
    d = await api('GET', '/api/fleet-doctor');
  } catch (e) {
    renderViewError(app, `Could not reach /api/fleet-doctor: ${String(e)}`);
    return;
  }

  if (!d.ok) {
    app.innerHTML = `
      <div class="page-head"><div><h2 class="page-title">Doctor</h2><span class="muted">container &amp; image invariants</span></div><button type="button" class="btn" id="doctor-refresh">↻ Refresh</button></div>
      <div class="card"><p class="r-overdue">No result yet${d.error ? `: ${esc(d.error)}` : ''}.</p>
      <p class="muted">${d.running ? 'A sweep is running now \u2014 it takes about a minute.' : 'Press Re-run to start a sweep.'}</p>
      <button class="btn" type="button" id="doctor-run">Re-run</button></div>`;
    $('#doctor-run')?.addEventListener('click', doctorRun);
    return;
  }

  const t = d.totals || {};
  const sitesChecked = t.sites_checked || 0;
  const sitesExpected = t.sites_expected || 0;
  const lastRun = d.last_run ? esc(String(d.last_run).replace('T', ' ').slice(0, 16)) : 'Never';
  const failing = (d.sites || []).filter(s => s.fail > 0);
  const banner = d.truncated
    ? `<div class="doctor-result doctor-result-invalid" role="alert"><b>INVALID SWEEP</b><span>Only ${sitesChecked} of ${sitesExpected} sites were checked. Treat this run as meaningless, not as a pass.</span></div>`
    : failing.length
      ? `<div class="doctor-result doctor-result-bad" role="status"><b>${failing.length} site(s) failing</b><span>Review the failing sites below and re-run after remediation.</span></div>`
      : `<div class="doctor-result doctor-result-good" role="status"><b>Fleet sweep passed</b><span>All ${sitesChecked} sites pass all ${t.pass || 0} checks.</span></div>`;

  const rows = failing
    .map(
      s => `<tr>
       <td>${esc(s.site)}</td>
       <td class="r-overdue">${s.fail}</td>
       <td>${s.pending || 0}</td>
       <td>${s.failures.map(f => `<div>${esc(f)}</div>`).join('')}</td>
     </tr>`
    )
    .join('');

  app.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">Doctor</h2><span class="muted">container &amp; image invariants \u00b7 fleet-wide</span></div><button type="button" class="btn" id="doctor-refresh">↻ Refresh</button></div>
    <section class="doctor-summary" aria-label="Fleet doctor summary">
      <div class="doctor-stat doctor-stat-good"><strong>${t.pass || 0}</strong><span>Checks passed</span></div>
      <div class="doctor-stat ${t.fail ? 'doctor-stat-bad' : 'doctor-stat-good'}"><strong>${t.fail || 0}</strong><span>Checks failed</span></div>
      <div class="doctor-stat ${t.pending ? 'doctor-stat-warn' : 'doctor-stat-good'}"><strong>${t.pending || 0}</strong><span>Checks pending</span></div>
      <div class="doctor-stat ${d.truncated ? 'doctor-stat-bad' : 'doctor-stat-good'}"><strong>${sitesChecked}<small>/${sitesExpected}</small></strong><span>Sites checked</span></div>
      <div class="doctor-stat doctor-stat-meta"><strong>${lastRun}</strong><span>Last sweep</span></div>
    </section>
    <div class="doctor-toolbar" role="group" aria-label="Fleet doctor actions">
      <div><strong>Fleet posture</strong><span class="muted">${sitesChecked}/${sitesExpected} sites checked · ${d.running ? 'sweep in progress' : 'background sweep every 15 minutes'}</span></div>
      <button class="btn" type="button" id="doctor-run" ${d.running ? 'disabled' : ''}>${d.running ? 'Running\u2026' : 'Re-run sweep'}</button>
    </div>
    ${banner}
    ${
      rows
        ? `<div class="card doctor-table"><div class="table-wrap"><table class="rmatrix">
      <thead><tr><th>Site</th><th>Failed</th><th>Pending</th><th>What failed</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`
        : ''
    }
    <details class="doctor-help"><summary>What this sweep checks</summary><p>Source: <code>tools/fleet-images/bin/fleet-doctor --json</code>. Each cron-capable site is checked for the shared image, a bind-mounted (never baked) crontab, a running container on the current image ID, uid 1000, dropped capabilities, and a failable healthcheck.</p></details>`;

  $('#doctor-refresh')?.addEventListener('click', () => renderDoctor());
  $('#doctor-run')?.addEventListener('click', doctorRun);
  stamp();
}

async function doctorRun() {
  const b = $('#doctor-run');
  if (b) {
    b.disabled = true;
    b.textContent = 'Running\u2026';
  }
  try {
    await api('POST', '/api/fleet-doctor/run');
  } catch {
    /* fall through to a re-render, which surfaces the error */
  }
  renderDoctor();
}

/* ---- parked inventory (F51) ----
 * The role matrix above only shows domains that RUN something. The scaffolds
 * — bought, bootstrapped to a COMING SOON page, then left — run nothing, so
 * they were previously visible only inside registry/fleet.yaml. They still
 * cost registrar renewal every year. This panel puts that inventory on the
 * same screen as the fleet it is being compared against.
 *
 * Rendered after the matrix and out-of-band: a slow or failed /api/scaffolds
 * must never delay or blank the thing people actually opened this tab for.
 */
async function renderParked() {
  const el = $('#parked-inventory');
  if (!el) return;
  let d;
  try {
    d = await api('GET', '/api/scaffolds');
  } catch {
    return; // silent: this is supplementary, not the page
  }
  if (!d || !d.ok || !d.rows.length) return;

  const s = d.summary;
  const rows = d.rows
    .map(r => {
      // Anything past a year parked has had every chance. Flag it rather than
      // making the reader do date arithmetic across 23 rows.
      const cls =
        r.days_parked == null
          ? ''
          : r.days_parked >= 365
            ? 'r-overdue'
            : r.days_parked >= 180
              ? 'r-stale'
              : '';
      const parked =
        r.days_parked == null ? '<span class="muted">unknown</span>' : `${r.days_parked}d`;
      // auto_renew decides whether a date needs anyone's attention: an expiry
      // 40 days out is routine if it renews itself, and an emergency if not.
      const renew =
        r.registrar_expires == null
          ? '<span class="muted">unknown</span>'
          : `${esc(r.registrar_expires)}${r.days_to_renewal != null ? ` <span class="muted">(${r.days_to_renewal}d)</span>` : ''}` +
            (r.auto_renew === false ? ' <span class="r-overdue">auto-renew OFF</span>' : '');
      // Capabilities beyond the bare site/ops pair mean prior investment
      // (social accounts provisioned, a feed wired) that a sunset discards.
      const extra = r.capabilities.filter(c => c !== 'site' && c !== 'ops');
      return `<tr>
        <td>${esc(r.domain)}</td>
        <td class="${cls}">${parked}</td>
        <td>${r.scaffolded_on ? esc(r.scaffolded_on) : '<span class="muted">—</span>'}</td>
        <td>${renew}</td>
        <td>${extra.length ? extra.map(c => `<span class="chip">${esc(c)}</span>`).join(' ') : '<span class="muted">none</span>'}</td>
      </tr>`;
    })
    .join('');

  el.innerHTML = `
    <div class="page-head parked-page-head"><h2 class="page-title">Parked inventory</h2><span class="muted">registry entries with <code>status: scaffold</code> — bought and bootstrapped, never built</span></div>
    <section class="parked-summary" aria-label="Parked inventory summary">
      <div class="parked-stat parked-stat-warn"><strong>${s.scaffolds}</strong><span>Parked domains</span></div>
      <div class="parked-stat"><strong>${s.parked_pct}%</strong><span>Of registry entries</span></div>
      <div class="parked-stat ${s.oldest_days_parked >= 365 ? 'parked-stat-bad' : 'parked-stat-warn'}"><strong>${s.oldest_days_parked ?? '?'}<small>d</small></strong><span>Oldest parked</span></div>
      <div class="parked-stat ${s.unknown_renewal ? 'parked-stat-warn' : 'parked-stat-good'}"><strong>${s.unknown_renewal || 0}</strong><span>Renewal dates unknown</span></div>
      <div class="parked-stat ${s.auto_renew_off ? 'parked-stat-bad' : 'parked-stat-good'}"><strong>${s.auto_renew_off || 0}</strong><span>Auto-renew off</span></div>
    </section>
    <div class="parked-toolbar" role="group" aria-label="Parked inventory context">
      <div><strong>Renewal exposure</strong><span class="muted">${s.total_registry_entries} registry entries · ${s.unknown_renewal || 0} missing renewal date${s.unknown_renewal === 1 ? '' : 's'}</span></div>
    </div>
    <div class="card parked-table"><div class="table-wrap"><table class="rmatrix"><caption class="sr-only">Parked domain inventory and renewal exposure</caption>
      <thead><tr><th>Domain</th><th>Parked</th><th>Scaffolded</th><th>Renewal</th><th>Also provisioned</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div></div>
    <details class="parked-help"><summary>How parked age and renewal are calculated</summary><p><b>Parked</b> is measured from the site repo's first commit — bootstrap-domain.sh's initial push — so it cannot drift. <b>Renewal</b> comes from Cloudflare Registrar via <code>tools/registrar</code>, refreshed daily; a hand-owned <code>registrar_expires</code> in <code>registry/fleet.yaml</code> overrides it for domains registered elsewhere. "unknown" means neither source has it.</p></details>`;
}

// F13: pause/resume one role across every site that schedules it as a
// worker role. Sequenced client-side, one site at a time (same shape as
// pushAllSites), so a single slow/failed site can't block the rest and the
// operator gets a per-site result instead of one opaque spinner.
async function bulkToggleRole(role, act) {
  const sites = ((ROLEMATRIX && ROLEMATRIX.sites) || []).filter(
    s => s.cells[role] && s.cells[role].worker
  );
  if (!sites.length) {
    toast(`No worker-controllable sites schedule ${role}`, 'err');
    return;
  }
  const verb = act === 'pause' ? 'Pause' : 'Resume';
  const approved = await globalThis.fleetConfirm?.({
    title: `${verb} ${role}`,
    message: `${verb} ${role} across ${sites.length} site(s)?`,
    confirmLabel: `${verb} sites`,
  });
  if (!approved) return;
  const btn = $(`.rcol-bulk[data-role="${CSS.escape(role)}"]`);
  gdBusy(btn, true);
  toast(`${verb === 'Pause' ? 'Pausing' : 'Resuming'} ${role} on ${sites.length} site(s)…`);
  const results = [];
  for (const s of sites) {
    try {
      await api(
        'POST',
        `/api/roles/${encodeURIComponent(s.site)}/${encodeURIComponent(role)}/${act}`
      );
      results.push({ site: s.site, ok: true });
    } catch (e) {
      results.push({ site: s.site, ok: false, error: e.message });
    }
    if (btn) btn.textContent = `${results.length}/${sites.length}`;
  }
  const failed = results.filter(r => !r.ok);
  toast(
    `${verb}d ${results.length - failed.length}/${results.length} ${role}${failed.length ? ` · failed: ${failed.map(f => f.site).join(', ')}` : ''}`,
    failed.length ? 'err' : 'ok'
  );
  softRender();
}

const STATE_LABEL = {
  fresh: 'fresh',
  stale: 'overdue',
  overdue: 'well overdue',
  paused: 'paused',
  never: 'no log found',
};
function roleDot(site, role, c) {
  let tip;
  if (c.deploy) {
    // Deployer cell = deploy health: push state (main vs origin) refined by the
    // CF build verdict (did Cloudflare actually ship the latest commit?).
    const d = c.deploy,
      b = d.build;
    let health;
    if (d.ahead) health = `${d.ahead} commit${d.ahead > 1 ? 's' : ''} not deployed (unpushed)`;
    else if (d.branch && d.branch !== 'main' && d.branch !== 'master')
      health = `on ${d.branch} (not main)`;
    else if (!d.pushed) health = 'no repo';
    else if (b && b.status === 'failed') health = `build failed${b.reason ? ` — ${b.reason}` : ''}`;
    else if (b && b.status === 'deploying') health = 'deploying — site commit pushed, not live yet';
    else if (b && b.status === 'behind')
      health = 'site changes pending — latest deployable commit is not live';
    else if (b && b.status === 'ops-only') health = 'ops-only changes — production unaffected';
    else if (b && b.ok && b.live) health = `live — CF v${b.version}`;
    else if (b && b.error) health = `in sync (CF check: ${b.error})`;
    else health = 'in sync — deployed';
    const extras = [];
    if (d.dirty) extras.push(`${d.dirty} uncommitted`);
    if (c.age != null) extras.push(`last deploy ${fmtAge(c.age)} ago`);
    if (d.heartbeat) {
      extras.push(
        d.heartbeat.age == null
          ? 'cron heartbeat missing'
          : d.heartbeat.state === 'overdue'
            ? `cron heartbeat overdue (${fmtAge(d.heartbeat.age)} ago)`
            : `cron tick ${fmtAge(d.heartbeat.age)} ago`
      );
    }
    tip = `deployer — ${health}${extras.length ? ' · ' + extras.join(' · ') : ''}`;
  } else {
    tip = `${role} — ${STATE_LABEL[c.state] || c.state}${c.age != null ? ` · last ${fmtAge(c.age)} ago` : ''} · sched ${c.schedule}`;
  }
  return `<span class="rdot r-${c.state}" data-site="${esc(site)}" data-role="${esc(role)}" role="button" tabindex="0" aria-label="Open ${esc(role)} status for ${esc(site)}: ${esc(STATE_LABEL[c.state] || c.state)}" title="${esc(tip)}"></span>`;
}

function roleCell(site, role) {
  const s = ROLEMATRIX && ROLEMATRIX.sites.find(x => x.site === site);
  return s ? s.cells[role] : null;
}

async function openRole(site, role) {
  const title = $('#modal-title'),
    body = $('#modal-body');
  const c = roleCell(site, role);
  title.textContent = `${site} · ${role}`;
  const badgeCls = !c
    ? 'b-gray'
    : !c.enabled
      ? 'b-gray'
      : c.state === 'fresh'
        ? 'b-green'
        : c.state === 'never'
          ? 'b-gray'
          : 'b-yellow';
  const stateTxt = c ? (c.enabled ? STATE_LABEL[c.state] || c.state : 'paused') : '';
  const isAgent = (STATE.agents || []).some(a => a.role === role);
  const ctrl =
    c && c.worker
      ? `<button class="btn sm" id="role-run">▶ Run now</button> <button class="btn sm ${c.enabled ? 'danger' : 'primary'}" id="role-toggle">${c.enabled ? '⏸ Pause role' : '▶ Resume role'}</button>`
      : c
        ? '<span class="muted" style="font-size:11.5px">not pause-controllable</span>'
        : '';
  body.innerHTML = `
    <div class="role-head">
      <span class="badge ${badgeCls}">${esc(stateTxt)}</span>
      ${c ? `<span class="muted">sched <span class="mono">${esc(c.schedule)}</span>${c.age != null ? ` · last ${fmtAge(c.age)} ago` : ''}</span>` : ''}
      ${isAgent ? `<a class="crumb-link" id="role-openpage">open ${esc(agentLabel(role))} page →</a>` : ''}
      <span class="role-ctrl">${ctrl}</span>
    </div>
    <div class="section-title"><span id="role-logfile">latest log</span> <span class="live-tag">live</span></div>
    <pre class="cn-logs-box async-loading" id="role-log">Loading latest log…</pre>`;
  $('#modal').classList.remove('hidden');
  ROLE_OPEN = { site, role };
  const tg = $('#role-toggle');
  if (tg) tg.addEventListener('click', () => toggleRole(site, role, c.enabled));
  const op = $('#role-openpage');
  if (op)
    op.addEventListener('click', () => {
      if (!closeModal()) return;
      go('agent', role);
    });
  const rn = $('#role-run');
  if (rn) rn.addEventListener('click', () => runAgent(site, role, rn));
  await fetchRoleLog(site, role);
}

async function fetchRoleLog(site, role) {
  const pre = $('#role-log');
  if (!pre) return;
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
  try {
    const r = await api(
      'GET',
      `/api/roles/${encodeURIComponent(site)}/${encodeURIComponent(role)}/log?tail=400`
    );
    const f = $('#role-logfile');
    if (f) f.textContent = r.file || 'no log file found';
    pre.classList.remove('async-loading');
    if (pre.textContent !== r.log) {
      pre.textContent = r.log;
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    }
  } catch (e) {
    pre.classList.remove('async-loading');
    if (pre.textContent === 'Loading latest log…') pre.textContent = `error: ${e.message}`;
  }
}

async function toggleRole(site, role, currentlyEnabled) {
  const action = currentlyEnabled ? 'pause' : 'resume';
  const btn = $('#role-toggle');
  gdBusy(btn, true);
  try {
    await api(
      'POST',
      `/api/roles/${encodeURIComponent(site)}/${encodeURIComponent(role)}/${action}`
    );
    toast(`${action === 'pause' ? 'Paused' : 'Resumed'} ${role} on ${site}`);
    FRESH = false;
    UISNAP = captureUI();
    await (STATE.view === 'agent'
      ? STATE.agent === 'engineer'
        ? renderEngineers()
        : renderGenericAgent(STATE.agent)
      : renderControl()); // refresh active view
    await openRole(site, role); // re-open with fresh state
  } catch (e) {
    toast(`${action} failed: ${e.message}`, 'err');
    gdBusy(btn, false);
  }
}

/* ===================== PRODUCT MANAGER PAGE ===================== */
async function renderProductManager(role) {
  const app = $('#app');
  const label = agentLabel(role);
  if (FRESH)
    app.innerHTML = `<div role="status" aria-live="polite"><div class="loading">Loading ${esc(label)} queue…</div></div>`;
  let messages, proposals, actions, workItems, taskQueue, runStatus;
  try {
    [messages, proposals, actions, workItems, taskQueue, runStatus] = await Promise.all([
      api('GET', '/api/executive/messages?limit=200'),
      api('GET', '/api/executive/proposals?limit=200'),
      api('GET', `/api/executive/actions?actor=${encodeURIComponent(role)}&limit=100`),
      api('GET', `/api/executive/work-items?owner=${encodeURIComponent(role)}&limit=200`),
      api('GET', `/api/executive/task-queue?role=${encodeURIComponent(role)}&limit=100`),
      apiOptional('GET', '/api/executive/run-status', { active: null, latest: null, runs: [] }),
    ]);
  } catch (e) {
    renderViewError(app, e.message);
    return;
  }
  const allMessages = messages.messages || [];
  const roleMessages = allMessages.filter(m => m.actor === role || m.metadata?.to === role);
  const roleProposals = (proposals.proposals || []).filter(p => p.created_by === role);
  const roleWork = workItems.work_items || [];
  const roleRequests = taskQueue.requests || [];
  const openWork = roleWork.filter(w => !['done', 'resolved', 'cancelled'].includes(w.status));
  const pendingProposals = roleProposals.filter(p => ['proposed', 'feedback'].includes(p.status));
  const runLabel = runStatus?.active ? 'executive pass in progress' : 'scheduled executive pass';
  const badge = status =>
    `<span class="badge ${status === 'done' || status === 'approved' ? 'b-green' : status === 'blocked' || status === 'failed' ? 'b-red' : status === 'feedback' ? 'b-yellow' : 'b-blue'}">${esc(status)}</span>`;
  const workRows = openWork
    .slice(0, 20)
    .map(
      w =>
        `<tr><td><b>${esc(w.title)}</b><div class="muted">${esc(w.kind)} · ${esc(w.priority)}</div></td><td>${esc(w.summary || '—')}</td><td>${badge(w.status)}</td><td class="muted">${esc(fmtDate(w.updated_at || w.created_at))}</td></tr>`
    )
    .join('');
  const proposalRows = roleProposals
    .slice(0, 20)
    .map(
      p =>
        `<tr><td><b>${esc(p.title)}</b><div class="muted">${esc(p.proposal_type)}</div></td><td>${esc(p.summary)}</td><td>${badge(p.status)}</td><td class="muted">${esc(fmtDate(p.updated_at || p.created_at))}</td></tr>`
    )
    .join('');
  const requestRows = roleRequests
    .slice(0, 12)
    .map(
      r =>
        `<tr><td><b>${esc(r.title || r.action_key || r.request_id)}</b><div class="muted">${esc(r.site || 'fleet')}</div></td><td>${esc(r.assigned_role || role)}</td><td>${badge(r.status)}</td><td class="muted">${esc(fmtDate(r.updated_at || r.created_at))}</td></tr>`
    )
    .join('');
  const messageRows = roleMessages
    .slice(0, 8)
    .map(
      m =>
        `<article class="card" style="margin-bottom:8px"><div class="muted"><b>${esc(executiveActorLabel(m.actor))}</b> · ${esc(fmtDate(m.created_at))}</div><div style="white-space:pre-wrap;margin-top:6px">${esc(m.body)}</div></article>`
    )
    .join('');
  const stat = (value, text) =>
    `<div class="ex-kpi"><b>${esc(value)}</b><span>${esc(text)}</span></div>`;
  app.innerHTML = `${breadcrumb(role)}<div class="ex-shell">
    <header class="ex-hero"><div><div class="ex-eyebrow">PRODUCT MANAGEMENT / ${esc(role === 'product-manager-fleet' ? 'FLEET' : 'MANAGED SITES')}</div><h2 class="page-title">${esc(label)}</h2><p class="muted">Recurring product strategy, evidence, proposals, and implementation handoffs for the executive team.</p></div><div class="task-toolbar"><button type="button" class="btn" id="pm-refresh">↻ Refresh</button><button type="button" class="btn" id="pm-open-executive">Executive overview →</button><button type="button" class="btn primary" id="pm-open-board">Open work queue →</button></div></header>
    <section class="ex-kpis">${stat(openWork.length, 'open work items')}${stat(pendingProposals.length, 'pending proposals')}${stat(roleRequests.filter(r => ['queued', 'claimed', 'running', 'reviewing'].includes(r.status)).length, 'queued handoffs')}${stat(roleMessages.length, 'presentations / updates')}</section>
    <section class="ex-panel"><div class="ex-panel-head"><div><div class="ex-eyebrow">OPERATING RHYTHM</div><h3>Executive cadence</h3><p class="muted">${esc(runLabel)}. This page is the role’s durable inbox and outbox; proposals and updates are presented through the executive control plane.</p></div><span class="badge ${runStatus?.active ? 'b-blue' : 'b-green'}">${runStatus?.active ? 'working now' : 'scheduled'}</span></div></section>
    <details class="ex-disclosure" open><summary><span><b>Work queue</b><small>${openWork.length} active product decisions and discovery items</small></span><span class="ex-chevron">›</span></summary><div class="ex-disclosure-body"><div class="table-wrap"><table class="tbl"><thead><tr><th>Item</th><th>Context</th><th>Status</th><th>Updated</th></tr></thead><tbody>${workRows || '<tr><td colspan="4" class="muted">No active work items assigned to this role yet.</td></tr>'}</tbody></table></div></div></details>
    <details class="ex-disclosure" open><summary><span><b>Product proposals</b><small>${roleProposals.length} proposals presented by this PM</small></span><span class="ex-chevron">›</span></summary><div class="ex-disclosure-body"><div class="table-wrap"><table class="tbl"><thead><tr><th>Proposal</th><th>Summary</th><th>Status</th><th>Updated</th></tr></thead><tbody>${proposalRows || '<tr><td colspan="4" class="muted">No proposals presented yet.</td></tr>'}</tbody></table></div></div></details>
    <details class="ex-disclosure"><summary><span><b>Implementation handoffs</b><small>${roleRequests.length} change requests assigned to this role</small></span><span class="ex-chevron">›</span></summary><div class="ex-disclosure-body"><div class="table-wrap"><table class="tbl"><thead><tr><th>Request</th><th>Owner</th><th>Status</th><th>Updated</th></tr></thead><tbody>${requestRows || '<tr><td colspan="4" class="muted">No implementation handoffs assigned to this role.</td></tr>'}</tbody></table></div></div></details>
    <details class="ex-disclosure"><summary><span><b>Executive presentations</b><small>${roleMessages.length} messages addressed to or sent by this PM</small></span><span class="ex-chevron">›</span></summary><div class="ex-disclosure-body">${messageRows || '<div class="ex-empty">No executive presentations yet.</div>'}</div></details>
  </div>`;
  $('#pm-refresh').onclick = () => renderProductManager(role);
  $('#pm-open-executive').onclick = () => go('agent', 'executive');
  $('#pm-open-board').onclick = () => go('workflow-board');
  wireCrumbs();
  stamp();
}

/* ===================== AGENT PAGE (generic) ===================== */
// One role across the fleet: overview of every site that has it (status, last
// run, schedule, pause/resume) + a per-site zoomed log (live-following).
async function renderGenericAgent(role) {
  const app = $('#app');
  const requestedRole = role;
  if (FRESH)
    app.innerHTML = `<div role="status" aria-live="polite"><div class="loading">Loading ${esc(agentLabel(role))} agent…</div></div>`;
  let data, healthData;
  try {
    [data, healthData] = await Promise.all([
      api('GET', '/api/roles'),
      api('GET', `/api/agents/${encodeURIComponent(role)}/health`).catch(() => null),
    ]);
  } catch (e) {
    if (!routeIs('agent', requestedRole, null)) return;
    renderViewError(app, e.message);
    return;
  }
  if (!routeIs('agent', requestedRole, null)) return;
  ROLEMATRIX = data;
  AGENT_HEALTH = healthData;
  const agentDef = (STATE.agents || []).find(a => a.role === role);
  const profiles = agentDef?.profiles || [role];
  const rows = data.sites.flatMap(s =>
    profiles
      .filter(profile => s.cells[profile])
      .map(profile => ({ site: s.site, profileRole: profile, ...s.cells[profile] }))
  );
  const healthBy = Object.fromEntries(
    (healthData?.rows || []).map(h => [`${h.site}:${h.role || role}`, h])
  );
  const enrolled = new Set(rows.map(r => r.site));
  const notEnrolled = (
    Array.isArray(data.allSites) ? data.allSites : data.sites.map(s => s.site)
  ).filter(site => !enrolled.has(site));
  const enabled = rows.filter(r => r.enabled).length;
  const paused = rows.length - enabled;
  const familyPage = profiles.length > 1;
  const editorialAlerts = rows.flatMap(row => row.editorial?.alerts || []);
  const issues = rows.filter(
    r => r.enabled && (r.state === 'stale' || r.state === 'overdue')
  ).length;
  const suggestedSchedule = rows[0]?.schedule || '0 */2 * * *';
  const healthPanel = healthData ? agentHealthPanel(healthData, rows) : '';

  const body = rows
    .map(r => {
      const actualRole = r.profileRole || role;
      const secondary = agentDef?.secondaryRoles?.includes(actualRole) || false;
      const h = healthBy[`${r.site}:${actualRole}`];
      const runBtn = r.worker
        ? `<button class="btn sm ag-run" data-site="${esc(r.site)}" data-role="${esc(actualRole)}">▶ Run</button>`
        : '';
      const ctrl = r.worker
        ? `${runBtn} <button class="btn sm ${r.enabled ? 'danger' : 'primary'} ag-toggle" data-site="${esc(r.site)}" data-role="${esc(actualRole)}" data-enabled="${r.enabled ? 1 : 0}">${r.enabled ? '⏸ Pause' : '▶ Resume'}</button>`
        : '<span class="muted" style="font-size:11px">not controllable</span>';
      const healthDetails = h
        ? ` <button class="btn sm ag-health-details" type="button" aria-expanded="false" data-site="${esc(r.site)}" data-role="${esc(actualRole)}">Expand</button>`
        : '';
      const badge = !r.enabled
        ? '<span class="badge b-gray">paused</span>'
        : r.state === 'fresh'
          ? '<span class="badge b-green">fresh</span>'
          : r.state === 'never'
            ? '<span class="badge b-gray">no log</span>'
            : `<span class="badge b-yellow">${esc(STATE_LABEL[r.state] || r.state)}</span>`;
      return `<tr class="ag-row" data-fleet-row data-site="${esc(r.site)}">
      <td class="site">${siteLink(r.site)}${toolLinks(r.site)}</td>
      <td>${badge}</td>
      <td class="mono muted">${r.age != null ? esc(fmtAge(r.age)) + ' ago' : '—'}</td>
      <td class="mono muted" title="${esc(r.schedule)}"><span class="badge b-blue">${esc(editorialCadenceLabel(r.cadence))}</span><br>${esc(r.schedule)}</td>
      <td>${editorialTelemetryCell(r.editorial, actualRole, secondary)}</td>
      <td>${agentHealthCell(h)}</td>
      <td class="cn-actions"><button class="btn sm ag-logs" data-site="${esc(r.site)}" data-role="${esc(actualRole)}">📜 Logs</button> ${ctrl}${healthDetails} <button class="btn sm danger ag-remove" data-site="${esc(r.site)}" data-role="${esc(actualRole)}">Remove</button></td>
    </tr>${h ? healthDetailRow(h, 7) : ''}
    <tr class="ag-detail-row hidden" data-detail="${esc(r.site)}" data-rk="ag:${esc(r.site)}"><td colspan="7"><div class="cn-log-head muted">latest log · <span class="live-tag">live</span></div><pre class="cn-logs-box" id="al-${esc(r.site)}" data-rkh="ag:${esc(r.site)}"></pre></td></tr>`;
    })
    .join('');
  const agentSiteView = body
    ? `<div class="card agent-table-card"><div class="matrix-scroll-hint" role="note">Swipe horizontally to inspect agent status and actions</div><div class="agent-table-wrap" tabindex="0" role="region" aria-label="${esc(agentLabel(role))} sites and agent controls"><table class="agent-table">
      <thead><tr><th scope="col">Site</th><th scope="col">Status</th><th scope="col">Last run</th><th scope="col">Cadence</th><th scope="col">Publishing</th><th scope="col">Health · 7d</th><th scope="col">Actions</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div></div>`
    : `<section class="card ag-empty-state" role="status"><strong>No sites enrolled</strong><p>${familyPage ? 'Enrollment is managed through each site’s editorial profile.' : 'Use “show sites” above to choose sites to enroll. Once enrolled, run status and controls will appear here.'}</p></section>`;

  app.innerHTML = `
    ${breadcrumb(role)}
    <div class="page-head"><div><h2 class="page-title">${esc(agentLabel(role))}</h2><span class="muted">${rows.length} sites run this agent</span></div><button type="button" class="btn" id="agent-refresh">↻ Refresh</button></div>
    <div class="task-toolbar">
      <strong>${rows.length} sites</strong>
      <span class="muted">${enabled} enabled · ${paused} paused${issues ? ` · <span class="flag">${issues} overdue</span>` : ''}${editorialAlerts.length ? ` · <span class="flag">${editorialAlerts.length} publishing alert${editorialAlerts.length === 1 ? '' : 's'}</span>` : ''}</span>
      <span class="ag-enrollment-gap">· ${notEnrolled.length} not enrolled <button class="crumb-link ag-missing-toggle" type="button" aria-expanded="false">show sites</button></span>
    </div>
    <div class="card ag-missing-panel hidden" id="ag-missing-panel">
      <div class="ag-missing-head"><strong>Sites not enrolled in ${esc(agentLabel(role))}</strong><span class="muted">${notEnrolled.length} sites</span></div>
      ${
        notEnrolled.length && !familyPage
          ? `<ul class="ag-missing-list">${notEnrolled.map(site => `<li><span>${siteLink(site)}</span><button class="btn sm ag-enroll" type="button" data-site="${esc(site)}" data-role="${esc(role)}" data-schedule="${esc(suggestedSchedule)}">Enroll</button></li>`).join('')}</ul>`
          : familyPage
            ? '<p class="muted ag-missing-empty">Enrollment is managed through the site-specific editorial profile.</p>'
            : '<p class="muted ag-missing-empty">Every discovered site is enrolled in this agent.</p>'
      }
    </div>
    ${healthPanel}
    ${agentSiteView}
    ${body ? `<p class="muted" style="margin-top:12px">Each row is one site running the <b>${esc(agentLabel(role))}</b> agent. Open <b>Logs</b> for the live-tailing latest run, or pause/resume the role per site.</p>` : ''}
    <p class="muted" style="margin-top:12px">← back to <a class="crumb-link" id="crumb-control2">Domain Control</a>.</p>`;

  $('#agent-refresh').addEventListener('click', () => renderGenericAgent(role));
  wireCrumbs();
  const c2 = $('#crumb-control2');
  if (c2) c2.addEventListener('click', () => go('control'));
  const missingToggle = $('.ag-missing-toggle');
  const missingPanel = $('#ag-missing-panel');
  if (missingToggle && missingPanel)
    missingToggle.addEventListener('click', () => {
      const open = missingPanel.classList.toggle('hidden') === false;
      missingToggle.setAttribute('aria-expanded', String(open));
      missingToggle.textContent = open ? 'hide sites' : 'show sites';
    });
  $$('.ag-enroll').forEach(button =>
    button.addEventListener('click', () => {
      beginRoleEnrollment(button.dataset.site, button.dataset.role, button.dataset.schedule);
    })
  );
  $$('.ag-remove').forEach(button =>
    button.addEventListener('click', () =>
      removeRoleEnrollment(button.dataset.site, button.dataset.role, button)
    )
  );
  $$('.ag-logs').forEach(b =>
    b.addEventListener('click', () => toggleAgentLog(b.dataset.site, b.dataset.role || role))
  );
  $$('.ag-toggle').forEach(b =>
    b.addEventListener('click', () =>
      toggleRole(b.dataset.site, b.dataset.role || role, b.dataset.enabled === '1')
    )
  );
  $$('.ag-health-toggle').forEach(b =>
    b.addEventListener('click', () => toggleRole(b.dataset.site, role, b.dataset.enabled === '1'))
  );
  $$('.ag-health-run').forEach(b =>
    b.addEventListener('click', () => runAgent(b.dataset.site, role, b))
  );
  $$('.ag-health-details').forEach(b => b.addEventListener('click', () => toggleHealthDetail(b)));
  // Family pages intentionally have no bulk pause/run controls. Every action
  // must carry the site's exact installed profile role.
  if (!familyPage) {
    $('.ag-health-pause')?.addEventListener('click', () => bulkAgentHealthAction(role, 'pause'));
    $('.ag-health-rerun')?.addEventListener('click', () => bulkAgentHealthAction(role, 'run'));
  }
  $$('.ag-run').forEach(b =>
    b.addEventListener('click', () => runAgent(b.dataset.site, b.dataset.role || role, b))
  );
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

// Fire a worker role now on one site (detached run-worker.sh, work-lock safe).
async function runAgent(site, role, btn) {
  if (btn.disabled) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const r = await api(
      'POST',
      `/api/roles/${encodeURIComponent(site)}/${encodeURIComponent(role)}/run`
    );
    toast(`${agentLabel(role)} triggered on ${site} (${r.container})`);
    btn.textContent = '✓ sent';
    setTimeout(() => {
      btn.textContent = orig;
      btn.disabled = false;
    }, 5000);
  } catch (e) {
    toast(`run failed: ${e.message}`, 'err');
    btn.textContent = orig;
    btn.disabled = false;
  }
}

async function toggleAgentLog(site, role) {
  const row = $(`tr.ag-detail-row[data-detail="${CSS.escape(site)}"]`);
  const box = $(`#al-${CSS.escape(site)}`);
  if (!row.classList.contains('hidden')) {
    row.classList.add('hidden');
    return;
  }
  row.classList.remove('hidden');
  box.classList.add('async-loading');
  box.textContent = 'Loading latest log…';
  await fetchAgentLog(site, role, box);
}

async function fetchAgentLog(site, role, box) {
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  try {
    const r = await api(
      'GET',
      `/api/roles/${encodeURIComponent(site)}/${encodeURIComponent(role)}/log?tail=400`
    );
    box.classList.remove('async-loading');
    if (box.textContent !== r.log) {
      box.textContent = r.log;
      if (atBottom) box.scrollTop = box.scrollHeight;
    }
  } catch (e) {
    box.classList.remove('async-loading');
    if (box.textContent === 'Loading latest log…') box.textContent = `error: ${e.message}`;
  }
}

/* ===================== CONTAINERS ===================== */
async function renderContainers() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div class="page-head"><div><h2 class="page-title">Containers</h2><span class="muted">Live runtime health and lifecycle controls across the fleet</span></div></div><div class="loading" role="status" aria-live="polite">Listing containers…</div>';
  let rows;
  try {
    rows = await api('GET', '/api/containers');
  } catch (e) {
    renderViewError(app, `Container list failed: ${e.message}`);
    return;
  }

  const cron = rows.filter(r => r.kind === 'cron');
  const cronUp = cron.filter(r => r.running).length;
  const workers = rows.filter(r => r.kind === 'worker').length;

  // F15: health tally, same dot-legend pattern as Domain Control / Git.
  const tally = { healthy: 0, unhealthy: 0, stopped: 0 };
  rows.forEach(r => {
    if (!r.running) tally.stopped++;
    else if (r.unhealthy) tally.unhealthy++;
    else tally.healthy++;
  });

  const body = rows
    .map(r => {
      const label =
        r.kind === 'cron' ? 'cron' : r.kind === 'worker' ? 'worker run' : r.service || r.kind;
      const svc = `<span class="badge ${r.kind === 'cron' ? 'b-blue' : r.kind === 'worker' ? 'b-purple' : 'b-gray'}">${esc(label)}</span>`;
      const acts = [
        `<button type="button" class="btn sm cn-logs" data-id="${esc(r.id)}" aria-expanded="false" aria-controls="cn-detail-${esc(r.id)}" aria-label="Show logs for ${esc(r.name)}">📜 Logs</button>`,
      ];
      if (r.running)
        acts.push(
          `<button type="button" class="btn sm cn-act" data-id="${esc(r.id)}" data-act="restart" data-name="${esc(r.name)}" aria-label="Restart ${esc(r.name)}">↻ Restart</button>`
        );
      else
        acts.push(
          `<button type="button" class="btn sm cn-act" data-id="${esc(r.id)}" data-act="start" data-name="${esc(r.name)}" aria-label="Start ${esc(r.name)}">▶ Start</button>`
        );
      if (r.kind === 'cron')
        acts.push(
          `<button type="button" class="btn sm cn-bounce" data-slug="${esc(r.slug)}" data-name="${esc(r.name)}" aria-label="Rebuild ${esc(r.name)}" title="Rebuild image + recreate (Dockerfile/dependency changes)">⟳ Rebuild</button>`
        );
      if (r.running)
        acts.push(
          `<button type="button" class="btn sm danger cn-act" data-id="${esc(r.id)}" data-act="stop" data-name="${esc(r.name)}" aria-label="Stop ${esc(r.name)}">⏹ Stop</button>`
        );
      const state = !r.running ? 'stopped' : r.unhealthy ? 'unhealthy' : 'healthy';
      return `<tr class="cn-row" data-id="${esc(r.id)}" data-fleet-row data-site="${esc(r.scope === 'site' ? r.slug : '')}" data-cn-name="${esc(`${r.name} ${r.slug || ''} ${r.service || ''}`.toLowerCase())}" data-cn-status="${state}" data-cn-kind="${esc(r.kind)}">
      <td class="mono">${esc(r.name)}</td>
      <td>${r.scope === 'site' ? `<span class="site">${esc(r.slug)}</span>` : '<span class="muted">tool</span>'}</td>
      <td>${svc}</td>
      <td>${containerStatus(r)}</td>
      <td class="mono muted">${esc(r.running ? r.runningFor : '—')}</td>
      <td class="cn-actions">${acts.join(' ')}</td>
    </tr>
    <tr class="cn-detail-row hidden" id="cn-detail-${esc(r.id)}" data-detail="${esc(r.id)}" data-rk="cn:${esc(r.id)}"><td colspan="6">
      <div class="cn-log-toolbar muted">
        <span>logs · <span class="live-tag">live</span></span>
        <span class="cm-spacer"></span>
        <input class="cm-input cn-log-filter" data-id="${esc(r.id)}" type="text" placeholder="Filter lines…" spellcheck="false" />
        <label class="cm-chk"><input type="checkbox" class="cn-log-wrap" data-id="${esc(r.id)}" /> Wrap</label>
        <button type="button" class="btn sm cn-log-copy" data-id="${esc(r.id)}" aria-label="Copy logs for ${esc(r.name)}">Copy</button>
        <button type="button" class="btn sm cn-log-download" data-id="${esc(r.id)}" data-name="${esc(r.name)}" aria-label="Download logs for ${esc(r.name)}">Download</button>
      </div>
      <pre class="cn-logs-box" id="cl-${esc(r.id)}" data-rkh="cn:${esc(r.id)}"></pre></td></tr>`;
    })
    .join('');

  app.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">Containers</h2><span class="muted">Live runtime health and lifecycle controls across the fleet</span></div><button type="button" class="btn" id="containers-refresh">↻ Refresh</button></div>
    <section class="cn-summary" aria-label="Container fleet summary">
      <div class="cn-summary-stat"><strong>${rows.length}</strong><span>Total containers</span></div>
      <div class="cn-summary-stat cn-summary-good"><strong>${tally.healthy}</strong><span>Healthy</span></div>
      <div class="cn-summary-stat ${tally.unhealthy ? 'cn-summary-bad' : ''}"><strong>${tally.unhealthy}</strong><span>Unhealthy</span></div>
      <div class="cn-summary-stat ${tally.stopped ? 'cn-summary-warn' : ''}"><strong>${tally.stopped}</strong><span>Stopped</span></div>
      <div class="cn-summary-meta"><strong>${cronUp}/${cron.length}</strong><span>Legacy cron online · ${workers} worker run${workers === 1 ? '' : 's'} in-flight</span></div>
    </section>
    <div class="cn-controls" role="group" aria-label="Filter containers">
      <label class="cn-search"><span class="sr-only">Search containers</span><input id="cn-search" class="cm-input" type="search" placeholder="Search container, site, or service…" value="${esc(CN_FILTER.q)}" autocomplete="off" /></label>
      <label><span class="sr-only">Container status</span><select id="cn-status" class="cm-input"><option value="all">All statuses</option><option value="healthy">Healthy</option><option value="unhealthy">Unhealthy</option><option value="stopped">Stopped</option></select></label>
      <label><span class="sr-only">Container type</span><select id="cn-kind" class="cm-input"><option value="all">All types</option><option value="cron">Cron</option><option value="worker">Worker runs</option><option value="site">Site services</option><option value="tool">Fleet tools</option></select></label>
      <span id="cn-filter-count" class="muted" role="status" aria-live="polite"></span>
      <button type="button" class="btn sm" id="restart-crons" aria-label="Restart legacy schedulers" title="Released-site legacy cron containers only — adopted sites are managed in Ops → Scheduler">↻ Restart legacy schedulers</button>
    </div>
    <div class="card cn-table"><div class="matrix-scroll-hint" role="note">Swipe horizontally to inspect container health and lifecycle actions</div><div class="table-wrap" tabindex="0" role="region" aria-label="Container runtime status and lifecycle controls"><table><caption class="sr-only">Container runtime status and lifecycle controls</caption>
      <thead><tr><th>Container</th><th>Site</th><th>Service</th><th>Status</th><th>Up</th><th>Actions</th></tr></thead>
      <tbody>${body || '<tr><td colspan="6" class="muted">No domains containers running.</td></tr>'}</tbody>
    </table></div></div>
    <details class="cn-help"><summary>What container actions do</summary><p><b>Restart</b> = quick bounce (re-runs the container; picks up bind-mounted crontab / role-flag changes). <b>Rebuild</b> = rebuild image + force-recreate (for Dockerfile / dependency changes). All actions are guard-railed to containers inside the domains repo.</p></details>`;

  wireContainerRows();
  $('#containers-refresh').addEventListener('click', () => renderContainers());
  $('#cn-status').value = CN_FILTER.status;
  $('#cn-kind').value = CN_FILTER.kind;
  $('#cn-search').addEventListener('input', e => {
    CN_FILTER.q = e.target.value;
    applyContainerFilter();
  });
  $('#cn-status').addEventListener('change', e => {
    CN_FILTER.status = e.target.value;
    applyContainerFilter();
  });
  $('#cn-kind').addEventListener('change', e => {
    CN_FILTER.kind = e.target.value;
    applyContainerFilter();
  });
  $('#restart-crons').addEventListener('click', restartAllCrons);
  if (!FRESH) applyUISnap();
  applyContainerFilter();
  applyFleetFilter();
  stamp();
}

function applyContainerFilter() {
  const q = CN_FILTER.q.trim().toLowerCase();
  const matches = $$('tr.cn-row').filter(row => {
    const textMatch = !q || (row.dataset.cnName || '').includes(q);
    const statusMatch = CN_FILTER.status === 'all' || row.dataset.cnStatus === CN_FILTER.status;
    const kindMatch = CN_FILTER.kind === 'all' || row.dataset.cnKind === CN_FILTER.kind;
    const visible = textMatch && statusMatch && kindMatch;
    row.classList.toggle('cn-filter-hidden', !visible);
    const detail = $(`tr[data-detail="${CSS.escape(row.dataset.id || '')}"]`);
    if (detail && !visible) detail.classList.add('hidden');
    return visible;
  });
  const count = $('#cn-filter-count');
  if (count) count.textContent = `${matches.length}/${$$('tr.cn-row').length} shown`;
}

async function restartAllCrons() {
  if (
    !(await globalThis.fleetConfirm?.({
      title: 'Restart legacy schedulers',
      message:
        'Restart all released-site legacy schedulers? Adopted sites are managed in Ops → Scheduler; fleet-cron is excluded.',
      confirmLabel: 'Restart schedulers',
    }))
  )
    return;
  const btn = $('#restart-crons');
  gdBusy(btn, true);
  toast('Restarting legacy schedulers…');
  try {
    const r = await api('POST', '/api/containers/restart-crons');
    toast(
      `Restarted ${r.restarted}/${r.total} legacy schedulers`,
      r.restarted === r.total ? 'ok' : 'err'
    );
    await reloadContainers();
  } catch (e) {
    toast(`restart-all failed: ${e.message}`, 'err');
    gdBusy(btn, false);
  }
}

function containerStatus(r) {
  if (!r.running) return '<span class="badge b-red">stopped</span>';
  if (r.unhealthy) return '<span class="badge b-red">unhealthy</span>';
  if (r.healthy) return '<span class="badge b-green">healthy</span>';
  return '<span class="badge b-green">running</span>';
}

function wireContainerRows() {
  $$('.cn-logs').forEach(b => {
    const detail = $(`tr[data-detail="${CSS.escape(b.dataset.id)}"]`);
    b.setAttribute(
      'aria-expanded',
      String(Boolean(detail && !detail.classList.contains('hidden')))
    );
    b.addEventListener('click', () => toggleContainerLogs(b.dataset.id));
  });
  $$('.cn-act').forEach(b =>
    b.addEventListener('click', () =>
      containerAction(b.dataset.id, b.dataset.act, b.dataset.name, b)
    )
  );
  $$('.cn-bounce').forEach(b =>
    b.addEventListener('click', () => bounceCron(b.dataset.slug, b.dataset.name, b))
  );
  // F26: filter/copy/download toolbar on the container log view (mirrors the
  // Cron tab's cm-log-filter/copy/download, scoped per container id).
  $$('.cn-log-filter').forEach(inp =>
    inp.addEventListener('input', () => {
      cnLogState(inp.dataset.id).filter = inp.value;
      cnApplyLogFilter(inp.dataset.id);
    })
  );
  $$('.cn-log-wrap').forEach(cb =>
    cb.addEventListener('change', e => {
      const box = $(`#cl-${CSS.escape(cb.dataset.id)}`);
      if (box) box.classList.toggle('cm-wrap', e.target.checked);
    })
  );
  $$('.cn-log-copy').forEach(b =>
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(cnLogState(b.dataset.id).raw);
        toast('Copied');
      } catch {
        toast('Copy failed', 'err');
      }
    })
  );
  $$('.cn-log-download').forEach(b =>
    b.addEventListener('click', () => {
      const st = cnLogState(b.dataset.id);
      const blob = new Blob([st.raw], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${b.dataset.name || b.dataset.id}.log`;
      a.click();
      URL.revokeObjectURL(a.href);
    })
  );
}

async function toggleContainerLogs(id) {
  const row = $(`tr[data-detail="${CSS.escape(id)}"]`);
  const box = $(`#cl-${CSS.escape(id)}`);
  const trigger = $(`.cn-logs[data-id="${CSS.escape(id)}"]`);
  if (!row.classList.contains('hidden')) {
    row.classList.add('hidden');
    trigger?.setAttribute('aria-expanded', 'false');
    return;
  }
  row.classList.remove('hidden');
  trigger?.setAttribute('aria-expanded', 'true');
  box.classList.add('async-loading');
  box.textContent = 'Loading logs…';
  await fetchContainerLog(id, box);
}

// F26: per-container raw log text + active filter string, keyed by container
// id — lets the filter/copy/download toolbar act on the unfiltered text even
// while a filter is applied, and survives the periodic live-follow re-fetch.
const CN_LOG = new Map();
function cnLogState(id) {
  if (!CN_LOG.has(id)) CN_LOG.set(id, { raw: '', filter: '' });
  return CN_LOG.get(id);
}
function cnApplyLogFilter(id) {
  const box = $(`#cl-${CSS.escape(id)}`);
  if (!box) return;
  const st = cnLogState(id);
  const f = st.filter.trim().toLowerCase();
  const lines = st.raw.split('\n');
  box.textContent = (f ? lines.filter(l => l.toLowerCase().includes(f)) : lines).join('\n');
}

// Fetch (or re-fetch, for live-follow) a container's logs. Keeps the view
// pinned to the bottom only if it was already there (so manual scroll sticks).
async function fetchContainerLog(id, box) {
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  try {
    const r = await api('GET', `/api/containers/${encodeURIComponent(id)}/logs?tail=300`);
    const st = cnLogState(id);
    if (st.raw !== r.logs) {
      st.raw = r.logs;
      cnApplyLogFilter(id);
      if (atBottom) box.scrollTop = box.scrollHeight;
    }
  } catch (e) {
    box.classList.remove('async-loading');
    if (!box.textContent || box.textContent === 'Loading logs…')
      box.textContent = `error: ${e.message}`;
  }
}

// Re-render the containers view in place (preserving open log panels + scroll).
function reloadContainers() {
  FRESH = false;
  UISNAP = captureUI();
  return renderContainers();
}

async function containerAction(id, act, name, btn) {
  if (
    act === 'stop' &&
    !(await globalThis.fleetConfirm?.({
      title: 'Stop container',
      message: `Stop ${name}? That pauses everything this container runs.`,
      confirmLabel: 'Stop container',
      danger: true,
    }))
  )
    return;
  gdBusy(btn, true);
  try {
    await api('POST', `/api/containers/${encodeURIComponent(id)}/${act}`);
    toast(`${act === 'restart' ? 'Restarted' : act === 'stop' ? 'Stopped' : 'Started'} ${name}`);
    await reloadContainers();
  } catch (e) {
    toast(`${act} failed: ${e.message}`, 'err');
    gdBusy(btn, false);
  }
}

async function bounceCron(slug, name, btn) {
  if (
    !(await globalThis.fleetConfirm?.({
      title: 'Rebuild cron container',
      message: `Rebuild and recreate the cron container for ${slug}? This rebuilds the image and force-recreates the container.`,
      confirmLabel: 'Rebuild container',
    }))
  )
    return;
  gdBusy(btn, true);
  toast(`Rebuilding ${slug} cron — this can take a minute…`);
  try {
    await api('POST', `/api/sites/${encodeURIComponent(slug)}/bounce`);
    toast(`Rebuilt + recreated ${name}`);
    await reloadContainers();
  } catch (e) {
    toast(`rebuild failed: ${e.message}`, 'err');
    gdBusy(btn, false);
  }
}

/* ===================== TASKS ===================== */
const COLS = ['backlog', 'in-progress', 'done', 'hold'];
const COL_LABEL = { backlog: 'Backlog', 'in-progress': 'In Progress', done: 'Done', hold: 'Hold' };
const STAGE_LABEL = {
  backlog: 'not started',
  'in-progress': 'in-progress',
  done: 'done',
  hold: 'hold',
};
const STAGE_ORDER = { 'in-progress': 0, backlog: 1, hold: 2, done: 3 };
const ROLES = [
  'engineer',
  'planner',
  'content-writer',
  'news-writer',
  'affiliate-editor',
  'seo-analyst',
  'watchdog',
  'maintainer',
];
let loadedMeta = {}; // full frontmatter of the task being edited (preserves unknown keys)

// Fleet-aggregator state. Stage defaults to open work (backlog+in-progress),
// matching the page this replaces.
const TASK = {
  mode: 'fleet', // 'fleet' | 'board'
  view: 'tree', // fleet sub-view: 'tree' | 'table'
  all: [], // every task across the fleet
  boardData: null,
  boardPages: {},
  f: {
    priority: new Set(),
    stage: new Set(['backlog', 'in-progress']),
    type: new Set(),
    role: new Set(),
    site: new Set(),
    blocked: '',
    query: '',
  },
};
const TASK_BOARD_PAGE_SIZE = 12;

function prioClass(p) {
  if (p == null || p === '') return 'pn';
  const n = Number(p);
  return n <= 1 ? 'p1' : n === 2 ? 'p2' : n === 3 ? 'p3' : 'pn';
}
function prioTag(p) {
  if (p == null || p === '') return '';
  return `<span class="prio ${prioClass(p)}">P${esc(p)}</span>`;
}

async function renderTasks() {
  const app = $('#app');
  if (!STATE.taskSite) STATE.taskSite = STATE.sites[0] || null;
  // On a silent refresh, keep the existing content visible during the fetch so
  // the board/tree doesn't flash empty — it's swapped in place once data lands.
  const prev =
    !FRESH && $('#task-content')
      ? $('#task-content').innerHTML
      : '<div role="status" aria-live="polite"><div class="loading">Loading tasks…</div></div>';
  app.innerHTML = `
    <div class="page-head task-page-head">
      <div>
        <h2 class="page-title">Tasks</h2>
        <span class="muted">Track work across the fleet or open one site’s board for hands-on triage.</span>
      </div><button type="button" class="btn" id="tasks-refresh">↻ Refresh</button>
    </div>
    <div class="task-toolbar task-route-toolbar">
      <div class="seg" role="group" aria-label="Task view mode">
        <button type="button" class="seg-btn ${TASK.mode === 'fleet' ? 'active' : ''}" data-mode="fleet" aria-pressed="${TASK.mode === 'fleet'}">Fleet</button>
        <button type="button" class="seg-btn ${TASK.mode === 'board' ? 'active' : ''}" data-mode="board" aria-pressed="${TASK.mode === 'board'}">Board</button>
      </div>
      <div id="task-controls" class="task-controls"></div>
      <button type="button" class="btn primary sm task-new-btn" id="new-task">+ New Task</button>
    </div>
    <div id="task-content">${prev}</div>`;
  $('#tasks-refresh').addEventListener('click', () => renderTasks());
  $$('.seg-btn').forEach(b =>
    b.addEventListener('click', () => {
      TASK.mode = b.dataset.mode;
      renderTasks();
    })
  );
  $('#new-task').addEventListener('click', () =>
    openTaskModal({
      mode: 'create',
      site: TASK.mode === 'board' ? STATE.taskSite : STATE.sites[0] || null,
    })
  );
  if (TASK.mode === 'board') renderBoardControls();
  else renderFleetControls();
  if (TASK.mode === 'board') loadBoard();
  else loadFleet();
}

/* ---- Board (per-site CRUD kanban) ---- */
function renderBoardControls() {
  const opts = STATE.sites
    .map(
      s => `<option value="${esc(s)}" ${s === STATE.taskSite ? 'selected' : ''}>${esc(s)}</option>`
    )
    .join('');
  $('#task-controls').innerHTML =
    `<label class="muted" for="task-site">Site</label> <select id="task-site">${opts}</select>`;
  $('#task-site').addEventListener('change', e => {
    STATE.taskSite = e.target.value;
    loadBoard();
  });
}

async function loadBoard() {
  const content = $('#task-content');
  if (!STATE.taskSite) {
    content.innerHTML = '<div class="empty">No sites found.</div>';
    return;
  }
  let data;
  try {
    data = await api('GET', `/api/tasks/${encodeURIComponent(STATE.taskSite)}`);
  } catch (e) {
    renderViewError(content, e.message);
    return;
  }
  renderBoard(data);
}

function renderBoard(data) {
  TASK.boardData = data;
  const titleCounts = new Map();
  COLS.forEach(stage =>
    (data[stage] || []).forEach(task =>
      titleCounts.set(task.title, (titleCounts.get(task.title) || 0) + 1)
    )
  );
  $('#task-content').innerHTML = `<div class="board">${COLS.map(col => {
    const items = data[col] || [];
    const pageKey = `${TASK.taskSite}:${col}`;
    const pageCount = Math.max(1, Math.ceil(items.length / TASK_BOARD_PAGE_SIZE));
    const page = Math.min(Math.max(1, TASK.boardPages[pageKey] || 1), pageCount);
    TASK.boardPages[pageKey] = page;
    const start = (page - 1) * TASK_BOARD_PAGE_SIZE;
    const visible = items.slice(start, start + TASK_BOARD_PAGE_SIZE);
    const cards = visible.length
      ? visible.map(t => boardCard(t, titleCounts.get(t.title) || 1)).join('')
      : '<div class="empty" style="padding:20px;font-size:12px">empty</div>';
    const pagination =
      pageCount > 1
        ? `<nav class="board-pagination" aria-label="${esc(COL_LABEL[col])} task pages"><button type="button" class="btn sm board-page" data-col="${esc(col)}" data-delta="-1" ${page === 1 ? 'disabled' : ''}><span aria-hidden="true">←</span><span class="sr-only">Previous page of ${esc(COL_LABEL[col])} tasks</span></button><span role="status">Page ${page} of ${pageCount} · ${start + 1}–${Math.min(start + TASK_BOARD_PAGE_SIZE, items.length)} of ${items.length}</span><button type="button" class="btn sm board-page" data-col="${esc(col)}" data-delta="1" ${page === pageCount ? 'disabled' : ''}><span aria-hidden="true">→</span><span class="sr-only">Next page of ${esc(COL_LABEL[col])} tasks</span></button></nav>`
        : '';
    return `<div class="col"><div class="col-head"><h3>${COL_LABEL[col]}</h3><span class="count">${items.length}</span></div><div class="col-body">${cards}</div>${pagination}</div>`;
  }).join('')}</div>`;
  $$('.board-page').forEach(button =>
    button.addEventListener('click', () => {
      const key = `${TASK.taskSite}:${button.dataset.col}`;
      TASK.boardPages[key] = (TASK.boardPages[key] || 1) + Number(button.dataset.delta);
      renderBoard(TASK.boardData);
    })
  );
  $$('.task').forEach(el =>
    el.addEventListener('click', () =>
      openTaskModal({
        mode: 'edit',
        site: STATE.taskSite,
        column: el.dataset.col,
        file: el.dataset.file,
      })
    )
  );
  $$('.task').forEach(el =>
    el.addEventListener('keydown', e => {
      if (!['Enter', ' '].includes(e.key)) return;
      e.preventDefault();
      el.click();
    })
  );
  if (!FRESH) applyUISnap();
  stamp();
}

// "Opened" label for a card: prefer the explicit `created` frontmatter (the date
// the ticket was opened); fall back to the file's creation time. Shows the date,
// with the full timestamp on hover.
function openedLabel(t) {
  const dateStr =
    t.created || (t.birthtime ? new Date(t.birthtime).toISOString().slice(0, 10) : null);
  if (!dateStr) return '';
  const full = t.birthtime ? new Date(t.birthtime).toLocaleString() : dateStr;
  return `<div class="t-date" title="opened ${esc(full)}">🕓 ${esc(dateStr)}</div>`;
}

function boardCard(t, duplicateCount = 1) {
  const role = t.assigned_role ? `<span class="badge b-blue">${esc(t.assigned_role)}</span>` : '';
  const type = t.type ? `<span class="badge b-gray">${esc(t.type)}</span>` : '';
  const blk = t.blocked_on ? '<span class="blocked-tag">blocked</span>' : '';
  const repeated =
    duplicateCount > 1
      ? `<span class="task-repeat-note" title="${duplicateCount} task files on this site share this title; each remains a separate task.">${duplicateCount} matching titles</span>`
      : '';
  return `<div class="task ${t.blocked_on ? 'task-blocked' : ''}" data-col="${esc(t.column)}" data-file="${esc(t.file)}" role="button" tabindex="0">
    <span class="sr-only">Open task: </span>
    <div class="t-title">${esc(t.title)}${blk}${repeated}</div>
    <div class="t-meta">${prioTag(t.priority)}${role}${type}</div>
    ${t.excerpt ? `<div class="t-excerpt">${esc(t.excerpt)}</div>` : ''}
    ${openedLabel(t)}
  </div>`;
}

/* ---- Fleet (cross-site aggregator + filters) ---- */
function renderFleetControls() {
  $('#task-controls').innerHTML = `
    <div class="seg sm">
      <button type="button" class="seg-btn ${TASK.view === 'tree' ? 'active' : ''}" id="v-tree" aria-pressed="${TASK.view === 'tree'}">tree</button>
      <button type="button" class="seg-btn ${TASK.view === 'table' ? 'active' : ''}" id="v-table" aria-pressed="${TASK.view === 'table'}">table</button>
    </div>`;
  $('#v-tree').addEventListener('click', () => {
    TASK.view = 'tree';
    renderFleet();
  });
  $('#v-table').addEventListener('click', () => {
    TASK.view = 'table';
    renderFleet();
  });
}

async function loadFleet() {
  const content = $('#task-content');
  try {
    TASK.all = await api('GET', '/api/tasks');
  } catch (e) {
    renderViewError(content, e.message);
    return;
  }
  renderFleet();
}

function fleetFiltered() {
  const f = TASK.f;
  return TASK.all
    .filter(t => {
      const query = TASK.f.query.trim().toLowerCase();
      if (
        query &&
        ![t.title, t.site, t.type, t.assigned_role, t.column, t.excerpt, t.blocked_on]
          .map(value => String(value || '').toLowerCase())
          .join(' ')
          .includes(query)
      )
        return false;
      if (f.priority.size && !f.priority.has(String(t.priority))) return false;
      if (f.stage.size && !f.stage.has(t.column)) return false;
      if (f.type.size && !f.type.has(t.type)) return false;
      if (f.role.size && !f.role.has(t.assigned_role)) return false;
      if (f.site.size && !f.site.has(t.site)) return false;
      if (f.blocked === 'yes' && !t.blocked_on) return false;
      if (f.blocked === 'no' && t.blocked_on) return false;
      return true;
    })
    .sort(
      (a, b) =>
        STAGE_ORDER[a.column] - STAGE_ORDER[b.column] ||
        (a.priority ?? 9) - (b.priority ?? 9) ||
        String(a.created || '9999').localeCompare(String(b.created || '9999'))
    );
}

function pill(group, val, label, extraCls = '') {
  const on = group === 'blocked' ? TASK.f.blocked === val : TASK.f[group].has(val);
  return `<button type="button" class="pill ${on ? 'active ' + extraCls : ''}" data-group="${group}" data-val="${esc(val)}" aria-pressed="${on}">${esc(label)}</button>`;
}

function renderFleet() {
  const content = $('#task-content');
  const all = TASK.all;
  const types = [...new Set(all.map(t => t.type).filter(Boolean))].sort();
  const roles = [...new Set(all.map(t => t.assigned_role).filter(Boolean))].sort();
  const sites = [...new Set(all.map(t => t.site))].sort();
  const rows = fleetFiltered();
  const repeatedTitles = new Map();
  TASK.all.forEach(task => {
    const key = [task.site, task.title].join('\u001f');
    repeatedTitles.set(key, (repeatedTitles.get(key) || 0) + 1);
  });
  const counts = {
    total: rows.length,
    ip: rows.filter(t => t.column === 'in-progress').length,
    bl: rows.filter(t => t.column === 'backlog').length,
    done: rows.filter(t => t.column === 'done').length,
    hold: rows.filter(t => t.column === 'hold').length,
    blocked: rows.filter(t => t.blocked_on).length,
    sites: new Set(rows.map(t => t.site)).size,
  };
  const fc = TASK.f;
  const active =
    fc.priority.size +
    fc.stage.size +
    fc.type.size +
    fc.role.size +
    fc.site.size +
    (fc.blocked ? 1 : 0) +
    (fc.query ? 1 : 0);
  const activeLabels = [
    ...[...fc.priority].map(value => `P${value}`),
    ...[...fc.stage].map(value => STAGE_LABEL[value] || value),
    ...fc.type,
    ...fc.role,
    ...fc.site,
    ...(fc.blocked ? [fc.blocked === 'yes' ? 'blocked only' : 'not blocked'] : []),
  ];
  const activeSummary = activeLabels.length
    ? ` · ${activeLabels.slice(0, 2).join(', ')}${activeLabels.length > 2 ? ` +${activeLabels.length - 2}` : ''}`
    : '';

  const filterPanel = `
    <details class="filter-panel" data-rk="filters">
      <summary>Filters ${active ? `<span class="badge b-blue">${active} active${esc(activeSummary)}</span>` : ''}</summary>
      ${active ? '<div class="filter-actions"><button id="clear-filters" type="button" class="filter-clear">Clear all filters</button></div>' : ''}
      <div class="filter-row"><span class="filter-label">priority</span><div class="pill-group">
        ${[
          ['1', 'P1', 'p1'],
          ['2', 'P2', 'p2'],
          ['3', 'P3', 'p3'],
          ['4', 'P4', 'pn'],
          ['5', 'P5', 'pn'],
        ]
          .map(([v, l, c]) => pill('priority', v, l, c))
          .join('')}</div></div>
      <div class="filter-row"><span class="filter-label">stage</span><div class="pill-group">
        ${COLS.map(c => pill('stage', c, STAGE_LABEL[c])).join('')}</div></div>
      ${types.length ? `<div class="filter-row"><span class="filter-label">type</span><div class="pill-group">${types.map(t => pill('type', t, t)).join('')}</div></div>` : ''}
      ${roles.length ? `<div class="filter-row"><span class="filter-label">role</span><div class="pill-group">${roles.map(r => pill('role', r, r)).join('')}</div></div>` : ''}
      <div class="filter-row"><span class="filter-label">site</span><div class="pill-group">${sites.map(s => pill('site', s, s)).join('')}</div></div>
      <div class="filter-row"><span class="filter-label">blocked</span><div class="pill-group">
        ${pill('blocked', 'no', 'not blocked')}${pill('blocked', 'yes', 'blocked only')}</div></div>
    </details>`;

  const counter = `<section class="tasks-summary" aria-label="Fleet task summary">
    <div class="task-stat"><strong>${counts.total}</strong><span>Visible tasks</span></div>
    <div class="task-stat task-stat-good"><strong>${counts.ip}</strong><span>In progress</span></div>
    <div class="task-stat ${counts.blocked ? 'task-stat-warn' : 'task-stat-good'}"><strong>${counts.blocked}</strong><span>Blocked</span></div>
    <div class="task-stat"><strong>${counts.bl}</strong><span>Backlog</span></div>
    <div class="task-stat task-stat-meta"><strong>${counts.sites}</strong><span>Sites represented · ${counts.done} done · ${counts.hold} hold</span></div>
  </section>`;
  const search = `<label class="task-search">Find a task<input id="task-search" class="cm-input" type="search" aria-label="Search fleet tasks" placeholder="Title, site, role, or blocker…" value="${esc(fc.query)}"></label>`;
  const list = rows.length
    ? TASK.view === 'tree'
      ? fleetTree(rows, repeatedTitles)
      : fleetTable(rows, repeatedTitles)
    : '<p class="empty">No tasks match.</p>';
  content.innerHTML = search + counter + filterPanel + list;

  $('#task-search').addEventListener('input', e => {
    TASK.f.query = e.target.value.trim().toLowerCase();
    renderFleet();
  });

  $$('.pill').forEach(p =>
    p.addEventListener('click', () => togglePill(p.dataset.group, p.dataset.val))
  );
  const clr = $('#clear-filters');
  if (clr)
    clr.addEventListener('click', () => {
      for (const k of ['priority', 'stage', 'type', 'role', 'site']) TASK.f[k].clear();
      TASK.f.blocked = '';
      TASK.f.query = '';
      renderFleet();
    });
  $$('.tree-task, .ttr').forEach(el =>
    el.addEventListener('click', () =>
      openTaskModal({
        mode: 'edit',
        site: el.dataset.site,
        column: el.dataset.col,
        file: el.dataset.file,
      })
    )
  );
  $$('.tree-task, .ttr').forEach(el =>
    el.addEventListener('keydown', e => {
      if (!['Enter', ' '].includes(e.key)) return;
      e.preventDefault();
      el.click();
    })
  );
  $$('.tree-all').forEach(b =>
    b.addEventListener('click', () =>
      $$('.tree-site, .tree-stage').forEach(d => {
        d.open = b.dataset.open === '1';
      })
    )
  );
  if (!FRESH) applyUISnap();
  stamp();
}

function togglePill(group, val) {
  if (group === 'blocked') {
    TASK.f.blocked = TASK.f.blocked === val ? '' : val;
  } else {
    const s = TASK.f[group];
    s.has(val) ? s.delete(val) : s.add(val);
  }
  renderFleet();
}

function fleetTree(rows, repeatedTitles = new Map()) {
  const bySite = {};
  for (const t of rows) (bySite[t.site] = bySite[t.site] || []).push(t);
  const groups = Object.entries(bySite).sort((a, b) => b[1].length - a[1].length);
  const ctrls = `<div class="tree-controls"><span class="muted">Active sites open by default; expand a stage to browse its tasks.</span><span class="tree-control-actions"><button type="button" class="tree-all" data-open="1">expand all</button><button type="button" class="tree-all" data-open="0">collapse all</button></span></div>`;
  const body = groups
    .map(([site, tasks]) => {
      const ip = tasks.filter(t => t.column === 'in-progress').length;
      const bl = tasks.filter(t => t.column === 'backlog').length;
      const stages = COLS.filter(stage => tasks.some(task => task.column === stage));
      const items = stages
        .map(stage => {
          const stageTasks = tasks.filter(task => task.column === stage);
          const blocked = stageTasks.filter(task => task.blocked_on).length;
          const stageItems = stageTasks
            .map(t => {
              const duplicateCount = repeatedTitles.get([t.site, t.title].join('\u001f')) || 1;
              const repeated =
                duplicateCount > 1
                  ? `<span class="task-repeat-note" title="${duplicateCount} task files on this site share this title; each remains a separate task.">${duplicateCount} matching titles</span>`
                  : '';
              return `<div class="tree-task ${t.blocked_on ? 'task-blocked' : ''}" data-site="${esc(t.site)}" data-col="${esc(t.column)}" data-file="${esc(t.file)}" role="button" tabindex="0">
        <span class="sr-only">Open task: </span>
        <span class="prio ${prioClass(t.priority)} tree-pri">${t.priority != null ? 'P' + esc(t.priority) : '—'}</span>
        <span class="tree-type">${esc(t.type || '')}</span>
        <span class="tree-title">${esc(t.title)}${t.blocked_on ? '<span class="blocked-tag">blocked</span>' : ''}${repeated}</span>
        <span class="tree-role">${esc(t.assigned_role || '')}</span>
        <span class="tree-est">${t.estimated_turns ? '~' + esc(t.estimated_turns) + 't' : ''}</span>
      </div>`;
            })
            .join('');
          const open = stage === 'in-progress' || blocked > 0;
          return `<details class="tree-stage" data-rk="tree-stage:${esc(site)}:${esc(stage)}"${open ? ' open' : ''}><summary><span>${STAGE_LABEL[stage]}</span><span class="tree-stage-count">${stageTasks.length}${blocked ? ` · ${blocked} blocked` : ''}</span></summary><div class="tree-tasks">${stageItems}</div></details>`;
        })
        .join('');
      const hasAttention = ip > 0 || tasks.some(t => t.blocked_on);
      return `<details class="tree-site"${hasAttention ? ' open' : ''} data-rk="tree:${esc(site)}"><summary class="tree-summary">
        <span class="tree-site-name">${esc(site)}</span>
        <span class="tree-meta">${ip ? `<span class="badge b-blue">${ip} in-progress</span>` : ''}${bl ? `<span class="badge b-gray">${bl} not started</span>` : ''}</span>
      </summary><div class="tree-stages">${items}</div></details>`;
    })
    .join('');
  return ctrls + `<div class="tree-list">${body}</div>`;
}

function fleetTable(rows, repeatedTitles = new Map()) {
  let lastStage = '';
  const body = rows
    .map(t => {
      const divider =
        t.column !== lastStage
          ? ((lastStage = t.column),
            `<tr class="stage-divider"><td colspan="7">${STAGE_LABEL[t.column]}</td></tr>`)
          : '';
      const duplicateCount = repeatedTitles.get([t.site, t.title].join('\u001f')) || 1;
      const repeated =
        duplicateCount > 1
          ? `<span class="task-repeat-note" title="${duplicateCount} task files on this site share this title; each remains a separate task.">${duplicateCount} matching titles</span>`
          : '';
      return (
        divider +
        `<tr class="ttr ${t.blocked_on ? 'task-blocked' : ''}" data-site="${esc(t.site)}" data-col="${esc(t.column)}" data-file="${esc(t.file)}" role="button" tabindex="0">
      <td><span class="sr-only">Open task: </span><span class="prio ${prioClass(t.priority)}">${t.priority != null ? 'P' + esc(t.priority) : '—'}</span></td>
      <td class="mono">${esc(t.site)}</td>
      <td><span class="badge b-gray">${STAGE_LABEL[t.column]}</span></td>
      <td>${esc(t.type || '')}</td>
      <td>${esc(t.title)}${t.blocked_on ? '<span class="blocked-tag">blocked</span>' : ''}${repeated}</td>
      <td>${esc(t.assigned_role || '')}</td>
      <td class="mono">${esc(t.created || '')}</td>
    </tr>`
      );
    })
    .join('');
  return `<div class="card"><div class="table-wrap"><table class="tasks-table"><caption class="sr-only">Fleet tasks</caption>
    <thead><tr><th>P</th><th>Site</th><th>Stage</th><th>Type</th><th>Title</th><th>Role</th><th>Created</th></tr></thead>
    <tbody>${body}</tbody></table></div></div>`;
}

/* ---- shared editor / CRUD ---- */
async function openTaskModal({ mode, site, column, file }) {
  const modal = $('#modal'),
    title = $('#modal-title'),
    bodyEl = $('#modal-body');
  site = site || STATE.taskSite || STATE.sites[0];
  let meta = { priority: 2 },
    body = '';
  loadedMeta = {};

  if (mode === 'edit') {
    try {
      const t = await api(
        'GET',
        `/api/tasks/${encodeURIComponent(site)}/${encodeURIComponent(column)}/${encodeURIComponent(file)}`
      );
      loadedMeta = t.meta || {};
      meta = { ...loadedMeta };
      body = t.body || '';
    } catch (e) {
      toast(e.message, 'err');
      return;
    }
  }
  // F16: bulk assignment — create mode only. A checkbox swaps the single-site
  // select for a multi-select; on save, the same POST the single-site path
  // already uses is looped client-side, one task file per selected site
  // (mirrors pushAllSites' "loop + await" bulk pattern — no new bulk endpoint).
  const siteSel =
    mode === 'create'
      ? `<div class="field" id="f-site-wrap"><label>Site</label><select id="f-site">${STATE.sites.map(s => `<option value="${esc(s)}" ${s === site ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
       <div class="field"><label><input type="checkbox" id="f-bulk-toggle" /> Assign to multiple sites</label></div>
       <div class="field hidden" id="f-bulk-wrap">
         <label>Sites (ctrl/cmd-click to select multiple)</label>
         <select id="f-sites-multi" multiple size="6">${STATE.sites.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}</select>
         <span class="muted" style="font-size:11px">Creates one copy of this task per selected site.</span>
       </div>`
      : '';
  title.textContent = mode === 'create' ? 'New task' : `Edit · ${site} · ${file}`;

  const colOpts = sel =>
    COLS.map(
      c => `<option value="${c}" ${c === sel ? 'selected' : ''}>${COL_LABEL[c]}</option>`
    ).join('');
  const roleSet = [...new Set([...ROLES, meta.assigned_role].filter(Boolean))];
  const roleOpts = [
    '<option value="">—</option>',
    ...roleSet.map(
      r =>
        `<option value="${esc(r)}" ${r === meta.assigned_role ? 'selected' : ''}>${esc(r)}</option>`
    ),
  ].join('');

  bodyEl.innerHTML = `
    ${siteSel}
    <div class="field"><label>Title</label><input id="f-title" value="${esc(meta.title || '')}" placeholder="Short imperative summary" /></div>
    <div class="row3">
      <div class="field"><label>Priority</label><select id="f-priority">${[0, 1, 2, 3, 4, 5].map(p => `<option value="${p}" ${String(meta.priority) === String(p) ? 'selected' : ''}>P${p}</option>`).join('')}</select></div>
      <div class="field"><label>Type</label><input id="f-type" value="${esc(meta.type || '')}" placeholder="content / ops / seo…" /></div>
      <div class="field"><label>Est. turns</label><input id="f-turns" value="${esc(meta.estimated_turns || '')}" placeholder="3" /></div>
    </div>
    <div class="row3">
      <div class="field"><label>Assigned role</label><select id="f-role">${roleOpts}</select></div>
      <div class="field"><label>Column</label><select id="f-col">${colOpts(column || 'backlog')}</select></div>
      <div class="field"><label>Blocked on</label><input id="f-blocked" value="${esc(meta.blocked_on || '')}" placeholder="(empty = not blocked)" /></div>
    </div>
    <div class="field"><label>Body (markdown)</label><textarea id="f-body" rows="12" placeholder="## Problem…">${esc(body)}</textarea></div>
    <div class="modal-foot">
      ${mode === 'edit' ? '<button class="btn danger spacer" id="f-delete">Delete</button>' : ''}
      <button class="btn" id="f-cancel">Cancel</button>
      <button class="btn primary" id="f-save">${mode === 'create' ? 'Create' : 'Save'}</button>
    </div>`;

  modal.classList.remove('hidden');
  $('#f-cancel').onclick = closeModal;
  $('#f-save').onclick = () => saveTask({ mode, site, origColumn: column, file });
  if (mode === 'edit') $('#f-delete').onclick = () => deleteTask(site, column, file);
  const bulkToggle = $('#f-bulk-toggle');
  if (bulkToggle) {
    bulkToggle.addEventListener('change', e => {
      $('#f-site-wrap').classList.toggle('hidden', e.target.checked);
      $('#f-bulk-wrap').classList.toggle('hidden', !e.target.checked);
    });
  }
}

function collectMeta() {
  const num = v => (v === '' || v == null ? undefined : Number(v));
  // Start from the preserved frontmatter so unknown keys survive a round-trip.
  const meta = { ...loadedMeta };
  meta.title = $('#f-title').value.trim();
  meta.priority = num($('#f-priority').value);
  meta.type = $('#f-type').value.trim() || undefined;
  meta.estimated_turns = num($('#f-turns').value);
  meta.assigned_role = $('#f-role').value || undefined;
  meta.blocked_on = $('#f-blocked').value.trim() || undefined;
  return meta;
}

async function saveTask({ mode, site, origColumn, file }) {
  const meta = collectMeta();
  const body = $('#f-body').value;
  const targetCol = $('#f-col').value;
  if (!meta.title) {
    toast('Title is required', 'err');
    return;
  }

  const bulkToggle = $('#f-bulk-toggle');
  if (mode === 'create' && bulkToggle && bulkToggle.checked) {
    const sites = [...$('#f-sites-multi').selectedOptions].map(o => o.value);
    if (!sites.length) {
      toast('Select at least one site', 'err');
      return;
    }
    const saveBtn = $('#f-save');
    gdBusy(saveBtn, true);
    let ok = 0;
    const failed = [];
    for (const s of sites) {
      try {
        await api('POST', `/api/tasks/${encodeURIComponent(s)}/${encodeURIComponent(targetCol)}`, {
          ...meta,
          body,
        });
        ok++;
      } catch (e) {
        failed.push(`${s}: ${e.message}`);
      }
    }
    toast(
      `Created task on ${ok}/${sites.length} site(s)${failed.length ? ' · failed: ' + failed.join('; ') : ''}`,
      failed.length ? 'err' : 'ok'
    );
    closeModal(true);
    if (TASK.mode === 'board') loadBoard();
    else loadFleet();
    return;
  }

  const targetSite = mode === 'create' ? ($('#f-site') ? $('#f-site').value : site) : site;
  const base = `/api/tasks/${encodeURIComponent(targetSite)}`;
  try {
    if (mode === 'create') {
      await api('POST', `${base}/${encodeURIComponent(targetCol)}`, { ...meta, body });
      toast('Task created');
    } else {
      await api('PUT', `${base}/${encodeURIComponent(origColumn)}/${encodeURIComponent(file)}`, {
        meta,
        body,
      });
      if (targetCol !== origColumn)
        await api(
          'POST',
          `${base}/${encodeURIComponent(origColumn)}/${encodeURIComponent(file)}/move`,
          { to: targetCol }
        );
      toast('Task saved');
    }
    closeModal(true);
    if (TASK.mode === 'board') loadBoard();
    else loadFleet();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function deleteTask(site, column, file) {
  if (
    !(await globalThis.fleetConfirm?.({
      title: 'Move task to trash',
      message: `Move task "${file}" to ops/tasks/.trash/? It is recoverable and will not be permanently removed.`,
      confirmLabel: 'Move to trash',
      danger: true,
    }))
  )
    return;
  try {
    await api(
      'DELETE',
      `/api/tasks/${encodeURIComponent(site)}/${encodeURIComponent(column)}/${encodeURIComponent(file)}`
    );
    toast('Task moved to trash');
    closeModal(true);
    if (TASK.mode === 'board') loadBoard();
    else loadFleet();
  } catch (e) {
    toast(e.message, 'err');
  }
}

let MODAL_FORM_BASELINE = null;
let MODAL_TEXT_CANCEL = null;

function modalFormSnapshot() {
  const modal = $('#modal');
  if (!modal || modal.classList.contains('hidden')) return [];
  return [...modal.querySelectorAll('input, select, textarea')]
    .filter(el => !['password', 'file'].includes((el.type || '').toLowerCase()))
    .map((el, index) => ({
      key: el.id || el.name || `${el.tagName.toLowerCase()}:${index}`,
      type: el.type || el.tagName.toLowerCase(),
      value:
        el.tagName === 'SELECT' && el.multiple
          ? [...el.selectedOptions].map(option => option.value)
          : el.value,
      checked: el.type === 'checkbox' || el.type === 'radio' ? el.checked : undefined,
    }));
}

function modalFormIsDirty() {
  if (!MODAL_FORM_BASELINE) return false;
  return JSON.stringify(modalFormSnapshot()) !== JSON.stringify(MODAL_FORM_BASELINE);
}

function watchModalFormState() {
  const modal = $('#modal');
  const body = $('#modal-body');
  if (!modal || !body || typeof MutationObserver === 'undefined') return;
  const capture = () => {
    if (modal.classList.contains('hidden')) {
      MODAL_FORM_BASELINE = null;
      return;
    }
    MODAL_FORM_BASELINE = modalFormSnapshot();
  };
  new MutationObserver(capture).observe(modal, {
    attributes: true,
    attributeFilter: ['class'],
    childList: true,
    subtree: true,
  });
  capture();
}

function closeModal(force = false) {
  if (!force && modalFormIsDirty()) {
    const modal = $('#modal');
    const title = $('#modal-title');
    const body = $('#modal-body');
    const previousTitle = title?.textContent || '';
    const previousBody = body?.innerHTML || '';
    const previousBaseline = MODAL_FORM_BASELINE;
    const previousRole = ROLE_OPEN;
    const confirmation = globalThis.fleetConfirm?.({
      title: 'Discard unsaved changes?',
      message: 'The changes in this editor have not been saved. Discard them and close the editor?',
      confirmLabel: 'Discard changes',
      danger: true,
    });
    confirmation?.then(approved => {
      if (approved) closeModal(true);
      else {
        if (title) title.textContent = previousTitle;
        if (body) body.innerHTML = previousBody;
        if (modal) modal.classList.remove('hidden');
        MODAL_FORM_BASELINE = previousBaseline;
        ROLE_OPEN = previousRole;
        requestAnimationFrame(() => {
          body?.querySelector('input, select, textarea, button')?.focus?.();
        });
      }
    });
    return false;
  }
  const cancelTextRequest = MODAL_TEXT_CANCEL;
  MODAL_TEXT_CANCEL = null;
  $('#modal').classList.add('hidden');
  MODAL_FORM_BASELINE = null;
  ROLE_OPEN = null;
  cancelTextRequest?.();
  return true;
}
// Shell-level navigation (saved views, rail affordances) can use the same
// dirty-editor guard as in-app route buttons without coupling shell.js to the
// modal implementation.
globalThis.fleetBeforeNavigate = () => closeModal();

function requestModalText({
  title,
  label,
  placeholder = '',
  required = false,
  submitLabel = 'Continue',
}) {
  return new Promise(resolve => {
    const modal = $('#modal');
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML =
      `<div class="field"><label for="modal-text-entry">${esc(label)}</label><textarea id="modal-text-entry" rows="6" placeholder="${esc(placeholder)}"></textarea></div><div class="modal-actions"><button class="btn" id="modal-text-cancel" type="button">Cancel</button><button class="btn primary" id="modal-text-submit" type="button">${esc(submitLabel)}</button></div>`;
    modal.classList.remove('hidden');
    const input = $('#modal-text-entry');
    const finish = value => {
      MODAL_TEXT_CANCEL = null;
      closeModal(true);
      resolve(value);
    };
    MODAL_TEXT_CANCEL = () => resolve(null);
    $('#modal-text-cancel').onclick = () => finish(null);
    $('#modal-text-submit').onclick = () => {
      const value = input.value.trim();
      if (required && !value) {
        input.setCustomValidity('Enter a value to continue.');
        input.reportValidity?.();
        input.focus();
        return;
      }
      finish(value);
    };
    input.addEventListener('input', () => input.setCustomValidity(''));
    input.focus();
  });
}
globalThis.fleetTextPrompt = requestModalText;

function requestModalConfirm({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    const modal = $('#modal');
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML =
      `<p class="modal-confirm-message">${esc(message)}</p><div class="modal-actions"><button class="btn" id="modal-confirm-cancel" type="button">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="modal-confirm-submit" type="button">${esc(confirmLabel)}</button></div>`;
    modal.classList.remove('hidden');
    const finish = value => {
      MODAL_TEXT_CANCEL = null;
      closeModal(true);
      resolve(value);
    };
    MODAL_TEXT_CANCEL = () => resolve(false);
    $('#modal-confirm-cancel').onclick = () => finish(false);
    $('#modal-confirm-submit').onclick = () => finish(true);
    $('#modal-confirm-submit').focus();
  });
}
globalThis.fleetConfirm = requestModalConfirm;

/* ===================== CRON ===================== */
// Crontab-line control plane, folded in from the retired cron-manager tool.
// Operates at the crontab-LINE level (edit schedule, comment/remove a line,
// diff vs the baked-in crontab, revert, rebuild) across sites/* AND tools/*.
const CM = {
  bySlug: new Map(),
  collapsed: cmLoadCollapsed(),
  rebuildLog: new Map(), // slug → last rebuild output (this session)
  runLog: new Map(), // "slug:role" → last run output (this session)
  editing: null, // { slug, lineIndex } while inline-editing
};
function cmLoadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem('fd.cron.collapsed') || '[]'));
  } catch {
    return new Set();
  }
}
function cmSaveCollapsed() {
  try {
    localStorage.setItem('fd.cron.collapsed', JSON.stringify([...CM.collapsed]));
  } catch {}
}
function cmHasCollapsePreference() {
  try {
    return localStorage.getItem('fd.cron.collapsed') !== null;
  } catch {
    return false;
  }
}
function cmRel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return d.toLocaleDateString();
}

async function renderCron() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Reading crontabs…</div></div>';
  let systems;
  try {
    systems = await api('GET', '/api/cron/systems');
  } catch (e) {
    renderViewError(app, `Cron read failed: ${e.message}`);
    return;
  }

  CM.bySlug.clear();
  systems.forEach(s => CM.bySlug.set(s.slug, s));
  // Failed / stale / down float to the top for immediate visibility.
  systems.sort((a, b) => {
    const rank = s => (s.failed ? 0 : s.needsRebuild ? 1 : s.status === 'running' ? 2 : 3);
    return rank(a) - rank(b);
  });
  // Keep the first visit focused on systems that need operator attention.
  // An explicit Expand all / Collapse all choice is persisted and always wins
  // over this default, so returning operators keep their preferred density.
  if (!cmHasCollapsePreference()) {
    systems.filter(s => !s.failed && !s.needsRebuild).forEach(s => CM.collapsed.add(s.slug));
    cmSaveCollapsed();
  }

  const running = systems.filter(s => s.status === 'running').length;
  const failed = systems.filter(s => s.failed);
  const dirty = systems.filter(s => s.needsRebuild).length;

  app.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">Cron</h2><span class="muted">legacy line-level control across ${systems.length} systems · edit, diff, and rebuild</span></div><div class="page-actions"><a class="btn sm" href="#scheduler">Open Scheduler →</a><button type="button" class="btn" id="cron-refresh">↻ Refresh</button></div></div>
    <div class="task-toolbar">
      <strong>${systems.length} systems</strong>
      <span class="muted"><span class="cm-st on"></span>${running} running · <span class="cm-st off"></span>${failed.length} failed · ${dirty} need rebuild</span>
      <button type="button" class="btn sm" id="cm-collapse-all" style="margin-left:auto">Collapse all</button>
      <button type="button" class="btn sm" id="cm-expand-all">Expand all</button>
    </div>
    <div class="matrix-scroll-hint cron-scroll-hint" role="note">Expanded cron job tables swipe horizontally to reach schedules, run times, and actions</div>
    <div class="cm-systems">${systems.map(s => cmCard(s)).join('')}</div>
    <p class="muted" style="margin-top:12px">Each card is one cron container (a site or tool). Edits write the on-disk <span class="mono">crontab.docker</span>; the container keeps running its baked-in copy until you <b>Rebuild &amp; restart</b>. <b>Pause/Resume</b> on a worker role toggles its <span class="mono">.&lt;role&gt;-disabled</span> flag (instant, no rebuild). <span class="cm-badge stale">stale</span> = disk crontab changed since the last build — rebuild or revert.</p>`;

  $('#cron-refresh').addEventListener('click', () => renderCron());
  cmWireCards();
  // Apply to the DOM directly, NOT via softRender() — softRender captures the
  // current [data-rk] visibility and re-applies it in applyUISnap(), which would
  // clobber the collapse state we just set (the cards would bounce right back).
  $('#cm-collapse-all').addEventListener('click', () => {
    systems.forEach(s => CM.collapsed.add(s.slug));
    cmSaveCollapsed();
    cmApplyCollapsed();
  });
  $('#cm-expand-all').addEventListener('click', () => {
    CM.collapsed.clear();
    cmSaveCollapsed();
    cmApplyCollapsed();
  });
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

function cmCard(sys) {
  const collapsed = CM.collapsed.has(sys.slug);
  const st = sys.status;
  const isStale = st === 'running' && sys.needsRebuild;
  const badgeCls = sys.failed
    ? 'failed'
    : isStale
      ? 'stale'
      : st === 'running'
        ? 'running'
        : 'stopped';
  const badgeLabel = isStale ? 'stale' : st;
  const exit = sys.exitCode != null ? ` · exit ${sys.exitCode}` : '';
  const badgeTitle = isStale
    ? esc((sys.statusText || st) + ' · crontab changed since last build')
    : esc((sys.statusText || st) + exit);

  const rows = sys.entries.length
    ? sys.entries.map(e => cmRow(sys, e)).join('')
    : '<tr><td colspan="5" class="muted">No cron entries.</td></tr>';

  const foot = [
    `<button class="btn sm primary cm-rebuild${sys.needsRebuild ? ' dirty' : ''}" data-slug="${esc(sys.slug)}">⟳ Rebuild &amp; restart</button>`,
    `<button class="btn sm cm-logs" data-slug="${esc(sys.slug)}" data-source="container">📜 Logs</button>`,
  ];
  if (isStale) {
    foot.push(`<button class="btn sm cm-diff" data-slug="${esc(sys.slug)}">≡ View diff</button>`);
    foot.push(
      `<button class="btn sm danger cm-revert" data-slug="${esc(sys.slug)}">↩ Revert</button>`
    );
  }
  const hint = sys.needsRebuild
    ? `<span class="cm-hint">${isStale ? 'running stale crontab — rebuild or revert' : 'crontab changed — rebuild to apply'}</span>`
    : '';

  const bodyId = `cm-body-${sys.slug}`;
  return `<section class="cm-card${sys.failed ? ' cm-failed' : ''}" data-fleet-row data-site="${esc(sys.kind === 'site' ? sys.slug : '')}" aria-labelledby="cm-title-${esc(sys.slug)}">
    <div class="cm-head" data-slug="${esc(sys.slug)}">
      <button type="button" class="cm-collapse" data-slug="${esc(sys.slug)}" aria-expanded="${!collapsed}" aria-controls="${esc(bodyId)}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${esc(sys.slug)} cron jobs" title="${collapsed ? 'Expand' : 'Collapse'}">${collapsed ? '▸' : '▾'}</button>
      <span class="cm-name" id="cm-title-${esc(sys.slug)}">${esc(sys.slug)}</span>
      <span class="cm-kind">${esc(sys.kind)}</span>
      <span class="cm-badge ${badgeCls}" title="${badgeTitle}">${esc(badgeLabel)}</span>
      ${sys.needsRebuild && !isStale ? '<span class="cm-badge stale">needs rebuild</span>' : ''}
      <span class="cm-container mono">${esc(sys.container)}</span>
    </div>
    <div class="cm-body${collapsed ? ' hidden' : ''}" id="${esc(bodyId)}" data-rk="cron:${esc(sys.slug)}">
      <div class="table-wrap" tabindex="0" role="region" aria-label="${esc(sys.slug)} cron jobs and controls"><table class="cm-jobs"><caption class="sr-only">${esc(sys.slug)} cron jobs and controls</caption>
        <thead><tr><th scope="col">State</th><th scope="col">Job</th><th scope="col">Schedule</th><th scope="col">Last run</th><th scope="col">Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="cm-foot">${foot.join(' ')}${hint}
        <button type="button" class="btn sm cm-addjob" data-slug="${esc(sys.slug)}" style="margin-left:auto">+ Add job</button>
      </div>
    </div>
  </section>`;
}

function cmRow(sys, e) {
  const r = cmRel(e.lastRun);
  const exCls = e.lastExit === 0 ? 'ok' : e.lastExit != null ? 'bad' : '';
  const last = r
    ? `<span class="cm-last${e.hasLog ? ' cm-clickable' : ''}" data-slug="${esc(sys.slug)}" data-role="${esc(e.role || '')}" title="${esc(e.lastRun)}${e.lastExit != null ? ' · exit ' + e.lastExit : ''}">${exCls ? `<span class="cm-ex ${exCls}"></span>` : ''}${esc(r)}</span>`
    : '<span class="muted">—</span>';
  const job = e.role
    ? `<span class="cm-job" title="${esc(e.command)}">${esc(e.role)}</span>`
    : `<span class="cm-job cmd" title="${esc(e.command)}">${esc(e.command)}</span>`;

  const acts = [
    `<button type="button" class="btn sm cm-toggle" data-line="${e.lineIndex}">${e.enabled ? 'Pause' : 'Resume'}</button>`,
    `<button type="button" class="btn sm cm-edit" data-line="${e.lineIndex}">Edit</button>`,
  ];
  if (e.hasLog)
    acts.push(
      `<button type="button" class="btn sm cm-rolelog" data-role="${esc(e.role)}">Log</button>`
    );
  if (e.role && sys.status === 'running')
    acts.push(
      `<button type="button" class="btn sm cm-run" data-role="${esc(e.role)}">Run</button>`
    );
  acts.push(
    `<button type="button" class="btn sm danger cm-remove" data-line="${e.lineIndex}">Remove</button>`
  );

  return `<tr class="cm-jobrow${e.enabled ? '' : ' cm-paused'}" data-slug="${esc(sys.slug)}" data-line="${e.lineIndex}">
    <td><span class="cm-state ${e.enabled ? 'on' : 'off'}">${e.enabled ? 'on' : 'paused'}</span></td>
    <td>${job}</td>
    <td><span class="cm-sched"><span class="cm-human">${esc(e.human || e.schedule)}</span><span class="cm-expr mono">${esc(e.schedule)}</span></span></td>
    <td>${last}</td>
    <td class="cn-actions">${acts.join(' ')}</td>
  </tr>`;
}

// Look up the live entry object for a (slug, lineIndex) — needed for rawLine
// (stale-line check) and schedule on demand.
function cmEntry(slug, lineIndex) {
  const sys = CM.bySlug.get(slug);
  return sys ? sys.entries.find(e => e.lineIndex === Number(lineIndex)) : null;
}

function cmWireCards() {
  $$('.cm-collapse').forEach(b =>
    b.addEventListener('click', ev => {
      ev.stopPropagation();
      cmToggleCollapse(b.dataset.slug);
    })
  );
  $$('.cm-head').forEach(h =>
    h.addEventListener('click', ev => {
      if (ev.target.closest('button')) return;
      cmToggleCollapse(h.dataset.slug);
    })
  );
  $$('.cm-rebuild').forEach(b => b.addEventListener('click', () => cmDoRebuild(b.dataset.slug, b)));
  $$('.cm-logs').forEach(b =>
    b.addEventListener('click', () => cmOpenLogs(b.dataset.slug, b.dataset.source))
  );
  $$('.cm-diff').forEach(b => b.addEventListener('click', () => cmOpenDiff(b.dataset.slug)));
  $$('.cm-revert').forEach(b => b.addEventListener('click', () => cmDoRevert(b.dataset.slug)));
  $$('.cm-toggle').forEach(b =>
    b.addEventListener('click', () => cmToggleJob(b.closest('tr').dataset.slug, b.dataset.line))
  );
  $$('.cm-edit').forEach(b => b.addEventListener('click', () => cmEditJob(b.closest('tr'))));
  $$('.cm-remove').forEach(b =>
    b.addEventListener('click', () => cmRemoveJob(b.closest('tr').dataset.slug, b.dataset.line))
  );
  $$('.cm-run').forEach(b =>
    b.addEventListener('click', () => cmRunJob(b.closest('tr').dataset.slug, b.dataset.role, b))
  );
  $$('.cm-rolelog').forEach(b =>
    b.addEventListener('click', () =>
      cmOpenLogs(b.closest('tr').dataset.slug, `role:${b.dataset.role}`)
    )
  );
  $$('.cm-last.cm-clickable').forEach(s =>
    s.addEventListener('click', () => {
      if (s.dataset.role) cmOpenLogs(s.dataset.slug, `role:${s.dataset.role}`);
    })
  );
  $$('.cm-addjob').forEach(b => b.addEventListener('click', () => cmOpenAddJob(b.dataset.slug)));
}

function cmToggleCollapse(slug) {
  if (CM.collapsed.has(slug)) CM.collapsed.delete(slug);
  else CM.collapsed.add(slug);
  cmSaveCollapsed();
  cmApplyCollapsed(slug);
}

// Reflect CM.collapsed into the DOM (body .hidden + chevron) without a re-render,
// so it survives applyUISnap(). Pass a slug to update one card, or omit for all.
function cmApplyCollapsed(slug) {
  const btns = slug ? $$(`.cm-collapse[data-slug="${CSS.escape(slug)}"]`) : $$('.cm-collapse');
  btns.forEach(btn => {
    const s = btn.dataset.slug;
    const collapsed = CM.collapsed.has(s);
    const body = $(`.cm-body[data-rk="cron:${CSS.escape(s)}"]`);
    if (body) body.classList.toggle('hidden', collapsed);
    btn.textContent = collapsed ? '▸' : '▾';
    btn.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${s} cron jobs`);
    btn.setAttribute('aria-expanded', String(!collapsed));
  });
}

/* ---- inline schedule editor ---- */
const CM_PRESETS = [
  ['*/15 * * * *', 'Every 15 min'],
  ['0 * * * *', 'Hourly'],
  ['*/30 * * * *', 'Every 30 min'],
  ['0 6 * * *', 'Daily 6am'],
  ['0 7 * * 1', 'Mon 7am'],
  ['0 9 1 * *', 'Monthly'],
];
function cmCloseEditor() {
  $$('.cm-editor-row').forEach(r => r.remove());
  CM.editing = null;
}

async function cmCloseEditorSafely() {
  const row = $('.cm-editor-row');
  if (!row) {
    cmCloseEditor();
    return true;
  }
  if (!(await closeInlineDraft(row, 'cron schedule draft'))) return false;
  row.remove();
  CM.editing = null;
  return true;
}

async function cmEditJob(tr) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('cm-editor-row')) {
    await cmCloseEditorSafely();
    return;
  }
  if (!(await cmCloseEditorSafely())) return;
  if (!(await cmCloseAddJobSafely())) return;
  const slug = tr.dataset.slug;
  const e = cmEntry(slug, tr.dataset.line);
  if (!e) return;
  CM.editing = { slug, lineIndex: e.lineIndex };
  const row = document.createElement('tr');
  row.className = 'cm-editor-row';
  row.innerHTML = `<td colspan="5"><div class="cm-editor">
    <div class="cm-ed-top">
      <span class="muted">Schedule for <b>${esc(e.role || e.command)}</b></span>
      <input class="cm-input cm-cron" type="text" spellcheck="false" autocomplete="off" value="${esc(e.schedule)}" />
      <span class="cm-ed-dirty" hidden>● unsaved</span>
    </div>
    <div class="cm-ed-verdict"></div>
    <div class="cm-ed-presets">${CM_PRESETS.map(([v, l]) => `<button class="btn sm cm-preset" data-v="${esc(v)}">${esc(l)}</button>`).join('')}</div>
    <div class="cm-ed-legend muted">min 0-59 · hour 0-23 · day 1-31 · month 1-12 · weekday 0-6 · <b>*</b> any · <b>*/n</b> every n · <b>a,b</b> list · <b>a-b</b> range</div>
    <div class="cm-ed-actions"><button class="btn sm primary cm-ed-save" disabled>Save</button><button class="btn sm cm-ed-cancel">Cancel</button></div>
  </div></td>`;
  tr.after(row);
  openInlineDraft(row);

  const input = $('.cm-cron', row);
  const verdict = $('.cm-ed-verdict', row);
  const save = $('.cm-ed-save', row);
  const dirty = $('.cm-ed-dirty', row);
  const original = e.schedule;
  let valid = false;
  let t;
  const check = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const expr = input.value.trim();
      const changed = expr !== original;
      dirty.hidden = !changed;
      if (!expr) {
        verdict.className = 'cm-ed-verdict';
        verdict.textContent = '';
        input.className = 'cm-input cm-cron';
        save.disabled = true;
        return;
      }
      try {
        const v = await api('GET', '/api/cron/describe?expr=' + encodeURIComponent(expr));
        valid = v.valid;
        input.className = 'cm-input cm-cron ' + (v.valid ? 'valid' : 'invalid');
        verdict.className = 'cm-ed-verdict ' + (v.valid ? 'good' : 'bad');
        verdict.textContent = v.valid ? v.human : v.error || 'invalid';
        save.disabled = !v.valid || !changed;
      } catch {
        verdict.textContent = '';
      }
    }, 180);
  };
  input.addEventListener('input', check);
  $$('.cm-preset', row).forEach(p =>
    p.addEventListener('click', () => {
      input.value = p.dataset.v;
      input.focus();
      check();
    })
  );
  $('.cm-ed-cancel', row).addEventListener('click', async () => {
    if (await closeInlineDraft(row, 'cron schedule draft')) {
      row.remove();
      CM.editing = null;
    }
  });
  save.addEventListener('click', async () => {
    if (!valid) return;
    save.disabled = true;
    await cmPostCrontab(slug, {
      action: 'edit',
      lineIndex: e.lineIndex,
      newSchedule: input.value.trim(),
      expectedRawLine: e.rawLine,
    });
  });
  input.focus();
  input.select();
  check();
}

/* ---- F28: add a new cron line ---- */
function cmCloseAddJob() {
  $$('.cm-addjob-row').forEach(r => r.remove());
}

async function cmCloseAddJobSafely() {
  const row = $('.cm-addjob-row');
  if (!row) {
    cmCloseAddJob();
    return true;
  }
  if (!(await closeInlineDraft(row, 'cron job draft'))) return false;
  row.remove();
  return true;
}

async function cmOpenAddJob(slug) {
  if (!(await cmCloseEditorSafely())) return;
  if (!(await cmCloseAddJobSafely())) return;
  const sys = CM.bySlug.get(slug);
  const head = $(`.cm-head[data-slug="${CSS.escape(slug)}"]`);
  const card = head ? head.closest('.cm-card') : null;
  const tbody = card ? $('.cm-jobs tbody', card) : null;
  if (!sys || !tbody) return;
  const isSite = sys.kind === 'site';
  const row = document.createElement('tr');
  row.className = 'cm-addjob-row';
  row.innerHTML = `<td colspan="5"><div class="cm-editor">
    <div class="cm-ed-top">
      <span class="muted">New cron job on <b>${esc(slug)}</b></span>
      <select class="cm-input cm-aj-kind">
        <option value="worker"${isSite ? ' selected' : ''}>Worker role — bash ops/scripts/run-worker.sh &lt;role&gt;${isSite ? '' : ' (sites only)'}</option>
        <option value="custom"${isSite ? '' : ' selected'}>Custom command</option>
      </select>
    </div>
    <div class="cm-ed-top">
      <input class="cm-input cm-aj-role" type="text" placeholder="role name, e.g. seo-analyst" spellcheck="false" autocomplete="off" ${isSite ? '' : 'disabled'} />
      <textarea class="cm-input cm-aj-cmd hidden" rows="2" placeholder="full shell command" spellcheck="false"></textarea>
    </div>
    <div class="cm-ed-top">
      <input class="cm-input cm-cron cm-aj-sched" type="text" placeholder="* * * * *" spellcheck="false" autocomplete="off" />
      <span class="cm-ed-dirty" hidden>● unsaved</span>
    </div>
    <div class="cm-ed-verdict"></div>
    <div class="cm-ed-presets">${CM_PRESETS.map(([v, l]) => `<button class="btn sm cm-preset" data-v="${esc(v)}">${esc(l)}</button>`).join('')}</div>
    <div class="cm-ed-legend muted">min 0-59 · hour 0-23 · day 1-31 · month 1-12 · weekday 0-6 · <b>*</b> any · <b>*/n</b> every n · <b>a,b</b> list · <b>a-b</b> range</div>
    <div class="cm-ed-actions"><button class="btn sm primary cm-aj-save" disabled>Add</button><button class="btn sm cm-aj-cancel">Cancel</button></div>
  </div></td>`;
  tbody.appendChild(row);
  openInlineDraft(row);

  const kindSel = $('.cm-aj-kind', row);
  const roleInp = $('.cm-aj-role', row);
  const cmdInp = $('.cm-aj-cmd', row);
  const schedInp = $('.cm-cron', row);
  const verdict = $('.cm-ed-verdict', row);
  const save = $('.cm-aj-save', row);
  const dirty = $('.cm-ed-dirty', row);

  function currentCommand() {
    if (kindSel.value === 'worker') {
      const role = roleInp.value.trim().toLowerCase();
      return role ? `bash ops/scripts/run-worker.sh ${role}` : '';
    }
    return cmdInp.value.trim();
  }
  function syncKindUI() {
    const worker = kindSel.value === 'worker';
    roleInp.classList.toggle('hidden', !worker);
    cmdInp.classList.toggle('hidden', worker);
    roleInp.disabled = !worker;
  }
  syncKindUI();

  let valid = false;
  let t;
  const check = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const expr = schedInp.value.trim();
      const cmd = currentCommand();
      dirty.hidden = !(expr || cmd);
      if (!expr || !cmd) {
        verdict.className = 'cm-ed-verdict';
        verdict.textContent = '';
        schedInp.className = 'cm-input cm-cron cm-aj-sched';
        save.disabled = true;
        return;
      }
      try {
        const v = await api('GET', '/api/cron/describe?expr=' + encodeURIComponent(expr));
        valid = v.valid;
        schedInp.className = 'cm-input cm-cron cm-aj-sched ' + (v.valid ? 'valid' : 'invalid');
        verdict.className = 'cm-ed-verdict ' + (v.valid ? 'good' : 'bad');
        verdict.textContent = v.valid ? `${v.human} — ${cmd}` : v.error || 'invalid';
        save.disabled = !v.valid;
      } catch {
        verdict.textContent = '';
      }
    }, 180);
  };
  kindSel.addEventListener('change', () => {
    syncKindUI();
    check();
  });
  roleInp.addEventListener('input', check);
  cmdInp.addEventListener('input', check);
  schedInp.addEventListener('input', check);
  $$('.cm-preset', row).forEach(p =>
    p.addEventListener('click', () => {
      schedInp.value = p.dataset.v;
      schedInp.focus();
      check();
    })
  );
  $('.cm-aj-cancel', row).addEventListener('click', () => cmCloseAddJobSafely());
  save.addEventListener('click', async () => {
    if (!valid) return;
    const command = currentCommand();
    if (!command) {
      toast('Enter a role or command', 'err');
      return;
    }
    save.disabled = true;
    try {
      await api('POST', `/api/cron/systems/${encodeURIComponent(slug)}/crontab`, {
        action: 'add',
        newSchedule: schedInp.value.trim(),
        command,
      });
      toast('Added to crontab — rebuild to apply');
      cmCloseAddJob();
      softRender();
    } catch (e) {
      toast(`add failed: ${e.message}`, 'err');
      save.disabled = false;
    }
  });
  schedInp.focus();
}

/* ---- mutations ---- */
async function cmToggleJob(slug, line) {
  const e = cmEntry(slug, line);
  const sys = CM.bySlug.get(slug);
  if (!e || !sys) return;
  try {
    if (e.role && sys.kind === 'site') {
      await api(
        'POST',
        `/api/cron/systems/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(e.role)}/${e.enabled ? 'disable' : 'enable'}`
      );
      toast(`${e.enabled ? 'Paused' : 'Resumed'} ${e.role} on ${slug}`);
    } else {
      await api('POST', `/api/cron/systems/${encodeURIComponent(slug)}/crontab`, {
        action: e.enabled ? 'comment' : 'uncomment',
        lineIndex: e.lineIndex,
        expectedRawLine: e.rawLine,
      });
      toast(`${e.enabled ? 'Disabled' : 'Enabled'} line — rebuild to apply`);
    }
    softRender();
  } catch (err) {
    toast(`failed: ${err.message}`, 'err');
  }
}

async function cmRemoveJob(slug, line) {
  const e = cmEntry(slug, line);
  if (!e) return;
  const approved = await globalThis.fleetConfirm?.({
    title: `Remove cron line from ${slug}`,
    message: `${e.rawLine}\n\nThis removes the line from the on-disk crontab. Rebuild is required to apply it.`,
    confirmLabel: 'Remove cron line',
    danger: true,
  });
  if (!approved) return;
  await cmPostCrontab(slug, {
    action: 'remove',
    lineIndex: e.lineIndex,
    expectedRawLine: e.rawLine,
  });
}

async function cmPostCrontab(slug, payload) {
  try {
    await api('POST', `/api/cron/systems/${encodeURIComponent(slug)}/crontab`, payload);
    toast('Saved to crontab — rebuild to apply');
    cmCloseEditor();
    softRender();
  } catch (e) {
    toast(`change failed: ${e.message}`, 'err');
  }
}

/* ---- run now (streamed) ---- */
async function cmRunJob(slug, role, btn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  let text = '';
  try {
    const r = await fetch(
      `/api/cron/systems/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(role)}/run`,
      { method: 'POST' }
    );
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
  } catch (err) {
    text += `\nclient error: ${err.message}`;
  }
  const m = text.match(/@@RUN_EXIT (-?\d+)/);
  const code = m ? parseInt(m[1], 10) : null;
  CM.runLog.set(`${slug}:${role}`, text.replace(/@@RUN_EXIT[^\n]*\n?/g, ''));
  btn.disabled = false;
  btn.textContent = orig;
  toast(
    code === 0
      ? `${role} completed — open Logs ▸ run:${role}`
      : `${role} exited ${code ?? '?'} — see Logs`,
    code === 0 ? 'ok' : 'err'
  );
  softRender();
}

/* ---- rebuild (streamed) ---- */
async function cmDoRebuild(slug, btn) {
  const approved = await globalThis.fleetConfirm?.({
    title: `Rebuild ${slug}'s cron container`,
    message: 'Builds the image and recreates the container. This can take a minute.',
    confirmLabel: 'Rebuild container',
  });
  if (!approved) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Rebuilding…';
  toast(`Rebuilding ${slug} — this can take a minute…`);
  let text = '';
  try {
    const r = await fetch(`/api/cron/systems/${encodeURIComponent(slug)}/rebuild`, {
      method: 'POST',
    });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
  } catch (e) {
    text += `\nclient error: ${e.message}`;
  }
  CM.rebuildLog.set(slug, text.replace(/@@VERDICT.*\n?/g, ''));
  const ok = /@@VERDICT ok\b/.test(text);
  btn.disabled = false;
  btn.textContent = orig;
  toast(
    ok ? `${slug} cron restarted` : `${slug} failed to start — open Logs ▸ Last rebuild`,
    ok ? 'ok' : 'err'
  );
  softRender();
}

/* ---- diff viewer ---- */
function cmDiffLines(running, disk) {
  const a = (running || '').split('\n');
  const b = (disk || '').split('\n');
  const m = a.length,
    n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] =
        a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const out = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      out.unshift({ type: 'same', line: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      out.unshift({ type: 'add', line: b[j - 1] });
      j--;
    } else {
      out.unshift({ type: 'del', line: a[i - 1] });
      i--;
    }
  }
  return out;
}
let CM_DIFF_SLUG = null;
async function cmOpenDiff(slug) {
  CM_DIFF_SLUG = slug;
  $('#cm-diff-title').textContent = `crontab diff — ${slug}`;
  const out = $('#cm-diff-out');
  out.textContent = 'Loading…';
  $('#cm-diff-meta').textContent = '';
  $('#cm-diff-modal').classList.remove('hidden');
  try {
    const { disk, running } = await api(
      'GET',
      `/api/cron/systems/${encodeURIComponent(slug)}/diff`
    );
    if (running === null) {
      out.textContent = 'Container is not running — cannot read baked crontab.';
      $('#cm-diff-meta').textContent = 'no running container';
      return;
    }
    const lines = cmDiffLines(running, disk);
    const adds = lines.filter(l => l.type === 'add').length;
    const dels = lines.filter(l => l.type === 'del').length;
    out.innerHTML = lines
      .map(({ type, line }) => {
        const e = esc(line);
        if (type === 'add') return `<span class="cm-dl-add">+ ${e}</span>`;
        if (type === 'del') return `<span class="cm-dl-del">- ${e}</span>`;
        return `<span class="cm-dl-same">  ${e}</span>`;
      })
      .join('\n');
    $('#cm-diff-meta').textContent =
      adds || dels ? `+${adds} / -${dels} lines vs running` : 'no differences (content matches)';
  } catch (e) {
    out.textContent = e.message;
  }
}
function cmCloseDiff() {
  $('#cm-diff-modal').classList.add('hidden');
  CM_DIFF_SLUG = null;
}

async function cmDoRevert(slug) {
  const approved = await globalThis.fleetConfirm?.({
    title: `Revert ${slug}'s crontab`,
    message:
      'Overwrite the on-disk crontab with the version baked into the running container. Your on-disk changes will be discarded.',
    confirmLabel: 'Revert crontab',
    danger: true,
  });
  if (!approved) return;
  try {
    await api('POST', `/api/cron/systems/${encodeURIComponent(slug)}/revert`);
    cmCloseDiff();
    toast(`Reverted ${slug} to the running container's crontab`);
    softRender();
  } catch (e) {
    toast(`revert failed: ${e.message}`, 'err');
  }
}

/* ---- log viewer ---- */
const CMLV = { slug: null, source: 'container', raw: '' };
async function cmOpenLogs(slug, source) {
  const sys = CM.bySlug.get(slug);
  CMLV.slug = slug;
  CMLV.source = source || 'container';
  $('#cm-log-title').textContent = sys ? sys.container : slug;
  const sources = (
    sys && sys.logSources ? sys.logSources : [{ id: 'container', label: 'Container' }]
  ).slice();
  if (CM.rebuildLog.has(slug) && !sources.some(s => s.id === 'rebuild'))
    sources.splice(1, 0, { id: 'rebuild', label: 'Last rebuild' });
  for (const key of CM.runLog.keys()) {
    if (!key.startsWith(slug + ':')) continue;
    const role = key.slice(slug.length + 1);
    if (!sources.some(s => s.id === `run:${role}`))
      sources.push({ id: `run:${role}`, label: `run: ${role}` });
  }
  const seg = $('#cm-log-sources');
  seg.innerHTML = sources
    .map(
      (s, i) =>
        `<button type="button" id="cm-log-source-${i}" data-id="${esc(s.id)}" role="tab" aria-controls="cm-log-out" aria-selected="${s.id === CMLV.source}">${esc(s.label)}</button>`
    )
    .join('');
  $$('#cm-log-sources button', seg).forEach(b =>
    b.addEventListener('click', () => {
      CMLV.source = b.dataset.id;
      cmFetchLogs();
    })
  );
  $('#cm-log-modal').classList.remove('hidden');
  cmFetchLogs();
}
async function cmFetchLogs() {
  const activeButton = $$('#cm-log-sources button').find(b => b.dataset.id === CMLV.source);
  $$('#cm-log-sources button').forEach(b => {
    const active = b.dataset.id === CMLV.source;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  const out = $('#cm-log-out');
  if (activeButton) out.setAttribute('aria-labelledby', activeButton.id);
  const tail = $('#cm-log-tail').value;
  if (CMLV.source === 'rebuild' && CM.rebuildLog.has(CMLV.slug)) {
    CMLV.raw = CM.rebuildLog.get(CMLV.slug);
  } else if (CMLV.source.startsWith('run:')) {
    CMLV.raw =
      CM.runLog.get(`${CMLV.slug}:${CMLV.source.slice(4)}`) ?? '(no run output in this session)';
  } else {
    out.textContent = 'Loading…';
    try {
      CMLV.raw = await (
        await fetch(
          `/api/cron/systems/${encodeURIComponent(CMLV.slug)}/logs?source=${encodeURIComponent(CMLV.source)}&tail=${tail}`
        )
      ).text();
    } catch (e) {
      CMLV.raw = `failed to load logs: ${e.message}`;
    }
  }
  cmApplyLogFilter();
  $('#cm-log-meta').textContent = `${CMLV.source} · tail ${tail}`;
  out.scrollTop = out.scrollHeight;
}
function cmApplyLogFilter() {
  const f = $('#cm-log-filter').value.trim().toLowerCase();
  const lines = CMLV.raw.split('\n');
  const shown = f ? lines.filter(l => l.toLowerCase().includes(f)) : lines;
  $('#cm-log-out').textContent = shown.join('\n');
  $('#cm-log-count').textContent = f
    ? `${shown.length} / ${lines.length} lines`
    : `${lines.length} lines`;
}
function cmCloseLogs() {
  $('#cm-log-modal').classList.add('hidden');
}

// Wire the cron modals' static controls once at boot.
function cmWireModals() {
  $('#cm-log-close').addEventListener('click', cmCloseLogs);
  $('#cm-log-modal').addEventListener('click', e => {
    if (e.target.id === 'cm-log-modal') cmCloseLogs();
  });
  $('#cm-log-filter').addEventListener('input', cmApplyLogFilter);
  $('#cm-log-tail').addEventListener('change', cmFetchLogs);
  $('#cm-log-reload').addEventListener('click', cmFetchLogs);
  $('#cm-log-wrap').addEventListener('change', e =>
    $('#cm-log-out').classList.toggle('cm-wrap', e.target.checked)
  );
  $('#cm-log-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#cm-log-out').textContent);
      toast('Copied');
    } catch {
      toast('Copy failed', 'err');
    }
  });
  $('#cm-log-download').addEventListener('click', () => {
    const blob = new Blob([CMLV.raw], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${CMLV.slug}-${CMLV.source.replace(':', '-')}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('#cm-diff-close').addEventListener('click', cmCloseDiff);
  $('#cm-diff-close2').addEventListener('click', cmCloseDiff);
  $('#cm-diff-modal').addEventListener('click', e => {
    if (e.target.id === 'cm-diff-modal') cmCloseDiff();
  });
  $('#cm-diff-revert').addEventListener('click', () => {
    if (CM_DIFF_SLUG) cmDoRevert(CM_DIFF_SLUG);
  });
}

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
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div class="page-head"><h2 class="page-title">Data Hub</h2><span class="muted">Private-source collection, VPN egress, freshness, and site consumption</span></div><div role="status" aria-live="polite"><div class="loading">Loading Data Hub…</div></div>';
  const [health, eg, src, ds, mtx, pl] = await Promise.all([
    api('GET', '/api/datahub/health'),
    api('GET', '/api/datahub/egress?limit=80'),
    api('GET', '/api/datahub/sources'),
    api('GET', '/api/datahub/datasets'),
    api('GET', '/api/datahub/matrix'),
    api('GET', '/api/datahub/pulls?limit=80'),
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
        <div class="dh-counts">Skipped records <b>${esc(String((health.counts || {}).skipped ?? '—'))}</b></div>
      </div>`;
  }

  // ---- Panel 2: Outbound Connection Ledger ----
  const events = (eg && eg.events) || [];
  const egRows = events
    .map(
      e => `
    <tr>
      <td class="dh-time">${esc((e.ts || '').replace('T', ' ').slice(0, 19))}</td>
      <td>${esc(e.source_id || '')}</td>
      <td class="dh-host">${esc(e.target_host || '')}</td>
      <td>${dhPathBadge(e.policy, e.exit_node)}</td>
      <td class="dh-ip">${esc(e.exit_ip || '—')}</td>
      <td>${dhBadge(e.status)}</td>
      <td class="dh-note">${esc(e.note || '')}</td>
    </tr>`
    )
    .join('');
  const egressHtml = `
    <div class="table-wrap"><table class="dh-egress">
      <caption class="sr-only">Outbound connection ledger</caption>
      <thead><tr><th>when</th><th>source</th><th>target</th><th>path</th><th>exit IP</th><th>status</th><th>note</th></tr></thead>
      <tbody>${egRows || '<tr><td colspan="7" class="muted">no egress events yet</td></tr>'}</tbody>
    </table></div>`;

  // ---- Panel 2b: Site Pulls (inbound — who consumed what, when) ----
  const pulls = (pl && pl.pulls) || [];
  const plRows = pulls
    .map(p => {
      const who = p.site
        ? siteLink(p.site)
        : `<span class="dh-host">${esc(p.endpoint || '')}</span>`;
      return `<tr>
      <td class="dh-time">${esc((p.ts || '').replace('T', ' ').slice(0, 19))}</td>
      <td>${who}</td>
      <td class="dh-host">${esc(p.endpoint || '')}</td>
      <td><b>${esc(String(p.item_count ?? 0))}</b></td>
      <td class="dh-ip">${esc(p.client_ip || '—')}</td>
    </tr>`;
    })
    .join('');
  const pullsHtml = `
    <div class="table-wrap"><table class="dh-egress dh-pulls">
      <caption class="sr-only">Site data pulls</caption>
      <thead><tr><th>when</th><th>consumer</th><th>endpoint</th><th>items</th><th>client IP</th></tr></thead>
      <tbody>${plRows || '<tr><td colspan="5" class="muted">no pulls yet</td></tr>'}</tbody>
    </table></div>`;

  // ---- Panel 3: Source Freshness (+ enabled/disabled toggle) ----
  const srcs = (src && src.sources) || [];
  const enabledCount = srcs.filter(s => s.enabled !== false).length;
  const disabledCount = srcs.length - enabledCount;
  const nodeValues = Object.values(health.nodes || {});
  const vpnNodes = nodeValues.filter(Boolean).length;
  const vpnLeaks = nodeValues.filter(ip => HOME_IPS.includes(ip)).length;
  const hubItems = health.counts?.items ?? 0;
  const srcRows = srcs
    .map(s => {
      const st = s.state || {};
      const off = s.enabled === false;
      const stale = !off && st.stale ? ' · <span class="dh-stale">stale</span>' : '';
      const ovr = s.overridden
        ? ' <span class="dh-ovr" title="overridden — differs from the registry default">override</span>'
        : '';
      const statusCell = off
        ? '<span class="dh-b dh-skip">disabled</span>'
        : `${dhBadge(st.status)}${stale}`;
      const toggle = `<button type="button" class="btn sm ${off ? 'primary' : 'danger'} dh-src-toggle" data-id="${esc(s.id)}" data-enabled="${off ? 0 : 1}">${off ? '▶ Enable' : '⏸ Disable'}</button>`;
      return `<tr class="${off ? 'dh-row-off' : ''}">
      <td>${esc(s.id)}${ovr}</td>
      <td>${esc(s.type)}</td>
      <td>${statusCell}</td>
      <td class="dh-time">${esc((st.last_fetch_at || '').replace('T', ' ').slice(0, 19) || '—')}</td>
      <td class="dh-srcctl">${toggle}</td>
    </tr>`;
    })
    .join('');
  const srcHtml = `
    <div class="dh-srccount">${enabledCount} enabled${disabledCount ? ` · <span class="dh-stale">${disabledCount} disabled</span>` : ''}</div>
    <div class="table-wrap"><table class="dh-sources">
      <caption class="sr-only">Data source freshness and controls</caption>
      <thead><tr><th scope="col">source</th><th scope="col">type</th><th scope="col">status</th><th scope="col">last fetch</th><th scope="col">Actions</th></tr></thead>
      <tbody>${srcRows || '<tr><td colspan="5" class="muted">no source state</td></tr>'}</tbody>
    </table></div>`;

  // ---- Panel 4: Datasets ----
  const dss = (ds && ds.datasets) || [];
  const dsRows = dss
    .map(
      d => `<tr>
    <td>${esc(d.dataset_key)}</td><td>${esc(String(d.count))}</td>
    <td class="dh-time">${esc((d.latest_observed_at || '').replace('T', ' ').slice(0, 19))}</td>
  </tr>`
    )
    .join('');
  const dsHtml = `
    <div class="table-wrap"><table class="dh-datasets">
      <caption class="sr-only">Collected datasets</caption>
      <thead><tr><th>dataset</th><th>rows</th><th>latest</th></tr></thead>
      <tbody>${dsRows || '<tr><td colspan="3" class="muted">no datasets</td></tr>'}</tbody>
    </table></div>`;

  // ---- Panel 5: Source×Site Matrix ----
  let matrixHtml = '<div class="muted">no matrix</div>';
  if (mtx && mtx.sites) {
    const rssRows = (mtx.rss || [])
      .map(
        r =>
          `<tr><td>${siteLink(r.site)}</td><td><b>${esc(String(r.matched_sources.length))}</b> sources</td><td class="dh-tags">${(r.tags_any || []).map(t => `<span class="dh-tag">${esc(t)}</span>`).join('')}</td></tr>`
      )
      .join('');
    const dsRows2 = (mtx.datasets || [])
      .filter(d => d.keys.length)
      .map(
        d =>
          `<tr><td>${siteLink(d.site)}</td><td class="dh-tags">${d.keys.map(k => `<span class="dh-tag dh-dskey">${esc(k)}</span>`).join('')}</td></tr>`
      )
      .join('');
    matrixHtml = `
      <div class="dh-matrix-sub">RSS subscriptions (by tag)</div>
      <div class="table-wrap"><table class="dh-matrix"><caption class="sr-only">RSS subscriptions by site</caption><thead><tr><th scope="col">Site</th><th scope="col">Sources</th><th scope="col">Tags</th></tr></thead><tbody>${rssRows}</tbody></table></div>
      <div class="dh-matrix-sub">Dataset subscriptions</div>
      <div class="table-wrap"><table class="dh-matrix"><caption class="sr-only">Dataset subscriptions by site</caption><thead><tr><th scope="col">Site</th><th scope="col">Subscribed datasets</th></tr></thead><tbody>${dsRows2 || '<tr><td colspan="2" class="muted">none</td></tr>'}</tbody></table></div>`;
  }

  app.innerHTML = `
    <div class="page-head"><h2 class="page-title">Data Hub</h2><span class="muted">Private-source collection, VPN egress, freshness, and site consumption in one operational view.</span><button type="button" class="btn" id="datahub-refresh">↻ Refresh</button></div>
    <section class="dh-summary" aria-label="Data hub summary">
      <div class="dh-stat ${hubDown || vpnLeaks ? 'dh-stat-bad' : 'dh-stat-good'}"><strong>${hubDown ? 'Down' : `${vpnNodes}/2`}</strong><span>VPN exits online</span></div>
      <div class="dh-stat ${vpnLeaks ? 'dh-stat-bad' : 'dh-stat-good'}"><strong>${vpnLeaks}</strong><span>Home-IP leaks</span></div>
      <div class="dh-stat"><strong>${esc(String(hubItems))}</strong><span>Collected items</span></div>
      <div class="dh-stat ${disabledCount ? 'dh-stat-warn' : 'dh-stat-good'}"><strong>${enabledCount}/${srcs.length}</strong><span>Sources enabled</span></div>
      <div class="dh-stat"><strong>${events.length}</strong><span>Egress events loaded</span></div>
      <div class="dh-stat dh-stat-meta"><strong>${pulls.length}</strong><span>Site pulls loaded · ${dss.length} datasets</span></div>
    </section>
    <div class="matrix-scroll-hint dh-scroll-hint" role="note">Swipe horizontally inside wide tables to reveal remaining columns</div>
    <div class="dh-grid">
      <section class="dh-panel" data-rk="dh-health"><h3>VPN Health</h3>${healthHtml}</section>
      <section class="dh-panel dh-wide" data-rk="dh-egress"><h3>Outbound Connection Ledger <span class="live-tag">live</span></h3>${egressHtml}</section>
      <section class="dh-panel dh-wide" data-rk="dh-pulls"><h3>Site Pulls <span class="dh-sub-h">inbound — who consumed what</span> <span class="live-tag">live</span></h3>${pullsHtml}</section>
      <section class="dh-panel" data-rk="dh-sources"><h3>Source Freshness</h3>${srcHtml}</section>
      <section class="dh-panel" data-rk="dh-datasets"><h3>Datasets</h3>${dsHtml}</section>
      <section class="dh-panel dh-wide" data-rk="dh-matrix"><h3>Source × Site Matrix</h3>${matrixHtml}</section>
    </div>
    <details class="dh-help"><summary>How Data Hub protects and routes collection</summary><p>Private sources are fetched through the configured VPN exits, while the egress ledger records the target, path, exit IP, and outcome. Site pulls show who consumed collected data; home-IP leaks are surfaced as a hard warning. Source toggles apply on the next collection cycle.</p></details>`;

  $$('.dh-panel .table-wrap', app).forEach(wrap => {
    const table = $('table', wrap);
    if (!table) return;
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', table.caption?.textContent?.trim() || 'Data Hub table');
  });
  $('#datahub-refresh').addEventListener('click', () => renderDataHub());
  const dhPageSize = 20;
  $$('.dh-panel table', app).forEach((table, index) => {
    const rows = [...table.tBodies].flatMap(body => [...body.rows]);
    if (rows.length <= dhPageSize) return;
    const label = table.caption?.textContent || 'Data Hub table';
    const tableId = `dh-table-${index}`;
    table.id = tableId;
    const pager = document.createElement('nav');
    pager.className = 'dh-pagination';
    pager.setAttribute('aria-label', `${label} pages`);
    pager.innerHTML = `<span class="dh-page-status" aria-live="polite"></span><div><button type="button" class="btn sm" data-dh-page="prev" aria-controls="${tableId}">← Previous</button><button type="button" class="btn sm" data-dh-page="next" aria-controls="${tableId}">Next →</button></div>`;
    table.closest('.table-wrap').after(pager);
    let page = 0;
    const status = $('.dh-page-status', pager);
    const previous = $('[data-dh-page="prev"]', pager);
    const next = $('[data-dh-page="next"]', pager);
    const updatePage = () => {
      const pageCount = Math.ceil(rows.length / dhPageSize);
      const start = page * dhPageSize;
      rows.forEach((row, rowIndex) => {
        row.hidden = rowIndex < start || rowIndex >= start + dhPageSize;
      });
      status.textContent = `${start + 1}–${Math.min(start + dhPageSize, rows.length)} of ${rows.length}`;
      previous.disabled = page === 0;
      next.disabled = page >= pageCount - 1;
    };
    previous.addEventListener('click', () => {
      page = Math.max(0, page - 1);
      updatePage();
    });
    next.addEventListener('click', () => {
      page = Math.min(Math.ceil(rows.length / dhPageSize) - 1, page + 1);
      updatePage();
    });
    updatePage();
  });
  // Wire the per-source enable/disable toggles (re-bound every render).
  $$('.dh-src-toggle').forEach(b =>
    b.addEventListener('click', () => dhToggleSource(b.dataset.id, b.dataset.enabled === '1', b))
  );

  if (!FRESH) applyUISnap();
}

// Toggle a hub source's enabled/disabled override, then soft-refresh the view.
// The change persists in the hub and takes effect on the next collect cycle.
async function dhToggleSource(id, currentlyEnabled, btn) {
  gdBusy(btn, true);
  const r = await api('POST', `/api/datahub/sources/${encodeURIComponent(id)}/enabled`, {
    enabled: !currentlyEnabled,
  });
  if (r && r.ok === false) {
    gdBusy(btn, false);
    toast(`Toggle failed: ${r.error || 'hub unreachable'}`);
    return;
  }
  toast(`${id} ${currentlyEnabled ? 'disabled' : 'enabled'} — applies on the next collect cycle`);
  softRender();
}

/* ===== ANALYTICS ===== */

function complianceCheck(value, yes = 'yes', no = 'no') {
  if (value == null) return '<span class="badge b-gray">unknown</span>';
  return value
    ? `<span class="badge b-green">${esc(yes)}</span>`
    : `<span class="badge b-red">${esc(no)}</span>`;
}

const COMPLIANCE_UI = {
  search: '',
  statuses: new Set(),
  check: 'all',
  openOnly: false,
  staleOnly: false,
  sort: 'site',
  direction: 'asc',
};
let COMPLIANCE_PROGRESS_TIMER = null;
let COMPLIANCE_PROGRESS_SEEN = -1;
let COMPLIANCE_SCAN_ACTIVE = false;

function complianceDuration(milliseconds) {
  if (milliseconds == null || milliseconds < 0) return '—';
  const minutes = Math.round(milliseconds / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function complianceCheckFailed(row, check) {
  const c = row.checks || {};
  if (check === 'open') return row.status !== 'pass';
  if (check === 'gaConsentGated') return c.ga4 === true && c.gaConsentGated === false;
  return c[check] === false;
}

function complianceSortValue(row, key) {
  const c = row.checks || {};
  if (key === 'site' || key === 'status' || key === 'checkedAt') return row[key] || '';
  if (key === 'evidence') return row.error || (row.failures || []).join('; ') || '';
  if (key === 'ga4')
    return (row.measurementIds || []).join(', ') || (c.ga4 == null ? '' : String(c.ga4));
  return c[key] == null ? -1 : Number(c[key]);
}

function openComplianceDetail(row) {
  const modal = $('#modal'),
    title = $('#modal-title'),
    body = $('#modal-body');
  const c = row.checks || {},
    ev = row.evidence || {};
  const statusCls = row.status === 'pass' ? 'b-green' : row.status === 'fail' ? 'b-red' : 'b-gray';
  const item = (label, value, explanation) => `<div class="compliance-detail-row">
    <div>${complianceCheck(value, 'passed', 'failed')}</div>
    <div><strong>${esc(label)}</strong><div class="muted">${esc(explanation)}</div></div>
  </div>`;
  const extLink = (url, label) =>
    url
      ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`
      : '<span class="muted">No deployed link captured</span>';
  const gaText = c.ga4
    ? `Detected ${esc((row.measurementIds || []).join(', ') || 'a Google tag')}.`
    : 'No GA4 tag was detected; analytics consent gating is not applicable.';
  const consentText =
    c.ga4 === false
      ? gaText
      : c.gaConsentGated
        ? `${gaText} The deployed source contains ${c.defaultDenied ? 'default-denied Google Consent Mode' : 'basic consent-gating logic that controls tag loading from the saved visitor choice'}.`
        : `${gaText} No default-denied or basic gating evidence was found.`;
  const history = (row.history || []).slice().reverse();
  const historyStats = row.historyStats || {};
  const historyHtml = history.length
    ? history
        .map(
          entry => `<div class="compliance-history-item">
        <span class="badge ${entry.status === 'pass' ? 'b-green' : entry.status === 'fail' ? 'b-red' : 'b-gray'}">${esc(entry.status)}</span>
        <span>${esc(new Date(entry.checkedAt).toLocaleString())}</span>
        <span class="muted">${esc(entry.change || '')}${entry.errorType ? ` · ${esc(entry.errorType)}` : ''}</span>
      </div>`
        )
        .join('')
    : '<span class="muted">History will appear after this site is scanned.</span>';

  title.textContent = `${row.site} — compliance evidence`;
  body.innerHTML = `
    <div class="compliance-detail-head">
      <span class="badge ${statusCls}">${esc(row.status)}</span>
      <span>${extLink(row.url, 'Open scanned homepage')}</span>
      <span class="muted">Checked ${esc(row.checkedAt ? new Date(row.checkedAt).toLocaleString() : 'not yet')}</span>
    </div>
    <p class="compliance-detail-summary">${
      row.status === 'pass'
        ? 'This site passed the automated technical baseline because every required cookie/analytics check below was detected in the deployed page or its same-origin JavaScript.'
        : row.status === 'fail'
          ? esc((row.failures || []).join('; ') || 'One or more required checks failed.')
          : esc(row.error || 'The live site could not be verified.')
    }</p>
    <div class="compliance-detail-grid">
      ${item('Cookie banner', c.banner, ev.bannerWording || 'A cookie/consent dialog pattern was detected in the deployed source.')}
      ${item('Accept choice', c.accept, ev.acceptLabel ? `Detected wording: “${ev.acceptLabel}”` : 'An accept/allow choice was detected.')}
      ${item('Reject choice', c.reject, ev.rejectLabel ? `Detected wording: “${ev.rejectLabel}”` : 'A reject/decline or necessary-only choice was detected.')}
      ${item('GA4 consent handling', c.ga4 === false ? true : c.gaConsentGated, consentText)}
    </div>
    <div class="compliance-wording"><strong>Detected banner wording</strong><p>${esc(ev.bannerWording || 'The previous cached scan did not retain a wording excerpt. Run “Scan live sites now” to capture it.')}</p></div>
    <div class="compliance-links"><div><strong>Privacy</strong><br>${extLink(ev.privacyUrl, ev.privacyUrl || 'Privacy policy')}</div><div><strong>Terms</strong><br>${extLink(ev.termsUrl, ev.termsUrl || 'Terms')}</div></div>
    <div class="compliance-history"><strong>Recent scan history</strong>
      <div class="compliance-history-summary">
        <span>Failure began <b>${esc(historyStats.failureSince ? new Date(historyStats.failureSince).toLocaleString() : '—')}</b></span>
        <span>Last resolved <b>${esc(historyStats.lastResolvedAt ? new Date(historyStats.lastResolvedAt).toLocaleString() : '—')}</b></span>
        <span>Resolution time <b>${esc(complianceDuration(historyStats.lastResolutionMs))}</b></span>
      </div>
      <div class="compliance-history-list">${historyHtml}</div>
    </div>
    <div class="muted compliance-detail-foot">Evidence source: live HTML plus ${esc(String(row.assetsChecked || 0))} same-origin JavaScript bundle(s). This is an automated technical baseline, not legal certification.</div>`;
  modal.classList.remove('hidden');
}

async function renderCompliance() {
  clearTimeout(COMPLIANCE_PROGRESS_TIMER);
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading live compliance evidence…</div></div>';
  let rows, trend;
  try {
    [rows, trend] = await Promise.all([
      api('GET', '/api/compliance'),
      api('GET', '/api/compliance/history?limit=18'),
    ]);
  } catch (e) {
    renderViewError(app, `Compliance scan failed: ${e.message}`);
    return;
  }

  const counts = { pass: 0, fail: 0, unknown: 0 };
  rows.forEach(r => {
    counts[r.status] = (counts[r.status] || 0) + 1;
  });
  const lastScan = rows.reduce((latest, row) => {
    const time = row.checkedAt ? Date.parse(row.checkedAt) : 0;
    return time > latest ? time : latest;
  }, 0);
  const staleCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const staleCount = rows.filter(
    row => !row.checkedAt || Date.parse(row.checkedAt) < staleCutoff
  ).length;
  const issueGroups = [
    ['banner', 'Banner missing'],
    ['accept', 'Accept missing'],
    ['reject', 'Reject missing'],
    ['gaConsentGated', 'GA consent ungated'],
    ['privacy', 'Privacy missing'],
    ['terms', 'Terms missing'],
  ]
    .map(([key, label]) => ({
      key,
      label,
      count: rows.filter(row => complianceCheckFailed(row, key)).length,
    }))
    .filter(group => group.count)
    .sort((a, b) => b.count - a.count);
  const unknownGroups = Object.entries(
    rows
      .filter(row => row.status === 'unknown')
      .reduce((out, row) => {
        const key = row.errorType || 'network';
        out[key] = (out[key] || 0) + 1;
        return out;
      }, {})
  ).sort((a, b) => b[1] - a[1]);
  const trendHtml = trend.length
    ? `<div class="compliance-trend" role="img" aria-label="Fleet pass rate trend from ${esc(
        new Date(trend[0].at).toLocaleString()
      )} to ${esc(new Date(trend[trend.length - 1].at).toLocaleString())}; currently ${trend[trend.length - 1].passRate}% pass">${trend
        .map(
          point =>
            `<i style="height:${Math.max(3, point.passRate * 0.4)}px" title="${esc(new Date(point.at).toLocaleString())}: ${point.passRate}% pass"></i>`
        )
        .join(
          ''
        )}<span>${trend[trend.length - 1].passRate}% pass</span></div><div class="compliance-trend-range" aria-hidden="true"><span>${esc(new Date(trend[0].at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</span><span>${esc(new Date(trend[trend.length - 1].at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</span></div>`
    : '<span class="muted">Trend begins after the next scan</span>';
  const rowHtml = r => {
    const c = r.checks || {};
    const statusCls = r.status === 'pass' ? 'b-green' : r.status === 'fail' ? 'b-red' : 'b-gray';
    const ga =
      c.ga4 == null
        ? complianceCheck(null)
        : c.ga4
          ? `<span class="badge b-blue">${esc((r.measurementIds || []).join(', ') || 'detected')}</span>`
          : '<span class="muted">not detected</span>';
    const evidence =
      r.error ||
      (r.failures || []).join('; ') ||
      `live HTML + ${r.assetsChecked || 0} same-origin JS bundle(s)`;
    const checked = r.checkedAt ? new Date(r.checkedAt).toLocaleString() : 'not scanned';
    const change =
      r.change && r.change !== 'unchanged'
        ? `<span class="badge compliance-change ${r.change === 'resolved' ? 'b-green' : r.change === 'regressed' ? 'b-red' : 'b-yellow'}">${esc(r.change)}</span>`
        : '';
    const diagnostic =
      r.status === 'unknown'
        ? `<span class="badge b-gray">${esc(r.errorType || 'network')}</span> `
        : '';
    return `<tr data-fleet-row data-site="${esc(r.site)}">
      <td class="site">${siteLink(r.site)}</td>
      <td><button type="button" class="badge ${statusCls} compliance-status" data-site="${esc(r.site)}" aria-label="Show ${esc(r.status)} compliance evidence for ${esc(r.site)}" title="Show compliance evidence for ${esc(r.site)}">${esc(r.status)}</button> ${change}</td>
      <td>${complianceCheck(c.banner, 'present', 'missing')}</td>
      <td>${complianceCheck(c.accept, 'present', 'missing')}</td>
      <td>${complianceCheck(c.reject, 'present', 'missing')}</td>
      <td>${ga}</td>
      <td>${c.ga4 === false ? '<span class="muted">N/A</span>' : complianceCheck(c.gaConsentGated, 'gated', 'ungated')}</td>
      <td>${complianceCheck(c.privacy, 'linked', 'missing')}</td>
      <td>${complianceCheck(c.terms, 'linked', 'missing')}</td>
      <td class="compliance-evidence" title="${esc(evidence)}">${diagnostic}${esc(evidence)}</td>
      <td class="mono">${esc(checked)}</td>
      <td><button type="button" class="btn sm compliance-rescan" data-site="${esc(r.site)}" title="Rescan only ${esc(r.site)}">↻ Rescan</button></td>
    </tr>`;
  };
  const sortHeader = (label, key) => {
    const active = COMPLIANCE_UI.sort === key;
    const arrow = active ? (COMPLIANCE_UI.direction === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th><button class="compliance-sort${active ? ' active' : ''}" data-sort="${key}" title="Sort by ${esc(label)}">${esc(label)}<span aria-hidden="true">${arrow}</span></button></th>`;
  };

  app.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">Compliance</h2><span class="muted">Live technical privacy baseline — not legal certification</span><span class="muted compliance-last-scan">Last scan: ${esc(lastScan ? new Date(lastScan).toLocaleString() : 'not yet scanned')}</span></div></div>
    <div class="task-toolbar compliance-toolbar" role="group" aria-label="Compliance filters and actions">
      <strong>${rows.length} domains</strong>
      <button type="button" class="badge b-green compliance-filter-tag" data-status="pass" aria-pressed="${COMPLIANCE_UI.statuses.has('pass')}">${counts.pass} pass</button>
      <button type="button" class="badge b-red compliance-filter-tag" data-status="fail" aria-pressed="${COMPLIANCE_UI.statuses.has('fail')}">${counts.fail} fail</button>
      <button type="button" class="badge b-gray compliance-filter-tag" data-status="unknown" aria-pressed="${COMPLIANCE_UI.statuses.has('unknown')}">${counts.unknown} unknown</button>
      <button type="button" id="compliance-open-only" class="btn sm compliance-toggle${COMPLIANCE_UI.openOnly ? ' active' : ''}" aria-pressed="${COMPLIANCE_UI.openOnly}">Open items</button>
      <button type="button" id="compliance-stale-only" class="btn sm compliance-toggle${COMPLIANCE_UI.staleOnly ? ' active' : ''}" aria-pressed="${COMPLIANCE_UI.staleOnly}">${staleCount} stale</button>
      <label class="compliance-search-wrap"><span class="muted">Site</span><input id="compliance-search" class="cm-input" type="search" placeholder="Search site name…" value="${esc(COMPLIANCE_UI.search)}" autocomplete="off"></label>
      <select id="compliance-check-filter" class="cm-input" aria-label="Filter by compliance check">
        <option value="all">All checks</option>
        <option value="open">Any open issue</option>
        <option value="banner">Banner missing</option>
        <option value="accept">Accept missing</option>
        <option value="reject">Reject missing</option>
        <option value="gaConsentGated">GA consent ungated</option>
        <option value="privacy">Privacy missing</option>
        <option value="terms">Terms missing</option>
      </select>
      <span id="compliance-visible-count" class="muted"></span>
      <button type="button" id="compliance-scan" class="btn sm compliance-scan">↻ Scan live sites now</button>
    </div>
    <div id="compliance-progress" class="compliance-progress hidden"><div><span id="compliance-progress-label">Preparing scan…</span><span id="compliance-progress-sites" class="muted"></span></div><progress id="compliance-progress-bar" value="0" max="1"></progress></div>
    <div class="compliance-overview">
      <div class="compliance-groups"><strong>Open findings</strong>${
        issueGroups.length
          ? issueGroups
              .map(
                group =>
                  `<button class="compliance-group" data-check="${group.key}"><span>${esc(group.label)}</span><b>${group.count}</b></button>`
              )
              .join('')
          : '<span class="muted">No failed checks</span>'
      }</div>
      <div class="compliance-groups"><strong>Unknown diagnostics</strong>${
        unknownGroups.length
          ? unknownGroups
              .map(
                ([type, count]) =>
                  `<span class="compliance-group static"><span>${esc(type)}</span><b>${count}</b></span>`
              )
              .join('')
          : '<span class="muted">No unknown scans</span>'
      }</div>
      <div class="compliance-trend-wrap"><strong>Pass-rate trend</strong>${trendHtml}</div>
    </div>
    <div class="compliance-note">A pass requires a detected cookie consent UI with both accept and reject choices, a Privacy Policy, and Terms. If GA4 is present, it must show default-denied consent mode or basic consent gating. “Unknown” means the deployed site could not be verified; it is never treated as a pass or failure.</div>
    <div class="card compliance-table"><div class="matrix-scroll-hint" role="note">Swipe horizontally to compare compliance checks, evidence, and scan dates</div><div class="table-wrap" tabindex="0" role="region" aria-label="Compliance evidence by site"><table>
      <caption class="sr-only">Compliance evidence by site</caption>
      <thead><tr>${sortHeader('Site', 'site')}${sortHeader('Status', 'status')}${sortHeader('Banner', 'banner')}${sortHeader('Accept', 'accept')}${sortHeader('Reject', 'reject')}${sortHeader('GA4', 'ga4')}${sortHeader('GA consent', 'gaConsentGated')}${sortHeader('Privacy', 'privacy')}${sortHeader('Terms', 'terms')}${sortHeader('Evidence / issue', 'evidence')}${sortHeader('Checked', 'checkedAt')}<th>Action</th></tr></thead>
      <tbody id="compliance-body"></tbody>
    </table></div></div>`;
  $('#compliance-check-filter').value = COMPLIANCE_UI.check;

  const bySite = new Map(rows.map(row => [row.site, row]));
  const updateRows = () => {
    const query = COMPLIANCE_UI.search.trim().toLowerCase();
    const visible = rows.filter(
      row =>
        (!query || row.site.toLowerCase().includes(query)) &&
        (!COMPLIANCE_UI.statuses.size || COMPLIANCE_UI.statuses.has(row.status)) &&
        (!COMPLIANCE_UI.openOnly || row.status !== 'pass') &&
        (!COMPLIANCE_UI.staleOnly || !row.checkedAt || Date.parse(row.checkedAt) < staleCutoff) &&
        (COMPLIANCE_UI.check === 'all' || complianceCheckFailed(row, COMPLIANCE_UI.check))
    );
    const multiplier = COMPLIANCE_UI.direction === 'asc' ? 1 : -1;
    visible.sort((a, b) => {
      const av = complianceSortValue(a, COMPLIANCE_UI.sort);
      const bv = complianceSortValue(b, COMPLIANCE_UI.sort);
      return (
        multiplier *
        (typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }))
      );
    });
    $('#compliance-body').innerHTML =
      visible.map(rowHtml).join('') ||
      `<tr><td colspan="12" class="muted">${rows.length ? 'No sites match the current filters' : 'No domains discovered'}</td></tr>`;
    $('#compliance-visible-count').textContent = `Showing ${visible.length} of ${rows.length}`;
    $$('.compliance-status').forEach(button =>
      button.addEventListener('click', () => openComplianceDetail(bySite.get(button.dataset.site)))
    );
    $$('.compliance-rescan').forEach(button =>
      button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = 'Scanning…';
        try {
          await api('POST', `/api/compliance/${encodeURIComponent(button.dataset.site)}/scan`);
          toast(`${button.dataset.site} scan complete`);
          renderCompliance();
        } catch (e) {
          toast(`scan failed: ${e.message}`, 'err');
          button.disabled = false;
          button.textContent = '↻ Rescan';
        }
      })
    );
  };
  updateRows();
  $('#compliance-search').addEventListener('input', event => {
    COMPLIANCE_UI.search = event.currentTarget.value;
    updateRows();
  });
  $('#compliance-check-filter').addEventListener('change', event => {
    COMPLIANCE_UI.check = event.currentTarget.value;
    updateRows();
  });
  $('#compliance-open-only').addEventListener('click', () => {
    COMPLIANCE_UI.openOnly = !COMPLIANCE_UI.openOnly;
    $('#compliance-open-only').classList.toggle('active', COMPLIANCE_UI.openOnly);
    $('#compliance-open-only').setAttribute('aria-pressed', String(COMPLIANCE_UI.openOnly));
    updateRows();
  });
  $('#compliance-stale-only').addEventListener('click', () => {
    COMPLIANCE_UI.staleOnly = !COMPLIANCE_UI.staleOnly;
    $('#compliance-stale-only').classList.toggle('active', COMPLIANCE_UI.staleOnly);
    $('#compliance-stale-only').setAttribute('aria-pressed', String(COMPLIANCE_UI.staleOnly));
    updateRows();
  });
  $$('.compliance-group[data-check]').forEach(button =>
    button.addEventListener('click', () => {
      COMPLIANCE_UI.check = button.dataset.check;
      $('#compliance-check-filter').value = COMPLIANCE_UI.check;
      updateRows();
    })
  );
  $$('.compliance-filter-tag').forEach(button =>
    button.addEventListener('click', () => {
      const status = button.dataset.status;
      if (COMPLIANCE_UI.statuses.has(status)) COMPLIANCE_UI.statuses.delete(status);
      else COMPLIANCE_UI.statuses.add(status);
      $$('.compliance-filter-tag').forEach(tag =>
        tag.setAttribute('aria-pressed', String(COMPLIANCE_UI.statuses.has(tag.dataset.status)))
      );
      updateRows();
    })
  );
  $$('.compliance-sort').forEach(button =>
    button.addEventListener('click', () => {
      const key = button.dataset.sort;
      if (COMPLIANCE_UI.sort === key)
        COMPLIANCE_UI.direction = COMPLIANCE_UI.direction === 'asc' ? 'desc' : 'asc';
      else {
        COMPLIANCE_UI.sort = key;
        COMPLIANCE_UI.direction = 'asc';
      }
      renderCompliance();
    })
  );
  $('#compliance-scan').addEventListener('click', async event => {
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Scanning…';
    try {
      await api('POST', '/api/compliance/scan');
      pollComplianceProgress();
    } catch (e) {
      toast(`scan failed: ${e.message}`, 'err');
      btn.disabled = false;
      btn.textContent = '↻ Scan live sites now';
    }
  });
  pollComplianceProgress();
  if (!FRESH) applyUISnap();
  stamp();
}

async function pollComplianceProgress() {
  clearTimeout(COMPLIANCE_PROGRESS_TIMER);
  if (STATE.view !== 'compliance') return;
  let progress;
  try {
    progress = await api('GET', '/api/compliance/progress');
  } catch {
    return;
  }
  const box = $('#compliance-progress'),
    button = $('#compliance-scan');
  if (!box || !button) return;
  box.classList.toggle('hidden', !progress.running);
  button.disabled = progress.running;
  button.textContent = progress.running ? 'Scanning…' : '↻ Scan live sites now';
  if (!progress.running) {
    if (COMPLIANCE_SCAN_ACTIVE) {
      COMPLIANCE_SCAN_ACTIVE = false;
      COMPLIANCE_PROGRESS_SEEN = -1;
      toast('Live compliance scan complete');
      renderCompliance();
    }
    return;
  }
  COMPLIANCE_SCAN_ACTIVE = true;
  if (COMPLIANCE_PROGRESS_SEEN >= 0 && progress.completed > COMPLIANCE_PROGRESS_SEEN) {
    COMPLIANCE_PROGRESS_SEEN = progress.completed;
    renderCompliance();
    return;
  }
  COMPLIANCE_PROGRESS_SEEN = progress.completed;
  $('#compliance-progress-label').textContent =
    `${progress.completed} / ${progress.total} sites scanned`;
  $('#compliance-progress-sites').textContent = progress.currentSites.length
    ? `Currently: ${progress.currentSites.join(', ')}`
    : '';
  const bar = $('#compliance-progress-bar');
  bar.max = Math.max(1, progress.total);
  bar.value = progress.completed;
  COMPLIANCE_PROGRESS_TIMER = setTimeout(pollComplianceProgress, 750);
}

let ANALYTICS_SITE = null; // persists across soft-refreshes
let ANALYTICS_SCROLL_TO_DETAIL = false;

let SEO_PRIORITY = 'all';
let SEO_TYPE = 'all';
let SEO_SITE = 'all';
let SEO_PAGE = 1;
const SEO_PAGE_SIZE = 24;
let BACKLINK_SITE = 'all';

const SEO_TYPE_LABELS = {
  'striking-distance': 'Striking distance',
  'low-ctr': 'Low CTR',
  'traffic-decline': 'Traffic decline',
  'page-opportunity': 'Page opportunity',
  'content-decay': 'Content decay',
  'engagement-risk': 'Engagement risk',
  'click-uplift': 'Click upside',
  cannibalization: 'Cannibalization',
  'web-vitals': 'Web performance',
  'broken-links': 'Broken links',
  crawlability: 'Crawlability',
};

function seoNum(value) {
  return Number(value || 0).toLocaleString();
}

function seoBadge(priority) {
  const cls = priority === 'high' ? 'b-red' : priority === 'medium' ? 'b-yellow' : 'b-blue';
  return `<span class="badge ${cls}">${esc(priority)}</span>`;
}

async function renderSeoIntelligence() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading SEO intelligence…</div></div>';
  const [data, vitals] = await Promise.all([
    api('GET', '/api/seo-intelligence?days=90'),
    api('GET', '/api/web-vitals').catch(() => null),
  ]);
  if (!data || data.error) {
    renderViewError(app, (data && data.error) || 'SEO intelligence unavailable');
    return;
  }

  const allActions = data.actions || [];
  const siteNames = (data.sites || []).map(s => s.site).sort();
  const types = Object.entries(data.types || {}).sort((a, b) => b[1] - a[1]);
  const maxType = Math.max(1, ...types.map(([, count]) => count));
  const filtered = allActions.filter(
    action =>
      (SEO_PRIORITY === 'all' || action.priority === SEO_PRIORITY) &&
      (SEO_TYPE === 'all' || action.type === SEO_TYPE) &&
      (SEO_SITE === 'all' || action.site === SEO_SITE)
  );
  const seoPageCount = Math.max(1, Math.ceil(filtered.length / SEO_PAGE_SIZE));
  SEO_PAGE = Math.min(Math.max(1, SEO_PAGE), seoPageCount);
  const seoPageStart = (SEO_PAGE - 1) * SEO_PAGE_SIZE;

  const source = data.sources || {};
  const upstream = data.upstream || {};
  const vitalFactors = vitals?.factors || {};
  const vitalSites = vitals?.sites || [];
  const vitalAge = factor =>
    vitalFactors[factor]?.age_seconds == null
      ? 'no run'
      : `${Math.round(vitalFactors[factor].age_seconds / 3600)}h ago`;
  const vitalStatus = factor => {
    const totals = vitalFactors[factor]?.totals || {};
    if (!vitalFactors[factor]) return 'missing';
    if ((totals.errors || 0) > 0 || (totals.regressed || 0) > 0 || (totals.over_budget || 0) > 0)
      return 'attention';
    return 'healthy';
  };
  const vitalCards = ['mobile', 'desktop']
    .map(factor => {
      const meta = vitalFactors[factor];
      const totals = meta?.totals || {};
      const status = vitalStatus(factor);
      return `<article class="seo-vitals-card ${status}"><div class="seo-vitals-card-top"><b>${esc(factor)}</b><span class="badge ${status === 'healthy' ? 'b-green' : status === 'missing' ? 'b-gray' : 'b-red'}">${esc(status)}</span></div><strong>${meta ? `${totals.regressed || 0} regressed · ${totals.over_budget || 0} over budget` : 'No report'}</strong><span class="muted">${esc(vitalAge(factor))} · ${totals.sites || 0} sites</span><button type="button" class="btn sm web-vitals-run" data-factor="${factor}">↻ Run now</button></article>`;
    })
    .join('');
  const vitalRows = vitalSites
    .slice(0, 60)
    .map(row => {
      const cell = factor => {
        const item = row[factor];
        if (!item) return '<td class="muted">—</td>';
        const m = item.metrics || {};
        const bad =
          (item.budget_breaches || []).length || (item.regressions || []).length || item.error;
        return `<td class="${bad ? 'web-vitals-bad' : ''}">${item.error ? esc(item.error) : `${seoNum(m.performance)} · ${m.lcp_ms == null ? '—' : Math.round(m.lcp_ms) + 'ms'}`}</td>`;
      };
      return `<tr data-fleet-row data-site="${esc(row.site)}"><td>${siteLink(row.site)}</td>${cell('mobile')}${cell('desktop')}</tr>`;
    })
    .join('');
  const sourceNote = upstream.ok
    ? `${source.gscReady}/${source.analyticsConfigured} GSC · ${source.ga4Ready}/${source.analyticsConfigured} GA4 ready`
    : upstream.partial
      ? `Partial analytics coverage · ${source.gscReady}/${source.analyticsConfigured} GSC · ${source.ga4Ready}/${source.analyticsConfigured} GA4 ready`
      : `Search data unavailable: ${upstream.error || 'data-hub offline'} · showing stored technical evidence`;
  const statCards = [
    ['Actions', data.totals.actions, `${data.totals.sites} sites`, 'var(--a1)'],
    ['High priority', data.totals.high, 'work first', 'var(--red)'],
    [
      'Pages measured',
      seoNum(data.totals.pagesMeasured),
      `${seoNum(data.totals.queryPagePairs)} query-page pairs`,
      'var(--yellow)',
    ],
    [
      'Conversions',
      seoNum(data.totals.conversions),
      `${data.windowDays} day value signal`,
      'var(--green)',
    ],
    [
      'Search impressions',
      seoNum(data.totals.impressions),
      `${data.windowDays} day evidence`,
      'var(--purple)',
    ],
    [
      'Modeled click upside',
      `+${seoNum(data.totals.modeledClicks)}`,
      'conservative query-page gaps',
      'var(--green)',
    ],
  ]
    .map(
      ([label, value, sub, color]) => `
    <div class="seo-stat" style="--seo-c:${color}">
      <div class="seo-stat-label">${esc(label)}</div><div class="seo-stat-value">${esc(value)}</div>
      <div class="seo-stat-sub">${esc(sub)}</div>
    </div>`
    )
    .join('');

  const typeBars =
    types
      .map(
        ([type, count]) => `
    <button class="seo-type-row" data-seo-type="${esc(type)}" aria-label="Filter to ${esc(SEO_TYPE_LABELS[type] || type)} ${count}" title="Filter to ${esc(SEO_TYPE_LABELS[type] || type)}">
      <span>${esc(SEO_TYPE_LABELS[type] || type)}</span>
      <i><b style="width:${Math.max(4, Math.round((count / maxType) * 100))}%"></b></i>
      <strong>${count}</strong>
    </button>`
      )
      .join('') || '<div class="muted">No detected opportunity types.</div>';

  const siteRows = (data.sites || [])
    .slice(0, 40)
    .map(row => {
      const ctr = row.impressions ? `${((row.clicks / row.impressions) * 100).toFixed(1)}%` : '—';
      return `<tr data-fleet-row data-site="${esc(row.site)}">
      <td>${siteLink(row.site)}</td><td><b>${row.actions}</b></td>
      <td>${row.high ? `<span class="badge b-red">${row.high}</span>` : '—'}</td>
      <td>${seoNum(row.pages)}</td><td>${seoNum(row.queryPagePairs)}</td><td>${seoNum(row.sessions)}</td><td>${seoNum(row.conversions)}</td>
      <td>${seoNum(row.impressions)}</td><td>${ctr}</td>
      <td><button type="button" class="btn sm seo-focus" data-site="${esc(row.site)}">Focus</button></td>
    </tr>`;
    })
    .join('');

  const actionRows =
    filtered
      .slice(seoPageStart, seoPageStart + SEO_PAGE_SIZE)
      .map(
        action => `
    <article class="seo-action priority-${esc(action.priority)}" data-fleet-row data-site="${esc(action.site)}">
      <div class="seo-action-top">${seoBadge(action.priority)}<span class="badge b-gray">${esc(SEO_TYPE_LABELS[action.type] || action.type)}</span><span class="seo-score">rank ${esc(action.rankScore || action.score)} · value ${esc(action.valueScore || 0)}</span></div>
      <h3>${esc(action.title)}</h3>
      <div class="seo-action-site">${siteLink(action.site)}</div>
      <p class="seo-evidence">${esc(action.evidence)}</p>
      <p>${esc(action.recommendation)}</p>
      <ol class="seo-plan">${(action.plan || []).map(step => `<li>${esc(step)}</li>`).join('')}</ol>
      <div class="seo-action-foot"><span><b>${seoNum(action.metric && action.metric.value)}</b> ${esc(action.metric && action.metric.label)}</span><button type="button" class="btn sm ${action.filed ? '' : 'primary'} seo-file-task" data-site="${esc(action.site)}" data-key="${esc(action.key)}" ${action.filed ? 'disabled' : ''}>${action.filed ? '✓ Filed' : '＋ File task'}</button></div>
    </article>`
      )
      .join('') || '<div class="empty seo-empty">No actions match these filters.</div>';

  app.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">SEO Intelligence</h2><div class="crumbs">First-party search demand joined with fleet technical evidence · ${esc(sourceNote)}</div></div><button type="button" class="btn" id="seo-refresh">↻ Refresh</button></div>
    <section class="dh-panel dh-wide seo-vitals-panel"><div class="seo-work-head"><div><h3>Web vitals operations</h3><span class="muted">Pinned Lighthouse lab baselines · mobile daily · desktop weekly</span></div><span class="muted">${vitals?.generated_at ? `<time datetime="${esc(vitals.generated_at)}">${esc(fmtDate(vitals.generated_at))}</time>` : 'unavailable'}</span></div><div class="seo-vitals-cards">${vitalCards}</div><div class="table-wrap"><table class="dh-sources"><caption class="sr-only">Web vitals by site</caption><thead><tr><th>site</th><th>mobile · perf / LCP</th><th>desktop · perf / LCP</th></tr></thead><tbody>${vitalRows || '<tr><td colspan="3" class="muted">No vitals reports yet.</td></tr>'}</tbody></table></div></section>
    <section class="seo-stats">${statCards}</section>
    <div class="seo-overview-grid">
      <section class="dh-panel"><h3>Opportunity mix</h3><div class="seo-type-bars">${typeBars}</div></section>
      <section class="dh-panel"><h3>Data coverage</h3>
        <div class="seo-coverage"><div><b>${source.analyticsConfigured || 0}</b><span>analytics configured</span></div><div><b>${source.gscReady || 0}</b><span>GSC current</span></div><div><b>${source.ga4Ready || 0}</b><span>GA4 current</span></div><div><b>${source.queryPageSites || 0}</b><span>query-page mapped</span></div><div><b>${source.ga4PageSites || 0}</b><span>GA4 page data</span></div><div><b>${source.linkRotSites || 0}</b><span>link crawls</span></div></div>
        <p class="muted seo-source-note">Value scores use conversions, sessions, engagement, and search demand—not estimated dollars. Technical actions remain available when data-hub is offline.</p>
      </section>
    </div>
    <section class="dh-panel dh-wide seo-sites"><h3>Site opportunity map</h3>
      <div class="table-wrap"><table class="dh-sources"><caption class="sr-only">SEO opportunity map by site</caption><thead><tr><th scope="col">site</th><th scope="col">actions</th><th scope="col">high</th><th scope="col">pages</th><th scope="col">query-page pairs</th><th scope="col">sessions</th><th scope="col">conversions</th><th scope="col">impressions</th><th scope="col">CTR</th><th scope="col">Actions</th></tr></thead>
      <tbody>${siteRows || '<tr><td colspan="10" class="muted">No site evidence available.</td></tr>'}</tbody></table>
      </div>
    </section>
    <section class="seo-work-head">
      <div><h3>Action queue</h3><span class="muted">${filtered.length} of ${allActions.length} evidence-backed items</span></div>
      <div class="task-toolbar seo-toolbar">
        <select id="seo-priority" class="cm-input" aria-label="Filter SEO opportunities by priority"><option value="all">All priorities</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>
        <select id="seo-type" class="cm-input" aria-label="Filter SEO opportunities by type"><option value="all">All opportunity types</option>${types.map(([type]) => `<option value="${esc(type)}">${esc(SEO_TYPE_LABELS[type] || type)}</option>`).join('')}</select>
        <select id="seo-site" class="cm-input" aria-label="Filter SEO opportunities by site"><option value="all">All sites</option>${siteNames.map(site => `<option value="${esc(site)}">${esc(site)}</option>`).join('')}</select>
      </div>
    </section>
    ${seoPageCount > 1 ? `<nav class="seo-pagination" aria-label="SEO action pages"><button type="button" class="btn sm" id="seo-prev" ${SEO_PAGE === 1 ? 'disabled' : ''}>← Previous</button><span class="muted" id="seo-page-status" role="status">Showing ${seoPageStart + 1}–${Math.min(seoPageStart + SEO_PAGE_SIZE, filtered.length)} of ${filtered.length} actions · Page ${SEO_PAGE} of ${seoPageCount}</span><button type="button" class="btn sm" id="seo-next" ${SEO_PAGE === seoPageCount ? 'disabled' : ''}>Next →</button></nav>` : ''}
    <section class="seo-actions">${actionRows}</section>`;

  $('#seo-refresh').addEventListener('click', () => renderSeoIntelligence());
  $('#seo-priority').value = SEO_PRIORITY;
  $('#seo-type').value = SEO_TYPE;
  $('#seo-site').value = SEO_SITE;
  $('#seo-priority').addEventListener('change', e => {
    SEO_PRIORITY = e.target.value;
    SEO_PAGE = 1;
    softRender();
  });
  $('#seo-type').addEventListener('change', e => {
    SEO_TYPE = e.target.value;
    SEO_PAGE = 1;
    softRender();
  });
  $('#seo-site').addEventListener('change', e => {
    SEO_SITE = e.target.value;
    SEO_PAGE = 1;
    softRender();
  });
  $$('.seo-type-row').forEach(button =>
    button.addEventListener('click', () => {
      SEO_TYPE = button.dataset.seoType;
      SEO_PAGE = 1;
      softRender();
    })
  );
  $$('.seo-focus').forEach(button =>
    button.addEventListener('click', () => {
      SEO_SITE = button.dataset.site;
      SEO_PAGE = 1;
      softRender();
    })
  );
  $('#seo-prev')?.addEventListener('click', () => {
    SEO_PAGE = Math.max(1, SEO_PAGE - 1);
    softRender();
  });
  $('#seo-next')?.addEventListener('click', () => {
    SEO_PAGE = Math.min(seoPageCount, SEO_PAGE + 1);
    softRender();
  });
  $$('.seo-file-task:not([disabled])').forEach(button =>
    button.addEventListener('click', async () => {
      const original = button.textContent;
      button.disabled = true;
      button.textContent = 'Filing…';
      try {
        const result = await api('POST', '/api/seo-intelligence/file', {
          site: button.dataset.site,
          key: button.dataset.key,
        });
        toast(result.duplicate ? 'Task was already filed' : `Filed ${result.file}`);
        softRender();
      } catch (error) {
        button.disabled = false;
        button.textContent = original;
        toast(error.message, 'err');
      }
    })
  );
  $$('.web-vitals-run').forEach(button =>
    button.addEventListener('click', async () => {
      const factor = button.dataset.factor;
      button.disabled = true;
      button.textContent = 'Queued…';
      try {
        await api('POST', '/api/web-vitals/run', { form_factor: factor });
        toast(`${factor} web-vitals sweep queued`);
      } catch (error) {
        toast(error.message, 'err');
        button.disabled = false;
        button.textContent = '↻ Run now';
      }
    })
  );
  applyFleetFilter();
  if (!FRESH) applyUISnap();
}

function backlinkBadge(status) {
  const cls =
    status === 'missing'
      ? 'b-red'
      : status === 'stale'
        ? 'b-yellow'
        : status === 'current'
          ? 'b-green'
          : 'b-blue';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

async function renderBacklinks() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading backlink coverage…</div></div>';
  let data;
  try {
    data = await api('GET', '/api/backlinks');
  } catch (e) {
    renderViewError(app, e.message);
    return;
  }
  if (!data || data.error) {
    renderViewError(app, data?.error || 'backlink audit unavailable');
    return;
  }
  const rows = (data.sites || []).filter(
    row => BACKLINK_SITE === 'all' || row.site === BACKLINK_SITE
  );
  const counts = data.totals || {};
  const cards = [
    ['Coverage', `${data.coverage || 0}%`, `${counts.sites || 0} sites tracked`, 'var(--a1)'],
    ['Missing', counts.missing || 0, 'no backlink report', 'var(--red)'],
    [
      'Needs refresh',
      (counts.stale || 0) + (counts.baseline || 0),
      'stale or unquantified',
      'var(--yellow)',
    ],
    ['Measured', counts.current || 0, 'quantified/current reports', 'var(--green)'],
  ]
    .map(
      ([label, value, sub, color]) =>
        `<div class="seo-stat" style="--seo-c:${color}"><div class="seo-stat-label">${esc(label)}</div><div class="seo-stat-value">${esc(value)}</div><div class="seo-stat-sub">${esc(sub)}</div></div>`
    )
    .join('');
  const detail =
    BACKLINK_SITE !== 'all' ? (data.sites || []).find(row => row.site === BACKLINK_SITE) : null;
  const detailHtml = detail
    ? `<section class="dh-panel dh-wide"><div class="page-head"><h3>${siteLink(detail.site)} detail</h3><div><button type="button" class="btn sm backlink-accent backlink-file" data-site="${esc(detail.site)}">＋ File task</button> <button type="button" class="btn sm backlink-back">Show fleet</button></div></div><p>${esc(detail.recommendation)}</p><p class="muted">Latest report: ${esc(detail.latestDate || 'none')} · ${esc(detail.latestAgeDays == null ? '—' : `${detail.latestAgeDays} days old`)} · sources: ${esc(detail.sources?.join(', ') || 'none')}</p>${(detail.reports || []).map(report => `<article class="seo-action"><div class="seo-action-top">${backlinkBadge(report.measured ? 'measured' : 'baseline')}<span class="muted">${esc(report.date)}</span></div><p>${esc(report.excerpt || 'No summary excerpt')}</p><div class="muted mono">${esc(report.file)}</div></article>`).join('')}</section>`
    : '';
  const alerts = (data.alerts || []).filter(
    alert => BACKLINK_SITE === 'all' || alert.site === BACKLINK_SITE
  );
  const alertHtml = alerts.length
    ? `<section class="dh-panel dh-wide"><h3>Material changes</h3><p class="muted">Changes of at least 25% between measured captures.</p>${alerts.map(alert => `<div class="seo-action"><strong>${siteLink(alert.site)}</strong> — ${esc(alert.metric)} ${esc(alert.type)}: ${esc(alert.before)} → ${esc(alert.after)} <span class="muted">(${esc(alert.latestDate)} vs ${esc(alert.previousDate)})</span></div>`).join('')}</section>`
    : '';
  const table = rows
    .map(
      row =>
        `<tr data-fleet-row data-site="${esc(row.site)}"><td>${siteLink(row.site)}</td><td>${backlinkBadge(row.status)}</td><td>${esc(row.latestDate || '—')}</td><td>${esc(row.latestAgeDays == null ? '—' : `${row.latestAgeDays}d`)}</td><td>${esc(row.sources?.join(', ') || '—')}</td><td><button type="button" class="btn sm backlink-focus" data-site="${esc(row.site)}">Details</button> <button type="button" class="btn sm backlink-accent backlink-file" data-site="${esc(row.site)}">＋ Task</button></td></tr>`
    )
    .join('');
  app.innerHTML = `<div class="page-head"><div><h2 class="page-title">Backlink Capture</h2><div class="crumbs">Fleet-wide backlink-report coverage and evidence provenance · generated ${esc(data.generatedAt || 'live')}</div></div><div><button type="button" id="backlinks-refresh" class="btn">↻ Refresh</button> <button type="button" id="backlinks-baseline" class="btn backlink-accent">＋ Queue all baselines</button> <button type="button" id="backlinks-run" class="btn backlink-accent">↻ Run audit now</button></div></div><section class="seo-stats">${cards}</section>${alertHtml}<section class="dh-panel dh-wide"><h3>What this measures</h3><p class="muted">A report is not treated as a quantified backlink capture unless it records a real source such as Moz, Bing Webmaster, Ahrefs, or DataForSEO. Missing reports are high-priority acquisition-domain follow-up; this page does not invent counts from search snippets.</p></section>${detailHtml}<section class="dh-panel dh-wide backlink-table"><div class="seo-work-head"><h3>Site coverage</h3><select id="backlink-site" class="cm-input"><option value="all">All sites</option>${(data.sites || []).map(row => `<option value="${esc(row.site)}">${esc(row.site)}</option>`).join('')}</select></div><div class="table-wrap"><table class="dh-sources"><caption class="sr-only">Backlink coverage by site</caption><thead><tr><th scope="col">site</th><th scope="col">status</th><th scope="col">latest</th><th scope="col">age</th><th scope="col">sources</th><th scope="col">Actions</th></tr></thead><tbody>${table || '<tr><td colspan="6" class="muted">No sites found.</td></tr>'}</tbody></table></div></section>`;
  $('#backlink-site')?.setAttribute('aria-label', 'Filter backlink coverage by site');
  $('#backlinks-refresh').addEventListener('click', () => renderBacklinks());
  $('#backlink-site').value = BACKLINK_SITE;
  $('#backlink-site').addEventListener('change', event => {
    BACKLINK_SITE = event.target.value;
    softRender();
  });
  $('#backlinks-baseline').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    event.currentTarget.textContent = 'Queuing…';
    try {
      const result = await api('POST', '/api/backlinks/baseline-tasks', {});
      toast(`${result.createdCount} baseline task${result.createdCount === 1 ? '' : 's'} queued`);
      setTimeout(() => softRender(), 500);
    } catch (e) {
      toast(e.message, 'err');
      event.currentTarget.disabled = false;
      event.currentTarget.textContent = '＋ Queue all baselines';
    }
  });
  $('#backlinks-run').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    event.currentTarget.textContent = 'Queued…';
    try {
      await api('POST', '/api/backlinks/run', {});
      toast('Backlink audit queued');
      setTimeout(() => softRender(), 1200);
    } catch (e) {
      toast(e.message, 'err');
      event.currentTarget.disabled = false;
      event.currentTarget.textContent = '↻ Run audit now';
    }
  });
  $$('.backlink-focus').forEach(button =>
    button.addEventListener('click', () => {
      BACKLINK_SITE = button.dataset.site;
      softRender();
    })
  );
  $$('.backlink-file').forEach(button =>
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await api(
          'POST',
          `/api/backlinks/${encodeURIComponent(button.dataset.site)}/file`,
          {}
        );
        toast(result.duplicate ? 'Backlink task already exists' : 'Backlink task filed');
      } catch (e) {
        toast(e.message, 'err');
        button.disabled = false;
      }
    })
  );
  $('.backlink-back')?.addEventListener('click', () => {
    BACKLINK_SITE = 'all';
    softRender();
  });
  applyFleetFilter();
}

function anDelta(cur, prev) {
  if (prev == null) return '';
  const pct = prev === 0 ? (cur > 0 ? 100 : 0) : Math.round(((cur - prev) / prev) * 100);
  const cls = pct > 0 ? 'dh-ok' : pct < 0 ? 'dh-err' : '';
  const sign = pct > 0 ? '+' : '';
  return ` <span class="dh-b ${cls}">${sign}${pct}% WoW</span>`;
}

async function renderAnalytics() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div class="page-head"><div><h2 class="page-title">Analytics</h2><span class="muted">Traffic, search demand, affiliate intent, and capture freshness</span></div></div><div role="status" aria-live="polite"><div class="loading">Loading analytics…</div></div>';

  const sitesResp = await api('GET', '/api/sites');
  const sites = (sitesResp && sitesResp.sites) || sitesResp || [];
  const siteNames = sites
    .map(s => (typeof s === 'string' ? s : s.domain || s.name))
    .filter(Boolean)
    .sort();
  if (!ANALYTICS_SITE || !siteNames.includes(ANALYTICS_SITE)) ANALYTICS_SITE = siteNames[0] || null;

  const health = await api('GET', '/api/analytics/health');
  const amazonRevenue = await api('GET', '/api/revenue/amazon');
  const healthSites = (health && health.sites) || {};

  const healthRows = Object.keys(healthSites)
    .sort()
    .map(site => {
      const s = healthSites[site] || {};
      const stateCell = st => {
        if (!st) return '<span class="dh-b dh-skip">no data</span>';
        const cls = st.stale ? 'dh-stale' : (st.status || '').startsWith('ok') ? 'dh-ok' : 'dh-err';
        return `<span class="dh-b ${cls}">${esc(st.status || 'unknown')}</span> <span class="dh-time">${esc((st.last_fetch_at || '').replace('T', ' ').slice(0, 19) || '—')}</span>`;
      };
      const gate = s.consent_gated
        ? ' <span class="dh-ovr" title="gated behind explicit visitor consent — reports only consented traffic, reads lower than reality">consent-gated</span>'
        : '';
      const selected = site === ANALYTICS_SITE;
      return `<tr class="an-site-row${selected ? ' is-selected' : ''}" data-an-site="${esc(site)}" tabindex="0" role="button" aria-pressed="${selected}" title="Load analytics for ${esc(site)}"><td><span class="an-site-name">${esc(site)}</span>${gate}</td><td>${stateCell(s.ga4)}</td><td>${stateCell(s.gsc)}</td></tr>`;
    })
    .join('');
  const healthHtml = `
    <div class="table-wrap"><table class="dh-sources">
      <caption class="sr-only">Analytics capture freshness by site</caption>
      <thead><tr><th>site</th><th>GA4</th><th>Search Console</th></tr></thead>
      <tbody>${healthRows || '<tr><td colspan="3" class="muted">no sites</td></tr>'}</tbody>
    </table></div>`;
  const amazonHtml =
    amazonRevenue && amazonRevenue.has_data
      ? `<div>Amazon clicks <b>${esc(String(amazonRevenue.clicks))}</b> · ordered <b>${esc(String(amazonRevenue.ordered_items))}</b> · shipped <b>${esc(String(amazonRevenue.shipped_items))}</b> · commission <b>$${esc(Number(amazonRevenue.commission_income).toFixed(2))}</b></div><div class="dh-sub-h">account-wide · ${esc(amazonRevenue.from || '—')} through ${esc(amazonRevenue.through || '—')}</div>`
      : `<div class="muted">${esc((amazonRevenue && amazonRevenue.message) || 'Amazon earnings data unavailable')}</div>`;

  let detailHtml = '<div class="muted">select a site</div>';
  if (ANALYTICS_SITE) {
    const [summary, wow, topPages, topConvertingPages, topQueries] = await Promise.all([
      api('GET', `/api/analytics/summary?site=${encodeURIComponent(ANALYTICS_SITE)}&window=28`),
      api('GET', `/api/analytics/wow?site=${encodeURIComponent(ANALYTICS_SITE)}`),
      api(
        'GET',
        `/api/analytics/top?site=${encodeURIComponent(ANALYTICS_SITE)}&source=ga4&metric=sessions&window=28&limit=10`
      ),
      api(
        'GET',
        `/api/analytics/top?site=${encodeURIComponent(ANALYTICS_SITE)}&source=ga4&metric=conversions&window=28&limit=10`
      ),
      api(
        'GET',
        `/api/analytics/top?site=${encodeURIComponent(ANALYTICS_SITE)}&source=gsc&metric=clicks&window=28&limit=10`
      ),
    ]);

    let summaryHtml;
    if (!summary || summary.has_data === false) {
      summaryHtml = '<div class="muted">no data captured yet for this site</div>';
    } else {
      const ga4Line =
        'sessions' in summary
          ? `<div>sessions <b>${esc(String(summary.sessions))}</b>${wow.ga4 ? anDelta(wow.ga4.cur.sessions, wow.ga4.prev.sessions) : ''} · users <b>${esc(String(summary.users))}</b> · affiliate clicks <b>${esc(String(summary.conversions))}</b> · click/session <b>${summary.sessions ? esc(`${((summary.conversions / summary.sessions) * 100).toFixed(2)}%`) : '—'}</b></div>`
          : '<div class="muted">no GA4 data</div>';
      const gscLine =
        'clicks' in summary
          ? `<div>clicks <b>${esc(String(summary.clicks))}</b>${wow.gsc ? anDelta(wow.gsc.cur.clicks, wow.gsc.prev.clicks) : ''} · impressions <b>${esc(String(summary.impressions))}</b></div>`
          : '<div class="muted">no Search Console data</div>';
      summaryHtml = `${ga4Line}${gscLine}<div class="dh-sub-h">trailing 28 days</div>`;
    }

    const topRows = (label, rows, metric) =>
      (rows.top || [])
        .map(
          r =>
            `<tr><td class="dh-host">${esc(r.dim_key)}</td><td><b>${esc(String(r[metric] ?? 0))}</b></td></tr>`
        )
        .join('') || `<tr><td colspan="2" class="muted">no ${label} data</td></tr>`;

    detailHtml = `
      ${collapsiblePanel('analytics.summary', `${siteLink(ANALYTICS_SITE)} — Summary`, summaryHtml)}
      ${collapsiblePanel(
        'analytics.pages',
        'Top Pages (sessions)',
        `<div class="table-wrap"><table class="dh-datasets"><caption class="sr-only">Top pages by sessions</caption><thead><tr><th>page</th><th>sessions</th></tr></thead><tbody>${topRows('page', topPages, 'sessions')}</tbody></table></div>`
      )}
      ${collapsiblePanel(
        'analytics.converting-pages',
        'Affiliate Funnel — click origin pages',
        `<p class="muted">Consent-observed clicks on first-party <code>/go/</code> links. This identifies which pages and offers create buying intent; Amazon orders and commission remain unavailable until the Associates earnings session is connected.</p><div class="table-wrap"><table class="dh-datasets"><caption class="sr-only">Affiliate click origin pages</caption><thead><tr><th>page</th><th>affiliate clicks</th></tr></thead><tbody>${topRows('affiliate click', topConvertingPages, 'conversions')}</tbody></table></div>`
      )}
      ${collapsiblePanel(
        'analytics.queries',
        'Top Queries (clicks)',
        `<div class="table-wrap"><table class="dh-datasets"><caption class="sr-only">Top search queries by clicks</caption><thead><tr><th>query</th><th>clicks</th></tr></thead><tbody>${topRows('query', topQueries, 'clicks')}</tbody></table></div>`
      )}`;
  }

  const siteIndex = Math.max(0, siteNames.indexOf(ANALYTICS_SITE));
  const picker = `<div class="an-site-nav">
    <button class="btn sm an-site-step" type="button" data-step="-1" aria-label="Previous site" title="Previous site"${siteNames.length < 2 ? ' disabled' : ''}>←</button>
    <label for="an-site-picker" class="sr-only">Analytics site</label>
    <select id="an-site-picker">${siteNames.map(s => `<option value="${esc(s)}" ${s === ANALYTICS_SITE ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
    <button class="btn sm an-site-step" type="button" data-step="1" aria-label="Next site" title="Next site"${siteNames.length < 2 ? ' disabled' : ''}>→</button>
    <span class="an-site-position muted">${siteNames.length ? `${siteIndex + 1} of ${siteNames.length}` : 'No sites'}</span>
  </div>`;

  app.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">Analytics</h2><span class="muted">Traffic, search demand, affiliate intent, and capture freshness</span></div><button type="button" class="btn" id="analytics-refresh">↻ Refresh</button></div>
    <div class="dh-grid">
      ${collapsiblePanel('analytics.health', 'Capture Freshness — all sites', healthHtml, 'dh-panel dh-wide')}
      ${collapsiblePanel('analytics.amazon', 'Amazon Associates — revenue outcome', amazonHtml, 'dh-panel dh-wide')}
      <section class="dh-panel dh-wide an-picker-panel">${picker}</section>
      <div class="an-detail-grid" id="an-detail" aria-live="polite">${detailHtml}</div>
    </div>`;

  const picked = $('#an-site-picker');
  $('#analytics-refresh').addEventListener('click', () => renderAnalytics());
  if (picked)
    picked.addEventListener('change', () => {
      ANALYTICS_SITE = picked.value;
      softRender();
    });

  $$('.an-site-step').forEach(button =>
    button.addEventListener('click', () => {
      if (siteNames.length < 2) return;
      const next =
        (siteNames.indexOf(ANALYTICS_SITE) + Number(button.dataset.step) + siteNames.length) %
        siteNames.length;
      ANALYTICS_SITE = siteNames[next];
      ANALYTICS_SCROLL_TO_DETAIL = true;
      softRender();
    })
  );

  const selectHealthSite = row => {
    ANALYTICS_SITE = row.dataset.anSite;
    ANALYTICS_SCROLL_TO_DETAIL = true;
    softRender();
  };
  $$('.an-site-row').forEach(row => {
    row.addEventListener('click', () => selectHealthSite(row));
    row.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      selectHealthSite(row);
    });
  });

  wireCollapsiblePanels(app);

  if (!FRESH) applyUISnap();
  if (ANALYTICS_SCROLL_TO_DETAIL) {
    ANALYTICS_SCROLL_TO_DETAIL = false;
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        $('#an-detail')?.scrollIntoView({
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          block: 'start',
        })
      )
    );
  }
}

/* ===================== LINT ===================== */
// Fleet prettier sweep (server/lintfleet.js -> tools/lint-fleet/lint-sweep.py).
// Two very different signals share this table and must not be conflated:
//   broken — prettier CANNOT PARSE the file, so the shared pre-commit hook
//            silently skips it forever. This is the rot this page exists for.
//   drift  — parses fine, merely unformatted; the next commit staging it fixes
//            it automatically. Informational only.
const LINT = { open: new Set() };

function lintStatusBadge(status) {
  if (status === 'broken') return '<span class="badge b-red">broken</span>';
  if (status === 'drift') return '<span class="badge b-yellow">drift</span>';
  if (status === 'clean') return '<span class="badge b-green">clean</span>';
  return '<span class="badge b-gray">no source</span>';
}

async function renderLint() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading lint sweep…</div></div>';
  let d;
  try {
    d = await api('GET', '/api/lint');
  } catch (e) {
    renderViewError(app, `Lint sweep failed: ${e.message}`);
    return;
  }

  const running = d.progress && d.progress.running;
  if (!d.report) {
    app.innerHTML = `
      <div class="page-head"><h2 class="page-title">Lint</h2><span class="muted">fleet-wide prettier parse + format sweep</span></div>
      <div class="task-toolbar lint-toolbar" role="group" aria-label="Lint actions">
        <button type="button" class="btn" id="lint-scan" ${running ? 'disabled' : ''}>${running ? 'Sweeping…' : 'Run sweep'}</button>
        <span class="muted">No sweep has run on this host yet.</span>
      </div>`;
    wireLintButtons();
    if (running)
      setTimeout(() => {
        if (STATE.view === 'lint') softRender();
      }, 5000);
    return;
  }

  const r = d.report;
  const s = r.summary || {};
  const swept = r.generated_at
    ? fmtAge((Date.now() - new Date(r.generated_at).getTime()) / 1000) + ' ago'
    : 'unknown';
  const newErrors = r.new_parse_errors || [];

  const rows = (r.sites || [])
    .filter(row => row.status === 'broken' || row.status === 'drift')
    .map(row => {
      const open = LINT.open.has(row.site);
      const errs = (row.parse_errors || [])
        .map(
          e =>
            `<li><span class="mono">${esc(e.file)}</span><div class="muted">${esc(e.message)}</div></li>`
        )
        .join('');
      const drift = (row.unformatted || [])
        .map(f => `<li class="mono muted">${esc(f)}</li>`)
        .join('');
      return `<tr data-fleet-row data-site="${esc(row.site)}">
      <td class="site"><button type="button" class="table-link lint-open" data-site="${esc(row.site)}">${esc(row.site)}</button></td>
      <td>${lintStatusBadge(row.status)}</td>
      <td class="mono">${(row.parse_errors || []).length}</td>
      <td class="mono muted">${(row.unformatted || []).length}</td>
      <td class="mono muted">${row.files_checked}</td>
      <td><button type="button" class="btn sm lint-rescan" data-site="${esc(row.site)}" ${running ? 'disabled' : ''}>Rescan</button></td>
    </tr>
    <tr class="cn-detail-row${open ? '' : ' hidden'}" data-detail="lint:${esc(row.site)}" data-rk="lint:${esc(row.site)}"><td colspan="6">
      ${errs ? `<div class="cn-log-head">Prettier cannot parse — the pre-commit hook is skipping these files</div><ul>${errs}</ul>` : ''}
      ${drift ? `<div class="cn-log-head muted">Unformatted (auto-fixes on next commit that stages them)</div><ul>${drift}</ul>` : ''}
    </td></tr>`;
    })
    .join('');

  app.innerHTML = `
    <div class="page-head"><h2 class="page-title">Lint</h2><span class="muted">fleet-wide prettier parse + format sweep — the detector for files the pre-commit hook silently skips</span></div>
    <div class="task-toolbar lint-toolbar" role="group" aria-label="Lint actions">
      <strong>${s.parse_errors || 0} unparseable file(s) across ${s.broken || 0} site(s)</strong>
      <span class="muted">${s.unformatted || 0} merely unformatted · ${s.clean || 0} clean · ${s.files_checked || 0} files checked · swept ${esc(swept)}</span>
      <button type="button" class="btn" id="lint-scan" ${running ? 'disabled' : ''}>${running ? 'Sweeping…' : 'Rescan fleet'}</button>
    </div>
    ${newErrors.length ? `<div class="card lint-alert" role="status"><div class="cn-log-head">New since the previous sweep (${newErrors.length})</div><ul>${newErrors.map(e => `<li class="mono">${esc(e.site)}/${esc(e.file)}</li>`).join('')}</ul></div>` : ''}
    <div class="card lint-table"><div class="table-wrap"><table>
      <caption class="sr-only">Lint findings by site</caption>
      <thead><tr><th scope="col">Site</th><th scope="col">Status</th><th scope="col">Parse errors</th><th scope="col">Unformatted</th><th scope="col">Files</th><th scope="col">Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">Every site is clean.</td></tr>'}</tbody>
    </table></div></div>
    <details class="lint-help"><summary>How to remediate lint findings</summary><p>A <strong>parse error</strong> is the real signal: <span class="mono">tools/git-hooks/pre-commit</span> pipes prettier through xargs and ignores its exit code, so an unparseable file is never formatted and nothing reports it. Fix the source (JSX-style <span class="mono">{/* … */}</span> comments inside template expressions, no raw <span class="mono">&lt;svg&gt;</span> in attributes, no script bodies inside template expressions) rather than adding a <span class="mono">.prettierignore</span>. Sites shown clean are omitted from the table.</p></details>`;

  $$('.lint-open').forEach(a =>
    a.addEventListener('click', e => {
      e.preventDefault();
      lintToggle(a.dataset.site);
    })
  );
  wireLintButtons();
  if (running)
    setTimeout(() => {
      if (STATE.view === 'lint') softRender();
    }, 5000);
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

function lintToggle(site) {
  const row = $(`tr[data-detail="lint:${CSS.escape(site)}"]`);
  if (!row) return;
  if (LINT.open.has(site)) {
    LINT.open.delete(site);
    row.classList.add('hidden');
    return;
  }
  LINT.open.add(site);
  row.classList.remove('hidden');
}

function wireLintButtons() {
  const all = $('#lint-scan');
  if (all) all.addEventListener('click', () => lintScan(all, null));
  $$('.lint-rescan').forEach(b => b.addEventListener('click', () => lintScan(b, b.dataset.site)));
}

async function lintScan(btn, site) {
  gdBusy(btn, true);
  try {
    await api('POST', `/api/lint/scan${site ? `?site=${encodeURIComponent(site)}` : ''}`);
    toast(site ? `Sweeping ${site}…` : 'Fleet sweep started (~25s)…');
    // The sweep runs detached; renderLint polls until progress.running clears.
    softRender();
  } catch (e) {
    gdBusy(btn, false);
    toast(`Sweep failed: ${e.message}`, 'err');
  }
}

/* ===== DATA HUB IMAGES ===== */

const DHI_PAGE_SIZE = 20;
const DHI_COUNT_PAGES = new Map();
const DHI_COUNT_ITEMS = new Map();
const DHI_TABLE_PAGES = new Map();
const DHI_TABLE_ITEMS = new Map();
let DHI_IMAGE_PAGE = 1;
let DHI_IMAGE_ITEMS = [];

function dhiBadge(status) {
  const s = String(status || '');
  let cls = 'dhi-b';
  if (s === 'ok' || s === 'active') cls += ' dhi-ok';
  else if (s.startsWith('skipped') || s === 'pending') cls += ' dhi-skip';
  else if (s === 'error' || s.startsWith('error') || s === 'blacklisted' || s === 'deleted')
    cls += ' dhi-err';
  return `<span class="${cls}">${esc(s || '—')}</span>`;
}

function dhiPathBadge(policy, exitNode) {
  if (policy === 'direct') return `<span class="dhi-path dhi-direct">direct</span>`;
  return `<span class="dhi-path dhi-vpn">vpn:${esc(exitNode || '?')}</span>`;
}

function dhiCountTable(title, counts) {
  const key = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
  DHI_COUNT_ITEMS.set(key, { title, entries });
  return dhiCountBlockHtml(key, title, entries);
}

function dhiCountBlockHtml(key, title, entries) {
  const pageCount = Math.max(1, Math.ceil(entries.length / DHI_PAGE_SIZE));
  const page = DHI_COUNT_PAGES.get(key) || 1;
  const currentPage = Math.min(page, pageCount);
  DHI_COUNT_PAGES.set(key, currentPage);
  const start = (currentPage - 1) * DHI_PAGE_SIZE;
  const rows = entries
    .slice(start, start + DHI_PAGE_SIZE)
    .map(
      ([name, value]) =>
        `<tr><td>${esc(name || '—')}</td><td><b>${esc(String(value))}</b></td></tr>`
    )
    .join('');
  const pagination =
    pageCount > 1
      ? `<nav class="dhi-pagination" aria-label="${esc(title)} category pages"><span class="muted" role="status" aria-live="polite">${start + 1}–${Math.min(start + DHI_PAGE_SIZE, entries.length)} of ${entries.length}</span><button type="button" class="btn sm" data-dhi-count-page="${key}" data-direction="-1" aria-label="Previous ${esc(title)} page" ${currentPage <= 1 ? 'disabled' : ''}>←</button><button type="button" class="btn sm" data-dhi-count-page="${key}" data-direction="1" aria-label="Next ${esc(title)} page" ${currentPage >= pageCount ? 'disabled' : ''}>→</button></nav>`
      : '';
  return `<div class="dhi-countblock" data-count-key="${key}"><div class="dhi-countblock-h">${esc(title)} <span>${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</span></div><table class="dhi-counts"><caption class="sr-only">${esc(title)} counts</caption><tbody>${rows || '<tr><td colspan="2" class="muted">none</td></tr>'}</tbody></table>${pagination}</div>`;
}

function dhiBindCountControls(root) {
  root.querySelectorAll('[data-dhi-count-page]').forEach(button => {
    button.addEventListener('click', () => {
      const key = button.dataset.dhiCountPage;
      const direction = Number(button.dataset.direction || 0);
      const data = DHI_COUNT_ITEMS.get(key);
      if (!data) return;
      const current = DHI_COUNT_PAGES.get(key) || 1;
      DHI_COUNT_PAGES.set(
        key,
        Math.max(1, Math.min(Math.ceil(data.entries.length / DHI_PAGE_SIZE), current + direction))
      );
      const block = button.closest('.dhi-countblock');
      const replacement = document.createElement('div');
      replacement.innerHTML = dhiCountBlockHtml(key, data.title, data.entries);
      const next = replacement.firstElementChild;
      block.replaceWith(next);
      dhiBindCountControls(next);
    });
  });
}

function dhiLedgerTableHtml(key, title, headers, rows, tableClass, emptyText) {
  DHI_TABLE_ITEMS.set(key, { title, headers, rows, tableClass, emptyText });
  const pageCount = Math.max(1, Math.ceil(rows.length / DHI_PAGE_SIZE));
  const page = Math.min(DHI_TABLE_PAGES.get(key) || 1, pageCount);
  DHI_TABLE_PAGES.set(key, page);
  const start = (page - 1) * DHI_PAGE_SIZE;
  const body = rows.slice(start, start + DHI_PAGE_SIZE).join('');
  const pagination =
    pageCount > 1
      ? `<nav class="dhi-pagination" aria-label="${esc(title)} pages"><span class="muted" role="status" aria-live="polite">${start + 1}–${Math.min(start + DHI_PAGE_SIZE, rows.length)} of ${rows.length} loaded entries</span><button type="button" class="btn sm" data-dhi-table-page="${key}" data-direction="-1" aria-label="Previous ${esc(title)} page" ${page <= 1 ? 'disabled' : ''}>←</button><button type="button" class="btn sm" data-dhi-table-page="${key}" data-direction="1" aria-label="Next ${esc(title)} page" ${page >= pageCount ? 'disabled' : ''}>→</button></nav>`
      : '';
  return `<div class="dhi-ledger" data-ledger-key="${key}">${pagination}<div class="table-wrap"><table class="${tableClass}"><caption class="sr-only">${esc(title)}</caption><thead><tr>${headers.map(label => `<th scope="col">${esc(label)}</th>`).join('')}</tr></thead><tbody>${body || `<tr><td colspan="${headers.length}" class="muted">${esc(emptyText)}</td></tr>`}</tbody></table></div></div>`;
}

function dhiBindLedgerControls(root) {
  root.querySelectorAll('[data-dhi-table-page]').forEach(button => {
    button.addEventListener('click', () => {
      const key = button.dataset.dhiTablePage;
      const direction = Number(button.dataset.direction || 0);
      const data = DHI_TABLE_ITEMS.get(key);
      if (!data) return;
      const current = DHI_TABLE_PAGES.get(key) || 1;
      DHI_TABLE_PAGES.set(
        key,
        Math.max(1, Math.min(Math.ceil(data.rows.length / DHI_PAGE_SIZE), current + direction))
      );
      const ledger = button.closest('.dhi-ledger');
      const replacement = document.createElement('div');
      replacement.innerHTML = dhiLedgerTableHtml(
        key,
        data.title,
        data.headers,
        data.rows,
        data.tableClass,
        data.emptyText
      );
      const next = replacement.firstElementChild;
      ledger.replaceWith(next);
      dhiBindLedgerControls(next);
    });
  });
}

function dhiImageCard(im) {
  const credit = im.credit || {};
  const creditLine =
    credit.photographer || credit.source
      ? `${esc(credit.photographer || '')}${credit.photographer && credit.source ? ' · ' : ''}${esc(credit.source || '')}`
      : esc(im.source_id || '');
  return `<div class="dhi-thumb" data-rk="dhi-img-${esc(im.id)}"><img src="/api/datahub-images/image/${encodeURIComponent(im.id)}" loading="lazy" alt="${creditLine}" /><div class="dhi-thumb-meta"><div class="dhi-thumb-credit">${creditLine}</div><div class="dhi-thumb-sub">${esc(im.license || '—')} · score ${esc(String(im.score ?? '—'))} · ${dhiBadge(im.status)}</div><div class="dhi-thumb-actions"><button type="button" class="btn sm danger dhi-blacklist" data-id="${esc(im.id)}">Blacklist</button><button type="button" class="btn sm danger dhi-reject" data-id="${esc(im.id)}">Reject</button></div></div></div>`;
}

function dhiImageGalleryHtml(images) {
  const pageCount = Math.max(1, Math.ceil(images.length / DHI_PAGE_SIZE));
  DHI_IMAGE_PAGE = Math.min(Math.max(1, DHI_IMAGE_PAGE), pageCount);
  const start = (DHI_IMAGE_PAGE - 1) * DHI_PAGE_SIZE;
  const pagination =
    pageCount > 1
      ? `<nav class="dhi-pagination" aria-label="Recent image pages"><span class="muted" role="status" aria-live="polite">${start + 1}–${Math.min(start + DHI_PAGE_SIZE, images.length)} of ${images.length} loaded images</span><button type="button" class="btn sm" data-dhi-image-page="-1" aria-label="Previous image page" ${DHI_IMAGE_PAGE <= 1 ? 'disabled' : ''}>←</button><button type="button" class="btn sm" data-dhi-image-page="1" aria-label="Next image page" ${DHI_IMAGE_PAGE >= pageCount ? 'disabled' : ''}>→</button></nav>`
      : `<div class="dhi-pagination"><span class="muted">${images.length} loaded image${images.length === 1 ? '' : 's'}</span></div>`;
  const cards = images
    .slice(start, start + DHI_PAGE_SIZE)
    .map(dhiImageCard)
    .join('');
  return `${pagination}<div class="dhi-thumbs">${cards || '<div class="muted">no images in the pool</div>'}</div>`;
}

function dhiBindImageGallery(root) {
  root.querySelectorAll('[data-dhi-image-page]').forEach(button => {
    button.addEventListener('click', () => {
      const pageCount = Math.max(1, Math.ceil(DHI_IMAGE_ITEMS.length / DHI_PAGE_SIZE));
      DHI_IMAGE_PAGE = Math.max(
        1,
        Math.min(pageCount, DHI_IMAGE_PAGE + Number(button.dataset.dhiImagePage))
      );
      root.innerHTML = dhiImageGalleryHtml(DHI_IMAGE_ITEMS);
      dhiBindImageGallery(root);
      dhiBindImageActions(root);
    });
  });
}

function dhiBindImageActions(root) {
  root
    .querySelectorAll('.dhi-blacklist')
    .forEach(button =>
      button.addEventListener('click', () => dhiBlacklist(button.dataset.id, button))
    );
  root
    .querySelectorAll('.dhi-reject')
    .forEach(button =>
      button.addEventListener('click', () => dhiReject(button.dataset.id, button))
    );
}

async function renderDataHubImages() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div class="page-head"><h2 class="page-title">Data Hub Images</h2><span class="muted">Image collection, curation, and consumer evidence</span></div><div role="status" aria-live="polite"><div class="loading">Loading Data Hub Images…</div></div>';
  const [health, stats, imgs, src, eg, pl] = await Promise.all([
    api('GET', '/api/datahub-images/health'),
    api('GET', '/api/datahub-images/stats'),
    api('GET', '/api/datahub-images/images?limit=100'),
    api('GET', '/api/datahub-images/sources'),
    api('GET', '/api/datahub-images/egress?limit=80'),
    api('GET', '/api/datahub-images/pulls?limit=80'),
  ]);

  const hubDown = health && health.ok === false;

  // ---- Panel 1: VPN Health ----
  let healthHtml;
  if (hubDown) {
    healthHtml = `<div class="dhi-down">⚠ Data hub images API unreachable — ${esc(health.error || 'is the datahub-images-api container running?')}</div>`;
  } else {
    const vpn = health.vpn || {};
    const cell = (name, ip) => {
      const cls = ip ? 'dhi-ok' : 'dhi-err';
      return `<div class="dhi-node"><span class="dhi-node-name">${esc(name)}</span> <span class="dhi-b ${cls}">${ip ? esc(ip) : 'down'}</span></div>`;
    };
    healthHtml = `
      <div class="dhi-health">
        ${cell('US exit', vpn.us)}
        ${cell('EU exit', vpn.eu)}
        <div class="dhi-counts">db <b>${health.db ? 'ok' : 'down'}</b> · generated <b>${esc((health.generated_at || '').replace('T', ' ').slice(0, 19))}</b></div>
      </div>`;
  }

  // ---- Panel 2: Pool Stats ----
  const statsHtml = hubDown
    ? '<div class="muted">unavailable</div>'
    : `
    <div class="dhi-stats-grid">
      ${dhiCountTable('by topic', stats.pool_by_topic)}
      ${dhiCountTable('by source', stats.pool_by_source)}
      ${dhiCountTable('by license', stats.pool_by_license)}
      ${dhiCountTable('requests by status', stats.requests_by_status)}
    </div>`;

  // ---- Panel 3: Recent Images (thumbnail grid + curation actions) ----
  const images = (imgs && imgs.images) || [];
  DHI_IMAGE_ITEMS = images;
  const thumbsHtml = `<div id="dhi-image-gallery">${dhiImageGalleryHtml(images)}</div>`;

  // ---- Panel 4: Source Freshness (+ enabled/disabled toggle) ----
  const srcs = (src && src.sources) || [];
  const enabledCount = srcs.filter(s => s.enabled !== false).length;
  const disabledCount = srcs.length - enabledCount;
  const srcRows = srcs
    .map(s => {
      const st = s.state || {};
      const off = s.enabled === false;
      const stale = !off && st.stale ? ' · <span class="dhi-stale">stale</span>' : '';
      const ovr = s.overridden
        ? ' <span class="dhi-ovr" title="overridden — differs from the registry default">override</span>'
        : '';
      const statusCell = off
        ? '<span class="dhi-b dhi-skip">disabled</span>'
        : `${dhiBadge(st.status)}${stale}`;
      const toggle = `<button type="button" class="btn sm ${off ? 'primary' : 'danger'} dhi-src-toggle" data-id="${esc(s.id)}" data-enabled="${off ? 0 : 1}">${off ? '▶ Enable' : '⏸ Disable'}</button>`;
      return `<tr class="${off ? 'dhi-row-off' : ''}">
      <td>${esc(s.id)}${ovr}</td>
      <td>${esc(s.kind)}</td>
      <td>${dhiPathBadge(s.policy, s.exit)}</td>
      <td>${statusCell}</td>
      <td class="dhi-time">${esc((st.last_fetch_at || '').replace('T', ' ').slice(0, 19) || '—')}</td>
      <td class="dhi-srcctl">${toggle}</td>
    </tr>`;
    })
    .join('');
  const srcHtml = `
    <div class="dhi-srccount">${enabledCount} enabled${disabledCount ? ` · <span class="dhi-stale">${disabledCount} disabled</span>` : ''}</div>
    <div class="table-wrap"><table class="dhi-sources">
      <caption class="sr-only">Image source freshness and controls</caption>
      <thead><tr><th scope="col">source</th><th scope="col">kind</th><th scope="col">path</th><th scope="col">status</th><th scope="col">last fetch</th><th scope="col">Actions</th></tr></thead>
      <tbody>${srcRows || '<tr><td colspan="6" class="muted">no source state</td></tr>'}</tbody>
    </table></div>`;

  // ---- Panel 5: Outbound Connection Ledger (egress) ----
  const events = (eg && eg.events) || [];
  const egressHtml = dhiLedgerTableHtml(
    'egress',
    'Image outbound connection ledger',
    ['When', 'Source', 'Target', 'Path', 'Exit IP', 'Status', 'Note'],
    events.map(
      e => `
    <tr>
      <td class="dhi-time">${esc((e.ts || '').replace('T', ' ').slice(0, 19))}</td>
      <td>${esc(e.source_id || '')}</td>
      <td class="dhi-host">${esc(e.target_host || '')}</td>
      <td>${dhiPathBadge(e.policy, e.exit_node)}</td>
      <td class="dhi-ip">${esc(e.exit_ip || '—')}</td>
      <td>${dhiBadge(e.status)}</td>
      <td class="dhi-note">${esc(e.note || '')}</td>
    </tr>`
    ),
    'dhi-egress',
    'no egress events yet'
  );

  // ---- Panel 6: Site Pulls (inbound — who consumed what) ----
  const pulls = (pl && pl.pulls) || [];
  const pullsHtml = dhiLedgerTableHtml(
    'pulls',
    'Image site data pulls',
    ['When', 'Consumer', 'Endpoint', 'Items', 'Client IP'],
    pulls.map(p => {
      const who = p.site
        ? siteLink(p.site)
        : `<span class="dhi-host">${esc(p.endpoint || '')}</span>`;
      return `<tr>
      <td class="dhi-time">${esc((p.ts || '').replace('T', ' ').slice(0, 19))}</td>
      <td>${who}</td>
      <td class="dhi-host">${esc(p.endpoint || '')}</td>
      <td><b>${esc(String(p.item_count ?? 0))}</b></td>
      <td class="dhi-ip">${esc(p.client_ip || '—')}</td>
    </tr>`;
    }),
    'dhi-egress dhi-pulls',
    'no pulls yet'
  );

  app.innerHTML = `
    <div class="page-head"><h2 class="page-title">Data Hub Images</h2><span class="muted">privacy-routed image collection, source freshness, curation, and consumer evidence</span><button type="button" class="btn" id="datahub-images-refresh">↻ Refresh</button></div>
    ${hubDown ? `<div class="dhi-banner">⚠ Data hub images API unreachable</div>` : ''}
    <div class="dhi-grid">
      <section class="dhi-panel" data-rk="dhi-health"><h3>VPN Health</h3>${healthHtml}</section>
      <section class="dhi-panel" data-rk="dhi-stats"><h3>Pool Stats</h3>${statsHtml}</section>
      <section class="dhi-panel dhi-wide" data-rk="dhi-images"><h3>Recent Images <span class="live-tag">live</span></h3>${thumbsHtml}</section>
      <section class="dhi-panel" data-rk="dhi-sources"><h3>Source Freshness</h3>${srcHtml}</section>
      <section class="dhi-panel dhi-wide" data-rk="dhi-egress"><h3>Outbound Connection Ledger <span class="live-tag">live</span></h3>${egressHtml}</section>
      <section class="dhi-panel dhi-wide" data-rk="dhi-pulls"><h3>Site Pulls <span class="dhi-sub-h">inbound — who consumed what</span> <span class="live-tag">live</span></h3>${pullsHtml}</section>
    </div>`;

  $('#datahub-images-refresh').addEventListener('click', () => renderDataHubImages());
  dhiBindCountControls(app);
  dhiBindLedgerControls(app);
  const imageGallery = $('#dhi-image-gallery');
  dhiBindImageGallery(imageGallery);
  dhiBindImageActions(imageGallery);
  // Wire per-source toggles (re-bound every render).
  $$('.dhi-src-toggle').forEach(b =>
    b.addEventListener('click', () => dhiToggleSource(b.dataset.id, b.dataset.enabled === '1', b))
  );

  if (!FRESH) applyUISnap();
}

// Toggle a data-hub-images source's enabled/disabled override, then soft-refresh.
async function dhiToggleSource(id, currentlyEnabled, btn) {
  gdBusy(btn, true);
  const r = await api('POST', `/api/datahub-images/sources/${encodeURIComponent(id)}/enabled`, {
    enabled: !currentlyEnabled,
  });
  if (r && r.ok === false) {
    gdBusy(btn, false);
    toast(`Toggle failed: ${r.error || 'hub unreachable'}`);
    return;
  }
  toast(`${id} ${currentlyEnabled ? 'disabled' : 'enabled'} — applies on the next collect cycle`);
  softRender();
}

// Blacklist an image (keeps the row/blob but excludes it from future selection).
async function dhiBlacklist(id, btn) {
  gdBusy(btn, true);
  const r = await api('POST', `/api/datahub-images/images/${encodeURIComponent(id)}/blacklist`);
  if (r && r.ok === false) {
    gdBusy(btn, false);
    toast(`Blacklist failed: ${r.error || 'hub unreachable'}`);
    return;
  }
  toast(`${id} blacklisted`);
  softRender();
}

// Reject an image (deletes it from the pool).
async function dhiReject(id, btn) {
  gdBusy(btn, true);
  const r = await api('POST', `/api/datahub-images/images/${encodeURIComponent(id)}/reject`);
  if (r && r.ok === false) {
    gdBusy(btn, false);
    toast(`Reject failed: ${r.error || 'hub unreachable'}`);
    return;
  }
  toast(`${id} rejected`);
  softRender();
}

/* ===================== GUIDE QUEUE ===================== */
// Idea -> drafted -> ready -> released pipeline (tools/guide-queue). Same
// per-site board shape as Tasks (reuses .board/.col/.col-head/.col-body css),
// plus a preview modal (rendered body + hero/card images) and a per-site
// cadence/ideas-min config editor (ops/tracked.yaml's manual: block).

const GUIDE_COLS = ['ideas', 'drafted', 'ready', 'released', 'rejected'];
const GUIDE_COL_LABEL = {
  ideas: 'Ideas',
  drafted: 'Drafted',
  ready: 'Ready',
  released: 'Released',
  rejected: 'Rejected',
};
let GUIDE = { site: null, data: null, config: null };

async function renderGuides() {
  const app = $('#app');
  if (!GUIDE.site) GUIDE.site = STATE.taskSite || STATE.sites[0] || null;
  const opts = STATE.sites
    .map(s => `<option value="${esc(s)}" ${s === GUIDE.site ? 'selected' : ''}>${esc(s)}</option>`)
    .join('');
  app.innerHTML = `
    <div class="page-head guide-page-head">
      <div>
        <h2 class="page-title">Guides</h2>
        <span class="muted">Move editorial ideas from brief to release with one site-aware production board.</span>
      </div>
    </div>
    <div class="task-toolbar guide-toolbar" role="group" aria-label="Guide queue controls">
      <label class="guide-site-control">Site<select id="guide-site" aria-label="Guide site">${opts}</select></label>
      <div id="guide-config" class="guide-config" aria-live="polite"></div>
      <button type="button" class="btn primary sm guide-new-btn" id="new-idea">+ New Idea</button>
    </div>
    <div id="guide-content" aria-live="polite" aria-busy="true"><div class="loading" role="status">Loading guide queue…</div></div>`;
  $('#guide-site').addEventListener('change', e => {
    GUIDE.site = e.target.value;
    loadGuideBoard();
  });
  $('#new-idea').addEventListener('click', () => openGuideIdeaModal());
  await loadGuideBoard();
}

async function loadGuideBoard() {
  const content = $('#guide-content'),
    cfgEl = $('#guide-config');
  content.setAttribute('aria-busy', 'true');
  if (!GUIDE.site) {
    content.innerHTML = '<div class="empty">No sites found.</div>';
    content.setAttribute('aria-busy', 'false');
    return;
  }
  let data, config;
  try {
    [data, config] = await Promise.all([
      api('GET', `/api/guide-queue/${encodeURIComponent(GUIDE.site)}`),
      api('GET', `/api/guide-queue/${encodeURIComponent(GUIDE.site)}/config`),
    ]);
  } catch (e) {
    renderViewError(content, e.message);
    content.setAttribute('aria-busy', 'false');
    return;
  }
  GUIDE.data = data;
  GUIDE.config = config;

  cfgEl.innerHTML = `<span class="guide-config-label">Cadence</span><label><input id="cfg-cadence" type="number" min="1" value="${esc(config.guide_cadence_days)}" aria-label="Guide cadence in days" /> days</label>
    <span class="guide-config-separator">·</span><span class="guide-config-label">Ideas minimum</span><label><input id="cfg-ideasmin" type="number" min="1" value="${esc(config.guide_ideas_min)}" aria-label="Minimum guide ideas" /></label>`;
  $('#cfg-cadence').addEventListener('change', e =>
    setGuideConfig('guide_cadence_days', e.target.value)
  );
  $('#cfg-ideasmin').addEventListener('change', e =>
    setGuideConfig('guide_ideas_min', e.target.value)
  );

  const summary = `<section class="guide-summary" aria-label="Guide queue summary">${GUIDE_COLS.map(
    col => {
      const count = (data[col] || []).length;
      return `<div class="guide-stat"><strong>${count}</strong><span>${GUIDE_COL_LABEL[col]}</span></div>`;
    }
  ).join('')}</section>`;
  content.innerHTML = `${summary}<div class="board">${GUIDE_COLS.map(col => {
    const items = data[col] || [];
    const cards = items.length
      ? items.map(it => guideCard(it)).join('')
      : '<div class="empty" style="padding:20px;font-size:12px">empty</div>';
    return `<div class="col"><div class="col-head"><h3>${GUIDE_COL_LABEL[col]}</h3><span class="count">${items.length}</span></div><div class="col-body">${cards}</div></div>`;
  }).join('')}</div>`;
  content.setAttribute('aria-busy', 'false');
  $$('.guide-card').forEach(el =>
    el.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      openGuideModal(el.dataset.status, el.dataset.file);
    })
  );
  $$('.guide-card').forEach(el =>
    el.addEventListener('keydown', e => {
      if (e.target.closest('button') || !['Enter', ' '].includes(e.key)) return;
      e.preventDefault();
      openGuideModal(el.dataset.status, el.dataset.file);
    })
  );
  $$('[data-guide-action]').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const { guideAction: action, status, file } = btn.dataset;
      moveGuide(status, file, action);
    })
  );
}

async function setGuideConfig(field, value) {
  try {
    GUIDE.config = await api(
      'PUT',
      `/api/guide-queue/${encodeURIComponent(GUIDE.site)}/config/${field}`,
      { value }
    );
    toast('cadence config saved');
  } catch (e) {
    toast(e.message, 'err');
  }
}

function guideCard(it) {
  const cat = it.category ? `<span class="badge b-gray">${esc(it.category)}</span>` : '';
  const src = it.source === 'ai' ? '<span class="badge b-blue">ai</span>' : '';
  const imgTag = it.hasImages ? '<span title="has images">🖼️</span>' : '';
  let actions = '';
  if (it.status === 'drafted') {
    actions = `<button class="btn sm primary" data-guide-action="accept" data-status="${esc(it.status)}" data-file="${esc(it.file)}">Accept</button>
      <button class="btn sm danger" data-guide-action="reject" data-status="${esc(it.status)}" data-file="${esc(it.file)}">Reject</button>`;
  } else if (it.status === 'ready') {
    actions = `<button class="btn sm danger" data-guide-action="reject" data-status="${esc(it.status)}" data-file="${esc(it.file)}">Reject</button>`;
  }
  return `<div class="task guide-card" role="button" tabindex="0" aria-label="Open guide ${esc(it.title)}" data-status="${esc(it.status)}" data-file="${esc(it.file)}">
    <div class="t-title">${esc(it.title)} ${imgTag}</div>
    <div class="t-meta">${cat}${src}</div>
    ${it.excerpt ? `<div class="t-excerpt">${esc(it.excerpt)}</div>` : ''}
    ${it.created ? `<div class="t-date">🕓 ${esc(it.created)}</div>` : ''}
    ${actions ? `<div class="modal-foot" style="margin-top:6px">${actions}</div>` : ''}
  </div>`;
}

async function moveGuide(status, file, action) {
  const to = action === 'accept' ? 'ready' : 'rejected';
  try {
    await api(
      'POST',
      `/api/guide-queue/${encodeURIComponent(GUIDE.site)}/${status}/${encodeURIComponent(file)}/move`,
      { to }
    );
    toast(action === 'accept' ? 'moved to ready' : 'rejected');
    loadGuideBoard();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function openGuideModal(status, file) {
  const modal = $('#modal'),
    title = $('#modal-title'),
    bodyEl = $('#modal-body');
  let item;
  try {
    item = await api(
      'GET',
      `/api/guide-queue/${encodeURIComponent(GUIDE.site)}/${status}/${encodeURIComponent(file)}`
    );
  } catch (e) {
    toast(e.message, 'err');
    return;
  }
  const m = item.meta;
  title.textContent = `${m.title || file} · ${GUIDE.site}`;
  const images = [
    item.images.hero
      ? `<img src="${item.images.hero}" alt="hero" style="max-width:100%;border-radius:6px;margin-bottom:8px" />`
      : '',
    item.images.card
      ? `<img src="${item.images.card}" alt="card" style="max-width:240px;border-radius:6px" />`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  const fields = ['category', 'description', 'author', 'updated', 'published']
    .filter(k => m[k])
    .map(k => `<div class="field"><label>${k}</label><div>${esc(String(m[k]))}</div></div>`)
    .join('');
  bodyEl.innerHTML = `
    ${images ? `<div class="field">${images}</div>` : ''}
    ${m.brief ? `<div class="field"><label>Brief</label><div class="muted">${esc(m.brief)}</div></div>` : ''}
    ${fields}
    <div class="field"><label>Body</label><div style="white-space:pre-wrap;max-height:50vh;overflow:auto;font-size:13px;line-height:1.5">${esc(item.body || '(no body yet)')}</div></div>
    <div class="field"><label>Notes</label><textarea id="f-guide-notes" rows="3">${esc(m.notes || '')}</textarea></div>
    <div class="modal-foot">
      ${status === 'drafted' ? '<button class="btn primary" id="f-guide-accept">Accept → Ready</button><button class="btn danger" id="f-guide-reject">Reject</button>' : ''}
      ${status === 'ready' ? '<button class="btn danger" id="f-guide-reject">Reject</button>' : ''}
      <button class="btn" id="f-guide-save-notes">Save Notes</button>
      <button class="btn" id="f-guide-cancel">Close</button>
    </div>`;
  modal.classList.remove('hidden');
  $('#f-guide-cancel').onclick = closeModal;
  $('#f-guide-save-notes').onclick = async () => {
    try {
      await api(
        'PUT',
        `/api/guide-queue/${encodeURIComponent(GUIDE.site)}/${status}/${encodeURIComponent(file)}`,
        { notes: $('#f-guide-notes').value }
      );
      toast('notes saved');
      closeModal(true);
      loadGuideBoard();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  const acceptBtn = $('#f-guide-accept');
  if (acceptBtn)
    acceptBtn.onclick = async () => {
      if (!closeModal()) return;
      await moveGuide(status, file, 'accept');
    };
  const rejectBtn = $('#f-guide-reject');
  if (rejectBtn)
    rejectBtn.onclick = async () => {
      if (!closeModal()) return;
      await moveGuide(status, file, 'reject');
    };
}

function openGuideIdeaModal() {
  const modal = $('#modal'),
    title = $('#modal-title'),
    bodyEl = $('#modal-body');
  title.textContent = `New guide idea · ${GUIDE.site}`;
  bodyEl.innerHTML = `
    <div class="field"><label>Title</label><input id="f-idea-title" placeholder="Short guide title" /></div>
    <div class="field"><label>Category</label><input id="f-idea-category" placeholder="e.g. placement, aftercare, first-tattoo" /></div>
    <div class="field"><label>Brief</label><textarea id="f-idea-brief" rows="5" placeholder="One-paragraph editorial angle for the writer"></textarea></div>
    <div class="modal-foot">
      <button class="btn" id="f-idea-cancel">Cancel</button>
      <button class="btn primary" id="f-idea-save">Add Idea</button>
    </div>`;
  modal.classList.remove('hidden');
  $('#f-idea-cancel').onclick = closeModal;
  $('#f-idea-save').onclick = async () => {
    const title2 = $('#f-idea-title').value.trim();
    if (!title2) {
      toast('title required', 'err');
      return;
    }
    try {
      await api('POST', `/api/guide-queue/${encodeURIComponent(GUIDE.site)}/ideas`, {
        title: title2,
        category: $('#f-idea-category').value.trim(),
        brief: $('#f-idea-brief').value.trim(),
        source: 'human',
      });
      toast('idea added');
      closeModal(true);
      loadGuideBoard();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
}

/* ===================== DOMAINS ===================== */
// Onboard / offboard a domain. This view is a *remote control* for
// tools/scripts/domain-manager-cli.sh — it never reimplements a step of the
// flow. POST /api/domains/jobs spools a job; the host runner
// (tools/scripts/domain-job-runner.sh) executes the CLI and streams its output
// into a log file this view tails.

const DOM = {
  openJob: null, // job id whose log is expanded
  form: { command: 'add', domain: '', flags: new Set(['--full']) },
};

function domJobBadge(status) {
  const map = {
    queued: 'b-gray',
    running: 'b-yellow',
    done: 'b-green',
    failed: 'b-red',
    cancelled: 'b-gray',
  };
  return `<span class="badge ${map[status] || 'b-gray'}">${esc(status)}</span>`;
}

async function renderDomains() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading domains…</div></div>';
  let d;
  try {
    d = await api('GET', '/api/domains');
  } catch (e) {
    renderViewError(app, `Domains failed: ${e.message}`);
    return;
  }
  DOM.commands = d.commands || [];

  const spec = DOM.commands.find(c => c.name === DOM.form.command) || { flags: [] };
  // Flags are per-command; drop any carried over from a previous selection.
  DOM.form.flags = new Set([...DOM.form.flags].filter(f => spec.flags.includes(f)));

  const r = d.runner || {};
  const runnerNote = !r.installed
    ? `<div class="empty">Host runner missing: <span class="mono">tools/scripts/domain-job-runner.sh</span> is not present. Jobs will queue and never run.</div>`
    : !r.alive
      ? `<div class="empty">Host runner has not checked in${r.lastTick ? ` for ${esc(fmtAge(r.ageSeconds))}` : ' yet'}. Jobs will sit in <em>queued</em> until it runs. Install the cron: <span class="mono">* * * * * ${esc(r.command)}</span></div>`
      : '';

  const cmdOpts = DOM.commands
    .map(
      c =>
        `<option value="${esc(c.name)}"${c.name === DOM.form.command ? ' selected' : ''}>${esc(c.label)} (${esc(c.name)})</option>`
    )
    .join('');

  const flagBoxes = spec.flags.length
    ? spec.flags
        .map(
          f =>
            `<label class="dom-flag"><input type="checkbox" class="dom-flag-box" value="${esc(f)}"${DOM.form.flags.has(f) ? ' checked' : ''}> <span class="mono">${esc(f)}</span></label>`
        )
        .join('')
    : '<span class="muted">no flags for this command</span>';

  const jobs = d.jobs || [];
  const activeJobs = jobs.filter(j => ['queued', 'running'].includes(j.status)).length;
  const failedJobs = jobs.filter(j => j.status === 'failed').length;
  const runnerStatus = !r.installed ? 'missing' : !r.alive ? 'stale' : 'ready';
  const runnerLabel =
    runnerStatus === 'ready' ? 'Ready' : runnerStatus === 'stale' ? 'Stale' : 'Missing';
  const jobRows = jobs
    .map(j => {
      const open = DOM.openJob === j.id;
      const dur =
        j.startedAt && j.finishedAt
          ? fmtAge((new Date(j.finishedAt) - new Date(j.startedAt)) / 1000)
          : j.startedAt
            ? fmtAge((Date.now() - new Date(j.startedAt)) / 1000) + '…'
            : '—';
      const detailId = `dom-detail-${j.id}`;
      return `<tr data-fleet-row data-site="${esc(j.domain)}">
        <td class="site"><button type="button" class="table-link dom-open" data-id="${esc(j.id)}" aria-expanded="${open ? 'true' : 'false'}" aria-controls="${esc(detailId)}" aria-label="${open ? 'Close' : 'Open'} ${esc(j.command)} job details for ${esc(j.domain)}" title="${open ? 'Close' : 'Open'} job details">${esc(j.domain)}</button></td>
        <td class="mono">${esc(j.command)}${j.flags && j.flags.length ? ` <span class="muted">${esc(j.flags.join(' '))}</span>` : ''}</td>
        <td>${domJobBadge(j.status)}${j.status === 'running' ? ' <span class="live-tag">live</span>' : ''}</td>
        <td class="mono muted">${esc(dur)}</td>
        <td class="mono muted">${j.exitCode === null || j.exitCode === undefined ? '—' : esc(String(j.exitCode))}</td>
        <td>${j.status === 'queued' ? `<button type="button" class="btn sm dom-cancel" data-id="${esc(j.id)}" aria-label="Cancel queued ${esc(j.command)} job for ${esc(j.domain)}" title="Cancel queued job">Cancel</button>` : ''}</td>
      </tr>
      <tr id="${esc(detailId)}" class="cn-detail-row${open ? '' : ' hidden'}" data-detail="dom:${esc(j.id)}" data-rk="dom:${esc(j.id)}"><td colspan="6">
        <div class="cn-log-head">${esc(j.id)}${j.error ? ` — <span class="b-red">${esc(j.error)}</span>` : ''}</div>
        <pre class="cn-logs-box${open ? ' async-loading' : ''}" data-rkh="domlog:${esc(j.id)}" data-domlog="${esc(j.id)}">${open ? 'Loading…' : ''}</pre>
      </td></tr>`;
    })
    .join('');

  const siteRows = (d.sites || [])
    .map(
      s => `<tr data-fleet-row data-site="${esc(s.slug)}">
      <td class="site">${siteLink(s.slug)}</td>
      <td>
        <button type="button" class="btn sm dom-quick" data-cmd="status" data-domain="${esc(s.slug)}" aria-label="Check status for ${esc(s.slug)}" title="Check status">Status</button>
        <button type="button" class="btn sm dom-quick" data-cmd="repair" data-domain="${esc(s.slug)}" aria-label="Repair ${esc(s.slug)}" title="Repair domain">Repair</button>
        <button type="button" class="btn sm danger dom-offboard" data-domain="${esc(s.slug)}" aria-label="Offboard ${esc(s.slug)}" title="Offboard domain">Offboard…</button>
      </td>
    </tr>`
    )
    .join('');

  app.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">Domains</h2><span class="muted">onboard / offboard — remote control for <span class="mono">tools/scripts/domain-manager-cli.sh</span></span></div><button type="button" class="btn" id="domains-refresh">↻ Refresh</button></div>
    <section class="dom-summary" aria-label="Domain operations summary">
      <div class="dom-stat"><strong>${(d.sites || []).length}</strong><span>Onboarded sites</span></div>
      <div class="dom-stat"><strong>${jobs.length}</strong><span>Recent jobs</span></div>
      <div class="dom-stat ${activeJobs ? 'dom-stat-warn' : ''}"><strong>${activeJobs}</strong><span>Queued or running</span></div>
      <div class="dom-stat ${failedJobs ? 'dom-stat-bad' : 'dom-stat-good'}"><strong>${failedJobs}</strong><span>Failed jobs</span></div>
      <div class="dom-stat dom-stat-meta"><strong>${runnerLabel}</strong><span>Host runner</span></div>
    </section>
    ${runnerNote}
    <section class="card dom-panel dom-command-panel">
      <div class="dom-panel-head"><div><h3>Queue a domain command</h3><p class="muted">Commands run through the host runner and stream their output into the job history.</p></div><span class="badge ${runnerStatus === 'ready' ? 'b-green' : runnerStatus === 'stale' ? 'b-yellow' : 'b-red'}">Runner ${runnerLabel}</span></div>
      <div class="dom-command-form" role="group" aria-label="Queue domain command">
        <label class="dom-field">Command<select id="dom-cmd" aria-label="Domain command">${cmdOpts}</select></label>
        <label class="dom-field dom-domain-field">Domain<input id="dom-domain" type="text" placeholder="example.com" spellcheck="false" value="${esc(DOM.form.domain)}" autocomplete="off"></label>
        <button class="btn primary dom-queue-btn" id="dom-run" type="button">Queue command</button>
      </div>
      <div class="dom-flags" id="dom-flags"><span class="dom-flags-label">Optional flags</span>${flagBoxes}</div>
      <details class="dom-help"><summary>Command safety and scope</summary><p>Onboard runs bootstrap → deploy → bind (<span class="mono">--full</span> does all three in one shot). Offboard archives the GitHub repo, detaches apex + www, deletes the Worker, drops the email rules, and removes the submodule. Offboard always requires typing the exact domain before queueing.</p></details>
    </section>

    <section class="card dom-panel">
      <div class="dom-panel-head"><div><h3>Job history</h3><p class="muted">Open a domain to inspect its live or completed command output.</p></div><span class="muted">${jobs.length} recent</span></div>
      <div class="matrix-scroll-hint" role="note">Swipe horizontally to inspect command status and actions</div><div class="table-wrap" tabindex="0" role="region" aria-label="Domain command job history"><table>
        <caption class="sr-only">Domain command job history</caption>
        <thead><tr><th>Domain</th><th>Command</th><th>Status</th><th>Duration</th><th>Exit</th><th>Actions</th></tr></thead>
        <tbody>${jobRows || '<tr><td colspan="6" class="muted">No domain jobs have run on this host yet.</td></tr>'}</tbody>
      </table></div>
    </section>

    <section class="card dom-panel">
      <div class="dom-panel-head"><div><h3>Onboarded sites</h3><p class="muted">Quick status, repair, and offboarding actions for checked-out domains.</p></div><span class="muted">${(d.sites || []).length} sites</span></div>
      <div class="matrix-scroll-hint" role="note">Swipe horizontally to review onboarded domains and available actions</div><div class="table-wrap" tabindex="0" role="region" aria-label="Onboarded domains and available actions"><table>
        <caption class="sr-only">Onboarded domains and available actions</caption>
        <thead><tr><th>Site</th><th>Actions</th></tr></thead>
        <tbody>${siteRows || '<tr><td colspan="2" class="muted">No sites checked out.</td></tr>'}</tbody>
      </table></div>
    </section>`;

  $('#domains-refresh').addEventListener('click', () => renderDomains());
  wireDomains();
  if (DOM.openJob) domLoadLog(DOM.openJob);
  // A running job's log grows; keep the view (and any open log) current.
  if (jobs.some(j => j.status === 'running' || j.status === 'queued'))
    setTimeout(() => {
      if (STATE.view === 'domains') softRender();
    }, 4000);
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

function wireDomains() {
  const cmd = $('#dom-cmd');
  if (cmd)
    cmd.addEventListener('change', () => {
      DOM.form.command = cmd.value;
      DOM.form.domain = ($('#dom-domain') || {}).value || '';
      // Sensible default: the one-shot path is what onboarding almost always wants.
      DOM.form.flags = new Set(DOM.form.command === 'add' ? ['--full'] : []);
      softRender();
    });

  const dom = $('#dom-domain');
  if (dom) dom.addEventListener('input', () => (DOM.form.domain = dom.value));

  $$('.dom-flag-box').forEach(b =>
    b.addEventListener('change', () => {
      if (b.checked) DOM.form.flags.add(b.value);
      else DOM.form.flags.delete(b.value);
    })
  );

  const run = $('#dom-run');
  if (run)
    run.addEventListener('click', () =>
      domQueue(run, DOM.form.command, ($('#dom-domain') || {}).value || '', [...DOM.form.flags])
    );

  $$('.dom-quick').forEach(b =>
    b.addEventListener('click', () => domQueue(b, b.dataset.cmd, b.dataset.domain, []))
  );
  $$('.dom-offboard').forEach(b =>
    b.addEventListener('click', () => domOffboard(b.dataset.domain))
  );
  $$('.dom-cancel').forEach(b => b.addEventListener('click', () => domCancel(b, b.dataset.id)));
  $$('.dom-open').forEach(a =>
    a.addEventListener('click', e => {
      e.preventDefault();
      domToggleJob(a.dataset.id);
    })
  );
}

// Offboard is the one irreversible action in this tab, so it costs a typed
// confirmation — not a yes/no anyone can click through by reflex.
async function domOffboard(domain) {
  const typed = await globalThis.fleetTextPrompt?.({
    title: `Offboard ${domain}`,
    label: `Type the exact domain to confirm. This archives the GitHub repo, detaches apex + www from the Worker, deletes the Worker script, removes the CF email rules, and drops the local submodule.`,
    placeholder: domain,
    required: true,
    submitLabel: 'Offboard domain',
  });
  if (typed === null) return;
  if (typed.trim().toLowerCase() !== domain.toLowerCase()) {
    toast('Confirmation did not match — nothing queued', 'err');
    return;
  }
  domQueue(null, 'remove', domain, []);
}

async function domQueue(btn, command, domain, flags) {
  if (!domain.trim()) {
    toast('domain required', 'err');
    return;
  }
  if (btn) gdBusy(btn, true);
  try {
    const job = await api('POST', '/api/domains/jobs', {
      command,
      domain: domain.trim(),
      flags,
    });
    DOM.openJob = job.id;
    DOM.form.domain = '';
    toast(`${command} ${job.domain} queued`);
    softRender();
  } catch (e) {
    if (btn) gdBusy(btn, false);
    toast(e.message, 'err');
  }
}

async function domCancel(btn, id) {
  gdBusy(btn, true);
  try {
    await api('POST', `/api/domains/jobs/${encodeURIComponent(id)}/cancel`);
    toast('Job cancelled');
    softRender();
  } catch (e) {
    gdBusy(btn, false);
    toast(e.message, 'err');
  }
}

function domToggleJob(id) {
  const row = $(`tr[data-detail="dom:${CSS.escape(id)}"]`);
  const trigger = $(`.dom-open[data-id="${CSS.escape(id)}"]`);
  if (!row) return;
  if (DOM.openJob === id) {
    DOM.openJob = null;
    row.classList.add('hidden');
    trigger?.setAttribute('aria-expanded', 'false');
    trigger?.setAttribute(
      'aria-label',
      trigger.getAttribute('aria-label')?.replace(/^Close /, 'Open ') || 'Open job details'
    );
    return;
  }
  DOM.openJob = id;
  row.classList.remove('hidden');
  trigger?.setAttribute('aria-expanded', 'true');
  trigger?.setAttribute(
    'aria-label',
    trigger.getAttribute('aria-label')?.replace(/^Open /, 'Close ') || 'Close job details'
  );
  domLoadLog(id);
}

async function domLoadLog(id) {
  const pre = $(`pre[data-domlog="${CSS.escape(id)}"]`);
  if (!pre) return;
  pre.classList.add('async-loading');
  pre.textContent = 'Loading…';
  try {
    const d = await api('GET', `/api/domains/jobs/${encodeURIComponent(id)}`);
    pre.classList.remove('async-loading');
    const pinned = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
    pre.textContent =
      (d.truncated ? '… (earlier output truncated)\n' : '') +
      (d.log || '(no output yet — waiting for the host runner to pick this job up)');
    if (pinned) pre.scrollTop = pre.scrollHeight;
  } catch (e) {
    pre.classList.remove('async-loading');
    pre.textContent = `log unavailable: ${e.message}`;
  }
}

/* ===================== SOCIAL ===================== */
// The fleet social registry — replaces the hand-maintained
// tools/social-setup/FLEET_SOCIAL_MAP.md. Three lenses over the same data:
//   matrix   site x platform grid (the shape the markdown table had)
//   list     flat, searchable/sortable/groupable account rows
//   personas the named-byline roster and its per-platform coverage
// Sites come from live discovery unioned with the registry, so a newly
// onboarded site appears here with zero registry edits.
const SOC = {
  data: null,
  mode: 'matrix',
  q: '',
  group: 'site',
  sort: {
    matrix: { key: 'site', dir: 1 },
    list: { key: 'site', dir: 1 },
  },
  f: { platform: '', status: '', scope: '', category: '', attention: false },
  // The matrix and flat list each keep their own column filters. Toolbar
  // filters apply to every lens; column filters are deliberately scoped to
  // the table where they are visible.
  matrixFilters: { site: '', personas: '', platforms: {} },
  listFilters: {
    site: '',
    who: '',
    email: '',
    platform: '',
    handle: '',
    status: '',
    credsInVault: '',
    updatedAt: '',
    statusNote: '',
  },
  open: new Set(), // sites expanded to show persona rows in matrix mode
};

const SOC_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const socStatus = k =>
  (SOC.data.statuses || []).find(s => s.key === k) || { label: k, tone: 'gray' };
const socPlatform = k => (SOC.data.platforms || []).find(p => p.key === k) || { label: k };
const socToneBadge = (tone, txt) =>
  `<span class="badge b-${{ green: 'green', yellow: 'yellow', orange: 'yellow', red: 'red', blue: 'blue', gray: 'gray' }[tone] || 'gray'}">${esc(txt)}</span>`;

// Worst status wins when several accounts collapse into one cell.
const TONE_RANK = { red: 5, orange: 4, yellow: 3, blue: 2, green: 1, gray: 0 };
function worstTone(list) {
  return list.reduce((w, a) => (TONE_RANK[a.tone] > TONE_RANK[w] ? a.tone : w), 'gray');
}

function socAccountsFor(site, platform, scope) {
  return SOC.data.accounts.filter(
    a => a.site === site && a.platform === platform && (!scope || a.scope === scope)
  );
}

function socNorm(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

// Search is word-based instead of treating the whole input as one exact
// substring. Quoted phrases stay together and a leading minus excludes a
// term: `america bluesky -blocked`.
function socQueryTerms(query) {
  return (String(query || '').match(/-?"[^"]+"|-?\S+/g) || [])
    .map(raw => {
      const exclude = raw.startsWith('-') && raw.length > 1;
      let value = exclude ? raw.slice(1) : raw;
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      return { exclude, value: socNorm(value) };
    })
    .filter(term => term.value);
}

function socTextMatch(values, query) {
  const terms = socQueryTerms(query);
  if (!terms.length) return true;
  const haystack = socNorm(values.filter(v => v !== null && v !== undefined).join(' '));
  return terms.every(term =>
    term.exclude ? !haystack.includes(term.value) : haystack.includes(term.value)
  );
}

function socSiteCategory(site) {
  return (SOC.data.sites.find(s => s.site === site) || {}).category || 'active';
}

function socAccountSearchValues(a) {
  const status = socStatus(a.status);
  return [
    a.site,
    socSiteCategory(a.site),
    a.platform,
    socPlatform(a.platform).label,
    a.scope,
    a.personaName || 'brand',
    a.email,
    a.handle,
    a.status,
    status.label,
    status.describe,
    a.action,
    a.statusNote,
    a.notes,
    (a.tags || []).join(' '),
    a.credsInVault ? 'vault credentials' : 'no vault credentials',
    a.updatedAt,
  ];
}

// Does this account survive the shared toolbar filters? Search is handled
// separately so matrix rows can search across the complete site record.
function socAccountFilterMatch(a) {
  const f = SOC.f;
  if (f.platform && a.platform !== f.platform) return false;
  if (f.status && a.status !== f.status) return false;
  if (f.scope && a.scope !== f.scope) return false;
  if (f.attention && !a.needsAttention) return false;
  if (f.category && socSiteCategory(a.site) !== f.category) return false;
  return true;
}

function socMatch(a) {
  return socAccountFilterMatch(a) && socTextMatch(socAccountSearchValues(a), SOC.q);
}

function socMatrixPlatformMatch(site, platform, wanted) {
  if (!wanted) return true;
  const rows = socAccountsFor(site, platform, 'brand');
  if (wanted === '__missing') return !rows.length;
  if (wanted === '__present') return rows.length > 0;
  if (wanted === '__live') return rows.some(a => a.live);
  if (wanted === '__attention') return rows.some(a => a.needsAttention);
  return rows.some(a => a.status === wanted);
}

function socSiteSearchValues(s) {
  const accounts = SOC.data.accounts.filter(a => a.site === s.site);
  const personas = SOC.data.personas.filter(p => p.site === s.site);
  return [
    s.site,
    s.category || 'active',
    s.note,
    ...accounts.flatMap(socAccountSearchValues),
    ...personas.flatMap(p => [p.name, p.email, p.beat, p.notes]),
  ];
}

function socMatrixSites() {
  const accountFiltersActive = Boolean(SOC.f.status || SOC.f.scope || SOC.f.attention);
  return SOC.data.sites.filter(s => {
    if (SOC.f.category && (s.category || 'active') !== SOC.f.category) return false;
    if (!socTextMatch([s.site], SOC.matrixFilters.site)) return false;
    if (!socTextMatch(socSiteSearchValues(s), SOC.q)) return false;

    const personas = SOC.data.personas.filter(p => p.site === s.site);
    if (SOC.matrixFilters.personas === 'with' && !personas.length) return false;
    if (SOC.matrixFilters.personas === 'without' && personas.length) return false;

    if (accountFiltersActive) {
      const matches = SOC.data.accounts.some(a => a.site === s.site && socAccountFilterMatch(a));
      if (!matches) return false;
    }

    return Object.entries(SOC.matrixFilters.platforms)
      .filter(([platform]) => !SOC.f.platform || SOC.f.platform === platform)
      .every(([platform, wanted]) => socMatrixPlatformMatch(s.site, platform, wanted));
  });
}

function socListColumnMatch(a) {
  const f = SOC.listFilters;
  if (!socTextMatch([a.site], f.site)) return false;
  if (!socTextMatch([a.personaName || 'brand', a.scope], f.who)) return false;
  if (!socTextMatch([a.email], f.email)) return false;
  if (f.platform && a.platform !== f.platform) return false;
  if (!socTextMatch([a.handle, a.profileUrl], f.handle)) return false;
  if (f.status && a.status !== f.status) return false;
  if (f.credsInVault && String(a.credsInVault) !== f.credsInVault) return false;
  if (!socTextMatch([(a.updatedAt || '').slice(0, 10)], f.updatedAt)) return false;
  if (!socTextMatch([a.statusNote, a.notes, a.action], f.statusNote)) return false;
  return true;
}

function socListRows() {
  return SOC.data.accounts.filter(a => socMatch(a) && socListColumnMatch(a));
}

function socActiveFilterCount() {
  let count = SOC.q.trim() ? 1 : 0;
  count += Object.entries(SOC.f).filter(([, value]) => Boolean(value)).length;
  if (SOC.mode === 'matrix') {
    if (SOC.matrixFilters.site) count += 1;
    if (SOC.matrixFilters.personas) count += 1;
    count += Object.entries(SOC.matrixFilters.platforms).filter(
      ([platform, value]) => value && (!SOC.f.platform || SOC.f.platform === platform)
    ).length;
  } else if (SOC.mode === 'list') {
    count += Object.values(SOC.listFilters).filter(Boolean).length;
  }
  return count;
}

function socResetFilters() {
  SOC.q = '';
  SOC.f = { platform: '', status: '', scope: '', category: '', attention: false };
  SOC.matrixFilters = { site: '', personas: '', platforms: {} };
  for (const key of Object.keys(SOC.listFilters)) SOC.listFilters[key] = '';
}

async function renderSocial() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading social registry…</div></div>';
  let data;
  try {
    data = await api('GET', '/api/social');
  } catch (e) {
    renderViewError(app, `Social account registry failed: ${e.message}`);
    return;
  }
  SOC.data = data;
  const s = data.summary;

  // Soft refresh (polling tick, not a real nav/mode change): the toolbar/filter
  // skeleton is already in the DOM and untouched by fetched data, so just
  // refresh the stats text and body instead of blowing away every input —
  // that was causing focus loss / flicker on every 15s tick.
  const existingBody = $('#soc-body');
  if (!FRESH && existingBody && STATE.view === 'social') {
    const statsEl = $('.page-head .soc-stats');
    if (statsEl) {
      statsEl.innerHTML = `
        ${socToneBadge('green', `${s.live} live`)}
        ${s.needsAttention ? socToneBadge('red', `${s.needsAttention} need attention`) : socToneBadge('gray', 'none broken')}`;
    }
    const summaryEl = $('.page-head .muted');
    if (summaryEl)
      summaryEl.textContent = `${s.accounts} accounts · ${s.personas} personas · ${s.eligibleSites} eligible sites`;
    socRenderBody();
    return;
  }

  const opt = (list, cur, blank) =>
    `<option value="">${blank}</option>` +
    list
      .map(
        o =>
          `<option value="${esc(o.key)}" ${o.key === cur ? 'selected' : ''}>${esc(o.label)}</option>`
      )
      .join('');

  app.innerHTML = `
    <div class="page-head">
      <div><h2 class="page-title">Social Accounts</h2><span class="muted">${s.accounts} accounts · ${s.personas} personas · ${s.eligibleSites} eligible sites</span></div>
      <span class="soc-stats">
        ${socToneBadge('green', `${s.live} live`)}
        ${s.needsAttention ? socToneBadge('red', `${s.needsAttention} need attention`) : socToneBadge('gray', 'none broken')}
      </span>
      <button type="button" class="btn" id="social-refresh">↻ Refresh</button>
    </div>
    <div class="task-toolbar soc-toolbar">
      <div class="soc-modes">
        ${['matrix', 'list', 'personas']
          .map(
            m =>
              `<button class="btn sm ${SOC.mode === m ? 'primary' : ''}" data-soc-mode="${m}">${m[0].toUpperCase() + m.slice(1)}</button>`
          )
          .join('')}
      </div>
      <label class="soc-search-wrap">
        <span class="muted">Search</span>
        <input id="soc-q" class="cm-input" type="search" placeholder='Words, "exact phrase", -exclude…' value="${esc(SOC.q)}" autocomplete="off" spellcheck="false" title='Search every field. Separate words may match anywhere; use quotes for a phrase or -word to exclude it.' />
      </label>
      <select id="soc-f-platform" aria-label="Filter by platform">${opt(data.platforms, SOC.f.platform, 'All platforms')}</select>
      <select id="soc-f-status" aria-label="Filter by status">${opt(data.statuses, SOC.f.status, 'All statuses')}</select>
      <select id="soc-f-scope" aria-label="Filter by account scope">${opt(
        [
          { key: 'brand', label: 'Brand' },
          { key: 'persona', label: 'Persona' },
        ],
        SOC.f.scope,
        'Brand + persona'
      )}</select>
      <select id="soc-f-category" aria-label="Filter by site bucket">${opt(data.siteCategories, SOC.f.category, 'All site buckets')}</select>
      <label class="soc-check"><input type="checkbox" id="soc-f-attention" ${SOC.f.attention ? 'checked' : ''} /> needs attention</label>
      ${SOC.mode === 'list' ? `<label class="muted" for="soc-group">Group</label><select id="soc-group">${['site', 'platform', 'status', 'scope', 'none'].map(g => `<option value="${g}" ${SOC.group === g ? 'selected' : ''}>${g}</option>`).join('')}</select>` : ''}
      <span id="soc-visible-count" class="muted soc-visible-count"></span>
      <button class="btn sm soc-clear" id="soc-clear" type="button">Clear filters</button>
      <button class="btn sm primary" id="soc-add" style="margin-left:auto">+ Account</button>
      <button class="btn sm" id="soc-add-persona">+ Persona</button>
    </div>
    <div id="soc-body"></div>`;

  $('#social-refresh').addEventListener('click', () => renderSocial());
  $$('[data-soc-mode]').forEach(b =>
    b.addEventListener('click', () => {
      SOC.mode = b.dataset.socMode;
      FRESH = true;
      renderSocial();
    })
  );
  const qEl = $('#soc-q');
  qEl.addEventListener('input', () => {
    SOC.q = qEl.value;
    socRenderBody();
  });
  const bindFilter = (id, key, isCheck) =>
    $(id).addEventListener('change', e => {
      SOC.f[key] = isCheck ? e.target.checked : e.target.value;
      socRenderBody();
    });
  bindFilter('#soc-f-platform', 'platform');
  bindFilter('#soc-f-status', 'status');
  bindFilter('#soc-f-scope', 'scope');
  bindFilter('#soc-f-category', 'category');
  bindFilter('#soc-f-attention', 'attention', true);
  const gEl = $('#soc-group');
  if (gEl)
    gEl.addEventListener('change', e => {
      SOC.group = e.target.value;
      socRenderBody();
    });
  $('#soc-add').addEventListener('click', () => socAccountModal(null, {}));
  $('#soc-add-persona').addEventListener('click', () => socPersonaModal(null));
  $('#soc-clear').addEventListener('click', () => {
    socResetFilters();
    FRESH = false;
    renderSocial();
  });

  socRenderBody();
  if (!FRESH) applyUISnap();
}

function socRenderBody(preserveFocus = false) {
  const body = $('#soc-body');
  if (!body) return;
  const active = preserveFocus ? document.activeElement : null;
  const focusKey = active && active.dataset ? active.dataset.socFilter : '';
  const selection =
    focusKey && typeof active.selectionStart === 'number'
      ? [active.selectionStart, active.selectionEnd]
      : null;
  if (SOC.mode === 'matrix') body.innerHTML = socMatrixHTML();
  else if (SOC.mode === 'list') body.innerHTML = socListHTML();
  else body.innerHTML = socPersonasHTML();
  socWireBody();
  if (focusKey) {
    const next = $(`[data-soc-filter="${CSS.escape(focusKey)}"]`, body);
    if (next) {
      next.focus();
      if (selection && typeof next.setSelectionRange === 'function') {
        next.setSelectionRange(selection[0], selection[1]);
      }
    }
  }
  const result = $('[data-soc-results]', body);
  const count = $('#soc-visible-count');
  if (count && result) {
    count.textContent = `Showing ${result.dataset.visible} of ${result.dataset.total} ${result.dataset.unit}`;
  }
  const clear = $('#soc-clear');
  if (clear) {
    const activeCount = socActiveFilterCount();
    clear.disabled = !activeCount;
    clear.textContent = activeCount ? `Clear filters (${activeCount})` : 'Clear filters';
  }
}

function socWireBody() {
  $$('[data-soc-cell]').forEach(el =>
    el.addEventListener('click', event => {
      if (event.target.closest('a, button, input, select, label')) return;
      const { site, platform, accountId } = el.dataset;
      if (accountId) socAccountModal(accountId);
      else socAccountModal(null, { site, platform, scope: 'brand' });
    })
  );
  $$('[data-soc-expand]').forEach(el =>
    el.addEventListener('click', () => {
      const site = el.dataset.socExpand;
      if (SOC.open.has(site)) SOC.open.delete(site);
      else SOC.open.add(site);
      socRenderBody();
    })
  );
  $$('[data-soc-sort]').forEach(el =>
    el.addEventListener('click', () => {
      const k = el.dataset.socSort;
      const mode = el.dataset.socSortMode || SOC.mode;
      const sort = SOC.sort[mode];
      if (!sort) return;
      sort.dir = sort.key === k ? -sort.dir : 1;
      sort.key = k;
      socRenderBody();
    })
  );
  $$('[data-soc-filter]').forEach(el => {
    const eventName = el.tagName === 'INPUT' ? 'input' : 'change';
    el.addEventListener(eventName, () => {
      const [area, key, subkey] = el.dataset.socFilter.split(':');
      if (area === 'matrix' && key === 'platform') {
        if (el.value) SOC.matrixFilters.platforms[subkey] = el.value;
        else delete SOC.matrixFilters.platforms[subkey];
      } else if (area === 'matrix') {
        SOC.matrixFilters[key] = el.value;
      } else if (area === 'list') {
        SOC.listFilters[key] = el.value;
      } else if (area === 'global') {
        SOC.f[key] = el.value;
        const toolbar = $(`#soc-f-${CSS.escape(key)}`);
        if (toolbar) toolbar.value = el.value;
      }
      socRenderBody(eventName === 'input');
    });
  });
  $$('[data-soc-persona]').forEach(el =>
    el.addEventListener('click', () => socPersonaModal(el.dataset.socPersona))
  );
  $$('[data-soc-category]').forEach(el =>
    el.addEventListener('change', async () => {
      try {
        await api('PUT', `/api/social/sites/${encodeURIComponent(el.dataset.socCategory)}/meta`, {
          category: el.value,
        });
        toast('site bucket saved');
        FRESH = false;
        renderSocial();
      } catch (e) {
        toast(e.message, 'err');
      }
    })
  );
}

/* ---- matrix ---- */
function socCell(site, platform, scope, personaId) {
  const rows = SOC.data.accounts.filter(
    a =>
      a.site === site &&
      a.platform === platform &&
      a.scope === scope &&
      (personaId === undefined || a.personaId === personaId)
  );
  if (!rows.length) {
    return `<td class="soc-c"><span class="soc-dot t-none" data-soc-cell data-site="${esc(site)}" data-platform="${esc(platform)}" title="not started — click to record one">·</span></td>`;
  }
  const a = rows[0];
  const extra = rows.length > 1 ? `<sup class="soc-n">${rows.length}</sup>` : '';
  const st = socStatus(a.status);
  const tip = [
    `${site} · ${socPlatform(platform).label} · ${a.personaName || 'brand'}`,
    `status: ${st.label}`,
    a.handle ? `handle: ${a.handle}` : '',
    a.statusNote || '',
  ]
    .filter(Boolean)
    .join('\n');
  return `<td class="soc-c"><span class="soc-dot t-${esc(a.tone)}" data-soc-cell data-account-id="${esc(a.id)}" title="${esc(tip)}"></span>${extra}</td>`;
}

function socCompare(a, b, dir = 1) {
  const aEmpty = a === null || a === undefined || a === '';
  const bEmpty = b === null || b === undefined || b === '';
  // Unknown/missing values stay at the bottom in either direction.
  if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
  if (aEmpty) return 0;
  const result =
    typeof a === 'number' && typeof b === 'number'
      ? a - b
      : SOC_COLLATOR.compare(String(a), String(b));
  return result * dir;
}

function socSortHeader(mode, key, label, className = '', title = '') {
  const sort = SOC.sort[mode];
  const active = sort.key === key;
  const direction = active ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none';
  const arrow = active ? (sort.dir > 0 ? '↑' : '↓') : '↕';
  return `<th class="${esc(className)}" aria-sort="${direction}"><button class="soc-sort-button ${active ? 'active' : ''}" type="button" data-soc-sort-mode="${esc(mode)}" data-soc-sort="${esc(key)}" title="${esc(title || `Sort by ${label}`)}"><span>${esc(label)}</span><span class="soc-sort-arrow" aria-hidden="true">${arrow}</span></button></th>`;
}

function socMatrixSortValue(site, key) {
  if (key === 'site') return site.site;
  if (key === 'category') {
    const category = SOC.data.siteCategories.find(c => c.key === (site.category || 'active'));
    return (category || {}).label || site.category || 'active';
  }
  if (key === 'personas') {
    return SOC.data.personas.filter(p => p.site === site.site).length;
  }
  if (key.startsWith('platform:')) {
    const platform = key.slice('platform:'.length);
    const accounts = socAccountsFor(site.site, platform, 'brand');
    return accounts.length ? TONE_RANK[worstTone(accounts)] : null;
  }
  return '';
}

function socMatrixStatusOptions(current) {
  const options = [
    ['', 'Any state'],
    ['__present', 'Has account'],
    ['__missing', 'No record'],
    ['__live', 'Live'],
    ['__attention', 'Needs attention'],
    ...SOC.data.statuses.map(status => [status.key, status.label]),
  ];
  return options
    .map(
      ([value, label]) =>
        `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`
    )
    .join('');
}

function socMatrixHTML() {
  const platforms = SOC.f.platform
    ? SOC.data.platforms.filter(p => p.key === SOC.f.platform)
    : SOC.data.platforms;
  const sites = socMatrixSites();
  const sort = SOC.sort.matrix;
  sites.sort(
    (a, b) =>
      socCompare(socMatrixSortValue(a, sort.key), socMatrixSortValue(b, sort.key), sort.dir) ||
      SOC_COLLATOR.compare(a.site, b.site)
  );
  const cats = SOC.data.siteCategories;
  const rows = sites
    .map(s => {
      const personas = SOC.data.personas.filter(p => p.site === s.site);
      const isOpen = SOC.open.has(s.site);
      const caret = personas.length
        ? `<span class="soc-caret" data-soc-expand="${esc(s.site)}">${isOpen ? '▾' : '▸'}</span>`
        : '<span class="soc-caret soc-caret-off">·</span>';
      const catSel = `<select class="soc-cat" data-soc-category="${esc(s.site)}" aria-label="Social account category for ${esc(s.site)}">${cats
        .map(
          c =>
            `<option value="${esc(c.key)}" ${(s.category || 'active') === c.key ? 'selected' : ''}>${esc(c.label)}</option>`
        )
        .join('')}</select>`;
      const main = `<tr data-fleet-row data-site="${esc(s.site)}">
        <td class="site">${caret}${siteLink(s.site)}${s.onDisk ? '' : '<span class="muted soc-off"> (registry only)</span>'}</td>
        <td>${catSel}</td>
        ${platforms.map(p => socCell(s.site, p.key, 'brand')).join('')}
        <td class="muted">${personas.length ? `${personas.length} persona${personas.length > 1 ? 's' : ''}` : '—'}</td>
      </tr>`;
      if (!isOpen) return main;
      const sub = personas
        .map(
          p => `<tr class="soc-sub" data-fleet-row data-site="${esc(s.site)}">
          <td class="soc-persona-name"><span class="soc-caret soc-caret-off"></span><span class="soc-plink" data-soc-persona="${esc(p.id)}">${esc(p.name)}</span></td>
          <td class="muted">${esc(p.beat || '')}</td>
          ${platforms.map(pl => socCell(s.site, pl.key, 'persona', p.id)).join('')}
          <td class="muted">${p.realPerson ? 'real person' : ''}</td>
        </tr>`
        )
        .join('');
      return main + sub;
    })
    .join('');
  const filterRow = `<tr class="soc-filter-row">
    <th><input class="soc-column-input" type="search" data-soc-filter="matrix:site" value="${esc(SOC.matrixFilters.site)}" placeholder="Filter domain…" aria-label="Filter Site column" autocomplete="off" /></th>
    <th><select class="soc-column-select" data-soc-filter="global:category" aria-label="Filter Bucket column">${
      `<option value="">Any bucket</option>` +
      cats
        .map(
          c =>
            `<option value="${esc(c.key)}" ${SOC.f.category === c.key ? 'selected' : ''}>${esc(c.label)}</option>`
        )
        .join('')
    }</select></th>
    ${platforms
      .map(
        p =>
          `<th class="soc-c"><select class="soc-column-select soc-platform-filter" data-soc-filter="matrix:platform:${esc(p.key)}" aria-label="Filter ${esc(p.label)} column">${socMatrixStatusOptions(SOC.matrixFilters.platforms[p.key] || '')}</select></th>`
      )
      .join('')}
    <th><select class="soc-column-select" data-soc-filter="matrix:personas" aria-label="Filter Personas column">
      <option value="">Any count</option>
      <option value="with" ${SOC.matrixFilters.personas === 'with' ? 'selected' : ''}>Has personas</option>
      <option value="without" ${SOC.matrixFilters.personas === 'without' ? 'selected' : ''}>No personas</option>
    </select></th>
  </tr>`;
  const empty = `<tr><td colspan="${platforms.length + 3}" class="muted soc-empty-row">No domains match the current filters.</td></tr>`;
  return `<div data-soc-results data-visible="${sites.length}" data-total="${SOC.data.sites.length}" data-unit="domains">
    <div class="sh-scroll-hint" role="note">Swipe horizontally to compare platform coverage · Site stays pinned</div>
    <div class="card soc-table-card" tabindex="0" role="region" aria-label="Social account matrix by site and platform"><table class="soc-matrix">
    <caption class="sr-only">Social account matrix by site and platform</caption>
    <thead><tr>
      ${socSortHeader('matrix', 'site', 'Site')}
      ${socSortHeader('matrix', 'category', 'Bucket')}
      ${platforms.map(p => socSortHeader('matrix', `platform:${p.key}`, p.label, 'soc-c', `Sort by ${p.label} account status`)).join('')}
      ${socSortHeader('matrix', 'personas', 'Personas')}
    </tr>${filterRow}</thead>
    <tbody>${rows || empty}</tbody></table></div>
    <div class="muted soc-legend">${SOC.data.statuses
      .map(
        st =>
          `<span class="soc-lg"><span class="soc-dot t-${st.tone}"></span> ${esc(st.label)}</span>`
      )
      .join('')}
      <span class="soc-lg"><span class="soc-dot t-none">·</span> not recorded</span>
      <span>Click a cell to edit; ▸ expands a site's personas.</span></div></div>`;
}

/* ---- list ---- */
const SOC_COLS = [
  { key: 'site', label: 'Site' },
  { key: 'who', label: 'Who' },
  { key: 'email', label: 'Email' },
  { key: 'platform', label: 'Platform' },
  { key: 'handle', label: 'Handle' },
  { key: 'status', label: 'Status' },
  { key: 'credsInVault', label: 'Vault' },
  { key: 'updatedAt', label: 'Updated' },
  { key: 'statusNote', label: 'Note' },
];

function socSortVal(a, key) {
  if (key === 'who') return a.personaName || 'brand';
  if (key === 'platform') return socPlatform(a.platform).label;
  if (key === 'status') return socStatus(a.status).label;
  if (key === 'credsInVault') return a.credsInVault ? 1 : 0;
  return a[key] ?? '';
}

function socListFilterControl(column) {
  const key = column.key;
  const current = SOC.listFilters[key] || '';
  if (key === 'platform') {
    return `<select class="soc-column-select" data-soc-filter="list:platform" aria-label="Filter Platform column"><option value="">Any</option>${SOC.data.platforms.map(p => `<option value="${esc(p.key)}" ${current === p.key ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>`;
  }
  if (key === 'status') {
    return `<select class="soc-column-select" data-soc-filter="list:status" aria-label="Filter Status column"><option value="">Any</option>${SOC.data.statuses.map(s => `<option value="${esc(s.key)}" ${current === s.key ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>`;
  }
  if (key === 'credsInVault') {
    return `<select class="soc-column-select" data-soc-filter="list:credsInVault" aria-label="Filter Vault column">
      <option value="">Any</option>
      <option value="true" ${current === 'true' ? 'selected' : ''}>In vault</option>
      <option value="false" ${current === 'false' ? 'selected' : ''}>Not in vault</option>
    </select>`;
  }
  const placeholders = {
    site: 'Domain…',
    who: 'Brand / persona…',
    email: 'Email…',
    handle: 'Handle…',
    updatedAt: 'YYYY-MM-DD…',
    statusNote: 'Note…',
  };
  return `<input class="soc-column-input" type="search" data-soc-filter="list:${esc(key)}" value="${esc(current)}" placeholder="${esc(placeholders[key] || 'Filter…')}" aria-label="Filter ${esc(column.label)} column" autocomplete="off" />`;
}

function socListHTML() {
  const rows = socListRows();
  const sort = SOC.sort.list;
  rows.sort((x, y) => {
    const a = socSortVal(x, sort.key);
    const b = socSortVal(y, sort.key);
    return (
      socCompare(a, b, sort.dir) ||
      SOC_COLLATOR.compare(x.site, y.site) ||
      SOC_COLLATOR.compare(socPlatform(x.platform).label, socPlatform(y.platform).label) ||
      SOC_COLLATOR.compare(x.personaName || 'brand', y.personaName || 'brand') ||
      SOC_COLLATOR.compare(x.id, y.id)
    );
  });

  const groups = new Map();
  for (const a of rows) {
    const k =
      SOC.group === 'none'
        ? ''
        : SOC.group === 'platform'
          ? socPlatform(a.platform).label
          : SOC.group === 'status'
            ? socStatus(a.status).label
            : SOC.group === 'scope'
              ? a.scope
              : a.site;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }

  const head = `<thead><tr>${SOC_COLS.map(c => socSortHeader('list', c.key, c.label)).join(
    ''
  )}</tr><tr class="soc-filter-row">${SOC_COLS.map(c => `<th>${socListFilterControl(c)}</th>`).join('')}</tr></thead>`;

  const grouped = [...groups.entries()];
  if (SOC.group !== 'none') {
    const groupSortKeys = { site: 'site', platform: 'platform', status: 'status', scope: 'who' };
    grouped.sort((a, b) => {
      if (groupSortKeys[SOC.group] === sort.key) return socCompare(a[0], b[0], sort.dir);
      // Keep grouping without making another column's sort look broken: order
      // groups by their first (already-sorted) row, then sort within the group.
      return (
        socCompare(socSortVal(a[1][0], sort.key), socSortVal(b[1][0], sort.key), sort.dir) ||
        SOC_COLLATOR.compare(a[0], b[0])
      );
    });
  }

  const body = grouped
    .map(([g, list]) => {
      const gh = g
        ? `<tr class="soc-group"><td colspan="${SOC_COLS.length}">${esc(g)}<span class="dd-count">${list.length}</span></td></tr>`
        : '';
      const trs = list
        .map(a => {
          const st = socStatus(a.status);
          const href = safeHref(a.profileUrl);
          const link = href
            ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" class="soc-hl">${esc(a.handle)}<span class="ext">↗</span></a>`
            : esc(a.handle || '—');
          return `<tr class="soc-row" data-fleet-row data-site="${esc(a.site)}" data-soc-cell data-account-id="${esc(a.id)}">
            <td class="site">${esc(a.site)}</td>
            <td>${a.personaName ? esc(a.personaName) : '<span class="muted">brand</span>'}</td>
            <td class="muted soc-email">${esc(a.email || '')}</td>
            <td>${esc(socPlatform(a.platform).label)}</td>
            <td class="soc-handle">${link}</td>
            <td>${socToneBadge(a.tone, st.label)}${a.action ? `<span class="muted soc-act"> ${esc(a.action)}</span>` : ''}</td>
            <td>${a.credsInVault ? '🔑' : '<span class="muted">—</span>'}</td>
            <td class="muted">${esc((a.updatedAt || '').slice(0, 10))}</td>
            <td class="soc-note muted" title="${esc(a.statusNote || '')}">${esc(a.statusNote || '')}</td>
          </tr>`;
        })
        .join('');
      return gh + trs;
    })
    .join('');

  const empty = `<tr><td colspan="${SOC_COLS.length}" class="muted soc-empty-row">No accounts match the current filters.</td></tr>`;
  const sortedLabel = SOC_COLS.find(c => c.key === sort.key)?.label || sort.key;
  return `<div data-soc-results data-visible="${rows.length}" data-total="${SOC.data.accounts.length}" data-unit="accounts">
    <div class="sh-scroll-hint" role="note">Swipe horizontally to inspect profile, status, and account details</div>
    <div class="card soc-table-card" tabindex="0" role="region" aria-label="Social account inventory"><table class="soc-list"><caption class="sr-only">Social account inventory</caption>${head}<tbody>${body || empty}</tbody></table></div>
    <div class="muted soc-legend"><span>Grouped by ${esc(SOC.group)}.</span><span>Sorted by ${esc(sortedLabel)} ${sort.dir > 0 ? 'ascending' : 'descending'}.</span><span>Click a row to edit.</span></div></div>`;
}

/* ---- personas ---- */
function socPersonasHTML() {
  const accountFiltersActive = Boolean(
    SOC.f.platform || SOC.f.status || SOC.f.scope || SOC.f.attention
  );
  const personas = SOC.data.personas.filter(p => {
    if (SOC.f.category && socSiteCategory(p.site) !== SOC.f.category) return false;
    const accounts = SOC.data.accounts.filter(a => a.personaId === p.id);
    if (accountFiltersActive && !accounts.some(socAccountFilterMatch)) return false;
    return socTextMatch(
      [p.site, p.name, p.email, p.beat, p.notes, ...accounts.flatMap(socAccountSearchValues)],
      SOC.q
    );
  });
  const rows = personas
    .map(p => {
      const accts = SOC.data.accounts.filter(a => a.personaId === p.id && socAccountFilterMatch(a));
      const chips = accts.length
        ? accts
            .map(
              a =>
                `<span class="soc-chip" data-soc-cell data-account-id="${esc(a.id)}" title="${esc(a.statusNote || a.status)}"><span class="soc-dot t-${esc(a.tone)}"></span>${esc(socPlatform(a.platform).label)}</span>`
            )
            .join('')
        : '<span class="muted">no accounts</span>';
      return `<tr data-fleet-row data-site="${esc(p.site)}">
        <td class="site">${esc(p.site)}</td>
        <td><span class="soc-plink" data-soc-persona="${esc(p.id)}">${esc(p.name)}</span></td>
        <td class="muted soc-email">${esc(p.email || '')}</td>
        <td class="muted">${esc(p.beat || '')}</td>
        <td>${chips}</td>
        <td>${p.realPerson ? socToneBadge('blue', 'real person') : ''}${p.active ? '' : socToneBadge('gray', 'inactive')}</td>
      </tr>`;
    })
    .join('');
  const empty = `<tr><td colspan="6" class="muted soc-empty-row">${SOC.data.personas.length ? 'No personas match the current filters.' : 'No personas yet. Use + Persona to add a byline.'}</td></tr>`;
  return `<div data-soc-results data-visible="${personas.length}" data-total="${SOC.data.personas.length}" data-unit="personas">
    <div class="sh-scroll-hint" role="note">Swipe horizontally to inspect persona details and platform accounts</div>
    <div class="card soc-table-card" tabindex="0" role="region" aria-label="Social personas and account coverage"><table>
    <caption class="sr-only">Social personas and account coverage</caption>
    <thead><tr><th>Site</th><th>Persona</th><th>Email</th><th>Beat</th><th>Accounts</th><th></th></tr></thead>
    <tbody>${rows || empty}</tbody></table></div>
    <div class="muted soc-legend"><span>Click a name to edit; click a platform chip to edit that account.</span></div></div>`;
}

/* ---- account editor ---- */
async function socAccountModal(accountId, seed = {}) {
  const modal = $('#modal'),
    title = $('#modal-title'),
    bodyEl = $('#modal-body');
  const a = accountId ? SOC.data.accounts.find(x => x.id === accountId) : null;
  const cur = a || {
    site: seed.site || '',
    platform: seed.platform || '',
    scope: seed.scope || 'brand',
    personaId: null,
    status: 'not_started',
    handle: '',
    profileUrl: '',
    statusNote: '',
    notes: '',
    credsInVault: false,
  };
  title.textContent = a
    ? `${a.site} · ${socPlatform(a.platform).label} · ${a.personaName || 'brand'}`
    : 'New social account';

  const siteOpts = SOC.data.sites
    .map(
      s =>
        `<option value="${esc(s.site)}" ${s.site === cur.site ? 'selected' : ''}>${esc(s.site)}</option>`
    )
    .join('');
  const platOpts = SOC.data.platforms
    .map(
      p =>
        `<option value="${esc(p.key)}" ${p.key === cur.platform ? 'selected' : ''}>${esc(p.label)}</option>`
    )
    .join('');
  const statusOpts = SOC.data.statuses
    .map(
      s =>
        `<option value="${esc(s.key)}" ${s.key === cur.status ? 'selected' : ''}>${esc(s.label)}${s.describe ? ` — ${esc(s.describe)}` : ''}</option>`
    )
    .join('');
  const personaOpts =
    '<option value="">— brand account —</option>' +
    SOC.data.personas
      .map(
        p =>
          `<option value="${esc(p.id)}" data-site="${esc(p.site)}" ${p.id === cur.personaId ? 'selected' : ''}>${esc(p.site)} · ${esc(p.name)}</option>`
      )
      .join('');

  bodyEl.innerHTML = `
    <div class="soc-grid">
      <div class="field"><label>Site</label><select id="f-soc-site" ${a ? 'disabled' : ''}>${siteOpts}</select></div>
      <div class="field"><label>Platform</label><select id="f-soc-platform" ${a ? 'disabled' : ''}>${platOpts}</select></div>
    </div>
    <div class="field"><label>Persona (leave as brand for the site's own account)</label><select id="f-soc-persona" ${a ? 'disabled' : ''}>${personaOpts}</select></div>
    <div class="field"><label>Status</label><select id="f-soc-status">${statusOpts}</select></div>
    <div class="field"><label>Status note — why it is in this state (the automation reads this)</label><textarea id="f-soc-statusnote" rows="3">${esc(cur.statusNote || '')}</textarea></div>
    <div class="soc-grid">
      <div class="field"><label>Handle</label><input id="f-soc-handle" value="${esc(cur.handle || '')}" placeholder="e.g. americastrikes.bsky.social" /></div>
      <div class="field"><label>Profile URL (derived from handle if blank)</label><input id="f-soc-url" value="${esc(cur.profileUrl && a && a.handle ? '' : cur.profileUrl || '')}" placeholder="https://…" /></div>
    </div>
    <div class="field"><label><input type="checkbox" id="f-soc-creds" ${cur.credsInVault ? 'checked' : ''} /> credentials are in the Vaultwarden "Social Media" collection</label></div>
    <div class="field"><label>Notes</label><textarea id="f-soc-notes" rows="2">${esc(cur.notes || '')}</textarea></div>
    <div id="soc-history"></div>
    <div class="modal-foot">
      ${a ? '<button class="btn danger spacer" id="f-soc-delete">Delete</button>' : ''}
      <button class="btn" id="f-soc-cancel">Cancel</button>
      <button class="btn primary" id="f-soc-save">Save</button>
    </div>`;
  modal.classList.remove('hidden');
  $('#f-soc-cancel').onclick = closeModal;

  if (a) {
    api('GET', `/api/social/events?accountId=${encodeURIComponent(a.id)}&limit=20`)
      .then(r => {
        const el = $('#soc-history');
        if (!el || !r.events.length) return;
        el.innerHTML = `<div class="field"><label>History</label><div class="soc-hist">${r.events
          .map(
            e =>
              `<div><span class="muted">${esc(e.at.slice(0, 16).replace('T', ' '))}</span> ${esc(e.kind)}${e.to ? ` → <b>${esc(e.to)}</b>` : ''} <span class="muted">${esc(e.actor || '')}</span>${e.note ? `<div class="soc-hist-note">${esc(e.note)}</div>` : ''}</div>`
          )
          .join('')}</div></div>`;
      })
      .catch(() => {});
  }

  $('#f-soc-save').onclick = async () => {
    const payload = {
      status: $('#f-soc-status').value,
      statusNote: $('#f-soc-statusnote').value,
      handle: $('#f-soc-handle').value.trim(),
      profileUrl: $('#f-soc-url').value.trim(),
      notes: $('#f-soc-notes').value,
      credsInVault: $('#f-soc-creds').checked,
      actor: 'ui',
    };
    try {
      if (a) {
        await api('PUT', `/api/social/accounts/${encodeURIComponent(a.id)}`, payload);
      } else {
        const personaId = $('#f-soc-persona').value;
        await api('POST', '/api/social/accounts', {
          ...payload,
          site: $('#f-soc-site').value,
          platform: $('#f-soc-platform').value,
          scope: personaId ? 'persona' : 'brand',
          personaId: personaId || undefined,
        });
      }
      toast('saved');
      closeModal(true);
      FRESH = false;
      renderSocial();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  const del = $('#f-soc-delete');
  if (del)
    del.onclick = async () => {
      const approved = await globalThis.fleetConfirm?.({
        title: `Delete ${a.platform} account`,
        message: `Delete the account row for ${a.site}? The history log keeps the record.`,
        confirmLabel: 'Delete account',
        danger: true,
      });
      if (!approved) return;
      try {
        await api('DELETE', `/api/social/accounts/${encodeURIComponent(a.id)}`);
        toast('deleted');
        closeModal(true);
        FRESH = false;
        renderSocial();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
}

/* ---- persona editor ---- */
function socPersonaModal(personaId) {
  const modal = $('#modal'),
    title = $('#modal-title'),
    bodyEl = $('#modal-body');
  const p = personaId ? SOC.data.personas.find(x => x.id === personaId) : null;
  title.textContent = p ? `${p.site} · ${p.name}` : 'New persona';
  const siteOpts = SOC.data.sites
    .map(
      s =>
        `<option value="${esc(s.site)}" ${p && s.site === p.site ? 'selected' : ''}>${esc(s.site)}</option>`
    )
    .join('');
  bodyEl.innerHTML = `
    <div class="field"><label>Site</label><select id="f-per-site" ${p ? 'disabled' : ''}>${siteOpts}</select></div>
    <div class="field"><label>Name (the byline)</label><input id="f-per-name" value="${esc(p ? p.name : '')}" /></div>
    <div class="field"><label>Beat / role</label><input id="f-per-beat" value="${esc(p ? p.beat || '' : '')}" /></div>
    <div class="field"><label>Notes</label><textarea id="f-per-notes" rows="2">${esc(p ? p.notes || '' : '')}</textarea></div>
    <div class="field"><label><input type="checkbox" id="f-per-real" ${p && p.realPerson ? 'checked' : ''} /> real person (not a pseudonymous byline — identity-verifying platforms are fair game)</label></div>
    <div class="field"><label><input type="checkbox" id="f-per-active" ${!p || p.active ? 'checked' : ''} /> active</label></div>
    <div class="modal-foot">
      ${p ? '<button class="btn danger spacer" id="f-per-delete">Delete</button>' : ''}
      <button class="btn" id="f-per-cancel">Cancel</button>
      <button class="btn primary" id="f-per-save">Save</button>
    </div>`;
  modal.classList.remove('hidden');
  $('#f-per-cancel').onclick = closeModal;
  $('#f-per-save').onclick = async () => {
    const payload = {
      name: $('#f-per-name').value.trim(),
      beat: $('#f-per-beat').value.trim(),
      notes: $('#f-per-notes').value,
      realPerson: $('#f-per-real').checked,
      active: $('#f-per-active').checked,
      actor: 'ui',
    };
    try {
      if (p) await api('PUT', `/api/social/personas/${encodeURIComponent(p.id)}`, payload);
      else await api('POST', '/api/social/personas', { ...payload, site: $('#f-per-site').value });
      toast('saved');
      closeModal(true);
      FRESH = false;
      renderSocial();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  const del = $('#f-per-delete');
  if (del)
    del.onclick = async () => {
      try {
        await api('DELETE', `/api/social/personas/${encodeURIComponent(p.id)}`);
        toast('deleted');
        closeModal(true);
        FRESH = false;
        renderSocial();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
}

/* ===================== SHELL ===================== */

// ---------------------------------------------------------------- Social Hub
// Panel view over tools/social-hub. The hub ships no UI of its own beyond its
// raw API (see tools/social-hub/api.py) — this panel IS the social-hub UI, so
// there is one control plane, not two differently-styled apps. Tabs: Overview
// (per-site state + engagement), Queue (every post at every status — this is
// "history of posts from an account"), Inbox (mention replies), Channels
// (enable/disable/verify), Events (the audit log).
const SH = {
  tab: 'overview',
  site: '',
  status: 'draft',
  kind: '',
  queuePlatform: '__public__',
  platforms: [],
  platformsBySite: {},
  inboxStatus: 'new,drafted',
  queueSearch: '',
  queueSort: 'when',
  queueDir: 'desc',
  calendarDays: 7,
  calendarPlatform: '__public__',
  inboxSearch: '',
  inboxSort: 'when',
  inboxDir: 'desc',
  eventsSearch: '',
  eventsSort: 'when',
  eventsDir: 'desc',
};
const SH_STATUSES = [
  'draft',
  'needs_rewrite',
  'approved',
  'scheduled',
  'posted',
  'failed',
  'rejected',
  'cancelled',
];
const SH_PUBLIC_PLATFORMS = '__public__';
const SH_TABS = ['overview', 'oversight', 'queue', 'calendar', 'inbox', 'channels', 'events'];

// Social Hub filters live in the fragment so review links can open an exact
// fleet/site/platform slice without requiring a server-side route. Slack uses
// these links, and changing Queue controls keeps the current URL shareable.
function shApplyRoute(params) {
  if (!params) return false;
  const before = JSON.stringify([
    SH.tab,
    SH.site,
    SH.status,
    SH.kind,
    SH.queuePlatform,
    SH.queueSearch,
  ]);
  const tab = SH_TABS.includes(params.tab) ? params.tab : 'overview';
  SH.tab = tab;
  const site = String(params.site || '').trim();
  SH.site = site.length <= 253 && /^[a-z0-9.-]+$/i.test(site) ? site : '';
  if (tab === 'queue') {
    SH.status = SH_STATUSES.includes(params.status) ? params.status : 'draft';
    SH.kind = ['post', 'reply'].includes(params.kind) ? params.kind : '';
    const platform = String(params.platform || '');
    SH.queuePlatform =
      platform === SH_PUBLIC_PLATFORMS || /^[a-z0-9_.-]{1,50}$/i.test(platform)
        ? platform
        : SH_PUBLIC_PLATFORMS;
    SH.queueSearch = String(params.q || '').slice(0, 200);
    SH.queueSort = 'when';
    SH.queueDir = ['approved', 'scheduled'].includes(SH.status) ? 'asc' : 'desc';
  }
  return (
    before !==
    JSON.stringify([SH.tab, SH.site, SH.status, SH.kind, SH.queuePlatform, SH.queueSearch])
  );
}

function shSyncRoute() {
  if (STATE.view !== 'socialhub') return;
  const params = new URLSearchParams({ tab: SH.tab });
  if (SH.site) params.set('site', SH.site);
  if (SH.tab === 'queue') {
    params.set('status', SH.status);
    params.set('platform', SH.queuePlatform || SH_PUBLIC_PLATFORMS);
    if (SH.kind) params.set('kind', SH.kind);
    if (SH.queueSearch) params.set('q', SH.queueSearch);
  }
  history.replaceState(null, '', `#socialhub?${params.toString()}`);
}

function shSyncTabs() {
  $$('[data-sh-tab]').forEach(button => {
    const active = button.dataset.shTab === SH.tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  const body = $('#sh-body');
  const activeTab = $(`[data-sh-tab="${CSS.escape(SH.tab)}"]`);
  if (body && activeTab) body.setAttribute('aria-labelledby', activeTab.id);
}

let shRefreshToken = 0;
function shRefreshStart() {
  const body = $('#sh-body');
  if (!body) return null;
  const token = ++shRefreshToken;
  document.querySelector('.sh-refresh-cover')?.remove();
  const rect = body.getBoundingClientRect();
  const cover = document.createElement('div');
  cover.className = 'sh-refresh-cover';
  cover.setAttribute('aria-hidden', 'true');
  cover.style.top = `${rect.top}px`;
  cover.style.left = `${rect.left}px`;
  cover.style.width = `${rect.width}px`;
  cover.style.height = `${rect.height}px`;
  cover.innerHTML = body.innerHTML;
  cover.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
  document.body.appendChild(cover);
  body.classList.add('is-refreshing');
  body.setAttribute('aria-busy', 'true');
  return { body, cover, token, started: performance.now() };
}

function shRefreshEnd(state) {
  if (!state || state.token !== shRefreshToken) return;
  const wait = Math.max(0, 260 - (performance.now() - state.started));
  setTimeout(() => {
    if (state.token !== shRefreshToken || !state.body.isConnected) return;
    state.body.classList.remove('is-refreshing');
    state.body.removeAttribute('aria-busy');
    state.cover?.remove();
  }, wait);
}

function shBadgeStatus(status) {
  const cls =
    {
      posted: 'b-green',
      failed: 'b-red',
      needs_rewrite: 'b-red',
      rejected: 'b-red',
      cancelled: 'b-gray',
      draft: 'b-yellow',
    }[status] || 'b-blue';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

function shFmtDate(ts) {
  return ts ? new Date(ts).toLocaleString() : '—';
}

function shDateParts(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return {
    date: d.toLocaleDateString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }),
    time: d.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }),
  };
}

// Queue dates need to read as schedule facts, not as an ambiguous timestamp.
// Browser-local time is intentional: the underlying ISO value remains in the
// datetime attribute and the visible timezone removes any UTC/local guesswork.
function shWhenCell(p) {
  const ts = p.posted_at || p.scheduled_at;
  const parts = shDateParts(ts);
  if (!parts) return '<span class="muted">Not scheduled</span>';
  const label = p.posted_at ? 'Posted' : 'Scheduled';
  return `<time class="sh-when" datetime="${esc(ts)}" title="${esc(ts)}">
    <span class="sh-when-label">${label}</span>
    <strong>${esc(parts.date)}</strong>
    <span>${esc(parts.time)}</span>
  </time>`;
}

// Truncate to n chars for a table cell, keeping the full text in a title
// tooltip so nothing is lost — just not stretched across the row.
function shTrunc(text, n) {
  const t = text || '';
  const short = t.length > n ? t.slice(0, n - 1) + '…' : t;
  return `<span class="sh-trunc" title="${esc(t)}">${esc(short) || "<span class='muted'>—</span>"}</span>`;
}

function shSortHeader(view, label, key) {
  const active = SH[`${view}Sort`] === key;
  const arrow = active ? (SH[`${view}Dir`] === 'asc' ? ' ↑' : ' ↓') : '';
  return `<th><button class="sh-sort${active ? ' active' : ''}" data-sh-sort="${key}" data-sh-view="${view}" title="Sort by ${esc(label)}">${esc(label)}<span aria-hidden="true">${arrow}</span></button></th>`;
}

function shBindSort(view, container, onSort) {
  $$('[data-sh-sort]', container).forEach(btn =>
    btn.addEventListener('click', () => {
      const key = btn.dataset.shSort;
      if (SH[`${view}Sort`] === key) SH[`${view}Dir`] = SH[`${view}Dir`] === 'asc' ? 'desc' : 'asc';
      else {
        SH[`${view}Sort`] = key;
        SH[`${view}Dir`] = 'desc';
      }
      onSort();
    })
  );
}

function shActions(p) {
  if (p.status === 'needs_rewrite') return [['edit', 'Rewrite']];
  if (p.status === 'draft')
    return [
      ['approve', 'Approve'],
      ['reject', 'Reject'],
      ['edit', 'Edit'],
    ];
  if (p.status === 'approved' || p.status === 'scheduled')
    return [
      ['publish', 'Publish now'],
      ['reschedule', 'Reschedule'],
      ['cancel', 'Cancel'],
      ['edit', 'Edit'],
    ];
  if (p.status === 'failed')
    return [
      ['approve', 'Retry'],
      ['cancel', 'Cancel'],
    ];
  return [];
}

function shLocalDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openSocialPostEditor({ id, btn, mode }) {
  const row = btn.closest('[data-sh-post]');
  const modal = $('#modal');
  const title = $('#modal-title');
  const bodyEl = $('#modal-body');
  if (!row || !modal || !title || !bodyEl) return;
  const currentBody = row.querySelector('.sh-trunc')?.getAttribute('title') || '';
  const currentWhen = row.dataset.when || '';
  const isEdit = mode === 'edit';
  title.textContent = isEdit ? `Edit post · ${id}` : `Reschedule post · ${id}`;
  bodyEl.innerHTML = isEdit
    ? `<div class="field"><label for="sh-editor-body">Post body</label><textarea id="sh-editor-body" rows="9" maxlength="5000" class="cm-input" spellcheck="true">${esc(currentBody)}</textarea><span class="muted">Keep the message concise for the selected platform.</span></div>`
    : `<div class="field"><label for="sh-editor-when">New send time</label><input id="sh-editor-when" class="cm-input" type="datetime-local" value="${esc(shLocalDateTime(currentWhen))}" /><span class="muted">Displayed in your local time and saved as UTC.</span></div>`;
  bodyEl.insertAdjacentHTML(
    'beforeend',
    `<div class="modal-foot"><button class="btn" id="sh-editor-cancel" type="button">Cancel</button><button class="btn primary" id="sh-editor-save" type="button">${isEdit ? 'Save changes' : 'Reschedule'}</button></div>`
  );
  modal.classList.remove('hidden');
  $('#sh-editor-cancel').onclick = closeModal;
  $('#sh-editor-save').onclick = async () => {
    const save = $('#sh-editor-save');
    const payload = {};
    if (isEdit) {
      payload.body = $('#sh-editor-body').value.trim();
      if (!payload.body) {
        toast('Post body is required', 'err');
        $('#sh-editor-body').focus();
        return;
      }
    } else {
      const value = $('#sh-editor-when').value;
      if (!value) {
        toast('Choose a send time', 'err');
        $('#sh-editor-when').focus();
        return;
      }
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        toast('Choose a valid send time', 'err');
        return;
      }
      payload.scheduled_at = date.toISOString();
    }
    save.disabled = true;
    try {
      await api('PATCH', `/api/socialhub/posts/${encodeURIComponent(id)}`, payload);
      toast(isEdit ? `Post ${id} updated` : `Post ${id} rescheduled`);
      closeModal(true);
      renderSocialHub();
    } catch (e) {
      toast(e.message, 'err');
      save.disabled = false;
    }
  };
  (isEdit ? $('#sh-editor-body') : $('#sh-editor-when'))?.focus();
}

function openSocialPostFeedback({ id, btn, act }) {
  const modal = $('#modal');
  const title = $('#modal-title');
  const bodyEl = $('#modal-body');
  if (!modal || !title || !bodyEl) return;
  const verb = act === 'deny' ? 'Deny' : 'Reject';
  title.textContent = `${verb} post · ${id}`;
  bodyEl.innerHTML = `<div class="field"><label for="sh-feedback-category">Feedback category</label><select id="sh-feedback-category" class="cm-input"><option value="other">Other</option><option value="wrong_voice">Wrong voice</option><option value="weak_hook">Weak hook</option><option value="unsupported_claim">Unsupported claim</option><option value="too_promotional">Too promotional</option><option value="platform_mismatch">Platform mismatch</option><option value="unsafe_or_private">Unsafe or private</option></select></div><div class="field"><label for="sh-feedback-reason">Reason <span class="muted">(optional)</span></label><textarea id="sh-feedback-reason" class="cm-input" rows="5" maxlength="2000" placeholder="What should change before this post is reviewed again?"></textarea></div><div class="modal-foot"><button class="btn" id="sh-feedback-cancel" type="button">Cancel</button><button class="btn danger" id="sh-feedback-save" type="button">${verb} post</button></div>`;
  modal.classList.remove('hidden');
  $('#sh-feedback-cancel').onclick = closeModal;
  $('#sh-feedback-save').onclick = async () => {
    const save = $('#sh-feedback-save');
    save.disabled = true;
    try {
      await api('POST', `/api/socialhub/posts/${encodeURIComponent(id)}/reject`, {
        reason: $('#sh-feedback-reason').value.trim(),
        category: $('#sh-feedback-category').value,
      });
      toast(`Post ${id} ${act === 'deny' ? 'denied' : 'rejected'}`);
      closeModal(true);
      renderSocialHub();
    } catch (e) {
      toast(e.message, 'err');
      save.disabled = false;
    }
  };
  $('#sh-feedback-reason').focus();
}

// One post as a table row — fixed columns instead of free-flowing badges, so
// nothing stretches unpredictably across the page.
function shPostRow(p) {
  const when = p.posted_at || p.scheduled_at;
  const eng =
    p.status === 'posted'
      ? `<span class="muted mono">❤${p.likes || 0} ↻${p.reposts || 0} ↩${p.replies || 0}</span>`
      : '<span class="muted">—</span>';
  const acts = shActions(p)
    .map(
      ([act, label]) =>
        `<button class="btn sm sh-act" data-act="${esc(act)}" data-id="${esc(p.id)}">${esc(label)}</button>`
    )
    .join('');
  // Two distinct links, easy to conflate: `remote_url` is the post as it
  // actually landed on the platform (only exists once posted); `link` is
  // whatever site article/page the post body itself links out to.
  const remoteHref = safeHref(p.remote_url || '');
  const siteHref = safeHref(p.link || '');
  const links = `
        ${remoteHref ? `<a class="sh-link" href="${remoteHref}" target="_blank" rel="noopener">↗ view on ${esc(p.platform)}</a>` : p.status === 'posted' ? '<span class="muted sh-link">no post URL recorded</span>' : ''}
        ${siteHref ? `<a class="sh-link" href="${siteHref}" target="_blank" rel="noopener">🔗 links to ${esc(new URL(siteHref).pathname || siteHref)}</a>` : ''}`;
  return `
    <tr data-sh-post data-fleet-row data-site="${esc(p.site)}" data-id="${esc(p.id)}" data-when="${esc(when || '')}" data-chars="${(p.body || '').length}">
      <td>${shWhenCell(p)}</td>
      <td><span class="badge b-blue">${esc(p.site)}</span></td>
      <td>${esc(p.platform)}${p.kind === 'reply' ? ' <span class="badge b-yellow">reply</span>' : ''}</td>
      <td>${shBadgeStatus(p.status)}</td>
      <td class="mono muted">${(p.body || '').length}</td>
      <td class="muted">${esc(p.ai_model || p.origin || '—')}</td>
      <td>${eng}</td>
      <td class="sh-body-cell">
        ${shTrunc(p.body, 140)}
        ${p.error ? `<div class="sh-err" title="${esc(p.error)}">⚠ ${esc(p.error.slice(0, 80))}${p.error.length > 80 ? '…' : ''}</div>` : ''}
      </td>
      <td class="sh-body-cell sh-links-cell">${links || '<span class="muted">—</span>'}</td>
      <td class="sh-acts-cell">${acts || '<span class="muted">—</span>'}</td>
    </tr>`;
}

function shSiteOptions(selected) {
  const opts = ['<option value="">All sites</option>']
    .concat(
      (STATE.sites || []).map(
        s => `<option value="${esc(s)}" ${s === selected ? 'selected' : ''}>${esc(s)}</option>`
      )
    )
    .join('');
  return opts;
}

function shPlatformLabel(platform) {
  return platform === 'console' ? 'console (local preview)' : platform;
}

// Channel records are persisted by the hub, but older hub databases and
// compatibility adapters have used a couple of names for the same fields.
// Keep that detail at the UI boundary so a partially migrated hub cannot make
// the Channels tab look empty.
function shChannelField(channel, ...keys) {
  for (const key of keys) {
    const value = channel?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function shChannelText(channel, ...keys) {
  const value = shChannelField(channel, ...keys);
  return value === '' ? '—' : String(value);
}

function shChannelDate(channel, ...keys) {
  const value = shChannelField(channel, ...keys);
  return value ? shFmtDate(value) : '—';
}

function shQueuePlatforms() {
  return SH.site ? SH.platformsBySite[SH.site] || [] : SH.platforms;
}

function shQueuePlatformOptions(selected) {
  return [
    `<option value="${SH_PUBLIC_PLATFORMS}" ${selected === SH_PUBLIC_PLATFORMS ? 'selected' : ''}>All public platforms</option>`,
  ]
    .concat(
      shQueuePlatforms().map(
        platform =>
          `<option value="${esc(platform)}" ${platform === selected ? 'selected' : ''}>${esc(shPlatformLabel(platform))}</option>`
      )
    )
    .join('');
}

async function shPostAction(btn) {
  const { act, id } = btn.dataset;
  btn.disabled = true;
  try {
    if (act === 'reject' || act === 'deny') {
      if (
        act === 'deny' &&
        !(await globalThis.fleetConfirm?.({
          title: 'Deny social post',
          message: 'Deny this post and remove it from the upcoming calendar?',
          confirmLabel: 'Deny post',
          danger: true,
        }))
      ) {
        btn.disabled = false;
        return;
      }
      openSocialPostFeedback({ id, btn, act });
      btn.disabled = false;
      return;
    } else if (act === 'approve') {
      const res = await api('POST', `/api/socialhub/posts/${id}/approve`);
      toast(`Post ${id} scheduled for ${res.scheduled_at || 'the next slot'}`);
    } else if (act === 'edit') {
      openSocialPostEditor({ id, btn, mode: 'edit' });
      btn.disabled = false;
      return;
    } else if (act === 'reschedule') {
      openSocialPostEditor({ id, btn, mode: 'reschedule' });
      btn.disabled = false;
      return;
    } else if (act === 'publish') {
      if (
        !(await globalThis.fleetConfirm?.({
          title: 'Publish social post now',
          message: 'Publish this post immediately, bypassing its scheduled time?',
          confirmLabel: 'Publish now',
        }))
      ) {
        btn.disabled = false;
        return;
      }
      await api('POST', `/api/socialhub/posts/${id}/publish`);
      toast(`Post ${id} published`);
    } else if (act === 'cancel') {
      if (
        !(await globalThis.fleetConfirm?.({
          title: 'Cancel social post',
          message: 'Cancel this scheduled post?',
          confirmLabel: 'Cancel post',
          danger: true,
        }))
      ) {
        btn.disabled = false;
        return;
      }
      await api('POST', `/api/socialhub/posts/${id}/cancel`);
      toast(`Post ${id} cancelled`);
    }
    renderSocialHub();
  } catch (e) {
    toast(e.message, 'err');
    btn.disabled = false;
  }
}

async function renderSocialHub() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div class="page-head"><div><h2 class="page-title">Social publishing</h2><span class="muted">Publishing, oversight, scheduling, and community inbox</span></div><button type="button" id="sh-refresh" class="btn sm">↻ Refresh</button></div><div class="loading" role="status" aria-live="polite">Reading the social hub…</div>';

  let overview;
  try {
    overview = await api('GET', '/api/socialhub');
  } catch (e) {
    renderViewError(app, `Social Hub proxy failed: ${e.message}`);
    return;
  }

  if (!overview.available) {
    app.innerHTML = `
      <div class="page-head"><h2 class="page-title">Social publishing</h2><button type="button" id="sh-refresh" class="btn sm">↻ Refresh</button></div>
      <div class="empty">
        <p><strong>social-hub is not reachable.</strong></p>
        <p class="muted">${esc(overview.error || '')}</p>
        <p class="muted">${esc(overview.hint || '')}</p>
      </div>`;
    $('#sh-refresh').addEventListener('click', () => renderSocialHub());
    return;
  }

  const sites = Object.keys(overview.sites);
  if (!STATE.sites || !STATE.sites.length) STATE.sites = sites;
  SH.platformsBySite = Object.fromEntries(
    Object.entries(overview.sites).map(([site, info]) => [
      site,
      [...new Set((info.channels || []).map(channel => channel.platform).filter(Boolean))].sort(),
    ])
  );
  SH.platforms = [...new Set(Object.values(SH.platformsBySite).flat())].sort();
  if (SH.site && !sites.includes(SH.site)) SH.site = '';
  if (SH.queuePlatform !== SH_PUBLIC_PLATFORMS && !shQueuePlatforms().includes(SH.queuePlatform))
    SH.queuePlatform = SH_PUBLIC_PLATFORMS;
  shSyncRoute();

  const tabs = [
    ['overview', 'Overview'],
    ['oversight', 'Oversight'],
    ['queue', 'Queue'],
    ['calendar', 'Calendar'],
    ['inbox', 'Inbox'],
    ['channels', 'Channels'],
    ['events', 'Events'],
  ];

  // Soft refresh (polling tick): the head/tab-bar skeleton is already there
  // and doesn't depend on fetched data beyond the site count, so just patch
  // that in and re-render the active tab body instead of rebuilding
  // everything — avoids the flash/flicker and focus loss on every tick.
  const existingBody = $('#sh-body');
  if (!FRESH && existingBody && STATE.view === 'socialhub') {
    shSyncTabs();
    const countEl = $('.page-head .muted');
    if (countEl)
      countEl.textContent = `${sites.length} managed site${sites.length === 1 ? '' : 's'}`;
    const refresh = shRefreshStart();
    let tabRender;
    if (SH.tab === 'overview') tabRender = shRenderOverview(overview);
    else if (SH.tab === 'oversight') tabRender = shRenderOversight(overview.oversight || {});
    else if (SH.tab === 'queue') tabRender = shRenderQueue();
    else if (SH.tab === 'calendar') tabRender = shRenderCalendar();
    else if (SH.tab === 'inbox') tabRender = shRenderInbox();
    else if (SH.tab === 'channels') tabRender = shRenderChannels();
    else if (SH.tab === 'events') tabRender = shRenderEvents();
    Promise.resolve(tabRender).finally(() => shRefreshEnd(refresh));
    return;
  }

  app.innerHTML = `
    <div class="page-head">
      <div><h2 class="page-title">Social publishing</h2><span class="muted">${sites.length} managed site${sites.length === 1 ? '' : 's'}</span></div>
      <span class="soc-stats">
        <button type="button" id="sh-refresh" class="btn sm">↻ Refresh</button>
        <button type="button" id="sh-compose" class="btn sm primary">＋ New post</button>
        <button type="button" id="sh-tick" class="btn sm">Run tick</button>
      </span>
    </div>
    <div class="seg sh-tabs" style="margin-bottom:14px" role="tablist" aria-label="Social Hub sections">
      ${tabs
        .map(
          ([id, label]) =>
            `<button type="button" class="seg-btn ${SH.tab === id ? 'active' : ''}" id="sh-tab-${id}" data-sh-tab="${id}" role="tab" aria-controls="sh-body" aria-selected="${SH.tab === id}">${label}</button>`
        )
        .join('')}
    </div>
    <div id="sh-body" role="tabpanel" tabindex="0" aria-labelledby="sh-tab-${SH.tab}"><div class="loading">Loading…</div></div>`;

  shSyncTabs();

  $('#sh-refresh').addEventListener('click', () => renderSocialHub());
  $('#sh-tick').addEventListener('click', async () => {
    const btn = $('#sh-tick');
    btn.disabled = true;
    btn.textContent = 'Running…';
    try {
      const res = await api('POST', '/api/socialhub/tick', {});
      const sent = Object.values(res.sites || {}).reduce((n, s) => n + (s.published || 0), 0);
      toast(`Tick complete — ${sent} published`);
    } catch (e) {
      toast(e.message, 'err');
    }
    btn.disabled = false;
    btn.textContent = 'Run tick';
    renderSocialHub();
  });

  $('#sh-compose').addEventListener('click', () => shComposerModal());

  $$('[data-sh-tab]').forEach(b =>
    b.addEventListener('click', () => {
      SH.tab = b.dataset.shTab;
      shSyncTabs();
      shSyncRoute();
      renderSocialHub();
    })
  );

  if (SH.tab === 'overview') shRenderOverview(overview);
  else if (SH.tab === 'oversight') shRenderOversight(overview.oversight || {});
  else if (SH.tab === 'queue') shRenderQueue();
  else if (SH.tab === 'calendar') shRenderCalendar();
  else if (SH.tab === 'inbox') shRenderInbox();
  else if (SH.tab === 'channels') shRenderChannels();
  else if (SH.tab === 'events') shRenderEvents();
}

function shComposerModal() {
  const modal = $('#modal');
  const title = $('#modal-title');
  const body = $('#modal-body');
  const sites = Object.keys(SH.platformsBySite || {}).sort();
  const selectedSite = SH.site && sites.includes(SH.site) ? SH.site : sites[0] || '';
  const platformOptions = site =>
    (SH.platformsBySite[site] || SH.platforms || [])
      .map(
        platform => `<option value="${esc(platform)}">${esc(shPlatformLabel(platform))}</option>`
      )
      .join('');
  title.textContent = 'New social post';
  body.innerHTML = `
    <p class="muted sh-composer-help">Write your own post, or leave the body blank and Social Hub will draft one from the newest known source using this site’s content direction.</p>
    <div class="form-grid sh-composer-grid">
      <label>Site<select id="sh-compose-site" class="cm-input">${sites.map(site => `<option value="${esc(site)}" ${site === selectedSite ? 'selected' : ''}>${esc(site)}</option>`).join('')}</select></label>
      <label>Platform<select id="sh-compose-platform" class="cm-input">${platformOptions(selectedSite)}</select></label>
    </div>
    <label class="sh-composer-label">Post body <span class="muted">optional for an AI draft</span><textarea id="sh-compose-body" class="cm-input" rows="6" maxlength="4000" placeholder="Share an update, insight, question, or leave blank for an AI draft…"></textarea></label>
    <label class="sh-composer-label">Link <span class="muted">optional</span><input id="sh-compose-link" class="cm-input" type="url" placeholder="https://…" /></label>
    <label class="sh-composer-schedule"><input id="sh-compose-scheduled" type="checkbox" /> Schedule for a specific time</label>
    <label id="sh-compose-when-wrap" class="sh-composer-label hidden">Scheduled time <input id="sh-compose-when" class="cm-input" type="datetime-local" /></label>
    <div class="modal-foot"><button class="btn" id="sh-compose-cancel">Cancel</button><button class="btn" id="sh-compose-draft">Save draft</button><button class="btn primary" id="sh-compose-submit">Schedule post</button></div>`;
  modal.classList.remove('hidden');

  const siteSelect = $('#sh-compose-site');
  const platformSelect = $('#sh-compose-platform');
  siteSelect.addEventListener('change', () => {
    platformSelect.innerHTML = platformOptions(siteSelect.value);
  });
  $('#sh-compose-scheduled').addEventListener('change', e => {
    $('#sh-compose-when-wrap').classList.toggle('hidden', !e.target.checked);
  });
  $('#sh-compose-cancel').onclick = closeModal;

  async function submit(schedule) {
    const submit = schedule ? $('#sh-compose-submit') : $('#sh-compose-draft');
    const whenInput = $('#sh-compose-when');
    submit.disabled = true;
    try {
      const scheduled = schedule && $('#sh-compose-scheduled').checked;
      const when = scheduled && whenInput.value ? new Date(whenInput.value) : null;
      if (when && Number.isNaN(when.getTime())) throw new Error('Scheduled time is invalid');
      await api('POST', '/api/socialhub/posts', {
        site: siteSelect.value,
        platform: platformSelect.value,
        body: $('#sh-compose-body').value,
        link: $('#sh-compose-link').value.trim(),
        schedule,
        scheduled_at: when ? when.toISOString() : undefined,
      });
      toast(schedule ? 'Post scheduled' : 'Draft saved');
      closeModal(true);
      FRESH = false;
      renderSocialHub();
    } catch (e) {
      toast(e.message, 'err');
      submit.disabled = false;
    }
  }
  $('#sh-compose-draft').onclick = () => submit(false);
  $('#sh-compose-submit').onclick = () => submit(true);
}

function shRenderOverview(data) {
  const body = $('#sh-body');
  const entries = Object.entries(data.sites);

  // Roll each site up to the two numbers that actually demand an operator:
  // posts awaiting review, and posts that failed to send.
  const rolled = entries.map(([name, info]) => {
    const c = info.counts || {};
    const channels = info.channels || [];
    const live = [...new Set(channels.filter(ch => ch.enabled).map(ch => ch.platform))];
    // a site can run several accounts on one platform, so collapse to one chip
    // per platform carrying "live/total" rather than repeating the name N times
    const byPlatform = [];
    for (const ch of channels) {
      const row = byPlatform.find(x => x[0] === ch.platform);
      if (row) {
        row[1]++;
        if (ch.enabled) row[2]++;
      } else byPlatform.push([ch.platform, 1, ch.enabled ? 1 : 0]);
    }
    return {
      byPlatform,
      name,
      info,
      c,
      live,
      total: channels.length,
      draft: c.draft || 0,
      failed: c.failed || 0,
      scheduled: c.scheduled || 0,
      posted: c.posted || 0,
      inbox: info.inbox_new || 0,
      idle: !info.next_send && !(c.scheduled || 0),
    };
  });

  const sum = k => rolled.reduce((n, r) => n + r[k], 0);
  const totals = {
    draft: sum('draft'),
    scheduled: sum('scheduled'),
    posted: sum('posted'),
    failed: sum('failed'),
    inbox: sum('inbox'),
    idle: rolled.filter(r => r.idle).length,
  };

  const filter = SH.ovFilter || 'all';
  let shown = rolled;
  if (filter === 'review') shown = shown.filter(r => r.draft > 0);
  else if (filter === 'failing') shown = shown.filter(r => r.failed > 0);
  else if (filter === 'idle') shown = shown.filter(r => r.idle);
  // trouble first, then volume of pending work, then name — an alphabetical
  // wall of 25 identical cards told you nothing about where to look
  shown = shown
    .slice()
    .sort(
      (a, b) =>
        b.failed - a.failed ||
        b.draft - a.draft ||
        b.inbox - a.inbox ||
        a.name.localeCompare(b.name)
    );

  const tile = (k, label, value, tone) =>
    `<button type="button" class="sh-tile${tone ? ' ' + tone : ''}" data-sh-jump="${k}">
       <span class="sh-tile-v">${value}</span><span class="sh-tile-k">${esc(label)}</span><span class="sr-only">Open queue filtered to ${esc(label)}</span>
     </button>`;

  const chip = (k, label, n) =>
    `<button type="button" class="seg-btn${filter === k ? ' active' : ''}" data-sh-ov="${k}" aria-label="${esc(label)} ${n}. Filter sites by ${esc(label)}" aria-pressed="${filter === k}">${esc(label)} <span class="ctl-n">${n}</span></button>`;

  const siteCards = shown
    .map(r => {
      const tone = r.failed ? 'is-bad' : r.draft ? 'is-warn' : r.idle ? 'is-idle' : 'is-ok';
      const next = r.info.next_send ? shFmtDate(r.info.next_send) : 'nothing scheduled';
      const pill = (label, n, cls) =>
        n ? `<span class="sh-pill${cls ? ' ' + cls : ''}">${n}<i>${esc(label)}</i></span>` : '';
      return `
        <div class="card sh-site ${tone}" data-fleet-row data-site="${esc(r.name)}" data-rk="sh-site-${esc(r.name)}">
          <div class="sh-site-head">
            <h3>${esc(r.name)}</h3>
            <span class="muted sh-site-chancount">${r.live.length}/${r.total || 0} live</span>
          </div>
          <div class="sh-site-lead">
            <span class="sh-lead-v${r.draft ? ' warn' : ''}">${r.draft}</span>
            <span class="sh-lead-k">awaiting review</span>
          </div>
          <div class="sh-pills">
            ${pill('scheduled', r.scheduled)}
            ${pill('posted', r.posted)}
            ${pill('failed', r.failed, 'bad')}
            ${pill('inbox', r.inbox, 'warn')}
            ${r.scheduled || r.posted || r.failed || r.inbox ? '' : '<span class="sh-pill muted-pill">quiet</span>'}
          </div>
          <div class="sh-kv-row"><span class="muted">next send</span><span${r.idle ? ' class="muted"' : ''}>${esc(next)}</span></div>
          <div class="sh-chans">${
            r.byPlatform.length
              ? r.byPlatform
                  .map(
                    ([platform, n, on]) =>
                      `<span class="sh-chan${on ? ' on' : ''}" title="${esc(shPlatformLabel(platform))} — ${on}/${n} live">${esc(shPlatformLabel(platform))}${n > 1 ? `<b>${on}/${n}</b>` : ''}</span>`
                  )
                  .join('')
              : '<span class="muted">no channels</span>'
          }</div>
        </div>`;
    })
    .join('');

  const platformRows = Object.entries(data.metrics.platforms || {})
    .map(
      ([platform, m]) => `<tr>
        <td>${esc(shPlatformLabel(platform))}</td><td class="mono">${m.posts}</td><td class="mono">${m.likes}</td>
        <td class="mono">${m.reposts}</td><td class="mono">${m.replies}</td><td class="mono">${m.clicks || 0}</td>
        <td class="mono">${m.conversions || 0}</td><td class="mono">${m.ctr || 0}%</td><td class="mono">${m.avg_engagement}</td>
      </tr>`
    )
    .join('');

  const ctrl = data.oversight || {};
  body.innerHTML = `
    <div class="card sh-controller-strip ${ctrl.enabled === false ? 'is-bad' : ''}">
      <div><strong>Editorial controller</strong><span class="muted">${ctrl.enabled === false ? 'paused' : 'active'} · next ${esc(shFmtDate(ctrl.next_run))}</span></div>
      <div><b>${ctrl.pending || 0}</b><span class="muted"> pending</span> · <b>${ctrl.needs_rewrite || 0}</b><span class="muted"> rewrites</span></div>
      <button class="btn sm" data-sh-open-oversight>Open oversight</button>
    </div>
    <div class="sh-tiles">
      ${tile('draft', 'awaiting review', totals.draft, totals.draft ? 'warn' : '')}
      ${tile('scheduled', 'scheduled', totals.scheduled)}
      ${tile('posted', 'posted', totals.posted)}
      ${tile('failed', 'failed', totals.failed, totals.failed ? 'bad' : '')}
    </div>
    <div class="ctl-bar sh-ov-bar">
      <div class="seg sm" role="group" aria-label="Filter sites by social state">
        ${chip('all', 'All sites', rolled.length)}
        ${chip('review', 'Needs review', rolled.filter(r => r.draft).length)}
        ${chip('failing', 'Failing', rolled.filter(r => r.failed).length)}
        ${chip('idle', 'Idle', totals.idle)}
      </div>
      <span class="ctl-count muted">${shown.length} of ${rolled.length} sites${totals.inbox ? ` · ${totals.inbox} unread inbox` : ''}</span>
    </div>
    <div class="cards sh-cards">${siteCards || '<div class="empty">No site matches this filter.</div>'}</div>
    <h3 class="sh-h">Engagement — last ${data.metrics.days || 30} days</h3>
    ${
      platformRows
        ? `<div class="card sh-table-wrap"><table class="tbl"><caption class="sr-only">Social platform engagement over the selected period</caption><thead><tr><th>Platform</th><th>Posts</th><th>Likes</th>
             <th>Reposts</th><th>Replies</th><th>Visits</th><th>Conversions</th><th>CTR</th><th>Avg engagement</th></tr></thead>
           <tbody>${platformRows}</tbody></table></div>`
        : '<div class="empty">Nothing published in this window yet.</div>'
    }`;

  $$('[data-sh-ov]').forEach(b =>
    b.addEventListener('click', () => {
      SH.ovFilter = b.dataset.shOv;
      shRenderOverview(data);
    })
  );
  $('[data-sh-open-oversight]')?.addEventListener('click', () =>
    $('[data-sh-tab="oversight"]')?.click()
  );
  // a summary tile is a question ("what are those 84 drafts?") — send it to the
  // queue already filtered rather than making the operator refilter by hand
  $$('[data-sh-jump]').forEach(b =>
    b.addEventListener('click', () => {
      SH.status = b.dataset.shJump;
      SH.site = '';
      $('[data-sh-tab="queue"]')?.click();
    })
  );
  applyFleetFilter();
}

function shRenderOversight(data) {
  const body = $('#sh-body');
  const last = data.last_run || {};
  const stats = last.stats || {};
  const usage = data.usage_30d || {};
  const categories = Object.entries(data.feedback_categories || {})
    .map(([name, count]) => `<tr><td>${esc(name)}</td><td class="mono">${count}</td></tr>`)
    .join('');
  const proposals = (data.learning_proposals || [])
    .map(
      p => `<tr>
    <td class="mono">#${esc(p.id)}</td><td>${esc(p.site || 'fleet')}</td><td>${esc(p.target_path)}</td>
    <td class="sh-body-cell">${esc(p.instruction)}</td><td>${shBadgeStatus(p.state)}</td>
    <td class="sh-acts-cell">${p.state === 'proposed' ? `<button class="btn sm sh-learn-review" data-id="${esc(p.id)}" data-state="approved">Approve</button><button class="btn sm sh-learn-review" data-id="${esc(p.id)}" data-state="rejected">Reject</button>` : '<span class="muted">—</span>'}</td>
  </tr>`
    )
    .join('');
  const configWarnings = (data.config_health || []).filter(row => !row.ready);
  body.innerHTML = `
    <div class="sh-tiles">
      <div class="sh-tile"><span class="sh-tile-v">${data.pending || 0}</span><span class="sh-tile-k">pending</span></div>
      <div class="sh-tile warn"><span class="sh-tile-v">${data.needs_rewrite || 0}</span><span class="sh-tile-k">needs rewrite</span></div>
      <div class="sh-tile ${Number(data.fallback?.percent || 0) ? 'bad' : ''}"><span class="sh-tile-v">${data.fallback?.percent || 0}%</span><span class="sh-tile-k">fallback drafts</span></div>
      <div class="sh-tile"><span class="sh-tile-v">$${Number(usage.cost_usd || 0).toFixed(2)}</span><span class="sh-tile-k">controller cost · 30d</span></div>
    </div>
    <div class="card sh-controller-panel">
      <div><h3>Controller</h3><p class="muted">Last check ${esc(shFmtDate(last.finished_at || last.started_at))} · next ${esc(shFmtDate(data.next_run))} · ${usage.runs || 0} AI ledger run(s)</p></div>
      <button id="sh-controller-toggle" class="btn sm ${data.enabled ? '' : 'primary'}">${data.enabled ? 'Pause controller' : 'Enable controller'}</button>
    </div>
    <div class="sh-oversight-grid">
      <div><h3 class="sh-h">Open feedback</h3>${categories ? `<div class="card sh-table-wrap"><table class="tbl"><thead><tr><th>Category</th><th>Count</th></tr></thead><tbody>${categories}</tbody></table></div>` : '<div class="empty">No open feedback.</div>'}</div>
      <div><h3 class="sh-h">Configuration readiness</h3><div class="card sh-config-health"><strong>${data.config_ready || 0}/${(data.config_health || []).length} complete</strong>${
        configWarnings
          .slice(0, 12)
          .map(
            row =>
              `<p><span class="badge b-yellow">${esc(row.site)}</span> ${esc(row.warnings.join(' · '))}</p>`
          )
          .join('') || '<p class="muted">Every managed site has a complete voice card.</p>'
      }</div></div>
    </div>
    <h3 class="sh-h">Writer learning proposals</h3>
    ${proposals ? `<div class="card sh-table-wrap"><table class="tbl sh-table"><thead><tr><th>ID</th><th>Scope</th><th>Target</th><th>Instruction</th><th>State</th><th>Actions</th></tr></thead><tbody>${proposals}</tbody></table></div>` : '<div class="empty">No evidence-backed changes proposed yet.</div>'}`;
  $('#sh-controller-toggle')?.addEventListener('click', async e => {
    gdBusy(e.currentTarget, true);
    try {
      await api('POST', '/api/socialhub/controller', { enabled: !data.enabled });
      toast(!data.enabled ? 'Controller enabled' : 'Controller paused');
      renderSocialHub();
    } catch (err) {
      toast(err.message, 'err');
      gdBusy(e.currentTarget, false);
    }
  });
  $$('.sh-learn-review').forEach(btn =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('POST', `/api/socialhub/learning/${btn.dataset.id}/review`, {
          state: btn.dataset.state,
        });
        toast(`Proposal ${btn.dataset.state}`);
        renderSocialHub();
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
      }
    })
  );
}

// A panel refresh should not blank a useful table while its request is in
// flight. Preserve the prior panel body for soft refreshes; a tab switch has
// no matching panel and therefore still gets the explicit loading state.
function shPreviousPanel(selector, loading) {
  if (FRESH) return loading;
  const previous = $(selector)?.innerHTML;
  return previous || loading;
}

async function shRenderQueue() {
  const body = $('#sh-body');
  body.innerHTML = `
    <div class="task-toolbar sh-toolbar">
      <select id="sh-f-status" class="cm-input">
        ${SH_STATUSES.map(s => `<option value="${s}" ${s === SH.status ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
      <select id="sh-f-site" class="cm-input">${shSiteOptions(SH.site)}</select>
      <select id="sh-f-platform" class="cm-input" title="Console is a local preview channel; it writes to the Social Hub outbox instead of a public network">
        ${shQueuePlatformOptions(SH.queuePlatform)}
      </select>
      <select id="sh-f-kind" class="cm-input">
        <option value="" ${SH.kind === '' ? 'selected' : ''}>posts + replies</option>
        <option value="post" ${SH.kind === 'post' ? 'selected' : ''}>posts only</option>
        <option value="reply" ${SH.kind === 'reply' ? 'selected' : ''}>replies only</option>
      </select>
      <label class="compliance-search-wrap"><span class="muted">Search</span><input id="sh-f-search" class="cm-input" type="search" placeholder="Search post body…" value="${esc(SH.queueSearch)}" autocomplete="off"></label>
      <span id="sh-queue-count" class="muted" style="margin-left:auto"></span>
    </div>
    <div id="sh-queue-list" class="loading">${shPreviousPanel('#sh-queue-list', 'Loading…')}</div>`;

  $('#sh-f-site').addEventListener('change', e => {
    SH.site = e.target.value;
    if (
      SH.queuePlatform !== SH_PUBLIC_PLATFORMS &&
      SH.queuePlatform &&
      !shQueuePlatforms().includes(SH.queuePlatform)
    )
      SH.queuePlatform = SH_PUBLIC_PLATFORMS;
    shSyncRoute();
    shRenderQueue();
  });
  $('#sh-f-platform').addEventListener('change', e => {
    SH.queuePlatform = e.target.value;
    shSyncRoute();
    shRenderQueue();
  });
  $('#sh-f-status').addEventListener('change', e => {
    SH.status = e.target.value;
    SH.queueSort = 'when';
    SH.queueDir = ['approved', 'scheduled'].includes(SH.status) ? 'asc' : 'desc';
    shSyncRoute();
    shRenderQueue();
  });
  $('#sh-f-kind').addEventListener('change', e => {
    SH.kind = e.target.value;
    shSyncRoute();
    shRenderQueue();
  });
  let searchT;
  $('#sh-f-search').addEventListener('input', e => {
    clearTimeout(searchT);
    const val = e.target.value;
    searchT = setTimeout(() => {
      SH.queueSearch = val;
      shSyncRoute();
      shQueueRedraw(posts);
    }, 150);
  });

  let data;
  try {
    const publicOnly = SH.queuePlatform === SH_PUBLIC_PLATFORMS;
    const platform = publicOnly ? '' : SH.queuePlatform;
    data = await api(
      'GET',
      `/api/socialhub/posts?status=${SH.status}&kind=${SH.kind}&site=${encodeURIComponent(SH.site)}&platform=${encodeURIComponent(platform)}&limit=${publicOnly ? 500 : 100}`
    );
  } catch (e) {
    renderViewError($('#sh-queue-list'), `Social queue failed: ${e.message}`);
    return;
  }
  var posts = (data.posts || [])
    .filter(post => SH.queuePlatform !== SH_PUBLIC_PLATFORMS || post.platform !== 'console')
    .slice(0, 100);

  function shQueueRedraw(posts) {
    const q = SH.queueSearch.trim().toLowerCase();
    const filtered = posts.filter(p => !q || (p.body || '').toLowerCase().includes(q));
    filtered.sort((a, b) => {
      const dir = SH.queueDir === 'asc' ? 1 : -1;
      const key = SH.queueSort;
      let av, bv;
      if (key === 'when') {
        av = a.posted_at || a.scheduled_at || '';
        bv = b.posted_at || b.scheduled_at || '';
      } else if (key === 'chars') {
        av = (a.body || '').length;
        bv = (b.body || '').length;
      } else {
        av = a[key] || '';
        bv = b[key] || '';
      }
      return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
    });
    $('#sh-queue-count').textContent = `${filtered.length} of ${posts.length} shown`;
    const list = $('#sh-queue-list');
    const whenHeading =
      SH.status === 'posted'
        ? 'Posted at'
        : ['approved', 'scheduled'].includes(SH.status)
          ? 'Scheduled for'
          : 'Date';
    list.innerHTML = filtered.length
      ? `<div class="card sh-table-wrap"><table class="tbl sh-table">
          <thead><tr>
            ${shSortHeader('queue', whenHeading, 'when')}
            ${shSortHeader('queue', 'Site', 'site')}
            ${shSortHeader('queue', 'Platform', 'platform')}
            ${shSortHeader('queue', 'Status', 'status')}
            ${shSortHeader('queue', 'Chars', 'chars')}
            <th>Model</th><th>Engagement</th><th>Post</th><th>Links</th><th>Actions</th>
          </tr></thead>
          <tbody>${filtered.map(shPostRow).join('')}</tbody>
        </table></div>`
      : `<div class="empty">No ${esc(SH.status)} posts${q ? ' matching your search' : ''}.</div>`;
    shBindSort('queue', list, () => shQueueRedraw(posts));
    $$('.sh-act', list).forEach(btn => btn.addEventListener('click', () => shPostAction(btn)));
    applyFleetFilter();
  }

  shQueueRedraw(posts);
}

function shCalendarDayKey(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shCalendarDayLabel(date) {
  const d = new Date(date);
  return {
    weekday: d.toLocaleDateString([], { weekday: 'long' }),
    date: d.toLocaleDateString([], { month: 'short', day: 'numeric' }),
  };
}

function shSiteMark(site) {
  const favicon = safeHref(`https://${site}/favicon.svg`);
  const initial =
    String(site || '?')
      .replace(/^www\./i, '')
      .charAt(0)
      .toUpperCase() || '?';
  return `<span class="sh-site-mark" title="${esc(site)}"><span class="sh-site-initial" aria-hidden="true">${esc(initial)}</span><img src="${favicon}" alt="" loading="lazy" data-sh-site-icon data-site="${esc(site)}"></span>`;
}

function shWireSiteIcons(root) {
  $$('[data-sh-site-icon]', root).forEach(img =>
    img.addEventListener('error', () => {
      if (img.dataset.fallback === '1') {
        img.hidden = true;
        return;
      }
      img.dataset.fallback = '1';
      img.src = safeHref(`https://${img.dataset.site}/favicon.ico`);
    })
  );
}

function shCalendarPost(p) {
  const parts = shDateParts(p.scheduled_at);
  const time = parts ? parts.time : 'Time unavailable';
  const overdue = p.scheduled_at && new Date(p.scheduled_at).getTime() < Date.now();
  const statusLabel =
    {
      draft: 'Awaiting approval',
      approved: 'Approved',
      scheduled: 'Scheduled',
      posted: 'Published',
      failed: 'Failed',
      rejected: 'Rejected',
      cancelled: 'Cancelled',
    }[p.status] ||
    p.status ||
    'Unknown';
  const acts = shActions(p)
    .map(
      ([act, label]) =>
        `<button class="btn sm sh-act" data-act="${esc(act)}" data-id="${esc(p.id)}">${esc(label)}</button>`
    )
    .join('');
  return `
    <article class="sh-cal-post${overdue ? ' overdue' : ''}" data-sh-post data-fleet-row data-site="${esc(p.site)}" data-id="${esc(p.id)}">
      <div class="sh-cal-post-head">
        <time datetime="${esc(p.scheduled_at || '')}" title="${esc(p.scheduled_at || '')}">${esc(time)}</time>
        <span class="badge ${p.status === 'draft' ? 'b-yellow' : p.status === 'posted' ? 'b-green' : p.status === 'failed' || p.status === 'rejected' ? 'b-red' : p.status === 'cancelled' ? 'b-gray' : 'b-blue'}" title="Current approval/publishing state">${esc(statusLabel)}</span>
      </div>
      <div class="sh-cal-meta">
        <span class="sh-site-label">${shSiteMark(p.site)}<span class="badge b-blue">${esc(p.site)}</span></span>
        <span class="badge">${esc(p.platform)}</span>
        ${p.kind === 'reply' ? '<span class="badge b-yellow">reply</span>' : ''}
      </div>
      <div class="sh-cal-body">${shTrunc(p.body, 110)}</div>
      ${overdue ? '<div class="sh-cal-overdue">Past due</div>' : ''}
      <div class="sh-acts-cell">${acts || '<span class="muted">—</span>'}</div>
    </article>`;
}

async function shRenderCalendar() {
  const body = $('#sh-body');
  body.innerHTML = `
    <div class="task-toolbar sh-toolbar sh-calendar-toolbar">
      <select id="sh-cal-site" class="cm-input">${shSiteOptions(SH.site)}</select>
      <select id="sh-cal-platform" class="cm-input" disabled><option value="">All platforms</option></select>
      <label class="sh-calendar-view-label" for="sh-cal-days">View</label>
      <select id="sh-cal-days" class="cm-input" aria-label="Calendar view">
        <option value="1" ${SH.calendarDays === 1 ? 'selected' : ''}>1 day</option>
        <option value="2" ${SH.calendarDays === 2 ? 'selected' : ''}>2 days</option>
        <option value="3" ${SH.calendarDays === 3 ? 'selected' : ''}>3 days</option>
        <option value="5" ${SH.calendarDays === 5 ? 'selected' : ''}>5 days</option>
        <option value="7" ${SH.calendarDays === 7 ? 'selected' : ''}>7 days</option>
      </select>
      <span id="sh-calendar-count" class="muted" style="margin-left:auto"></span>
    </div>
    <div id="sh-calendar-list" class="loading">${shPreviousPanel('#sh-calendar-list', 'Loading upcoming schedule…')}</div>`;

  $('#sh-cal-site').addEventListener('change', e => {
    SH.site = e.target.value;
    shRenderCalendar();
  });
  $('#sh-cal-days').addEventListener('change', e => {
    SH.calendarDays = Number(e.target.value) || 7;
    shRenderCalendar();
  });

  let data;
  try {
    data = await api(
      'GET',
      `/api/socialhub/calendar?site=${encodeURIComponent(SH.site)}&days=${SH.calendarDays}`
    );
  } catch (e) {
    renderViewError($('#sh-calendar-list'), `Social calendar failed: ${e.message}`);
    return;
  }
  const posts = (data.posts || []).filter(p => p.scheduled_at);
  const platforms = [...new Set(posts.map(p => p.platform).filter(Boolean))].sort();
  if (
    SH.calendarPlatform !== SH_PUBLIC_PLATFORMS &&
    SH.calendarPlatform &&
    !platforms.includes(SH.calendarPlatform)
  )
    SH.calendarPlatform = SH_PUBLIC_PLATFORMS;
  const platformSelect = $('#sh-cal-platform');
  platformSelect.innerHTML = [
    `<option value="${SH_PUBLIC_PLATFORMS}" ${SH.calendarPlatform === SH_PUBLIC_PLATFORMS ? 'selected' : ''}>All public platforms</option>`,
  ]
    .concat(
      platforms.map(
        platform =>
          `<option value="${esc(platform)}" ${platform === SH.calendarPlatform ? 'selected' : ''}>${esc(shPlatformLabel(platform))}</option>`
      )
    )
    .join('');
  platformSelect.disabled = platforms.length === 0;
  platformSelect.addEventListener('change', e => {
    SH.calendarPlatform = e.target.value;
    shCalendarRedraw();
  });

  function shCalendarRedraw() {
    const filtered = posts
      .filter(p =>
        SH.calendarPlatform === SH_PUBLIC_PLATFORMS
          ? p.platform !== 'console'
          : !SH.calendarPlatform || p.platform === SH.calendarPlatform
      )
      .sort((a, b) => (a.scheduled_at || '').localeCompare(b.scheduled_at || ''));
    const groups = new Map();
    filtered.forEach(p => {
      const key = shCalendarDayKey(p.scheduled_at);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    });
    $('#sh-calendar-count').textContent =
      `${filtered.length} upcoming post${filtered.length === 1 ? '' : 's'}`;
    const list = $('#sh-calendar-list');
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const now = new Date();
    const nowPct = ((now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60) / 1440) * 100;
    const days = Array.from({ length: SH.calendarDays }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return { date, posts: groups.get(shCalendarDayKey(date)) || [] };
    });
    const activeDays = days.filter(day => day.posts.length);
    const busiest = activeDays.length ? Math.max(...activeDays.map(day => day.posts.length)) : 0;
    list.classList.remove('loading');
    list.innerHTML = `
      <div class="sh-calendar-intro">
        <div>
          <span class="sh-calendar-kicker">Publishing schedule</span>
          <h3>Upcoming content</h3>
          <p>Review what is planned across your connected channels.</p>
        </div>
        <div class="sh-calendar-legend" aria-label="Calendar legend">
          <span><i class="sh-legend-dot scheduled"></i>Scheduled</span>
          <span><i class="sh-legend-dot review"></i>Needs review</span>
          <span><i class="sh-legend-dot overdue"></i>Past due</span>
        </div>
      </div>
      <div class="sh-calendar-summary">
        <div><strong>${filtered.length}</strong><span>upcoming post${filtered.length === 1 ? '' : 's'}</span></div>
        <div><strong>${activeDays.length}</strong><span>active day${activeDays.length === 1 ? '' : 's'}</span></div>
        <div><strong>${busiest}</strong><span>busiest day</span></div>
      </div>
      <div class="matrix-scroll-hint sh-calendar-scroll-hint" role="note">Swipe horizontally to browse day columns; scroll within a day to review its posts</div>
      <div class="sh-calendar-wrap" tabindex="0" role="region" aria-label="Upcoming posts by day">
        <div class="sh-calendar-grid" style="--sh-calendar-days:${days.length}">
          ${days
            .map(day => {
              const label = shCalendarDayLabel(day.date);
              const today = shCalendarDayKey(day.date) === shCalendarDayKey(new Date());
              const weekend = [0, 6].includes(day.date.getDay());
              return `<section class="sh-cal-day${today ? ' is-today' : ''}${weekend ? ' is-weekend' : ''}">
                <header><div><strong>${esc(label.weekday)}</strong><span>${esc(label.date)}</span></div><div class="sh-cal-day-head-meta">${today ? '<span class="sh-cal-today-mark">Today</span>' : ''}<span class="badge ${day.posts.length ? 'b-blue' : 'b-gray'}">${day.posts.length}</span></div></header>
                <div class="sh-cal-day-posts">${today ? `<div class="sh-cal-now-line" style="--sh-now-pct:${nowPct.toFixed(3)}%"><span>Now ${esc(now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</span></div>` : ''}${day.posts.length ? day.posts.map(shCalendarPost).join('') : '<div class="sh-cal-empty"><span>—</span><small>No posts</small></div>'}</div>
              </section>`;
            })
            .join('')}
        </div>
      </div>`;
    $$('.sh-act', list).forEach(btn => btn.addEventListener('click', () => shPostAction(btn)));
    shWireSiteIcons(list);
    applyFleetFilter();
  }

  shCalendarRedraw();
}

function shMentionBadge(status) {
  const cls =
    { answered: 'b-green', blocked: 'b-red', ignored: 'b-gray', drafted: 'b-blue' }[status] ||
    'b-yellow';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

// One inbox mention as a table row. The drafted reply (if any) shows as a
// compact sub-row instead of a full nested card.
function shMentionRow(m) {
  const acts = [
    !m.reply
      ? `<button class="btn sm sh-mention-draft" data-id="${m.id}">Draft reply</button>`
      : '',
    `<button class="btn sm sh-mention-status" data-id="${m.id}" data-status="answered">Mark answered</button>`,
    `<button class="btn sm sh-mention-status" data-id="${m.id}" data-status="ignored">Ignore</button>`,
    `<button class="btn sm sh-mention-status" data-id="${m.id}" data-status="blocked">Block author</button>`,
  ]
    .filter(Boolean)
    .join('');
  return `
    <tr data-fleet-row data-site="${esc(m.site)}" data-id="${m.id}" data-when="${esc(m.created_at || '')}">
      <td class="mono muted">${shFmtDate(m.created_at)}</td>
      <td><span class="badge b-blue">${esc(m.site)}</span></td>
      <td>${esc(m.platform)}</td>
      <td>${shMentionBadge(m.status)}</td>
      <td>@${esc(m.author || 'unknown')}</td>
      <td class="sh-body-cell">${shTrunc(m.text, 140)}</td>
      <td class="sh-body-cell">
        ${
          m.reply
            ? `${shBadgeStatus(m.reply.status)} ${shTrunc(m.reply.body, 90)}
               ${safeHref(m.reply.remote_url || '') ? `<a class="sh-link" href="${safeHref(m.reply.remote_url)}" target="_blank" rel="noopener">↗ view on ${esc(m.platform)}</a>` : ''}
               <div class="sh-acts-cell">${shActions(m.reply)
                 .map(
                   ([act, label]) =>
                     `<button class="btn sm sh-act" data-act="${act}" data-id="${m.reply.id}">${label}</button>`
                 )
                 .join('')}</div>`
            : '<span class="muted">no reply drafted</span>'
        }
      </td>
      <td class="sh-acts-cell">${acts}</td>
    </tr>`;
}

async function shRenderInbox() {
  const body = $('#sh-body');
  body.innerHTML = `
    <div class="task-toolbar sh-toolbar">
      <select id="sh-f-istatus" class="cm-input">
        ${['new,drafted', 'new', 'drafted', 'answered', 'ignored', 'blocked']
          .map(
            s =>
              `<option value="${s}" ${s === SH.inboxStatus ? 'selected' : ''}>${s.replace(',', ' + ')}</option>`
          )
          .join('')}
      </select>
      <select id="sh-f-isite" class="cm-input">${shSiteOptions(SH.site)}</select>
      <label class="compliance-search-wrap"><span class="muted">Search</span><input id="sh-f-isearch" class="cm-input" type="search" placeholder="Search mention text…" value="${esc(SH.inboxSearch)}" autocomplete="off"></label>
      <span id="sh-inbox-count" class="muted" style="margin-left:auto"></span>
    </div>
    <div id="sh-inbox-list" class="loading">${shPreviousPanel('#sh-inbox-list', 'Loading…')}</div>`;

  $('#sh-f-isite').addEventListener('change', e => {
    SH.site = e.target.value;
    shRenderInbox();
  });
  $('#sh-f-istatus').addEventListener('change', e => {
    SH.inboxStatus = e.target.value;
    shRenderInbox();
  });
  let searchT;
  $('#sh-f-isearch').addEventListener('input', e => {
    clearTimeout(searchT);
    const val = e.target.value;
    searchT = setTimeout(() => {
      SH.inboxSearch = val;
      shInboxRedraw(mentions);
    }, 150);
  });

  let data;
  try {
    data = await api(
      'GET',
      `/api/socialhub/inbox?status=${encodeURIComponent(SH.inboxStatus)}&site=${encodeURIComponent(SH.site)}`
    );
  } catch (e) {
    renderViewError($('#sh-inbox-list'), `Social inbox failed: ${e.message}`);
    return;
  }
  var mentions = data.mentions || [];

  function shInboxRedraw(mentions) {
    const q = SH.inboxSearch.trim().toLowerCase();
    const filtered = mentions.filter(
      m =>
        !q || (m.text || '').toLowerCase().includes(q) || (m.author || '').toLowerCase().includes(q)
    );
    filtered.sort((a, b) => {
      const dir = SH.inboxDir === 'asc' ? 1 : -1;
      const key = SH.inboxSort;
      const av = key === 'when' ? a.created_at || '' : a[key] || '';
      const bv = key === 'when' ? b.created_at || '' : b[key] || '';
      return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
    });
    $('#sh-inbox-count').textContent = `${filtered.length} of ${mentions.length} shown`;
    const list = $('#sh-inbox-list');
    list.innerHTML = filtered.length
      ? `<div class="card sh-table-wrap"><table class="tbl sh-table">
          <thead><tr>
            ${shSortHeader('inbox', 'When', 'when')}
            ${shSortHeader('inbox', 'Site', 'site')}
            ${shSortHeader('inbox', 'Platform', 'platform')}
            ${shSortHeader('inbox', 'Status', 'status')}
            ${shSortHeader('inbox', 'Author', 'author')}
            <th>Mention</th><th>Reply</th><th>Actions</th>
          </tr></thead>
          <tbody>${filtered.map(shMentionRow).join('')}</tbody>
        </table></div>`
      : `<div class="empty">Nothing in the inbox at this filter${q ? ' matching your search' : ''}.</div>`;
    shBindSort('inbox', list, () => shInboxRedraw(mentions));

    $$('.sh-act', list).forEach(btn => btn.addEventListener('click', () => shPostAction(btn)));
    $$('.sh-mention-draft', list).forEach(btn =>
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const res = await api('POST', `/api/socialhub/inbox/${btn.dataset.id}/draft`, {});
          toast(res.ok ? 'Reply drafted' : `Declined: ${res.reason || 'no reply generated'}`);
          shRenderInbox();
        } catch (e) {
          toast(e.message, 'err');
          btn.disabled = false;
        }
      })
    );
    $$('.sh-mention-status', list).forEach(btn =>
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api('POST', `/api/socialhub/inbox/${btn.dataset.id}/status`, {
            status: btn.dataset.status,
          });
          toast(`Marked ${btn.dataset.status}`);
          shRenderInbox();
        } catch (e) {
          toast(e.message, 'err');
          btn.disabled = false;
        }
      })
    );
    applyFleetFilter();
  }

  shInboxRedraw(mentions);
}

async function shRenderChannels() {
  const body = $('#sh-body');
  body.innerHTML = `
    <div class="task-toolbar sh-toolbar">
      <select id="sh-f-csite" class="cm-input">${shSiteOptions(SH.site)}</select>
      <span id="sh-channels-count" class="muted" style="margin-left:auto"></span>
    </div>
    <div id="sh-channels-list" class="loading">${shPreviousPanel('#sh-channels-list', 'Loading…')}</div>`;
  $('#sh-f-csite').addEventListener('change', e => {
    SH.site = e.target.value;
    shRenderChannels();
  });

  let data;
  let registryData = { accounts: [] };
  try {
    data = await api('GET', `/api/socialhub/channels?site=${encodeURIComponent(SH.site)}`);
  } catch (e) {
    renderViewError($('#sh-channels-list'), `Social channels failed: ${e.message}`);
    return;
  }
  // Registry enrichment is optional; the Hub inventory must remain visible
  // even when the separate Fleet Social Registry endpoint is unavailable.
  try {
    registryData = await api('GET', `/api/social/accounts?site=${encodeURIComponent(SH.site)}`);
  } catch {
    registryData = { accounts: [] };
  }
  // Accept both the hub's normal envelope and the direct list shape returned
  // by a few older deployments.
  const hubChannels = (
    Array.isArray(data)
      ? data
      : Array.isArray(data?.channels)
        ? data.channels
        : Array.isArray(data?.data?.channels)
          ? data.data.channels
          : []
  ).slice();
  const registryAccounts = Array.isArray(registryData?.accounts) ? registryData.accounts : [];
  const channelKey = c =>
    [
      shChannelField(c, 'site', 'domain'),
      shChannelField(c, 'platform', 'platform_name', 'network'),
      shChannelField(c, 'personaName', 'persona_name', 'persona') || 'brand',
    ]
      .map(value => String(value).toLowerCase())
      .join('|');

  // The registry is the source of truth for identity and lifecycle state;
  // the hub mirror owns operational fields such as enabled and timestamps.
  // Include registry rows that have not been synced yet so they are visible
  // instead of silently disappearing from this inventory.
  const byKey = new Map(hubChannels.map(channel => [channelKey(channel), { ...channel }]));
  for (const account of registryAccounts) {
    const key = channelKey(account);
    const hub = byKey.get(key) || {};
    const merged = {
      ...hub,
      ...account,
      // Registry IDs identify social accounts; channel actions require the
      // separate numeric ID from Social Hub's mirror.
      id: hub.id !== undefined && hub.id !== null ? hub.id : '',
      ...(hub.enabled !== undefined ? { enabled: hub.enabled } : {}),
      ...(hub.last_posted_at ? { last_posted_at: hub.last_posted_at } : {}),
      ...(hub.last_polled_at ? { last_polled_at: hub.last_polled_at } : {}),
      ...(hub.updated_at ? { updated_at: hub.updated_at } : {}),
    };
    // A successful hub verification can know the handle even when the
    // registry account has not been backfilled yet.
    if (!account.handle && hub.handle) merged.handle = hub.handle;
    byKey.set(key, merged);
  }
  const channels = [...byKey.values()].sort(
    (a, b) =>
      shChannelText(a, 'site', 'domain').localeCompare(shChannelText(b, 'site', 'domain')) ||
      shChannelText(a, 'platform', 'platform_name', 'network').localeCompare(
        shChannelText(b, 'platform', 'platform_name', 'network')
      ) ||
      shChannelText(a, 'personaName', 'persona_name', 'persona', 'scope').localeCompare(
        shChannelText(b, 'personaName', 'persona_name', 'persona', 'scope')
      )
  );
  $('#sh-channels-count').textContent =
    `${channels.length} channel${channels.length === 1 ? '' : 's'}`;
  const rows = channels
    .map(c => {
      const site = shChannelText(c, 'site', 'domain');
      const platform = shChannelText(c, 'platform', 'platform_name', 'network');
      const persona = shChannelField(c, 'personaName', 'persona_name', 'persona');
      const scope = shChannelField(c, 'scope') || (persona ? 'persona' : 'brand');
      const handle = shChannelText(c, 'handle', 'username', 'account', 'account_handle');
      const status = shChannelText(c, 'status', 'state');
      const readiness = shChannelText(c, 'readiness');
      const enabled = c.enabled === true || c.enabled === 1 || c.enabled === '1';
      const hasCreds =
        c.has_creds === true || c.has_creds === 1 || c.has_creds === '1' || c.credsInVault === true;
      const note = shChannelText(c, 'note', 'statusNote', 'notes');
      const error = shChannelField(c, 'error', 'last_error');
      const id = shChannelField(c, 'id', 'channel_id');
      const canOperate = id !== '';
      return `<tr data-fleet-row data-site="${esc(site)}" data-id="${esc(id)}">
          <td><span class="badge b-blue">${esc(site)}</span></td>
          <td>${esc(shPlatformLabel(platform))}</td>
          <td class="muted">${esc(scope)}${persona ? ` <span class="mono">(${esc(persona)})</span>` : ''}</td>
          <td class="mono">${esc(handle)}</td>
          <td>${esc(status)}</td>
          <td><span class="badge ${readiness === 'ready' ? 'b-green' : readiness === 'cooldown' || readiness === 'blocked' ? 'b-red' : 'b-yellow'}">${esc(readiness)}</span></td>
          <td>${enabled ? '<span class="badge b-green">on</span>' : '<span class="badge b-gray">off</span>'}</td>
          <td>${hasCreds ? '<span class="badge b-green">yes</span>' : '<span class="badge b-gray">no</span>'}</td>
          <td class="mono muted">${esc(shChannelDate(c, 'last_verified_at', 'verified_at', 'updated_at'))}</td>
          <td class="mono muted">${esc(shChannelDate(c, 'last_posted_at'))}</td>
          <td class="mono muted">${esc(shChannelDate(c, 'last_polled_at'))}</td>
          <td class="sh-body-cell" title="${esc(note)}">${esc(note)}</td>
          <td class="sh-body-cell">${error ? `<span class="sh-err" title="${esc(error)}">⚠ ${esc(String(error).slice(0, 60))}${String(error).length > 60 ? '…' : ''}</span>` : '<span class="muted">—</span>'}</td>
          <td class="sh-acts-cell">
            ${
              canOperate
                ? `<button class="btn sm sh-chan-toggle" data-id="${esc(id)}" data-enabled="${enabled ? 0 : 1}">${enabled ? 'Disable' : 'Enable'}</button>
                 <button class="btn sm sh-chan-verify" data-id="${esc(id)}">Verify</button>`
                : '<span class="muted" title="This registry account has not been synced into Social Hub yet">Registry only</span>'
            }
          </td>
        </tr>`;
    })
    .join('');
  $('#sh-channels-list').innerHTML = rows
    ? `<div class="card sh-table-wrap"><table class="tbl sh-table"><thead><tr><th>Site</th><th>Platform</th><th>Scope</th><th>Handle</th>
         <th>Status</th><th>Readiness</th><th>Enabled</th><th>Credentials</th><th>Last checked</th><th>Last posted</th><th>Last polled</th><th>Note</th><th>Error</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<div class="empty">No channels for this filter.</div>';

  const channelSelect = $('#sh-f-csite');
  if (channelSelect) channelSelect.setAttribute('aria-label', 'Filter social channels by site');
  const channelTable = $('#sh-channels-list table');
  const channelWrap = $('#sh-channels-list .sh-table-wrap');
  if (channelTable && channelWrap) {
    const caption = document.createElement('caption');
    caption.className = 'sr-only';
    caption.textContent = 'Social channel readiness register';
    channelTable.prepend(caption);
    const hint = document.createElement('div');
    hint.className = 'sh-scroll-hint';
    hint.setAttribute('role', 'note');
    hint.textContent = 'Swipe horizontally to inspect readiness, credentials, and actions';
    channelWrap.before(hint);
  }

  $$('.sh-chan-toggle').forEach(btn =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('PATCH', `/api/socialhub/channels/${btn.dataset.id}`, {
          enabled: btn.dataset.enabled === '1',
        });
        shRenderChannels();
      } catch (e) {
        toast(e.message, 'err');
        btn.disabled = false;
      }
    })
  );
  $$('.sh-chan-verify').forEach(btn =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Verifying…';
      try {
        const res = await api('POST', `/api/socialhub/channels/${btn.dataset.id}/verify`, {});
        toast(
          res.ok ? 'Channel verified' : `Verify failed: ${res.error || 'unknown'}`,
          res.ok ? '' : 'err'
        );
      } catch (e) {
        toast(e.message, 'err');
      }
      btn.disabled = false;
      btn.textContent = 'Verify';
    })
  );
  applyFleetFilter();
}

async function shRenderEvents() {
  const body = $('#sh-body');
  body.innerHTML = `
    <div class="task-toolbar sh-toolbar">
      <select id="sh-f-esite" class="cm-input">${shSiteOptions(SH.site)}</select>
      <label class="compliance-search-wrap"><span class="muted">Search</span><input id="sh-f-esearch" class="cm-input" type="search" placeholder="Search event message…" value="${esc(SH.eventsSearch)}" autocomplete="off"></label>
      <span id="sh-events-count" class="muted" style="margin-left:auto"></span>
    </div>
    <div id="sh-events-list" class="loading">${shPreviousPanel('#sh-events-list', 'Loading…')}</div>`;
  $('#sh-f-esite').addEventListener('change', e => {
    SH.site = e.target.value;
    shRenderEvents();
  });
  let searchT;
  $('#sh-f-esearch').addEventListener('input', e => {
    clearTimeout(searchT);
    const val = e.target.value;
    searchT = setTimeout(() => {
      SH.eventsSearch = val;
      shEventsRedraw(events);
    }, 150);
  });

  let data;
  try {
    data = await api('GET', `/api/socialhub/events?site=${encodeURIComponent(SH.site)}&limit=150`);
  } catch (e) {
    renderViewError($('#sh-events-list'), `Social events failed: ${e.message}`);
    return;
  }
  var events = data.events || [];

  function shEventsRedraw(events) {
    const q = SH.eventsSearch.trim().toLowerCase();
    const filtered = events.filter(
      ev =>
        !q ||
        (ev.message || '').toLowerCase().includes(q) ||
        (ev.kind || '').toLowerCase().includes(q)
    );
    filtered.sort((a, b) => {
      const dir = SH.eventsDir === 'asc' ? 1 : -1;
      const key = SH.eventsSort;
      const av = key === 'when' ? a.ts || '' : a[key] || '';
      const bv = key === 'when' ? b.ts || '' : b[key] || '';
      return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
    });
    $('#sh-events-count').textContent = `${filtered.length} of ${events.length} shown`;
    const rows = filtered
      .map(
        ev => `<tr${ev.site ? ` data-fleet-row data-site="${esc(ev.site)}"` : ''}>
          <td class="mono muted">${shFmtDate(ev.ts)}</td>
          <td>${ev.site ? `<span class="badge b-blue">${esc(ev.site)}</span>` : '<span class="muted">—</span>'}</td>
          <td><span class="badge b-gray">${esc(ev.kind)}</span></td>
          <td class="sh-body-cell">${esc(ev.message || '')}</td>
        </tr>`
      )
      .join('');
    const list = $('#sh-events-list');
    list.innerHTML = filtered.length
      ? `<div class="card sh-table-wrap"><table class="tbl sh-table"><thead><tr>
           ${shSortHeader('events', 'When', 'when')}
           ${shSortHeader('events', 'Site', 'site')}
           ${shSortHeader('events', 'Event', 'kind')}
           <th>Message</th></tr></thead>
           <tbody>${rows}</tbody></table></div>`
      : `<div class="empty">No events for this filter${q ? ' matching your search' : ''}.</div>`;
    shBindSort('events', list, () => shEventsRedraw(events));
    applyFleetFilter();
  }

  shEventsRedraw(events);
}

// NAV_GROUPS is defined further down (grouped nav), before parseHash() needs
// it — declared here as a forward reference via var hoisting is unsafe with
// const, so TOP_VIEWS is assembled lazily the first time it's read.
function topViews() {
  return [
    'control',
    'priorities',
    'improvements',
    'delivery',
    'workbench',
    'knowledge',
    'executive',
    'agents',
    ...Object.keys(NAV_GROUPS),
    ...NAV_GROUP_VIEWS,
  ];
}

// Grouped nav (F-nav): the flat 20+ tab bar collapsed into topic dropdowns,
// mirroring the existing Agents ▾ pattern. Add a new top-level view's button
// here — a bare data-view button is only for something that deserves to be
// pinned outside every group (currently just Domain Control).
const NAV_GROUPS = {
  ops: {
    label: 'Ops',
    description: 'Run, deploy, and maintain the fleet infrastructure.',
    items: [
      ['cron', 'Cron'],
      ['scheduler', 'Scheduler'],
      ['containers', 'Containers'],
      ['git', 'Git'],
      ['tasks', 'Tasks'],
      ['change-queue', 'Change Queue'],
      ['workflow-board', 'Work Board'],
      ['deploys', 'Deploys'],
      ['builds', 'Build Usage'],
      ['domains', 'Domains'],
      ['guardrails', 'Guardrails'],
      ['doctor', 'Doctor'],
      ['retention', 'Retention'],
    ],
  },
  content: {
    label: 'Content',
    description: 'Create, enrich, and manage the fleet publishing pipeline.',
    items: [
      ['guides', 'Guides'],
      ['productfeed', 'Product Feed'],
      ['datahub', 'Data Hub'],
      ['datahubimages', 'Data Hub Images'],
      ['sitefacts', 'Site Facts'],
    ],
  },
  growth: {
    label: 'Growth',
    description: 'Measure demand, expand reach, and manage acquisition systems.',
    items: [
      ['seointelligence', 'SEO Intelligence'],
      ['backlinks', 'Backlink Capture'],
      ['analytics', 'Analytics'],
      ['social', 'Social Accounts'],
      ['socialhub', 'Social Hub'],
      ['automation', 'Automation'],
      ['aiusage', 'AI Usage'],
      ['aioptimizer', 'AI Optimizer'],
      ['aiinventory', 'AI Inventory'],
      ['taskbudget', 'Task Budget'],
    ],
  },
  quality: {
    label: 'Quality',
    description: 'Protect reliability, compliance, and data integrity.',
    items: [
      ['compliance', 'Compliance'],
      ['lint', 'Lint'],
      ['health', 'Health'],
      ['errors', 'Errors'],
      ['activity', 'Activity'],
      ['devsandbox', 'Dev Sandboxes'],
      ['dataquality', 'Data Quality'],
    ],
  },
};
// Flattened for the router — every view any group knows about.
const NAV_GROUP_VIEWS = Object.values(NAV_GROUPS).flatMap(g => g.items.map(([v]) => v));

// Hash router. Routes: #control, #cron, #containers, #git[/hygiene], #tasks, #agents/<role>[/<page>].
// Legacy aliases: #roles → control, #fleet → agents/engineer.
function parseHash() {
  const raw = (location.hash || '').replace(/^#/, '');
  const queryAt = raw.indexOf('?');
  const h = queryAt === -1 ? raw : raw.slice(0, queryAt);
  const query = queryAt === -1 ? '' : raw.slice(queryAt + 1);
  if (!h) return { view: 'control', agent: null };
  const parts = h.split('/');
  const [a, b, c] = parts;
  if (a === 'site' && b) return { view: 'site', siteSlug: decodeURIComponent(b) };
  if (a === 'agents' && b)
    return {
      view: 'agent',
      agent: decodeURIComponent(b),
      agentPage: c ? decodeURIComponent(c) : null,
    };
  if (a === 'fleet') return { view: 'agent', agent: 'engineer' };
  if (a === 'roles') return { view: 'control', agent: null };
  // Legacy bookmark for the former standalone Git Hygiene view.
  if (a === 'githygiene') return { view: 'git', agent: null, gitTab: 'hygiene' };
  if (a === 'git' && b === 'hygiene') return { view: 'git', agent: null, gitTab: 'hygiene' };
  if (a === 'git' && b && c === 'stashes')
    return { view: 'gitstashes', agent: null, gitSlug: decodeURIComponent(b) };
  if (topViews().includes(a))
    return {
      view: a,
      agent: null,
      gitTab: a === 'git' ? 'operations' : null,
      socialHub: a === 'socialhub' && query ? Object.fromEntries(new URLSearchParams(query)) : null,
      controlFilter: a === 'control' ? new URLSearchParams(query).get('filter') : null,
      controlSort: a === 'control' ? new URLSearchParams(query).get('sort') : null,
    };
  return { view: 'control', agent: null };
}
function hashFor(view, agent, agentPage) {
  if (view === 'site') return `site/${encodeURIComponent(STATE.siteSlug || '')}`;
  return view === 'agent'
    ? `agents/${encodeURIComponent(agent)}${agentPage ? `/${encodeURIComponent(agentPage)}` : ''}`
    : view;
}

// FRESH = true → a navigation/first paint: show loading placeholders.
// FRESH = false → an in-place soft refresh: no loading flash, and each view
// restores scroll + expanded rows from UISNAP after it repaints.
let FRESH = true;
let UISNAP = { open: {}, html: {}, details: [], fields: [], scroll: 0, focus: null };
let SOFT_RENDER_BUSY = false;
let SOFT_RENDER_QUEUED = false;

// Snapshot the bits of UI state a full re-render would otherwise discard:
// every [data-rk] element's open/visible state, the inner HTML of lazily
// filled panels ([data-rkh], e.g. expanded git detail), and scroll position.
function captureUI() {
  const open = {},
    html = {};
  $$('[data-rk]').forEach(el => {
    open[el.dataset.rk] = el.tagName === 'DETAILS' ? el.open : !el.classList.contains('hidden');
  });
  $$('[data-rkh]').forEach(el => {
    html[el.dataset.rkh] = el.innerHTML;
  });
  const active = document.activeElement;
  const focus =
    active && active !== document.body
      ? { id: active.id || '', name: active.getAttribute('name') || '', tag: active.tagName }
      : null;
  const fields = [];
  $$('input, select, textarea').forEach((el, index) => {
    const type = (el.getAttribute('type') || '').toLowerCase();
    // Never retain credentials or file handles in an in-memory refresh
    // snapshot. All other visible controls are operator workspace state.
    if (type === 'password' || type === 'file') return;
    fields.push({
      id: el.id || '',
      name: el.getAttribute('name') || '',
      tag: el.tagName.toLowerCase(),
      index,
      type,
      value: el.value,
      checked: type === 'checkbox' || type === 'radio' ? el.checked : undefined,
      selected:
        el.tagName === 'SELECT' && el.multiple
          ? Array.from(el.selectedOptions).map(o => o.value)
          : undefined,
    });
  });
  return {
    open,
    html,
    // A number of views use native details without a data-rk key. Their
    // position in the rendered view is stable, so preserve those too.
    details: $$('details').map(el => el.open),
    fields,
    scroll: window.scrollY,
    focus,
  };
}
function applyUISnap() {
  const s = UISNAP;
  if (!s) return;
  $$('[data-rkh]').forEach(el => {
    const v = s.html[el.dataset.rkh];
    if (v && v.trim()) el.innerHTML = v;
  });
  $$('[data-rk]').forEach(el => {
    if (!(el.dataset.rk in s.open)) return;
    if (el.tagName === 'DETAILS') el.open = s.open[el.dataset.rk];
    else el.classList.toggle('hidden', !s.open[el.dataset.rk]);
  });
  if (Array.isArray(s.details)) {
    $$('details').forEach((el, i) => {
      if (i < s.details.length) el.open = s.details[i];
    });
  }
  if (Array.isArray(s.fields)) {
    s.fields.forEach(saved => {
      const candidates = saved.id
        ? [document.getElementById(saved.id)].filter(Boolean)
        : saved.name
          ? $$(`${saved.tag}[name="${CSS.escape(saved.name)}"]`)
          : [];
      const target = saved.id
        ? candidates[0]
        : candidates[Math.min(saved.index || 0, candidates.length - 1)];
      if (!target) return;
      if (saved.type === 'checkbox' || saved.type === 'radio')
        target.checked = Boolean(saved.checked);
      else if (target.tagName === 'SELECT' && target.multiple && Array.isArray(saved.selected)) {
        Array.from(target.options).forEach(option => {
          option.selected = saved.selected.includes(option.value);
        });
      } else if (saved.type !== 'password' && saved.type !== 'file')
        target.value = saved.value ?? '';
    });
  }
  if (typeof s.scroll === 'number') window.scrollTo({ top: s.scroll, left: 0, behavior: 'auto' });
  if (s.focus) {
    const target = s.focus.id
      ? document.getElementById(s.focus.id)
      : s.focus.name
        ? $(`${s.focus.tag.toLowerCase()}[name="${CSS.escape(s.focus.name)}"]`)
        : null;
    if (target && document.activeElement !== target) target.focus({ preventScroll: true });
  }
}

// ---------------------------------------------------------------- Automation
// One management surface for the controls that are otherwise split across
// hub.yaml, role markdown, and per-site crontabs.
let AUTO_SITE = '';
let AUTO_ROLE_DRAFT = null;

const AUTO_SCHEDULE_PRESETS = [
  ['*/15 * * * *', 'Every 15 minutes'],
  ['*/30 * * * *', 'Every 30 minutes'],
  ['0 * * * *', 'Every hour'],
  ['0 */2 * * *', 'Every 2 hours'],
  ['0 6 * * *', 'Every day at 6:00 AM'],
  ['0 9 * * 1-5', 'Weekdays at 9:00 AM'],
  ['0 9 * * 1', 'Every Monday at 9:00 AM'],
  ['0 9 1 * *', 'First day of every month at 9:00 AM'],
];

function automationSchedulePicker(id, value) {
  const preset = AUTO_SCHEDULE_PRESETS.find(([expr]) => expr === value);
  return `<div class="auto-schedule-picker" data-auto-schedule-picker>
    <select id="${esc(id)}-preset" class="cm-input auto-schedule-preset" aria-label="Choose a schedule">
      <option value="">Choose a common schedule…</option>
      ${AUTO_SCHEDULE_PRESETS.map(([expr, label]) => `<option value="${esc(expr)}" ${expr === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
      <option value="__custom__" ${preset ? '' : 'selected'}>Custom cron schedule…</option>
    </select>
    <input id="${esc(id)}" class="cm-input auto-role-schedule${preset ? ' hidden' : ''}" type="text" value="${esc(value)}" placeholder="minute hour day month weekday" spellcheck="false" autocomplete="off" aria-label="Custom five-field cron schedule" />
    <span class="muted auto-schedule-help">${preset ? esc(preset[1]) : 'Use custom five-field cron, for example: 15 8 * * 1-5'}</span>
  </div>`;
}

function wireAutomationSchedulePickers() {
  $$('[data-auto-schedule-picker]').forEach(picker => {
    const select = $('.auto-schedule-preset', picker);
    const input = $('.auto-role-schedule', picker);
    const help = $('.auto-schedule-help', picker);
    select.addEventListener('change', () => {
      const custom = select.value === '__custom__';
      if (!custom && select.value) input.value = select.value;
      input.classList.toggle('hidden', !custom);
      const preset = AUTO_SCHEDULE_PRESETS.find(([expr]) => expr === input.value);
      help.textContent = custom
        ? 'Use custom five-field cron, for example: 15 8 * * 1-5'
        : preset
          ? preset[1]
          : 'Choose a schedule above';
    });
  });
}

function automationSiteOptions(selected) {
  return ['<option value="">Select a site…</option>']
    .concat(
      (STATE.sites || []).map(
        s => `<option value="${esc(s)}" ${s === selected ? 'selected' : ''}>${esc(s)}</option>`
      )
    )
    .join('');
}

function cycleAutomationSite(direction) {
  const sites = STATE.sites || [];
  if (!sites.length) return;
  const selectedIndex = sites.indexOf(AUTO_SITE);
  const current = selectedIndex === -1 ? (direction > 0 ? -1 : 0) : selectedIndex;
  AUTO_SITE = sites[(current + direction + sites.length) % sites.length];
  renderAutomation();
}

let PRIORITY_STATE = 'all';
let PRIORITY_PAGE = 1;
const PRIORITY_PAGE_SIZE = 25;

async function renderPriorities() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Joining portfolio signals…</div></div>';
  let data;
  try {
    data = await api('GET', '/api/priorities');
  } catch (e) {
    renderViewError(app, e.message);
    return;
  }
  const coverage = data.coverage || {};
  const all = data.items || [];
  const reportedTotal = Number(data.totals?.recommendations);
  const omittedActions = Number.isFinite(reportedTotal)
    ? Math.max(0, reportedTotal - all.length)
    : 0;
  const rows = all.filter(item => PRIORITY_STATE === 'all' || item.state === PRIORITY_STATE);
  const pageCount = Math.max(1, Math.ceil(rows.length / PRIORITY_PAGE_SIZE));
  PRIORITY_PAGE = Math.min(Math.max(1, PRIORITY_PAGE), pageCount);
  const pageStart = (PRIORITY_PAGE - 1) * PRIORITY_PAGE_SIZE;
  const pageRows = rows.slice(pageStart, pageStart + PRIORITY_PAGE_SIZE);
  const tiles = [
    ['Recommendations', data.totals?.recommendations || 0, 'joined work queue'],
    ['Ready', data.totals?.ready || 0, 'can be filed now'],
    ['Blocked', data.totals?.blocked || 0, 'coverage or ownership'],
    [
      'Live sites',
      coverage.live_sites || 0,
      `${coverage.discovered_sites || 0} operational checkouts`,
    ],
    ['Analytics', coverage.analytics_sites || 0, 'sites reporting'],
    [
      'Revenue',
      coverage.revenue_connected ? 'Connected' : 'Missing',
      coverage.revenue_attributed ? 'attributed' : 'not attributable',
    ],
  ]
    .map(
      ([label, value, sub]) =>
        `<div class="seo-stat"><div class="seo-stat-label">${esc(label)}</div><div class="seo-stat-value">${esc(value)}</div><div class="seo-stat-sub">${esc(sub)}</div></div>`
    )
    .join('');
  const body = pageRows
    .map(
      item => `<tr data-fleet-row data-site="${esc(item.site)}">
    <td><b>${esc(item.score)}</b></td><td>${siteLink(item.site)}</td>
    <td><span class="badge ${item.state === 'blocked' ? 'b-red' : item.state === 'filed' ? 'b-green' : 'b-blue'}">${esc(item.state)}</span></td>
    <td><span class="badge b-gray">${esc(item.kind)}</span></td>
    <td><strong>${esc(item.title)}</strong><div class="muted">${esc(item.evidence || '')}</div>${item.duplicate_count > 1 ? `<details class="priority-duplicates"><summary>${item.duplicate_count} identical tasks grouped</summary><ul>${(item.task?.files || []).map(file => `<li><code>${esc(file)}</code></li>`).join('')}</ul></details>` : ''}</td>
    <td>${esc(item.confidence)}</td><td>${item.expected_profit_usd == null ? '<span class="muted">not attributable</span>' : fmtUSD(item.expected_profit_usd)}</td>
    <td>${item.action_key && item.state === 'ready' ? `<button class="btn sm primary priority-start" data-site="${esc(item.site)}" data-key="${esc(item.action_key)}">Start improvement</button>` : ''}</td>
  </tr>`
    )
    .join('');
  const scorecards = (data.scorecards || [])
    .map(
      row =>
        `<tr data-fleet-row data-site="${esc(row.site)}"><td>${siteLink(row.site)}</td><td><span class="badge b-gray">${esc(row.allocation)}</span></td><td>${esc(row.opportunity_score)}</td><td>${seoNum(row.sessions)}</td><td>${seoNum(row.conversions)}</td><td>${fmtUSD(row.ai_cost_usd)}</td><td>${row.revenue_usd == null ? '—' : fmtUSD(row.revenue_usd)}</td><td>${row.margin_usd == null ? '—' : fmtUSD(row.margin_usd)}</td></tr>`
    )
    .join('');
  app.innerHTML = `<div class="page-head"><div><h2 class="page-title">Next Best Actions</h2><div class="crumbs">One decision queue across growth, coverage, and execution</div></div><button type="button" id="priorities-refresh" class="btn">↻ Refresh</button></div>
    ${data.notice ? `<div class="fd-stale-banner priority-notice" role="note"><strong>Data note</strong><span>${esc(data.notice)}</span></div>` : ''}
    ${omittedActions ? `<div class="fd-stale-banner priority-truncated" role="alert"><strong>Incomplete queue</strong><span>The API reports ${reportedTotal} recommendations but returned ${all.length}; ${omittedActions} actions are not available in this view yet.</span></div>` : ''}
    <section class="seo-stats">${tiles}</section>
    <details class="card"><summary><strong>Portfolio allocation scorecard</strong> <span class="muted">value, direct AI cost, and attributable margin by live site</span></summary><div class="matrix-scroll-hint priority-scroll-hint" role="note">Swipe horizontally to inspect all scorecard columns</div><div class="table-wrap" tabindex="0" role="region" aria-label="Portfolio allocation scorecard by live site"><table class="tbl"><caption class="sr-only">Portfolio allocation scorecard by live site</caption><thead><tr><th>Site</th><th>Allocation</th><th>Opportunity</th><th>Sessions</th><th>Conversions</th><th>AI cost</th><th>Revenue</th><th>Margin</th></tr></thead><tbody>${scorecards}</tbody></table></div></details>
    <div class="task-toolbar"><strong>${rows.length} items</strong><span class="muted">Showing ${rows.length ? pageStart + 1 : 0}–${Math.min(pageStart + PRIORITY_PAGE_SIZE, rows.length)}</span><select id="priority-state" class="cm-input" aria-label="Filter prioritized actions by state"><option value="all">All states</option><option value="ready">Ready</option><option value="blocked">Blocked</option><option value="filed">Filed</option></select></div>
    ${pageCount > 1 ? `<nav class="priority-pagination" aria-label="Priority action pages"><button type="button" class="btn sm" id="priority-prev" ${PRIORITY_PAGE === 1 ? 'disabled' : ''}>← Previous</button><span class="muted" id="priority-page-status" role="status">Page ${PRIORITY_PAGE} of ${pageCount} · ${rows.length} total actions</span><button type="button" class="btn sm" id="priority-next" ${PRIORITY_PAGE === pageCount ? 'disabled' : ''}>Next →</button></nav>` : ''}
    <section class="card"><div class="matrix-scroll-hint priority-scroll-hint" role="note">Swipe horizontally to inspect all recommendation columns</div><div class="table-wrap" tabindex="0" role="region" aria-label="Prioritized recommended actions"><table class="tbl"><caption class="sr-only">Prioritized recommended actions</caption><thead><tr><th scope="col">Score</th><th scope="col">Site</th><th scope="col">State</th><th scope="col">Kind</th><th scope="col">Recommended action</th><th scope="col">Confidence</th><th scope="col">Expected profit</th><th scope="col">Action</th></tr></thead><tbody>${body || '<tr><td colspan="8" class="muted">No actions in this slice.</td></tr>'}</tbody></table></div></section>`;
  $('#priorities-refresh').addEventListener('click', () => renderPriorities());
  $('#priority-state').value = PRIORITY_STATE;
  $('#priority-state').addEventListener('change', e => {
    PRIORITY_STATE = e.target.value;
    PRIORITY_PAGE = 1;
    softRender();
  });
  $('#priority-prev')?.addEventListener('click', () => {
    PRIORITY_PAGE = Math.max(1, PRIORITY_PAGE - 1);
    softRender();
  });
  $('#priority-next')?.addEventListener('click', () => {
    PRIORITY_PAGE = Math.min(pageCount, PRIORITY_PAGE + 1);
    softRender();
  });
  $$('.priority-start').forEach(button =>
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await api('POST', '/api/improvements/start', {
          site: button.dataset.site,
          key: button.dataset.key,
        });
        toast(result.duplicate ? 'Improvement already exists' : 'Improvement started');
        go('improvements');
      } catch (e) {
        button.disabled = false;
        toast(e.message, 'err');
      }
    })
  );
  applyFleetFilter();
  if (!FRESH) applyUISnap();
  stamp();
}

let IMPROVEMENT_STATE = 'active';
let IMPROVEMENT_PAGE = 1;
const IMPROVEMENT_PAGE_SIZE = 20;
const IMPROVEMENT_TERMINAL = new Set(['proven', 'inconclusive', 'cancelled', 'rolled-back']);

function improvementActions(run, transitions) {
  if (run.state === 'measuring' || run.state === 'deployed')
    return `${run.state === 'measuring' ? `<button class="btn sm primary improvement-measure" data-id="${esc(run.run_id)}">Measure outcome</button> ` : ''}<button class="btn sm danger improvement-rollback" data-id="${esc(run.run_id)}" data-title="${esc(run.title)}">Execute rollback</button>`;
  if (run.state === 'review')
    return (
      `<button class="btn sm primary improvement-deploy" data-id="${esc(run.run_id)}" data-title="${esc(run.title)}">Approve & deploy</button> ` +
      (transitions[run.state] || [])
        .filter(state => state !== 'deployed')
        .map(
          state =>
            `<button class="btn sm ${state === 'cancelled' ? 'danger' : ''} improvement-transition" data-id="${esc(run.run_id)}" data-state="${esc(state)}">${esc(state)}</button>`
        )
        .join(' ')
    );
  const buildTools =
    run.state === 'building'
      ? `<button class="btn sm improvement-agent" data-id="${esc(run.run_id)}">Run agent</button> <button class="btn sm improvement-commit" data-id="${esc(run.run_id)}">Commit changes</button> <button class="btn sm primary improvement-validate" data-id="${esc(run.run_id)}">Run quality gates</button> `
      : '';
  return (
    buildTools +
    (transitions[run.state] || [])
      .map(
        state =>
          `<button class="btn sm ${state === 'building' ? 'primary' : state === 'proven' ? 'primary' : state === 'cancelled' || state === 'rolled-back' ? 'danger' : ''} improvement-transition" data-id="${esc(run.run_id)}" data-state="${esc(state)}">${state === 'building' && run.state !== 'review' ? 'Start sandbox build' : esc(state.replace('-', ' '))}</button>`
      )
      .join(' ')
  );
}

function improvementChecks(validation) {
  const checks = {
    ...(validation?.checks || {}),
    ...(validation?.preview?.checks || {}),
    ...(validation?.browser?.lighthouse?.checks || {}),
    ...(validation?.browser?.screenshots || {}),
  };
  return (
    Object.entries(checks)
      .map(([name, value]) => {
        const item = typeof value === 'string' ? { status: value } : value || {};
        const cls =
          item.status === 'pass' ? 'b-green' : item.status === 'warn' ? 'b-yellow' : 'b-red';
        return `<tr><td>${esc(name.replaceAll('_', ' '))}</td><td><span class="badge ${cls}">${esc(item.status || 'unknown')}</span></td><td class="muted">${esc(item.evidence || item.excerpt || '')}</td></tr>`;
      })
      .join('') || '<tr><td colspan="3" class="muted">Quality gates have not run.</td></tr>'
  );
}

async function renderImprovements() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading improvement runs…</div></div>';
  let data;
  try {
    data = await api('GET', '/api/improvements');
  } catch (e) {
    renderViewError(app, e.message);
    return;
  }
  const all = data.runs || [];
  const runs = all.filter(
    run =>
      IMPROVEMENT_STATE === 'all' ||
      (IMPROVEMENT_STATE === 'active'
        ? !IMPROVEMENT_TERMINAL.has(run.state)
        : run.state === IMPROVEMENT_STATE)
  );
  const pageCount = Math.max(1, Math.ceil(runs.length / IMPROVEMENT_PAGE_SIZE));
  IMPROVEMENT_PAGE = Math.min(Math.max(1, IMPROVEMENT_PAGE), pageCount);
  const pageStart = (IMPROVEMENT_PAGE - 1) * IMPROVEMENT_PAGE_SIZE;
  const pageRuns = runs.slice(pageStart, pageStart + IMPROVEMENT_PAGE_SIZE);
  const cards = pageRuns
    .map(run => {
      const baseline = run.baseline?.analytics || {};
      const validation = run.validation || {};
      const outcome = run.outcome || {};
      return `<article class="card improvement-card" data-fleet-row data-site="${esc(run.site)}">
      <div class="page-head"><div><h3>${esc(run.title)}</h3><div>${siteLink(run.site)} · <span class="badge b-blue">${esc(run.state)}</span>${run.stale ? ' · <span class="badge b-yellow">stale</span>' : ''} · owner ${esc(run.agent?.assigned_role || 'unassigned')} · <span class="mono muted">${esc(run.run_id.slice(0, 8))}</span></div></div><div>${improvementActions(run, data.transitions || {})}</div></div>
      <div class="seo-stats">
        <div class="seo-stat"><div class="seo-stat-label">Task ${run.task_drift ? '<span class="badge b-red">drift</span>' : ''}</div><div class="seo-stat-value is-compact">${esc(run.task_file || '—')}</div><div class="seo-stat-sub">${esc(run.task_column || 'missing')} · expected ${esc(run.expected_task_column || '—')}</div></div>
        <div class="seo-stat"><div class="seo-stat-label">Branch</div><div class="seo-stat-value is-compact">${esc(run.branch || 'not recorded')}</div><div class="seo-stat-sub">${run.sandbox?.ttydUrl ? `<a href="${esc(run.sandbox.ttydUrl)}" target="_blank" rel="noopener">open isolated shell</a>` : 'isolated implementation'}</div></div>
        <div class="seo-stat"><div class="seo-stat-label">Baseline</div><div class="seo-stat-value is-compact">${baseline.has_data === false ? 'unavailable' : 'captured'}</div><div class="seo-stat-sub">${esc(run.baseline?.captured_at || '')}</div></div>
        <div class="seo-stat"><div class="seo-stat-label">Measure</div><div class="seo-stat-value is-compact">${esc(run.measurement_due || '—')}</div><div class="seo-stat-sub">28-day outcome window</div></div>
      </div>
      <details class="improvement-detail" data-id="${esc(run.run_id)}" data-rk="improvement:${esc(run.run_id)}"><summary>Evidence and delivery record</summary>
        <p><b>Original evidence:</b> ${esc(run.baseline?.evidence || '—')}</p>
        <p><b>Preview:</b> ${run.preview_url ? `<a href="${esc(run.preview_url)}" target="_blank" rel="noopener">${esc(run.preview_url)}</a>` : '—'} · <b>Deployment:</b> ${esc(run.deployment_id || '—')}</p>
        <h4>Quality gates</h4><div class="table-wrap"><table class="tbl"><thead><tr><th>Check</th><th>Result</th><th>Evidence</th></tr></thead><tbody>${improvementChecks(validation)}</tbody></table></div>
        ${validation?.browser?.screenshots?.['production.png']?.status === 'pass' && validation?.browser?.screenshots?.['preview.png']?.status === 'pass' ? `<h4>Captured visual comparison</h4><div class="improvement-visual-compare"><figure><figcaption>Production baseline</figcaption><img src="/api/improvements/${esc(run.run_id)}/artifacts/production.png" alt="Production screenshot"></figure><figure><figcaption>Improvement preview</figcaption><img src="/api/improvements/${esc(run.run_id)}/artifacts/preview.png" alt="Improvement preview screenshot"></figure></div>` : run.preview_url && ['review', 'building'].includes(run.state) ? `<h4>Live visual review</h4><div class="improvement-live-review" data-review-site="${esc(run.site)}" data-review-preview="${esc(run.preview_url)}"><p class="improvement-review-placeholder muted">Open this evidence panel to load the production and preview frames.</p></div>` : ''}
        <p><b>Outcome:</b> ${outcome.classification ? `<span class="badge ${outcome.classification === 'proven' ? 'b-green' : outcome.classification === 'regressed' ? 'b-red' : 'b-yellow'}">${esc(outcome.classification)}</span> · confidence ${esc(outcome.confidence || '—')}` : '<span class="muted">not measured</span>'}</p>
        <div class="improvement-live muted">Open to load worktree diff, agent log, and event timeline.</div>
      </details>
    </article>`;
    })
    .join('');
  const active = all.filter(run => !IMPROVEMENT_TERMINAL.has(run.state)).length;
  app.innerHTML = `<div class="page-head"><div><h2 class="page-title">Site Improvements</h2><div class="crumbs">Recommendation → task → build → review → deploy → measured outcome</div></div><button type="button" id="improvements-refresh" class="btn">↻ Refresh</button></div>
    <section class="seo-stats"><div class="seo-stat"><div class="seo-stat-value">${active}</div><div class="seo-stat-label">Active</div></div><div class="seo-stat"><div class="seo-stat-value">${data.totals?.proven || 0}</div><div class="seo-stat-label">Proven</div></div><div class="seo-stat"><div class="seo-stat-value">${data.totals?.regressed || 0}</div><div class="seo-stat-label">Regressed</div></div><div class="seo-stat"><div class="seo-stat-value">${all.length}</div><div class="seo-stat-label">All runs</div></div></section>
    <div class="task-toolbar"><select id="improvement-state" class="cm-input" aria-label="Filter improvement runs by state"><option value="active">Active</option><option value="all">All runs</option>${(data.states || []).map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}</select><span class="muted">State changes are explicit and recorded in the causal event graph.</span></div>
    ${pageCount > 1 ? `<nav class="improvement-pagination" aria-label="Improvement run pages"><button type="button" class="btn sm" id="improvements-prev" ${IMPROVEMENT_PAGE === 1 ? 'disabled' : ''}>← Previous</button><span class="muted" id="improvements-page-status" role="status">Showing ${pageStart + 1}–${Math.min(pageStart + IMPROVEMENT_PAGE_SIZE, runs.length)} of ${runs.length} runs · Page ${IMPROVEMENT_PAGE} of ${pageCount}</span><button type="button" class="btn sm" id="improvements-next" ${IMPROVEMENT_PAGE === pageCount ? 'disabled' : ''}>Next →</button></nav>` : ''}
    ${cards || '<div class="empty">No improvement runs in this view. Start one from Priorities.</div>'}`;
  $('#improvements-refresh').addEventListener('click', () => renderImprovements());
  $('#improvement-state').value = IMPROVEMENT_STATE;
  $('#improvement-state').addEventListener('change', e => {
    IMPROVEMENT_STATE = e.target.value;
    IMPROVEMENT_PAGE = 1;
    softRender();
  });
  $('#improvements-prev')?.addEventListener('click', () => {
    IMPROVEMENT_PAGE = Math.max(1, IMPROVEMENT_PAGE - 1);
    softRender();
  });
  $('#improvements-next')?.addEventListener('click', () => {
    IMPROVEMENT_PAGE = Math.min(pageCount, IMPROVEMENT_PAGE + 1);
    softRender();
  });
  $$('.improvement-transition').forEach(button =>
    button.addEventListener('click', async () => {
      const state = button.dataset.state;
      if (state === 'building' && button.textContent.includes('sandbox')) {
        button.disabled = true;
        try {
          await api('POST', `/api/improvements/${encodeURIComponent(button.dataset.id)}/build`, {});
          toast('Branch and sandbox ready');
          softRender();
        } catch (e) {
          button.disabled = false;
          toast(e.message, 'err');
        }
        return;
      }
      const payload = { state };
      if (state === 'review') {
        payload.preview_url =
          (await globalThis.fleetTextPrompt?.({
            title: 'Preview URL',
            label: 'Optional preview URL',
            placeholder: 'https://preview.example.com',
            submitLabel: 'Continue',
          })) || null;
      }
      if (state === 'deployed') {
        const deployment = await globalThis.fleetTextPrompt?.({
          title: 'Record deployment',
          label: 'Deployment ID or production commit SHA',
          required: true,
          submitLabel: 'Record deployment',
        });
        if (!deployment) return;
        payload.deployment_id = deployment;
      }
      if (['proven', 'regressed', 'inconclusive'].includes(state)) {
        const notes = await globalThis.fleetTextPrompt?.({
          title: 'Record measured outcome',
          label: 'Measured outcome and supporting metric change',
          required: true,
          submitLabel: 'Record outcome',
        });
        if (!notes) return;
        payload.outcome = { measured_at: new Date().toISOString(), notes };
      }
      button.disabled = true;
      try {
        await api(
          'POST',
          `/api/improvements/${encodeURIComponent(button.dataset.id)}/transition`,
          payload
        );
        toast(`Moved to ${state}`);
        softRender();
      } catch (e) {
        button.disabled = false;
        toast(e.message, 'err');
      }
    })
  );
  $$('.improvement-validate').forEach(button =>
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Validating…';
      try {
        const result = await api(
          'POST',
          `/api/improvements/${encodeURIComponent(button.dataset.id)}/validate`,
          {}
        );
        toast(
          result.validation.passed ? 'All quality gates passed' : 'Quality gates found issues',
          result.validation.passed ? '' : 'err'
        );
        softRender();
      } catch (e) {
        button.disabled = false;
        button.textContent = 'Run quality gates';
        toast(e.message, 'err');
        softRender();
      }
    })
  );
  $$('.improvement-measure').forEach(button =>
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await api(
          'POST',
          `/api/improvements/${encodeURIComponent(button.dataset.id)}/measure`,
          {}
        );
        toast(`Outcome: ${result.outcome.classification}`);
        softRender();
      } catch (e) {
        button.disabled = false;
        toast(e.message, 'err');
      }
    })
  );
  $$('.improvement-agent').forEach(button =>
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api('POST', `/api/improvements/${encodeURIComponent(button.dataset.id)}/agent`, {});
        toast('Agent started in isolated worktree');
        softRender();
      } catch (e) {
        button.disabled = false;
        toast(e.message, 'err');
      }
    })
  );
  $$('.improvement-commit').forEach(button =>
    button.addEventListener('click', async () => {
      const message = await globalThis.fleetTextPrompt?.({
        title: 'Commit reviewed changes',
        label: 'Commit message for the reviewed worktree changes',
        required: true,
        submitLabel: 'Commit changes',
      });
      if (!message) return;
      button.disabled = true;
      try {
        await api('POST', `/api/improvements/${encodeURIComponent(button.dataset.id)}/commit`, {
          message,
        });
        toast('Improvement changes committed');
        softRender();
      } catch (e) {
        button.disabled = false;
        toast(e.message, 'err');
      }
    })
  );
  $$('.improvement-deploy').forEach(button =>
    button.addEventListener('click', async () => {
      const confirmTitle = await globalThis.fleetTextPrompt?.({
        title: 'Approve production deployment',
        label: `Type the exact improvement title: ${button.dataset.title}`,
        placeholder: button.dataset.title,
        required: true,
        submitLabel: 'Approve deployment',
      });
      if (confirmTitle !== button.dataset.title)
        return toast('Deployment confirmation did not match', 'err');
      button.disabled = true;
      try {
        await api('POST', `/api/improvements/${encodeURIComponent(button.dataset.id)}/deploy`, {
          confirm: confirmTitle,
        });
        toast('Deployed; outcome measurement scheduled');
        softRender();
      } catch (e) {
        button.disabled = false;
        toast(e.message, 'err');
      }
    })
  );
  $$('.improvement-rollback').forEach(button =>
    button.addEventListener('click', async () => {
      const confirmTitle = await globalThis.fleetTextPrompt?.({
        title: 'Approve production rollback',
        label: `This creates and pushes a production revert. Type the exact title: ${button.dataset.title}`,
        placeholder: button.dataset.title,
        required: true,
        submitLabel: 'Approve rollback',
      });
      if (confirmTitle !== button.dataset.title)
        return toast('Rollback confirmation did not match', 'err');
      button.disabled = true;
      try {
        await api('POST', `/api/improvements/${encodeURIComponent(button.dataset.id)}/rollback`, {
          confirm: confirmTitle,
        });
        toast('Rollback committed and pushed');
        softRender();
      } catch (e) {
        button.disabled = false;
        toast(e.message, 'err');
      }
    })
  );
  $$('.improvement-detail').forEach(details =>
    details.addEventListener('toggle', async () => {
      if (!details.open || details.dataset.loaded === '1') return;
      const review = $('.improvement-live-review[data-review-preview]', details);
      if (review && review.dataset.loaded !== '1') {
        const productionUrl = safeHref(`https://${review.dataset.reviewSite}/`);
        const previewUrl = safeHref(review.dataset.reviewPreview);
        review.innerHTML =
          productionUrl && previewUrl
            ? `<div><b>Production</b><iframe title="Production before improvement" loading="lazy" src="${esc(productionUrl)}"></iframe></div><div><b>Improvement preview</b><iframe title="Improvement preview" loading="lazy" src="${esc(previewUrl)}"></iframe></div>`
            : '<p class="improvement-review-placeholder muted">Visual review URLs are unavailable for this run.</p>';
        review.dataset.loaded = '1';
      }
      const box = $('.improvement-live', details);
      box.textContent = 'Loading delivery evidence…';
      try {
        const detail = await api(
          'GET',
          `/api/improvements/${encodeURIComponent(details.dataset.id)}`
        );
        const files =
          (detail.workspace?.files || []).map(f => `${f.code || ''} ${f.path}`).join('\n') ||
          '(clean worktree)';
        const timeline = (detail.events || [])
          .map(e => `${fmtDate(e.occurred_at)}  ${e.event_type}`)
          .join('\n');
        box.innerHTML = `<h4>Worktree</h4><pre class="cn-logs-box">${esc(detail.workspace?.diff_stat || '')}\n${esc(files)}</pre><h4>Code/content diff${detail.diff?.truncated ? ' (truncated)' : ''}</h4><pre class="cn-logs-box">${esc(detail.diff?.text || '(no uncommitted diff; review the recorded commit)')}</pre><h4>Agent · ${esc(detail.agent?.status || 'not started')}</h4><pre class="cn-logs-box">${esc(detail.agent?.log_tail || '(no agent output)')}</pre><h4>Timeline</h4><pre class="cn-logs-box">${esc(timeline)}</pre>`;
        details.dataset.loaded = '1';
      } catch (e) {
        box.textContent = e.message;
      }
    })
  );
  applyFleetFilter();
  if (!FRESH) applyUISnap();
  stamp();
}

let CHANGE_QUEUE_RECORDER = null;
let CHANGE_QUEUE_CHUNKS = [];
let CHANGE_QUEUE_FILTER = { q: '', status: 'all', site: 'all', priority: 'all', provider: 'all' };
let CHANGE_QUEUE_DETAIL = null;
let CHANGE_QUEUE_RENDERING = false;
let CHANGE_QUEUE_PAGE = 1;
let CHANGE_QUEUE_PAGE_SIZE = 10;
let CHANGE_QUEUE_SORT = 'urgency';
let CHANGE_QUEUE_SORT_DIR = 'desc';
let CHANGE_QUEUE_OWNER = 'all';
let CHANGE_QUEUE_VIEW = 'attention';
let CHANGE_QUEUE_NEXT_PICKUP_AT = 0;
let CHANGE_QUEUE_CLOCK = null;

function cqAge(value) {
  const ms = Date.now() - new Date(value || 0).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function cqAgeTone(value, status) {
  if (['claimed', 'running', 'reviewing', 'delivery_pending'].includes(status)) return 'working';
  const ms = Date.now() - new Date(value || 0).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ms >= 60 * 60 * 1000 ? 'old' : ms >= 15 * 60 * 1000 ? 'aging' : '';
}

function cqWorkLabel(r) {
  if (r.work?.active)
    return r.work.state === 'claimed' ? 'Claimed · starting' : `Working · ${r.work.state}`;
  if (r.status === 'queued')
    return r.queue_block?.blocked ? 'Waiting · blocked' : 'Waiting · eligible';
  if (r.status === 'review') return 'Waiting · review';
  if (r.status === 'needs_repair') return 'Waiting · repair';
  if (r.status === 'blocked_infrastructure') return 'Blocked · infrastructure';
  return `Finished · ${r.status}`;
}

function cqStatusClass(status) {
  if (['deployed', 'verified', 'committed'].includes(status)) return 'b-green';
  if (['failed', 'cancelled'].includes(status)) return 'b-red';
  if (['blocked_owner', 'blocked_infrastructure', 'needs_human_review'].includes(status))
    return 'b-yellow';
  if (['review', 'reviewing', 'delivery_pending', 'needs_repair'].includes(status))
    return 'b-yellow';
  return 'b-blue';
}

function cqNextAction(r, settings) {
  const age = Date.now() - new Date(r.created_at || 0).getTime();
  const staleQueue =
    r.status === 'queued' && age > Math.max(10, Number(settings.interval_minutes || 1) * 2) * 60000;
  if (r.status === 'queued') {
    if (r.queue_block?.blocked) return r.queue_block.primary.label;
    return staleQueue ? 'Investigate pickup delay' : 'Dispatch when capacity is available';
  }
  if (r.status === 'claimed') return 'Confirm worker started';
  if (r.status === 'running') return 'Monitor implementation and lease';
  if (r.status === 'reviewing') return 'Wait for quality gates';
  if (r.status === 'review') return 'Run review and deliver';
  if (r.status === 'delivery_pending') return 'Run deterministic delivery';
  if (r.status === 'needs_repair') return 'Repair implementation, then review again';
  if (r.status === 'failed') return 'Inspect failure, then retry';
  if (r.status === 'blocked_owner') return 'Install or assign a site owner';
  if (r.status === 'blocked_infrastructure') return 'Repair infrastructure, then retry';
  if (r.status === 'needs_human_review') return 'Human review required';
  if (r.status === 'cancelled') return 'Replace or close request';
  if (['deployed', 'verified', 'committed'].includes(r.status)) return 'Measure outcome';
  return 'Open request details';
}

function cqSiteContext(r) {
  const context = r.site_context || {};
  return `<div class="cq-site-context"><span class="cq-domain">${siteLink(r.site || context.domain)}</span><span class="cq-site-purpose">${esc(context.description || 'Site purpose not recorded')}</span></div>`;
}

function cqBlocker(r) {
  if (!r.queue_block?.blocked) return '';
  const reasons = (r.queue_block.reasons || [])
    .slice(1)
    .map(reason => reason.label)
    .join(' · ');
  const escalation = r.queue_block.escalated ? ' · Escalation threshold reached' : '';
  const next = r.queue_block.next_check_at
    ? ` · Recheck ${fmtDate(r.queue_block.next_check_at)}`
    : '';
  const due =
    r.queue_block.primary.code === 'measurement_window' && r.measurement_window?.due_at
      ? ` · Ends ${fmtDate(r.measurement_window.due_at)}`
      : '';
  const override =
    r.queue_block.primary.code === 'measurement_window' && !r.measurement_override
      ? `<button type="button" class="btn sm cq-override-measurement" data-id="${esc(r.request_id)}" aria-label="Override measurement window for ${esc(r.title)}" title="Start this request before the measurement window ends">Override window</button>`
      : r.measurement_override
        ? '<span class="badge b-blue">override enabled</span>'
        : '';
  return `<div class="cq-blocker"><span class="badge ${r.queue_block.escalated ? 'b-red' : 'b-yellow'}">blocked</span><span><b>${esc(r.queue_block.primary.label)}</b><small>${esc(r.queue_block.primary.detail)}${due}${reasons ? ` · Also: ${esc(reasons)}` : ''}${escalation}${next}</small></span>${override}</div>`;
}

function cqActionButtons(r) {
  const id = esc(r.request_id);
  const title = esc(r.title);
  const manage = `<button type="button" class="btn sm cq-detail" data-id="${id}" aria-label="Open actions for ${title}" title="Open inline actions, request details, and timeline">Actions</button>`;
  if (r.status === 'queued')
    return `${manage} <button type="button" class="btn sm primary cq-pick" data-id="${id}" aria-label="Dispatch ${title}" title="Dispatch ${title}">Dispatch</button> <button type="button" class="btn sm cq-reevaluate" data-id="${id}" aria-label="Re-evaluate ${title}" title="Re-check capacity and site locks without bypassing safety rules">Re-evaluate</button>`;
  if (['review', 'needs_repair'].includes(r.status))
    return `${manage} <button type="button" class="btn sm primary cq-auto-review" data-id="${id}" aria-label="Review and deliver ${title}" title="Review and deliver ${title}">Review & deliver</button>`;
  if (r.status === 'failed')
    return `${manage} <button type="button" class="btn sm primary cq-retry" data-id="${id}" aria-label="Retry ${title}" title="Retry ${title}">Retry</button>`;
  if (['blocked_owner', 'blocked_infrastructure', 'needs_human_review'].includes(r.status))
    return `${manage} <button type="button" class="btn sm primary cq-retry" data-id="${id}" aria-label="Retry ${title}" title="Retry ${title}">Retry</button>`;
  if (
    ['queued', 'claimed', 'running', 'reviewing', 'delivery_pending', 'review'].includes(r.status)
  )
    return `${manage} <button type="button" class="btn sm danger cq-cancel" data-id="${id}" aria-label="Cancel ${title}" title="Cancel ${title}">Cancel</button>`;
  return manage;
}

function cqRequestRow(r, settings, compact = false) {
  const ageBase = r.created_at || r.updated_at;
  const activeWork = r.work?.active;
  return `<tr data-fleet-row data-site="${esc(r.site)}"><td><span class="badge ${r.priority === 'high' ? 'b-red' : r.priority === 'medium' ? 'b-yellow' : 'b-blue'}">${esc(r.priority || 'normal')}</span></td><td class="cq-request-cell"><b>${esc(r.title)}</b>${cqSiteContext(r)}<div class="muted">${esc(r.category || 'general')} · ${esc(r.assigned_role || 'engineer')}</div><div class="cq-age-line"><time datetime="${esc(r.created_at || '')}">Added ${esc(fmtDate(r.created_at))}</time><span class="cq-age ${cqAgeTone(ageBase, r.status)}" data-cq-age="${esc(ageBase || '')}">${esc(cqAge(ageBase))} old</span></div>${r.error ? `<div class="error-text">${esc(r.error)}</div>` : ''}</td><td><span class="badge ${cqStatusClass(r.status)}">${esc(r.status)}</span>${activeWork ? `<div class="cq-working-badge"><i></i>${esc(cqWorkLabel(r))}</div>` : ''}${cqBlocker(r)}<div class="muted">${esc(cqNextAction(r, settings))}</div></td><td>${esc(r.assigned_role || 'engineer')}<div class="muted">${esc(r.provider || '—')}</div>${activeWork ? `<div class="cq-worker-meta">worker ${esc(r.work.worker || 'dashboard')} · heartbeat ${esc(cqAge(r.work.heartbeat_at))} ago</div>` : ''}</td><td>${compact ? `<button type="button" class="btn sm cq-detail" data-id="${esc(r.request_id)}" aria-label="Open actions for ${esc(r.title)}" title="Open actions for ${esc(r.title)}">Manage</button>` : cqActionButtons(r)}</td></tr>`;
}

function cqExceptionProfile(r) {
  const text = `${r.error || ''} ${r.title || ''}`;
  if (/No such container|worker process|agent exited/i.test(text))
    return {
      label: 'Worker / infrastructure failure',
      next: 'Retry once after the worker health check passes.',
    };
  if (/quality gates|Playwright|Chromium|thread|WebSocket|missing Astro module/i.test(text))
    return {
      label: 'Validation or tooling failure',
      next: 'Fix the dependency or validation gate, then retry.',
    };
  if (/reviewer rejected/i.test(text))
    return {
      label: 'Reviewer decision',
      next: 'Read the reviewer evidence and correct the request or diff.',
    };
  return { label: 'Unclassified failure', next: 'Open the run details before retrying.' };
}

function cqExceptionCard(r) {
  const profile = cqExceptionProfile(r);
  return `<article class="cq-exception-card"><div class="cq-exception-head"><span class="badge b-red">failed</span><span class="muted">${esc(cqAge(r.updated_at || r.created_at))} old</span></div><strong>${esc(r.title)}</strong><div class="muted">${esc(r.site)} · ${esc(r.assigned_role || 'engineer')} · ${esc(r.provider || '—')}</div><p><b>${esc(profile.label)}</b><br>${esc(r.error || 'The request failed before delivery evidence was recorded.')}</p><div class="muted">Next: ${esc(profile.next)}</div><div class="cq-exception-actions"><button type="button" class="btn sm primary cq-retry" data-id="${esc(r.request_id)}" aria-label="Retry ${esc(r.title)}" title="Retry ${esc(r.title)}">Retry</button><button type="button" class="btn sm cq-detail" data-id="${esc(r.request_id)}" aria-label="Open actions for ${esc(r.title)}" title="Open actions for ${esc(r.title)}">Actions</button></div></article>`;
}

async function renderChangeQueue({ background = false } = {}) {
  if (CHANGE_QUEUE_RENDERING) return;
  CHANGE_QUEUE_RENDERING = true;
  if (FRESH && !background)
    app.innerHTML =
      '<div class="loading" role="status" aria-live="polite">Loading change queue…</div>';
  let data;
  try {
    data = await api('GET', '/api/change-requests');
  } catch (e) {
    if (!background) renderViewError(app, e.message);
    CHANGE_QUEUE_RENDERING = false;
    return;
  }
  const requests = data.requests || [];
  const queued = requests.filter(r => r.status === 'queued');
  const blocked = queued.filter(r => r.queue_block?.blocked).length;
  const active = requests.filter(r =>
    ['claimed', 'running', 'reviewing', 'delivery_pending', 'review', 'needs_repair'].includes(
      r.status
    )
  );
  const working = requests.filter(r => r.work?.active);
  // Only surface recoverable exceptions here. Cancelled requests are historical
  // outcomes, not active interventions; failed requests have a direct retry path.
  const attention = requests.filter(r =>
    ['failed', 'blocked_infrastructure', 'needs_repair', 'needs_human_review'].includes(r.status)
  );
  const deliveryMetrics = data.delivery_metrics || { windows: {} };
  const throughput = deliveryMetrics.windows || {};
  const capacity = Number(data.settings.max_concurrent || 1);
  const staleQueued = queued.filter(
    r =>
      Date.now() - new Date(r.created_at || 0).getTime() >
      Math.max(10, Number(data.settings.interval_minutes || 1) * 2) * 60000
  );
  const isStale = r =>
    r.status === 'queued' &&
    Date.now() - new Date(r.created_at || 0).getTime() >
      Math.max(10, Number(data.settings.interval_minutes || 1) * 2) * 60000;
  const isOpen = r => !['deployed', 'verified', 'committed', 'cancelled'].includes(r.status);
  const viewMatches = r => {
    if (CHANGE_QUEUE_VIEW === 'all') return true;
    if (CHANGE_QUEUE_VIEW === 'queued') return r.status === 'queued';
    if (CHANGE_QUEUE_VIEW === 'active')
      return [
        'claimed',
        'running',
        'reviewing',
        'delivery_pending',
        'review',
        'needs_repair',
      ].includes(r.status);
    if (CHANGE_QUEUE_VIEW === 'failed')
      return ['failed', 'blocked_infrastructure', 'needs_repair', 'needs_human_review'].includes(
        r.status
      );
    if (CHANGE_QUEUE_VIEW === 'shipped')
      return ['deployed', 'verified', 'committed'].includes(r.status);
    return r.status === 'failed' || isStale(r) || (r.priority === 'high' && isOpen(r));
  };
  const health = !data.settings.enabled
    ? ['Paused', 'warn']
    : staleQueued.length
      ? ['Attention', 'warn']
      : active.length
        ? ['Operating', 'good']
        : queued.length
          ? ['Ready', 'info']
          : ['Idle', 'good'];
  const siteOptions = (STATE.sites || [])
    .map(
      s =>
        `<option value="${esc(typeof s === 'string' ? s : s.slug)}">${esc(typeof s === 'string' ? s : s.slug)}</option>`
    )
    .join('');
  const sites = [...new Set(requests.map(r => r.site))].sort();
  const matches = r =>
    viewMatches(r) &&
    (!CHANGE_QUEUE_FILTER.q ||
      `${r.title} ${r.body} ${r.site} ${r.assigned_role || ''}`
        .toLowerCase()
        .includes(CHANGE_QUEUE_FILTER.q.toLowerCase())) &&
    (CHANGE_QUEUE_FILTER.status === 'all' || r.status === CHANGE_QUEUE_FILTER.status) &&
    (CHANGE_QUEUE_FILTER.site === 'all' || r.site === CHANGE_QUEUE_FILTER.site) &&
    (CHANGE_QUEUE_FILTER.priority === 'all' || r.priority === CHANGE_QUEUE_FILTER.priority) &&
    (CHANGE_QUEUE_FILTER.provider === 'all' || r.provider === CHANGE_QUEUE_FILTER.provider) &&
    (CHANGE_QUEUE_OWNER === 'all' || (r.assigned_role || 'engineer') === CHANGE_QUEUE_OWNER);
  const filteredRequests = requests.filter(matches);
  const urgencyValue = r =>
    r.status === 'failed'
      ? 5
      : isStale(r)
        ? 4
        : r.priority === 'high'
          ? 3
          : ['review', 'reviewing', 'delivery_pending', 'needs_repair'].includes(r.status)
            ? 2
            : r.status === 'queued'
              ? 1
              : 0;
  const sortValue = r =>
    CHANGE_QUEUE_SORT === 'urgency'
      ? urgencyValue(r)
      : CHANGE_QUEUE_SORT === 'priority'
        ? { high: 3, medium: 2, low: 1 }[r.priority] || 0
        : CHANGE_QUEUE_SORT === 'status'
          ? r.status
          : CHANGE_QUEUE_SORT === 'site'
            ? r.site
            : CHANGE_QUEUE_SORT === 'owner'
              ? r.assigned_role || 'engineer'
              : CHANGE_QUEUE_SORT === 'provider'
                ? r.provider || ''
                : new Date(r.updated_at || r.created_at || 0).getTime();
  const sortedRequests = [...filteredRequests].sort((a, b) => {
    const av = sortValue(a),
      bv = sortValue(b);
    const result =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv));
    if (CHANGE_QUEUE_SORT === 'urgency' && result === 0) {
      const ageA = new Date(a.updated_at || a.created_at || 0).getTime();
      const ageB = new Date(b.updated_at || b.created_at || 0).getTime();
      return ageA - ageB;
    }
    return CHANGE_QUEUE_SORT_DIR === 'asc' ? result : -result;
  });
  const pageCount = Math.max(1, Math.ceil(sortedRequests.length / CHANGE_QUEUE_PAGE_SIZE));
  CHANGE_QUEUE_PAGE = Math.min(CHANGE_QUEUE_PAGE, pageCount);
  const pageStart = (CHANGE_QUEUE_PAGE - 1) * CHANGE_QUEUE_PAGE_SIZE;
  const pageRows = sortedRequests.slice(pageStart, pageStart + CHANGE_QUEUE_PAGE_SIZE);
  const rows = pageRows.map(r => cqRequestRow(r, data.settings)).join('');
  const owners = [...new Set(requests.map(r => r.assigned_role || 'engineer'))].sort();
  const pageLabel = sortedRequests.length
    ? `${pageStart + 1}–${Math.min(pageStart + CHANGE_QUEUE_PAGE_SIZE, sortedRequests.length)} of ${sortedRequests.length}`
    : '0 of 0';
  const pipeline = [
    ['queued', 'Ready', queued.length, 'var(--a1)'],
    ['active', 'In flight', active.length, 'var(--a3)'],
    [
      'review',
      'Review',
      requests.filter(r =>
        ['review', 'reviewing', 'delivery_pending', 'needs_repair'].includes(r.status)
      ).length,
      'var(--a2)',
    ],
    ['done', 'Shipped (month)', throughput.month_to_date?.shipped || 0, 'var(--green)'],
  ];
  if (!CHANGE_QUEUE_NEXT_PICKUP_AT || CHANGE_QUEUE_NEXT_PICKUP_AT < Date.now())
    CHANGE_QUEUE_NEXT_PICKUP_AT = Date.now() + Number(data.settings.interval_minutes || 30) * 60000;
  const workingCards = working
    .map(
      r =>
        `<article class="cq-working-card"><div class="cq-working-card-head"><span class="cq-working-badge"><i></i>${esc(cqWorkLabel(r))}</span><span class="cq-age working" data-cq-age="${esc(r.work.since || r.created_at || '')}">${esc(cqAge(r.work.since || r.created_at))}</span></div><strong>${esc(r.title)}</strong><div class="muted">${esc(r.site)} · ${esc(r.assigned_role || 'engineer')} · worker ${esc(r.work.worker || 'dashboard')}</div><div class="cq-working-card-foot"><span>Started ${esc(fmtDate(r.work.since || r.created_at))}</span><span>Heartbeat ${esc(cqAge(r.work.heartbeat_at))} ago</span><button type="button" class="btn sm cq-detail" data-id="${esc(r.request_id)}" aria-label="View work for ${esc(r.title)}" title="View work for ${esc(r.title)}">View work</button></div></article>`
    )
    .join('');
  app.innerHTML = `<div class="page-head cq-page-head"><div><div class="cq-eyebrow">OPERATIONS CONTROL PLANE</div><h2 class="page-title">Change Queue</h2><div class="crumbs">One place to decide what needs attention, what is moving, and what is safe to leave alone.</div></div><div class="cq-head-actions"><span class="cq-health ${health[1]}"><i></i>${health[0]}</span><button type="button" class="btn primary" id="cq-new" aria-label="Create a new change request">New change request</button></div></div>
    <section class="cq-command-strip"><div class="cq-command-main"><div class="cq-eyebrow">AUTOMATION</div><div class="cq-command-title"><label class="cq-switch"><input type="checkbox" id="cq-enabled" aria-label="${data.settings.enabled ? 'Pause automatic dispatch' : 'Resume automatic dispatch'}" ${data.settings.enabled ? 'checked' : ''}><span></span></label><div><strong>${data.settings.enabled ? 'Automatic dispatch is on' : 'Automatic dispatch is paused'}</strong><p>${data.settings.enabled ? 'The dispatcher will pick up eligible work automatically.' : 'Nothing will start until you dispatch it manually or resume automation.'}</p></div></div></div><div class="cq-command-stat"><span>Next pickup</span><strong id="cq-next-pickup">calculating…</strong><small>every ${esc(data.settings.interval_minutes)} min</small></div><div class="cq-command-stat"><span>Capacity</span><strong>${active.length}<em> / ${capacity}</em></strong><small>${capacity - active.length > 0 ? `${capacity - active.length} slot${capacity - active.length === 1 ? '' : 's'} open` : 'at capacity'}</small></div><div class="cq-command-stat"><span>Blocked</span><strong>${blocked}</strong><small>${data.queue_metrics?.oldest_blocked_at ? `oldest ${cqAge(data.queue_metrics.oldest_blocked_at)}` : 'none'}</small></div><button type="button" class="btn sm" id="cq-pickup-all" aria-label="Dispatch due work — dispatch all due change requests">Dispatch due work</button></section>
    <section class="card cq-working-panel"><div class="cq-section-head"><div><div class="cq-eyebrow">LIVE WORK</div><h3>Currently being worked</h3><p class="muted">Claimed, running, and reviewing requests with their worker and heartbeat.</p></div><span class="cq-live-count ${working.length ? 'is-working' : ''}"><i></i>${working.length ? `${working.length} active` : 'Nothing active'}</span></div><div class="cq-working-list">${workingCards || '<div class="cq-no-work"><strong>No request is being worked right now.</strong><span>The queue is idle or waiting for eligible work.</span></div>'}</div></section>
    <section class="cq-overview-grid cq-overview-grid--single"><aside class="card cq-status-panel"><div class="cq-section-head"><div><div class="cq-eyebrow">QUEUE PULSE</div><h3>Work at a glance</h3></div><span class="muted">${requests.length} total</span></div><div class="cq-pipeline">${pipeline.map(([key, label, count, color]) => `<div class="cq-pipeline-step"><i style="--step-color:${color}"></i><strong>${count}</strong><span>${label}</span></div>`).join('')}</div>${blocked ? `<div class="cq-status-note warn"><span class="cq-dot warn"></span><div><strong>${blocked} queued request${blocked === 1 ? '' : 's'} blocked — not failed</strong><small>These requests have no error; capacity, another run, or a measurement window is holding them. Open a queued row for the exact reason.</small></div></div>` : ''}${attention.length ? `<div class="cq-status-note warn"><span class="cq-dot warn"></span><div><strong>${attention.length} request${attention.length === 1 ? '' : 's'} actually failed</strong><small>Failed work is separate from blocked queue work. Open the failed view to see the recorded reason and retry path.</small></div></div>` : ''}<div class="cq-status-note ${data.settings.auto_review_enabled === false ? 'warn' : ''}"><span class="cq-dot ${data.settings.auto_review_enabled === false ? 'warn' : 'good'}"></span><div><strong>Automatic review ${data.settings.auto_review_enabled === false ? 'off' : 'on'}</strong><small>${data.settings.auto_review_enabled === false ? 'Review items manually before delivery.' : 'Eligible work moves through validation automatically.'}</small></div></div><details class="cq-policy"><summary>Dispatch policy <span>＋</span></summary><div class="task-toolbar"><label class="muted">Every <input id="cq-interval" type="number" min="1" max="1440" value="${esc(data.settings.interval_minutes)}"> min</label><label class="muted">Concurrency <input id="cq-concurrency" type="number" min="1" max="10" value="${esc(data.settings.max_concurrent)}"></label><label class="muted">Lease <input id="cq-lease-minutes" type="number" min="5" max="1440" value="${esc(data.settings.lease_minutes || 30)}"> min</label><label class="muted">Auto reviewer <input type="checkbox" id="cq-auto-review-enabled" ${data.settings.auto_review_enabled !== false ? 'checked' : ''}></label><button class="btn sm" id="cq-save-settings">Save policy</button></div></details></aside></section><section class="card cq-throughput"><div class="cq-section-head"><div><div class="cq-eyebrow">DELIVERY THROUGHPUT</div><h3>Actually shipped</h3><p class="muted">Deployed changes only · as of ${esc(fmtDate(deliveryMetrics.as_of))}</p></div><span class="muted">${esc(deliveryMetrics.definition || '')}</span></div><div class="cq-throughput-grid">${[
      ['24h', 'Last 24 hours'],
      ['2d', 'Last 2 days'],
      ['5d', 'Last 5 days'],
      ['month_to_date', throughput.month_to_date?.label || 'Month to date'],
    ]
      .map(([key, label]) => {
        const item = throughput[key] || {};
        return `<div class="cq-throughput-stat"><strong>${item.shipped || 0}</strong><span>shipped · ${esc(label)}</span><small>${item.verified || 0} verified · ${item.failed || 0} failed${item.success_rate == null ? '' : ` · ${item.success_rate}% terminal success`}</small></div>`;
      })
      .join('')}</div></section>
    <section class="card cq-register"><div class="cq-register-head"><div><div class="cq-eyebrow">WORK REGISTER</div><h3>All change requests</h3><p>Search the full history when you need context. The focus lane above is reserved for decisions.</p></div><span class="muted">${filteredRequests.length} matching · ${pageLabel}</span></div><div class="cq-register-toolbar"><div class="cq-filter-group"><input id="cq-search" class="cm-input" placeholder="Search title, site, role…" value="${esc(CHANGE_QUEUE_FILTER.q)}"><select id="cq-status" class="cm-input" title="Filter by state"><option value="all">All states</option>${data.statuses.map(x => `<option value="${x}" ${CHANGE_QUEUE_FILTER.status === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select><select id="cq-site-filter" class="cm-input" title="Filter by site"><option value="all">All sites</option>${sites.map(x => `<option value="${esc(x)}" ${CHANGE_QUEUE_FILTER.site === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select><select id="cq-priority-filter" class="cm-input" title="Filter by priority"><option value="all" ${CHANGE_QUEUE_FILTER.priority === 'all' ? 'selected' : ''}>All priorities</option>${['high', 'medium', 'low'].map(x => `<option value="${x}" ${CHANGE_QUEUE_FILTER.priority === x ? 'selected' : ''}>${x}</option>`).join('')}</select><select id="cq-owner-filter" class="cm-input" title="Filter by owner"><option value="all">All owners</option>${owners.map(x => `<option value="${esc(x)}" ${CHANGE_QUEUE_OWNER === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select><select id="cq-provider-filter" class="cm-input" title="Filter by provider"><option value="all">All providers</option>${data.providers.map(x => `<option value="${x}" ${CHANGE_QUEUE_FILTER.provider === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div><div class="cq-sort-group"><label class="cq-filter-label" for="cq-sort">Sort</label><select id="cq-sort" class="cm-input"><option value="created_at" ${CHANGE_QUEUE_SORT === 'created_at' ? 'selected' : ''}>Recent activity</option><option value="priority" ${CHANGE_QUEUE_SORT === 'priority' ? 'selected' : ''}>Priority</option><option value="status" ${CHANGE_QUEUE_SORT === 'status' ? 'selected' : ''}>State</option><option value="site" ${CHANGE_QUEUE_SORT === 'site' ? 'selected' : ''}>Site</option><option value="owner" ${CHANGE_QUEUE_SORT === 'owner' ? 'selected' : ''}>Owner</option><option value="provider" ${CHANGE_QUEUE_SORT === 'provider' ? 'selected' : ''}>Provider</option></select><button class="btn sm" id="cq-sort-dir" title="Toggle sort direction">${CHANGE_QUEUE_SORT_DIR === 'asc' ? '↑ Ascending' : '↓ Descending'}</button></div></div><div class="table-wrap"><table class="tbl cq-table"><thead><tr><th>Priority</th><th>Request</th><th>State / next action</th><th>Owner</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">No requests match these filters.</td></tr>'}</tbody></table></div><div class="cq-pagination"><label class="muted">Rows <select id="cq-page-size" class="cm-input"><option ${CHANGE_QUEUE_PAGE_SIZE === 10 ? 'selected' : ''}>10</option><option ${CHANGE_QUEUE_PAGE_SIZE === 25 ? 'selected' : ''}>25</option><option ${CHANGE_QUEUE_PAGE_SIZE === 50 ? 'selected' : ''}>50</option></select></label><span class="muted">${pageLabel}</span><button class="btn sm" id="cq-page-prev" ${CHANGE_QUEUE_PAGE <= 1 ? 'disabled' : ''}>← Previous</button><button class="btn sm" id="cq-page-next" ${CHANGE_QUEUE_PAGE >= pageCount ? 'disabled' : ''}>Next →</button></div></section><div id="cq-detail-panel"></div>`;
  const cqAccessibleLabels = {
    'cq-search': 'Search change requests',
    'cq-status': 'Filter change requests by state',
    'cq-site-filter': 'Filter change requests by site',
    'cq-priority-filter': 'Filter change requests by priority',
    'cq-owner-filter': 'Filter change requests by owner',
    'cq-provider-filter': 'Filter change requests by provider',
    'cq-sort': 'Sort change requests',
    'cq-page-size': 'Change queue rows per page',
    'cq-interval': 'Dispatch interval in minutes',
    'cq-concurrency': 'Maximum concurrent requests',
    'cq-lease-minutes': 'Request lease in minutes',
    'cq-auto-review-enabled': 'Enable automatic review',
  };
  Object.entries(cqAccessibleLabels).forEach(([id, label]) => {
    const control = $(`#${id}`);
    if (control) control.setAttribute('aria-label', label);
  });
  ['cq-new', 'cq-pickup-all', 'cq-save-settings', 'cq-page-prev', 'cq-page-next'].forEach(id => {
    const button = $(`#${id}`);
    if (button) button.type = 'button';
  });
  const cqEnabled = $('#cq-enabled');
  if (cqEnabled)
    cqEnabled.setAttribute(
      'aria-label',
      data.settings.enabled ? 'Pause automatic dispatch' : 'Resume automatic dispatch'
    );
  const cqSortDirection = $('#cq-sort-dir');
  if (cqSortDirection)
    cqSortDirection.setAttribute(
      'aria-label',
      `${CHANGE_QUEUE_SORT_DIR === 'asc' ? 'Ascending' : 'Descending'} — sort change requests ${CHANGE_QUEUE_SORT_DIR === 'asc' ? 'descending' : 'ascending'}`
    );
  const cqTable = $('.cq-table');
  if (cqTable && !cqTable.querySelector('caption')) {
    const caption = document.createElement('caption');
    caption.className = 'sr-only';
    caption.textContent = 'Change request work register';
    cqTable.prepend(caption);
  }
  const cqTableWrap = cqTable?.closest('.table-wrap');
  if (cqTable && cqTableWrap) {
    const caption = cqTable.querySelector('caption');
    cqTableWrap.tabIndex = 0;
    cqTableWrap.setAttribute('role', 'region');
    cqTableWrap.setAttribute(
      'aria-label',
      caption?.textContent?.trim() || 'Change request work register'
    );
    const hint = document.createElement('div');
    hint.className = 'matrix-scroll-hint';
    hint.setAttribute('role', 'note');
    hint.textContent = 'Swipe horizontally to review change requests and available actions';
    cqTableWrap.before(hint);
  }
  if (CHANGE_QUEUE_CLOCK) clearInterval(CHANGE_QUEUE_CLOCK);
  const updatePickupClock = () => {
    const el = $('#cq-next-pickup');
    if (!el) return;
    const remaining = Math.max(0, CHANGE_QUEUE_NEXT_PICKUP_AT - Date.now());
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    el.textContent = data.settings.enabled
      ? remaining
        ? `${mins}m ${String(secs).padStart(2, '0')}s`
        : 'due now'
      : 'paused';
    $$('[data-cq-age]').forEach(el => {
      const value = el.dataset.cqAge;
      if (!value) return;
      el.textContent = `${cqAge(value)}${el.classList.contains('cq-age') ? ' old' : ''}`;
    });
  };
  updatePickupClock();
  CHANGE_QUEUE_CLOCK = setInterval(updatePickupClock, 1000);
  // The decision lane is now a saved table view. Remove the duplicate visual
  // panel while keeping the queue pulse as a compact operational summary.
  const registerHead = $('.cq-register-head');
  if (registerHead) {
    const viewBar = document.createElement('div');
    viewBar.className = 'cq-views';
    viewBar.setAttribute('role', 'group');
    viewBar.setAttribute('aria-label', 'Queue views');
    for (const [value, label] of [
      ['attention', 'Needs attention'],
      ['all', 'All work'],
      ['queued', 'Queued'],
      ['active', 'In flight'],
      ['failed', 'Failed'],
      ['shipped', 'Shipped'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `cq-view${CHANGE_QUEUE_VIEW === value ? ' is-active' : ''}`;
      button.dataset.cqView = value;
      button.textContent = label;
      viewBar.append(button);
    }
    registerHead.after(viewBar);
  }
  const sortSelect = $('#cq-sort');
  if (sortSelect && !Array.from(sortSelect.options).some(option => option.value === 'urgency')) {
    sortSelect.insertBefore(new Option('Urgency', 'urgency'), sortSelect.options[0]);
    sortSelect.value = CHANGE_QUEUE_SORT;
  }
  $('#cq-new').onclick = () => showChangeRequestForm(siteOptions, data);
  $('#cq-save-settings').onclick = async () => {
    try {
      await api('PATCH', '/api/change-requests/queue-settings', {
        enabled: $('#cq-enabled').checked,
        auto_review_enabled: $('#cq-auto-review-enabled').checked,
        interval_minutes: Number($('#cq-interval').value),
        max_concurrent: Number($('#cq-concurrency').value),
        lease_minutes: Number($('#cq-lease-minutes').value),
      });
      toast('Queue settings saved');
      softRender();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  // The primary automation switch is safe to operate directly; the detailed
  // cadence controls remain explicitly saved inside the policy disclosure.
  $('#cq-enabled').onchange = () => $('#cq-save-settings').click();
  $$('.cq-view').forEach(button => {
    button.onclick = () => {
      CHANGE_QUEUE_VIEW = button.dataset.cqView || 'attention';
      CHANGE_QUEUE_PAGE = 1;
      renderChangeQueue();
    };
  });
  $('#cq-pickup-all').onclick = async () => {
    try {
      const r = await api('POST', '/api/change-requests/pickup', {});
      toast(`Picked up ${r.picked} request${r.picked === 1 ? '' : 's'}`);
      softRender();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  const updateFilter = () => {
    CHANGE_QUEUE_FILTER = {
      q: $('#cq-search').value,
      status: $('#cq-status').value,
      site: $('#cq-site-filter').value,
      priority: $('#cq-priority-filter').value,
      provider: $('#cq-provider-filter').value,
    };
    CHANGE_QUEUE_OWNER = $('#cq-owner-filter').value;
    CHANGE_QUEUE_PAGE = 1;
    renderChangeQueue();
  };
  $('#cq-search').oninput = e => {
    CHANGE_QUEUE_FILTER.q = e.target.value;
    CHANGE_QUEUE_PAGE = 1;
    renderChangeQueue();
  };
  $('#cq-status').onchange = updateFilter;
  $('#cq-site-filter').onchange = updateFilter;
  $('#cq-priority-filter').onchange = updateFilter;
  $('#cq-provider-filter').onchange = updateFilter;
  $('#cq-owner-filter').onchange = updateFilter;
  $('#cq-sort').onchange = e => {
    CHANGE_QUEUE_SORT = e.target.value;
    CHANGE_QUEUE_PAGE = 1;
    renderChangeQueue();
  };
  $('#cq-sort-dir').onclick = () => {
    CHANGE_QUEUE_SORT_DIR = CHANGE_QUEUE_SORT_DIR === 'asc' ? 'desc' : 'asc';
    renderChangeQueue();
  };
  $('#cq-page-size').onchange = e => {
    CHANGE_QUEUE_PAGE_SIZE = Number(e.target.value) || 10;
    CHANGE_QUEUE_PAGE = 1;
    renderChangeQueue();
  };
  $('#cq-page-prev').onclick = () => {
    CHANGE_QUEUE_PAGE = Math.max(1, CHANGE_QUEUE_PAGE - 1);
    renderChangeQueue();
  };
  $('#cq-page-next').onclick = () => {
    CHANGE_QUEUE_PAGE += 1;
    renderChangeQueue();
  };
  $$('.cq-pick').forEach(
    b =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          await api('POST', `/api/change-requests/${encodeURIComponent(b.dataset.id)}/pickup`, {});
          toast('Request pickup started');
          softRender();
        } catch (e) {
          b.disabled = false;
          toast(e.message, 'err');
        }
      })
  );
  $$('.cq-reevaluate').forEach(
    b =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          await api(
            'POST',
            `/api/change-requests/${encodeURIComponent(b.dataset.id)}/re-evaluate`,
            {}
          );
          toast('Queue locks re-evaluated');
          softRender();
        } catch (e) {
          b.disabled = false;
          toast(e.message, 'err');
        }
      })
  );
  $$('.cq-override-measurement').forEach(
    b =>
      (b.onclick = async () => {
        const approved = await globalThis.fleetConfirm?.({
          title: 'Override measurement window',
          message:
            "Allow this request to start before the measurement window ends? This may contaminate the existing experiment's measurement.",
          confirmLabel: 'Override window',
          danger: true,
        });
        if (!approved) return;
        b.disabled = true;
        try {
          await api(
            'POST',
            `/api/change-requests/${encodeURIComponent(b.dataset.id)}/override-measurement`,
            { reason: 'operator requested measurement-window override' }
          );
          toast('Measurement-window override enabled; pickup started');
          softRender();
        } catch (e) {
          b.disabled = false;
          toast(e.message, 'err');
        }
      })
  );
  $$('.cq-auto-review').forEach(
    b =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          await api(
            'POST',
            `/api/change-requests/${encodeURIComponent(b.dataset.id)}/auto-review`,
            {}
          );
          toast('Automatic review started');
          softRender();
        } catch (e) {
          b.disabled = false;
          toast(e.message, 'err');
        }
      })
  );
  $$('.cq-retry').forEach(
    b =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          await api('POST', `/api/change-requests/${encodeURIComponent(b.dataset.id)}/retry`, {});
          toast('Request returned to queue');
          softRender();
        } catch (e) {
          toast(e.message, 'err');
        }
      })
  );
  $$('.cq-cancel').forEach(
    b =>
      (b.onclick = async () => {
        try {
          await api('POST', `/api/change-requests/${encodeURIComponent(b.dataset.id)}/cancel`, {});
          softRender();
        } catch (e) {
          toast(e.message, 'err');
        }
      })
  );
  $$('.cq-detail').forEach(b => (b.onclick = () => renderChangeQueueDetail(b.dataset.id)));
  if (CHANGE_QUEUE_DETAIL) renderChangeQueueDetail(CHANGE_QUEUE_DETAIL);
  applyFleetFilter();
  if (!FRESH) applyUISnap();
  stamp();
  CHANGE_QUEUE_RENDERING = false;
}

async function renderChangeQueueDetail(id) {
  CHANGE_QUEUE_DETAIL = id;
  const panel = $('#cq-detail-panel');
  if (!panel) {
    toast('Queue action panel is not available; refresh the Change Queue view.', 'err');
    return;
  }
  panel.innerHTML =
    '<section class="card cq-detail-card"><div class="loading" role="status" aria-live="polite">Loading actions and request details…</div></section>';
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const data = await api('GET', `/api/change-requests/${encodeURIComponent(id)}`);
    const r = data.request;
    let improvement = null;
    if (data.run) {
      try {
        improvement = await api('GET', `/api/improvements/${encodeURIComponent(data.run.run_id)}`);
      } catch {
        /* run may be cleaned up */
      }
    }
    const run = data.run;
    const eventRows = (data.events || [])
      .map(
        e =>
          `<tr><td class="muted">${esc(fmtDate(e.occurred_at))}</td><td>${esc(e.event_type)}</td><td class="muted">${esc(e.payload?.error || '')}</td></tr>`
      )
      .join('');
    const actions =
      r.status === 'queued'
        ? `<button class="btn sm primary cq-detail-pick">Pick up now</button><button class="btn sm cq-detail-reevaluate">Re-evaluate</button><button class="btn sm danger cq-detail-cancel">Cancel</button>`
        : r.status === 'failed'
          ? `<button class="btn sm primary cq-detail-retry">Retry</button>`
          : r.status === 'review'
            ? `<button class="btn sm primary cq-detail-auto-review">Auto-review & deliver</button><button class="btn sm danger cq-detail-cancel">Cancel</button>`
            : ['claimed', 'running', 'reviewing'].includes(r.status)
              ? `<button class="btn sm danger cq-detail-cancel">Cancel</button>`
              : '';
    const preflight = run?.preflight || {};
    const reportLink =
      r.delivery_mode === 'report_only' && ['verified', 'deployed'].includes(r.status)
        ? `<p><a class="btn sm" href="/api/change-requests/${encodeURIComponent(r.request_id)}/report" target="_blank" rel="noopener">Open report artifact</a></p>`
        : '';
    const preflightText =
      preflight.passed === true ? 'passed' : preflight.passed === false ? 'blocked' : 'not run';
    panel.innerHTML = `<section class="card cq-detail-card"><div class="page-head"><div><h3>${esc(r.title)}</h3><div class="muted">${esc(r.site)} · ${esc(r.category)} · request ${esc(r.request_id.slice(0, 8))}${r.requested_by ? ` · requested by ${esc(r.requested_by)}` : ''}</div></div><div><button class="btn sm cq-detail-edit">Edit request</button> ${run ? '<button class="btn sm cq-detail-preflight">Run preflight</button>' : ''}${actions}<button class="btn sm" id="cq-detail-close">Close</button></div></div><div class="seo-stats"><div class="seo-stat"><div class="seo-stat-label">Status</div><div class="seo-stat-value" style="font-size:16px">${esc(r.status)}</div><div class="seo-stat-sub">${esc(r.attempts)} attempt(s)</div></div><div class="seo-stat"><div class="seo-stat-label">Agent</div><div class="seo-stat-value" style="font-size:16px">${esc(r.provider)}</div><div class="seo-stat-sub">${esc(r.model || 'provider default')} · ${esc(r.max_turns)} turns</div></div><div class="seo-stat"><div class="seo-stat-label">Role</div><div class="seo-stat-value" style="font-size:16px">${esc(r.assigned_role || 'engineer')}</div><div class="seo-stat-sub">priority ${esc(r.priority)}</div></div><div class="seo-stat"><div class="seo-stat-label">Delivery</div><div class="seo-stat-value" style="font-size:16px">${esc(r.delivery_mode || 'direct')}</div><div class="seo-stat-sub">${r.source_proposal_id ? `proposal ${esc(r.source_proposal_id.slice(0, 8))}` : 'no linked proposal'}</div></div><div class="seo-stat"><div class="seo-stat-label">Preflight</div><div class="seo-stat-value" style="font-size:16px">${esc(preflightText)}</div><div class="seo-stat-sub">${esc(preflight.recorded_at || 'environment not checked')}</div></div><div class="seo-stat"><div class="seo-stat-label">Linked run</div><div class="seo-stat-value" style="font-size:16px">${run ? esc(run.state) : 'not started'}</div><div class="seo-stat-sub">${run ? esc(run.run_id.slice(0, 8)) : 'waiting for pickup'}</div></div></div><h4>Request</h4><pre class="cn-logs-box cq-request-body">${esc(r.body || '(no additional details)')}</pre>${r.error ? `<div class="error-box">${esc(r.error)}</div>` : ''}${reportLink}${run && improvement ? `<h4>Delivery evidence</h4><pre class="cn-logs-box">${esc(improvement.workspace?.diff_stat || '')}\n${esc(improvement.diff?.text || '(no uncommitted diff)')}\n\nAgent status: ${esc(improvement.agent?.status || 'not started')}\n\n${esc(improvement.agent?.log_tail || '(no agent output yet)')}</pre><p><a class="btn sm" href="#improvements">Open full improvement review</a></p>` : ''}<h4>Timeline</h4><div class="table-wrap"><table class="tbl"><thead><tr><th>When</th><th>Event</th><th>Notes</th></tr></thead><tbody>${eventRows || '<tr><td colspan="3" class="muted">No events yet.</td></tr>'}</tbody></table></div></section>`;
    const detailHeader = $('.cq-detail-card .page-head > div');
    if (detailHeader) detailHeader.insertAdjacentHTML('beforeend', cqSiteContext(r) + cqBlocker(r));
    $('#cq-detail-close').onclick = () => {
      CHANGE_QUEUE_DETAIL = null;
      panel.innerHTML = '';
    };
    $('.cq-detail-edit', panel).onclick = () => showChangeRequestEditForm(r, data);
    $('.cq-detail-preflight', panel)?.addEventListener('click', async () => {
      try {
        await api('POST', `/api/change-requests/${encodeURIComponent(r.request_id)}/preflight`, {});
        toast('Preflight completed');
        renderChangeQueueDetail(r.request_id);
      } catch (e) {
        toast(e.message, 'err');
      }
    });
    $('.cq-detail-pick', panel)?.addEventListener('click', async () => {
      try {
        await api('POST', `/api/change-requests/${encodeURIComponent(r.request_id)}/pickup`, {});
        toast('Request pickup started');
        softRender();
      } catch (e) {
        toast(e.message, 'err');
      }
    });
    $('.cq-detail-reevaluate', panel)?.addEventListener('click', async button => {
      button.currentTarget.disabled = true;
      try {
        await api(
          'POST',
          `/api/change-requests/${encodeURIComponent(r.request_id)}/re-evaluate`,
          {}
        );
        toast('Queue locks re-evaluated');
        softRender();
      } catch (e) {
        button.currentTarget.disabled = false;
        toast(e.message, 'err');
      }
    });
    $('.cq-detail-auto-review', panel)?.addEventListener('click', async () => {
      try {
        await api(
          'POST',
          `/api/change-requests/${encodeURIComponent(r.request_id)}/auto-review`,
          {}
        );
        toast('Automatic review started');
        softRender();
      } catch (e) {
        toast(e.message, 'err');
      }
    });
    $('.cq-detail-retry', panel)?.addEventListener('click', async () => {
      try {
        await api('POST', `/api/change-requests/${encodeURIComponent(r.request_id)}/retry`, {});
        toast('Request returned to queue');
        softRender();
      } catch (e) {
        toast(e.message, 'err');
      }
    });
    $('.cq-detail-cancel', panel)?.addEventListener('click', async () => {
      try {
        await api('POST', `/api/change-requests/${encodeURIComponent(r.request_id)}/cancel`, {});
        toast('Request cancelled');
        softRender();
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  } catch (e) {
    renderViewError(panel, `Unable to load queue actions: ${e.message}`);
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast(`Unable to load queue actions: ${e.message}`, 'err');
  }
}

function showChangeRequestEditForm(request, data) {
  const modal = $('#modal');
  $('#modal-title').textContent = 'Edit change request';
  $('#modal-body').innerHTML =
    `<div class="field"><label>Title</label><input id="cq-edit-title" value="${esc(request.title)}"></div><div class="field"><label>Details / acceptance criteria</label><textarea id="cq-edit-body" rows="8">${esc(request.body || '')}</textarea></div><div class="field-row"><div class="field"><label>Category</label><select id="cq-edit-category">${data.categories.map(x => `<option value="${x}" ${x === request.category ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div><div class="field"><label>Priority</label><select id="cq-edit-priority">${['high', 'medium', 'low'].map(x => `<option ${x === request.priority ? 'selected' : ''}>${x}</option>`).join('')}</select></div><div class="field"><label>Role</label><input id="cq-edit-role" value="${esc(request.assigned_role || 'engineer')}"></div></div><div class="field-row"><div class="field"><label>Provider</label><select id="cq-edit-provider">${data.providers.map(x => `<option value="${x}" ${x === request.provider ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div><div class="field"><label>Model</label><input id="cq-edit-model" value="${esc(request.model || '')}"></div><div class="field"><label>Max turns</label><input id="cq-edit-turns" type="number" min="1" max="200" value="${esc(request.max_turns)}"></div><div class="field"><label>Delivery</label><select id="cq-edit-delivery"><option value="direct" ${request.delivery_mode === 'direct' ? 'selected' : ''}>Direct deploy</option><option value="pull_request" ${request.delivery_mode === 'pull_request' ? 'selected' : ''}>Pull request</option><option value="report_only" ${request.delivery_mode === 'report_only' ? 'selected' : ''}>Report only</option></select></div></div><div class="modal-actions"><button class="btn" id="cq-edit-close">Cancel</button><button class="btn primary" id="cq-edit-save">Save changes</button></div>`;
  modal.classList.remove('hidden');
  $('#cq-edit-close').onclick = closeModal;
  const editAutoReview = document.createElement('div');
  editAutoReview.className = 'field';
  editAutoReview.innerHTML = `<label><input type="checkbox" id="cq-edit-auto-review" ${request.auto_review !== false && request.auto_review !== 0 ? 'checked' : ''}> Automatically review, validate, commit, and push</label>`;
  $('#cq-edit-turns').closest('.field-row').after(editAutoReview);
  $('#cq-edit-save').onclick = async () => {
    const b = $('#cq-edit-save');
    b.disabled = true;
    try {
      await api('PATCH', `/api/change-requests/${encodeURIComponent(request.request_id)}`, {
        title: $('#cq-edit-title').value,
        body: $('#cq-edit-body').value,
        category: $('#cq-edit-category').value,
        priority: $('#cq-edit-priority').value,
        assigned_role: $('#cq-edit-role').value,
        provider: $('#cq-edit-provider').value,
        model: $('#cq-edit-model').value || null,
        max_turns: Number($('#cq-edit-turns').value),
        delivery_mode: $('#cq-edit-delivery').value,
        auto_review: $('#cq-edit-auto-review').checked,
      });
      closeModal(true);
      toast('Request updated');
      softRender();
    } catch (e) {
      b.disabled = false;
      toast(e.message, 'err');
    }
  };
}

function showChangeRequestForm(siteOptions, data) {
  const modal = $('#modal');
  const title = $('#modal-title');
  const bodyEl = $('#modal-body');
  title.textContent = 'New change request';
  const body = `<div class="field"><label>Site</label><select id="cq-site">${siteOptions}</select></div><div class="field"><label>What should change?</label><input id="cq-title" placeholder="Fix Slack error, improve homepage, add a guide…"></div><div class="field"><label>Details / acceptance criteria</label><textarea id="cq-body" rows="7" placeholder="Paste the error, describe the desired result, link a page, or give a topic…"></textarea></div><div class="field-row"><div class="field"><label>Category</label><select id="cq-category">${data.categories.map(x => `<option>${esc(x)}</option>`).join('')}</select></div><div class="field"><label>Priority</label><select id="cq-priority"><option>high</option><option selected>medium</option><option>low</option></select></div><div class="field"><label>Role</label><input id="cq-role" value="engineer" placeholder="engineer"></div></div><div class="field-row"><div class="field"><label>Provider</label><select id="cq-provider"><option value="claude">Claude</option><option value="chatgpt">ChatGPT / Codex</option><option value="local">Local model</option></select></div><div class="field"><label>Model (optional)</label><input id="cq-model" placeholder="sonnet, gpt-5, llama3.2…"></div><div class="field"><label>Max turns</label><input id="cq-turns" type="number" min="1" max="200" value="20"></div><div class="field"><label>Delivery</label><select id="cq-delivery"><option value="direct">Direct deploy</option><option value="pull_request">Pull request</option><option value="report_only">Report only</option></select></div></div><div class="field"><label>Voice input (optional, local STT)</label><button class="btn sm" id="cq-record">Record voice</button> <span id="cq-record-status" class="muted">No recording</span><input type="hidden" id="cq-transcript"></div><div class="modal-actions"><button class="btn" id="cq-close">Cancel</button><button class="btn primary" id="cq-submit">Queue request</button></div>`;
  bodyEl.innerHTML = body;
  const autoReviewField = document.createElement('div');
  autoReviewField.className = 'field';
  autoReviewField.innerHTML = `<label><input type="checkbox" id="cq-auto-review" ${data.settings.auto_review_enabled !== false ? 'checked' : ''}> Automatically review, validate, commit, and push after the agent finishes</label>`;
  $('#cq-turns').closest('.field-row').after(autoReviewField);
  modal.classList.remove('hidden');
  $('#cq-close').onclick = closeModal;
  $('#cq-submit').onclick = async () => {
    const b = $('#cq-submit');
    b.disabled = true;
    try {
      await api('POST', '/api/change-requests', {
        site: $('#cq-site').value,
        title: $('#cq-title').value,
        body: $('#cq-body').value,
        category: $('#cq-category').value,
        priority: $('#cq-priority').value,
        assigned_role: $('#cq-role').value,
        provider: $('#cq-provider').value,
        model: $('#cq-model').value || null,
        max_turns: Number($('#cq-turns').value),
        delivery_mode: $('#cq-delivery').value,
        auto_review: $('#cq-auto-review').checked,
        voice_transcript: $('#cq-transcript').value || null,
      });
      closeModal(true);
      toast('Change request queued');
      softRender();
    } catch (e) {
      b.disabled = false;
      toast(e.message, 'err');
    }
  };
  $('#cq-record').onclick = async () => {
    const status = $('#cq-record-status');
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
      return toast('This browser does not support local voice recording', 'err');
    if (CHANGE_QUEUE_RECORDER) {
      CHANGE_QUEUE_RECORDER.stop();
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    CHANGE_QUEUE_CHUNKS = [];
    CHANGE_QUEUE_RECORDER = new MediaRecorder(stream);
    CHANGE_QUEUE_RECORDER.ondataavailable = e => CHANGE_QUEUE_CHUNKS.push(e.data);
    CHANGE_QUEUE_RECORDER.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      status.textContent = 'Transcribing locally…';
      const blob = new Blob(CHANGE_QUEUE_CHUNKS, { type: 'audio/webm' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      bytes.forEach(x => (binary += String.fromCharCode(x)));
      try {
        const out = await api('POST', '/api/change-requests/transcribe', {
          audioBase64: btoa(binary),
          mimeType: 'audio/webm',
        });
        $('#cq-transcript').value = out.transcript;
        $('#cq-body').value =
          ($('#cq-body').value ? $('#cq-body').value + '\n\n' : '') + out.transcript;
        status.textContent = 'Transcript added';
      } catch (e) {
        status.textContent = 'STT unavailable';
        toast(e.message, 'err');
      }
      CHANGE_QUEUE_RECORDER = null;
    };
    CHANGE_QUEUE_RECORDER.start();
    status.textContent = 'Recording… click to stop';
  };
}

/* ===================== FLEET WORK BOARD ===================== */
const WORK_BOARD_COLUMNS = [
  ['backlog', 'Backlog'],
  ['ready', 'Ready'],
  ['active', 'In progress'],
  ['approval', 'Approval / review'],
  ['blocked', 'Blocked'],
  ['done', 'Done'],
];
const WORK_BOARD_FILTER_KEY = 'fd.work-board.filters';
const WORK_BOARD_COLUMN_KEYS = new Set(WORK_BOARD_COLUMNS.map(([key]) => key));
let WORK_BOARD_QUERY = '';
let WORK_BOARD_SEARCH_TIMER;
const WORK_BOARD_PAGE_SIZE = 20;
const WORK_BOARD_PAGES = Object.create(null);
function readWorkBoardFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(WORK_BOARD_FILTER_KEY) || '{}');
    const valid = value =>
      Array.isArray(value) ? value.filter(key => WORK_BOARD_COLUMN_KEYS.has(key)) : [];
    return { include: new Set(valid(saved.include)), exclude: new Set(valid(saved.exclude)) };
  } catch {
    return { include: new Set(), exclude: new Set() };
  }
}
const WORK_BOARD_FILTERS = readWorkBoardFilters();
const WORK_BOARD_INCLUDE = WORK_BOARD_FILTERS.include,
  WORK_BOARD_EXCLUDE = WORK_BOARD_FILTERS.exclude;
function saveWorkBoardFilters() {
  try {
    localStorage.setItem(
      WORK_BOARD_FILTER_KEY,
      JSON.stringify({ include: [...WORK_BOARD_INCLUDE], exclude: [...WORK_BOARD_EXCLUDE] })
    );
  } catch {}
}
function toggleWorkBoardFilter(kind, key) {
  const target = kind === 'include' ? WORK_BOARD_INCLUDE : WORK_BOARD_EXCLUDE;
  const other = kind === 'include' ? WORK_BOARD_EXCLUDE : WORK_BOARD_INCLUDE;
  if (target.has(key)) target.delete(key);
  else {
    target.add(key);
    other.delete(key);
  }
  saveWorkBoardFilters();
}
function clearWorkBoardFilter(kind) {
  (kind === 'include' ? WORK_BOARD_INCLUDE : WORK_BOARD_EXCLUDE).clear();
  saveWorkBoardFilters();
}
function wbCol(item) {
  if (item.source === 'work-item')
    return item.status === 'open'
      ? 'backlog'
      : item.status === 'ready'
        ? 'ready'
        : item.status === 'in_progress'
          ? 'active'
          : ['blocked', 'waiting'].includes(item.status)
            ? 'blocked'
            : 'done';
  if (item.source === 'proposal')
    return ['proposed', 'feedback'].includes(item.status)
      ? 'approval'
      : item.status === 'declined'
        ? 'done'
        : 'ready';
  return ['review', 'reviewing', 'delivery_pending', 'needs_repair'].includes(item.status)
    ? 'approval'
    : item.status === 'failed'
      ? 'blocked'
      : ['queued', 'claimed'].includes(item.status)
        ? 'ready'
        : item.status === 'running'
          ? 'active'
          : 'done';
}
function wbVisible(item) {
  const col = wbCol(item);
  return !WORK_BOARD_EXCLUDE.has(col) && (!WORK_BOARD_INCLUDE.size || WORK_BOARD_INCLUDE.has(col));
}
function wbItems(data) {
  return [
    ...(data.work_items || []).map(x => ({
      ...x,
      id: x.work_id,
      source: 'work-item',
      source_label: 'backlog',
      owner: x.owner,
    })),
    ...(data.requests || []).map(x => ({
      ...x,
      id: x.request_id,
      source: 'request',
      source_label: 'change queue',
      owner: x.assigned_role,
    })),
    ...(data.proposals || []).map(x => ({
      ...x,
      id: x.proposal_id,
      source: 'proposal',
      source_label: 'executive gate',
      owner: x.created_by,
    })),
  ];
}
async function openWorkflowItem(source, id, data) {
  const item = wbItems(data).find(x => x.source === source && x.id === id);
  if (!item) return;
  const typeLabels = { 'work-item': 'backlog', request: 'change request', proposal: 'proposal' };
  const links = (data.links || []).filter(
    x => (x.from_type === source && x.from_id === id) || (x.to_type === source && x.to_id === id)
  );
  const entity = (type, entityId) =>
    wbItems(data).find(x => x.source === type && x.id === entityId);
  const linkRows = links
    .map(link => {
      const outgoing = link.from_type === source && link.from_id === id;
      const other = entity(
        outgoing ? link.to_type : link.from_type,
        outgoing ? link.to_id : link.from_id
      );
      return `<div class="wb-link-row"><span class="badge ${link.relation === 'blocks' || link.relation === 'blocked_by' ? 'b-yellow' : 'b-blue'}">${esc(outgoing ? link.relation : link.relation === 'blocks' ? 'blocked by' : link.relation)}</span><strong>${esc(other?.title || `${link.to_type}:${link.to_id}`)}</strong><button class="btn sm" data-wb-delete-link="${esc(link.link_id)}">Remove</button></div>`;
    })
    .join('');
  const options = wbItems(data)
    .filter(x => !(x.source === source && x.id === id))
    .map(
      x =>
        `<option value="${esc(x.source + '|' + x.id)}">${esc(x.title)} · ${esc(typeLabels[x.source])}</option>`
    )
    .join('');
  const events = (data.events || [])
    .filter(x => x.entity_id === id || x.correlation_id === `${source}:${id}`)
    .slice(0, 20)
    .map(
      x =>
        `<tr><td class="muted">${esc(fmtDate(x.occurred_at))}</td><td>${esc(x.event_type)}</td><td class="muted">${esc(x.payload?.error || x.source || '')}</td></tr>`
    )
    .join('');
  $('#modal-title').textContent = item.title;
  $('#modal-body').innerHTML =
    `<div class="wb-detail"><div class="wb-detail-chips"><span class="badge b-blue">${esc(typeLabels[source])}</span><span class="badge">${esc(item.status)}</span><span class="badge">${esc(item.owner || 'unassigned')}</span></div><p>${esc(item.summary || item.body || item.rationale || 'No summary')}</p><h4>Lifecycle and gate</h4><pre>${esc(wbGate(item))}\nUpdated: ${esc(fmtDate(item.updated_at || item.created_at || item.started_at))}${item.run_id ? `\nRun: ${item.run_id}` : ''}${item.next_attempt_at ? `\nNext attempt: ${fmtDate(item.next_attempt_at)}` : ''}${item.due_at ? `\nDue: ${fmtDate(item.due_at)}` : ''}</pre><h4>Dependencies and related work</h4><div class="wb-link-list">${linkRows || '<span class="muted">No links yet.</span>'}</div><div class="wb-link-form"><select id="wb-link-relation"><option value="blocks">Blocks</option><option value="blocked_by">Blocked by</option><option value="related_to">Related to</option></select><select id="wb-link-target">${options}</select><button class="btn sm primary" id="wb-add-link">Link</button></div><h4>Timeline</h4><div class="table-wrap"><table class="tbl"><thead><tr><th>When</th><th>Event</th><th>Notes</th></tr></thead><tbody>${events || '<tr><td colspan="3" class="muted">No recorded events for this item.</td></tr>'}</tbody></table></div></div><div class="modal-actions"><button class="btn" id="wb-detail-close">Close</button></div>`;
  $('#modal').classList.remove('hidden');
  $('#wb-detail-close').onclick = closeModal;
  $('#wb-add-link').onclick = async () => {
    try {
      const [to_type, to_id] = $('#wb-link-target').value.split('|');
      await api('POST', '/api/workflow-links', {
        from_type: source,
        from_id: id,
        to_type,
        to_id,
        relation: $('#wb-link-relation').value,
        created_by: 'owner',
      });
      toast('Dependency linked');
      await openWorkflowItem(source, id, {
        ...data,
        links: [
          ...(data.links || []),
          {
            from_type: source,
            from_id: id,
            to_type,
            to_id,
            relation: $('#wb-link-relation').value,
            link_id: `new-${Date.now()}`,
          },
        ],
      });
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  $$('[data-wb-delete-link]').forEach(
    button =>
      (button.onclick = async () => {
        try {
          await api(
            'DELETE',
            `/api/workflow-links/${encodeURIComponent(button.dataset.wbDeleteLink)}`
          );
          toast('Link removed');
          const next = {
            ...data,
            links: (data.links || []).filter(x => x.link_id !== button.dataset.wbDeleteLink),
          };
          await openWorkflowItem(source, id, next);
        } catch (e) {
          toast(e.message, 'err');
        }
      })
  );
}

/* ===================== FLEET WORK BOARD ===================== */
function workBoardVisible(item) {
  const column = workBoardColumn(item);
  if (WORK_BOARD_EXCLUDE.has(column)) return false;
  if (WORK_BOARD_INCLUDE.size && !WORK_BOARD_INCLUDE.has(column)) return false;
  const query = WORK_BOARD_QUERY.trim().toLowerCase();
  if (!query) return true;
  return [
    item.title,
    item.site,
    item.owner,
    item.assigned_role,
    item.created_by,
    item.source_label,
    item.status,
    item.summary,
    item.body,
    item.rationale,
    item.next_action,
    item.waiting_on,
  ]
    .map(value => String(value || '').toLowerCase())
    .join(' ')
    .includes(query);
}

function workBoardColumn(item) {
  if (item.source === 'work-item') {
    if (item.status === 'open') return 'backlog';
    if (item.status === 'ready') return 'ready';
    if (item.status === 'in_progress') return 'active';
    if (['blocked', 'waiting'].includes(item.status)) return 'blocked';
    return 'done';
  }
  if (item.source === 'proposal')
    return ['proposed', 'feedback'].includes(item.status)
      ? 'approval'
      : item.status === 'declined'
        ? 'done'
        : 'ready';
  if (['review', 'reviewing', 'delivery_pending', 'needs_repair'].includes(item.status))
    return 'approval';
  if (['failed', 'blocked_infrastructure', 'needs_human_review'].includes(item.status))
    return 'blocked';
  if (['queued', 'claimed'].includes(item.status)) return 'ready';
  if (item.status === 'running') return 'active';
  return 'done';
}

function workBoardCard(item) {
  const column = workBoardColumn(item);
  const gate =
    item.source === 'request'
      ? `${item.auto_review === false ? 'manual review' : 'auto review'} · ${item.delivery_mode || 'direct'}`
      : item.source === 'proposal'
        ? `owner decision · legal ${item.implementation?.legal_review?.status || 'n/a'} · security ${item.implementation?.security_review?.status || 'n/a'}`
        : item.next_action || 'PM triage pending';
  return `<article class="wb-card" draggable="true" data-wb-source="${esc(item.source)}" data-wb-id="${esc(item.id)}"><div class="wb-card-top"><span class="badge ${item.priority === 'urgent' || item.priority === 'high' ? 'b-red' : item.priority === 'medium' ? 'b-yellow' : 'b-blue'}">${esc(item.priority || 'normal')}</span><span class="wb-source">${esc(item.source_label)}</span>${item.critical ? '<span class="badge b-yellow">critical path</span>' : ''}</div><strong>${esc(item.title)}</strong><div class="wb-meta">${esc(item.site || 'fleet')} · ${esc(item.owner || item.assigned_role || item.created_by || 'unassigned')}</div><p>${esc(item.summary || item.body || item.rationale || 'No brief recorded yet.')}</p><div class="wb-gate"><span>◆</span>${esc(gate)}</div><div class="wb-card-foot"><time>${esc(fmtDate(item.updated_at || item.created_at || item.started_at))}</time><button type="button" class="btn sm wb-open" data-wb-source="${esc(item.source)}" data-wb-id="${esc(item.id)}" aria-label="Open ${esc(item.title)} details" title="Open ${esc(item.title)} details">Open</button></div></article>`;
}

function workBoardItems(data) {
  const items = [];
  const decorate = (row, source, id) => {
    const workflow = data.workflow?.nodes?.[`${source}:${id}`] || {};
    return {
      ...row,
      ...workflow,
      waiting_on: workflow.blockers?.join(', ') || row.waiting_on || null,
      id,
      source,
    };
  };
  (data.work_items || []).forEach(row =>
    items.push({ ...decorate(row, 'work-item', row.work_id), source_label: 'backlog' })
  );
  (data.requests || []).forEach(row =>
    items.push({
      ...decorate(row, 'request', row.request_id),
      source_label: 'change queue',
      owner: row.assigned_role,
    })
  );
  (data.proposals || []).forEach(row =>
    items.push({
      ...decorate(row, 'proposal', row.proposal_id),
      source_label: 'executive gate',
      owner: row.created_by,
      summary: row.summary,
    })
  );
  return items;
}

let ACTIVE_DELIVERY_ATTENTION_PAGE = 1;
const ACTIVE_DELIVERY_ATTENTION_PAGE_SIZE = 12;

async function renderActiveDelivery() {
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading active delivery…</div></div>';
  try {
    const data = await api('GET', '/api/executive/active-delivery');
    const policy = data.policy || {};
    const laneLabels = {
      'finish-sites': 'Site improvements',
      'growth-revenue': 'Growth / revenue',
      'site-factory': 'New-site factory',
      fleet: 'Fleet tooling',
    };
    const slotRows = (data.slots || [])
      .map(
        (item, index) =>
          `<tr><td><strong>${index + 1}</strong></td><td><strong>${esc(item.title)}</strong><small class="muted">${esc(item.site)}</small></td><td>${esc(laneLabels[item.lane] || item.lane)}</td><td><span class="badge ${item.state === 'review' ? 'b-yellow' : item.state === 'measuring' ? 'b-blue' : item.state === 'deployed' ? 'b-green' : 'b-purple'}">${esc(item.state)}</span></td><td>${esc(item.owner || 'engineer')}</td><td class="muted">${esc(item.next_action)}</td></tr>`
      )
      .join('');
    const attention = data.attention || [];
    const attentionPages = Math.max(
      1,
      Math.ceil(attention.length / ACTIVE_DELIVERY_ATTENTION_PAGE_SIZE)
    );
    ACTIVE_DELIVERY_ATTENTION_PAGE = Math.min(ACTIVE_DELIVERY_ATTENTION_PAGE, attentionPages);
    const attentionStart =
      (ACTIVE_DELIVERY_ATTENTION_PAGE - 1) * ACTIVE_DELIVERY_ATTENTION_PAGE_SIZE;
    const attentionRows = attention
      .slice(attentionStart, attentionStart + ACTIVE_DELIVERY_ATTENTION_PAGE_SIZE)
      .map(
        item =>
          `<tr><td><span class="badge b-yellow">${esc(item.attention)}</span></td><td><strong>${esc(item.title)}</strong><small class="muted">${esc(item.site)}</small></td><td>${esc(item.state)}</td><td>${esc(item.next_action)}</td></tr>`
      )
      .join('');
    const today = data.today || {};
    const flow = data.flow || {};
    const lanes = Object.entries(data.lane_counts || {})
      .map(
        ([lane, count]) =>
          `<span class="badge b-gray">${esc(laneLabels[lane] || lane)}: ${count}</span>`
      )
      .join(' ');
    app.innerHTML = `<div class="page-head"><div><div class="cq-eyebrow">PORTFOLIO DELIVERY CONTROL</div><h2 class="page-title">Active Delivery</h2><div class="crumbs">Ten meaningful initiatives stay in motion; reporting does not consume delivery capacity.</div></div><button class="btn" id="delivery-refresh">↻ Refresh</button></div><section class="seo-stats"><div class="seo-stat"><div class="seo-stat-value">${policy.active_slots || 0}/${policy.max_active_slots || 10}</div><div class="seo-stat-label">Active slots</div></div><div class="seo-stat"><div class="seo-stat-value">${policy.open_slots || 0}</div><div class="seo-stat-label">Open slots</div></div><div class="seo-stat"><div class="seo-stat-value">${attention.length}</div><div class="seo-stat-label">Needs attention</div></div><div class="seo-stat"><div class="seo-stat-value">${today.implementation_requests_completed || 0}</div><div class="seo-stat-label">Implementation completions today</div></div><div class="seo-stat"><div class="seo-stat-value">${today.report_only_requests_created || 0}</div><div class="seo-stat-label">Reports created today</div></div></section><section class="card"><div class="cq-section-head"><div><div class="cq-eyebrow">ACTIVE PORTFOLIO</div><h3>What engineers are actually working on</h3><p class="muted">Only direct implementation work occupies these slots. Completed reports remain available in the Work Board and executive history.</p></div><div>${lanes}</div></div><div class="table-wrap"><table class="tbl"><thead><tr><th>#</th><th>Initiative</th><th>Lane</th><th>State</th><th>Owner</th><th>Next action</th></tr></thead><tbody>${slotRows || '<tr><td colspan="6" class="muted">No active implementation work. Fill the delivery slots.</td></tr>'}</tbody></table></div>${(data.overflow || []).length ? `<div class="muted" style="margin-top:12px">${data.overflow.length} additional implementation item(s) are beyond the ten-slot limit and should be triaged before new work is created.</div>` : ''}</section><section class="card"><div class="cq-section-head"><div><div class="cq-eyebrow">DELIVERY ATTENTION</div><h3>Resolve before generating more reports</h3></div><span class="badge ${attention.length ? 'b-yellow' : 'b-green'}">${attention.length ? `${attention.length} flagged` : 'all clear'}</span></div><div class="table-wrap"><table class="tbl"><thead><tr><th>Reason</th><th>Initiative</th><th>State</th><th>Next action</th></tr></thead><tbody>${attentionRows || '<tr><td colspan="4" class="muted">No delivery blockers or pending gates.</td></tr>'}</tbody></table></div>${attention.length > ACTIVE_DELIVERY_ATTENTION_PAGE_SIZE ? `<nav class="priority-pagination" aria-label="Delivery attention pages"><button type="button" class="btn sm" id="delivery-attention-prev" aria-label="Previous delivery attention page" ${ACTIVE_DELIVERY_ATTENTION_PAGE <= 1 ? 'disabled' : ''}>← Previous</button><span id="delivery-attention-page-status" class="muted" role="status" aria-live="polite">Showing ${attentionStart + 1}–${Math.min(attentionStart + ACTIVE_DELIVERY_ATTENTION_PAGE_SIZE, attention.length)} of ${attention.length} flagged items</span><button type="button" class="btn sm" id="delivery-attention-next" aria-label="Next delivery attention page" ${ACTIVE_DELIVERY_ATTENTION_PAGE >= attentionPages ? 'disabled' : ''}>Next →</button></nav>` : ''}</section><section class="card"><div class="cq-section-head"><div><div class="cq-eyebrow">TODAY’S FLOW</div><h3>Execution over activity</h3></div></div><div class="muted">${today.implementation_requests_created || 0} implementation requests created · ${today.implementation_requests_completed || 0} completed · ${today.implementation_requests_failed_or_cancelled || 0} failed/cancelled · ${today.report_only_requests_created || 0} report-only requests created${today.reporting_to_delivery_ratio == null ? '' : ` · reporting/completion ratio ${today.reporting_to_delivery_ratio}:1`}.</div></section></div>`;
    const completionKpi = app.querySelectorAll('.seo-stat')[3];
    if (completionKpi) {
      completionKpi.querySelector('.seo-stat-value').textContent = flow.deployed_today ?? 0;
      completionKpi.querySelector('.seo-stat-label').textContent = 'Verified deployments today';
    }
    app
      .querySelector('.seo-stats')
      ?.insertAdjacentHTML(
        'afterend',
        `<section class="card"><div class="cq-section-head"><div><div class="cq-eyebrow">DELIVERY FLOW</div><h3>Work crossing the delivery boundary</h3></div></div><p class="muted">${Number(flow.queued_implementation_requests || 0)} queued implementation requests${flow.oldest_queued_minutes == null ? '' : ` · oldest waiting ${Number(flow.oldest_queued_minutes)} min`} · ${Number(flow.blocked_reviews || 0)} infrastructure-blocked reviews · ${Number(flow.validated_today || 0)} validated today · ${Number(flow.deployed_today || 0)} deployment-verified today · ${Number(flow.measured_today || 0)} measured today.</p></section>`
      );
    $('#delivery-refresh').onclick = () => renderActiveDelivery();
    $('#delivery-attention-prev')?.addEventListener('click', () => {
      ACTIVE_DELIVERY_ATTENTION_PAGE = Math.max(1, ACTIVE_DELIVERY_ATTENTION_PAGE - 1);
      softRender();
    });
    $('#delivery-attention-next')?.addEventListener('click', () => {
      ACTIVE_DELIVERY_ATTENTION_PAGE = Math.min(attentionPages, ACTIVE_DELIVERY_ATTENTION_PAGE + 1);
      softRender();
    });
    if (!FRESH) applyUISnap();
    stamp();
  } catch (e) {
    renderViewError(app, e.message);
  }
}

function renderWorkflowBoardLane(key, label, items, total) {
  const pageCount = Math.max(1, Math.ceil(total / WORK_BOARD_PAGE_SIZE));
  const page = (WORK_BOARD_PAGES[key] = Math.min(WORK_BOARD_PAGES[key] || 1, pageCount));
  const start = (page - 1) * WORK_BOARD_PAGE_SIZE;
  const cards = items
    .slice(start, start + WORK_BOARD_PAGE_SIZE)
    .map(workBoardCard)
    .join('');
  const pagination =
    pageCount > 1
      ? `<nav class="wb-lane-pagination" aria-label="${esc(label)} work items pages"><span class="muted" role="status" aria-live="polite">${start + 1}–${Math.min(start + WORK_BOARD_PAGE_SIZE, total)} of ${total}</span><button type="button" class="btn sm" data-wb-page="${key}" data-direction="-1" aria-label="Previous ${esc(label)} work items" ${page <= 1 ? 'disabled' : ''}>←</button><button type="button" class="btn sm" data-wb-page="${key}" data-direction="1" aria-label="Next ${esc(label)} work items" ${page >= pageCount ? 'disabled' : ''}>→</button></nav>`
      : '';
  return `<div class="wb-column" data-wb-drop="${key}"><div class="wb-column-head"><div><h3>${label}</h3><span>${total} item${total === 1 ? '' : 's'}</span></div><i></i></div><div class="wb-cards">${cards || '<div class="wb-empty">Drop work here</div>'}</div>${pagination}</div>`;
}

async function renderWorkflowBoard() {
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading fleet workflow…</div></div>';
  try {
    const data = await api('GET', '/api/workflow-board');
    const items = workBoardItems(data).filter(workBoardVisible);
    const counts = WORK_BOARD_COLUMNS.map(
      ([key]) => items.filter(item => workBoardColumn(item) === key).length
    );
    const activity = (data.actions || [])
      .slice(0, 12)
      .map(
        action =>
          `<div class="wb-activity"><span class="badge ${action.status === 'failed' ? 'b-red' : action.status === 'started' ? 'b-yellow' : 'b-green'}">${esc(action.status)}</span><div><strong>${esc(action.summary)}</strong><small>${esc(action.actor)} · ${esc(fmtDate(action.started_at))}</small></div></div>`
      )
      .join('');
    const diagnosticGroups = [];
    const diagnosticIndex = new Map();
    (data.diagnostics || []).forEach(item => {
      const key = [item.title, item.status, item.next_action]
        .map(value => String(value || ''))
        .join('|');
      const existing = diagnosticIndex.get(key);
      if (existing) existing.count += 1;
      else {
        const group = { ...item, count: 1 };
        diagnosticIndex.set(key, group);
        diagnosticGroups.push(group);
      }
    });
    const diagnostics = diagnosticGroups
      .slice(0, 8)
      .map(
        item =>
          `<div class="wb-activity"><span class="badge ${item.status === 'failed' || item.status === 'blocked' ? 'b-red' : 'b-yellow'}">${esc(item.status)}</span><div><strong>${esc(item.title)}${item.count > 1 ? ` <span class="badge b-gray">${item.count} matches</span>` : ''}</strong><small>waiting on ${esc(item.waiting_on || 'none')} · ${esc(item.next_action)}</small></div></div>`
      )
      .join('');
    const filterButtons = WORK_BOARD_COLUMNS.map(
      ([key, label]) =>
        `<button type="button" class="btn sm ${WORK_BOARD_INCLUDE.has(key) ? 'primary' : ''}" data-wb-include="${key}" aria-label="Show only ${esc(label)}" aria-pressed="${WORK_BOARD_INCLUDE.has(key)}">${label}</button>`
    ).join('');
    const excludeButtons = WORK_BOARD_COLUMNS.map(
      ([key, label]) =>
        `<button type="button" class="btn sm ${WORK_BOARD_EXCLUDE.has(key) ? 'danger' : ''}" data-wb-exclude="${key}" aria-label="Hide ${esc(label)}" aria-pressed="${WORK_BOARD_EXCLUDE.has(key)}">${label}</button>`
    ).join('');
    app.innerHTML = `<div class="page-head wb-head"><div><div class="cq-eyebrow">FLEET DELIVERY SYSTEM</div><h2 class="page-title">Work Board</h2><div class="crumbs">Backlog, agents, schedules, approval gates, and delivery evidence in one operating view.</div></div><div class="wb-head-actions"><span class="muted">PM tick: every 15 min</span><button type="button" class="btn" id="wb-board-refresh">↻ Refresh</button><button type="button" class="btn primary" id="wb-new">＋ Add backlog work</button></div></div><section class="wb-summary"><div><strong>${items.length}</strong><span>matching work items</span></div><div><strong>${counts[3]}</strong><span>approval gates</span></div><div><strong>${counts[4]}</strong><span>blocked</span></div><div><strong>${data.settings?.change_queue?.max_concurrent || 1}</strong><span>worker capacity</span></div></section><div class="wb-toolbar"><label class="wb-board-search">Find work<input id="wb-board-search" class="cm-input" type="search" aria-label="Search work board items" placeholder="Title, site, owner, or next action…" value="${esc(WORK_BOARD_QUERY)}"></label><div class="wb-filter-controls"><div class="wb-filter-line"><span class="wb-filter-label">Show only</span><button type="button" class="btn sm ${!WORK_BOARD_INCLUDE.size ? 'primary' : ''}" data-wb-clear="include" aria-label="Show all work board lanes" aria-pressed="${!WORK_BOARD_INCLUDE.size}">All</button>${filterButtons}</div><div class="wb-filter-line"><span class="wb-filter-label">Hide</span>${excludeButtons}<button type="button" class="btn sm" data-wb-clear="exclude" aria-label="Clear hidden work board lanes">Clear hidden</button></div></div><span class="muted">Select multiple lanes to combine them. Filters are remembered on this device; drag/drop still updates durable state.</span></div><div class="wb-layout"><section class="wb-board">${WORK_BOARD_COLUMNS.map(
      ([key, label], index) =>
        renderWorkflowBoardLane(
          key,
          label,
          items.filter(item => workBoardColumn(item) === key),
          counts[index]
        )
    ).join(
      ''
    )}</section><aside class="card wb-activity-panel"><div class="cq-section-head"><div><div class="cq-eyebrow">WHY IS WORK WAITING?</div><h3>Diagnostics</h3></div><span class="muted">${(data.diagnostics || []).length} flagged · ${diagnosticGroups.length} unique</span></div>${diagnostics || '<div class="muted">No blocked or waiting work.</div>'}<div class="cq-section-head" style="margin-top:16px"><div><div class="cq-eyebrow">AUDIT STREAM</div><h3>Latest actions</h3></div><span class="muted">${(data.actions || []).length} recorded</span></div>${activity || '<div class="muted">No executive actions recorded yet.</div>'}<details class="wb-gates"><summary>What the gates mean</summary><p><b>Ready</b> means queued but not running. <b>Approval / review</b> means a human, executive, or automated reviewer must decide before delivery. <b>Done</b> is terminal evidence, not merely a completed model response.</p></details></aside></div>`;
    $('#wb-board-refresh').onclick = () => renderWorkflowBoard();
    $('#wb-new').onclick = () => showWorkflowBacklogForm();
    $('#wb-board-search').oninput = event => {
      clearTimeout(WORK_BOARD_SEARCH_TIMER);
      const value = event.target.value.trim().toLowerCase();
      WORK_BOARD_SEARCH_TIMER = setTimeout(() => {
        WORK_BOARD_QUERY = value;
        WORK_BOARD_COLUMNS.forEach(([key]) => (WORK_BOARD_PAGES[key] = 1));
        renderWorkflowBoard();
      }, 180);
    };
    $$('[data-wb-include]').forEach(
      button =>
        (button.onclick = () => {
          const key = button.dataset.wbInclude;
          toggleWorkBoardFilter('include', key);
          renderWorkflowBoard();
        })
    );
    $$('[data-wb-exclude]').forEach(
      button =>
        (button.onclick = () => {
          const key = button.dataset.wbExclude;
          toggleWorkBoardFilter('exclude', key);
          renderWorkflowBoard();
        })
    );
    $$('[data-wb-clear]').forEach(
      button =>
        (button.onclick = () => {
          clearWorkBoardFilter(button.dataset.wbClear);
          renderWorkflowBoard();
        })
    );
    $$('[data-wb-page]').forEach(
      button =>
        (button.onclick = () => {
          const key = button.dataset.wbPage;
          WORK_BOARD_PAGES[key] =
            (WORK_BOARD_PAGES[key] || 1) + Number(button.dataset.direction || 0);
          renderWorkflowBoard();
        })
    );
    $$('.wb-open').forEach(
      button =>
        (button.onclick = () =>
          openWorkflowItem(button.dataset.wbSource, button.dataset.wbId, data))
    );
    $$('.wb-card').forEach(card =>
      card.addEventListener('dragstart', event =>
        event.dataTransfer.setData(
          'text/plain',
          JSON.stringify({ source: card.dataset.wbSource, id: card.dataset.wbId })
        )
      )
    );
    $$('.wb-column').forEach(column => {
      column.addEventListener('dragover', event => {
        event.preventDefault();
        column.classList.add('is-over');
      });
      column.addEventListener('dragleave', () => column.classList.remove('is-over'));
      column.addEventListener('drop', async event => {
        event.preventDefault();
        column.classList.remove('is-over');
        const item = JSON.parse(event.dataTransfer.getData('text/plain') || '{}');
        try {
          await moveWorkflowItem(item.source, item.id, column.dataset.wbDrop, data);
          toast('Work moved');
          renderWorkflowBoard();
        } catch (e) {
          toast(e.message, 'err');
        }
      });
    });
    if (!FRESH) applyUISnap();
    stamp();
  } catch (e) {
    renderViewError(app, e.message);
  }
}

function showWorkflowBacklogForm() {
  const modal = $('#modal');
  $('#modal-title').textContent = 'Add backlog work';
  $('#modal-body').innerHTML =
    `<div class="field"><label>Title</label><input id="wb-title" placeholder="A clear outcome, not a vague task"></div><div class="field-row"><div class="field"><label>Kind</label><select id="wb-kind"><option>implementation</option><option>research</option><option>decision</option><option>incident</option><option>evidence</option></select></div><div class="field"><label>Priority</label><select id="wb-priority"><option>urgent</option><option>high</option><option selected>normal</option><option>low</option></select></div><div class="field"><label>Owner</label><select id="wb-owner"><option>project-manager</option><option>domain-manager</option><option>engineer</option><option>principal-engineer</option><option>ceo</option><option>cto</option></select></div></div><div class="field"><label>Site (optional)</label><input id="wb-site" placeholder="example.com or fleet"></div><div class="field"><label>Brief / context</label><textarea id="wb-summary" rows="4" placeholder="What outcome should this work produce?"></textarea></div><div class="field"><label>Next action / acceptance criteria</label><textarea id="wb-next" rows="4" placeholder="The smallest next step and how we know it is done"></textarea></div><div class="modal-actions"><button class="btn" id="wb-cancel">Cancel</button><button class="btn primary" id="wb-save">Add to backlog</button></div>`;
  modal.classList.remove('hidden');
  $('#wb-cancel').onclick = closeModal;
  $('#wb-save').onclick = async () => {
    const button = $('#wb-save');
    button.disabled = true;
    try {
      await api('POST', '/api/executive/work-items', {
        title: $('#wb-title').value,
        kind: $('#wb-kind').value,
        priority: $('#wb-priority').value,
        owner: $('#wb-owner').value,
        site: $('#wb-site').value || null,
        summary: $('#wb-summary').value,
        next_action: $('#wb-next').value,
        created_by: 'owner',
      });
      closeModal(true);
      toast('Added to backlog');
      renderWorkflowBoard();
    } catch (e) {
      button.disabled = false;
      toast(e.message, 'err');
    }
  };
}

async function moveWorkflowItem(source, id, column, data) {
  if (source === 'work-item') {
    const node = data.workflow?.nodes?.[`work-item:${id}`];
    if (column === 'active' && node?.ready === false)
      throw new Error(`Blocked by ${node.blockers.join(', ')}`);
    const status = {
      backlog: 'open',
      active: 'in_progress',
      blocked: 'blocked',
      done: 'done',
      ready: 'ready',
      approval: 'waiting',
    }[column];
    const patch = {
      status,
      expected_updated_at: (data.work_items || []).find(row => row.work_id === id)?.updated_at,
    };
    if (status === 'done') {
      const outcome = await requestModalText({
        title: 'Complete work item',
        label: 'Outcome or evidence',
        placeholder: 'What was delivered, verified, or learned?',
        required: true,
        submitLabel: 'Complete work',
      });
      if (!outcome) throw new Error('Completion cancelled: outcome or evidence is required');
      patch.outcome = outcome;
    }
    return api('PATCH', `/api/executive/work-items/${encodeURIComponent(id)}`, patch);
  }
  if (source === 'request') {
    const request = (data.requests || []).find(row => row.request_id === id);
    if (column === 'ready' && request.status === 'failed')
      return api('POST', `/api/change-requests/${encodeURIComponent(id)}/retry`, {});
    if (column === 'active' && request.status === 'queued')
      return api('POST', `/api/change-requests/${encodeURIComponent(id)}/pickup`, {});
    if (column === 'approval' && request.status === 'review')
      return api('POST', `/api/change-requests/${encodeURIComponent(id)}/auto-review`, {});
  }
  throw new Error('This transition must use its approval-aware action');
}

async function renderDataQuality() {
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Checking data contracts…</div></div>';
  let data;
  try {
    data = await api('GET', '/api/data-quality');
  } catch (e) {
    renderViewError(app, e.message);
    return;
  }
  const rows = (data.contracts || [])
    .map(
      row =>
        `<tr><td><strong>${esc(row.source)}</strong></td><td><span class="badge ${row.status === 'green' ? 'b-green' : row.status === 'yellow' ? 'b-yellow' : 'b-red'}">${esc(row.status)}</span></td><td>${row.observed} / ${row.expected}</td><td>${Math.round(row.completeness * 100)}%</td><td>${row.freshest_at ? esc(fmtDate(row.freshest_at)) : '—'}</td><td class="muted">${esc(row.error || '')}</td></tr>`
    )
    .join('');
  app.innerHTML = `<div class="page-head"><div><h2 class="page-title">Data Quality</h2><div class="crumbs">Freshness, completeness, and attribution contracts</div></div><button type="button" class="btn" id="dataquality-refresh">↻ Refresh</button></div><section class="seo-stats dq-stats" aria-label="Contract health summary"><div class="seo-stat dq-healthy"><div class="seo-stat-value">${data.totals.green}</div><div class="seo-stat-label">Healthy</div></div><div class="seo-stat dq-partial"><div class="seo-stat-value">${data.totals.yellow}</div><div class="seo-stat-label">Partial</div></div><div class="seo-stat dq-broken"><div class="seo-stat-value">${data.totals.red}</div><div class="seo-stat-label">Broken</div></div></section><section class="card dq-contracts"><div class="matrix-scroll-hint" role="note">Swipe horizontally to compare coverage, freshness, and error details</div><div class="table-wrap" tabindex="0" role="region" aria-label="Data quality contract status"><table class="tbl"><caption class="sr-only">Data quality contract status</caption><thead><tr><th>Source</th><th>Status</th><th>Coverage</th><th>Complete</th><th>Freshest</th><th>Error / boundary</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted">No data quality contracts have been recorded yet.</td></tr>'}</tbody></table></div></section>`;
  $('#dataquality-refresh').onclick = () => renderDataQuality();
  if (!FRESH) applyUISnap();
  stamp();
}

async function renderAutomation() {
  app.innerHTML = `<div class="page-head"><div><h2 class="page-title">Automation</h2><span class="muted">Approval, cadence, worker switches, schedules, and prompts — per site</span></div><button type="button" class="btn" id="auto-refresh">↻ Refresh</button></div>
    <div class="task-toolbar auto-site-toolbar"><button id="auto-site-prev" class="btn sm auto-site-nav" type="button" aria-label="Previous site" title="Previous site">←</button><select id="auto-site" class="cm-input" aria-label="Automation site">${automationSiteOptions(AUTO_SITE)}</select><button id="auto-site-next" class="btn sm auto-site-nav" type="button" aria-label="Next site" title="Next site">→</button><span class="muted">Changes are written to tracked site ops files.</span></div>
    <div id="auto-body" class="${AUTO_SITE ? 'async-loading' : 'empty'}" ${AUTO_SITE ? 'role="status" aria-live="polite"' : ''}>${AUTO_SITE ? 'Loading automation controls…' : 'Select a site to manage its automation.'}</div>`;
  $('#auto-refresh').addEventListener('click', () => renderAutomation());
  $('#auto-site').addEventListener('change', e => {
    AUTO_SITE = e.target.value;
    renderAutomation();
  });
  $('#auto-site-prev').addEventListener('click', () => cycleAutomationSite(-1));
  $('#auto-site-next').addEventListener('click', () => cycleAutomationSite(1));
  const siteNavDisabled = !(STATE.sites || []).length;
  $('#auto-site-prev').disabled = siteNavDisabled;
  $('#auto-site-next').disabled = siteNavDisabled;
  if (!AUTO_SITE) {
    if (!FRESH) applyUISnap();
    return;
  }
  let data;
  try {
    data = await api('GET', `/api/automation/${encodeURIComponent(AUTO_SITE)}`);
  } catch (e) {
    renderViewError($('#auto-body'), e.message);
    if (!FRESH) applyUISnap();
    return;
  }
  const cfg = data.social.config || {};
  const cadence = cfg.cadence || {};
  const reply = cfg.reply || {};
  const ai = cfg.ai || {};
  const quietHours = cadence.quiet_hours || [3, 11];
  const slots = cadence.slots || ['12:20', '17:40', '21:10'];
  const hashtags = Array.isArray(cfg.hashtags) ? cfg.hashtags.join(', ') : '';
  const roles = data.roles || [];
  const roleDraft = AUTO_ROLE_DRAFT && AUTO_ROLE_DRAFT.site === AUTO_SITE ? AUTO_ROLE_DRAFT : null;
  AUTO_ROLE_DRAFT = null;
  const newRoleSchedule = roleDraft?.schedule || '0 */2 * * *';
  const platformRows = (cfg.platforms || [])
    .map((platform, i) => {
      const override = (cfg.platform_overrides || {})[platform] || {};
      const approval = override.approval || cfg.approval || 'auto';
      return `<label>${esc(platform)} approval<select id="auto-platform-${i}" data-platform-approval="${esc(platform)}" class="cm-input"><option value="auto" ${approval === 'auto' ? 'selected' : ''}>Automatic</option><option value="manual" ${approval === 'manual' ? 'selected' : ''}>Require human approval</option></select></label>`;
    })
    .join('');
  $('#auto-body').innerHTML = `
    <div class="cards">
      <section class="card">
        <div class="page-head"><div><h3>Social Hub policy</h3><span class="muted">${esc(data.social.file)}</span></div><span class="badge ${cfg.enabled !== false ? 'b-green' : 'b-gray'}">${cfg.enabled !== false ? 'enabled' : 'disabled'}</span></div>
        <p class="auto-section-help">Controls how new site content becomes social drafts, scheduled posts, and replies. Changes apply to this site only.</p>
        <div class="auto-settings-section"><h4>Publishing</h4><div class="form-grid">
          <label>Social Hub<select id="auto-enabled" class="cm-input"><option value="true" ${cfg.enabled !== false ? 'selected' : ''}>Enabled</option><option value="false" ${cfg.enabled === false ? 'selected' : ''}>Disabled</option></select><small>Stops this site from being managed by the hub.</small></label>
          <label>Public post approval<select id="auto-approval" class="cm-input"><option value="auto" ${cfg.approval === 'auto' ? 'selected' : ''}>Automatic</option><option value="manual" ${cfg.approval === 'manual' ? 'selected' : ''}>Require human approval</option></select><small>Automatic approval also schedules the first draft.</small></label>
          <label>Variants per article<input id="auto-variants" class="cm-input" type="number" min="1" step="1" value="${esc(cfg.variants_per_source ?? 1)}"><small>Only the first variant can be auto-scheduled.</small></label>
          <label>Max source age (hours)<input id="auto-age" class="cm-input" type="number" min="0" step="1" value="${esc(cfg.max_source_age_hours ?? 72)}"><small>Older content is recorded but not queued.</small></label>
          <label>Sources per tick<input id="auto-source-limit" class="cm-input" type="number" min="0" step="1" value="${esc(cfg.max_sources_per_run ?? 2)}"><small>Drafting budget per 15-minute hub tick.</small></label>
          <label>Link style<select id="auto-link-style" class="cm-input"><option value="append" ${cfg.link_style !== 'none' ? 'selected' : ''}>Append article link</option><option value="none" ${cfg.link_style === 'none' ? 'selected' : ''}>No article link</option></select></label>
        </div></div>
        <div class="auto-settings-section"><h4>Post timing</h4><div class="form-grid">
          <label>Posts per platform/day<input id="auto-per-day" class="cm-input" type="number" min="0" step="1" value="${esc(cadence.per_platform_per_day ?? 3)}"></label>
          <label>Minimum gap (minutes)<input id="auto-gap" class="cm-input" type="number" min="0" step="1" value="${esc(cadence.min_gap_minutes ?? 90)}"></label>
          <label>Preferred send times<input id="auto-slots" class="cm-input" type="text" value="${esc(slots.join(', '))}" placeholder="12:20, 17:40, 21:10"><small>UTC, comma-separated. The scheduler uses the next available slot.</small></label>
          <label>Quiet hours<input id="auto-quiet-start" class="cm-input" type="number" min="0" max="23" step="1" value="${esc(quietHours[0])}"><input id="auto-quiet-end" class="cm-input auto-inline-input" type="number" min="0" max="23" step="1" value="${esc(quietHours[1])}"><small>UTC hours, from start (inclusive) to end (exclusive).</small></label>
          <label>Immediate mode<select id="auto-immediate" class="cm-input"><option value="false" ${cadence.immediate ? '' : 'selected'}>Use preferred times</option><option value="true" ${cadence.immediate ? 'selected' : ''}>Post as soon as allowed</option></select><small>Still respects caps, gaps, and quiet hours.</small></label>
          <label>Site staggering<select id="auto-stagger" class="cm-input"><option value="true" ${cadence.stagger !== false ? 'selected' : ''}>Stagger sites</option><option value="false" ${cadence.stagger === false ? 'selected' : ''}>Use exact slot times</option></select></label>
        </div></div>
        <div class="auto-settings-section"><h4>Replies and AI</h4><div class="form-grid">
          <label>Reply handling<select id="auto-reply-enabled" class="cm-input"><option value="true" ${reply.enabled !== false ? 'selected' : ''}>Monitor replies</option><option value="false" ${reply.enabled === false ? 'selected' : ''}>Ignore replies</option></select></label>
          <label>Reply approval<select id="auto-reply-approval" class="cm-input"><option value="manual" ${reply.approval === 'manual' ? 'selected' : ''}>Require human approval</option><option value="auto" ${reply.approval === 'auto' ? 'selected' : ''}>Automatic</option></select></label>
          <label>Replies per day<input id="auto-reply-max" class="cm-input" type="number" min="0" step="1" value="${esc(reply.max_per_day ?? 12)}"></label>
          <label>Reply poll limit<input id="auto-reply-poll" class="cm-input" type="number" min="0" step="1" value="${esc(reply.poll_limit ?? 25)}"><small>Maximum mentions checked per tick.</small></label>
          <label>AI backend<select id="auto-ai-backend" class="cm-input"><option value="auto" ${ai.backend === 'auto' || !ai.backend ? 'selected' : ''}>Automatic</option><option value="cli" ${ai.backend === 'cli' ? 'selected' : ''}>Tracked Claude CLI</option><option value="api" ${ai.backend === 'api' ? 'selected' : ''}>Anthropic API</option><option value="fake" ${ai.backend === 'fake' ? 'selected' : ''}>Test/fallback only</option></select></label>
          <label>AI model<input id="auto-ai-model" class="cm-input" type="text" value="${esc(ai.model ?? 'claude-sonnet-4-6')}"></label>
          <label>Max AI tokens<input id="auto-ai-tokens" class="cm-input" type="number" min="1" step="1" value="${esc(ai.max_tokens ?? 1200)}"></label>
          <label>Hashtags<input id="auto-hashtags" class="cm-input" type="text" value="${esc(hashtags)}" placeholder="#infosec, #news"><small>Comma-separated; leave blank for none.</small></label>
        </div></div>
        <div class="auto-settings-section"><h4>Brand voice and guardrails</h4><div class="form-grid auto-wide-fields">
          <label>Brand voice<textarea id="auto-voice" class="cm-input" rows="4" placeholder="How should this brand sound?">${esc(cfg.voice || '')}</textarea></label>
          <label>Content direction and ideas<textarea id="auto-direction" class="cm-input" rows="4" placeholder="Topics, angles, recurring series, and ideas the writers should prioritize…">${esc(cfg.content_direction || '')}</textarea><small>Guides new AI social drafts for this site; it does not rewrite existing posts.</small></label>
          <label>AI guardrails<textarea id="auto-guardrails" class="cm-input" rows="4" placeholder="What must the model never say or do?">${esc(ai.guardrails || '')}</textarea></label>
        </div></div>
        ${platformRows ? `<div class="page-head"><strong>Per-platform post approval</strong><span class="muted">Overrides the global policy above.</span></div><div class="form-grid">${platformRows}</div>` : ''}
        <div class="task-actions"><button id="auto-social-save" class="btn primary">Save policy</button><button id="auto-rebuild" class="btn">Rebuild cron container</button><span id="auto-social-msg" class="muted"></span></div>
        <details class="auto-raw"><summary>Advanced: edit complete hub.yaml</summary><textarea id="auto-social-raw" class="cm-input" rows="20" spellcheck="false">${esc(data.social.raw)}</textarea><div class="task-actions"><button id="auto-raw-save" class="btn">Save complete YAML</button></div></details>
      </section>
    </div>
    <section class="card"><div class="page-head"><h3>Scheduled roles</h3><span class="muted">Disable, change cadence, or edit the full role prompt. Schedule changes require a cron rebuild.</span></div>
      <details class="auto-role" ${roleDraft ? 'open' : ''}><summary><strong>＋ Add worker role</strong><span class="muted">Create a separate writer, promotion, or breaking-news loop.</span></summary>
        ${roleDraft ? `<div class="auto-enroll-callout"><strong>Enrolling ${esc(roleDraft.role)} on ${esc(AUTO_SITE)}</strong><span class="muted">Review the schedule and prompt, then add the role. The cron container must be rebuilt before it runs.</span></div>` : ''}
        <div class="form-grid"><label>Role name<input id="auto-new-role" class="cm-input" placeholder="news-writer" pattern="[a-z0-9-]+" value="${esc(roleDraft?.role || '')}"></label><label>Schedule${automationSchedulePicker('auto-new-schedule', newRoleSchedule)}</label><label>Start enabled<select id="auto-new-enabled" class="cm-input"><option value="true">On</option><option value="false">Off</option></select></label></div>
        <label>Prompt / role instructions<textarea id="auto-new-prompt" class="cm-input" rows="10" placeholder="# News Writer\nDescribe the role's job, guardrails, and output contract." spellcheck="false"></textarea></label>
        <div class="task-actions"><button id="auto-new-save" class="btn primary">Add worker role</button></div>
      </details>
      ${
        roles.length
          ? roles
              .map(
                (
                  r,
                  i
                ) => `<details class="auto-role" data-auto-role="${esc(r.role)}"><summary><span class="badge ${r.enabled ? 'b-green' : 'b-gray'}">${r.enabled ? 'on' : 'off'}</span> <strong>${esc(r.role)}</strong><span class="muted mono">${esc(r.schedule)}</span>${r.entries.length > 1 ? `<span class="badge b-yellow">${r.entries.length} schedules</span>` : ''}</summary>
        <div class="form-grid"><label>Enabled<select class="cm-input auto-role-enabled" ${r.worker ? '' : 'disabled'}><option value="true" ${r.enabled ? 'selected' : ''}>On</option><option value="false" ${!r.enabled ? 'selected' : ''}>Off</option></select>${r.worker ? '' : '<span class="muted">Dedicated job; use its script/container controls.</span>'}</label><label>Schedule${automationSchedulePicker(`auto-role-schedule-${i}`, r.schedule)}</label></div>
        <label>Prompt / role instructions<textarea class="cm-input auto-role-prompt" rows="14" spellcheck="false">${esc(r.prompt || '')}</textarea></label>
        <div class="task-actions"><button class="btn primary auto-role-save" data-role="${esc(r.role)}">Save ${esc(r.role)}</button><span class="muted">${esc(r.promptPath || 'no prompt file; saving creates one')}</span></div>
      </details>`
              )
              .join('')
          : '<div class="empty">No scheduled worker roles found.</div>'
      }
    </section>`;

  wireAutomationSchedulePickers();

  $('#auto-social-save').addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const platformApprovals = {};
      $$('[data-platform-approval]').forEach(select => {
        platformApprovals[select.dataset.platformApproval] = select.value;
      });
      const slots = $('#auto-slots')
        .value.split(',')
        .map(slot => slot.trim())
        .filter(Boolean);
      const hashtags = $('#auto-hashtags')
        .value.split(',')
        .map(tag => tag.trim())
        .filter(Boolean);
      await api('PATCH', `/api/automation/${encodeURIComponent(AUTO_SITE)}/social`, {
        enabled: $('#auto-enabled').value === 'true',
        approval: $('#auto-approval').value,
        platformApprovals,
        max_source_age_hours: Number($('#auto-age').value),
        variants_per_source: Number($('#auto-variants').value),
        max_sources_per_run: Number($('#auto-source-limit').value),
        voice: $('#auto-voice').value,
        content_direction: $('#auto-direction').value,
        hashtags,
        link_style: $('#auto-link-style').value,
        cadence: {
          per_platform_per_day: Number($('#auto-per-day').value),
          min_gap_minutes: Number($('#auto-gap').value),
          slots,
          quiet_hours: [Number($('#auto-quiet-start').value), Number($('#auto-quiet-end').value)],
          immediate: $('#auto-immediate').value === 'true',
          stagger: $('#auto-stagger').value === 'true',
        },
        reply: {
          enabled: $('#auto-reply-enabled').value === 'true',
          approval: $('#auto-reply-approval').value,
          max_per_day: Number($('#auto-reply-max').value),
          poll_limit: Number($('#auto-reply-poll').value),
        },
        ai: {
          backend: $('#auto-ai-backend').value,
          model: $('#auto-ai-model').value.trim(),
          max_tokens: Number($('#auto-ai-tokens').value),
          guardrails: $('#auto-guardrails').value,
        },
      });
      $('#auto-social-msg').textContent = 'Saved.';
      toast('Social Hub policy saved');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });
  $('#auto-raw-save').addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api('PUT', `/api/automation/${encodeURIComponent(AUTO_SITE)}/social`, {
        raw: $('#auto-social-raw').value,
      });
      toast('Complete hub.yaml saved');
      renderAutomation();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });
  $('#auto-rebuild').addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    $('#auto-social-msg').textContent = 'Rebuilding…';
    try {
      const res = await fetch(`/api/cron/systems/${encodeURIComponent(AUTO_SITE)}/rebuild`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      const text = await res.text();
      if (!res.ok || !text.includes('@@VERDICT ok'))
        throw new Error(text.slice(-500) || `rebuild failed (${res.status})`);
      $('#auto-social-msg').textContent = 'Cron container rebuilt and verified.';
      toast('Cron container rebuilt');
    } catch (err) {
      $('#auto-social-msg').textContent = err.message;
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });
  $('#auto-new-save').addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api('POST', `/api/automation/${encodeURIComponent(AUTO_SITE)}/roles`, {
        role: $('#auto-new-role').value,
        schedule: $('#auto-new-schedule').value,
        enabled: $('#auto-new-enabled').value === 'true',
        prompt: $('#auto-new-prompt').value,
      });
      toast('Worker role added');
      renderAutomation();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });
  $$('.auto-role-save').forEach(btn =>
    btn.addEventListener('click', async () => {
      const card = btn.closest('[data-auto-role]');
      btn.disabled = true;
      try {
        await api(
          'PATCH',
          `/api/automation/${encodeURIComponent(AUTO_SITE)}/roles/${encodeURIComponent(btn.dataset.role)}`,
          {
            enabled: card.querySelector('.auto-role-enabled').value === 'true',
            schedule: card.querySelector('.auto-role-schedule').value,
            prompt: card.querySelector('.auto-role-prompt').value,
          }
        );
        toast(`${btn.dataset.role} saved`);
        renderAutomation();
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    })
  );
  if (!FRESH) applyUISnap();
  const siteSelect = $('#auto-site');
  if (siteSelect) siteSelect.value = AUTO_SITE;
}

function mountExecutiveWorkspaceNav(active) {
  const shell = document.querySelector('.ex-shell');
  if (!shell || document.querySelector('.ex-workspace-nav')) return;
  const copy =
    {
      overview: [
        'Command center',
        'A calm starting point for decisions, alerts, and the next most important action.',
      ],
      dashboard: [
        'Dashboard',
        'A full-width view of executive runs, durable follow-through, decisions, and fleet operations.',
      ],
      conversation: [
        'Conversation',
        'Read the team’s messages, requests, responses, and operator-visible background work in one threaded workspace.',
      ],
      runs: [
        'Runs',
        'Monitor scheduled and operator-triggered executive runs with clear status and failure context.',
      ],
      work: [
        'Work',
        'Track owner requests, active queues, and work that needs acknowledgement or follow-through.',
      ],
      decisions: [
        'Decisions',
        'Review proposals, approval gates, CRO handoffs, and the durable decision record.',
      ],
      signals: [
        'Signals',
        'Inspect the fleet telemetry that informs executive priorities without mixing it into the work queue.',
      ],
      setup: [
        'Executive settings',
        'Manage the strategy contract, recurring cadence, and transcript retention policy.',
      ],
      runtime: [
        'Agent runtime',
        'Operate agent identity, runs, budgets, watchdogs, evaluations, grants, and workspaces.',
      ],
    }[active] || null;
  if (copy) {
    const title = shell.querySelector('.page-title');
    const description = shell.querySelector('.ex-hero p.muted');
    if (title) title.textContent = copy[0];
    if (description) description.textContent = copy[1];
  }
  const items = [
    ['dashboard', 'Dashboard', 'Executive overview'],
    ['overview', 'Command center', 'Decisions at a glance'],
    ['conversation', 'Conversation', 'Messages & transcript'],
    ['runs', 'Runs', 'Live execution history'],
    ['work', 'Work', 'Requests & queues'],
    ['decisions', 'Decisions', 'Approvals & history'],
    ['signals', 'Signals', 'Fleet telemetry'],
    ['runtime', 'Agent runtime', 'Agents, budgets & safeguards'],
    ['setup', 'Settings', 'Strategy & retention'],
  ];
  const nav = document.createElement('nav');
  nav.className = 'ex-workspace-nav';
  nav.setAttribute('aria-label', 'Executive workspace');
  nav.innerHTML = items
    .map(
      ([key, label, description]) =>
        `<button type="button" class="ex-workspace-tab ${active === key ? 'active' : ''}" data-ex-workspace="${key}" title="${esc(`${label}: ${description}`)}" aria-label="${esc(`${label}: ${description}`)}"><span>${esc(label)}</span><small>${esc(description)}</small></button>`
    )
    .join('');
  shell.insertBefore(nav, shell.firstElementChild?.nextElementSibling || shell.firstChild);
  nav.querySelectorAll('[data-ex-workspace]').forEach(button => {
    button.onclick = () =>
      go(
        'agent',
        'executive',
        button.dataset.exWorkspace === 'overview' ? null : button.dataset.exWorkspace
      );
  });
}

function applyExecutiveWorkspace(page) {
  const shell = document.querySelector('.ex-shell');
  if (!shell || page === 'setup') return;
  shell.dataset.workspace = page;
  const primary = shell.querySelector('.ex-primary');
  const secondary = shell.querySelector('.ex-secondary');
  const layout = shell.querySelector('.ex-layout');
  const run = shell.querySelector('.ex-run-panel');
  const followThrough = shell.querySelector('.ex-followthrough');
  const attention = shell.querySelector('.ex-attention');
  const compose = shell.querySelector('.ex-compose');
  const cases = shell.querySelector('.ex-cases');
  const requests = shell.querySelector('.ex-requests');
  const transcript = shell.querySelector('.ex-transcript-panel');
  const recent = [...shell.querySelectorAll('.ex-disclosure')].find(el =>
    el.textContent.includes('Recent conversation')
  );
  const details = [...shell.querySelectorAll('.ex-disclosure')];
  const strategy = details.find(el => el.textContent.includes('Strategy contract'));
  const performance = details.find(el => el.textContent.includes('Performance & revenue'));
  const decisions = details.find(el => el.textContent.includes('Decision history'));
  const hide = element => {
    if (element) element.classList.add('ex-workspace-hidden');
  };
  const show = element => {
    if (element) element.classList.remove('ex-workspace-hidden');
  };
  [
    run,
    followThrough,
    attention,
    compose,
    cases,
    requests,
    transcript,
    recent,
    secondary,
    strategy,
    performance,
    decisions,
  ].forEach(show);
  show(layout);
  if (page === 'dashboard') {
    hide(attention);
    hide(compose);
    hide(cases);
    hide(requests);
    hide(transcript);
    hide(recent);
    hide(strategy);
    hide(performance);
    hide(decisions);
  } else if (page === 'overview') {
    hide(run);
    hide(compose);
    hide(cases);
    hide(requests);
    hide(transcript);
    hide(recent);
    hide(secondary);
    hide(strategy);
    hide(performance);
    hide(decisions);
  } else if (page === 'conversation') {
    hide(run);
    hide(cases);
    hide(attention);
    hide(secondary);
    hide(transcript);
    hide(recent);
    hide(strategy);
    hide(performance);
    hide(decisions);
    const split = requests?.querySelector('.ex-request-split');
    if (split && compose) {
      // Keep the new-conversation composer above the split view. Appending it
      // to the selected detail pane made it disappear when the inbox was
      // empty (or when no thread was selected), which made this tab look
      // read-only.
      requests.insertBefore(compose, split);
      compose.classList.remove('ex-workspace-hidden');
      const heading = compose.querySelector('h3');
      const note = compose.querySelector('.muted');
      const button = compose.querySelector('#ex-send');
      if (heading) heading.textContent = 'Message the executive team';
      if (note)
        note.textContent =
          'Start a durable request here, then use the selected thread below to continue the conversation.';
      if (button) button.textContent = 'Start conversation';
    }
  } else if (page === 'runs') {
    hide(attention);
    hide(compose);
    hide(requests);
    hide(cases);
    hide(transcript);
    hide(recent);
    hide(secondary);
    hide(strategy);
    hide(performance);
    hide(decisions);
  } else if (page === 'work') {
    hide(run);
    hide(attention);
    hide(compose);
    hide(transcript);
    hide(recent);
    hide(strategy);
    hide(performance);
    hide(decisions);
  } else if (page === 'decisions') {
    hide(layout);
    hide(strategy);
    hide(performance);
    // The decisions workspace is a focused view, so its only visible panel
    // must be expanded. The panel is a <details> element in the shared
    // executive shell; leaving it closed makes this route look empty even
    // when proposals and audit actions were loaded successfully.
    show(decisions);
    if (decisions) decisions.open = true;
  } else if (page === 'signals') {
    hide(primary);
    hide(strategy);
    hide(decisions);
    show(performance);
    show(secondary);
  }
}

async function renderAgentRuntime() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading agent runtime…</div></div>';
  try {
    const [
      agents,
      runs,
      budgets,
      routines,
      watchdogs,
      evals,
      grants,
      workspaces,
      actor,
      users,
      issues,
      policies,
      decisions,
      suites,
      evalRuns,
      blobs,
      plugins,
      connectors,
      providers,
      adapters,
      delegations,
      dispatches,
      artifacts,
      skills,
      memories,
      productivityPilots,
    ] = await Promise.all([
      api('GET', '/api/agents?limit=100'),
      api('GET', '/api/agent-runs?limit=100'),
      api('GET', '/api/budgets?limit=100'),
      api('GET', '/api/agent-routines?limit=100'),
      api('GET', '/api/agent-watchdogs?limit=100'),
      api('GET', '/api/agent-evals?limit=100'),
      api('GET', '/api/agent-tools?limit=100'),
      api('GET', '/api/agent-workspaces?limit=100'),
      api('GET', '/api/platform/actor'),
      api('GET', '/api/platform/users?limit=100'),
      api('GET', '/api/agent-issues?limit=100'),
      api('GET', '/api/execution-policies?limit=100'),
      api('GET', '/api/governance-decisions?limit=100'),
      api('GET', '/api/eval-suites?limit=100'),
      api('GET', '/api/eval-runs?limit=100'),
      api('GET', '/api/object-blobs?limit=100'),
      api('GET', '/api/runtime-plugins?limit=100'),
      api('GET', '/api/runtime-connectors?limit=100'),
      api('GET', '/api/runtime-providers?limit=100'),
      api('GET', '/api/runtime-adapters?limit=100'),
      api('GET', '/api/agent-delegations?limit=100'),
      api('GET', '/api/agent-dispatches?limit=100'),
      api('GET', '/api/agent-artifacts?limit=100'),
      api('GET', '/api/agent-skills?limit=100'),
      api('GET', '/api/agent-memories?limit=100'),
      api('GET', '/api/productivity/pilots?limit=20'),
    ]);
    const agentRows = agents.agents || [];
    const runRows = runs.runs || [];
    const budgetRows = budgets.budgets || [];
    const routineRows = routines.routines || [];
    const watchdogRows = watchdogs.watchdogs || [];
    const evalRows = evals.evaluations || [];
    const grantRows = grants.grants || [];
    const workspaceRows = workspaces.workspaces || [];
    const issueRows = issues.issues || [];
    const policyRows = policies.policies || [];
    const decisionRows = decisions.decisions || [];
    const suiteRows = suites.suites || [];
    const evalRunRows = evalRuns.runs || [];
    const blobRows = blobs.blobs || [];
    const pluginRows = plugins.plugins || [];
    const connectorRows = connectors.connectors || [];
    const providerRows = providers.providers || [];
    const adapterRows = adapters.adapters || [];
    const productivityPilotRows = productivityPilots.pilots || [];
    const delegationRows = delegations.delegations || [];
    const dispatchRows = dispatches.dispatches || [];
    const artifactRows = artifacts.artifacts || [];
    const skillRows = skills.skills || [];
    const memoryRows = memories.memories || [];
    const activeRuns = runRows.filter(row => ['queued', 'running'].includes(row.status)).length;
    const fired = watchdogRows.filter(row => row.status === 'fired').length;
    const spent = budgetRows.reduce((sum, row) => sum + Number(row.spent_usd || 0), 0);
    const limits = budgetRows.reduce((sum, row) => sum + Number(row.limit_usd || 0), 0);
    const stat = (value, label, tone = '') =>
      `<div class="ex-kpi ${tone}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
    const agentName = id => agentRows.find(row => row.agent_id === id)?.name || id || '—';
    const statusBadge = status =>
      `<span class="badge ${status === 'active' || status === 'succeeded' || status === 'satisfied' ? 'b-green' : status === 'failed' || status === 'fired' || status === 'paused' ? 'b-red' : 'b-yellow'}">${esc(status || '—')}</span>`;
    const deliveryState = run => {
      const signal = run.result?.delivery_status;
      if (signal === 'delivered_to_downstream') return 'delivered';
      if (signal === 'failed_to_deliver') return 'failed_to_deliver';
      if (signal === 'deferred') return 'deferred';
      if (run.status === 'failed') return 'failed';
      if (run.status === 'running') return 'running';
      return run.status || 'unknown';
    };
    const deliveryBadge = state =>
      `<span class="badge ${state === 'delivered' || state === 'succeeded' ? 'b-green' : state === 'failed' || state === 'failed_to_deliver' ? 'b-red' : 'b-yellow'}">${esc(state.replaceAll('_', ' '))}</span>`;
    const deliveryStates = runRows.map(deliveryState);
    const deliveredRuns = deliveryStates.filter(state => state === 'delivered').length;
    const failedDeliveries = deliveryStates.filter(
      state => state === 'failed_to_deliver' || state === 'failed'
    ).length;
    const deferredRuns = deliveryStates.filter(state => state === 'deferred').length;
    const rows = agentRows
      .map(agent => {
        const agentRuns = runRows.filter(run => run.agent_id === agent.agent_id);
        const agentEvals = evalRows.filter(row => row.agent_id === agent.agent_id);
        const accountability = agent.workspace?.accountability || {};
        const agentDeliveryStates = agentRuns.map(deliveryState);
        const agentFailures = agentDeliveryStates.filter(
          state => state === 'failed_to_deliver' || state === 'failed'
        ).length;
        const agentDelivered = agentDeliveryStates.filter(state => state === 'delivered').length;
        const agentDeferred = agentDeliveryStates.filter(state => state === 'deferred').length;
        const average = agentEvals.length
          ? Math.round(
              agentEvals.reduce((sum, row) => sum + Number(row.score || 0), 0) / agentEvals.length
            )
          : '—';
        return `<tr><td><b>${esc(agent.name)}</b><div class="muted">${esc(agent.role)} · ${esc(agent.adapter || 'adapter')}</div></td><td>${statusBadge(agent.status)}${accountability.execution_generation ? `<div class="muted">generation ${esc(accountability.execution_generation)}</div>` : ''}</td><td>${agentDelivered} delivered · ${agentFailures} failed<div class="muted">${agentDeferred} deferred${accountability.total_failures ? ` · ${esc(accountability.total_failures)} lifetime failures` : ''}</div>${accountability.last_failure_reason ? `<div class="muted" title="${esc(accountability.last_failure_reason)}">last: ${esc(accountability.last_failure_reason.slice(0, 70))}${accountability.last_failure_reason.length > 70 ? '…' : ''}</div>` : ''}</td><td>${agentRuns.length} runs<div class="muted">${agentEvals.length ? `${average}/100 eval` : 'not evaluated'}</div></td><td><button class="btn sm agent-runtime-toggle" data-agent-id="${esc(agent.agent_id)}" data-status="${esc(agent.status)}">${agent.status === 'paused' ? 'Resume' : 'Pause'}</button></td></tr>`;
      })
      .join('');
    const runTable = runRows
      .slice(0, 30)
      .map(
        run =>
          `<tr><td><b>${esc(agentName(run.agent_id))}</b><div class="muted">${esc(run.run_id.slice(0, 12))} · ${esc(fmtDate(run.started_at))}</div></td><td>${statusBadge(run.status)}<div class="muted">${deliveryBadge(deliveryState(run))}</div></td><td>${esc(run.total_tokens || 0)} tokens<div class="muted">$${Number(run.cost_usd || 0).toFixed(4)}</div></td><td>${esc(run.error || run.result?.delivery_error || run.result?.routine || '—')}</td></tr>`
      )
      .join('');
    const budgetTable = budgetRows
      .map(
        row =>
          `<tr><td>${esc(row.scope_type)}<div class="muted">${esc(row.scope_id)}</div></td><td>$${Number(row.spent_usd || 0).toFixed(2)} / $${Number(row.limit_usd || 0).toFixed(2)}</td><td>${statusBadge(row.status)} ${row.hard_stop ? '<span class="muted">hard stop</span>' : ''}</td></tr>`
      )
      .join('');
    const routineTable = routineRows
      .map(
        row =>
          `<tr><td><b>${esc(row.name)}</b><div class="muted">${esc(agentName(row.agent_id))} · ${esc(row.trigger_type)}</div></td><td>${statusBadge(row.status)}</td><td>${esc(fmtDate(row.next_due_at))}</td></tr>`
      )
      .join('');
    const inventory = (label, value, detail = '') =>
      `<div class="ex-inventory-card"><b>${esc(value)}</b><span>${esc(label)}</span>${detail ? `<small>${esc(detail)}</small>` : ''}</div>`;
    const issueTable = issueRows
      .slice(0, 20)
      .map(
        row =>
          `<tr><td><b>${esc(row.title)}</b><div class="muted">${esc(row.issue_id.slice(0, 10))}</div></td><td>${statusBadge(row.status)}</td><td>${esc(row.checkout_owner || 'unclaimed')}</td><td><button class="btn sm agent-issue-checkout" data-issue-id="${esc(row.issue_id)}">Checkout</button></td></tr>`
      )
      .join('');
    const governanceTable = decisionRows
      .slice(0, 12)
      .map(
        row =>
          `<tr><td>${esc(row.entity_type)}<div class="muted">${esc(row.entity_id)}</div></td><td>${statusBadge(row.decision)}</td><td>${esc(row.actor_id)}</td></tr>`
      )
      .join('');
    const platformInventory = `<section class="ex-panel"><div class="ex-panel-head"><div><div class="ex-eyebrow">PLATFORM COVERAGE</div><h3>Paperclip-compatible control plane</h3></div><span class="muted">actor: ${esc(actor.actor?.actor_id || 'operator')}</span></div><div class="ex-inventory-grid">${inventory('human users', (users.users || []).length)}${inventory('issues', issueRows.length, `${issueRows.filter(x => x.status === 'in_progress').length} checked out`)}${inventory('execution policies', policyRows.length)}${inventory('governance decisions', decisionRows.length)}${inventory('evaluation suites', suiteRows.length, `${evalRunRows.length} runs`)}${inventory('object blobs', blobRows.length)}${inventory('plugins', pluginRows.length, `${pluginRows.filter(x => x.status === 'active').length} active`)}${inventory('connectors / MCP', connectorRows.length)}${inventory('runtime providers', providerRows.length)}${inventory('adapters', adapterRows.length, `${adapterRows.filter(x => x.status === 'online').length} online`)}${inventory('productivity pilots', productivityPilotRows.length, productivityPilotRows.map(x => x.status).join(', ') || 'none')}${inventory('delegations', delegationRows.length)}${inventory('dispatches', dispatchRows.length)}${inventory('artifacts', artifactRows.length)}${inventory('skills', skillRows.length)}${inventory('memories', memoryRows.length)}</div></section><section class="ex-layout"><div class="ex-primary"><section class="ex-panel"><div class="ex-panel-head"><div><div class="ex-eyebrow">ISSUE QUEUE</div><h3>Atomic task checkout and dependencies</h3></div><span class="muted">${issueRows.length} issues</span></div><div class="table-wrap"><table class="tbl"><thead><tr><th>Issue</th><th>Status</th><th>Owner</th><th></th></tr></thead><tbody>${issueTable || '<tr><td colspan="4" class="muted">No issues configured.</td></tr>'}</tbody></table></div></section></div><aside class="ex-secondary"><section class="ex-panel"><div class="ex-panel-head"><div><div class="ex-eyebrow">GOVERNANCE</div><h3>Decisions and approval trail</h3></div><span class="muted">${policyRows.length} policies</span></div><div class="table-wrap"><table class="tbl"><thead><tr><th>Entity</th><th>Decision</th><th>Actor</th></tr></thead><tbody>${governanceTable || '<tr><td colspan="3" class="muted">No governance decisions.</td></tr>'}</tbody></table></div></section></aside></section>`;
    const pilotTable = productivityPilotRows
      .map(
        row =>
          `<tr><td><b>${esc(row.name)}</b><div class="muted">${esc((row.treatment_sites || []).length)} treatment · ${(row.control_sites || []).length} control</div></td><td>${statusBadge(row.status)}</td><td>${esc(row.baseline?.treatment?.shipped_output || 0)} / ${esc(row.baseline?.control?.shipped_output || 0)} baseline output</td><td>${esc(row.evaluation?.passed === undefined ? 'in progress' : row.evaluation.passed ? 'passed' : 'needs adjustment')}</td></tr>`
      )
      .join('');
    const platformOps = `<section class="ex-panel"><div class="ex-panel-head"><div><div class="ex-eyebrow">PRODUCTIVITY PROGRAM</div><h3>Treatment/control delivery pilots</h3></div><span class="muted">${productivityPilotRows.length} pilot(s)</span></div><div class="table-wrap"><table class="tbl"><thead><tr><th>Pilot</th><th>Status</th><th>Baseline output</th><th>Evaluation</th></tr></thead><tbody>${pilotTable || '<tr><td colspan="4" class="muted">No productivity pilot configured.</td></tr>'}</tbody></table></div></section><section class="ex-panel"><div class="ex-panel-head"><div><div class="ex-eyebrow">RUNTIME SERVICES</div><h3>Adapters, plugins, providers, and evaluations</h3></div><span class="muted">${adapterRows.length + pluginRows.length + providerRows.length} services · ${suiteRows.length} suites</span></div><div class="table-wrap"><table class="tbl"><thead><tr><th>Service</th><th>Kind</th><th>Status</th><th>Action</th></tr></thead><tbody>${adapterRows.map(row => `<tr><td>${esc(row.slug)}</td><td>adapter · ${esc(row.kind)}</td><td>${statusBadge(row.status)}</td><td><button class="btn sm runtime-adapter-heartbeat" data-adapter-id="${esc(row.adapter_id)}">Heartbeat</button></td></tr>`).join('')}${pluginRows.map(row => `<tr><td>${esc(row.slug)}</td><td>plugin</td><td>${statusBadge(row.status)}</td><td>${esc(row.manifest?.capabilities?.length || 0)} capabilities</td></tr>`).join('')}${providerRows.map(row => `<tr><td>${esc(row.slug)}</td><td>provider · ${esc(row.kind)}</td><td>${statusBadge(row.status)}</td><td>${esc((row.capabilities || []).join(', ') || '—')}</td></tr>`).join('')}${suiteRows.map(row => `<tr><td>${esc(row.name)}</td><td>evaluation suite</td><td>${statusBadge(evalRunRows.find(run => run.suite_id === row.suite_id)?.status || 'not run')}</td><td>${esc(row.cases?.length || 0)} cases</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No runtime services registered.</td></tr>'}</tbody></table></div></section>`;
    app.innerHTML = `${breadcrumb('executive')}<div class="ex-shell"><header class="ex-hero"><div><div class="ex-eyebrow">FLEET CONTROL PLANE / RUNTIME</div><h2 class="page-title">Agent runtime</h2><p class="muted">One operator surface for identity, resumable runs, delivery accountability, budgets, heartbeats, watchdogs, evaluations, grants, isolated workspaces, issues, governance, plugins, connectors, providers, artifacts, skills, and memory.</p></div><div class="task-toolbar"><button class="btn" id="agent-runtime-refresh">↻ Refresh</button><button class="btn primary" id="agent-runtime-heartbeat">Run heartbeat</button><button class="btn" id="agent-runtime-audit">Audit watchdogs</button></div></header><section class="ex-kpis">${stat(agentRows.filter(row => row.status === 'active').length, 'active agents', 'good')}${stat(activeRuns, 'active runs', activeRuns ? 'warn' : '')}${stat(deliveredRuns, 'recent deliveries', deliveredRuns ? 'good' : 'warn')}${stat(failedDeliveries, 'delivery failures', failedDeliveries ? 'warn' : 'good')}${stat(deferredRuns, 'deferred / requeued', deferredRuns ? 'warn' : 'good')}${stat(`$${spent.toFixed(2)} / $${limits.toFixed(2)}`, 'reserved / limits')}${stat(fired, 'fired watchdogs', fired ? 'warn' : 'good')}${stat(`${grantRows.length} / ${workspaceRows.length}`, 'grants / workspaces')}</section><section class="ex-panel"><div class="ex-panel-head"><div><div class="ex-eyebrow">AGENT REGISTRY</div><h3>Identity and delivery accountability</h3></div><span class="muted">${agentRows.length} registered agents · recent run window</span></div><div class="table-wrap"><table class="tbl"><thead><tr><th>Agent</th><th>Status / generation</th><th>Delivery outcome</th><th>Runs / evaluation</th><th>Operator action</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">No agents registered.</td></tr>'}</tbody></table></div></section><section class="ex-layout"><div class="ex-primary"><section class="ex-panel"><div class="ex-panel-head"><div><div class="ex-eyebrow">RESUMABLE RUNS</div><h3>Execution and delivery history</h3></div><span class="muted">${runRows.length} recorded · green means delivered or terminal success; red means failed delivery/failure</span></div><div class="table-wrap"><table class="tbl"><thead><tr><th>Agent / run</th><th>Terminal / delivery</th><th>Usage</th><th>Result / failure reason</th></tr></thead><tbody>${runTable || '<tr><td colspan="4" class="muted">No agent runs recorded.</td></tr>'}</tbody></table></div></section><section class="ex-panel"><div class="ex-panel-head"><div><div class="ex-eyebrow">HEARTBEAT QUEUE</div><h3>Routines</h3></div><span class="muted">${routineRows.length} configured</span></div><div class="table-wrap"><table class="tbl"><thead><tr><th>Routine</th><th>Status</th><th>Next due</th></tr></thead><tbody>${routineTable || '<tr><td colspan="3" class="muted">No routines configured.</td></tr>'}</tbody></table></div></section></div><aside class="ex-secondary"><section class="ex-panel"><div class="ex-panel-head"><div><div class="ex-eyebrow">HARD STOPS</div><h3>Budget policies</h3></div></div><div class="table-wrap"><table class="tbl"><thead><tr><th>Scope</th><th>Spend / limit</th><th>Policy</th></tr></thead><tbody>${budgetTable || '<tr><td colspan="3" class="muted">No budgets configured.</td></tr>'}</tbody></table></div></section><section class="ex-panel"><div class="ex-panel-head"><div><div class="ex-eyebrow">RECOVERY</div><h3>Watchdogs</h3></div><span class="badge ${fired ? 'b-red' : 'b-green'}">${fired ? `${fired} fired` : 'clear'}</span></div><p class="muted">${watchdogRows.length} watchdogs are persisted against active and completed runs. Fired watchdogs require operator review.</p></section></aside></section>${platformInventory}</div>`;
    document.querySelector('#app .ex-shell')?.insertAdjacentHTML('beforeend', platformOps);
    wireCrumbs();
    $('#agent-runtime-refresh').onclick = () => softRender();
    $('#agent-runtime-heartbeat').onclick = async event => {
      event.currentTarget.disabled = true;
      try {
        await api('POST', '/api/agent-heartbeat/tick', {});
        toast('Heartbeat dispatched');
        softRender();
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        event.currentTarget.disabled = false;
      }
    };
    $('#agent-runtime-audit').onclick = async event => {
      event.currentTarget.disabled = true;
      try {
        const result = await api('POST', '/api/agent-watchdogs/audit', {});
        toast(`${result.fired?.length || 0} watchdogs fired`);
        softRender();
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        event.currentTarget.disabled = false;
      }
    };
    $$('.agent-runtime-toggle').forEach(button => {
      button.onclick = async () => {
        button.disabled = true;
        const paused = button.dataset.status !== 'paused';
        try {
          await api('PATCH', `/api/agents/${encodeURIComponent(button.dataset.agentId)}`, {
            status: paused ? 'paused' : 'active',
            pause_reason: paused ? 'operator pause from runtime console' : null,
          });
          toast(paused ? 'Agent paused' : 'Agent resumed');
          softRender();
        } catch (e) {
          toast(e.message, 'err');
        } finally {
          button.disabled = false;
        }
      };
    });
    $$('.agent-issue-checkout').forEach(button => {
      button.onclick = async () => {
        button.disabled = true;
        try {
          await api(
            'POST',
            `/api/agent-issues/${encodeURIComponent(button.dataset.issueId)}/checkout`,
            { owner: 'operator-console' }
          );
          toast('Issue checked out');
          softRender();
        } catch (e) {
          toast(e.message, 'err');
          button.disabled = false;
        }
      };
    });
    $$('.runtime-adapter-heartbeat').forEach(button => {
      button.onclick = async () => {
        button.disabled = true;
        try {
          await api(
            'POST',
            `/api/runtime-adapters/${encodeURIComponent(button.dataset.adapterId)}/heartbeat`,
            { status: 'online' }
          );
          toast('Adapter heartbeat recorded');
          softRender();
        } catch (e) {
          toast(e.message, 'err');
          button.disabled = false;
        }
      };
    });
  } catch (e) {
    renderViewError(app, `Agent runtime failed: ${e.message}`);
  }
}

async function renderExecutiveSetup() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading executive setup…</div></div>';
  let settings,
    revops,
    experiments,
    campaigns,
    reports,
    proposals,
    actions,
    croLabRuns,
    performance;
  try {
    [
      settings,
      revops,
      experiments,
      campaigns,
      reports,
      proposals,
      actions,
      performance,
      croLabRuns,
    ] = await Promise.all([
      api('GET', '/api/executive/settings'),
      api('GET', '/api/revops/summary'),
      api('GET', '/api/experiments'),
      api('GET', '/api/campaigns/summary'),
      api('GET', '/api/executive/reports?limit=20'),
      api('GET', '/api/executive/proposals?limit=100'),
      api('GET', '/api/executive/actions?limit=200'),
      api('GET', '/api/executive/performance'),
      apiOptional('GET', '/api/executive/cro-lab/runs?limit=12', { runs: [] }),
    ]);
  } catch (e) {
    renderViewError(app, `Executive setup failed: ${e.message}`);
    return;
  }
  const s = settings.settings || {};
  const performanceData = performance.performance || {};
  const performanceContract = performanceData.contract || {};
  const performanceRoles = performanceData.roles || [];
  const revopsSummary = revops.summary || {};
  const experimentRows = experiments.experiments || [];
  const campaignSummary = campaigns.summary || {};
  const reportRows = reports.reports || [];
  const latestReport = reportRows[0];
  const croRuns = croLabRuns?.runs || [];
  const performanceRoleRows = performanceRoles
    .map(role => {
      const key = String(role.role).replaceAll(/[^a-z0-9-]/gi, '-');
      const goal = performanceContract.roles?.[role.role] || {};
      const tone =
        role.status === 'on-track' || role.status === 'protected'
          ? 'b-green'
          : role.status === 'recovery'
            ? 'b-yellow'
            : 'b-red';
      return `<tr><td><b>${esc(role.role)}</b><div class="muted">${esc(role.recovery_reason || 'No recovery required')}</div></td><td><span class="badge ${tone}">${esc(role.status)}</span><div>${role.score == null ? '—' : `${esc(role.score)}/100`}</div></td><td>${esc(role.durable_outputs)} / <input class="cm-input ex-performance-role-goal" data-role="${esc(role.role)}" value="${esc(goal.durable_outputs ?? 1)}" type="number" min="0" max="20" aria-label="Durable output goal for ${esc(role.role)}"></td><td>${esc(role.verified_outcomes)}<div class="muted">${esc(role.proposals)} proposals · ${esc(role.change_requests)} queue requests</div></td><td><label class="ex-check"><input class="ex-performance-role-protected" data-role="${esc(role.role)}" type="checkbox" ${goal.protected ? 'checked' : ''}> protect</label></td></tr>`;
    })
    .join('');
  const stat = (value, label, tone = '') =>
    `<div class="ex-kpi ${tone}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  const croLabRows = croRuns
    .slice(0, 6)
    .map(run => {
      const candidate = run.candidate?.full_name || 'unknown repository';
      const decision = run.recommendation?.decision || run.status || 'unresolved';
      const checks = (run.checks || []).filter(check => check.status === 'passed').length;
      return `<tr><td><b>${esc(candidate)}</b><div class="muted">${esc(run.candidate?.purpose || 'fleet capability')}</div></td><td><span class="badge ${decision === 'research' ? 'b-green' : decision === 'blocked' ? 'b-red' : 'b-yellow'}">${esc(decision)}</span></td><td>${esc(checks)} passed<div class="muted">${esc(run.repository?.file_count || 0)} files inspected</div></td><td><a href="/api/executive/cro-lab/runs/${encodeURIComponent(run.run_id)}" target="_blank" rel="noreferrer">evidence ↗</a><div class="muted">${esc(fmtDate(run.generated_at))}</div></td></tr>`;
    })
    .join('');
  const proposalRows = (proposals.proposals || [])
    .map(p => {
      const pending = ['proposed', 'feedback'].includes(p.status);
      const badge =
        p.status === 'approved'
          ? 'b-green'
          : p.status === 'declined'
            ? 'b-red'
            : p.status === 'feedback'
              ? 'b-yellow'
              : 'b-blue';
      const decision = pending
        ? `<button class="btn sm primary ex-approve" data-id="${esc(p.proposal_id)}">Approve</button> <button class="btn sm ex-feedback" data-id="${esc(p.proposal_id)}">Reply / request changes</button> <button class="btn sm danger ex-decline" data-id="${esc(p.proposal_id)}">Decline</button>`
        : esc(p.decision_note || '');
      return `<tr><td><b>${esc(p.title)}</b><div class="muted">${esc(p.proposal_type)} · ${esc(executiveActorLabel(p.created_by))}</div></td><td>${esc(p.summary)}</td><td><span class="badge ${badge}">${esc(p.status)}</span></td><td>${decision}</td></tr>`;
    })
    .join('');
  const actionRows = (actions.actions || [])
    .map(
      a =>
        `<tr><td class="muted">${esc(fmtDate(a.started_at))}</td><td><b>${esc(executiveActorLabel(a.actor))}</b><div class="muted">${esc(a.action_type)}</div></td><td>${esc(a.summary)}</td><td><span class="badge ${a.status === 'completed' ? 'b-green' : a.status === 'failed' ? 'b-red' : 'b-blue'}">${esc(a.status)}</span>${a.error ? `<div class="error-text">${esc(a.error)}</div>` : ''}</td></tr>`
    )
    .join('');
  app.innerHTML = `${breadcrumb('executive')}<div class="ex-shell">
    <header class="ex-hero"><div><div class="ex-eyebrow">EXECUTIVE OVERVIEW / SETUP</div><h2 class="page-title">Executive setup</h2><p class="muted">Configure the strategy contract, review operating systems, and inspect executive decision history.</p></div><div class="task-toolbar"><button class="btn" id="ex-back-overview">← Executive overview</button></div></header>
    <section class="ex-kpis">${stat(revopsSummary.total_leads ?? 0, 'tracked leads')}${stat(revopsSummary.mqls ?? 0, 'MQLs')}${stat(revopsSummary.opportunities ?? 0, 'opportunities')}${stat(experimentRows.filter(row => row.state === 'running').length, 'running experiments')}${stat(campaignSummary.active ?? 0, 'active campaigns')}</section>
    <section class="ex-panel"><div class="ex-panel-head"><div><div class="ex-eyebrow">SETUP</div><h3>Details &amp; configuration</h3><p class="muted">Strategy contract, performance settings, and decision history.</p></div><button class="btn primary" id="ex-open-setup">Open setup →</button></div></section>
    <details class="ex-disclosure" open><summary><span><b>Strategy contract</b><small>Targets, limits, risk tolerance, and recurring ticks</small></span><span class="ex-chevron">›</span></summary><div class="ex-disclosure-body"><p class="muted">These settings are included in every CEO/CTO brief and constrain prioritization.</p><div class="form-grid"><label>Monthly revenue target<input id="ex-revenue-target" class="cm-input" value="${esc(s.revenue_target_monthly || '')}" placeholder="e.g. 5000"></label><label>Fixed monthly costs<input id="ex-fixed-costs" class="cm-input" value="${esc(s.fixed_costs_monthly || '')}" placeholder="optional"></label><label>Marketing budget<input id="ex-marketing-budget" class="cm-input" value="${esc(s.marketing_budget_monthly || '')}" placeholder="optional"></label><label>Revenue floor<input id="ex-revenue-floor" class="cm-input" value="${esc(s.revenue_floor_monthly || '')}" placeholder="optional"></label><label>Monthly spend limit<input id="ex-spend-limit" class="cm-input" value="${esc(s.monthly_spend_limit || '')}" placeholder="optional"></label><label>Attribution threshold<input id="ex-attribution-threshold" class="cm-input" value="${esc(s.attribution_materiality_threshold || '')}" placeholder="e.g. 100"></label><label>Risk tolerance<select id="ex-risk" class="cm-input"><option value="">Choose risk tolerance</option><option value="low" ${s.risk_tolerance === 'low' ? 'selected' : ''}>Low — conservative</option><option value="medium" ${s.risk_tolerance === 'medium' ? 'selected' : ''}>Medium — balanced</option><option value="high" ${s.risk_tolerance === 'high' ? 'selected' : ''}>High — exploratory</option></select></label><label>Check-in hours<input id="ex-checkin" class="cm-input" value="${esc(s.checkin_hours || '24')}" type="number" min="1" max="168"></label></div><label class="ex-operating-modes">Operating modes / notes<textarea id="ex-notes" class="cm-input" rows="6" placeholder="What should the executive optimize for? Describe priorities, guardrails, and when to escalate.">${esc(s.operating_notes || '')}</textarea></label><label class="ex-check"><input id="ex-tick-enabled" type="checkbox" ${s.tick_enabled === true ? 'checked' : ''}> Enable recurring executive ticks</label><div class="ex-disclosure-actions"><span class="muted">No spend or deployment authority is granted here.</span><button class="btn primary" id="ex-save-settings">Save strategy</button></div></div></details>
    <details class="ex-disclosure" open><summary><span><b>Performance &amp; recovery contract</b><small>Durable output goals, scoring weights, and automatic repair</small></span><span class="ex-chevron">›</span></summary><div class="ex-disclosure-body"><p class="muted">Volume alone never earns credit. Scores use durable work, verified outcomes, quality, and stale-work progress. Protected roles are not punished for correctly blocking unsafe work; they must still record the evidence and unblocker.</p><div class="ex-mini-grid">${stat(performanceData.summary?.average_score ?? '—', 'average score')}${stat(performanceData.summary?.on_track ?? 0, 'on track')}${stat(performanceData.summary?.needs_recovery ?? 0, 'needs recovery')}${stat(performanceData.window?.ticks ?? 0, 'ticks measured')}</div><div class="form-grid"><label>Enabled<select id="ex-performance-enabled" class="cm-input"><option value="true" ${performanceContract.enabled !== false ? 'selected' : ''}>Enabled</option><option value="false" ${performanceContract.enabled === false ? 'selected' : ''}>Disabled</option></select></label><label>Measurement window (runs)<input id="ex-performance-window" class="cm-input" type="number" min="1" max="20" value="${esc(performanceContract.window_ticks || 5)}"></label><label>Minimum passing score<input id="ex-performance-threshold" class="cm-input" type="number" min="0" max="100" value="${esc(performanceContract.minimum_score || 60)}"></label><label>Restricted after windows<input id="ex-performance-restricted" class="cm-input" type="number" min="1" max="20" value="${esc(performanceContract.restricted_after_windows || 2)}"></label><label>Escalate after windows<input id="ex-performance-escalation" class="cm-input" type="number" min="1" max="30" value="${esc(performanceContract.escalation_after_windows || 3)}"></label><label>Output weight<input id="ex-performance-weight-output" class="cm-input" type="number" min="0" max="100" value="${esc(performanceContract.weights?.output || 45)}"></label><label>Outcome weight<input id="ex-performance-weight-outcomes" class="cm-input" type="number" min="0" max="100" value="${esc(performanceContract.weights?.outcomes || 30)}"></label><label>Quality weight<input id="ex-performance-weight-quality" class="cm-input" type="number" min="0" max="100" value="${esc(performanceContract.weights?.quality || 15)}"></label><label>Progress weight<input id="ex-performance-weight-progress" class="cm-input" type="number" min="0" max="100" value="${esc(performanceContract.weights?.progress || 10)}"></label></div><div class="table-wrap"><table class="tbl"><thead><tr><th>Role</th><th>Score / state</th><th>Durable outputs / goal</th><th>Verified outcomes</th><th>Guardrail</th></tr></thead><tbody>${performanceRoleRows || '<tr><td colspan="5" class="muted">No performance data yet.</td></tr>'}</tbody></table></div><div class="ex-disclosure-actions"><span class="muted">Below threshold → repair assignment → restricted mode → escalation.</span><button class="btn primary" id="ex-save-performance">Save performance contract</button></div></div></details>
    <details class="ex-disclosure"><summary><span><b>Performance &amp; revenue</b><small>Funnel, campaigns, experiments, reports, and exceptions</small></span><span class="ex-chevron">›</span></summary><div class="ex-disclosure-body"><div class="ex-subsection"><h4>Revenue operating system</h4><div class="ex-mini-grid">${stat(revopsSummary.total_leads ?? 0, 'tracked leads')}${stat(revopsSummary.mqls ?? 0, 'MQLs')}${stat(revopsSummary.opportunities ?? 0, 'opportunities')}${stat(experimentRows.filter(row => row.state === 'running').length, 'running experiments')}${stat(campaignSummary.active ?? 0, 'active campaigns')}</div><p class="muted">Campaigns are planning and attribution records until an owner-approved provider, audience, consent, and unsubscribe path exist.</p></div><div class="ex-subsection"><h4>Domain-manager reports</h4><div class="ex-mini-grid">${stat(reportRows.length, 'recent reports')}${stat(latestReport?.summary?.sites_considered ?? 0, 'sites considered')}${stat(latestReport?.summary?.exceptions ?? 0, 'latest exceptions')}${stat(latestReport?.summary?.deep_dive_candidates ?? 0, 'deep-dive candidates')}</div><p class="muted">${latestReport ? `Latest: ${esc(latestReport.cadence)} · ${esc(fmtDate(latestReport.generated_at))}.` : 'No reports generated yet.'}</p></div><div class="ex-subsection"><div class="ex-panel-head"><div><h4>CRO repo lab</h4><p class="muted">CRO candidates are tested in disposable workspaces before CEO/CTO review.</p></div><button class="btn sm" id="ex-run-cro-lab">Run CRO lab</button></div><div class="table-wrap"><table class="tbl"><thead><tr><th>Repository</th><th>Decision</th><th>Evidence</th><th>Report</th></tr></thead><tbody>${croLabRows || '<tr><td colspan="4" class="muted">No repo-lab runs yet.</td></tr>'}</tbody></table></div></div></div></details>
    <details class="ex-disclosure"><summary><span><b>Decision history</b><small>${(proposals.proposals || []).length} proposals · ${actions.actions?.length ?? 0} audited actions</small></span><span class="ex-chevron">›</span></summary><div class="ex-disclosure-body"><div class="table-wrap">${proposalRows ? `<table class="tbl"><thead><tr><th>Proposal</th><th>Summary</th><th>Status</th><th>Decision</th></tr></thead><tbody>${proposalRows}</tbody></table>` : '<div class="ex-empty">No proposals yet.</div>'}</div><h4 class="ex-history-title">Action audit log</h4><div class="table-wrap"><table class="tbl"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Status</th></tr></thead><tbody>${actionRows || '<tr><td colspan="4" class="muted">No executive actions recorded yet.</td></tr>'}</tbody></table></div></div></details>
  </div>`;
  mountExecutiveWorkspaceNav('setup');
  $('#ex-performance-threshold')
    ?.closest('.form-grid')
    ?.insertAdjacentHTML(
      'beforeend',
      `<label>Pause after failed deliveries<input id="ex-accountability-pause" class="cm-input" type="number" min="1" max="20" value="${esc(performanceContract.accountability?.pause_after_failures || 2)}"></label><label>Recovery cooldown (minutes)<input id="ex-accountability-recovery" class="cm-input" type="number" min="5" max="1440" value="${esc(performanceContract.accountability?.recovery_cooldown_minutes || 60)}"></label><label>Reprovision after failures<input id="ex-accountability-reprovision" class="cm-input" type="number" min="2" max="50" value="${esc(performanceContract.accountability?.reprovision_after_failures || 4)}"></label>`
    );
  $('#ex-save-settings')
    ?.closest('.ex-disclosure-body')
    ?.querySelector('.form-grid')
    ?.insertAdjacentHTML(
      'beforeend',
      `<label>Transcript retention (days)<input id="ex-transcript-retention" class="cm-input" value="${esc(s.conversation_retention_days || '90')}" type="number" min="1" max="3650"><small class="muted">Operator-visible run transcript only.</small></label>`
    );
  $('#ex-back-overview').onclick = () => go('agent', 'executive');
  $('#ex-save-settings').onclick = async () => {
    const btn = $('#ex-save-settings');
    btn.disabled = true;
    try {
      await api('PATCH', '/api/executive/settings', {
        revenue_target_monthly: $('#ex-revenue-target').value.trim(),
        fixed_costs_monthly: $('#ex-fixed-costs').value.trim(),
        marketing_budget_monthly: $('#ex-marketing-budget').value.trim(),
        revenue_floor_monthly: $('#ex-revenue-floor').value.trim(),
        attribution_materiality_threshold: $('#ex-attribution-threshold').value.trim(),
        monthly_spend_limit: $('#ex-spend-limit').value.trim(),
        risk_tolerance: $('#ex-risk').value.trim(),
        checkin_hours: Number($('#ex-checkin').value || 24),
        conversation_retention_days: Number($('#ex-transcript-retention').value || 90),
        operating_notes: $('#ex-notes').value.trim(),
        tick_enabled: $('#ex-tick-enabled').checked,
      });
      toast('Strategy saved');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  };
  $('#ex-save-performance').onclick = async () => {
    const btn = $('#ex-save-performance');
    btn.disabled = true;
    try {
      const roles = {};
      $$('.ex-performance-role-goal').forEach(input => {
        const role = input.dataset.role;
        roles[role] = {
          durable_outputs: Number(input.value || 0),
          verified_outcomes: performanceContract.roles?.[role]?.verified_outcomes || 0,
          protected: Boolean(
            $(`.ex-performance-role-protected[data-role="${CSS.escape(role)}"]`)?.checked
          ),
        };
      });
      await api('PATCH', '/api/executive/settings', {
        performance_contract: {
          enabled: $('#ex-performance-enabled').value === 'true',
          window_ticks: Number($('#ex-performance-window').value),
          minimum_score: Number($('#ex-performance-threshold').value),
          restricted_after_windows: Number($('#ex-performance-restricted').value),
          escalation_after_windows: Number($('#ex-performance-escalation').value),
          accountability: {
            pause_after_failures: Number($('#ex-accountability-pause').value),
            recovery_cooldown_minutes: Number($('#ex-accountability-recovery').value),
            reprovision_after_failures: Number($('#ex-accountability-reprovision').value),
          },
          weights: {
            output: Number($('#ex-performance-weight-output').value),
            outcomes: Number($('#ex-performance-weight-outcomes').value),
            quality: Number($('#ex-performance-weight-quality').value),
            progress: Number($('#ex-performance-weight-progress').value),
          },
          roles,
        },
      });
      toast('Performance contract saved');
      softRender();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  };
  $('#ex-run-cro-lab').onclick = async () => {
    const button = $('#ex-run-cro-lab');
    button.disabled = true;
    try {
      await api('POST', '/api/executive/cro-lab/run', {});
      toast('CRO repo lab completed');
      softRender();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      button.disabled = false;
    }
  };
  const decide = async (button, status) => {
    const note = await requestModalText({
      title:
        status === 'feedback'
          ? 'Request changes'
          : `${status === 'approved' ? 'Approve' : 'Decline'} proposal`,
      label:
        status === 'feedback'
          ? 'Feedback for the executive team'
          : `${status === 'approved' ? 'Approval' : 'Decline'} note (optional)`,
      placeholder:
        status === 'feedback'
          ? 'What needs to change before this can move forward?'
          : 'Capture the rationale, guardrails, owner, or next step.',
      submitLabel:
        status === 'feedback'
          ? 'Send feedback'
          : status === 'approved'
            ? 'Approve proposal'
            : 'Decline proposal',
    });
    if (note === null) return;
    button.disabled = true;
    api('POST', `/api/executive/proposals/${encodeURIComponent(button.dataset.id)}/decision`, {
      status,
      decision_note: note,
      decided_by: 'owner',
    })
      .then(() => {
        toast(`Proposal ${status}`);
        softRender();
      })
      .catch(e => {
        button.disabled = false;
        toast(e.message, 'err');
      });
  };
  $$('.ex-approve').forEach(b => (b.onclick = () => decide(b, 'approved')));
  $$('.ex-feedback').forEach(b => (b.onclick = () => decide(b, 'feedback')));
  $$('.ex-decline').forEach(b => (b.onclick = () => decide(b, 'declined')));
  wireCrumbs();
  stamp();
}

async function renderExecutive() {
  if (STATE.agentPage === 'runtime') return renderAgentRuntime();
  if (STATE.agentPage === 'setup') return renderExecutiveSetup();
  const app = $('#app');
  const requestedPage = STATE.agentPage || null;
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading executive control plane…</div></div>';
  let messages,
    transcript,
    requests,
    inbox,
    proposals,
    actions,
    settings,
    brief,
    revops,
    experiments,
    campaigns,
    reports,
    managerQueue,
    principalQueue,
    croLabRuns,
    runStatus,
    cases,
    calendar,
    draft;
  const conversationOnly = STATE.agentPage === 'conversation';
  const dashboardOnly = STATE.agentPage === 'dashboard';
  const executiveRouteActive = () =>
    routeIs('executive') || routeIs('agent', 'executive', requestedPage);
  // The dashboard is the first-paint surface. Do not make it wait for data
  // belonging to hidden workspace tabs (transcripts, cases, CRO lab, etc.).
  // Auxiliary reads are deliberately bounded so a sick collector degrades to
  // an empty panel instead of taking the entire control plane down.
  const optional = (method, url, fallback) => apiOptional(method, url, fallback, 1500);
  try {
    const loadKey = conversationOnly
      ? 'conversation'
      : `workspace:${STATE.agentPage || 'overview'}`;
    const now = Date.now();
    if (
      !EXECUTIVE_LOAD_CACHE ||
      EXECUTIVE_LOAD_CACHE.key !== loadKey ||
      EXECUTIVE_LOAD_CACHE.expires <= now
    ) {
      EXECUTIVE_LOAD_CACHE = {
        key: loadKey,
        expires: now + 1000,
        promise: Promise.all([
          // The inbox is the canonical owner-thread source. Conversation
          // does not need a second copy of the same messages/work items.
          conversationOnly
            ? Promise.resolve({ messages: [] })
            : dashboardOnly
              ? Promise.resolve({ messages: [] })
              : optional('GET', '/api/executive/messages?limit=100', { messages: [] }),
          conversationOnly
            ? Promise.resolve({ messages: [], retention_days: 90 })
            : dashboardOnly
              ? Promise.resolve({ messages: [], retention_days: 90 })
              : optional('GET', '/api/executive/transcript', { messages: [], retention_days: 90 }),
          conversationOnly
            ? Promise.resolve({ work_items: [] })
            : dashboardOnly
              ? Promise.resolve({ work_items: [] })
              : optional('GET', '/api/executive/work-items?source_type=owner-request&limit=50', {
                  work_items: [],
                }),
          dashboardOnly
            ? Promise.resolve({ requests: [], notifications: [] })
            : optional(
                'GET',
                `/api/executive/inbox?limit=50${conversationOnly ? '&history_limit=30' : ''}`,
                { requests: [], notifications: [], degraded: true },
                5000
              ),
          conversationOnly
            ? optional('GET', '/api/executive/draft', { draft: null })
            : Promise.resolve({ draft: null }),
          conversationOnly
            ? Promise.resolve({ proposals: [] })
            : dashboardOnly
              ? Promise.resolve({ proposals: [] })
              : optional('GET', '/api/executive/proposals?limit=100', { proposals: [] }),
          conversationOnly
            ? Promise.resolve({ actions: [] })
            : dashboardOnly
              ? Promise.resolve({ actions: [] })
              : optional('GET', '/api/executive/actions?limit=200', { actions: [] }),
          conversationOnly
            ? Promise.resolve({ settings: {} })
            : dashboardOnly
              ? Promise.resolve({ settings: {} })
              : optional('GET', '/api/executive/settings', { settings: {} }),
          conversationOnly
            ? Promise.resolve({ brief: {} })
            : optional('GET', '/api/executive/brief', { brief: {} }),
          conversationOnly || dashboardOnly
            ? Promise.resolve({ summary: {} })
            : optional('GET', '/api/revops/summary', { summary: {} }),
          conversationOnly || dashboardOnly
            ? Promise.resolve({ experiments: [] })
            : optional('GET', '/api/experiments', { experiments: [] }),
          conversationOnly
            ? Promise.resolve({ summary: {} })
            : dashboardOnly
              ? Promise.resolve({ summary: {} })
              : optional('GET', '/api/campaigns/summary', { summary: {} }),
          conversationOnly
            ? Promise.resolve({ reports: [] })
            : dashboardOnly
              ? Promise.resolve({ reports: [] })
              : optional('GET', '/api/executive/reports?limit=20', { reports: [] }),
          conversationOnly
            ? Promise.resolve({ queue: {} })
            : optional('GET', '/api/executive/domain-manager-queue', { queue: {}, jobs: [] }),
          conversationOnly
            ? Promise.resolve({ summary: {} })
            : optional('GET', '/api/executive/task-queue?role=principal-engineer&limit=100', {
                summary: {},
                requests: [],
              }),
          conversationOnly
            ? Promise.resolve({ runs: [] })
            : dashboardOnly
              ? Promise.resolve({ runs: [] })
              : optional('GET', '/api/executive/cro-lab/runs?limit=12', { runs: [] }),
          conversationOnly
            ? Promise.resolve({ active: null, latest: null, runs: [] })
            : optional(
                'GET',
                '/api/executive/run-status',
                { active: null, latest: null, runs: [], degraded: true },
                5000
              ),
          conversationOnly
            ? Promise.resolve({ cases: [] })
            : dashboardOnly
              ? Promise.resolve({ cases: [] })
              : optional('GET', '/api/cases?limit=300', { cases: [] }),
          conversationOnly
            ? Promise.resolve({ events: [], calendar: { events: [] } })
            : optional('GET', '/api/executive/calendar', {
                events: [],
                calendar: { events: [] },
              }),
        ]),
      };
    }
    [
      messages,
      transcript,
      requests,
      inbox,
      draft,
      proposals,
      actions,
      settings,
      brief,
      revops,
      experiments,
      campaigns,
      reports,
      managerQueue,
      principalQueue,
      croLabRuns,
      runStatus,
      cases,
      calendar,
    ] = await EXECUTIVE_LOAD_CACHE.promise;
  } catch (e) {
    if (!executiveRouteActive()) return;
    renderViewError(app, `Executive control plane failed: ${e.message}`);
    return;
  }
  if (!executiveRouteActive()) return;
  const executiveDataDegraded = Boolean(inbox?.degraded || runStatus?.degraded);
  // The inbox endpoint is the canonical source for owner requests. Older
  // responses can still contain the same work item in both the inbox payload
  // and the work-items fallback, so keep the UI keyed to one row per thread.
  const ownerRequestMap = new Map(
    (inbox.requests || requests.work_items || []).map(request => [request.work_id, request])
  );
  const allOwnerRequests = Array.from(ownerRequestMap.values());
  const unreadNotifications = (inbox.notifications || []).filter(item => !item.read_at);
  const requestMatches = request => {
    const haystack = [request.title, request.summary, request.lifecycle_state, request.status]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return (
      (!EXEC_INBOX_UI.q || haystack.includes(EXEC_INBOX_UI.q.toLowerCase())) &&
      (EXEC_INBOX_UI.status === 'all' ||
        (EXEC_INBOX_UI.status === 'unread'
          ? request.response_count > 0 &&
            unreadNotifications.some(n => n.work_id === request.work_id)
          : EXEC_INBOX_UI.status === 'overdue'
            ? request.overdue
            : request.lifecycle_state === EXEC_INBOX_UI.status))
    );
  };
  const filteredOwnerRequests = allOwnerRequests.filter(requestMatches);
  const inboxPageCount = Math.max(
    1,
    Math.ceil(filteredOwnerRequests.length / EXEC_INBOX_UI.pageSize)
  );
  EXEC_INBOX_UI.page = Math.min(EXEC_INBOX_UI.page, inboxPageCount);
  const ownerRequests = filteredOwnerRequests.slice(
    (EXEC_INBOX_UI.page - 1) * EXEC_INBOX_UI.pageSize,
    EXEC_INBOX_UI.page * EXEC_INBOX_UI.pageSize
  );
  notifyExecutiveBrowser(unreadNotifications);
  const visibleNotifications = unreadNotifications.slice(0, 5);
  const notificationRows = visibleNotifications
    .map(
      notification =>
        `<article class="ex-notification" data-notification-id="${esc(notification.notification_id)}"><span class="ex-notification-icon" aria-hidden="true">!</span><div class="ex-notification-content"><b>${esc(notification.title)}</b><div>${esc(notification.body)}</div><small class="muted">${esc(fmtDate(notification.created_at))}</small></div><button class="ex-notification-read" type="button" aria-label="Dismiss notification: ${esc(notification.title)}" title="Dismiss notification: ${esc(notification.title)}">×</button></article>`
    )
    .join('');
  const notificationGroup = notificationRows
    ? `<details class="ex-notification-group"><summary><span class="ex-notification-summary-icon" aria-hidden="true">●</span><span><b>Notifications</b><small>${visibleNotifications.length} notice${visibleNotifications.length === 1 ? '' : 's'} being shown</small></span><span class="ex-chevron">›</span></summary><div class="ex-notifications">${notificationRows}</div></details>`
    : '';
  const messageRows = (messages.messages || [])
    .slice()
    .reverse()
    .map(
      m =>
        `<article class="card" style="margin-bottom:8px"><div class="muted"><b>${esc(executiveActorLabel(m.actor))}</b> · ${esc(fmtDate(m.created_at))}</div><div style="white-space:pre-wrap;margin-top:6px">${esc(m.body)}</div></article>`
    )
    .join('');
  const transcriptMessages = (transcript.messages || []).slice().reverse();
  const transcriptRows = transcriptMessages
    .map(item => {
      const kind =
        item.message_type === 'background'
          ? 'background'
          : item.message_type === 'model-prompt'
            ? 'prompt'
            : 'response';
      const label =
        kind === 'background'
          ? item.metadata?.label || 'Background work'
          : kind === 'prompt'
            ? item.metadata?.label || 'Model request'
            : 'Model response';
      const run = item.metadata?.run_id ? ` · run ${String(item.metadata.run_id).slice(0, 8)}` : '';
      const body =
        kind === 'background'
          ? `<div class="ex-transcript-summary">${esc(item.body)}</div>`
          : `<details><summary>View ${kind === 'prompt' ? 'request context' : 'structured response'}</summary><pre>${esc(item.body)}</pre></details>`;
      return `<article class="ex-transcript-event ex-transcript-${kind}"><div class="ex-transcript-meta"><span class="ex-transcript-dot"></span><b>${esc(label)}</b><span class="muted">${esc(executiveActorLabel(item.actor))} · ${esc(fmtDate(item.created_at))}${esc(run)}</span></div>${body}</article>`;
    })
    .join('');
  const backgroundRows = transcriptMessages
    .filter(item => item.message_type === 'background')
    .slice(-20)
    .map(
      item =>
        `<div class="ex-thread-activity-row"><b>${esc(item.metadata?.label || 'Background work')}</b><span>${esc(item.body)}</span><small>${esc(fmtDate(item.created_at))}</small></div>`
    )
    .join('');
  // Behave like an email client: show previews until the operator chooses a
  // message. Preserve an explicitly selected thread across soft refreshes.
  const selectedRequestId = ownerRequests.some(
    request => request.work_id === EXEC_INBOX_UI.selected
  )
    ? EXEC_INBOX_UI.selected
    : null;
  EXEC_INBOX_UI.selected = selectedRequestId;
  const requestThread = request =>
    (
      request.messages ||
      (messages.messages || []).filter(message => message.work_id === request.work_id)
    )
      .filter(message => message.work_id === request.work_id)
      .sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0));
  const requestStatus = (request, thread) =>
    thread.at(-1)?.actor === 'owner'
      ? ['awaiting executive reply', 'b-yellow']
      : thread.some(message => message.actor !== 'owner')
        ? ['response received', 'b-green']
        : request.status === 'blocked'
          ? ['blocked', 'b-red']
          : [request.status || 'open', 'b-yellow'];
  const ownerRequestList = ownerRequests
    .map(request => {
      const thread = requestThread(request);
      const [status, tone] = requestStatus(request, thread);
      const unread = unreadNotifications.some(n => n.work_id === request.work_id);
      const latest = thread.at(-1);
      const sender = latest
        ? executiveActorLabel(latest.actor)
        : executiveActorLabel(request.owner || 'owner');
      const preview = latest?.body || request.summary || 'No message preview available.';
      return `<button type="button" class="ex-request-list-item ${request.work_id === selectedRequestId ? 'selected' : ''}" data-request-id="${esc(request.work_id)}"><span class="ex-request-list-top"><b>${esc(request.request_ref || 'EXEC_CONV')}</b><time datetime="${esc(request.created_at || '')}">${esc(fmtDate(request.created_at))}</time></span><span class="ex-request-list-meta"><span class="ex-request-list-sender">${esc(sender)}</span>${unread ? '<span class="ex-unread-dot" title="Unread reply"></span>' : ''}<span class="badge ${tone}">${esc(status)}</span></span><span class="ex-request-list-summary">${request.site ? `<span class="badge b-blue">for ${esc(request.site)}</span> ` : ''}${esc(request.title)}</span><span class="ex-request-list-summary">${esc(preview)}</span></button>`;
    })
    .join('');
  const selectedRequest = ownerRequests.find(request => request.work_id === selectedRequestId);
  const ownerRequestDetail = selectedRequest
    ? (() => {
        const request = selectedRequest;
        const thread = requestThread(request);
        const timeline = thread
          .map(
            message =>
              `<div class="ex-thread-message ${message.actor === 'owner' ? 'owner' : 'agent'}"><div class="ex-thread-message-head"><b>${esc(executiveActorLabel(message.actor))}</b><span>${esc(fmtDate(message.created_at))}</span></div><div>${esc(message.body)}</div></div>`
          )
          .join('');
        // The request summary already contains the initial owner message. A
        // one-event thread would therefore render that same text a third time;
        // reserve the full-thread section for actual back-and-forth history.
        const threadSection =
          thread.length > 1
            ? `<div class="ex-thread-heading"><b>Full thread</b><span class="muted">${thread.length} event${thread.length === 1 ? '' : 's'}</span></div><div class="ex-thread">${timeline}</div>`
            : '';
        const linked = (request.links || [])
          .map(
            link =>
              `<span class="badge b-blue">linked ${esc(link.to_type)} ${esc(String(link.to_id).slice(0, 8))}</span>`
          )
          .join(' ');
        const [status, statusClass] = requestStatus(request, thread);
        const due = request.overdue
          ? '<span class="badge b-red">SLA overdue</span>'
          : request.due_at
            ? `<span class="muted">Due ${esc(fmtDate(request.due_at))}</span>`
            : '';
        const actions =
          request.lifecycle_state === 'closed'
            ? '<span class="muted">Closed request</span>'
            : `<button class="btn sm ex-request-ack" data-id="${esc(request.work_id)}" ${request.lifecycle_state !== 'submitted' ? 'disabled' : ''}>Acknowledge</button><button class="btn sm ex-request-close" data-id="${esc(request.work_id)}">Close request</button>`;
        const replyComposer =
          request.lifecycle_state === 'closed'
            ? ''
            : `<div class="ex-work-reply"><div class="ex-thread-heading"><b>Continue this thread</b><span class="muted">The executive team will see this on its next run.</span></div><textarea class="cm-input ex-work-reply-body" data-id="${esc(request.work_id)}" rows="4" placeholder="Reply with clarification, a decision, or the next direction…"></textarea><div class="task-toolbar"><span class="muted">Your reply stays attached to this work item.</span><button class="btn sm primary ex-work-reply-send" data-id="${esc(request.work_id)}" type="button">Send reply</button></div></div>`;
        return `<article class="ex-request-detail"><div class="ex-request-detail-head"><div><div class="ex-eyebrow">REQUEST THREAD · ${esc(request.request_ref || 'EXEC_CONV')}</div><h4>${esc(request.title)}</h4><p class="muted">${request.site ? `For ${esc(request.site)} · ` : 'Fleet-wide · '}Submitted ${esc(fmtDate(request.created_at))} · owner ${esc(executiveActorLabel(request.owner || 'ceo'))} · waiting on ${esc(request.waiting_on || 'executive team')}</p></div><div>${due} <span class="badge ${statusClass}">${esc(status)}</span></div></div><div class="ex-request-summary">${esc(request.summary)}</div>${request.next_action ? `<div class="ex-decision-request"><b>Next action:</b> ${esc(request.next_action)}</div>` : ''}${threadSection}${replyComposer}<details class="ex-thread-activity"><summary>Run activity <span class="muted">${transcriptMessages.length} events</span></summary><div>${backgroundRows || '<span class="muted">No background activity recorded.</span>'}</div></details>${linked ? `<div class="ex-request-links">${linked}</div>` : ''}${request.outcome ? `<p><b>Outcome:</b> ${esc(request.outcome)}</p>` : ''}<div class="task-toolbar ex-request-actions">${actions}</div></article>`;
      })()
    : '<div class="ex-request-detail ex-empty">Select a request to inspect its full thread.</div>';
  const allCases = cases?.cases || [];
  const filteredCases = allCases.filter(item => {
    const haystack =
      `${item.title} ${item.site || ''} ${item.owner || ''} ${item.state?.label || ''} ${item.state?.detail || ''}`.toLowerCase();
    return (
      (EXEC_CASE_UI.state === 'all' || item.state?.key === EXEC_CASE_UI.state) &&
      (!EXEC_CASE_UI.q || haystack.includes(EXEC_CASE_UI.q.toLowerCase()))
    );
  });
  const selectedCaseId = filteredCases.some(item => item.case_id === EXEC_CASE_UI.selected)
    ? EXEC_CASE_UI.selected
    : filteredCases[0]?.case_id || null;
  EXEC_CASE_UI.selected = selectedCaseId;
  const selectedCase = selectedCaseId
    ? await apiOptional('GET', `/api/cases/${encodeURIComponent(selectedCaseId)}`, null)
    : null;
  const caseRows = filteredCases
    .map(
      item =>
        `<button type="button" class="ex-case-list-item ${item.case_id === selectedCaseId ? 'selected' : ''}" data-case-id="${esc(item.case_id)}"><span class="ex-case-list-top"><b>${esc(item.title)}</b>${workItemBadge(item.priority, 'priority')}</span><span class="ex-case-list-meta">${esc(item.site || 'fleet')} · ${esc(item.owner || 'unassigned')} · <span class="badge b-${esc(item.state?.tone || 'blue')}">${esc(item.state?.label || 'Open')}</span></span><span class="ex-case-list-summary">${esc(item.state?.detail || item.next_action || 'No next action recorded.')}</span></button>`
    )
    .join('');
  const caseRecord = selectedCase?.case || null;
  const caseTimeline = (caseRecord?.timeline || [])
    .slice(-80)
    .reverse()
    .map(
      row =>
        `<div class="ex-case-timeline-row"><div class="ex-case-timeline-head"><b>${esc(row.label)}</b><span>${esc(fmtDate(row.at))}</span></div><div>${esc(row.body || 'Recorded activity')}</div><small>${esc(row.actor || 'system')}</small></div>`
    )
    .join('');
  const caseRequests = (caseRecord?.requests || [])
    .map(
      request =>
        `<div class="ex-case-linked-row"><b>${esc(request.title || request.request_id)}</b><span class="badge b-${request.status === 'failed' ? 'red' : request.status === 'queued' ? 'blue' : 'green'}">${esc(request.status || 'unknown')}</span><small>${esc(request.site || '')} · ${esc(fmtDate(request.updated_at || request.created_at))}</small></div>`
    )
    .join('');
  const caseRuns = (caseRecord?.runs || [])
    .map(
      run =>
        `<div class="ex-case-linked-row"><b>${esc(run.title || run.run_id)}</b><span class="badge b-${run.state === 'failed' ? 'red' : ['measuring', 'review'].includes(run.state) ? 'purple' : 'blue'}">${esc(run.state || 'unknown')}</span><small>${esc(fmtDate(run.updated_at || run.created_at))}</small></div>`
    )
    .join('');
  const caseOutcome = caseRecord?.outcome
    ? typeof caseRecord.outcome === 'string'
      ? caseRecord.outcome
      : JSON.stringify(caseRecord.outcome, null, 2)
    : '';
  const caseDetail = caseRecord
    ? `<article class="ex-case-detail"><div class="ex-case-detail-head"><div><div class="ex-eyebrow">UNIFIED CASE</div><h3>${esc(caseRecord.title)}</h3><p class="muted">${esc(caseRecord.site || 'fleet')} · case ${esc(caseRecord.case_id.slice(0, 20))}</p></div><span class="badge b-${esc(caseRecord.state?.tone || 'blue')}">${esc(caseRecord.state?.label || 'Open')}</span></div><div class="ex-case-facts"><div><span>Owner</span><b>${esc(caseRecord.owner || 'unassigned')}</b></div><div><span>Waiting on</span><b>${esc(caseRecord.waiting_on || '—')}</b></div><div><span>Next action</span><b>${esc(caseRecord.next_action || '—')}</b></div><div><span>Due</span><b>${caseRecord.due_at ? esc(fmtDate(caseRecord.due_at)) : '—'}</b></div></div><div class="ex-case-summary">${esc(caseRecord.work?.summary || 'No case summary recorded.')}</div><div class="ex-case-links"><span class="muted">Linked work ${esc(caseRecord.links.work_id?.slice(0, 12) || '—')}</span><span class="muted">${caseRecord.links.request_ids.length} request${caseRecord.links.request_ids.length === 1 ? '' : 's'}</span><span class="muted">${caseRecord.links.run_ids.length} run${caseRecord.links.run_ids.length === 1 ? '' : 's'}</span></div><div class="ex-case-linked-grid"><div><h4>Assigned work / delivery requests</h4><div class="ex-case-linked-list">${caseRequests || '<div class="ex-empty">No delivery request linked yet.</div>'}</div></div><div><h4>Agent runs / measurements</h4><div class="ex-case-linked-list">${caseRuns || '<div class="ex-empty">No agent run linked yet.</div>'}</div></div></div>${caseOutcome ? `<div class="ex-case-outcome"><h4>Latest outcome</h4><pre>${esc(caseOutcome)}</pre></div>` : ''}<div class="task-toolbar ex-case-actions">${caseRecord.links.request_ids[0] ? `<button class="btn sm" type="button" data-case-open-queue="${esc(caseRecord.links.request_ids[0])}">Open delivery queue</button>` : ''}${caseRecord.links.work_id ? `<button class="btn sm" type="button" data-case-open-thread="${esc(caseRecord.links.work_id)}">Open conversation</button>` : ''}<button class="btn sm" type="button" id="ex-case-close">Close dossier</button></div><h4>Full case timeline and conversation</h4><div class="ex-case-timeline">${caseTimeline || '<div class="ex-empty">No timeline activity recorded yet.</div>'}</div></article>`
    : '<div class="ex-empty">Select a case to inspect its full lifecycle.</div>';
  const casePanel = `<section class="ex-panel ex-cases"><div class="ex-panel-head"><div><div class="ex-eyebrow">END-TO-END CASES</div><h3>Unified work lifecycle</h3><p class="muted">One case links the thread, owner, work item, queue request, agent run, review, deployment, measurement, and outcome.</p></div><span class="badge b-blue">${filteredCases.length} shown · ${allCases.length} total</span></div><div class="ex-case-toolbar"><input id="ex-case-search" class="cm-input" type="search" aria-label="Search executive cases" placeholder="Search cases…" value="${esc(EXEC_CASE_UI.q)}"><select id="ex-case-state" class="cm-input" aria-label="Filter executive cases by state"><option value="all" ${EXEC_CASE_UI.state === 'all' ? 'selected' : ''}>All states</option>${['waiting', 'queued', 'working', 'blocked', 'failed', 'measuring', 'completed'].map(value => `<option value="${value}" ${EXEC_CASE_UI.state === value ? 'selected' : ''}>${value.replace('_', ' ')}</option>`).join('')}</select></div><div class="ex-case-split"><div class="ex-case-list">${caseRows || '<div class="ex-empty">No cases match this view.</div>'}</div><div class="ex-case-detail-pane">${caseDetail}</div></div></section>`;
  const isCROHandoff = p => ['researcher', 'cro'].includes(String(p.created_by));
  const proposalSite = p => p.implementation?.site || null;
  const proposalScope = p => {
    const site = proposalSite(p);
    return site
      ? `<span class="badge b-blue ex-scope-badge">for ${esc(site)}</span>`
      : '<span class="badge b-purple ex-scope-badge">fleet-wide</span>';
  };
  const proposalRows = (proposals.proposals || [])
    .map(p => {
      const croHandoff = isCROHandoff(p);
      const pending = ['proposed', 'feedback'].includes(p.status);
      const status = croHandoff && pending ? 'exec review' : p.status;
      const badge =
        p.status === 'approved'
          ? 'b-green'
          : p.status === 'declined'
            ? 'b-red'
            : p.status === 'feedback'
              ? 'b-yellow'
              : 'b-blue';
      const decision =
        croHandoff && pending
          ? 'Presented to CEO/CTO'
          : pending
            ? `<button class="btn sm primary ex-approve" data-id="${esc(p.proposal_id)}" aria-label="Approve proposal: ${esc(p.title)}" title="Approve proposal: ${esc(p.title)}">Approve</button> <button class="btn sm ex-feedback" data-id="${esc(p.proposal_id)}" aria-label="Reply or request changes for proposal: ${esc(p.title)}" title="Reply or request changes for proposal: ${esc(p.title)}">Reply / request changes</button> <button class="btn sm danger ex-decline" data-id="${esc(p.proposal_id)}" aria-label="Decline proposal: ${esc(p.title)}" title="Decline proposal: ${esc(p.title)}">Decline</button>`
            : esc(p.decision_note || '');
      return `<tr><td><b>${esc(p.title)}</b><div class="muted">${proposalScope(p)} ${esc(p.proposal_type)} · ${esc(executiveActorLabel(p.created_by))}</div></td><td>${esc(p.summary)}${p.requested_action ? `<div class="muted ex-decision-request"><b>Decision:</b> ${esc(p.requested_action)}</div>` : ''}</td><td><span class="badge ${badge}">${esc(status)}</span></td><td>${decision} <button class="btn sm ex-open-thread" type="button">Work thread →</button></td></tr>`;
    })
    .join('');
  const pendingApprovalRows = (proposals.proposals || [])
    .filter(
      p =>
        ['proposed', 'feedback'].includes(p.status) &&
        p.owner_action_required === true &&
        !isCROHandoff(p)
    )
    .map(p => {
      const impl = p.implementation || {};
      const route = [
        impl.assigned_role || 'engineer',
        impl.provider || 'chatgpt',
        impl.model || 'provider default',
      ].join(' · ');
      return `<article class="card ex-approval-card"><div class="page-head"><div><h3>${esc(p.title)}</h3><div class="muted">${proposalScope(p)} ${esc(p.proposal_type)} · proposed by ${esc(p.created_by)} · ${esc(fmtDate(p.created_at))}</div></div><span class="badge b-yellow">${esc(p.status === 'feedback' ? 'needs revision' : 'awaiting approval')}</span></div><p>${esc(p.summary)}</p>${p.requested_action ? `<div class="ex-decision-request"><b>Decision requested:</b> ${esc(p.requested_action)}</div>` : ''}<div class="muted"><b>Implementation route:</b> ${esc(route)}${impl.site ? ` · ${esc(impl.site)}` : ''}</div><div class="task-toolbar"><button type="button" class="btn primary ex-approve" data-id="${esc(p.proposal_id)}">Approve and respond</button><button type="button" class="btn ex-quick-approve" data-id="${esc(p.proposal_id)}">Quick Approve</button><button type="button" class="btn ex-feedback" data-id="${esc(p.proposal_id)}">Reply / request changes</button><button type="button" class="btn danger ex-decline" data-id="${esc(p.proposal_id)}">Decline</button></div></article>`;
    })
    .join('');
  const croReviewRows = (proposals.proposals || [])
    .filter(p => ['proposed', 'feedback'].includes(p.status) && isCROHandoff(p))
    .map(
      p =>
        `<article class="card ex-approval-card"><div class="page-head"><div><h3>${esc(p.title)}</h3><div class="muted">${proposalScope(p)} ${esc(p.proposal_type)} · CRO research lead · ${esc(fmtDate(p.created_at))}</div></div><span class="badge b-blue">awaiting CEO/CTO review</span></div><p>${esc(p.summary)}</p>${p.requested_action ? `<div class="ex-decision-request"><b>Review requested:</b> ${esc(p.requested_action)}</div>` : ''}<p class="muted" style="margin-bottom:0">This is a research handoff, not an adoption approval. CEO/CTO validates fit, license, security, and measurable fleet value.</p></article>`
    )
    .join('');
  const actionRows = (actions.actions || [])
    .map(
      a =>
        `<tr><td class="muted">${esc(fmtDate(a.started_at))}</td><td><b>${esc(executiveActorLabel(a.actor))}</b><div class="muted">${esc(a.action_type)}</div></td><td>${esc(a.summary)}</td><td><span class="badge ${a.status === 'completed' ? 'b-green' : a.status === 'failed' ? 'b-red' : 'b-blue'}">${esc(a.status)}</span>${a.error ? `<div class="error-text">${esc(a.error)}</div>` : ''}</td></tr>`
    )
    .join('');
  const s = settings.settings || {};
  const intel = brief.brief?.intelligence || {};
  const executiveBreadcrumb = STATE.view === 'agent' ? breadcrumb('executive') : '';
  const pendingCount = (proposals.proposals || []).filter(
    p =>
      ['proposed', 'feedback'].includes(p.status) &&
      p.owner_action_required === true &&
      !isCROHandoff(p)
  ).length;
  const fleetCost = intel.ai_usage?.summary?.total_cost_usd;
  const fleetCalls = intel.ai_usage?.summary?.calls;
  const revopsSummary = revops.summary || {};
  const experimentRows = experiments.experiments || [];
  const campaignSummary = campaigns.summary || {};
  const reportRows = reports.reports || [];
  const latestReport = reportRows[0];
  const managerQueueSummary = managerQueue.queue || {};
  const principalQueueSummary = principalQueue.summary || {};
  const croRuns = croLabRuns?.runs || [];
  const activeRun = runStatus?.active;
  const latestRun = runStatus?.latest;
  const runQueue = runStatus?.queue || [];
  // Run logs load in their own drawer on demand. Fetching a full dossier here
  // made every page refresh wait on a large transcript, even when no log was
  // being viewed.
  const selectedRunId = null;
  const runResult = latestRun?.result?.tick_result || latestRun?.result || {};
  const runCounts = runResult?.counts || runResult?.created_counts || {};
  const runFailureReason =
    latestRun?.failure_reason ||
    latestRun?.result?.failure_reason ||
    latestRun?.result?.tick_error ||
    latestRun?.result?.tick_result?.failure_reason ||
    latestRun?.result?.tick_result?.error ||
    latestRun?.error ||
    null;
  const runFailureStage =
    latestRun?.result?.failed_stage || latestRun?.result?.tick_result?.failed_stage || null;
  const activePhase = activeRun?.result?.phase || 'queued';
  const runStatusLabel = activeRun ? activePhase : latestRun ? latestRun.status : 'ready';
  const runStatusClass = activeRun
    ? 'b-blue'
    : latestRun?.status === 'completed'
      ? 'b-green'
      : latestRun?.status === 'failed'
        ? 'b-red'
        : 'b-gray';
  const runDetails = activeRun
    ? `${activePhase === 'queued' ? 'Queued' : 'Started'} ${fmtDate(activeRun.result?.[activePhase === 'queued' ? 'queued_at' : 'running_at'] || activeRun.started_at)} · run ${activeRun.action_id.slice(0, 8)} · the team is working through its role passes.`
    : latestRun
      ? `${latestRun.status === 'completed' ? 'Completed' : 'Last attempt'} ${fmtDate(latestRun.finished_at || latestRun.started_at)}${runFailureReason ? ` · ${runFailureReason}` : ''}`
      : 'No operator-triggered run yet.';
  const runOutput =
    !activeRun && latestRun?.status === 'failed'
      ? `<div class="ex-run-output ex-run-failure"><b>Failure reason</b><span>${esc(runFailureReason || 'No failure reason was recorded.')}</span>${runFailureStage ? `<span class="muted">Stage: ${esc(runFailureStage)}</span>` : ''}${latestRun.result?.approved_work_warning ? `<span class="muted">Warning: ${esc(latestRun.result.approved_work_warning)}</span>` : ''}<span class="muted">The linked tick and audit record remain available below.</span></div>`
      : !activeRun && latestRun?.status === 'completed'
        ? `<div class="ex-run-output"><b>Latest output</b><span>${esc(
            Object.entries(runCounts)
              .filter(([, value]) => Number(value) > 0)
              .map(([key, value]) => `${value} ${key.replaceAll('_', ' ')}`)
              .join(' · ') || 'No new items recorded'
          )}</span><span class="muted">Review the proposals, messages, and audit log below for the full result.</span></div>`
        : '';
  const runQueueFiltered = runQueue
    .filter(run => {
      const status = run.status === 'started' ? 'running' : run.status;
      const haystack = [status, run.source, run.error, run.result?.phase, run.action_id]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return (
        (EXEC_RUN_UI.status === 'all' || status === EXEC_RUN_UI.status) &&
        (!EXEC_RUN_UI.q || haystack.includes(EXEC_RUN_UI.q.toLowerCase()))
      );
    })
    .sort((a, b) => {
      const value = run => {
        if (EXEC_RUN_UI.sort === 'status') return run.status === 'started' ? 'running' : run.status;
        if (EXEC_RUN_UI.sort === 'source') return run.source || '';
        if (EXEC_RUN_UI.sort === 'result') return run.error || run.result?.phase || '';
        if (EXEC_RUN_UI.sort === 'id') return run.action_id || '';
        return Date.parse(run.started_at || '') || 0;
      };
      const av = value(a),
        bv = value(b);
      return (av < bv ? -1 : av > bv ? 1 : 0) * EXEC_RUN_UI.dir;
    });
  const runPageCount = Math.max(1, Math.ceil(runQueueFiltered.length / EXEC_RUN_UI.pageSize));
  EXEC_RUN_UI.page = Math.min(EXEC_RUN_UI.page, runPageCount);
  const runPageStart = (EXEC_RUN_UI.page - 1) * EXEC_RUN_UI.pageSize;
  const runPage = runQueueFiltered.slice(runPageStart, runPageStart + EXEC_RUN_UI.pageSize);
  const runQueueRows = runPage
    .map(run => {
      const isActive = run.status === 'started';
      const label = run.source === 'manual' ? 'Manual' : 'Scheduled';
      const statusClass = isActive
        ? 'b-blue'
        : run.status === 'completed'
          ? 'b-green'
          : run.status === 'failed'
            ? 'b-red'
            : 'b-gray';
      const detail =
        run.failure_reason ||
        run.result?.failure_reason ||
        run.result?.tick_error ||
        run.result?.tick_result?.failure_reason ||
        run.result?.tick_result?.error ||
        run.error ||
        run.result?.phase ||
        (run.result?.counts ? 'Plan applied' : 'Recorded run');
      const clear =
        run.status === 'failed'
          ? ` <button class="btn sm ex-run-clear" data-id="${esc(run.action_id)}" type="button" aria-label="Clear failed ${esc(label.toLowerCase())} run ${esc(run.action_id.slice(0, 8))}" title="Clear failed ${esc(label.toLowerCase())} run ${esc(run.action_id.slice(0, 8))}">Clear</button>`
          : '';
      return `<tr class="${run.action_id === selectedRunId ? 'ex-run-selected' : ''}"><td><span class="badge ${statusClass}">${isActive ? 'running' : esc(run.status)}</span></td><td><b>${esc(label)}</b><div class="muted">${esc(fmtDate(run.started_at))}</div></td><td>${esc(detail)}${clear}</td><td class="muted"><button class="btn sm ex-run-view" data-id="${esc(run.action_id)}" type="button" aria-label="View log for ${esc(label.toLowerCase())} run ${esc(run.action_id.slice(0, 8))}" title="View log for ${esc(label.toLowerCase())} run ${esc(run.action_id.slice(0, 8))}">View log</button><div>${esc(run.action_id.slice(0, 8))}</div></td></tr>`;
    })
    .join('');
  const runSortButton = (key, label) => {
    const active = EXEC_RUN_UI.sort === key;
    const arrow = active ? (EXEC_RUN_UI.dir < 0 ? '↓' : '↑') : '↕';
    return `<button class="ex-run-sort${active ? ' active' : ''}" data-ex-run-sort="${key}" type="button" aria-label="Sort run history by ${label}">${label} <span aria-hidden="true">${arrow}</span></button>`;
  };
  const failedRunCount = runQueue.filter(run => run.status === 'failed').length;
  const runQueueToolbar = `<div class="ex-run-queue-toolbar"><input id="ex-run-filter" class="cm-input" type="search" aria-label="Filter executive runs" placeholder="Filter runs…" value="${esc(EXEC_RUN_UI.q)}"><select id="ex-run-status" class="cm-input" aria-label="Filter executive runs by status"><option value="all" ${EXEC_RUN_UI.status === 'all' ? 'selected' : ''}>All statuses</option><option value="running" ${EXEC_RUN_UI.status === 'running' ? 'selected' : ''}>Running</option><option value="completed" ${EXEC_RUN_UI.status === 'completed' ? 'selected' : ''}>Completed</option><option value="failed" ${EXEC_RUN_UI.status === 'failed' ? 'selected' : ''}>Failed</option></select><label class="muted">Rows <select id="ex-run-page-size" class="cm-input" aria-label="Executive run history rows per page">${[10, 25, 50, 100].map(n => `<option value="${n}" ${EXEC_RUN_UI.pageSize === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>${failedRunCount ? '<button class="btn sm danger" id="ex-run-clear-failed" type="button" aria-label="Clear failed executive runs" title="Clear failed executive runs">Clear failed</button>' : ''}</div>`;
  const croLabRows = croRuns
    .slice(0, 6)
    .map(run => {
      const candidate = run.candidate?.full_name || 'unknown repository';
      const decision = run.recommendation?.decision || run.status || 'unresolved';
      const checks = (run.checks || []).filter(check => check.status === 'passed').length;
      return `<tr><td><b>${esc(candidate)}</b><div class="muted">${esc(run.candidate?.purpose || 'fleet capability')}</div></td><td><span class="badge ${decision === 'research' ? 'b-green' : decision === 'blocked' ? 'b-red' : 'b-yellow'}">${esc(decision)}</span></td><td>${esc(checks)} passed<div class="muted">${esc(run.repository?.file_count || 0)} files inspected</div></td><td><a href="/api/executive/cro-lab/runs/${encodeURIComponent(run.run_id)}" target="_blank" rel="noreferrer">evidence ↗</a><div class="muted">${esc(fmtDate(run.generated_at))}</div></td></tr>`;
    })
    .join('');
  const reviewCount = (proposals.proposals || []).filter(
    p => ['proposed', 'feedback'].includes(p.status) && isCROHandoff(p)
  ).length;
  const latestMessage = (messages.messages || []).slice().reverse()[0];
  const queueTotal =
    Number(managerQueueSummary.queued || 0) + Number(principalQueueSummary.queued || 0);
  const stat = (value, label, tone = '') =>
    `<div class="ex-kpi ${tone}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  const calendarEvents = calendar?.events || calendar?.calendar?.events || [];
  const calendarBadge = state =>
    `<span class="badge ${state === 'completed' ? 'b-green' : state === 'overdue' ? 'b-red' : state === 'picked_up' ? 'b-blue' : state === 'failed' ? 'b-red' : 'b-yellow'}">${esc(state)}</span>`;
  const calendarRows = calendarEvents
    .slice(0, 30)
    .map(
      e =>
        `<tr><td><b>${esc(e.title)}</b><div class="muted">${esc(e.owner || 'ceo')}${e.site ? ` · ${esc(e.site)}` : ''}</div></td><td>${esc(fmtDate(e.at))}</td><td>${calendarBadge(e.state)}</td><td>${e.state === 'overdue' || e.state === 'scheduled' ? `<button class="btn sm ex-calendar-pick" data-id="${esc(e.id)}" aria-label="Pick up calendar event: ${esc(e.title)}" title="Pick up calendar event: ${esc(e.title)}">Pick up</button>` : ''}${e.state === 'picked_up' ? `<button class="btn sm ex-calendar-complete" data-id="${esc(e.id)}" aria-label="Complete calendar event: ${esc(e.title)}" title="Complete calendar event: ${esc(e.title)}">Complete</button>` : ''}</td></tr>`
    )
    .join('');
  app.innerHTML = `${executiveBreadcrumb}<div class="ex-shell">
    ${executiveDataDegraded ? '<div class="fd-stale-banner" role="status">Some executive telemetry is taking longer than expected. The workspace is usable with the available data; refresh to retry delayed sources.</div>' : ''}
    <header class="ex-hero"><div><div class="ex-eyebrow">FLEET CONTROL PLANE</div><h2 class="page-title">Executive overview</h2><p class="muted">Decisions, risks, and work needing attention. Detailed telemetry is tucked below.</p><span class="sr-only">Executive Leadership · Fleet Executive Office · CEO, CTO, CRO, CFO · fleet AI spend telemetry</span></div><div class="ex-hero-actions"><button class="btn" id="ex-notify-enable" type="button" aria-label="Enable executive browser alerts" title="Enable executive browser alerts">Enable alerts</button><button class="btn" id="ex-notify-read" type="button" aria-label="${unreadNotifications.length ? `Mark ${unreadNotifications.length} executive alerts read` : 'No unread executive alerts'}" ${unreadNotifications.length ? '' : 'disabled'}>${unreadNotifications.length ? `Mark ${unreadNotifications.length} alert${unreadNotifications.length === 1 ? '' : 's'} read` : 'No unread alerts'}</button><button class="btn" id="ex-refresh" type="button" aria-label="Refresh executive overview" title="Refresh executive overview">↻ Refresh</button></div></header>
    <section class="ex-kpis">${stat(pendingCount, 'owner decisions', pendingCount ? 'warn' : 'good')}${stat(reviewCount, 'internal reviews', reviewCount ? 'info' : 'good')}${stat(queueTotal, 'queued work')}${stat(fleetCalls == null ? '—' : Number(fleetCalls).toLocaleString(), 'AI calls')}</section>
    <section class="ex-layout">
      <div class="ex-primary">
        <section class="ex-panel ex-run-panel"><div class="ex-panel-head"><div><div class="ex-eyebrow">EXECUTIVE RUN QUEUE</div><h3>Executive team run</h3><p class="muted">Scheduled and operator-triggered runs share this live audit stream. A run remains visible here when it fails, including the provider or validation reason.</p></div><span class="badge ${runStatusClass}">${esc(runStatusLabel)}</span></div><div class="ex-run-controls"><button class="btn primary" id="ex-run-team" type="button" aria-label="${activeRun ? 'Executive team run is in progress' : 'Run executive team now'}" title="${activeRun ? 'Executive team run is in progress' : 'Run executive team now'}" ${activeRun ? 'disabled' : ''}>${activeRun ? '⏳ Team running…' : '▶ Run executive team'}</button><span class="muted">${esc(runDetails)}</span></div>${runOutput}<div class="ex-run-queue"><div class="ex-run-queue-head"><b>Run history</b><span class="muted">${runQueueFiltered.length} matching · ${runQueue.length} recorded</span></div>${runQueueToolbar}<div class="table-wrap"><table class="tbl"><caption class="sr-only">Executive run history</caption><thead><tr><th>${runSortButton('status', 'Status')}</th><th>${runSortButton('source', 'Source / started')}</th><th>${runSortButton('result', 'Result')}</th><th>${runSortButton('id', 'ID / log')}</th></tr></thead><tbody>${runQueueRows || '<tr><td colspan="4" class="muted">No runs match these filters.</td></tr>'}</tbody></table></div><div class="activity-pagination"><span class="muted">${runQueueFiltered.length ? `Showing ${runPageStart + 1}–${Math.min(runPageStart + EXEC_RUN_UI.pageSize, runQueueFiltered.length)} of ${runQueueFiltered.length}` : 'Showing 0 runs'}</span><button class="btn sm" id="ex-run-prev" type="button" ${EXEC_RUN_UI.page <= 1 ? 'disabled' : ''}>← Previous</button><span class="activity-page-count">Page ${EXEC_RUN_UI.page} of ${runPageCount}</span><button class="btn sm" id="ex-run-next" type="button" ${EXEC_RUN_UI.page >= runPageCount ? 'disabled' : ''}>Next →</button></div></div></section>
        <section class="ex-panel ex-followthrough"><div class="ex-panel-head"><div><div class="ex-eyebrow">DURABLE FOLLOW-THROUGH</div><h3>Executive calendar</h3><p class="muted">Checked-in events are picked up, resumed, and reviewed by the team. Past-due events stay visible until acknowledged.</p></div><button class="btn sm primary" id="ex-calendar-new" type="button" aria-label="Schedule executive calendar event" title="Schedule executive calendar event">＋ Schedule event</button></div><div class="table-wrap"><table class="tbl"><caption class="sr-only">Executive calendar events</caption><thead><tr><th>Event</th><th>When</th><th>Status</th><th>Action</th></tr></thead><tbody>${calendarRows || '<tr><td colspan="4" class="muted">No events scheduled yet.</td></tr>'}</tbody></table></div></section>
        <section class="ex-panel ex-attention"><div class="ex-panel-head"><div><div class="ex-eyebrow">OWNER DECISIONS</div><h3>What needs your attention</h3><p class="muted ex-attention-intro">Only decisions that require an owner choice appear here. Evidence gathering, monitoring, and routine executive follow-through stay in the workbench.</p></div><span class="badge ${pendingCount ? 'b-yellow' : 'b-green'}">${pendingCount ? `${pendingCount} open` : 'all clear'}</span></div>${pendingApprovalRows || '<div class="ex-empty">Nothing is waiting for an owner decision.</div>'}</section>
        <section class="ex-panel ex-compose" id="ex-compose"><div class="ex-panel-head"><div><div class="ex-eyebrow">NEW CONVERSATION</div><h3>Message the executive team</h3></div><span class="muted">Draft saved across sessions</span></div><p class="muted ex-compose-help">Start a durable thread here. Your draft is kept in the host-side control plane until you submit it.</p><textarea id="ex-message" class="cm-input" rows="5" placeholder="What would you like the executive team to research, decide, or prioritize?">${esc(draft?.draft?.body || '')}</textarea><div class="ex-compose-foot"><span class="muted">Tip: include the question, context, links, and what a useful answer should contain.</span><button class="btn primary" id="ex-send">Start conversation</button></div></section>
        ${casePanel}
        <section class="ex-panel ex-requests"><div class="ex-panel-head"><div><div class="ex-eyebrow">OWNER INBOX</div><h3>Requests you’re tracking</h3><p class="muted">Select a request to open its full conversation and next actions.</p></div><span class="badge ${unreadNotifications.length ? 'b-yellow' : 'b-green'}">${unreadNotifications.length} unread · ${allOwnerRequests.length} total</span></div><div class="ex-inbox-toolbar"><input id="ex-inbox-search" class="cm-input" type="search" aria-label="Search executive requests" placeholder="Search requests…" value="${esc(EXEC_INBOX_UI.q)}"><select id="ex-inbox-filter" class="cm-input" aria-label="Filter executive requests"><option value="all" ${EXEC_INBOX_UI.status === 'all' ? 'selected' : ''}>All requests</option><option value="unread" ${EXEC_INBOX_UI.status === 'unread' ? 'selected' : ''}>Unread replies</option><option value="overdue" ${EXEC_INBOX_UI.status === 'overdue' ? 'selected' : ''}>Overdue</option>${['submitted', 'acknowledged', 'answered', 'actioned', 'measured', 'snoozed', 'closed'].map(state => `<option value="${state}" ${EXEC_INBOX_UI.status === state ? 'selected' : ''}>${state}</option>`).join('')}</select><span class="muted">${filteredOwnerRequests.length} matching · page ${EXEC_INBOX_UI.page} of ${inboxPageCount}</span></div>${notificationGroup}<div class="ex-request-split"><div class="ex-request-list">${ownerRequestList || '<div class="ex-empty">No Owner requests match this view.</div>'}</div><div class="ex-request-detail-pane">${ownerRequestDetail}</div></div><div class="activity-pagination"><button class="btn sm" id="ex-inbox-prev" type="button" ${EXEC_INBOX_UI.page <= 1 ? 'disabled' : ''}>← Previous</button><button class="btn sm" id="ex-inbox-next" type="button" ${EXEC_INBOX_UI.page >= inboxPageCount ? 'disabled' : ''}>Next →</button></div></section>
        <details class="ex-disclosure"><summary><span><b>Recent conversation</b><small>${latestMessage ? `${esc(executiveActorLabel(latestMessage.actor))} · ${esc(fmtDate(latestMessage.created_at))}` : 'No messages yet'}</small></span><span class="ex-chevron">›</span></summary><div class="ex-disclosure-body">${messageRows || '<div class="ex-empty">No executive messages yet.</div>'}</div></details>
        <section class="ex-panel ex-transcript-panel"><div class="ex-panel-head"><div><div class="ex-eyebrow">RUN TRANSCRIPT</div><h3>Conversation &amp; background work</h3><p class="muted">Operator-visible requests, structured responses, and pass milestones across the executive team. Private chain-of-thought is never collected.</p></div><span class="badge b-blue">${transcriptMessages.length} events</span></div><div class="ex-transcript-legend"><span class="ex-legend-prompt">Model request</span><span class="ex-legend-response">Model response</span><span class="ex-legend-background">Background work</span><span class="muted">Retained ${esc(String(transcript.retention_days || 90))} days</span></div><div class="ex-transcript-list">${transcriptRows || '<div class="ex-empty">No run transcript yet. Start an executive team run to populate it.</div>'}</div></section>
      </div>
      <aside class="ex-secondary">
        <section class="ex-panel"><div class="ex-panel-head"><div><div class="ex-eyebrow">FLEET SIGNALS</div><h3>At a glance</h3></div><span class="muted">${esc(fmtDate(brief.brief?.generated_at))}</span></div><div class="ex-mini-grid">${stat(intel.analytics?.configured_sites ?? '—', 'analytics sites')}${stat(intel.revenue?.commission_income ?? '—', 'commission income')}${stat(intel.ai_usage?.summary?.total_tokens ?? intel.ai_usage?.summary?.tokens ?? '—', 'AI tokens')}${stat(fleetCost == null ? '—' : `$${Number(fleetCost).toFixed(2)}`, 'telemetry cost')}</div><p class="muted ex-footnote">Telemetry only; no per-run executive cost is inferred.</p></section>
        <section class="ex-panel"><div class="ex-panel-head"><div><div class="ex-eyebrow">OPERATIONS</div><h3>Queues</h3></div><a href="#change-queue" class="muted">open queue →</a></div><div class="ex-queue-row"><span>Domain manager</span><b>${esc(managerQueueSummary.queued ?? 0)} queued</b><span class="muted">${esc(managerQueueSummary.running ?? 0)} running</span></div><div class="ex-queue-row"><span>Principal engineer</span><b>${esc(principalQueueSummary.queued ?? 0)} queued</b><span class="muted">${esc(principalQueueSummary.review ?? 0)} review</span></div></section>
      </aside>
    </section>
    <div class="ex-details-label">DETAILS &amp; CONFIGURATION</div>
    <details class="ex-disclosure"><summary><span><b>Strategy contract</b><small>Targets, limits, risk tolerance, and recurring ticks</small></span><span class="ex-chevron">›</span></summary><div class="ex-disclosure-body"><p class="muted">These settings are included in every CEO/CTO brief and constrain prioritization.</p><div class="form-grid"><label>Monthly revenue target<input id="ex-revenue-target" class="cm-input" value="${esc(s.revenue_target_monthly || '')}" placeholder="e.g. 5000"></label><label>Fixed monthly costs<input id="ex-fixed-costs" class="cm-input" value="${esc(s.fixed_costs_monthly || '')}" placeholder="optional"></label><label>Marketing budget<input id="ex-marketing-budget" class="cm-input" value="${esc(s.marketing_budget_monthly || '')}" placeholder="optional"></label><label>Revenue floor<input id="ex-revenue-floor" class="cm-input" value="${esc(s.revenue_floor_monthly || '')}" placeholder="optional"></label><label>Monthly spend limit<input id="ex-spend-limit" class="cm-input" value="${esc(s.monthly_spend_limit || '')}" placeholder="optional"></label><label>Attribution threshold<input id="ex-attribution-threshold" class="cm-input" value="${esc(s.attribution_materiality_threshold || '')}" placeholder="e.g. 100"></label><label>Risk tolerance<select id="ex-risk" class="cm-input"><option value="">Choose risk tolerance</option><option value="low" ${s.risk_tolerance === 'low' ? 'selected' : ''}>Low — conservative</option><option value="medium" ${s.risk_tolerance === 'medium' ? 'selected' : ''}>Medium — balanced</option><option value="high" ${s.risk_tolerance === 'high' ? 'selected' : ''}>High — exploratory</option></select></label><label>Check-in hours<input id="ex-checkin" class="cm-input" value="${esc(s.checkin_hours || '24')}" type="number" min="1" max="168"></label></div><label class="ex-operating-modes">Operating modes / notes<textarea id="ex-notes" class="cm-input" rows="6" placeholder="What should the executive optimize for? Describe priorities, guardrails, and when to escalate.">${esc(s.operating_notes || '')}</textarea></label><label class="ex-check"><input id="ex-tick-enabled" type="checkbox" ${s.tick_enabled === true ? 'checked' : ''}> Enable recurring executive ticks</label><div class="ex-disclosure-actions"><span class="muted">No spend or deployment authority is granted here.</span><button class="btn primary" id="ex-save-settings">Save strategy</button></div></div></details>
    <details class="ex-disclosure"><summary><span><b>Performance &amp; revenue</b><small>Funnel, campaigns, experiments, reports, and exceptions</small></span><span class="ex-chevron">›</span></summary><div class="ex-disclosure-body"><div class="ex-subsection"><h4>Revenue operating system</h4><div class="ex-mini-grid">${stat(revopsSummary.total_leads ?? 0, 'tracked leads')}${stat(revopsSummary.mqls ?? 0, 'MQLs')}${stat(revopsSummary.opportunities ?? 0, 'opportunities')}${stat(experimentRows.filter(row => row.state === 'running').length, 'running experiments')}${stat(campaignSummary.active ?? 0, 'active campaigns')}</div><p class="muted">Campaigns are planning and attribution records until an owner-approved provider, audience, consent, and unsubscribe path exist.</p></div><div class="ex-subsection"><h4>Domain-manager reports</h4><div class="ex-mini-grid">${stat(reportRows.length, 'recent reports')}${stat(latestReport?.summary?.sites_considered ?? 0, 'sites considered')}${stat(latestReport?.summary?.exceptions ?? 0, 'latest exceptions')}${stat(latestReport?.summary?.deep_dive_candidates ?? 0, 'deep-dive candidates')}</div><p class="muted">${latestReport ? `Latest: ${esc(latestReport.cadence)} · ${esc(fmtDate(latestReport.generated_at))}.` : 'No reports generated yet.'}</p></div><div class="ex-subsection"><div class="ex-panel-head"><div><h4>CRO repo lab</h4><p class="muted">CRO candidates are now tested in disposable workspaces before CEO/CTO review. No dependencies are installed and no project files are mounted.</p></div><button class="btn sm" id="ex-run-cro-lab">Run CRO lab</button></div><div class="table-wrap"><table class="tbl"><thead><tr><th>Repository</th><th>Decision</th><th>Evidence</th><th>Report</th></tr></thead><tbody>${croLabRows || '<tr><td colspan="4" class="muted">No repo-lab runs yet.</td></tr>'}</tbody></table></div></div></div></details>
    <details class="ex-disclosure"><summary><span><b>Decision history</b><small>${(proposals.proposals || []).length} proposals · ${actions.actions?.length ?? 0} audited actions</small></span><span class="ex-chevron">›</span></summary><div class="ex-disclosure-body"><div class="table-wrap">${proposalRows ? `<table class="tbl"><thead><tr><th>Proposal</th><th>Summary</th><th>Status</th><th>Decision</th></tr></thead><tbody>${proposalRows}</tbody></table>` : '<div class="ex-empty">No proposals yet.</div>'}</div><h4 class="ex-history-title">Action audit log</h4><div class="table-wrap"><table class="tbl"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Status</th></tr></thead><tbody>${actionRows || '<tr><td colspan="4" class="muted">No executive actions recorded yet.</td></tr>'}</tbody></table></div></div></details>
  </div>`;
  mountExecutiveWorkspaceNav(STATE.agentPage || 'overview');
  applyExecutiveWorkspace(STATE.agentPage || 'overview');
  $('#ex-save-settings')
    ?.closest('.ex-disclosure-body')
    ?.querySelector('.form-grid')
    ?.insertAdjacentHTML(
      'beforeend',
      `<label>Transcript retention (days)<input id="ex-transcript-retention" class="cm-input" value="${esc(s.conversation_retention_days || '90')}" type="number" min="1" max="3650"><small class="muted">Operator-visible run transcript only.</small></label>`
    );
  $('#ex-refresh').onclick = () => softRender();
  $('#ex-case-search').oninput = event => {
    EXEC_CASE_UI.q = event.target.value.trim();
    EXEC_CASE_UI.selected = null;
    softRender();
  };
  $('#ex-case-state').onchange = event => {
    EXEC_CASE_UI.state = event.target.value;
    EXEC_CASE_UI.selected = null;
    softRender();
  };
  $$('.ex-case-list-item').forEach(button => {
    button.onclick = () => {
      EXEC_CASE_UI.selected = button.dataset.caseId;
      softRender();
    };
  });
  $('#ex-case-close')?.addEventListener('click', () => {
    EXEC_CASE_UI.selected = null;
    softRender();
  });
  $$('[data-case-open-thread]').forEach(button => {
    button.onclick = () => {
      EXEC_INBOX_UI.selected = button.dataset.caseOpenThread;
      go('agent', 'executive', 'conversation');
    };
  });
  $$('[data-case-open-queue]').forEach(button => {
    button.onclick = () => {
      CHANGE_QUEUE_DETAIL = button.dataset.caseOpenQueue;
      go('change-queue');
    };
  });
  $('#ex-inbox-search').oninput = event => {
    EXEC_INBOX_UI.q = event.target.value.trim();
    EXEC_INBOX_UI.page = 1;
    softRender();
  };
  $('#ex-inbox-filter').onchange = event => {
    EXEC_INBOX_UI.status = event.target.value;
    EXEC_INBOX_UI.page = 1;
    softRender();
  };
  $$('.ex-request-list-item').forEach(button => {
    button.onclick = () => {
      EXEC_INBOX_UI.selected = button.dataset.requestId;
      softRender();
    };
  });
  $('#ex-inbox-prev').onclick = () => {
    EXEC_INBOX_UI.page -= 1;
    softRender();
  };
  $('#ex-inbox-next').onclick = () => {
    EXEC_INBOX_UI.page += 1;
    softRender();
  };
  $('#ex-notify-enable').onclick = async () => {
    if (!('Notification' in window))
      return toast('Browser notifications are not supported here', 'err');
    const permission = await Notification.requestPermission();
    toast(
      permission === 'granted' ? 'Executive alerts enabled' : 'Executive alerts remain disabled',
      permission === 'granted' ? 'ok' : 'err'
    );
  };
  $('#ex-notify-read').onclick = async () => {
    try {
      await api('POST', '/api/executive/notifications/read-all', {});
      softRender();
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  $$('.ex-notification-read').forEach(button => {
    button.onclick = async () => {
      try {
        await api(
          'POST',
          `/api/executive/notifications/${encodeURIComponent(button.closest('[data-notification-id]').dataset.notificationId)}/read`,
          {}
        );
        softRender();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  });
  $$('.ex-request-ack').forEach(button => {
    button.onclick = async () => {
      try {
        await api(
          'POST',
          `/api/executive/requests/${encodeURIComponent(button.dataset.id)}/transition`,
          { lifecycle_state: 'acknowledged' }
        );
        toast('Request acknowledged');
        softRender();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  });
  $$('.ex-request-close').forEach(button => {
    button.onclick = async () => {
      const outcome = await requestModalText({
        title: 'Close executive request',
        label: 'Outcome or resolution note',
        placeholder: 'What was resolved, decided, or handed off?',
        required: true,
        submitLabel: 'Close request',
      });
      if (!outcome) return;
      try {
        await api(
          'POST',
          `/api/executive/requests/${encodeURIComponent(button.dataset.id)}/transition`,
          { lifecycle_state: 'closed', outcome }
        );
        toast('Request closed');
        softRender();
      } catch (e) {
        toast(e.message, 'err');
      }
    };
  });
  $$('.ex-work-reply-send').forEach(button => {
    button.onclick = async () => {
      const body = $(
        `.ex-work-reply-body[data-id="${CSS.escape(button.dataset.id)}"]`
      )?.value.trim();
      if (!body) return toast('Write a reply first', 'err');
      const request = allOwnerRequests.find(item => item.work_id === button.dataset.id);
      const thread = request ? requestThread(request) : [];
      button.disabled = true;
      try {
        await api('POST', '/api/executive/messages', {
          actor: 'owner',
          body,
          work_id: button.dataset.id,
          reply_to: thread.at(-1)?.message_id || null,
          message_type: 'update',
        });
        toast('Reply added; the executive team will see it on its next run');
        softRender();
      } catch (e) {
        button.disabled = false;
        toast(e.message, 'err');
      }
    };
  });
  $('#ex-run-filter').onchange = e => {
    EXEC_RUN_UI.q = e.target.value.trim();
    EXEC_RUN_UI.page = 1;
    softRender();
  };
  $('#ex-run-status').onchange = e => {
    EXEC_RUN_UI.status = e.target.value;
    EXEC_RUN_UI.page = 1;
    softRender();
  };
  $('#ex-run-page-size').onchange = e => {
    EXEC_RUN_UI.pageSize = Number(e.target.value) || 25;
    EXEC_RUN_UI.page = 1;
    softRender();
  };
  $('#ex-run-prev').onclick = () => {
    EXEC_RUN_UI.page -= 1;
    softRender();
  };
  $('#ex-run-next').onclick = () => {
    EXEC_RUN_UI.page += 1;
    softRender();
  };
  $$('.ex-run-view').forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      button.disabled = true;
      button.textContent = 'Opening…';
      openExecutiveRunLog(button.dataset.id).finally(() => {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = 'View log';
        }
      });
    });
  });
  $$('.ex-run-sort').forEach(
    button =>
      (button.onclick = () => {
        const key = button.dataset.exRunSort;
        if (EXEC_RUN_UI.sort === key) EXEC_RUN_UI.dir *= -1;
        else {
          EXEC_RUN_UI.sort = key;
          EXEC_RUN_UI.dir = key === 'started_at' ? -1 : 1;
        }
        EXEC_RUN_UI.page = 1;
        softRender();
      })
  );
  $('#ex-run-clear-failed')?.addEventListener('click', async () => {
    const button = $('#ex-run-clear-failed');
    button.disabled = true;
    try {
      await api('POST', '/api/executive/run/clear-failed', {});
      toast('Failed runs cleared');
      softRender();
    } catch (e) {
      button.disabled = false;
      toast(e.message, 'err');
    }
  });
  $$('.ex-run-clear').forEach(
    button =>
      (button.onclick = async () => {
        button.disabled = true;
        try {
          await api(
            'POST',
            `/api/executive/run/${encodeURIComponent(button.dataset.id)}/clear`,
            {}
          );
          toast('Failed run cleared');
          softRender();
        } catch (e) {
          button.disabled = false;
          toast(e.message, 'err');
        }
      })
  );
  $('#ex-open-setup')?.addEventListener('click', () => go('agent', 'executive', 'setup'));
  $('#ex-run-team').onclick = async () => {
    const button = $('#ex-run-team');
    button.disabled = true;
    button.textContent = '⏳ Queuing executive team…';
    try {
      await api('POST', '/api/executive/run', {});
      toast('Executive team run started');
      await softRender();
      pollExecutiveRun();
    } catch (e) {
      toast(e.message, 'err');
      button.disabled = false;
      button.textContent = '▶ Run executive team';
    }
  };
  $$('.ex-calendar-pick').forEach(
    b =>
      (b.onclick = async () => {
        await api('POST', `/api/executive/calendar/${encodeURIComponent(b.dataset.id)}/picked_up`, {
          actor: 'owner',
        });
        toast('Event picked up');
        softRender();
      })
  );
  $$('.ex-calendar-complete').forEach(
    b =>
      (b.onclick = async () => {
        const note = await globalThis.fleetTextPrompt?.({
          title: 'Review follow-up',
          label: 'Write the follow-up, or type "none" if no follow-up is needed',
          required: true,
          submitLabel: 'Complete event',
        });
        if (!note) return;
        await api('POST', `/api/executive/calendar/${encodeURIComponent(b.dataset.id)}/completed`, {
          followup_status: note.trim().toLowerCase() === 'none' ? 'none' : 'written',
          followup_note: note.trim().toLowerCase() === 'none' ? null : note.trim(),
        });
        toast('Event completed — review follow-ups');
        softRender();
      })
  );
  $('#ex-calendar-new')?.addEventListener('click', async () => {
    const title = await globalThis.fleetTextPrompt?.({
      title: 'Schedule executive event',
      label: 'Event title',
      required: true,
      submitLabel: 'Next',
    });
    if (!title) return;
    const when = await globalThis.fleetTextPrompt?.({
      title: 'Schedule executive event',
      label: 'ISO date/time (for example 2026-10-01T14:00:00-04:00)',
      required: true,
      submitLabel: 'Schedule',
    });
    if (!when) return;
    const repeat = await globalThis.fleetTextPrompt?.({
      title: 'Schedule executive event',
      label: 'Repeat interval (optional, e.g. 2 hours or 1 day)',
      submitLabel: 'Schedule',
    });
    const recurrence = repeat?.trim() ? { kind: 'interval', value: repeat.trim() } : null;
    api('POST', '/api/executive/calendar', {
      title,
      at: when,
      recurrence,
      action: { type: 'reminder' },
      followup_required: true,
    })
      .then(() => {
        toast('Calendar event scheduled');
        softRender();
      })
      .catch(e => toast(e.message, 'err'));
  });
  if (activeRun) pollExecutiveRun();
  $('#ex-run-cro-lab').onclick = async () => {
    const button = $('#ex-run-cro-lab');
    button.disabled = true;
    try {
      await api('POST', '/api/executive/cro-lab/run', {});
      toast('CRO repo lab completed');
      softRender();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      button.disabled = false;
    }
  };
  $('#ex-message').oninput = event => {
    clearTimeout(EXECUTIVE_DRAFT_SAVE_TIMER);
    const body = event.target.value;
    EXECUTIVE_DRAFT_SAVE_TIMER = setTimeout(() => {
      api('PUT', '/api/executive/draft', { body }).catch(() => {});
    }, 350);
  };
  $('#ex-send').onclick = async () => {
    const body = $('#ex-message').value.trim();
    if (!body) return toast('Write a message first', 'err');
    const button = $('#ex-send');
    button.disabled = true;
    try {
      clearTimeout(EXECUTIVE_DRAFT_SAVE_TIMER);
      await api('POST', '/api/executive/requests', { actor: 'owner', body });
      await api('DELETE', '/api/executive/draft');
      // Clear the composer before the refresh so a successful submission
      // behaves like a normal message box and never looks duplicated.
      $('#ex-message').value = '';
      toast('Conversation started; the executive team will see it on its next run');
      softRender();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      button.disabled = false;
    }
  };
  $('#ex-save-settings').onclick = async () => {
    const btn = $('#ex-save-settings');
    btn.disabled = true;
    try {
      await api('PATCH', '/api/executive/settings', {
        revenue_target_monthly: $('#ex-revenue-target').value.trim(),
        fixed_costs_monthly: $('#ex-fixed-costs').value.trim(),
        marketing_budget_monthly: $('#ex-marketing-budget').value.trim(),
        revenue_floor_monthly: $('#ex-revenue-floor').value.trim(),
        attribution_materiality_threshold: $('#ex-attribution-threshold').value.trim(),
        monthly_spend_limit: $('#ex-spend-limit').value.trim(),
        risk_tolerance: $('#ex-risk').value.trim(),
        checkin_hours: Number($('#ex-checkin').value || 24),
        conversation_retention_days: Number($('#ex-transcript-retention').value || 90),
        operating_notes: $('#ex-notes').value.trim(),
        tick_enabled: $('#ex-tick-enabled').checked,
      });
      toast('Strategy saved');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  };
  // Setup is rendered as its own route. Remove the legacy inline copy after
  // wiring the shared handlers so overview remains focused on decisions.
  const overviewSetup = $('#ex-revenue-target')?.closest('details');
  if (overviewSetup && !STATE.agentPage) {
    let node = overviewSetup;
    for (let i = 0; i < 3 && node; i += 1) {
      const next = node.nextElementSibling;
      node.remove();
      node = next;
    }
  }
  const decide = (button, status) => {
    if (!$('#modal') || !$('#modal-title') || !$('#modal-body')) {
      toast('Approval dialog is unavailable; refresh the dashboard', 'err');
      return;
    }
    const proposalTitle =
      button.closest('.ex-approval-card')?.querySelector('h3')?.textContent || 'this proposal';
    const isFeedback = status === 'feedback';
    const isDecline = status === 'declined';
    const intent = isFeedback
      ? 'Reply to the team with the changes, questions, evidence, or decision criteria they need. This will return the proposal for revision.'
      : isDecline
        ? 'Explain why this proposal should not proceed. This note becomes part of the decision record.'
        : 'Optionally record the approval context, constraints, or implementation guardrails.';
    $('#modal-title').textContent = isFeedback
      ? 'Reply / request changes'
      : isDecline
        ? 'Decline proposal'
        : 'Approve proposal';
    $('#modal-body').innerHTML =
      `<div class="ex-decision-form"><div class="ex-decision-context"><div class="cq-eyebrow">${isFeedback ? 'TEAM REPLY' : 'DECISION RECORD'}</div><strong>${esc(proposalTitle)}</strong><p>${esc(intent)}</p></div><label class="field"><span>${isFeedback ? 'Reply and requested changes' : isDecline ? 'Reason for declining' : 'Decision note (optional)'}</span><textarea id="ex-decision-note" class="cm-input" rows="8" placeholder="${isFeedback ? 'Be specific: what needs to change, what research is required, what must be true before approval…' : isDecline ? 'What is the concern, risk, or alternative direction?' : 'Capture the rationale, guardrails, owner, or next step…'}"></textarea></label><div class="modal-actions"><button class="btn" id="ex-decision-cancel">Cancel</button><button class="btn ${isDecline ? 'danger' : 'primary'}" id="ex-decision-submit">${isFeedback ? 'Send reply and request changes' : isDecline ? 'Decline proposal' : 'Approve proposal'}</button></div></div>`;
    $('#modal').classList.remove('hidden');
    $('#ex-decision-cancel').onclick = closeModal;
    $('#ex-decision-submit').onclick = async () => {
      const submit = $('#ex-decision-submit');
      const note = $('#ex-decision-note').value.trim();
      if (isFeedback && !note) return toast('Write the requested changes or reply first', 'err');
      if (isDecline && !note) return toast('Add a reason before declining', 'err');
      submit.disabled = true;
      button.disabled = true;
      try {
        await api(
          'POST',
          `/api/executive/proposals/${encodeURIComponent(button.dataset.id)}/decision`,
          { status, decision_note: note, decided_by: 'owner' }
        );
        closeModal(true);
        toast(isFeedback ? 'Reply sent; proposal returned for revision' : `Proposal ${status}`);
        softRender();
      } catch (e) {
        submit.disabled = false;
        button.disabled = false;
        toast(e.message, 'err');
      }
    };
    $('#ex-decision-note').focus();
  };
  const quickApprove = async button => {
    button.disabled = true;
    try {
      await api(
        'POST',
        `/api/executive/proposals/${encodeURIComponent(button.dataset.id)}/decision`,
        {
          status: 'approved',
          decision_note: '',
          decided_by: 'owner',
        }
      );
      toast('Proposal approved');
      softRender();
    } catch (e) {
      button.disabled = false;
      toast(e.message, 'err');
    }
  };
  // Delegate from the stable app root so controls remain live if a background
  // refresh replaces the approval cards between paint and the user's click.
  app.onclick = event => {
    const button = event.target.closest(
      '.ex-approve, .ex-quick-approve, .ex-feedback, .ex-decline, .ex-open-thread'
    );
    if (!button || !app.contains(button)) return;
    event.preventDefault();
    if (button.classList.contains('ex-open-thread')) go('workbench');
    else if (button.classList.contains('ex-quick-approve')) quickApprove(button);
    else if (button.classList.contains('ex-feedback')) decide(button, 'feedback');
    else if (button.classList.contains('ex-decline')) decide(button, 'declined');
    else decide(button, 'approved');
  };
  wireCrumbs();
  stamp();
}

const WORKBENCH_UI = {
  status: 'open,in_progress,blocked,waiting',
  owner: '',
  kind: '',
  query: '',
  page: 1,
  pageSize: window.matchMedia?.('(max-width: 700px)').matches ? 10 : 25,
};
const WORKBENCH_STATUSES = ['open', 'in_progress', 'blocked', 'waiting', 'done', 'cancelled'];
let workbenchSearchTimer;

function workItemBadge(value, type = 'status') {
  const classes = {
    urgent: 'b-red',
    high: 'b-yellow',
    normal: 'b-blue',
    low: 'b-gray',
    open: 'b-blue',
    in_progress: 'b-purple',
    blocked: 'b-red',
    waiting: 'b-yellow',
    done: 'b-green',
    cancelled: 'b-gray',
  };
  return `<span class="badge ${classes[value] || 'b-gray'}">${esc(String(value || '').replace('_', ' '))}</span>`;
}

function inlineDraftSnapshot(panel) {
  return [...panel.querySelectorAll('input, select, textarea')].map(el => ({
    value: el.value,
    checked: el.checked,
    selected: el.tagName === 'SELECT' ? [...el.selectedOptions].map(option => option.value) : null,
  }));
}

function openInlineDraft(panel) {
  panel.dataset.fdDraftBaseline = JSON.stringify(inlineDraftSnapshot(panel));
  panel.classList.remove('hidden');
}

async function closeInlineDraft(panel, label) {
  if (!panel || panel.classList.contains('hidden')) return true;
  const baseline = panel.dataset.fdDraftBaseline || '';
  const dirty = baseline
    ? JSON.stringify(inlineDraftSnapshot(panel)) !== baseline
    : [...panel.querySelectorAll('input:not([type="hidden"]), textarea')].some(el =>
        el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value.trim()
      );
  if (dirty) {
    const approved = await globalThis.fleetConfirm?.({
      title: `Discard ${label}?`,
      message: `This ${label} has unsaved content. Discard it and close the editor?`,
      confirmLabel: 'Discard draft',
      danger: true,
    });
    if (!approved) return false;
  }
  panel.classList.add('hidden');
  delete panel.dataset.fdDraftBaseline;
  return true;
}

async function renderWorkbench() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading executive workbench…</div></div>';
  let data;
  try {
    data = await api('GET', '/api/executive/work-items?limit=300');
  } catch (e) {
    renderViewError(app, `Workbench failed to load: ${e.message}`);
    return;
  }
  const all = data.work_items || [];
  const selectedStatuses = WORKBENCH_UI.status.split(',').filter(Boolean);
  const statusFilterLabel =
    selectedStatuses.length === 0
      ? 'All statuses'
      : selectedStatuses.length === 1
        ? selectedStatuses[0].replace('_', ' ')
        : `${selectedStatuses.length} statuses`;
  const wbStatusRank = { open: 4, in_progress: 4, blocked: 4, waiting: 4, done: 2, cancelled: 1 };
  const wbCaseKey = item =>
    [item.site || 'fleet', item.owner || '', item.kind || '', item.title || ''].join('\u001f');
  const wbRepresentative = items =>
    items
      .slice()
      .sort(
        (a, b) =>
          (wbStatusRank[b.status] || 0) - (wbStatusRank[a.status] || 0) ||
          new Date(b.updated_at || b.created_at || 0).getTime() -
            new Date(a.updated_at || a.created_at || 0).getTime()
      )[0];
  const allGroups = new Map();
  all.forEach(item => {
    const key = wbCaseKey(item);
    const group = allGroups.get(key) || [];
    group.push(item);
    allGroups.set(key, group);
  });
  const allCaseThreads = [...allGroups.values()].map(wbRepresentative);
  const active = allCaseThreads.filter(item => !['done', 'cancelled'].includes(item.status));
  const visible = all.filter(item => {
    const statuses = WORKBENCH_UI.status.split(',').filter(Boolean);
    const query = WORKBENCH_UI.query.trim().toLowerCase();
    const searchable = [
      item.title,
      item.site,
      item.owner,
      item.kind,
      item.summary,
      item.next_action,
      item.waiting_on,
    ]
      .map(value => String(value || '').toLowerCase())
      .join(' ');
    return (
      (!statuses.length || statuses.includes(item.status)) &&
      (!WORKBENCH_UI.owner || item.owner === WORKBENCH_UI.owner) &&
      (!WORKBENCH_UI.kind || item.kind === WORKBENCH_UI.kind) &&
      (!query || searchable.includes(query))
    );
  });
  // Collapse repeated handoff records before building card markup so retries
  // do not inflate the DOM or spend time rendering cards that are discarded.
  const wbGroups = new Map();
  visible.forEach(item => {
    const key = wbCaseKey(item);
    const group = wbGroups.get(key) || [];
    group.push(item);
    wbGroups.set(key, group);
  });
  const threads = [...wbGroups.values()].map(items => ({
    item: wbRepresentative(items),
    duplicateCount: items.length,
  }));
  const wbCollapsedRecords = visible.length - threads.length;
  const wbDuplicateGroups = threads.filter(thread => thread.duplicateCount > 1).length;
  const pageCount = Math.max(1, Math.ceil(threads.length / WORKBENCH_UI.pageSize));
  WORKBENCH_UI.page = Math.min(WORKBENCH_UI.page, pageCount);
  const pageStart = (WORKBENCH_UI.page - 1) * WORKBENCH_UI.pageSize;
  const pageThreads = threads.slice(pageStart, pageStart + WORKBENCH_UI.pageSize);
  const options = (values, selected, label) =>
    `<option value="">${label}</option>${values.map(value => `<option value="${esc(value)}" ${selected === value ? 'selected' : ''}>${esc(value.replace('_', ' '))}</option>`).join('')}`;
  const rows = pageThreads
    .map(
      ({ item, duplicateCount }) => `<article class="wb-item" data-work-id="${esc(item.work_id)}">
    <div class="wb-item-head"><div><div class="wb-item-title">${esc(item.title)}${duplicateCount > 1 ? `<span class="wb-duplicate-note" title="${duplicateCount} records share this case title; the latest actionable record is shown.">${duplicateCount} linked records</span>` : ''}</div><div class="muted">${esc(item.site || 'fleet')} · ${esc(item.owner)}${item.source_type ? ` · ${esc(item.source_type)}` : ''}</div></div><div class="wb-badges">${workItemBadge(item.priority, 'priority')}${workItemBadge(item.status)}</div></div>
    <p class="wb-summary">${esc(item.summary || 'No context recorded.')}</p>${item.waiting_on ? `<div class="wb-next"><span class="wb-label">WAITING ON</span>${esc(item.waiting_on)}</div>` : ''}
    <div class="wb-next"><span class="wb-label">NEXT</span>${esc(item.next_action || 'No next action recorded.')}</div>
    <div class="wb-item-foot"><span class="muted">${esc(item.kind)}${item.evidence?.length ? ` · ${item.evidence.length} evidence item${item.evidence.length === 1 ? '' : 's'}` : ''}${item.due_at ? ` · due ${esc(fmtDate(item.due_at))}` : ''}</span><div class="wb-actions"><button class="btn sm wb-thread-toggle" data-id="${esc(item.work_id)}" data-thread-title="${esc(item.title)}" aria-label="Open thread for ${esc(item.title)}" aria-controls="wb-thread-${esc(item.work_id)}" aria-expanded="false" title="Open thread for ${esc(item.title)}">Thread</button><select class="cm-input wb-status" data-id="${esc(item.work_id)}" aria-label="Status for ${esc(item.title)}">${options(['open', 'in_progress', 'blocked', 'waiting', 'done', 'cancelled'], item.status, 'Change status')}</select><select class="cm-input wb-owner" data-id="${esc(item.work_id)}" aria-label="Owner for ${esc(item.title)}">${options(['ceo', 'cto', 'cfo', 'legal', 'security', 'cro', 'domain-manager', 'principal-engineer', 'engineer', 'owner'], item.owner, 'Change owner')}</select></div></div><div class="wb-thread hidden" id="wb-thread-${esc(item.work_id)}" data-thread="${esc(item.work_id)}"></div>
  </article>`
    )
    .join('');
  const count = status => allCaseThreads.filter(item => item.status === status).length;
  app.innerHTML = `<div class="wb-shell"><div class="page-head wb-head"><div><div class="wb-eyebrow">ASSISTIVE OPERATING QUEUE</div><h2 class="page-title">Executive Workbench</h2><div class="muted">One place for decisions, evidence gaps, reviews, incidents, and learning. Roles can update cases autonomously; humans step in only when a decision or approval is actually required.</div></div><div class="wb-head-actions"><button type="button" class="btn" id="wb-refresh">↻ Refresh</button><button type="button" class="btn primary" id="wb-new-toggle">＋ New case</button></div></div>
    <section class="wb-kpis"><div><b>${active.length}</b><span>active cases</span></div><div><b>${count('blocked')}</b><span>blocked</span></div><div><b>${count('waiting')}</b><span>waiting</span></div><div><b>${count('done')}</b><span>completed</span></div></section>
    <section class="card wb-new hidden" id="wb-new"><div class="wb-new-head"><div><h3>Open a workbench case</h3><p class="muted">Use this for a durable next action, not a general note.</p></div><button class="icon-btn" id="wb-new-close" aria-label="Close">✕</button></div><div class="form-grid"><label>Title<input id="wb-title" class="cm-input" placeholder="e.g. Confirm affiliate disclosure requirements"></label><label>Kind<select id="wb-kind" class="cm-input">${options(['decision', 'research', 'incident', 'legal', 'security', 'education', 'evidence', 'implementation'], '', 'Choose kind')}</select></label><label>Owner<select id="wb-owner-new" class="cm-input">${options(['ceo', 'cto', 'cfo', 'legal', 'security', 'cro', 'domain-manager', 'principal-engineer', 'engineer', 'owner'], 'ceo', 'Choose owner')}</select></label><label>Priority<select id="wb-priority" class="cm-input">${options(['urgent', 'high', 'normal', 'low'], 'normal', 'Choose priority')}</select></label></div><label>Summary<textarea id="wb-summary" class="cm-input" rows="2" placeholder="Why this matters and what is known so far"></textarea></label><label>Next action<input id="wb-next" class="cm-input" placeholder="The smallest useful next step"></label><div class="task-toolbar"><span class="muted">Cases are visible to the executive roles on their next brief.</span><button class="btn primary" id="wb-create">Create case</button></div></section>
    <section class="wb-toolbar"><label class="wb-search">Find a case<input id="wb-search" class="cm-input" type="search" placeholder="Title, site, owner, or next action…" aria-label="Search workbench cases" value="${esc(WORKBENCH_UI.query)}"></label><div class="wb-filter-control"><span class="wb-filter-label">Show status</span><details class="wb-status-filter" id="wb-filter-status"><summary aria-label="Filter workbench cases by status">${esc(statusFilterLabel)}</summary><div class="wb-status-options" role="group" aria-label="Workbench statuses">${WORKBENCH_STATUSES.map(value => `<label><input type="checkbox" value="${value}" ${selectedStatuses.includes(value) ? 'checked' : ''}><span>${value.replace('_', ' ')}</span></label>`).join('')}</div></details></div><label>Owner<select id="wb-filter-owner" class="cm-input" aria-label="Filter workbench cases by owner">${options(['ceo', 'cto', 'cfo', 'legal', 'security', 'cro', 'domain-manager', 'principal-engineer', 'engineer', 'owner'], WORKBENCH_UI.owner, 'All owners')}</select></label><label>Kind<select id="wb-filter-kind" class="cm-input" aria-label="Filter workbench cases by kind">${options(['decision', 'research', 'incident', 'legal', 'security', 'education', 'evidence', 'implementation'], WORKBENCH_UI.kind, 'All kinds')}</select></label><span class="muted wb-count">${visible.length} of ${all.length} cases shown</span></section>
    <section class="wb-list" aria-label="Workbench cases">${rows || '<div class="empty">No workbench cases match these filters.</div>'}</section><nav class="wb-pagination" aria-label="Workbench case pages"><span class="muted" id="wb-page-status" role="status" aria-live="polite">${threads.length ? `Showing ${pageStart + 1}–${Math.min(pageStart + WORKBENCH_UI.pageSize, threads.length)} of ${threads.length} case threads` : 'No case threads to show'}</span><label class="muted">Rows <select id="wb-page-size" class="cm-input" aria-label="Workbench cases per page">${[10, 25, 50].map(size => `<option value="${size}" ${WORKBENCH_UI.pageSize === size ? 'selected' : ''}>${size}</option>`).join('')}</select></label><button type="button" class="btn sm" id="wb-page-prev" aria-label="Previous workbench page" ${WORKBENCH_UI.page <= 1 ? 'disabled' : ''}>← Previous</button><button type="button" class="btn sm" id="wb-page-next" aria-label="Next workbench page" ${WORKBENCH_UI.page >= pageCount ? 'disabled' : ''}>Next →</button></nav></div>`;
  const wbCount = $('.wb-count');
  if (wbCount) {
    wbCount.textContent = `${visible.length - wbCollapsedRecords} case threads · ${visible.length} records shown${wbDuplicateGroups ? ` · ${wbDuplicateGroups} duplicate set${wbDuplicateGroups === 1 ? '' : 's'} collapsed` : ''}`;
  }
  $('#wb-refresh').onclick = () => renderWorkbench();
  $('#wb-new-toggle').onclick = async () => {
    const panel = $('#wb-new');
    if (panel.classList.contains('hidden')) openInlineDraft(panel);
    else await closeInlineDraft(panel, 'workbench case draft');
  };
  $('#wb-new-close').onclick = () => closeInlineDraft($('#wb-new'), 'workbench case draft');
  $('#wb-search').oninput = e => {
    clearTimeout(workbenchSearchTimer);
    const value = e.target.value.trim().toLowerCase();
    workbenchSearchTimer = setTimeout(() => {
      WORKBENCH_UI.query = value;
      WORKBENCH_UI.page = 1;
      softRender();
    }, 180);
  };
  $('#wb-filter-status').onchange = () => {
    WORKBENCH_UI.status = $$('input[type="checkbox"]', $('#wb-filter-status'))
      .filter(input => input.checked)
      .map(input => input.value)
      .join(',');
    WORKBENCH_UI.page = 1;
    softRender();
  };
  $('#wb-filter-owner').onchange = e => {
    WORKBENCH_UI.owner = e.target.value;
    WORKBENCH_UI.page = 1;
    softRender();
  };
  $('#wb-filter-kind').onchange = e => {
    WORKBENCH_UI.kind = e.target.value;
    WORKBENCH_UI.page = 1;
    softRender();
  };
  $('#wb-page-size').onchange = e => {
    WORKBENCH_UI.pageSize = Number(e.target.value) || 25;
    WORKBENCH_UI.page = 1;
    softRender();
  };
  $('#wb-page-prev').onclick = () => {
    WORKBENCH_UI.page = Math.max(1, WORKBENCH_UI.page - 1);
    softRender();
  };
  $('#wb-page-next').onclick = () => {
    WORKBENCH_UI.page = Math.min(pageCount, WORKBENCH_UI.page + 1);
    softRender();
  };
  $('#wb-create').onclick = async () => {
    const title = $('#wb-title').value.trim();
    const kind = $('#wb-kind').value;
    if (!title || !kind) return toast('Title and kind are required', 'err');
    const button = $('#wb-create');
    button.disabled = true;
    try {
      await api('POST', '/api/executive/work-items', {
        title,
        kind,
        owner: $('#wb-owner-new').value,
        priority: $('#wb-priority').value,
        summary: $('#wb-summary').value.trim(),
        next_action: $('#wb-next').value.trim(),
        created_by: 'owner',
      });
      toast('Workbench case created');
      softRender();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      button.disabled = false;
    }
  };
  $$('.wb-status').forEach(
    select =>
      (select.onchange = async () => {
        try {
          await api('PATCH', `/api/executive/work-items/${encodeURIComponent(select.dataset.id)}`, {
            status: select.value,
          });
          toast('Case status updated');
          softRender();
        } catch (e) {
          toast(e.message, 'err');
        }
      })
  );
  $$('.wb-owner').forEach(
    select =>
      (select.onchange = async () => {
        try {
          await api('PATCH', `/api/executive/work-items/${encodeURIComponent(select.dataset.id)}`, {
            owner: select.value,
          });
          toast('Case owner updated');
          softRender();
        } catch (e) {
          toast(e.message, 'err');
        }
      })
  );
  $$('.wb-thread-toggle').forEach(
    button =>
      (button.onclick = async () => {
        const thread = $(`[data-thread="${CSS.escape(button.dataset.id)}"]`);
        if (!thread) return;
        if (!thread.classList.contains('hidden')) {
          thread.classList.add('hidden');
          button.setAttribute('aria-expanded', 'false');
          button.setAttribute('aria-label', `Open thread for ${button.dataset.threadTitle}`);
          button.setAttribute('title', button.getAttribute('aria-label'));
          return;
        }
        thread.classList.remove('hidden');
        button.setAttribute('aria-expanded', 'true');
        button.setAttribute('aria-label', `Close thread for ${button.dataset.threadTitle}`);
        button.setAttribute('title', button.getAttribute('aria-label'));
        thread.innerHTML =
          '<div class="async-loading" role="status" aria-live="polite">Loading thread…</div>';
        try {
          const data = await api(
            'GET',
            `/api/executive/messages?work_id=${encodeURIComponent(button.dataset.id)}&limit=30`
          );
          const messages = (data.messages || []).slice().reverse();
          thread.innerHTML = `${messages.map(message => `<div class="wb-message"><b>${esc(executiveActorLabel(message.actor))}</b><span class="muted"> · ${esc(message.message_type || 'update')} · ${esc(fmtDate(message.created_at))}</span><div>${esc(message.body)}</div></div>`).join('') || '<div class="muted">No handoffs yet.</div>'}<div class="wb-reply"><textarea class="cm-input wb-reply-body" rows="2" placeholder="Add owner direction to this case…"></textarea><button class="btn sm primary wb-reply-send">Send</button></div>`;
          const wbReplyBody = $('.wb-reply-body', thread);
          if (wbReplyBody) {
            wbReplyBody.setAttribute('aria-label', 'Add owner direction to this case');
            wbReplyBody.setAttribute('name', 'owner_direction');
          }
          $('.wb-reply-send', thread).onclick = async () => {
            const body = $('.wb-reply-body', thread).value.trim();
            if (!body) return toast('Write a reply first', 'err');
            try {
              await api('POST', '/api/executive/messages', {
                actor: 'owner',
                body,
                work_id: button.dataset.id,
                message_type: 'update',
              });
              toast('Thread updated');
              button.click();
              button.click();
            } catch (e) {
              toast(e.message, 'err');
            }
          };
        } catch (e) {
          thread.innerHTML = `<div class="error-text">${esc(e.message)}</div>`;
        }
      })
  );
  if (!FRESH) applyUISnap();
  stamp();
}

const KNOWLEDGE_UI = { status: '', audience: '', query: '' };
let knowledgeSearchTimer;

function renderKnowledge() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading knowledge shelf…</div></div>';
  return api('GET', '/api/executive/knowledge?limit=300')
    .then(data => {
      const all = data.knowledge || [];
      const visible = all.filter(
        item =>
          (!KNOWLEDGE_UI.status || item.status === KNOWLEDGE_UI.status) &&
          (!KNOWLEDGE_UI.audience || item.audience === KNOWLEDGE_UI.audience) &&
          (!KNOWLEDGE_UI.query ||
            [
              item.title,
              item.publisher,
              item.summary,
              item.takeaway,
              item.applied_to,
              ...(item.tags || []),
            ].some(value =>
              String(value || '')
                .toLowerCase()
                .includes(KNOWLEDGE_UI.query)
            ))
      );
      const options = (values, selected, label) =>
        `<option value="">${label}</option>${values.map(value => `<option value="${esc(value)}" ${selected === value ? 'selected' : ''}>${esc(value.replace('_', ' '))}</option>`).join('')}`;
      const cards = visible
        .map(
          item => `<article class="kn-card">
      <div class="kn-card-head"><div><h3>${item.url ? `<a href="${safeHref(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)} ↗</a>` : esc(item.title)}</h3><div class="muted">${esc(item.publisher || 'Publisher not recorded')}${item.jurisdiction ? ` · ${esc(item.jurisdiction)}` : ''}</div></div><div>${workItemBadge(item.status)} ${workItemBadge(item.resource_type)}</div></div>
      <p>${esc(item.summary || 'No relevance note recorded.')}</p>${item.takeaway || item.applied_to ? `<div class="kn-learning"><b>Applied learning</b><div>${esc(item.takeaway || 'No takeaway recorded.')}</div>${item.applied_to ? `<small>Used in: ${esc(item.applied_to)}</small>` : ''}</div>` : ''}
      <div class="kn-meta"><span>${esc(item.audience)}${item.license ? ` · ${esc(item.license)}` : ''}</span>${item.published_at ? `<span>published ${esc(item.published_at)}</span>` : ''}</div>
      <div class="kn-foot"><span class="muted">${(item.tags || []).map(esc).join(' · ') || 'No tags'}</span><div class="kn-actions"><button class="btn sm kn-learning-toggle" data-id="${esc(item.knowledge_id)}" aria-label="Add learning note for ${esc(item.title)}" aria-controls="kn-learning-${esc(item.knowledge_id)}" aria-expanded="false" title="Add learning note for ${esc(item.title)}">Learning note</button><select class="cm-input kn-status" data-id="${esc(item.knowledge_id)}" aria-label="Status for ${esc(item.title)}">${options(['candidate', 'queued', 'in_progress', 'complete', 'rejected'], item.status, 'Change status')}</select></div></div><div class="kn-learning-edit hidden" id="kn-learning-${esc(item.knowledge_id)}" data-learning="${esc(item.knowledge_id)}"><textarea class="cm-input kn-takeaway" rows="2" placeholder="What did the role learn?">${esc(item.takeaway || '')}</textarea><input class="cm-input kn-applied" placeholder="Where was it applied?" value="${esc(item.applied_to || '')}"><button class="btn sm primary kn-learning-save" data-id="${esc(item.knowledge_id)}">Save learning</button></div>
    </article>`
        )
        .join('');
      app.innerHTML = `<div class="kn-shell"><div class="page-head"><div><div class="wb-eyebrow">CURATED LEARNING SYSTEM</div><h2 class="page-title">Knowledge shelf</h2><div class="muted">Short, attributable resources for the roles. Every source carries provenance and a reason to learn it; no random textbook pile and no substitute for counsel.</div></div><div class="kn-head-actions"><button type="button" class="btn" id="kn-refresh">↻ Refresh</button><button type="button" class="btn primary" id="kn-new-toggle">＋ Add source</button></div></div>
      <section class="kn-kpis"><div><b>${all.filter(i => ['queued', 'in_progress'].includes(i.status)).length}</b><span>learning queue</span></div><div><b>${all.filter(i => i.status === 'complete').length}</b><span>completed</span></div><div><b>${all.filter(i => i.audience === 'legal').length}</b><span>legal resources</span></div><div><b>${all.length}</b><span>catalogued</span></div></section>
      <section class="card kn-new hidden" id="kn-new"><div class="page-head"><div><h3>Add a source</h3><p class="muted">Record enough provenance that a role can judge whether it is worth its time.</p></div><button class="icon-btn" id="kn-new-close" aria-label="Close">✕</button></div><div class="form-grid"><label>Title<input id="kn-title" class="cm-input" placeholder="e.g. FTC Endorsement Guides"></label><label>Type<select id="kn-type" class="cm-input">${options(['official', 'book', 'course', 'checklist', 'paper', 'reference'], 'official', 'Choose type')}</select></label><label>Audience<select id="kn-audience-new" class="cm-input">${options(['all', 'ceo', 'cto', 'cfo', 'legal', 'security', 'cro', 'domain-manager', 'engineer'], 'all', 'Choose audience')}</select></label><label>URL<input id="kn-url" class="cm-input" type="url" placeholder="https://…"></label><label>Publisher<input id="kn-publisher" class="cm-input" placeholder="Publisher or institution"></label><label>Jurisdiction<input id="kn-jurisdiction" class="cm-input" placeholder="US / EU / general"></label><label>License<input id="kn-license" class="cm-input" placeholder="Public / CC BY / paid / verify"></label></div><label>Why it matters<textarea id="kn-summary" class="cm-input" rows="2" placeholder="What decision or capability does this support?"></textarea><div class="task-toolbar"><span class="muted">Sources can be queued for a role without interrupting the human owner.</span><button class="btn primary" id="kn-create">Add source</button></div></section>
      <section class="kn-toolbar"><label class="kn-search">Search sources<input id="kn-search" class="cm-input" type="search" placeholder="Title, publisher, tag…" aria-label="Search knowledge sources" value="${esc(KNOWLEDGE_UI.query)}"></label><label>Status<select id="kn-filter-status" class="cm-input">${options(['candidate', 'queued', 'in_progress', 'complete', 'rejected'], KNOWLEDGE_UI.status, 'All statuses')}</select></label><label>Audience<select id="kn-filter-audience" class="cm-input">${options(['all', 'ceo', 'cto', 'cfo', 'legal', 'security', 'cro', 'domain-manager', 'engineer'], KNOWLEDGE_UI.audience, 'All roles')}</select></label><span class="muted">${visible.length} of ${all.length} sources shown</span></section><section class="kn-list">${cards || '<div class="empty">No sources match this view.</div>'}</section></div>`;
      $('#kn-refresh').onclick = () => renderKnowledge();
      $('#kn-new-toggle').onclick = async () => {
        const panel = $('#kn-new');
        if (panel.classList.contains('hidden')) openInlineDraft(panel);
        else await closeInlineDraft(panel, 'knowledge source draft');
      };
      $('#kn-new-close').onclick = () => closeInlineDraft($('#kn-new'), 'knowledge source draft');
      $('#kn-filter-status').onchange = e => {
        KNOWLEDGE_UI.status = e.target.value;
        softRender();
      };
      $('#kn-filter-audience').onchange = e => {
        KNOWLEDGE_UI.audience = e.target.value;
        softRender();
      };
      $('#kn-search').oninput = e => {
        clearTimeout(knowledgeSearchTimer);
        const value = e.target.value.trim().toLowerCase();
        knowledgeSearchTimer = setTimeout(() => {
          KNOWLEDGE_UI.query = value;
          softRender();
        }, 180);
      };
      $('#kn-create').onclick = async () => {
        const title = $('#kn-title').value.trim();
        if (!title) return toast('Title is required', 'err');
        try {
          await api('POST', '/api/executive/knowledge', {
            title,
            resource_type: $('#kn-type').value,
            audience: $('#kn-audience-new').value,
            url: $('#kn-url').value.trim(),
            publisher: $('#kn-publisher').value.trim(),
            jurisdiction: $('#kn-jurisdiction').value.trim(),
            license: $('#kn-license').value.trim(),
            summary: $('#kn-summary').value.trim(),
            created_by: 'owner',
          });
          toast('Source added');
          softRender();
        } catch (e) {
          toast(e.message, 'err');
        }
      };
      $$('.kn-status').forEach(
        select =>
          (select.onchange = async () => {
            try {
              await api(
                'PATCH',
                `/api/executive/knowledge/${encodeURIComponent(select.dataset.id)}`,
                { status: select.value }
              );
              toast('Learning status updated');
              softRender();
            } catch (e) {
              toast(e.message, 'err');
            }
          })
      );
      $$('.kn-learning-toggle').forEach(
        button =>
          (button.onclick = () => {
            const editor = $(`[data-learning="${CSS.escape(button.dataset.id)}"]`);
            if (!editor) return;
            const expanded = editor.classList.toggle('hidden') === false;
            button.setAttribute('aria-expanded', String(expanded));
            const verb = expanded ? 'Edit' : 'Add';
            button.setAttribute(
              'aria-label',
              `${verb} learning note for ${button.title.replace(/^(Add|Edit) learning note for /, '')}`
            );
            button.setAttribute('title', button.getAttribute('aria-label'));
          })
      );
      $$('.kn-learning-save').forEach(
        button =>
          (button.onclick = async () => {
            const edit = $(`[data-learning="${CSS.escape(button.dataset.id)}"]`);
            try {
              await api(
                'PATCH',
                `/api/executive/knowledge/${encodeURIComponent(button.dataset.id)}`,
                {
                  takeaway: $('.kn-takeaway', edit).value.trim(),
                  applied_to: $('.kn-applied', edit).value.trim(),
                  reviewed_by: 'owner',
                }
              );
              toast('Learning recorded');
              softRender();
            } catch (e) {
              toast(e.message, 'err');
            }
          })
      );
      if (!FRESH) applyUISnap();
      stamp();
    })
    .catch(e => {
      if (isStaleRouteError(e)) throw e;
      renderViewError(app, `Knowledge shelf failed to load: ${e.message}`);
    });
}

/* --------------------------------------------------------- site command center */
function siteStatusBadge(ok, good = 'Healthy', bad = 'Needs attention') {
  return ok === true
    ? `<span class="badge b-green">${good}</span>`
    : ok === false
      ? `<span class="badge b-red">${bad}</span>`
      : '<span class="badge b-gray">Unknown</span>';
}

function siteTaskCount(data) {
  if (!data || typeof data !== 'object') return 0;
  if (Array.isArray(data)) return data.length;
  return Object.entries(data).reduce((n, [key, value]) => {
    if (['summary', 'site', 'ok'].includes(key)) return n;
    return (
      n +
      (Array.isArray(value) ? value.length : typeof value === 'object' ? siteTaskCount(value) : 0)
    );
  }, 0);
}

async function renderSiteDetail() {
  const app = $('#app');
  const site = STATE.siteSlug;
  if (!site) return go('control');
  if (FRESH)
    app.innerHTML = `<div role="status" aria-live="polite"><div class="loading">Opening ${esc(site)} command center…</div></div>`;

  const [fleet, roles, deploy, gatus, errors, tasks, git, actions] = await Promise.all([
    apiOptional('GET', '/api/fleet', { rows: [] }),
    apiOptional('GET', '/api/roles', { sites: [] }),
    apiOptional('GET', '/api/deploy-health', { sites: {} }),
    apiOptional('GET', '/api/gatus', { sites: {} }),
    apiOptional('GET', '/api/errors', { containers: [] }),
    apiOptional('GET', `/api/tasks/${encodeURIComponent(site)}`, {}),
    apiOptional('GET', `/api/git/${encodeURIComponent(site)}`, {}),
    apiOptional('GET', '/api/actions?limit=300', { actions: [] }),
  ]);

  const fleetRow = (fleet.rows || []).find(row => row.site === site) || {};
  const roleSite = (roles.sites || []).find(row => row.site === site) || {};
  const deploySite = deploy.sites?.[site] || {};
  const gatusSite = gatus.sites?.[site] || {};
  const siteErrors = (errors.containers || []).filter(row => row.slug === site);
  const activeErrors = siteErrors.filter(row => Number(row.count24h) > 0);
  const runtimeOk =
    gatusSite.failing == null && !siteErrors.length
      ? null
      : gatusSite.failing === 0 && activeErrors.length === 0;
  const taskCount = siteTaskCount(tasks);
  const roleCells = Object.entries(roleSite.cells || {}).filter(
    ([, cell]) => cell && cell.installed !== false
  );
  const healthyRoles = roleCells.filter(
    ([, cell]) => cell.state === 'fresh' || cell.status === 'fresh'
  ).length;
  const rolePct = roleCells.length ? Math.round((healthyRoles / roleCells.length) * 100) : null;
  const recentActions = (actions.actions || [])
    .filter(action => activitySiteFromPath(action.path) === site)
    .slice(0, 6);
  const actionRows = recentActions.length
    ? recentActions
        .map(
          action =>
            `<tr><td class="mono muted">${esc(fmtAge((Date.now() - Date.parse(action.ts || action.at || 0)) / 1000))} ago</td><td>${esc(action.method || '—')}</td><td class="mono">${esc(action.path || '—')}</td><td>${action.status >= 400 ? '<span class="badge b-red">failed</span>' : '<span class="badge b-green">ok</span>'}</td></tr>`
        )
        .join('')
    : '<tr><td colspan="4" class="muted">No recent mutating actions recorded for this site.</td></tr>';
  const roleRows = roleCells.length
    ? roleCells
        .map(
          ([role, cell]) =>
            `<tr><td class="mono">${esc(role)}</td><td>${siteStatusBadge(cell.state === 'fresh' || cell.status === 'fresh', 'Fresh', cell.state || cell.status || 'Attention')}</td><td class="mono muted">${esc(cell.last_run || cell.last || '—')}</td><td>${cell.enabled === false ? '<span class="badge b-gray">Paused</span>' : '<span class="badge b-blue">Enabled</span>'}</td></tr>`
        )
        .join('')
    : '<tr><td colspan="4" class="muted">No installed roles were reported.</td></tr>';

  app.innerHTML = `
    <div class="page-head site-command-head">
      <div><div class="crumbs"><a class="crumb-link" id="site-back-control">Domain Control</a><span class="crumb-sep">›</span><span class="crumb-cur">${esc(site)}</span></div><h2 class="page-title">${esc(site)}</h2><span class="muted">Site command center · one operational view for health, delivery, work, and audit evidence.</span></div>
      <div class="site-command-actions"><button class="btn" id="site-open-control" type="button">Filter fleet</button><button class="btn primary" id="site-run-engineer" type="button">▶ Run Engineer</button></div>
    </div>
    <section class="site-kpis" aria-label="${esc(site)} summary">
      <div class="site-kpi"><span>Role health</span><strong>${rolePct == null ? '—' : `${rolePct}%`}</strong><small>${healthyRoles}/${roleCells.length || 0} installed roles fresh</small></div>
      <div class="site-kpi"><span>Deploy</span><strong>${esc({ live: 'Live', 'ops-only': 'Live · ops-only', deploying: 'Deploying', behind: 'Site changes pending', failed: 'Build failed', unknown: 'Unknown' }[deploySite.status] || (deploySite.live === true ? 'Live' : deploySite.live === false ? 'Site changes pending' : '—'))}</strong><small>${esc(deploySite.reason || (deploySite.deployedAt ? new Date(deploySite.deployedAt * 1000).toLocaleString() : 'No deploy evidence'))}</small></div>
      <div class="site-kpi"><span>Open work</span><strong>${taskCount}</strong><small>tasks across this site queue</small></div>
      <div class="site-kpi${activeErrors.length ? ' is-risk' : ''}"><span>Errors · 24h</span><strong>${activeErrors.length}</strong><small>${activeErrors.length ? 'Requires investigation' : 'No active container errors'}</small></div>
    </section>
    <section class="site-command-grid">
      <article class="card site-panel"><div class="site-panel-head"><div><h3>Runtime posture</h3><p class="muted">Current evidence from role liveness, deploy health, and synthetic monitoring.</p></div>${siteStatusBadge(runtimeOk, 'Operational', 'Degraded')}</div><dl class="site-facts"><div><dt>Engineer pulse</dt><dd>${esc(fleetRow.pulse || fleetRow.status || 'Unknown')}</dd></div><div><dt>Live check</dt><dd>${gatusSite.failing == null ? 'Unknown' : gatusSite.failing === 0 ? 'Passing' : `${gatusSite.failing} failing`}</dd></div><div><dt>Last ship</dt><dd>${deploySite.deployedAt ? esc(new Date(deploySite.deployedAt * 1000).toLocaleString()) : 'No deploy evidence'}</dd></div><div><dt>Git</dt><dd>${esc(git.branch || git.currentBranch || 'Branch unknown')} · ${git.dirty ? 'uncommitted changes' : 'clean'}</dd></div></dl></article>
      <article class="card site-panel"><div class="site-panel-head"><div><h3>Immediate actions</h3><p class="muted">Safe shortcuts into the existing operational surfaces.</p></div></div><div class="site-action-list"><button class="btn" id="site-open-tasks" type="button">Open task board <span>→</span></button><button class="btn" id="site-open-git" type="button">Inspect Git status <span>→</span></button><button class="btn" id="site-open-errors" type="button">Review errors${activeErrors.length ? ` <span class="badge b-red">${activeErrors.length}</span>` : ''} <span>→</span></button></div></article>
    </section>
    <section class="card site-panel site-wide-panel"><div class="site-panel-head"><div><h3>Installed roles</h3><p class="muted">The role matrix is the source of truth for scheduled ownership on this site.</p></div><span class="muted">${roleCells.length} roles</span></div><div class="table-wrap"><table><thead><tr><th>Role</th><th>Status</th><th>Last run</th><th>Control</th></tr></thead><tbody>${roleRows}</tbody></table></div></section>
    <section class="card site-panel site-wide-panel"><div class="site-panel-head"><div><h3>Recent operator activity</h3><p class="muted">Mutating actions associated with this site.</p></div><a class="btn sm" href="#activity">Open full activity</a></div><div class="table-wrap"><table><thead><tr><th>When</th><th>Method</th><th>Path</th><th>Result</th></tr></thead><tbody>${actionRows}</tbody></table></div></section>`;

  $('#site-back-control').onclick = () => go('control');
  $('#site-open-control').onclick = () => {
    const filter = $('#fleet-filter');
    if (filter) {
      filter.value = site;
      filter.dispatchEvent(new Event('input', { bubbles: true }));
    }
    go('control');
  };
  $('#site-run-engineer').onclick = async button => {
    button.disabled = true;
    try {
      await api('POST', `/api/fleet/${encodeURIComponent(site)}/run`);
      toast(`Engineer triggered on ${site}`);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      button.disabled = false;
    }
  };
  $('#site-open-tasks').onclick = () => go('tasks');
  $('#site-open-git').onclick = () => go('git');
  $('#site-open-errors').onclick = () => go('errors');
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

function enhanceScrollableTables(root) {
  if (!root) return;
  const scrollers = new Map();
  root.querySelectorAll('table').forEach(table => {
    let wrap = table.parentElement;
    while (wrap && wrap !== root) {
      const overflowX = getComputedStyle(wrap).overflowX;
      if (
        (overflowX === 'auto' || overflowX === 'scroll') &&
        wrap.scrollWidth > wrap.clientWidth + 1
      ) {
        scrollers.set(wrap, table);
        break;
      }
      wrap = wrap.parentElement;
    }
  });
  [...scrollers].forEach(([wrap, table], index) => {
    const caption = table.querySelector('caption')?.textContent?.trim();
    const heading = wrap
      .closest('.card, section, article')
      ?.querySelector('h2, h3, h4')
      ?.textContent?.trim();
    const label =
      wrap.getAttribute('aria-label') ||
      caption ||
      heading ||
      `${document.title.replace(/ · Domain Fleet Manager$/, '')} table ${index + 1}`;
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', label);
    const precedes = (hint, node) => Boolean(hint.compareDocumentPosition(node) & 4);
    const panel = wrap.closest('.card, section, article');
    const hintSelector = '[role="note"][class*="scroll-hint"]';
    const hasHint =
      wrap.previousElementSibling?.matches(hintSelector) ||
      [...wrap.querySelectorAll(hintSelector)].some(hint => precedes(hint, table)) ||
      [...(panel?.querySelectorAll(hintSelector) || [])].some(hint => precedes(hint, wrap)) ||
      [...root.children].some(child => child.matches(hintSelector) && precedes(child, wrap));
    if (!hasHint) {
      const hint = document.createElement('div');
      hint.className = 'matrix-scroll-hint';
      hint.setAttribute('role', 'note');
      hint.textContent = 'Swipe horizontally to inspect all columns';
      if (wrap.classList.contains('card')) wrap.prepend(hint);
      else wrap.before(hint);
    }
  });
}

function removeDuplicatePageRefresh(root) {
  if (!root || !document.querySelector('#refresh')) return;
  const mainHead =
    root.querySelector(':scope > .page-head') ||
    root.querySelector('.page-head .page-title')?.closest('.page-head');
  mainHead?.querySelectorAll('button[id$="-refresh"]').forEach(button => {
    const label = button.textContent.trim().replace(/^↻\s*/, '').trim();
    if (label === 'Refresh') button.remove();
  });
}

function render() {
  return Promise.resolve(renderCurrentView()).then(() => {
    const app = $('#app');
    enhanceScrollableTables(app);
    removeDuplicatePageRefresh(app);
  });
}

function renderCurrentView() {
  $('#app')?.setAttribute('aria-busy', 'true');
  $$('.tab[data-view]').forEach(t => t.classList.toggle('active', t.dataset.view === STATE.view));
  const ddBtn = $('#agents-btn');
  if (ddBtn) ddBtn.classList.toggle('active', STATE.view === 'agent');
  document.body.dataset.view = STATE.view; // lets CSS widen specific views
  syncAgentsMenuActive();
  syncNavGroupsActive();
  if (STATE.view === 'control') return renderControl();
  else if (STATE.view === 'priorities') return renderPriorities();
  else if (STATE.view === 'improvements') return renderImprovements();
  else if (STATE.view === 'delivery') return renderActiveDelivery();
  else if (STATE.view === 'workbench') return renderWorkbench();
  else if (STATE.view === 'knowledge') return renderKnowledge();
  else if (STATE.view === 'site') return renderSiteDetail();
  else if (STATE.view === 'executive') return renderExecutive();
  else if (STATE.view === 'agents') return renderCategoryRoot('agents');
  else if (NAV_GROUPS[STATE.view]) return renderCategoryRoot(STATE.view);
  else if (STATE.view === 'cron') return renderCron();
  else if (STATE.view === 'scheduler') return renderScheduler();
  else if (STATE.view === 'agent') return renderAgent(STATE.agent);
  else if (STATE.view === 'containers') return renderContainers();
  else if (STATE.view === 'git')
    return STATE.gitTab === 'hygiene' ? renderGitHygiene() : renderGit();
  else if (STATE.view === 'gitstashes') return renderGitStashes(STATE.gitSlug);
  else if (STATE.view === 'tasks') return renderTasks();
  else if (STATE.view === 'change-queue') return renderChangeQueue();
  else if (STATE.view === 'workflow-board') return renderWorkflowBoard();
  else if (STATE.view === 'taskbudget') return renderTaskBudget();
  else if (STATE.view === 'aiinventory') return renderAIInventory();
  else if (STATE.view === 'aiusage') return renderAIUsage();
  else if (STATE.view === 'aioptimizer') return renderAIOptimizer();
  else if (STATE.view === 'datahub') return renderDataHub();
  else if (STATE.view === 'datahubimages') return renderDataHubImages();
  else if (STATE.view === 'productfeed') return renderProductFeed();
  else if (STATE.view === 'seointelligence') return renderSeoIntelligence();
  else if (STATE.view === 'backlinks') return renderBacklinks();
  else if (STATE.view === 'analytics') return renderAnalytics();
  else if (STATE.view === 'compliance') return renderCompliance();
  else if (STATE.view === 'lint') return renderLint();
  else if (STATE.view === 'deploys') return renderDeployHealth();
  else if (STATE.view === 'builds') return renderCloudflareBuilds();
  else if (STATE.view === 'health') return renderHealth();
  else if (STATE.view === 'errors') return renderErrors();
  else if (STATE.view === 'activity') return renderActivity();
  else if (STATE.view === 'devsandbox') return renderDevSandbox();
  else if (STATE.view === 'dataquality') return renderDataQuality();
  else if (STATE.view === 'sitefacts') return renderSiteFacts();
  else if (STATE.view === 'guides') return renderGuides();
  else if (STATE.view === 'guardrails') return renderGuardrails();
  else if (STATE.view === 'social') return renderSocial();
  else if (STATE.view === 'socialhub') return renderSocialHub();
  else if (STATE.view === 'automation') return renderAutomation();
  else if (STATE.view === 'domains') return renderDomains();
  else if (STATE.view === 'doctor') return renderDoctor();
  else if (STATE.view === 'retention') return renderRetention();
}

// Route renderers are async, but navigation itself is intentionally fire-and-
// forget. Centralize their rejection handling so a slow response from the
// previous route cannot become an unhandled promise (or leave a stale global
// runtime alert) after the operator has already moved on.
function renderRoute() {
  const renderEpoch = ROUTE_EPOCH;
  const pending = render();
  Promise.resolve(pending).catch(error => {
    if (isStaleRouteError(error)) {
      // If navigation came back to the route that was already open, its
      // hashchange does not fire a second time. Retry once for the current
      // epoch so a discarded request cannot leave a permanent loading state.
      if (renderEpoch !== ROUTE_EPOCH && renderRoute.retryEpoch !== ROUTE_EPOCH) {
        renderRoute.retryEpoch = ROUTE_EPOCH;
        queueMicrotask(() => {
          if (renderRoute.retryEpoch === ROUTE_EPOCH) renderRoute();
        });
      }
      return;
    }
    renderViewError($('#app'), error);
  });
  return pending;
}

const NAV_ITEM_DESCRIPTIONS = {
  cron: 'Review schedules and manage fleet cron jobs.',
  containers: 'Inspect runtime health, resource use, and container state.',
  git: 'Review repository status, working-tree changes, and fleet hygiene.',
  tasks: 'Manage the fleet-wide work queue.',
  deploys: 'Compare live Cloudflare deployments with source.',
  builds: 'Track build activity, usage, and failures.',
  domains: 'Onboard, park, and offboard domains.',
  guardrails: 'Manage identity and content protection rules.',
  doctor: 'Check container and image invariants.',
  retention: 'Review data-retention policy across services.',
  guides: 'Manage guide ideas and editorial production.',
  productfeed: 'Review verified products and publishing queues.',
  datahub: 'Explore shared structured content data.',
  datahubimages: 'Manage generated and sourced image assets.',
  sitefacts: 'Audit site facts, trust signals, and product health.',
  seointelligence: 'Turn first-party search evidence into priorities.',
  backlinks: 'Track backlink captures, provenance, and acquisition-domain follow-up.',
  analytics: 'Review traffic and performance across the portfolio.',
  social: 'Manage connected social accounts.',
  socialhub: 'Plan, approve, and monitor social publishing.',
  automation: 'Configure approval policy, schedules, and worker roles.',
  aiusage: 'Track model usage and cost across the fleet.',
  aioptimizer: 'Find opportunities to improve AI cost and routing.',
  aiinventory: 'Audit providers and models used by scheduled services.',
  taskbudget: 'Review task volume and automation budgets.',
  'change-queue':
    'Queue human site changes with explicit AI, budget, priority, and review controls.',
  'workflow-board':
    'Operate the combined fleet backlog, agent queue, approval gates, and delivery flow.',
  delivery:
    'Keep ten meaningful implementation initiatives moving and resolve delivery attention before more reporting.',
  compliance: 'Check the live technical privacy baseline.',
  lint: 'Run fleet-wide parse and formatting checks.',
  health: 'Monitor uptime and service health.',
  errors: 'Inspect recent warnings and errors from fleet services.',
  activity: 'Review the durable operator action trail.',
  devsandbox: 'Open and monitor per-site development sandboxes.',
  dataquality: 'Check freshness, completeness, and attribution contracts.',
};

function renderCategoryRoot(id) {
  const app = $('#app');
  const isAgents = id === 'agents';
  const group = isAgents
    ? { label: 'Agents', description: 'Monitor and operate every automated role across the fleet.' }
    : NAV_GROUPS[id];
  const items = isAgents
    ? [
        [
          'executive',
          'Executive Overview',
          'CEO/CTO/CRO/CFO leadership plus product strategy, approvals, costs, and audit history',
        ],
        ...(STATE.agents || []).map(a => [
          a.role,
          a.label || agentLabel(a.role),
          a.description ||
            (a.sites != null && Number.isFinite(Number(a.sites))
              ? `${Number(a.sites)} site${Number(a.sites) === 1 ? '' : 's'} run this agent`
              : ''),
        ]),
      ]
    : group.items.map(([view, label]) => [
        view,
        label,
        NAV_ITEM_DESCRIPTIONS[view] || `Open ${label}.`,
      ]);
  const cards = items
    .map(
      ([
        key,
        label,
        description,
      ]) => `<button class="nav-root-card" type="button" data-root-target="${esc(key)}">
      <span class="nav-root-icon" aria-hidden="true">${isAgents && typeof globalThis.fleetAgentIcon === 'function' ? globalThis.fleetAgentIcon(key) : typeof globalThis.fleetNavIcon === 'function' ? globalThis.fleetNavIcon(key) : ''}</span>
      <span class="nav-root-card-copy"><strong>${esc(label)}</strong>${description ? `<span>${esc(description)}</span>` : ''}</span>
      <span class="nav-root-arrow" aria-hidden="true">→</span>
    </button>`
    )
    .join('');

  app.innerHTML = `<div class="page-head nav-root-head">
      <div><h2 class="page-title">${esc(group.label)}</h2><span class="muted">${esc(group.description)}</span></div>
      <span class="nav-root-count">${items.length} ${isAgents ? 'roles' : 'tools'}</span>
    </div>
    <section class="nav-root-grid nav-root-${esc(id)}" aria-label="${esc(group.label)} pages">
      ${cards || '<div class="empty">No pages are available in this category.</div>'}
    </section>`;
  $$('.nav-root-card', app).forEach(card =>
    card.addEventListener('click', () => {
      if (isAgents) go('agent', card.dataset.rootTarget);
      else go(card.dataset.rootTarget);
    })
  );
  stamp();
}

function renderAgent(role) {
  if (role === 'executive') return renderExecutive();
  if (role === 'exec-overwatch') return renderExecOverwatch();
  if (role === 'engineer') return renderEngineers();
  if (role === 'product-manager-fleet' || role === 'product-manager-sites')
    return renderProductManager(role);
  return renderGenericAgent(role);
}

async function renderExecOverwatch() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading Exec Overwatch…</div></div>';
  const definition = (STATE.agents || []).find(
    agent => agent.role === 'exec-overwatch' || agent.slug === 'fleet-exec-overwatch'
  );
  if (!definition) {
    renderViewError(app, 'Exec Overwatch is not registered yet.');
    return;
  }
  let data;
  try {
    data = await api(
      'GET',
      `/api/agents/${encodeURIComponent(definition.agent_id || definition.slug)}/overwatch`
    );
  } catch (e) {
    renderViewError(app, `Exec Overwatch failed to load: ${e.message}`);
    return;
  }
  const agent = data.agent || definition;
  const routine = data.routine || {};
  const config = agent.workspace?.overwatch || {};
  const runs = data.runs || [];
  const artifacts = data.artifacts || [];
  const evals = data.evaluations || [];
  const latestArtifact = artifacts[0];
  const synopsis = runs
    .slice(0, 12)
    .map(run => {
      const artifact = artifacts.find(item => item.run_id === run.run_id);
      const delta = artifact?.metadata?.real_work_delta || {};
      const repairs = Number(artifact?.metadata?.repairs || 0);
      const status = run.status === 'succeeded' ? 'completed' : run.status || 'unknown';
      const delivery =
        delta.verified_deliveries > 0 || delta.verified_artifacts > 0
          ? 'verified delivery'
          : delta.new_executable_work_items > 0
            ? 'downstream work queued'
            : 'failed to deliver';
      return `<tr><td class="mono muted">${esc(fmtDate(run.started_at))}</td><td><span class="badge ${status === 'completed' && delivery !== 'failed to deliver' ? 'b-green' : delivery === 'failed to deliver' ? 'b-red' : 'b-yellow'}">${esc(delivery)}</span><div class="muted">${esc(status)}</div></td><td>${esc(repairs)} repair${repairs === 1 ? '' : 's'} · ${esc(delta.new_work_items || 0)} new work · ${esc(delta.new_executable_work_items || 0)} executable · ${esc(delta.new_change_requests || 0)} new requests</td><td class="muted">${esc(run.total_tokens || 0)} tokens · $${Number(run.cost_usd || 0).toFixed(4)}</td></tr>`;
    })
    .join('');
  const goals = Array.isArray(config.goals) ? config.goals.join('\n') : '';
  app.innerHTML = `
    ${breadcrumb('exec-overwatch')}
    <div class="page-head"><div><h2 class="page-title">Exec Overwatch</h2><span class="muted">Independent hourly execution audit, repair, and improvement controller.</span></div><span class="badge ${agent.status === 'active' && routine.status === 'active' ? 'b-green' : 'b-red'}">${agent.status === 'active' && routine.status === 'active' ? 'ON · hourly' : 'OFF'}</span></div>
    <div class="task-toolbar"><strong>${esc(runs.length)} recorded cycles</strong><span class="muted">${esc(evals.length)} evaluations · ${esc(artifacts.length)} reports · next ${esc(fmtDate(routine.next_due_at))}</span><button type="button" class="btn" id="overwatch-refresh">↻ Refresh</button><button type="button" class="btn primary" id="overwatch-run">▶ Run now</button><button type="button" class="btn ${agent.status === 'active' && routine.status === 'active' ? 'danger' : 'primary'}" id="overwatch-toggle">${agent.status === 'active' && routine.status === 'active' ? '⏸ Turn off' : '▶ Turn on'}</button></div>
    <div class="card"><div class="ex-panel-head"><div><div class="ex-eyebrow">OPERATING CONTRACT</div><h3>Crack the whip, with evidence</h3></div><span class="muted">lookback: ${esc(config.lookback_runs || 4)} cycles · mode: ${esc(config.aggression || 'aggressive')}</span></div><p>${esc(config.prompt || '')}</p><div class="muted">A cycle only counts as productive when it creates or completes real downstream work. Repairs and blockers are reported separately.</div></div>
    <div class="card"><div class="ex-panel-head"><div><div class="ex-eyebrow">GOALS</div><h3>What Overwatch is accountable for</h3></div></div><pre class="mono" style="white-space:pre-wrap">${esc(goals)}</pre></div>
    <div class="card"><div class="ex-panel-head"><div><div class="ex-eyebrow">EDIT CONTROL</div><h3>Prompt and goals</h3></div></div><label class="field-label" for="overwatch-prompt">Prompt</label><textarea id="overwatch-prompt" class="cm-input" rows="7">${esc(config.prompt || '')}</textarea><label class="field-label" for="overwatch-goals">Goals, one per line</label><textarea id="overwatch-goals" class="cm-input" rows="5">${esc(goals)}</textarea><div style="margin-top:10px"><button class="btn primary" id="overwatch-save">Save Overwatch settings</button></div></div>
    <div class="card"><div class="ex-panel-head"><div><div class="ex-eyebrow">TURN LOG</div><h3>Hourly synopsis</h3></div><span class="muted">cost and token usage are recorded per run</span></div><div class="agent-table-wrap"><table class="agent-table"><thead><tr><th>When</th><th>Status</th><th>What changed</th><th>Usage</th></tr></thead><tbody>${synopsis || '<tr><td colspan="4" class="empty">No Overwatch cycles recorded yet.</td></tr>'}</tbody></table></div></div>`;
  $('#overwatch-refresh').onclick = () => renderExecOverwatch();
  $('#overwatch-run').onclick = async () => {
    try {
      await api('POST', `/api/agents/${encodeURIComponent(agent.agent_id)}/overwatch/run`, {});
      toast('Exec Overwatch cycle started');
      setTimeout(softRender, 1000);
    } catch (e) {
      toast(`Overwatch run failed: ${e.message}`, 'err');
    }
  };
  $('#overwatch-toggle').onclick = async () => {
    try {
      await api('PATCH', `/api/agents/${encodeURIComponent(agent.agent_id)}/overwatch/settings`, {
        enabled: !(agent.status === 'active' && routine.status === 'active'),
      });
      softRender();
    } catch (e) {
      toast(`Overwatch setting failed: ${e.message}`, 'err');
    }
  };
  $('#overwatch-save').onclick = async () => {
    try {
      await api('PATCH', `/api/agents/${encodeURIComponent(agent.agent_id)}/overwatch/settings`, {
        prompt: $('#overwatch-prompt').value,
        goals: $('#overwatch-goals')
          .value.split('\n')
          .map(x => x.trim())
          .filter(Boolean),
      });
      toast('Overwatch prompt and goals saved');
      softRender();
    } catch (e) {
      toast(`Overwatch save failed: ${e.message}`, 'err');
    }
  };
  wireCrumbs();
  stamp();
}

let EXEC_RUN_LOG_REQUEST = 0;
let EXEC_RUN_LOG_RETURN_FOCUS = null;
const EXEC_RUN_LOG_UI = {
  actionId: null,
  query: '',
  kind: 'important',
  sort: 'newest',
};

function executiveRunDetailContent(runDetail) {
  const source = runDetail?.transcript?.length
    ? runDetail.transcript
    : runDetail?.conversation || [];
  const classify = item => {
    const type = String(item.message_type || 'event');
    if (type === 'model-response') return ['response', 'Response', true];
    if (type === 'model-prompt') return ['prompt', 'Prompt', true];
    if (type === 'background') return ['milestone', 'Milestone', true];
    if (type === 'tool-call' || type === 'tool-result') return ['tool', 'Tool pass-through', false];
    return ['message', 'Message', true];
  };
  const needle = EXEC_RUN_LOG_UI.query.trim().toLowerCase();
  const entries = source
    .map(item => {
      const [category, label, important] = classify(item);
      return { item, category, label, important };
    })
    .filter(
      entry =>
        EXEC_RUN_LOG_UI.kind === 'all' ||
        (EXEC_RUN_LOG_UI.kind === 'important'
          ? entry.important
          : entry.category === EXEC_RUN_LOG_UI.kind)
    )
    .filter(
      entry =>
        !needle ||
        `${entry.label} ${entry.item.actor || ''} ${entry.item.body || ''}`
          .toLowerCase()
          .includes(needle)
    )
    .sort((a, b) => {
      const av = Date.parse(a.item.created_at || '') || 0;
      const bv = Date.parse(b.item.created_at || '') || 0;
      return EXEC_RUN_LOG_UI.sort === 'oldest' ? av - bv : bv - av;
    });
  const transcript = entries
    .map(
      ({ item, category, label }) =>
        `<article class="ex-run-log-entry ex-run-log-${esc(category)}"><div class="ex-transcript-meta"><span class="ex-run-log-label">${esc(label)}</span><b>${esc(executiveActorLabel(item.actor))}</b><span class="muted">${esc(item.message_type || 'event')} · ${esc(fmtDate(item.created_at))}</span></div><details><summary>Show full entry</summary><pre>${esc(item.body || '')}</pre></details></article>`
    )
    .join('');
  const actionItems = (runDetail?.action_items || [])
    .filter(
      item =>
        !needle ||
        `${item.title || ''} ${item.summary || ''} ${item.owner || ''} ${item.next_action || ''}`
          .toLowerCase()
          .includes(needle)
    )
    .sort((a, b) => {
      const av = Date.parse(a.updated_at || a.created_at || '') || 0;
      const bv = Date.parse(b.updated_at || b.created_at || '') || 0;
      return EXEC_RUN_LOG_UI.sort === 'oldest' ? av - bv : bv - av;
    })
    .map(
      item =>
        `<article class="ex-run-action-item"><div><b>${esc(item.title)}</b><span class="badge ${item.status === 'done' ? 'b-green' : 'b-yellow'}">${esc(item.status)}</span></div><p>${esc(item.summary || '')}</p><div class="muted">${esc(item.owner || 'unassigned')}${item.site ? ` · ${esc(item.site)}` : ''} · ${esc(item.run_operation || 'run item')}</div><div><b>Next:</b> ${esc(item.next_action || '—')}</div></article>`
    )
    .join('');
  const audit = (runDetail?.action_log || [])
    .map(
      action =>
        `${action.started_at} · ${action.actor} · ${action.action_type} · ${action.summary}${action.error ? ` · ERROR: ${action.error}` : ''}`
    )
    .join('\n');
  return `<div class="ex-run-drawer-summary"><b>${esc(source.length)} log entries</b><span>·</span><b>${esc(entries.length)} shown</b><span>·</span><b>${esc(runDetail?.action_items?.length || 0)} action items</b></div><div class="ex-run-log-controls"><label class="ex-run-log-search"><span class="sr-only">Search run log</span><input id="ex-run-log-search" class="cm-input" type="search" placeholder="Search messages, actors, tools…" value="${esc(EXEC_RUN_LOG_UI.query)}"></label><select id="ex-run-log-kind" class="cm-input" aria-label="Log entry type"><option value="important" ${EXEC_RUN_LOG_UI.kind === 'important' ? 'selected' : ''}>Important only</option><option value="all" ${EXEC_RUN_LOG_UI.kind === 'all' ? 'selected' : ''}>Everything</option><option value="response" ${EXEC_RUN_LOG_UI.kind === 'response' ? 'selected' : ''}>Responses</option><option value="prompt" ${EXEC_RUN_LOG_UI.kind === 'prompt' ? 'selected' : ''}>Prompts</option><option value="milestone" ${EXEC_RUN_LOG_UI.kind === 'milestone' ? 'selected' : ''}>Milestones</option><option value="tool" ${EXEC_RUN_LOG_UI.kind === 'tool' ? 'selected' : ''}>Tool pass-through</option><option value="message" ${EXEC_RUN_LOG_UI.kind === 'message' ? 'selected' : ''}>Messages</option></select><select id="ex-run-log-sort" class="cm-input" aria-label="Log sort order"><option value="newest" ${EXEC_RUN_LOG_UI.sort === 'newest' ? 'selected' : ''}>Newest first</option><option value="oldest" ${EXEC_RUN_LOG_UI.sort === 'oldest' ? 'selected' : ''}>Oldest first</option></select><button class="btn sm" type="button" id="ex-run-log-reset">Reset</button></div><div class="ex-run-detail-grid"><div><div class="ex-run-section-head"><h4>Conversation and milestones</h4><span class="muted">Tool pass-through is hidden by default</span></div><div class="ex-run-log">${transcript || '<div class="ex-empty">No log entries match these filters.</div>'}</div><details class="ex-run-activity"><summary>Audit actions (${esc(runDetail?.action_log?.length || 0)})</summary><pre>${esc(audit || 'No audit actions recorded.')}</pre></details></div><div><div class="ex-run-section-head"><h4>Action items</h4><span class="muted">${esc((runDetail?.action_items || []).length)} total</span></div><div class="ex-run-action-list">${actionItems || '<div class="ex-empty">No action items match this search.</div>'}</div></div></div>`;
}

function wireExecutiveRunLogFilters(detail, shell) {
  const rerender = () => {
    $('.ex-run-drawer-body', shell).innerHTML = executiveRunDetailContent(detail);
    wireExecutiveRunLogFilters(detail, shell);
  };
  $('#ex-run-log-search', shell)?.addEventListener('input', event => {
    EXEC_RUN_LOG_UI.query = event.target.value;
    rerender();
    const input = $('#ex-run-log-search', shell);
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });
  $('#ex-run-log-kind', shell)?.addEventListener('change', event => {
    EXEC_RUN_LOG_UI.kind = event.target.value;
    rerender();
  });
  $('#ex-run-log-sort', shell)?.addEventListener('change', event => {
    EXEC_RUN_LOG_UI.sort = event.target.value;
    rerender();
  });
  $('#ex-run-log-reset', shell)?.addEventListener('click', () => {
    EXEC_RUN_LOG_UI.query = '';
    EXEC_RUN_LOG_UI.kind = 'important';
    EXEC_RUN_LOG_UI.sort = 'newest';
    rerender();
  });
}

function closeExecutiveRunLog() {
  EXEC_RUN_LOG_REQUEST += 1;
  $('#ex-run-log-drawer')?.remove();
  EXEC_RUN_UI.selected = null;
  EXEC_RUN_LOG_UI.actionId = null;
  const returnFocus = EXEC_RUN_LOG_RETURN_FOCUS;
  EXEC_RUN_LOG_RETURN_FOCUS = null;
  if (returnFocus?.isConnected && !returnFocus.closest('.hidden')) returnFocus.focus();
}

async function openExecutiveRunLog(actionId) {
  const requestId = ++EXEC_RUN_LOG_REQUEST;
  EXEC_RUN_UI.selected = actionId;
  if (EXEC_RUN_LOG_UI.actionId !== actionId) {
    EXEC_RUN_LOG_UI.actionId = actionId;
    EXEC_RUN_LOG_UI.query = '';
    EXEC_RUN_LOG_UI.kind = 'important';
    EXEC_RUN_LOG_UI.sort = 'newest';
  }
  const existing = $('#ex-run-log-drawer');
  if (!existing) {
    const active = document.activeElement;
    EXEC_RUN_LOG_RETURN_FOCUS = active instanceof HTMLElement ? active : null;
  }
  existing?.remove();
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div id="ex-run-log-drawer" class="ex-run-drawer-shell" role="dialog" aria-modal="true" aria-labelledby="ex-run-drawer-title" aria-describedby="ex-run-drawer-status"><div class="ex-run-drawer-backdrop" data-ex-run-log-close></div><aside class="ex-run-drawer"><div class="ex-run-drawer-head"><div><div class="ex-eyebrow">RUN DOSSIER</div><h2 id="ex-run-drawer-title">Loading run log…</h2><p class="muted" id="ex-run-drawer-status" role="status" aria-live="polite">Fetching this run’s retained transcript and actions.</p></div><button id="ex-run-drawer-close" class="icon-btn" type="button" data-ex-run-log-close aria-label="Close run log">×</button></div><div class="ex-run-drawer-toolbar"><button class="btn sm" type="button" id="ex-run-log-refresh">↻ Refresh log</button><span class="muted">This panel stays open during dashboard updates.</span></div><div class="ex-run-drawer-body"><div class="ex-run-drawer-loading" role="status">Loading run log…</div></div></aside></div>`
  );
  const shell = $('#ex-run-log-drawer');
  $$('[data-ex-run-log-close]', shell).forEach(button =>
    button.addEventListener('click', closeExecutiveRunLog)
  );
  $('#ex-run-log-refresh', shell)?.addEventListener('click', () => openExecutiveRunLog(actionId));
  shell.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeExecutiveRunLog();
  });
  requestAnimationFrame(() => {
    if (shell?.isConnected) $('#ex-run-drawer-close', shell)?.focus();
  });
  try {
    const detail = await api('GET', `/api/executive/run/${encodeURIComponent(actionId)}`);
    if (requestId !== EXEC_RUN_LOG_REQUEST || !$('#ex-run-log-drawer')) return;
    const run = detail?.run || {};
    $('#ex-run-drawer-title').textContent =
      `${run.source || (run.target_type === 'manual-executive-run' ? 'manual' : 'scheduled')} run · ${fmtDate(run.started_at)}`;
    $('#ex-run-drawer-status').textContent = 'Retained transcript and action history';
    $('.ex-run-drawer-body', shell).innerHTML = executiveRunDetailContent(detail);
    wireExecutiveRunLogFilters(detail, shell);
  } catch (error) {
    if (requestId !== EXEC_RUN_LOG_REQUEST || !$('#ex-run-log-drawer')) return;
    $('#ex-run-drawer-title').textContent = 'Run log unavailable';
    $('#ex-run-drawer-status').textContent = error.message;
    $('.ex-run-drawer-body', shell).innerHTML =
      `<div class="error-box">${esc(error.message)}</div>`;
  }
}

// In-place refresh of the current view: capture UI state, repaint without the
// loading flash, then restore the viewport after the view finishes. Live ticks
// can arrive faster than slow API responses, so only one redraw is allowed at
// a time; a second tick is coalesced into one follow-up refresh.
function softRender() {
  if (SOFT_RENDER_BUSY) {
    SOFT_RENDER_QUEUED = true;
    return;
  }
  SOFT_RENDER_BUSY = true;
  document.body.classList.add('fd-refreshing');
  $('#updated')?.setAttribute('data-state', 'refreshing');
  $('#refresh')?.setAttribute('aria-busy', 'true');
  document.documentElement.classList.add('fd-soft-refresh');
  UISNAP = captureUI();
  FRESH = false;
  const pending = render();
  Promise.resolve(pending)
    .catch(() => {})
    .then(() => {
      if (!FRESH) {
        // Two frames cover both async view rendering and browser scroll
        // anchoring after a large table changes height.
        requestAnimationFrame(() => {
          if (!FRESH) applyUISnap();
          requestAnimationFrame(() => {
            if (!FRESH) applyUISnap();
            document.documentElement.classList.remove('fd-soft-refresh');
            document.body.classList.remove('fd-refreshing');
            $('#refresh')?.setAttribute('aria-busy', 'false');
            SOFT_RENDER_BUSY = false;
            if (SOFT_RENDER_QUEUED) {
              SOFT_RENDER_QUEUED = false;
              setTimeout(softRender, 0);
            }
          });
        });
      } else {
        document.documentElement.classList.remove('fd-soft-refresh');
        document.body.classList.remove('fd-refreshing');
        $('#refresh')?.setAttribute('aria-busy', 'false');
        SOFT_RENDER_BUSY = false;
        SOFT_RENDER_QUEUED = false;
      }
    });
}

// Shared recovery hook for shell-level error affordances. Keep retrying the
// current route in place so an operator does not lose the active filter,
// navigation context, or URL when a single API read fails.
globalThis.fleetRetryView = () => {
  FRESH = false;
  softRender();
};

function go(view, agent, agentPage) {
  // Route changes must respect the same unsaved-editor guard as modal close
  // buttons. If the operator cancels the discard prompt, keep the current URL,
  // editor, and workspace intact.
  if (!closeModal()) return false;
  STATE.view = view;
  STATE.agent = agent || null;
  STATE.agentPage = agentPage || null;
  if (view === 'git') STATE.gitTab = 'operations';
  const hash = hashFor(view, agent, agentPage);
  ROUTE_EPOCH += 1;
  if (location.hash !== `#${hash}`) location.hash = hash; // shareable + back-button
  FRESH = true;
  renderRoute();
  return true;
}

/* ---- agents dropdown ---- */
function buildAgentsMenu() {
  const menu = $('#agents-menu');
  if (!menu) return;
  menu.innerHTML =
    [['executive', 'Executive Overview', ''], ...(STATE.agents || [])]
      .map(a => {
        const role = a?.[0] || a?.role || '';
        const label = role === 'executive' ? 'Executive Overview' : a?.label || agentLabel(role);
        const siteCount = Array.isArray(a) ? a[2] : (a?.sites ?? a?.site_count ?? a?.sites_count);
        const count =
          role === 'executive'
            ? 'CEO/CTO/CRO/CFO'
            : a?.scope === 'fleet'
              ? 'fleet queue'
              : siteCount != null &&
                  String(siteCount).trim() !== '' &&
                  String(siteCount) !== 'undefined'
                ? String(siteCount)
                : '';
        return `<a class="dd-item" data-role="${esc(role)}">${typeof globalThis.fleetAgentIcon === 'function' ? globalThis.fleetAgentIcon(role) : ''}<span>${esc(label)}</span>${count ? `<span class="dd-count">${esc(count)}</span>` : ''}</a>`;
      })
      .join('') || '<span class="dd-empty">no agents found</span>';
  $$('.dd-item', menu).forEach(it =>
    it.addEventListener('click', () => {
      closeAgentsMenu();
      go('agent', it.dataset.role);
    })
  );
  syncAgentsMenuActive();
}
function syncAgentsMenuActive() {
  const btn = $('#agents-btn');
  if (btn) btn.classList.toggle('active', STATE.view === 'agents' || STATE.view === 'agent');
  $$('#agents-menu .dd-item').forEach(it =>
    it.classList.toggle('active', STATE.view === 'agent' && it.dataset.role === STATE.agent)
  );
}
function toggleAgentsMenu() {
  $('#agents-menu').classList.toggle('hidden');
}
function closeAgentsMenu() {
  const m = $('#agents-menu');
  if (m) m.classList.add('hidden');
}

/* ---- grouped nav dropdowns (Ops/Content/Growth/Quality — mirrors #agents-dd) ---- */
function buildNavGroupMenus() {
  Object.entries(NAV_GROUPS).forEach(([id, g]) => {
    const menu = $(`[data-group-menu="${id}"]`);
    if (!menu) return;
    menu.innerHTML = g.items
      .map(([view, label]) => `<a class="dd-item" data-view="${esc(view)}">${esc(label)}</a>`)
      .join('');
    $$('.dd-item', menu).forEach(it =>
      it.addEventListener('click', () => {
        closeNavGroupMenus();
        go(it.dataset.view);
      })
    );
  });
  syncNavGroupsActive();
}
function syncNavGroupsActive() {
  Object.entries(NAV_GROUPS).forEach(([id, g]) => {
    const inGroup = STATE.view === id || g.items.some(([view]) => view === STATE.view);
    const btn = $(`[data-group-btn="${id}"]`);
    if (btn) btn.classList.toggle('active', inGroup);
    $$(`[data-group-menu="${id}"] .dd-item`).forEach(it =>
      it.classList.toggle('active', it.dataset.view === STATE.view)
    );
  });
}
function closeNavGroupMenus() {
  $$('.nav-group .dd-menu').forEach(m => m.classList.add('hidden'));
}

// Breadcrumb shown atop every agent page.
function breadcrumb(role) {
  const label = role === 'executive' ? 'Executive Overview' : agentLabel(role);
  return `<div class="crumbs"><a class="crumb-link" id="crumb-control">Domain Control</a><span class="crumb-sep">›</span><span class="muted">Agents</span><span class="crumb-sep">›</span><span class="crumb-cur">${esc(label)}</span></div>`;
}
function wireCrumbs() {
  const c = $('#crumb-control');
  if (c) c.addEventListener('click', () => go('control'));
}

/* ---- auto-refresh ---- */
let autoTimer = null,
  countTimer = null,
  nextAt = 0;

function autoCfg() {
  try {
    return {
      on: localStorage.getItem('fd.auto') !== '0', // default ON
      interval: parseInt(localStorage.getItem('fd.interval') || '15000', 10) || 15000,
    };
  } catch {
    return { on: true, interval: 15000 };
  }
}
function applyAutoUI() {
  const { on, interval } = autoCfg();
  const cb = $('#auto-on'),
    sel = $('#auto-int');
  if (cb) cb.checked = on;
  if (sel) sel.value = String(interval);
  document.body.classList.toggle('auto-on', on);
}
function updateCountdown() {
  const next = $('#auto-next');
  if (!next) return;
  if (
    $('#ex-run-log-drawer') ||
    $('.ex-request-detail:not(.ex-empty)') ||
    $('.ex-case-detail') ||
    $('details[open]')
  ) {
    next.textContent = 'paused while reading';
    return;
  }
  if (!autoCfg().on) {
    next.textContent = 'paused';
    return;
  }
  if (SSE_LIVE) {
    next.textContent = '● live';
    return;
  } // pushed by the SSE channel
  const s = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
  next.textContent = `↻ ${s}s`;
}
function scheduleAuto() {
  clearInterval(autoTimer);
  clearInterval(countTimer);
  applyAutoUI();
  if (!autoCfg().on) {
    updateCountdown();
    return;
  }
  // When the SSE channel is live it drives refresh (throttled to the interval),
  // so we don't also run the local poll timer — just the 1s countdown label.
  if (SSE_LIVE) {
    countTimer = setInterval(updateCountdown, 1000);
    updateCountdown();
    return;
  }
  nextAt = Date.now() + autoCfg().interval;
  autoTimer = setInterval(() => {
    nextAt = Date.now() + autoCfg().interval;
    refreshTick();
  }, autoCfg().interval);
  countTimer = setInterval(updateCountdown, 1000);
  updateCountdown();
}
function refreshTick() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  if (document.hidden) return; // tab not visible
  if (!$('#modal').classList.contains('hidden')) return; // editing a task
  const reading =
    $('#ex-run-log-drawer') ||
    $('.ex-request-detail:not(.ex-empty)') ||
    $('.ex-case-detail') ||
    $('details[open]');
  if (reading) return; // never repaint an open reading surface underneath the operator
  const ae = document.activeElement; // mid-typing (e.g. commit msg)
  if (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName)) return;
  softRender();
}

/* ---- live refresh channel (F4) ---- */
let SSE_LIVE = false; // true while the SSE connection is up (drives refresh)
let lastRefresh = 0; // throttle: honour the user's chosen interval even on SSE ticks
function openStream() {
  let es;
  try {
    es = new EventSource('/api/stream');
  } catch {
    return;
  } // no EventSource → keep polling
  es.onopen = () => {
    SSE_LIVE = true;
    scheduleAuto();
  };
  es.onerror = () => {
    if (SSE_LIVE) {
      SSE_LIVE = false;
      scheduleAuto();
    }
  }; // fall back to the poll timer
  es.addEventListener('tick', ev => {
    if (!autoCfg().on) return;
    let v;
    try {
      v = JSON.parse(ev.data).version;
    } catch {
      /* ignore */
    }
    if (v && BOOT_VERSION && v !== BOOT_VERSION) return checkVersion(); // a new build shipped → show the deliberate-update control
    const now = Date.now();
    if (now - lastRefresh < autoCfg().interval) return; // respect the interval
    lastRefresh = now;
    refreshTick();
  });
}

/* ---- dependency preflight banner (F7) ---- */
async function checkDeps() {
  let d;
  try {
    d = await api('GET', '/api/health/deps');
  } catch {
    return;
  }
  const el = $('#deps-banner');
  if (!el) return;
  if (!d || d.ok) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  const bad = Object.entries(d.checks)
    .filter(([, c]) => !c.ok)
    .map(([k, c]) => `${k} — ${c.detail}`);
  el.innerHTML = `<strong>⚠ Degraded</strong> ${bad.map(b => esc(b)).join(' · ')}`;
  el.classList.remove('hidden');
}

/* ---- self-update: detect a new front-end build without interrupting the UI ---- */
let BOOT_VERSION = null;
async function checkVersion() {
  let v;
  try {
    v = (await api('GET', '/api/version')).version;
  } catch {
    return;
  }
  if (!BOOT_VERSION) {
    BOOT_VERSION = v;
    return;
  } // first call: record baseline
  if (v === BOOT_VERSION) return;
  // A new build is being served. Never reload automatically: the fleet
  // manager is a live workspace and a document reload discards the current
  // queue/thread position, expanded rows, focus, and viewport. Data polling
  // continues in place; the operator can use the update pill when it is safe
  // to restart the document deliberately.
  $('#update-pill')?.classList.remove('hidden');
}

async function boot() {
  applyDensityUI();
  // Auth gate (F1): if the server requires a token and we don't have one, show
  // the login overlay and stop — don't render the dashboard behind it.
  const loginForm = $('#login-form');
  if (loginForm) loginForm.addEventListener('submit', submitLogin);
  try {
    const a = await api('GET', '/api/auth');
    applyAccessLevel(a?.access);
    if (a && a.authRequired && !a.authed) {
      showLogin();
      return;
    }
  } catch {
    /* /api/auth is exempt; ignore transient errors */
  }

  // These are independent navigation/bootstrap reads. Fetch them together so
  // a slow registry cannot add its latency on top of a slow site discovery.
  const [sites, agents] = await Promise.all([
    apiOptional('GET', '/api/sites', []),
    apiOptional('GET', '/api/agents', { agents: [] }),
  ]);
  STATE.sites = sites;
  STATE.agents = normalizeAgentList(agents);
  const r = parseHash();
  STATE.view = r.view;
  STATE.agent = r.agent;
  STATE.agentPage = r.agentPage || null;
  STATE.siteSlug = r.siteSlug || null;
  STATE.gitSlug = r.gitSlug || null;
  STATE.gitTab = r.gitTab || 'operations';
  STATE.controlFilter = r.controlFilter || null;
  STATE.controlSort = r.controlSort || null;
  if (r.view === 'socialhub') shApplyRoute(r.socialHub);
  buildAgentsMenu();
  buildNavGroupMenus();
  $$('.tab[data-view]').forEach(t => t.addEventListener('click', () => go(t.dataset.view)));
  $('#agents-btn').addEventListener('click', e => {
    e.stopPropagation();
    closeNavGroupMenus();
    toggleAgentsMenu();
  });
  $$('[data-group-btn]').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      closeAgentsMenu();
      const id = btn.dataset.groupBtn;
      const wasOpen = !$(`[data-group-menu="${id}"]`).classList.contains('hidden');
      closeNavGroupMenus();
      if (!wasOpen) $(`[data-group-menu="${id}"]`).classList.remove('hidden');
    })
  );
  document.addEventListener('click', e => {
    if (!e.target.closest('#agents-dd')) closeAgentsMenu();
    if (!e.target.closest('.nav-group')) closeNavGroupMenus();
  });
  $('#refresh').addEventListener('click', softRender);
  $('#density-toggle').addEventListener('click', toggleDensity);
  $('#theme-toggle')?.addEventListener('click', toggleTheme);
  applyThemeUI();
  watchSystemTheme();
  const ff = $('#fleet-filter');
  if (ff) {
    try {
      ff.value = localStorage.getItem('fd.fleet-filter') || '';
    } catch {}
    CF_BUILDS.filter = ff.value.trim().toLowerCase();
    ff.addEventListener('input', () => {
      try {
        localStorage.setItem('fd.fleet-filter', ff.value);
      } catch {}
      if (STATE.view === 'builds') {
        const query = ff.value.trim().toLowerCase();
        if (query !== CF_BUILDS.filter) {
          CF_BUILDS.filter = query;
          CF_BUILDS.pages = { repos: 1, builds: 1, triggers: 1 };
        }
        clearTimeout(CF_BUILDS.filterTimer);
        CF_BUILDS.filterTimer = setTimeout(() => renderCloudflareBuilds(), 180);
      } else applyFleetFilter();
    });
    ff.addEventListener('keydown', e => {
      if (e.key === 'Escape' && ff.value) {
        e.stopPropagation();
        clearFleetFilter();
      }
    });
    $('#fleet-filter-clear')?.addEventListener('click', clearFleetFilter);
    applyFleetFilter();
  }
  $('#auto-on').addEventListener('change', e => {
    try {
      localStorage.setItem('fd.auto', e.target.checked ? '1' : '0');
    } catch {}
    scheduleAuto();
  });
  $('#auto-int').addEventListener('change', e => {
    try {
      localStorage.setItem('fd.interval', e.target.value);
    } catch {}
    scheduleAuto();
  });
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', e => {
    if (e.target.id === 'modal') closeModal();
  });
  watchModalFormState();
  $('#toast-close')?.addEventListener('click', toast._dismiss);
  $('#update-pill').addEventListener('click', async () => {
    const approved = await globalThis.fleetConfirm?.({
      title: 'Reload dashboard?',
      message:
        'A newer dashboard build is available. Reload now? Unsaved editor content and the current workspace position may be lost.',
      confirmLabel: 'Reload now',
    });
    if (approved === false) return;
    location.reload();
  });
  cmWireModals();
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeModal();
      closeExecutiveRunLog();
      cmCloseLogs();
      cmCloseDiff();
      cmCloseEditorSafely();
      cmCloseAddJobSafely();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      checkVersion();
      refreshTick();
      scheduleAuto();
    }
  });
  checkVersion();
  checkDeps(); // F7: surface missing python3/docker/etc.
  openStream(); // F4: live-refresh channel (falls back to polling)
  setInterval(checkVersion, 60000);
  setInterval(checkDeps, 120000);
  setInterval(logFollowTick, 3000); // live-tail open log surfaces
  window.addEventListener('hashchange', () => {
    const n = parseHash();
    const socialHubChanged = n.view === 'socialhub' && shApplyRoute(n.socialHub);
    if (
      n.view !== STATE.view ||
      n.agent !== STATE.agent ||
      (n.agentPage || null) !== STATE.agentPage ||
      (n.siteSlug || null) !== STATE.siteSlug ||
      (n.gitSlug || null) !== STATE.gitSlug ||
      (n.gitTab || 'operations') !== STATE.gitTab ||
      (n.controlFilter || null) !== STATE.controlFilter ||
      (n.controlSort || null) !== STATE.controlSort ||
      socialHubChanged
    ) {
      ROUTE_EPOCH += 1;
      STATE.view = n.view;
      STATE.agent = n.agent;
      STATE.agentPage = n.agentPage || null;
      STATE.siteSlug = n.siteSlug || null;
      STATE.gitSlug = n.gitSlug || null;
      STATE.gitTab = n.gitTab || 'operations';
      STATE.controlFilter = n.controlFilter || null;
      STATE.controlSort = n.controlSort || null;
      FRESH = true;
      renderRoute();
    }
  });
  FRESH = true;
  renderRoute();
  scheduleAuto();
}

/* ===== GUARDRAILS ===== */
// Identity/content guardrail lists (backs tools/content-guardrails + the
// shared pre-commit hook) + a live audit log of hits. Two tiers: "blocked"
// (hard-fails any commit, no override) and "warn" (only fails if the
// AI context-classifier flags it — e.g. it clears a named historical public
// figure but flags a vague, unattributed "our founder <name>"). Global lists apply fleet-wide; per-repo
// overrides are additive only (a repo can add a term, never remove a global one).
let GR_CONFIG = null;

function grChip(term, onRemove) {
  return `<span class="gr-chip">${esc(term)}<button type="button" class="gr-chip-x" data-term="${esc(term)}" ${onRemove ? `data-action="${esc(onRemove)}"` : ''} aria-label="Remove ${esc(term)}">×</button></span>`;
}

async function renderGuardrails() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading guardrails…</div></div>';
  let cfg, log, sites;
  try {
    [cfg, log, sites] = await Promise.all([
      api('GET', '/api/guardrails/config'),
      api('GET', '/api/guardrails/log?limit=100'),
      api('GET', '/api/sites'),
    ]);
  } catch (e) {
    renderViewError(app, `Guardrails failed to load: ${e.message}`);
    return;
  }
  GR_CONFIG = cfg;

  const globalBlocked =
    (cfg.global.blocked || []).map(t => grChip(t, 'rm-global-blocked')).join(' ') ||
    '<span class="muted">none</span>';
  const globalWarn =
    (cfg.global.warn || []).map(t => grChip(t, 'rm-global-warn')).join(' ') ||
    '<span class="muted">none</span>';

  const repoRows = Object.keys(cfg.overrides || {})
    .sort()
    .map(repo => {
      const ov = cfg.overrides[repo];
      return `<tr>
      <td class="mono">${esc(repo)}</td>
      <td>${(ov.blocked || []).map(t => grChip(t, `rm-repo-blocked|${repo}`)).join(' ') || '<span class="muted">—</span>'}</td>
      <td>${(ov.warn || []).map(t => grChip(t, `rm-repo-warn|${repo}`)).join(' ') || '<span class="muted">—</span>'}</td>
    </tr>`;
    })
    .join('');

  const siteOptions = (sites || [])
    .map(s => `<option value="${esc(s)}">${esc(s)}</option>`)
    .join('');

  const logRows = (log || [])
    .map(r => {
      const badge =
        r.kind === 'blocked'
          ? '<span class="badge b-red">BLOCKED</span>'
          : r.flagged
            ? '<span class="badge b-red">WARN-FLAGGED</span>'
            : '<span class="badge b-yellow">warn-cleared</span>';
      return `<tr>
      <td class="mono muted">${esc(new Date(r.ts).toLocaleString())}</td>
      <td class="mono">${esc(r.repo)}</td>
      <td>${badge}</td>
      <td class="mono">${esc(r.term)}</td>
      <td class="mono muted" title="${esc(r.line || '')}">${esc((r.line || '').slice(0, 90))}</td>
      <td class="muted">${esc(r.reason || '')}</td>
    </tr>`;
    })
    .join('');

  app.innerHTML = `
    <div class="page-head"><div><h2 class="page-title">Guardrails</h2><span class="muted">Identity/content protection — blocked terms hard-fail every commit fleet-wide; warn terms only fail when the context-classifier flags them.</span></div><button type="button" id="guardrails-refresh" class="btn">↻ Refresh</button></div>

    <div class="card gr-panel">
      <h3 class="gr-title">Global — Blocked <span class="muted gr-title-note">(no override, ever)</span></h3>
      <div class="chip-row">${globalBlocked}</div>
      <div class="task-toolbar gr-toolbar">
        <input id="gr-add-global-blocked" class="gr-term-input" aria-label="Add global blocked term" placeholder="add blocked term…">
        <button type="button" class="btn sm" id="gr-add-global-blocked-btn">Add</button>
      </div>
    </div>

    <div class="card gr-panel">
      <h3 class="gr-title">Global — Warn <span class="muted gr-title-note">(context-checked; human can override with HUMAN_ALLOW_WARN=1)</span></h3>
      <div class="chip-row">${globalWarn}</div>
      <div class="task-toolbar gr-toolbar">
        <input id="gr-add-global-warn" class="gr-term-input" aria-label="Add global warning term" placeholder="add warn term…">
        <button type="button" class="btn sm" id="gr-add-global-warn-btn">Add</button>
      </div>
    </div>

    <div class="card gr-panel">
      <h3 class="gr-title">Per-repo overrides <span class="muted gr-title-note">(additive only — adds to the global lists for that repo)</span></h3>
      <div class="matrix-scroll-hint" role="note">Swipe horizontally to inspect repository guardrail overrides</div><div class="table-wrap" tabindex="0" role="region" aria-label="Per-repository guardrail overrides"><table><caption class="sr-only">Per-repository guardrail overrides</caption><thead><tr><th>Repo</th><th>Blocked</th><th>Warn</th></tr></thead>
        <tbody>${repoRows || '<tr><td colspan="3" class="muted">No per-repo overrides yet.</td></tr>'}</tbody></table>
      </div>
      <div class="task-toolbar gr-toolbar">
        <select id="gr-repo-select" aria-label="Repository to override"><option value="">site…</option>${siteOptions}</select>
        <select id="gr-repo-list" aria-label="Guardrail list to edit"><option value="blocked">blocked</option><option value="warn">warn</option></select>
        <input id="gr-repo-term" class="gr-repo-input" aria-label="Add repository guardrail term" placeholder="term…">
        <button type="button" class="btn sm" id="gr-add-repo-btn">Add override</button>
      </div>
    </div>

    <div class="card gr-panel">
      <h3 class="gr-title">Audit log <span class="muted gr-title-note">(last 100 hits — every commit blocked or warn-flagged)</span></h3>
      <div class="matrix-scroll-hint" role="note">Swipe horizontally to inspect guardrail audit details</div><div class="table-wrap" tabindex="0" role="region" aria-label="Guardrail audit log"><table><caption class="sr-only">Guardrail audit log</caption><thead><tr><th>When</th><th>Repo</th><th>Result</th><th>Term</th><th>Line</th><th>Reason</th></tr></thead>
        <tbody>${logRows || '<tr><td colspan="6" class="muted">No guardrail hits recorded yet.</td></tr>'}</tbody></table>
      </div>
    </div>`;

  $('#guardrails-refresh').addEventListener('click', () => renderGuardrails());
  wireGuardrails();
  if (!FRESH) applyUISnap();
  stamp();
}

async function grSaveConfig(next) {
  try {
    await api('PUT', '/api/guardrails/config', next);
    toast('Guardrails updated');
    FRESH = false;
    await renderGuardrails();
  } catch (e) {
    toast('Failed: ' + e.message);
  }
}

function wireGuardrails() {
  $('#gr-add-global-blocked-btn')?.addEventListener('click', () => {
    const el = $('#gr-add-global-blocked');
    const v = el.value.trim();
    if (!v) return;
    const next = structuredClone(GR_CONFIG);
    next.global.blocked = [...new Set([...(next.global.blocked || []), v])];
    grSaveConfig(next);
  });
  $('#gr-add-global-warn-btn')?.addEventListener('click', () => {
    const el = $('#gr-add-global-warn');
    const v = el.value.trim();
    if (!v) return;
    const next = structuredClone(GR_CONFIG);
    next.global.warn = [...new Set([...(next.global.warn || []), v])];
    grSaveConfig(next);
  });
  $('#gr-add-repo-btn')?.addEventListener('click', () => {
    const repo = $('#gr-repo-select').value;
    const list = $('#gr-repo-list').value;
    const v = $('#gr-repo-term').value.trim();
    if (!repo || !v) {
      toast('Pick a site and enter a term');
      return;
    }
    const next = structuredClone(GR_CONFIG);
    next.overrides[repo] = next.overrides[repo] || { blocked: [], warn: [] };
    next.overrides[repo][list] = [...new Set([...(next.overrides[repo][list] || []), v])];
    grSaveConfig(next);
  });
  $$('.gr-chip-x').forEach(btn =>
    btn.addEventListener('click', () => {
      const term = btn.dataset.term;
      const [action, repo] = (btn.dataset.action || '').split('|');
      const next = structuredClone(GR_CONFIG);
      if (action === 'rm-global-blocked')
        next.global.blocked = next.global.blocked.filter(t => t !== term);
      else if (action === 'rm-global-warn')
        next.global.warn = next.global.warn.filter(t => t !== term);
      else if (action === 'rm-repo-blocked')
        next.overrides[repo].blocked = next.overrides[repo].blocked.filter(t => t !== term);
      else if (action === 'rm-repo-warn')
        next.overrides[repo].warn = next.overrides[repo].warn.filter(t => t !== term);
      grSaveConfig(next);
    })
  );
}

boot();

/* ---- AI Optimizer (fleet AI-cost finding queue, tools/ai-optimizer) ----
 * Decide-only board: tickets are filed by the analyst role through the Python
 * CLI (which enforces the evidence bar), and this tab is where a human
 * approves / denies / defers them. There is no "new ticket" button on purpose.
 */
// `optimistic`: job → trigger timestamp, set the instant "Run now" is
// clicked so the button flips to "running" immediately instead of waiting
// for the server to actually grab its flock (a beat — the script has to
// exec into the fleet-cron container first). `pollers`: job → timer handle,
// so a poll loop survives repeated renderAIOptimizer() calls (each render
// rebuilds the DOM, but this object is module-level and outlives that).
const AIOPT = { status: 'proposed', optimistic: {}, pollers: {} };

// Runs are minutes-long `claude -p` sessions, not the few-second HTTP call
// that starts them — poll while this tab is open so "Run now" reflects
// reality instead of reverting to idle after one fixed timeout. Server truth
// (`t.running`, backed by the job's own flock) is what actually ends the
// poll; the optimistic flag only bridges the gap before the script grabs
// that lock.
function aioptStartPoll(job) {
  if (AIOPT.pollers[job]) return; // already polling this job
  const startedAt = Date.now();
  const tick = async () => {
    // Give up well past the job's own 45-minute timeout rather than poll
    // forever if something on the server side wedges.
    if (Date.now() - startedAt > 50 * 60 * 1000) {
      delete AIOPT.pollers[job];
      delete AIOPT.optimistic[job];
      return;
    }
    let running = true;
    try {
      const data = await (STATE.view === 'aioptimizer'
        ? renderAIOptimizer()
        : api('GET', '/api/ai-optimizer'));
      const t = data?.summary?.toggles?.[job] || {};
      if (t.running) delete AIOPT.optimistic[job];
      running = t.running || !!AIOPT.optimistic[job];
    } catch {
      /* transient fetch failure — keep polling, next tick tries again */
    }
    if (running) {
      AIOPT.pollers[job] = setTimeout(tick, 8000);
    } else {
      delete AIOPT.pollers[job];
      if (STATE.view === 'aioptimizer') renderAIOptimizer();
    }
  };
  AIOPT.pollers[job] = setTimeout(tick, 3000);
}

function aioptRiskBadge(risk) {
  const cls = risk === 'high' ? 'b-red' : risk === 'medium' ? 'b-yellow' : 'b-green';
  return `<span class="badge ${cls}">${esc(risk || '—')}</span>`;
}

function aioptScope(t) {
  if (t.scope === 'fleet')
    return '<span class="badge b-blue" title="Applies across the fleet">fleet</span>';
  const sites = t.sites || [];
  if (!sites.length) return '<span class="muted">—</span>';
  const shown = sites
    .slice(0, 3)
    .map(s => siteLink(s))
    .join(', ');
  return shown + (sites.length > 3 ? ` <span class="muted">+${sites.length - 3}</span>` : '');
}

function aioptCard(t) {
  const save = t.estimated_savings_usd_per_day;
  // Every ticket carries the evidence that got it past validation — surfacing
  // it here is the point: a human approving a fix should see the file refs and
  // the git check, not just a dollar number and a claim.
  const evidence = (t.evidence_files || [])
    .map(f => `<code class="mono">${esc(f)}</code>`)
    .join(' ');
  const buttons = (t.allowed_moves || [])
    .map(to => {
      const label =
        { approved: 'Approve', rejected: 'Reject', deferred: 'Defer', applied: 'Mark applied' }[
          to
        ] || to;
      const cls = to === 'approved' ? 'primary' : to === 'rejected' ? 'danger' : '';
      return `<button class="btn sm ${cls}" data-aiopt-move="${esc(t.status)}|${esc(t.file)}|${esc(to)}">${label}</button>`;
    })
    .join(' ');
  return `<div class="card" style="margin-bottom:10px">
    <div class="task-toolbar">
      <strong>${esc(t.title)}</strong>
      ${aioptRiskBadge(t.risk)}
      <span class="muted mono">${esc(t.finding_class || '')}</span>
    </div>
    <div style="padding:0 12px 10px">
      <div style="margin-bottom:6px">
        ${aioptScope(t)}
        ${t.role ? `<span class="badge b-gray mono">${esc(t.role)}</span>` : ''}
        <span class="muted">measured <strong>${fmtUSD(t.measured_cost_usd)}</strong>
          over ${esc(t.window_from || '?')} → ${esc(t.window_to || '?')}</span>
        ${save != null ? `<span class="badge b-green" title="Analyst's estimate">saves ~${fmtUSD(save)}/day</span>` : ''}
      </div>
      <div class="muted" style="margin-bottom:6px">${esc(t.excerpt || '')}</div>
      ${evidence ? `<div style="margin-bottom:4px"><span class="muted">evidence:</span> ${evidence}</div>` : ''}
      ${t.verified_git_check ? `<div class="muted" style="margin-bottom:6px">git check: ${esc(t.verified_git_check)}</div>` : ''}
      ${t.decision_note ? `<div class="muted">note: ${esc(t.decision_note)}</div>` : ''}
      ${t.applied_commit ? `<div class="muted">commit: <code class="mono">${esc(t.applied_commit)}</code></div>` : ''}
      ${buttons ? `<div style="margin-top:8px">${buttons}</div>` : ''}
    </div>
  </div>`;
}

async function renderAIOptimizer() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div role="status" aria-live="polite"><div class="loading">Loading AI-cost findings…</div></div>';
  let data;
  try {
    data = await api('GET', '/api/ai-optimizer');
  } catch (e) {
    renderViewError(app, `AI optimizer queue failed: ${e.message}`);
    return data;
  }
  const s = data.summary || { counts: {} };
  const tickets = data.tickets || {};
  const rows = tickets[AIOPT.status] || [];

  // Kill switches. Worth surfacing here rather than leaving as a `touch` on
  // the host: the moment you want to stop the robot is not the moment you want
  // to go find a terminal.
  const tg = s.toggles || {};
  const toggleRow = Object.entries(tg)
    .map(([job, t]) => {
      const on = t.enabled;
      // Server truth (backed by the job's own flock) OR the optimistic flag
      // set the instant "Run now" is clicked, still within its grace window —
      // see aioptStartPoll.
      const isRunning =
        t.running || (AIOPT.optimistic[job] && Date.now() - AIOPT.optimistic[job] < 10000);
      if (isRunning) aioptStartPoll(job);
      const last =
        t.last_run && t.last_run.at ? `last run ${cmRel(t.last_run.at) || '?'}` : 'never run';
      return `<div style="margin-bottom:8px">
        <strong>${esc(t.label)}</strong>
        <span class="badge ${on ? 'b-green' : 'b-red'}">${on ? 'enabled' : 'PAUSED'}</span>
        ${isRunning ? '<span class="badge b-blue">⏳ running now</span>' : ''}
        <button class="btn sm ${on ? '' : 'danger'}" data-aiopt-toggle="${esc(job)}" data-aiopt-next="${on ? '0' : '1'}">
          ${on ? '⏸ Pause' : '▶ Resume'}
        </button>
        <button class="btn sm" data-aiopt-run="${esc(job)}" ${on && !isRunning ? '' : 'disabled'} title="${isRunning ? 'a run is already in progress' : on ? '' : 'paused'}">
          ${isRunning ? '⏳ running…' : '▶ Run now'}
        </button>
        <span class="muted" title="${esc((t.last_run && t.last_run.tail) || '')}">${esc(last)}</span>
        <span class="muted">· ${esc(t.detail || '')}</span>
      </div>`;
    })
    .join('');

  const pills = ['proposed', 'approved', 'applied', 'deferred', 'rejected']
    .map(st => {
      const n = (s.counts || {})[st] || 0;
      const on = AIOPT.status === st;
      return `<button class="pill ${on ? 'active' : ''}" data-aiopt-status="${st}">${st} (${n})</button>`;
    })
    .join(' ');

  app.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="task-toolbar">
        <strong>Recommendation queue</strong>
        <span class="muted">AI-cost findings filed by the analyst — approve, deny, or let sit</span>
      </div>
      <div style="padding:0 12px 12px">
        <div style="margin-bottom:8px">
          <span class="badge b-yellow">${(s.counts || {}).proposed || 0} awaiting decision</span>
          <span class="badge b-blue">${(s.counts || {}).approved || 0} approved, not yet applied</span>
          <span class="muted">open est. savings <strong>${fmtUSD(s.open_savings_usd_per_day)}/day</strong>
            · approved <strong>${fmtUSD(s.approved_savings_usd_per_day)}/day</strong>
            · realised <strong>${fmtUSD(s.applied_savings_usd_per_day)}/day</strong></span>
        </div>
        <div>${pills}</div>
        <div class="aiopt-toggles" style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border,#333)">
          ${toggleRow}
        </div>
      </div>
    </div>
    ${rows.length ? rows.map(aioptCard).join('') : `<div class="empty">No ${esc(AIOPT.status)} findings.</div>`}
  `;

  $$('[data-aiopt-status]').forEach(b =>
    b.addEventListener('click', () => {
      AIOPT.status = b.dataset.aioptStatus;
      renderAIOptimizer();
    })
  );

  $$('[data-aiopt-run]').forEach(b =>
    b.addEventListener('click', async () => {
      const job = b.dataset.aioptRun;
      if (
        job === 'implement' &&
        !(await globalThis.fleetConfirm?.({
          title: 'Run implementer now',
          message: 'Apply the oldest approved ticket to its canary site and push the result?',
          confirmLabel: 'Run implementer',
        }))
      )
        return;
      b.disabled = true;
      b.textContent = '⏳ started…';
      try {
        await api('POST', `/api/ai-optimizer/run/${encodeURIComponent(job)}`);
        // Detached — the run takes minutes, not seconds. Flip the button to
        // "running" right away and poll until the job's own flock says it's
        // actually done (see aioptStartPoll), instead of a single fixed-delay
        // re-render that reverts to idle while the run is still in flight.
        AIOPT.optimistic[job] = Date.now();
        await renderAIOptimizer();
      } catch (e) {
        toast(`Run failed: ${e.message}`, 'err');
        b.disabled = false;
        b.textContent = '▶ Run now';
      }
    })
  );

  $$('[data-aiopt-toggle]').forEach(b =>
    b.addEventListener('click', async () => {
      const job = b.dataset.aioptToggle;
      const enabled = b.dataset.aioptNext === '1';
      // Pausing is the safe direction, so only confirm on resume-to-apply,
      // where the next tick can start changing code.
      if (
        enabled &&
        job === 'implement' &&
        !(await globalThis.fleetConfirm?.({
          title: 'Resume implementer',
          message:
            'Approved tickets will start being applied on the next scheduled tick (:11/:31/:51).',
          confirmLabel: 'Resume implementer',
        }))
      )
        return;
      b.disabled = true;
      try {
        await api('PUT', `/api/ai-optimizer/toggle/${encodeURIComponent(job)}`, { enabled });
        await renderAIOptimizer();
      } catch (e) {
        toast(`Toggle failed: ${e.message}`, 'err');
        b.disabled = false;
      }
    })
  );

  $$('[data-aiopt-move]').forEach(b =>
    b.addEventListener('click', async () => {
      const [status, file, to] = b.dataset.aioptMove.split('|');
      // A denial is a lasting decision — it permanently suppresses this
      // finding class from being re-filed — so make the reason mandatory.
      let note = '';
      if (to === 'rejected') {
        note = await globalThis.fleetTextPrompt?.({
          title: 'Reject AI finding',
          label: 'Reason for rejection',
          placeholder:
            'This is recorded on the ticket and suppresses this finding from being re-filed.',
          required: true,
          submitLabel: 'Reject finding',
        });
        if (note === null) return;
      } else if (to === 'applied') {
        note =
          (await globalThis.fleetTextPrompt?.({
            title: 'Record applied commit',
            label: 'Commit hash (optional)',
            placeholder: 'abc1234',
            submitLabel: 'Record commit',
          })) || '';
      }
      b.disabled = true;
      try {
        await api(
          'POST',
          `/api/ai-optimizer/${encodeURIComponent(status)}/${encodeURIComponent(file)}/move`,
          {
            to,
            note: to === 'rejected' ? note : undefined,
            commit: to === 'applied' ? note : undefined,
          }
        );
        await renderAIOptimizer();
      } catch (e) {
        toast(`Move failed: ${e.message}`, 'err');
        b.disabled = false;
      }
    })
  );

  return data;
}
