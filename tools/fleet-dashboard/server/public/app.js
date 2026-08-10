'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let STATE = { view: 'control', agent: null, sites: [], agents: [], taskSite: null, gitSlug: null };

function agentLabel(role) { return String(role).split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '); }

// The site dir name is the live domain — link straight to it (new tab).
function siteLink(site) {
  return `<a class="site-link" href="https://${esc(site)}" target="_blank" rel="noopener noreferrer" title="Open https://${esc(site)}">${esc(site)}<span class="ext">↗</span></a>`;
}

// F5: quick-links to the other portfolio tools that operate on this same site —
// site-tracker's per-site detail page (:4742/site/<slug>) and the
// domain-developer sandboxed dev panel (:7777/, no per-site deep link exists
// there today so it just opens the panel root).
function toolLinks(site) {
  const s = encodeURIComponent(site);
  return `<span class="tool-links">` +
    `<a href="http://127.0.0.1:4742/site/${s}" target="_blank" rel="noopener noreferrer" title="Open ${esc(site)} in site-tracker">tracker↗</a>` +
    `<a href="http://127.0.0.1:7777/" target="_blank" rel="noopener noreferrer" title="Open the domain-developer panel">dev↗</a>` +
    `</span>`;
}

// Shared dot-legend chip (used by the Domain Control, Containers, and Deploys
// tally headers) — a colored .rdot swatch (reusing the role-matrix state
// colors: fresh=green, overdue=red, paused=gray) followed by a label.
function dotLegend(st, txt) { return `<span class="rdot r-${st}"></span> ${txt}`; }

// F6: fleet-wide site filter (topbar input). Any row rendered with
// data-fleet-row + data-site="<slug>" is shown/hidden as the operator types.
// Re-applied at the end of every view that opts in, since a re-render replaces
// the DOM (and any hidden state on it).
function applyFleetFilter() {
  const input = $('#fleet-filter');
  const q = ((input && input.value) || '').trim().toLowerCase();
  $$('[data-fleet-row]').forEach((el) => {
    const site = (el.dataset.site || '').toLowerCase();
    el.classList.toggle('fleet-hidden', Boolean(q) && !site.includes(q));
  });
}

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  if (r.status === 401) { showLogin(); throw new Error('authentication required'); }
  const txt = await r.text();
  let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  return data;
}

/* ---- auth gate (F1) ---- */
function showLogin() { const o = $('#login-overlay'); if (o) o.classList.remove('hidden'); const t = $('#login-token'); if (t) t.focus(); }
function hideLogin() { const o = $('#login-overlay'); if (o) o.classList.add('hidden'); }
async function submitLogin(e) {
  e.preventDefault();
  const err = $('#login-err'); if (err) err.textContent = '';
  const token = ($('#login-token') || {}).value || '';
  try {
    await api('POST', '/api/login', { token });   // sets the httpOnly cookie on success
    hideLogin();
    location.reload();                             // re-fetch everything now that we're authed
  } catch (ex) { if (err) err.textContent = ex.message === 'authentication required' ? 'Invalid token' : ex.message; }
}

function toast(msg, kind = 'ok') {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast show ${kind}`;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.className = 'toast'; }, 3200);
}

function stamp() { $('#updated').textContent = 'updated ' + new Date().toLocaleTimeString(); }

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
  const cls = s === 'green' ? 'b-green' : s === 'work' ? 'b-blue' : s === 'issue' ? 'b-red' : 'b-gray';
  return `<span class="badge ${cls}">${esc(s)}</span>`;
}
function ageCell(r) {
  if (r.pulse_age == null) return '<span class="muted">—</span>';
  const s = Math.round(r.pulse_age);
  const txt = s < 90 ? `${s}s` : s < 5400 ? `${Math.floor(s / 60)}m` : s < 172800 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  const stale = r.pulse_age > 35 * 60;
  return `<span class="${stale ? 'flag' : ''}">${txt}${stale ? ' !' : ''}</span>`;
}
function sparkline(series) {
  if (!series || !series.length) return '';
  return `<span class="spark">${series.map((v) => `<i class="${v ? '' : 'bad'}" style="height:${v ? 14 : 6}px"></i>`).join('')}</span>`;
}
// Health timeline: one cell per scheduled 30-min run (last 24h) — 2=ran healthy,
// 1=ran with an issue/cf-down, 0=missed (cron didn't fire).
function healthBar(tl) {
  if (!tl || !tl.length) return '';
  const cls = (c) => c === 2 ? 'h-ok' : c === 1 ? 'h-bad' : 'h-miss';
  return `<span class="hbar">${tl.map((c) => `<i class="${cls(c)}"></i>`).join('')}</span>`;
}
function healthCell(h) {
  if (!h) return '<span class="muted">—</span>';
  const tl = Array.isArray(h.timeline) ? h.timeline : null;
  if (!tl) return `<span class="${h.coverage < 70 ? 'flag' : 'muted'}">${h.coverage}%</span>`;
  const ok = tl.filter((c) => c === 2).length;
  const bad = tl.filter((c) => c === 1).length;
  const miss = tl.filter((c) => c === 0).length;
  const shown = tl.length;
  const pct = shown ? Math.round(100 * ok / shown) : 0;
  const cls = pct >= 90 ? 'muted' : pct >= 70 ? 'warn' : 'flag';
  const tip = `last 24h: ${ok} healthy · ${bad} issue · ${miss} missed (of ${shown} runs) · 3-day coverage ${h.coverage}%`;
  return `<span class="hcell" title="${esc(tip)}">${healthBar(tl)}<span class="${cls} hpct">${pct}%</span></span>`;
}

async function renderEngineers() {
  const app = $('#app');
  if (FRESH) app.innerHTML = '<div class="loading">Loading fleet audit…</div>';
  let rows, hist = [];
  try {
    [rows, hist] = await Promise.all([api('GET', '/api/fleet'), api('GET', '/api/fleet/history?days=3').catch(() => [])]);
  } catch (e) { app.innerHTML = `<div class="empty">Audit failed: ${esc(e.message)}</div>`; return; }
  const histBy = Object.fromEntries(hist.map((h) => [h.site, h]));

  const eng = rows.filter((r) => r.engineer);
  const tiers = {};
  eng.forEach((r) => { tiers[r.tier] = (tiers[r.tier] || 0) + 1; });
  const summary = Object.entries(tiers).map(([k, v]) => `${k}=${v}`).join(' · ');
  const stale = eng.filter((r) => r.pulse_age && r.pulse_age > 35 * 60).map((r) => r.site);

  const body = rows.map((r) => {
    const h = histBy[r.site];
    const cf = r.cf == null ? '<span class="muted">—</span>' : r.cf ? '<span class="badge b-green">ok</span>' : '<span class="badge b-red">DOWN</span>';
    const cron = r.cron ? `<span class="mono">${esc(r.cron)}</span>` : '<span class="muted">—</span>';
    const flags = [...(r.flags || [])];
    if (r.engineer && !r.cron_up) flags.unshift('no-cron-container');
    const flagHtml = flags.length ? `<span class="flag">${esc(flags.join(', '))}</span>` : '';
    const cover = healthCell(h);
    const tasksBtn = `<button class="btn sm tasks-link" data-site="${esc(r.site)}" title="Open ${esc(r.site)}'s task board">📋 Tasks${r.queue ? ` <span class="qn">${r.queue}</span>` : ''}</button>`;
    const runBtn = r.engineer
      ? `<button class="btn sm run-eng" data-site="${esc(r.site)}"${r.cron_up ? '' : ' disabled title="cron container not running"'}>▶ Run</button> `
      : '';
    const actions = r.engineer ? runBtn + tasksBtn : tasksBtn;
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
      <td>${cover}</td>
      <td>${flagHtml}</td>
      <td class="run-cell">${actions}</td>
    </tr>`;
  }).join('');

  // [label, full-name, tooltip] — tooltip shows on hover over the header.
  const COLHELP = [
    ['Site', 'Site', 'Portfolio site (a submodule under sites/). Every row is one site; rows without an engineer show — in most columns.'],
    ['Tier', 'Archetype tier', 'How aligned this engineer is with the current bash archetype. aligned = fully on the current archetype with every feature; PARTIAL = bash runner present but missing a feature; LEGACY = old generic engineer (role.md, no bash runner); none = no engineer installed.'],
    ['Feat', 'Features', 'Which engineer safety features are wired. L = work-lock (serializes the Claude pass so two engineers never run at once), P = liveness-pulse (writes a status pulse every tick), D = daily-summary. Lit = on, · = off.'],
    ['Cron', 'Cron schedule', 'The crontab schedule the engineer runs on (e.g. 12,42 * * * * = :12 and :42 past every hour). — = no cron line found.'],
    ['Pulse', 'Pulse status', 'The engineer\'s self-reported status from its most recent tick. green = healthy and idle, work = it did work this tick, issue = it found a problem, — = no pulse yet.'],
    ['Age', 'Pulse age', 'Time since the last pulse was written (s/m/h/d). ! flag = older than 35 minutes, meaning the engineer may be wedged or its cron container is down.'],
    ['Rnd', 'Render check', 'True-render health check of the live site (Playwright in-container): passes / total checks. e.g. 1/1 = the live page rendered correctly on the last tick.'],
    ['CF', 'Cloudflare', 'Cloudflare deploy/edge status. ok = the Worker is serving the live site; DOWN = the live site did not respond on the last check.'],
    ['Q', 'Queue', 'Number of open tasks assigned to this engineer (assigned_role: engineer) waiting in the task backlog.'],
    ['Health', 'Run health (24h)', 'One square per scheduled 30-min run over the last 24 hours — green = ran healthy, red = ran but reported an issue or Cloudflare was down, gray = the run was missed (the cron did not fire). The % is the healthy share of those runs (green = ≥90%, amber 70–90%, red <70%). Hover the cell for exact counts and the 3-day coverage figure.'],
    ['Flags', 'Flags', 'Audit warnings for this row, e.g. no-cron-container (engineer installed but its cron container is not running) or archetype drift. Empty = no warnings.'],
    ['Actions', 'Actions', '▶ Run fires this engineer immediately — the exact command cron runs (bash ops/scripts/run-worker.sh engineer) inside the site\'s cron container, detached; the work-lock makes a mid-pass click no-op safely, and ▶ Run is disabled when the cron container is down. 📋 Tasks jumps to this site\'s task board (the number is its open engineer-queue count).'],
  ];
  const thead = COLHELP.map(([label, name, tip]) =>
    `<th class="th-help" title="${esc(name)} — ${esc(tip)}">${esc(label)}</th>`).join('');

  app.innerHTML = `
    ${breadcrumb('engineer')}
    <div class="page-head"><h2 class="page-title">Engineer</h2><span class="muted">${eng.length} sites run this agent — live pulse, render, Cloudflare, queue</span></div>
    <div class="task-toolbar">
      <strong>${eng.length} engineers</strong>
      <span class="muted">${esc(summary)}</span>
      ${stale.length ? `<span class="flag">⚠ stale pulse: ${esc(stale.join(', '))}</span>` : ''}
      <button id="fleet-help-toggle" class="btn sm" style="margin-left:auto" title="Show / hide the column key">? Help</button>
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
    <div class="card"><table>
      <thead><tr>${thead}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <p class="muted" style="margin-top:12px">Feat: <b>L</b>=work-lock <b>P</b>=liveness-pulse <b>D</b>=daily-summary · Age <b>!</b> = pulse &gt; 35m (possibly wedged) · Health: <i class="hkey h-ok"></i> healthy <i class="hkey h-bad"></i> issue <i class="hkey h-miss"></i> missed — one per 30-min run, last 24h. <a id="fleet-help-link" class="filter-clear" style="margin-left:0">full column key →</a></p>`;
  const helpBox = $('#fleet-help');
  const toggleHelp = () => helpBox.classList.toggle('hidden');
  $('#fleet-help-toggle').addEventListener('click', toggleHelp);
  $('#fleet-help-link').addEventListener('click', () => { helpBox.classList.remove('hidden'); helpBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
  $$('.run-eng').forEach((b) => b.addEventListener('click', () => runEngineerNow(b.dataset.site, b)));
  $$('.tasks-link').forEach((b) => b.addEventListener('click', () => openSiteTasks(b.dataset.site)));
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

async function runEngineerNow(site, btn) {
  if (btn.disabled) return;
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  try {
    const r = await api('POST', `/api/fleet/${encodeURIComponent(site)}/run`);
    toast(`engineer triggered on ${site} (${r.container})`);
    btn.textContent = '✓ sent';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 5000);
  } catch (e) {
    toast(`run failed: ${e.message}`, 'err');
    btn.textContent = orig; btn.disabled = false;
  }
}

/* ===================== GIT ===================== */
async function renderGit() {
  const app = $('#app');
  if (FRESH) app.innerHTML = '<div class="loading">Scanning repos…</div>';
  let rows;
  try { rows = await api('GET', '/api/git'); }
  catch (e) { app.innerHTML = `<div class="empty">Git scan failed: ${esc(e.message)}</div>`; return; }

  const dirtyCount = rows.filter((r) => r.dirty > 0).length;
  const pushCount = rows.filter((r) => r.needsPush).length;
  const pullCount = rows.filter((r) => r.needsPull).length;

  const body = rows.map((r) => {
    if (!r.isRepo) return `<tr><td class="site">${esc(r.slug)}</td><td colspan="5"><span class="muted">${esc(r.error || 'not a repo')}</span></td></tr>`;
    const dirty = r.dirty > 0 ? `<span class="badge b-yellow">${r.dirty} uncommitted</span>` : '<span class="badge b-green">clean</span>';
    const sync = [];
    if (r.ahead) sync.push(`<span class="badge b-blue">↑${r.ahead}</span>`);
    if (r.behind) sync.push(`<span class="badge b-red">↓${r.behind}</span>`);
    if (!r.ahead && !r.behind) sync.push('<span class="muted">synced</span>');
    const shaCls = { synced: 'b-green', ahead: 'b-yellow', 'diverged-behind': 'b-red', 'no-upstream': 'b-blue' }[r.syncState] || 'b-blue';
    const shaLine = `<span class="badge ${shaCls}" title="local vs remote SHA">${esc(r.localSha || '—')} / ${esc(r.remoteSha || '—')}</span>`;
    const stashBadge = r.stashCount ? ` <a href="#git/${encodeURIComponent(r.slug)}/stashes" class="badge b-blue" title="${r.stashCount} stash(es)">📦 ${r.stashCount}</a>` : '';
    const repoLink = r.remoteWebUrl ? ` <a href="${esc(r.remoteWebUrl)}" target="_blank" rel="noopener" class="rcol-link" title="Open repo on GitHub">↗</a>` : '';
    return `<tr class="git-row" data-slug="${esc(r.slug)}" data-fleet-row data-site="${esc(r.slug)}">
      <td class="site">${esc(r.slug)}${repoLink} <span class="muted">▸</span></td>
      <td class="mono">${esc(r.branch || '—')} ${shaLine}${stashBadge}</td>
      <td>${dirty}</td>
      <td>${sync.join(' ')}</td>
    </tr>
    <tr class="git-detail-row hidden" data-detail="${esc(r.slug)}" data-rk="git:${esc(r.slug)}"><td colspan="4"><div class="git-detail" id="gd-${esc(r.slug)}" data-rkh="git:${esc(r.slug)}"></div></td></tr>`;
  }).join('');

  app.innerHTML = `
    <div class="task-toolbar">
      <strong>${rows.length} repos</strong>
      <span class="muted">${dirtyCount} dirty · ${pushCount} need push · ${pullCount} need pull</span>
      <button class="btn sm" id="pull-all" style="margin-left:auto"${pullCount ? '' : ' disabled title="nothing to pull"'}>⇩ Pull all${pullCount ? ` (${pullCount})` : ''}</button>
      <button class="btn sm" id="push-all"${pushCount ? '' : ' disabled title="nothing to push"'}>⇧ Push all${pushCount ? ` (${pushCount})` : ''}</button>
    </div>
    <div class="card"><table>
      <thead><tr><th>Site</th><th>Branch</th><th>Working tree</th><th>Remote</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;

  $$('.git-row').forEach((tr) => tr.addEventListener('click', (e) => { if (e.target.closest('a')) return; toggleGitDetail(tr.dataset.slug); }));
  const pa = $('#push-all'); if (pa) pa.addEventListener('click', pushAllSites);
  const pua = $('#pull-all'); if (pua) pua.addEventListener('click', pullAllSites);
  if (!FRESH) applyUISnap();
  // applyUISnap re-injects the saved innerHTML of any expanded detail but not its
  // event listeners — re-wire the live ops for every still-open detail panel.
  $$('.git-detail-row:not(.hidden)').forEach((r) => {
    const box = $(`#gd-${CSS.escape(r.dataset.detail)}`);
    if (box && box.querySelector('.gd-files, .gd-push')) wireGitOps(r.dataset.detail, box);
  });
  applyFleetFilter();
  stamp();
}

/* ===================== TASK BUDGET ===================== */
// Writer-role turn-budget audit: static (configured) vs. computed (derived
// from the next backlog task's own estimated_turns) --max-turns per
// site/role, plus dead-role backlog task drift (assigned_role with no
// matching ops/roles/*.md). Delegates to tools/task-budget/turn_budget.py
// audit --json (server/taskbudget.js) — same "shell out to the Python CLI,
// render here" pattern as the Engineers view.
async function renderTaskBudget() {
  const app = $('#app');
  if (FRESH) app.innerHTML = '<div class="loading">Auditing writer-role turn budgets…</div>';
  let sites;
  try { sites = await api('GET', '/api/task-budget'); }
  catch (e) { app.innerHTML = `<div class="empty">Task-budget audit failed: ${esc(e.message)}</div>`; return; }

  let roleRows = 0, driftRows = 0, deadRoleRows = 0;
  const siteBlocks = sites.filter((s) => s.roles.length || s.dead_role_tasks.length).map((s) => {
    const rows = s.roles.map((r) => {
      roleRows++;
      const drift = r.static_max_turns != null && r.computed_max_turns != null
        && Math.abs(r.static_max_turns - r.computed_max_turns) >= 10;
      if (drift) driftRows++;
      const staticBadge = r.static_max_turns != null ? `<span class="badge b-blue">${r.static_max_turns}</span>` : '<span class="muted">—</span>';
      const computedBadge = r.computed_max_turns != null
        ? `<span class="badge ${drift ? 'b-yellow' : 'b-green'}">${r.computed_max_turns}</span>`
        : '<span class="muted">no eligible task</span>';
      const installed = r.role_installed ? '' : ' <span class="badge b-red" title="assigned_role with no matching ops/roles/*.md">dead role</span>';
      const dispatch = r.dispatch === 'wrapper'
        ? `<span class="muted mono" title="${esc(r.wrapper_script || '')}">wrapper</span>`
        : '<span class="muted">run-role.sh</span>';
      return `<tr>
        <td class="mono">${esc(r.role)}${installed}</td>
        <td>${staticBadge}</td>
        <td>${computedBadge}</td>
        <td>${dispatch}</td>
        <td>${r.next_task ? esc(r.next_task) : '<span class="muted">—</span>'}</td>
      </tr>`;
    }).join('');
    const deadTasks = s.dead_role_tasks.map((d) => {
      deadRoleRows++;
      return `<div class="muted">⚠ <span class="mono">${esc(d.file)}</span> → assigned_role: <span class="mono">${esc(d.assigned_role)}</span> (no such role installed — never picked up)</div>`;
    }).join('');
    return `<div class="card" style="margin-bottom:14px">
      <div class="task-toolbar"><strong>${esc(s.site)}</strong></div>
      ${rows ? `<table>
        <thead><tr><th>Role</th><th>Static</th><th>Computed</th><th>Dispatch</th><th>Next task</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : ''}
      ${deadTasks ? `<div style="padding:10px 14px">${deadTasks}</div>` : ''}
    </div>`;
  }).join('');

  app.innerHTML = `
    <div class="task-toolbar">
      <strong>${roleRows} writer/backlog-driven roles</strong>
      <span class="muted">${driftRows} static≫computed drift · ${deadRoleRows} dead-role tasks stuck in backlog</span>
    </div>
    ${siteBlocks || '<div class="empty">No sites with backlog-driven roles found.</div>'}`;
  if (!FRESH) applyUISnap();
  stamp();
}

/* ===================== AI INVENTORY ===================== */
async function renderAIInventory() {
  const app = $('#app');
  if (FRESH) app.innerHTML = '<div class="loading">Tracing scheduled AI dispatches…</div>';
  let data;
  try { data = await api('GET', '/api/ai-inventory'); }
  catch (e) { app.innerHTML = `<div class="empty">AI inventory failed: ${esc(e.message)}</div>`; return; }

  const s = data.summary || {};
  const providerClass = (r) => r.provider === 'None' ? 'b-gray' : r.policy === 'Local' ? 'b-purple' : 'b-blue';
  const status = (r) => r.status === 'DISABLED'
    ? `<span class="badge b-gray" title="${esc(r.disabled_flag || '')}">disabled</span>`
    : '<span class="badge b-green">enabled</span>';
  const rows = (data.rows || []).map((r) => `<tr data-fleet-row data-site="${esc(r.domain)}">
    <td>${siteLink(r.domain)}</td>
    <td class="mono">${esc(r.service)}</td>
    <td><span class="badge ${providerClass(r)}">${esc(r.provider)}</span></td>
    <td class="mono">${esc(r.model)}</td>
    <td>${status(r)}${r.conditional ? ' <span class="badge b-yellow" title="Deterministic preflight; model is not called on every tick">conditional</span>' : ''}</td>
    <td><span class="mono muted" title="${esc(r.source)}">${esc(r.dispatch)}</span></td>
    <td>${esc(r.purpose)}${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}</td>
  </tr>`).join('');

  app.innerHTML = `
    <div class="page-head"><h2 class="page-title">AI Inventory</h2><span class="muted">dispatch-aware provider and model audit of scheduled fleet services</span></div>
    <div class="task-toolbar">
      <strong>${s.ai || 0} AI-backed / ${s.services || 0} scheduled services</strong>
      <span class="muted">${s.remote || 0} remote · ${s.local || 0} local · ${s.conditional || 0} conditional · ${s.disabled || 0} disabled</span>
    </div>
    <div class="card"><table>
      <thead><tr><th>Site</th><th>Service</th><th>Provider</th><th>Model</th><th>Status</th><th>Dispatch</th><th>Function</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="muted" style="margin-top:12px">“Claude CLI default (unpinned)” and aliases such as <span class="mono">sonnet</span>/<span class="mono">haiku</span> can change without a repository change. Conditional services run deterministic gates before spending model tokens. Rows marked no-AI remain visible to make classifier decisions auditable.</p>`;
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

/* ===================== PRODUCT FEED ===================== */
// tools/product-feed — shared, tagged product-candidate queue. Sites push
// sourced+judged candidates in, tagged subscribers claim/publish them one
// at a time. See that tool's README + the product-feed-dev skill.
function pfStatusBadge(status) {
  const cls = status === 'published' ? 'b-green' : status === 'claimed' ? 'b-yellow' : status === 'queued' ? 'b-gray' : 'b-red';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

async function renderProductFeed() {
  const app = $('#app');
  if (FRESH) app.innerHTML = '<div class="loading">Loading product feed…</div>';
  const [health, stats, subs, candidates] = await Promise.all([
    api('GET', '/api/product-feed/health'),
    api('GET', '/api/product-feed/stats'),
    api('GET', '/api/product-feed/subscriptions'),
    api('GET', '/api/product-feed/candidates?limit=30'),
  ]);

  let healthHtml = '';
  if (health.ok === false) {
    healthHtml = `<div class="dh-down">⚠ product-feed API unreachable — ${esc(health.error || 'is the product-feed-api container running? (cd tools/product-feed && docker compose up -d)')}</div>`;
  }

  const subRows = (Array.isArray(subs) ? subs : []).map((s) => {
    const depthLabel = s.error ? `<span class="muted" title="${esc(s.error)}">—</span>`
      : `<span class="mono">${s.depth ?? '—'}${s.max_queue_depth ? ` / ${s.max_queue_depth}` : ''}</span>`;
    const overCap = s.max_queue_depth && s.depth != null && s.depth >= s.max_queue_depth;
    return `<tr data-fleet-row data-site="${esc(s.site)}">
      <td>${siteLink(s.site)}</td>
      <td>${(s.tags_any || []).map((t) => `<span class="badge b-gray">${esc(t)}</span>`).join(' ')}</td>
      <td>${s.site_origin_allow ? esc(s.site_origin_allow.join(', ')) : '<span class="muted">any producer</span>'}</td>
      <td>${depthLabel}${overCap ? ' <span class="badge b-yellow" title="At/above max_queue_depth — sourcing should be backing off">at cap</span>' : ''}</td>
    </tr>`;
  }).join('');

  const statsBySite = (stats && stats.ok !== false) ? stats : {};
  const statsRows = Object.entries(statsBySite).map(([site, byStatus]) => `<tr data-fleet-row data-site="${esc(site)}">
    <td>${siteLink(site)}</td>
    <td class="mono">${byStatus.queued || 0}</td>
    <td class="mono">${byStatus.claimed || 0}</td>
    <td class="mono">${byStatus.published || 0}</td>
    <td class="mono">${byStatus.rejected || 0}</td>
    <td class="mono">${byStatus.failed || 0}</td>
  </tr>`).join('');

  const candidateItems = (candidates && candidates.items) || [];
  const candidateRows = candidateItems.map((c) => `<tr data-fleet-row data-site="${esc(c.site_origin)}">
    <td class="mono">${esc(c.created_at || '').slice(0, 16).replace('T', ' ')}</td>
    <td>${siteLink(c.site_origin)}</td>
    <td>${esc(c.decision?.name || c.candidate?.title || c.asin || '—')}</td>
    <td>${(c.tags || []).map((t) => `<span class="badge b-gray">${esc(t)}</span>`).join(' ')}</td>
    <td>${pfStatusBadge(c.status)}</td>
    <td>${c.claimed_by ? esc(c.claimed_by) : '<span class="muted">—</span>'}</td>
  </tr>`).join('');

  app.innerHTML = `
    <div class="page-head"><h2 class="page-title">Product Feed</h2><span class="muted">tools/product-feed — shared, tagged product-candidate queue (:4761)</span></div>
    ${healthHtml}
    <div class="card">
      <h3>Subscriptions</h3>
      <table>
        <thead><tr><th>Site</th><th>Tags</th><th>Origin allow-list</th><th>Depth (queued+claimed / max)</th></tr></thead>
        <tbody>${subRows || '<tr><td colspan="4" class="muted">No subscriptions registered — see registry/subscriptions.yaml</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card">
      <h3>Stats by site</h3>
      <table>
        <thead><tr><th>Site</th><th>Queued</th><th>Claimed</th><th>Published</th><th>Rejected</th><th>Failed</th></tr></thead>
        <tbody>${statsRows || '<tr><td colspan="6" class="muted">No candidates sourced yet</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card">
      <h3>Recent candidates</h3>
      <table>
        <thead><tr><th>Sourced</th><th>Site</th><th>Name</th><th>Tags</th><th>Status</th><th>Claimed by</th></tr></thead>
        <tbody>${candidateRows || '<tr><td colspan="6" class="muted">Nothing sourced yet</td></tr>'}</tbody>
      </table>
    </div>`;
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
function fmtTokens(n) { return (n || 0).toLocaleString(); }
function fmtUSD(n) { return `$${(n || 0).toFixed(2)}`; }
const AI_USAGE = { range: '7d', granularity: 'day', from: '', to: '', site: '', role: '' };

function utcDay(offset = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}
function aiUsageWindow(range) {
  if (range === 'all') return { from: '', to: '' };
  const days = Number.parseInt(range, 10);
  return { from: utcDay(days - 1), to: utcDay() };
}
function usageTotals(rows) {
  const totals = { calls: 0, errors: 0, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, total_cost_usd: 0 };
  rows.forEach((row) => Object.keys(totals).forEach((key) => { totals[key] += Number(row[key]) || 0; }));
  const cacheDenominator = totals.input_tokens + totals.cache_read_input_tokens;
  totals.cache_hit_ratio = cacheDenominator ? totals.cache_read_input_tokens / cacheDenominator : null;
  return totals;
}
function groupUsage(rows, key) {
  const groups = new Map();
  rows.forEach((row) => {
    const value = row[key];
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  });
  return [...groups.entries()].map(([value, items]) => ({ [key]: value, ...usageTotals(items) }));
}
function usageChart(rows, bucket) {
  if (!rows.length) return '<div class="aiu-chart-empty">No tracked usage for this selection.</div>';
  const width = 760; const height = 190; const left = 44; const bottom = 28; const top = 12;
  const max = Math.max(...rows.map((r) => r.total_cost_usd), 0.01);
  const plotH = height - top - bottom;
  const step = (width - left - 10) / rows.length;
  const barW = Math.max(3, Math.min(28, step * .66));
  const bars = rows.map((r, index) => {
    const h = Math.max(2, (r.total_cost_usd / max) * plotH);
    const x = left + index * step + (step - barW) / 2;
    const y = height - bottom - h;
    const value = r[bucket];
    const label = bucket === 'hour' ? value.slice(11, 16) : value.slice(5);
    const showLabel = rows.length <= (bucket === 'hour' ? 48 : 31) || index === 0 || index === rows.length - 1;
    return `<g><title>${esc(value)}: ${fmtUSD(r.total_cost_usd)} · ${r.calls} calls · ${fmtTokens(r.input_tokens + r.output_tokens)} tokens</title><rect class="aiu-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2"/>${showLabel ? `<text class="aiu-chart-label" x="${(x + barW / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle">${esc(label)}</text>` : ''}</g>`;
  }).join('');
  return `<svg class="aiu-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${bucket === 'hour' ? 'Hourly' : 'Daily'} AI usage cost chart"><line class="aiu-axis" x1="${left}" y1="${height - bottom}" x2="${width - 8}" y2="${height - bottom}"/><text class="aiu-chart-value" x="2" y="${top + 9}">${fmtUSD(max)}</text>${bars}</svg>`;
}

async function renderAIUsage() {
  const app = $('#app');
  if (FRESH) app.innerHTML = '<div class="loading">Aggregating AI token usage…</div>';
  if (AI_USAGE.range !== 'all' && AI_USAGE.range !== 'custom' && !AI_USAGE.from) Object.assign(AI_USAGE, aiUsageWindow(AI_USAGE.range));
  let data;
  const params = new URLSearchParams();
  if (AI_USAGE.from) params.set('from', AI_USAGE.from);
  if (AI_USAGE.to) params.set('to', AI_USAGE.to);
  try { data = await api('GET', `/api/ai-usage${params.size ? `?${params}` : ''}`); }
  catch (e) { app.innerHTML = `<div class="empty">AI usage aggregation failed: ${esc(e.message)}</div>`; return; }

  const rawRoles = data.by_site_role || [];
  const sites = [...new Set(rawRoles.map((r) => r.site))].sort();
  const roles = [...new Set(rawRoles.filter((r) => !AI_USAGE.site || r.site === AI_USAGE.site).map((r) => r.role))].sort();
  if (AI_USAGE.role && !roles.includes(AI_USAGE.role)) AI_USAGE.role = '';
  const activeRows = rawRoles.filter((r) => (!AI_USAGE.site || r.site === AI_USAGE.site) && (!AI_USAGE.role || r.role === AI_USAGE.role));
  const s = usageTotals(activeRows);
  const bucket = AI_USAGE.granularity === 'hour' ? 'hour' : 'day';
  const timedRows = data[bucket === 'hour' ? 'by_hour_site_role' : 'by_day_site_role'] || [];
  const filteredPeriods = groupUsage(timedRows.filter((r) =>
    (!AI_USAGE.site || r.site === AI_USAGE.site) && (!AI_USAGE.role || r.role === AI_USAGE.role)), bucket)
    .sort((a, b) => a[bucket].localeCompare(b[bucket]));
  const siteRows = groupUsage(activeRows, 'site').sort((a, b) => b.total_cost_usd - a.total_cost_usd);
  const roleRows = activeRows.slice().sort((a, b) => b.total_cost_usd - a.total_cost_usd);
  const rawSummary = data.summary || {};
  const runtimeModels = (data.by_model || []).slice().sort((a, b) => b.total_cost_usd - a.total_cost_usd);
  const requestedModels = (data.by_requested_model || []).slice().sort((a, b) => b.total_cost_usd - a.total_cost_usd);
  const usageAlerts = (data.alerts || []).slice(0, 10);
  const wiredAwaiting = rawSummary.sites_wired_awaiting_first_run || [];
  const notWired = rawSummary.sites_not_wired || [];
  const noAiRole = rawSummary.sites_no_ai_role || [];
  const coverageRows = (data.coverage || []).filter((r) => !AI_USAGE.site || r.site === AI_USAGE.site).map((r) => {
    const label = r.status === 'reporting' ? 'reporting' :
      r.status === 'wired_awaiting_first_run' ? 'wired — awaiting first call' :
      r.status === 'not_wired' ? 'untracked call path' : 'no AI call path';
    const badge = r.status === 'reporting' ? 'b-green' :
      r.status === 'not_wired' ? 'b-red' : 'b-gray';
    return `<tr data-fleet-row data-site="${esc(r.site)}"><td>${siteLink(r.site)}</td><td><span class="badge ${badge}">${esc(label)}</span></td></tr>`;
  }).join('');

  const siteTableRows = siteRows.map((r) => `<tr data-fleet-row data-site="${esc(r.site)}">
    <td>${siteLink(r.site)}</td>
    <td>${r.calls}</td>
    <td>${r.errors ? `<span class="badge b-red">${r.errors}</span>` : '<span class="muted">0</span>'}</td>
    <td class="mono">${fmtTokens(r.input_tokens)}</td>
    <td class="mono">${fmtTokens(r.output_tokens)}</td>
    <td class="mono">${fmtTokens(r.cache_read_input_tokens)}</td>
    <td class="mono">${fmtTokens(r.cache_creation_input_tokens)}</td>
    <td class="mono">${r.cache_hit_ratio != null ? `${Math.round(r.cache_hit_ratio * 100)}%` : '<span class="muted">—</span>'}</td>
    <td class="mono">${fmtUSD(r.total_cost_usd)}</td>
  </tr>`).join('');

  const roleTableRows = roleRows.map((r) => `<tr data-fleet-row data-site="${esc(r.site)}">
    <td>${siteLink(r.site)}</td>
    <td class="mono">${esc(r.role)}</td>
    <td>${r.calls}</td>
    <td class="mono">${fmtTokens(r.input_tokens)}</td>
    <td class="mono">${fmtTokens(r.output_tokens)}</td>
    <td class="mono">${fmtUSD(r.total_cost_usd)}</td>
  </tr>`).join('');

  const periodRows = filteredPeriods.map((r) => `<tr>
    <td class="mono">${esc(r[bucket])}</td>
    <td>${r.calls}</td>
    <td class="mono">${fmtTokens(r.input_tokens + r.output_tokens)}</td>
    <td class="mono">${fmtUSD(r.total_cost_usd)}</td>
  </tr>`).join('');
  const runtimeModelRows = runtimeModels.map((r) => `<tr><td>${esc(r.provider)}</td><td class="mono">${esc(r.model)}</td><td>${r.calls}</td><td class="mono">${fmtTokens(r.output_tokens)}</td><td class="mono">${fmtUSD(r.total_cost_usd)}</td></tr>`).join('');
  const requestedModelRows = requestedModels.map((r) => `<tr><td class="mono">${esc(r.requested_model)}</td><td>${r.calls}</td><td class="mono">${fmtUSD(r.total_cost_usd)}</td></tr>`).join('');
  const alertRows = usageAlerts.map((r) => `<tr>
    <td>${siteLink(r.site)}</td>
    <td class="mono">${esc(r.role)}</td>
    <td>${r.is_error ? '<span class="badge b-red">failed</span>' : '<span class="badge b-gray">turn cap</span>'}</td>
    <td class="mono">${r.num_turns || 0}/${r.requested_max_turns || '—'}</td>
    <td class="mono">${fmtUSD(r.total_cost_usd)}</td>
  </tr>`).join('');

  const diagnosticsCount = usageAlerts.length + notWired.length;
  const diagnosticsBadge = diagnosticsCount
    ? `<span class="badge b-red">${diagnosticsCount}</span>`
    : `<span class="badge b-green">clean</span>`;

  app.innerHTML = `
    <div class="page-head"><h2 class="page-title">AI Usage</h2><span class="muted">real token usage/cost captured by tools/scripts/claude-tracked.sh, aggregated fleet-wide</span></div>
    <div class="aiu-controls" aria-label="AI usage filters">
      <div class="aiu-granularity" role="group" aria-label="Usage resolution">
        ${[['hour', 'Hourly'], ['day', 'Daily']].map(([value, label]) => `<button class="btn sm aiu-granularity-btn ${AI_USAGE.granularity === value ? 'active' : ''}" data-granularity="${value}">${label}</button>`).join('')}
      </div>
      <div class="aiu-range" role="group" aria-label="Time frame">
        ${[['7d', '7 days'], ['90d', '90 days'], ['all', 'All time']].map(([value, label]) => `<button class="btn sm aiu-range-btn ${AI_USAGE.range === value ? 'active' : ''}" data-range="${value}">${label}</button>`).join('')}
        <button class="btn sm aiu-range-btn ${AI_USAGE.range === 'custom' ? 'active' : ''}" data-range="custom">Custom</button>
      </div>
      <label>From <input id="aiu-from" type="date" value="${esc(AI_USAGE.from)}" ${AI_USAGE.range === 'custom' ? '' : 'disabled'}></label>
      <label>To <input id="aiu-to" type="date" value="${esc(AI_USAGE.to)}" ${AI_USAGE.range === 'custom' ? '' : 'disabled'}></label>
      ${AI_USAGE.range === 'custom' ? '<button id="aiu-apply-custom" class="btn sm">Apply dates</button>' : ''}
      <label>Site <select id="aiu-site"><option value="">All reporting sites</option>${sites.map((site) => `<option value="${esc(site)}" ${AI_USAGE.site === site ? 'selected' : ''}>${esc(site)}</option>`).join('')}</select></label>
      <label>Role <select id="aiu-role"><option value="">All roles</option>${roles.map((role) => `<option value="${esc(role)}" ${AI_USAGE.role === role ? 'selected' : ''}>${esc(role)}</option>`).join('')}</select></label>
    </div>
    <div class="task-toolbar">
      <strong>${fmtUSD(s.total_cost_usd)} tracked spend</strong>
      <span class="muted">${s.calls || 0} calls · ${fmtTokens(s.input_tokens)} in / ${fmtTokens(s.output_tokens)} out tokens · ${s.cache_hit_ratio != null ? `${Math.round(s.cache_hit_ratio * 100)}% cache hit` : 'no cache data'} · ${rawSummary.sites_instrumented || 0}/${rawSummary.sites_total || 0} sites instrumented</span>
    </div>
    <div class="card aiu-chart-card">
      <div class="task-toolbar"><strong>${bucket === 'hour' ? 'Hourly' : 'Daily'} spend</strong><span class="muted">Hover a bar for cost, calls, and tokens. Times are UTC.</span></div>
      ${usageChart(filteredPeriods, bucket)}
    </div>
    <div class="card" style="margin-bottom:14px">
      <div class="task-toolbar"><strong>Runtime model resolution</strong><span class="muted">Observed model comes from Claude's response; requested model is the caller's flag. Differences expose alias/routing drift.</span></div>
      ${runtimeModelRows ? `<table><thead><tr><th>Provider</th><th>Observed model</th><th>Calls</th><th>Output tok</th><th>Cost</th></tr></thead><tbody>${runtimeModelRows}</tbody></table>` : '<div class="empty">No model records yet.</div>'}
      ${requestedModelRows ? `<div class="task-toolbar" style="margin-top:12px"><strong>Requested models</strong></div><table><thead><tr><th>Requested model</th><th>Calls</th><th>Cost</th></tr></thead><tbody>${requestedModelRows}</tbody></table>` : ''}
    </div>
    <div class="card" style="margin-bottom:14px">
      <div class="task-toolbar"><strong>By site</strong></div>
      ${siteTableRows ? `<table>
        <thead><tr><th>Site</th><th>Calls</th><th>Errors</th><th>Input tok</th><th>Output tok</th><th>Cache read</th><th>Cache write</th><th>Cache hit</th><th>Cost</th></tr></thead>
        <tbody>${siteTableRows}</tbody>
      </table>` : '<div class="empty">No tracked usage yet.</div>'}
    </div>
    <div class="card" style="margin-bottom:14px">
      <div class="task-toolbar"><strong>By site &amp; role</strong></div>
      ${roleTableRows ? `<table>
        <thead><tr><th>Site</th><th>Role</th><th>Calls</th><th>Input tok</th><th>Output tok</th><th>Cost</th></tr></thead>
        <tbody>${roleTableRows}</tbody>
      </table>` : '<div class="empty">No tracked usage yet.</div>'}
    </div>
    <div class="card" style="margin-bottom:14px">
      <div class="task-toolbar"><strong>By ${bucket === 'hour' ? 'hour' : 'day'}</strong></div>
      ${periodRows ? `<table>
        <thead><tr><th>${bucket === 'hour' ? 'Hour (UTC)' : 'Day (UTC)'}</th><th>Calls</th><th>Total tokens</th><th>Cost</th></tr></thead>
        <tbody>${periodRows}</tbody>
      </table>` : `<div class="empty">${bucket === 'hour' ? 'No timestamped usage in this selection.' : 'No tracked usage yet.'}</div>`}
    </div>
    <details class="card aiu-diagnostics">
      <summary><strong>Alerts &amp; coverage</strong> ${diagnosticsBadge} <span class="muted">cost-control alerts, wiring gaps, and which sites are/aren't instrumented</span></summary>
      <div class="aiu-diagnostics-body">
        ${usageAlerts.length ? `
        <div class="task-toolbar" style="margin-top:12px"><strong>Recent cost-control alerts</strong><span class="muted">runs that hit the turn cap or errored — most expensive first, last 10</span></div>
        <table><thead><tr><th>Site</th><th>Role</th><th>Outcome</th><th>Turns</th><th>Cost</th></tr></thead><tbody>${alertRows}</tbody></table>` : ''}
        ${notWired.length ? `<div class="empty" style="margin-top:12px; color: var(--red)">⚠ Has AI cron calls but NOT wired to claude-tracked.sh (${notWired.length}): ${notWired.map(esc).join(', ')}. See <span class="mono">tools/cron-roles/WIRING.md</span> Step 6.5.</div>` : ''}
        ${wiredAwaiting.length ? `<div class="empty" style="margin-top:12px">Wired, awaiting first cron fire (${wiredAwaiting.length}): ${wiredAwaiting.map(esc).join(', ')}.</div>` : ''}
        ${noAiRole.length ? `<div class="empty" style="margin-top:12px">No AI cron role at all — nothing to track (${noAiRole.length}): ${noAiRole.map(esc).join(', ')}.</div>` : ''}
        <div class="task-toolbar" style="margin-top:16px"><strong>Fleet tracking coverage</strong><span class="muted">Every site, including ones with no AI call path.</span></div>
        <table><thead><tr><th>Site</th><th>Tracking status</th></tr></thead><tbody>${coverageRows}</tbody></table>
      </div>
    </details>`;
  $$('.aiu-range-btn').forEach((button) => button.addEventListener('click', () => {
    AI_USAGE.range = button.dataset.range;
    if (AI_USAGE.range !== 'custom') Object.assign(AI_USAGE, aiUsageWindow(AI_USAGE.range));
    renderAIUsage();
  }));
  $$('.aiu-granularity-btn').forEach((button) => button.addEventListener('click', () => {
    AI_USAGE.granularity = button.dataset.granularity;
    renderAIUsage();
  }));
  $('#aiu-site').addEventListener('change', (event) => { AI_USAGE.site = event.target.value; AI_USAGE.role = ''; renderAIUsage(); });
  $('#aiu-role').addEventListener('change', (event) => { AI_USAGE.role = event.target.value; renderAIUsage(); });
  const applyCustom = $('#aiu-apply-custom');
  if (applyCustom) applyCustom.addEventListener('click', () => {
    const from = $('#aiu-from').value; const to = $('#aiu-to').value;
    if (!from || !to || from > to) { toast('Choose a valid start and end date', 'error'); return; }
    AI_USAGE.from = from; AI_USAGE.to = to; renderAIUsage();
  });
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
  if (FRESH) app.innerHTML = '<div class="loading">Loading deploy health…</div>';
  let d;
  try { d = await api('GET', '/api/deploy-health'); }
  catch (e) { app.innerHTML = `<div class="empty">Deploy health failed: ${esc(e.message)}</div>`; return; }

  const sites = Object.values(d.sites || {}).sort((a, b) => a.slug.localeCompare(b.slug));
  const live = sites.filter((s) => s.live === true).length;
  const behind = sites.filter((s) => s.live === false).length;
  const unknown = sites.length - live - behind;

  const body = sites.map((s) => {
    const badge = s.live === true ? '<span class="badge b-green">live</span>'
      : s.live === false ? '<span class="badge b-red">behind</span>'
        : '<span class="badge b-gray">unknown</span>';
    const deployedAt = s.deployedAt ? new Date(s.deployedAt * 1000).toLocaleString() : '—';
    return `<tr data-fleet-row data-site="${esc(s.slug)}">
      <td class="site">${siteLink(s.slug)}</td>
      <td class="mono muted">${esc(s.worker || '—')}</td>
      <td>${badge}</td>
      <td class="mono">${s.version != null ? esc(String(s.version)) : '—'}</td>
      <td class="mono muted">${esc(deployedAt)}</td>
      <td>${s.error ? `<span class="flag">${esc(s.error)}</span>` : ''}</td>
    </tr>`;
  }).join('');

  const swept = d.lastSweep ? fmtAge((Date.now() - d.lastSweep) / 1000) + ' ago' : 'never';
  app.innerHTML = `
    <div class="page-head"><h2 class="page-title">Deploys</h2><span class="muted">Cloudflare deploy health — does the live Worker match the latest commit?</span></div>
    <div class="task-toolbar">
      <strong>${sites.length} sites</strong>
      <span class="muted">${dotLegend('fresh', live + ' live')} · ${dotLegend('overdue', behind + ' behind')} · ${dotLegend('paused', unknown + ' unknown')} · last swept ${esc(swept)}</span>
    </div>
    <div class="card"><table>
      <thead><tr><th>Site</th><th>Worker</th><th>Status</th><th>Version</th><th>Deployed at</th><th>Error</th></tr></thead>
      <tbody>${body || '<tr><td colspan="6" class="muted">No deploy-health data yet — either no CF credentials are configured, or the poller hasn\'t swept yet.</td></tr>'}</tbody>
    </table></div>
    <p class="muted" style="margin-top:12px"><b>live</b> = the newest Worker version was deployed at/after the site's HEAD commit time. <b>behind</b> = pushed but Cloudflare hasn't shipped the latest commit yet (pending build or a failed one). <b>unknown</b> = no CF credentials, or the poller hasn't checked this site yet. Refreshed every 5 minutes in the background.</p>`;
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

async function renderErrors() {
  const app = $('#app');
  if (FRESH) app.innerHTML = '<div class="loading">Loading error scan…</div>';
  let d;
  try { d = await api('GET', '/api/errors'); }
  catch (e) { app.innerHTML = `<div class="empty">Error scan failed: ${esc(e.message)}</div>`; return; }

  const rows = (d.containers || []).slice().sort((a, b) =>
    (b.count1h - a.count1h) || ((b.lastAt || 0) - (a.lastAt || 0)) || a.name.localeCompare(b.name));

  const noisy1h = rows.filter((r) => r.count1h > 0).length;
  const noisy24h = rows.filter((r) => r.count24h > 0).length;
  const crit24h = rows.reduce((n, r) => n + r.crit24h, 0);

  const body = rows.map((r) => {
    const level = r.count24h > 0 ? r.lastLevel : null;
    const when = r.lastAt ? fmtAge((Date.now() - r.lastAt) / 1000) + ' ago' : '—';
    return `<tr class="err-row" data-fleet-row data-site="${esc(r.scope === 'site' ? r.slug : '')}">
      <td class="mono">${esc(r.name)}</td>
      <td>${r.scope === 'site' ? `<span class="site">${esc(r.slug)}</span>` : '<span class="muted">tool</span>'}</td>
      <td>${r.count1h ? `<span class="badge b-red">${r.count1h}</span>` : '<span class="muted">0</span>'}</td>
      <td>${r.count24h ? `<span class="badge ${r.count1h ? 'b-red' : 'b-yellow'}">${r.count24h}</span>` : '<span class="muted">0</span>'}</td>
      <td>${errLevelBadge(level)}</td>
      <td class="mono muted">${esc(when)}</td>
      <td class="mono muted err-snippet" title="${esc(r.lastLine || '')}">${esc((r.lastLine || '—').slice(0, 90))}</td>
      <td><button class="btn sm err-toggle" data-id="${esc(r.id)}">📜 Lines</button></td>
    </tr>
    <tr class="err-detail-row hidden" data-detail="${esc(r.id)}" data-rk="err:${esc(r.id)}"><td colspan="8">
      <div class="cn-log-toolbar muted"><span>matched lines (retained window) · <span class="live-tag">live</span></span></div>
      <pre class="cn-logs-box" id="el-${esc(r.id)}" data-rkh="err:${esc(r.id)}"></pre></td></tr>`;
  }).join('');

  const swept = d.lastSweep ? fmtAge((Date.now() - d.lastSweep) / 1000) + ' ago' : 'never';
  app.innerHTML = `
    <div class="page-head"><h2 class="page-title">Errors</h2><span class="muted">Fleet-wide log scan — error/warn lines tailed from every in-repo container's docker logs.</span></div>
    <div class="task-toolbar">
      <strong>${rows.length} containers scanned</strong>
      <span class="muted">${dotLegend('overdue', noisy1h + ' erroring now')} · ${dotLegend('paused', noisy24h + ' in last 24h')}${crit24h ? ' · ' + dotLegend('overdue', crit24h + ' crit') : ''} · last swept ${esc(swept)}</span>
    </div>
    <div class="card"><table>
      <thead><tr><th>Container</th><th>Site</th><th>1h</th><th>24h</th><th>Level</th><th>Last</th><th>Last line</th><th></th></tr></thead>
      <tbody>${body || '<tr><td colspan="8" class="muted">No containers scanned yet — the poller sweeps every 3 minutes in the background.</td></tr>'}</tbody>
    </table></div>
    <p class="muted" style="margin-top:12px">Classifies lines matching <b>error/exception/traceback/failed/failure</b> (error), <b>panic/fatal/out of memory</b> (crit), or <b>warn(ing)</b> (warn) — a substring/regex match, noisy by design. Tune or add per-container suppression in <code>server/errorscan.js</code> if a site is chatty. Rolling ~26h retention, refreshed every 3 minutes.</p>`;

  wireErrorRows();
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

function wireErrorRows() {
  $$('.err-toggle').forEach((b) => b.addEventListener('click', () => toggleErrorLines(b.dataset.id)));
}

async function toggleErrorLines(id) {
  const row = $(`tr.err-detail-row[data-detail="${CSS.escape(id)}"]`);
  const box = $(`#el-${CSS.escape(id)}`);
  if (!row || !box) return;
  if (!row.classList.contains('hidden')) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  box.textContent = 'loading…';
  await fetchErrorLines(id, box);
}

async function fetchErrorLines(id, box) {
  try {
    const r = await api('GET', `/api/errors/${encodeURIComponent(id)}/lines?limit=500`);
    box.textContent = r.lines.length
      ? r.lines.map((l) => `${new Date(l.tsMs).toISOString()} [${l.level}] ${l.line}`).join('\n')
      : '(no matched lines in the retained window)';
  } catch (e) { box.textContent = `error: ${e.message}`; }
}

/* ===================== ACTIVITY ===================== */
// F14: read-only view over the durable audit trail (GET /api/actions, backed
// by server/actionlog.js) — every mutating dashboard request, newest first.
function activitySiteFromPath(p) {
  const m = String(p || '').match(/^\/api\/(?:roles|git|tasks|fleet|sites|cron\/systems)\/([^/?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
async function renderActivity() {
  const app = $('#app');
  if (FRESH) app.innerHTML = '<div class="loading">Loading action log…</div>';
  let data;
  try { data = await api('GET', '/api/actions?limit=300'); }
  catch (e) { app.innerHTML = `<div class="empty">Action log read failed: ${esc(e.message)}</div>`; return; }

  const rows = data.actions || [];
  const failed = rows.filter((a) => !a.ok).length;

  const body = rows.map((a) => {
    const site = activitySiteFromPath(a.path);
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
  }).join('');

  app.innerHTML = `
    <div class="page-head"><h2 class="page-title">Activity</h2><span class="muted">durable audit trail of every mutating dashboard action — newest first</span></div>
    <div class="task-toolbar">
      <strong>${rows.length} actions</strong>
      <span class="muted">${failed ? `<span class="flag">${failed} failed</span>` : 'all succeeded'}</span>
    </div>
    <div class="card"><table>
      <thead><tr><th>Time</th><th>Actor</th><th>Method</th><th>Path</th><th>Site</th><th>Status</th><th>Duration</th><th>IP</th></tr></thead>
      <tbody>${body || '<tr><td colspan="8" class="muted">No actions recorded yet.</td></tr>'}</tbody>
    </table></div>
    <p class="muted" style="margin-top:12px">Every completed POST/PUT/DELETE to the dashboard's API, including rejected attempts (401/403). <b>Actor</b> is a non-reversible fingerprint of the caller's token/cookie, never the secret itself.</p>`;
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

/* ===================== DEV SANDBOXES ===================== */
// Per-site sandboxed Claude/ttyd dev containers, folded in from the
// standalone domain-developer tool so it stops being a separate URL an
// operator has to remember exists. Backed by server/devsandbox.js.
const DS = { sites: [], dockerAvailable: true, open: new Map() };  // open: site -> 'term'|'dev'|'logs'

function dsStatusBadge(status) {
  if (status === 'running') return '<span class="badge b-green">running</span>';
  if (status === 'absent') return '<span class="badge b-gray">absent</span>';
  return `<span class="badge b-red">${esc(status)}</span>`;
}

async function renderDevSandbox() {
  const app = $('#app');
  if (FRESH) app.innerHTML = '<div class="loading">Loading dev sandboxes…</div>';
  let d;
  try { d = await api('GET', '/api/devsandbox/sites'); }
  catch (e) { app.innerHTML = `<div class="empty">Dev sandbox list failed: ${esc(e.message)}</div>`; return; }
  DS.sites = d.sites || [];
  DS.dockerAvailable = d.dockerAvailable !== false;

  const running = DS.sites.filter((s) => s.status === 'running').length;
  const exists = DS.sites.filter((s) => s.status !== 'absent').length;

  const warn = !DS.dockerAvailable
    ? `<div class="alert" style="margin-bottom:12px">Docker daemon unreachable — every site below shows "absent" because sandbox state can't be queried, not because containers were removed. Start is disabled until Docker is back.</div>`
    : '';

  const body = DS.sites.map((s) => {
    const acts = [];
    if (s.status === 'running') {
      acts.push(`<button class="btn sm ds-open" data-site="${esc(s.name)}" data-tab="term">🖥 Terminal</button>`);
      acts.push(`<button class="btn sm ds-open" data-site="${esc(s.name)}" data-tab="dev">▶ Dev preview</button>`);
      acts.push(`<button class="btn sm ds-open" data-site="${esc(s.name)}" data-tab="logs">📜 Dev logs</button>`);
      acts.push(`<button class="btn sm danger ds-act" data-site="${esc(s.name)}" data-act="stop">⏹ Stop</button>`);
    } else {
      acts.push(`<button class="btn sm primary ds-act" data-site="${esc(s.name)}" data-act="start"${DS.dockerAvailable ? '' : ' disabled'}>▶ Start</button>`);
      if (s.status !== 'absent') acts.push(`<button class="btn sm danger ds-act" data-site="${esc(s.name)}" data-act="remove">🗑 Remove</button>`);
    }
    const openTab = DS.open.get(s.name);
    return `<tr class="cn-row" data-fleet-row data-site="${esc(s.name)}">
      <td class="site">${siteLink(s.name)}</td>
      <td>${dsStatusBadge(s.status)}</td>
      <td class="mono muted">${s.ttydPort ? ':' + s.ttydPort : '—'}</td>
      <td class="mono muted" id="ds-stat-${esc(s.name)}">—</td>
      <td class="cn-actions">${acts.join(' ')}</td>
    </tr>
    <tr class="cn-detail-row${openTab ? '' : ' hidden'}" data-detail="ds:${esc(s.name)}" data-rk="ds:${esc(s.name)}"><td colspan="5">
      <div id="ds-panel-${esc(s.name)}"></div>
    </td></tr>`;
  }).join('');

  app.innerHTML = `
    <div class="page-head"><h2 class="page-title">Dev Sandboxes</h2><span class="muted">per-site sandboxed Claude + ttyd dev containers — folded in from domain-developer</span></div>
    <div class="task-toolbar">
      <strong>${DS.sites.length} sites</strong>
      <span class="muted">${dotLegend('fresh', running + ' running')} · ${dotLegend('paused', (exists - running) + ' stopped')}</span>
      <span class="cm-spacer"></span>
      <button class="btn sm" id="ds-stats">📊 Stats</button>
      <button class="btn sm" id="ds-stop-all">⏹ Stop all</button>
      <button class="btn sm" id="ds-remove-stopped">🧹 Remove stopped</button>
      <button class="btn sm" id="ds-clean-orphans">🗑 Clean orphans</button>
    </div>
    ${warn}
    <div class="card"><table>
      <thead><tr><th>Site</th><th>Status</th><th>ttyd</th><th>CPU · Mem · PIDs</th><th>Actions</th></tr></thead>
      <tbody>${body || '<tr><td colspan="5" class="muted">No sites found.</td></tr>'}</tbody>
    </table></div>
    <p class="muted" style="margin-top:12px">Each sandbox bind-mounts ONLY that site's directory — the rest of the fleet stays protected. Memory/CPU/PIDs are capped per container. Unauthenticated worker containers still run with <code>--dangerously-skip-permissions</code> inside their own sandbox; this tab itself is behind the same token gate as the rest of the dashboard.</p>`;

  wireDevSandboxRows();
  for (const [site, tab] of DS.open) dsRenderPanel(site, tab);
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

function reloadDevSandbox() { FRESH = false; UISNAP = captureUI(); return renderDevSandbox(); }

function wireDevSandboxRows() {
  $$('.ds-act').forEach((b) => b.addEventListener('click', () => dsAction(b.dataset.site, b.dataset.act, b)));
  $$('.ds-open').forEach((b) => b.addEventListener('click', () => dsToggleTab(b.dataset.site, b.dataset.tab)));
  $('#ds-stats')?.addEventListener('click', dsShowStats);
  $('#ds-stop-all')?.addEventListener('click', dsStopAll);
  $('#ds-remove-stopped')?.addEventListener('click', dsRemoveStopped);
  $('#ds-clean-orphans')?.addEventListener('click', dsCleanOrphans);
}

async function dsAction(site, act, btn) {
  if (act === 'remove' && !confirm(`Remove the dev sandbox for ${site}? (site code untouched, claude state kept)`)) return;
  gdBusy(btn, true);
  try {
    await api('POST', `/api/devsandbox/${encodeURIComponent(site)}/${act}`);
    toast(`${act === 'start' ? 'Started' : act === 'stop' ? 'Stopped' : 'Removed'} ${site} sandbox`);
    await reloadDevSandbox();
  } catch (e) { toast(`${act} failed: ${e.message}`, 'err'); gdBusy(btn, false); }
}

function dsToggleTab(site, tab) {
  const row = $(`tr[data-detail="ds:${CSS.escape(site)}"]`);
  if (DS.open.get(site) === tab) { DS.open.delete(site); row.classList.add('hidden'); return; }
  DS.open.set(site, tab);
  row.classList.remove('hidden');
  dsRenderPanel(site, tab);
}

function dsRenderPanel(site, tab) {
  const s = DS.sites.find((x) => x.name === site);
  const el = $(`#ds-panel-${CSS.escape(site)}`);
  if (!el || !s) return;
  if (tab === 'term') {
    if (!s.ttydUrl) { el.innerHTML = '<div class="empty">Terminal not available — sandbox is not running.</div>'; return; }
    el.innerHTML = `<iframe class="ds-frame" src="${esc(s.ttydUrl)}" allow="clipboard-read; clipboard-write"></iframe>`;
  } else if (tab === 'dev') {
    if (!s.devUrl) { el.innerHTML = '<div class="empty">Dev preview not available — sandbox is not running.</div>'; return; }
    el.innerHTML = `
      <div class="cn-log-toolbar muted">
        <span>expects <code>npm run dev</code> on port 4321 in the container</span>
        <span class="cm-spacer"></span>
        <a href="${esc(s.devUrl)}" target="_blank" rel="noopener">↗ ${esc(s.devUrl)}</a>
      </div>
      <iframe class="ds-frame" src="${esc(s.devUrl)}"></iframe>`;
  } else if (tab === 'logs') {
    el.innerHTML = `<pre class="cn-logs-box" id="ds-logs-${esc(site)}">loading…</pre>`;
    dsFetchDevLogs(site);
  }
}

async function dsFetchDevLogs(site) {
  const box = $(`#ds-logs-${CSS.escape(site)}`);
  if (!box) return;
  try {
    const r = await fetch(`/api/devsandbox/${encodeURIComponent(site)}/dev/logs?n=400`);
    box.textContent = await r.text();
  } catch (e) { box.textContent = `error: ${e.message}`; }
}

async function dsShowStats() {
  let r;
  try { r = await api('GET', '/api/devsandbox/stats'); }
  catch (e) { toast(`stats failed: ${e.message}`, 'err'); return; }
  for (const c of r.containers || []) {
    const el = $(`#ds-stat-${CSS.escape(c.site)}`);
    if (el) el.textContent = `${c.cpu} · ${c.mem} · ${c.pids}p`;
  }
  if (!r.containers || !r.containers.length) toast('No running sandboxes');
}

async function dsStopAll() {
  if (!confirm('Stop every running dev sandbox?')) return;
  try {
    const r = await api('POST', '/api/devsandbox/stop-all');
    if (r.errors && r.errors.length) toast(`Some sites failed to stop: ${r.errors.map((e) => e.site).join(', ')}`, 'err');
    else toast(`Stopped ${r.stopped.length} sandbox(es)`);
    await reloadDevSandbox();
  } catch (e) { toast(`stop-all failed: ${e.message}`, 'err'); }
}

async function dsRemoveStopped() {
  if (!confirm('Remove every non-running dev sandbox container? (site code and claude state are untouched)')) return;
  try {
    const r = await api('POST', '/api/devsandbox/remove-stopped');
    if (r.errors && r.errors.length) toast(`Some containers failed to remove: ${r.errors.map((e) => e.site).join(', ')}`, 'err');
    else toast(`Removed ${r.removed.length} container(s)`);
    await reloadDevSandbox();
  } catch (e) { toast(`remove-stopped failed: ${e.message}`, 'err'); }
}

async function dsCleanOrphans() {
  let o;
  try { o = await api('GET', '/api/devsandbox/orphans'); }
  catch (e) { toast(`orphan check failed: ${e.message}`, 'err'); return; }
  if (!o.stalePorts.length && !o.danglingContainers.length) { toast('No orphans found'); return; }
  const msg = [
    o.danglingContainers.length ? `Remove ${o.danglingContainers.length} dangling container(s): ${o.danglingContainers.join(', ')}` : null,
    o.stalePorts.length ? `Prune ${o.stalePorts.length} stale port allocation(s): ${o.stalePorts.join(', ')}` : null,
  ].filter(Boolean).join('\n');
  if (!confirm(msg + '\n\nProceed?')) return;
  try {
    const r = await api('POST', '/api/devsandbox/orphans/cleanup');
    if (r.errors && r.errors.length) toast(`Some cleanup steps failed: ${r.errors.map((e) => e.site).join(', ')}`, 'err');
    else toast('Orphans cleaned up');
    await reloadDevSandbox();
  } catch (e) { toast(`cleanup failed: ${e.message}`, 'err'); }
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
  if (FRESH) app.innerHTML = '<div class="loading">Loading site facts…</div>';
  let d;
  try { d = await api('GET', '/api/sitefacts'); }
  catch (e) { app.innerHTML = `<div class="empty">Site facts failed: ${esc(e.message)}</div>`; return; }

  const swept = d.lastSweep ? fmtAge((Date.now() - d.lastSweep) / 1000) + ' ago' : 'never (first sweep is still running — hourly checks, give it a minute)';

  const body = d.rows.map((row) => {
    const cells = d.families.map((fam) => `<td><span class="rdot ${sfCellClass(row.cells[fam])}" title="${esc(fam)}: ${esc(row.cells[fam])}"></span></td>`).join('');
    const open = SF.open.has(row.site);
    return `<tr data-fleet-row data-site="${esc(row.site)}">
      <td class="site"><a href="#" class="sf-open" data-site="${esc(row.site)}">${esc(row.site)}</a></td>
      ${cells}
    </tr>
    <tr class="cn-detail-row${open ? '' : ' hidden'}" data-detail="sf:${esc(row.site)}" data-rk="sf:${esc(row.site)}"><td colspan="${d.families.length + 1}">
      <div id="sf-panel-${esc(row.site)}"></div>
    </td></tr>`;
  }).join('');

  app.innerHTML = `
    <div class="page-head"><h2 class="page-title">Site Facts</h2><span class="muted">SEO/trust/branding/ads/legal presence checks + Amazon ASIN health — swept hourly, ${d.rows.length} sites</span></div>
    <div class="task-toolbar"><span class="muted">last swept ${esc(swept)}</span></div>
    <div class="card"><table class="sf-table">
      <thead><tr><th>Site</th>${d.families.map((f) => `<th>${esc(f)}</th>`).join('')}</tr></thead>
      <tbody>${body || '<tr><td colspan="99" class="muted">No sites found.</td></tr>'}</tbody>
    </table></div>
    <p class="muted" style="margin-top:12px">Click a site name for the fact-by-fact breakdown, Amazon ASIN health, and manual annotations. Green = present, gray dot = not yet checked, amber-ish = missing (never a hard "red" — these are presence checks, not outages).</p>`;

  $$('.sf-open').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); sfToggle(a.dataset.site); }));
  for (const site of SF.open) sfRenderPanel(site);
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

function reloadSiteFacts() { FRESH = false; UISNAP = captureUI(); return renderSiteFacts(); }

function sfToggle(site) {
  const row = $(`tr[data-detail="sf:${CSS.escape(site)}"]`);
  if (SF.open.has(site)) { SF.open.delete(site); row.classList.add('hidden'); return; }
  SF.open.add(site);
  row.classList.remove('hidden');
  sfRenderPanel(site);
}

async function sfRenderPanel(site) {
  const el = $(`#sf-panel-${CSS.escape(site)}`);
  if (!el) return;
  el.innerHTML = '<span class="muted">loading…</span>';
  let d;
  try { d = await api('GET', `/api/sitefacts/${encodeURIComponent(site)}`); }
  catch (e) { el.innerHTML = `<span class="muted">failed: ${esc(e.message)}</span>`; return; }

  const factRows = d.rows.map((r) => `<tr>
    <td class="mono muted">${esc(r.key)}</td>
    <td>${esc(r.describe)}</td>
    <td>${r.value === true ? '<span class="badge b-green">yes</span>' : r.value === false ? '<span class="badge b-red">no</span>' : '<span class="badge b-gray">unknown</span>'}</td>
  </tr>`).join('');

  const tlsRow = d.tlsExpiryDays != null
    ? `<span class="${d.tlsExpiryDays < 7 ? 'flag' : d.tlsExpiryDays < 30 ? 'warn' : ''}">${d.tlsExpiryDays}d</span>`
    : '<span class="muted">unknown</span>';

  const amz = d.amz || {};
  const amzLine = amz.asin_count != null
    ? `${amz.asin_count} ASINs · ${amz.oos_count ?? 0} OOS · ${amz.delisted_count ?? 0} delisted · last scan ${esc(amz.last_scan || '—')}`
    : '<span class="muted">no amz-stats data for this site</span>';

  const manualRows = Object.entries(d.manual || {}).map(([k, v]) => `<tr>
    <td class="mono muted">${esc(k)}</td>
    <td id="sf-manual-${esc(site)}-${esc(k)}">${esc(v.value)}</td>
    <td class="mono muted">${esc(v.setAt || '—')}</td>
    <td><button class="btn sm danger sf-manual-del" data-site="${esc(site)}" data-key="${esc(k)}">delete</button></td>
  </tr>`).join('');

  el.innerHTML = `
    <div class="cn-log-toolbar muted"><span>checked ${d.checkedAt ? fmtAge((Date.now() - d.checkedAt) / 1000) + ' ago' : 'never yet'} · TLS expiry: ${tlsRow}</span></div>
    <table class="sf-detail-table"><tbody>${factRows}</tbody></table>
    <div class="section-title" style="margin-top:12px">Amazon affiliate health</div>
    <p class="muted">${amzLine}</p>
    <div class="section-title" style="margin-top:12px">Manual annotations</div>
    <table class="sf-detail-table"><tbody>${manualRows || '<tr><td colspan="4" class="muted">none yet</td></tr>'}</tbody></table>
    <form class="sf-manual-form" data-site="${esc(site)}" style="margin-top:8px;display:flex;gap:6px">
      <input type="text" class="cm-input sf-manual-key" placeholder="key (e.g. adsense_status)" pattern="[-a-zA-Z0-9._]+" required />
      <input type="text" class="cm-input sf-manual-value" placeholder="value" maxlength="500" required />
      <button type="submit" class="btn sm primary">add / update</button>
    </form>`;

  $$(`.sf-manual-del[data-site="${CSS.escape(site)}"]`).forEach((b) => b.addEventListener('click', () => sfDeleteManual(site, b.dataset.key)));
  el.querySelector('.sf-manual-form')?.addEventListener('submit', (e) => { e.preventDefault(); sfSetManual(site, el); });
}

async function sfSetManual(site, panelEl) {
  const key = panelEl.querySelector('.sf-manual-key').value.trim();
  const value = panelEl.querySelector('.sf-manual-value').value.trim();
  try {
    await api('POST', `/api/sitefacts/${encodeURIComponent(site)}/manual/${encodeURIComponent(key)}`, { value });
    toast(`Set manual.${key} for ${site}`);
    await sfRenderPanel(site);
  } catch (e) { toast(`Save failed: ${e.message}`, 'err'); }
}
async function sfDeleteManual(site, key) {
  if (!confirm(`Delete manual.${key} for ${site}?`)) return;
  try {
    await api('DELETE', `/api/sitefacts/${encodeURIComponent(site)}/manual/${encodeURIComponent(key)}`);
    toast(`Deleted manual.${key}`);
    await sfRenderPanel(site);
  } catch (e) { toast(`Delete failed: ${e.message}`, 'err'); }
}

const gitCls = (k) => k === 'untracked' ? 'unt' : k.includes('staged') ? 'stg' : k === 'deleted' || k === 'D' ? 'del' : 'mod';

async function toggleGitDetail(slug) {
  const row = $(`tr[data-detail="${CSS.escape(slug)}"]`);
  const box = $(`#gd-${CSS.escape(slug)}`);
  if (!row.classList.contains('hidden')) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  box.innerHTML = '<span class="muted">loading…</span>';
  await fillGitDetail(slug, box);
}

async function fillGitDetail(slug, box) {
  let s;
  try { s = await api('GET', `/api/git/${encodeURIComponent(slug)}`); }
  catch (e) { box.innerHTML = `<span class="flag">${esc(e.message)}</span>`; return; }
  renderGitDetail(slug, box, s);
}

function renderGitDetail(slug, box, s) {
  const lc = s.lastCommit
    ? `<span class="gd-last muted">last commit <span class="mono">${esc(s.lastCommit.hash)}</span> · ${esc(s.lastCommit.subject)} · ${esc(s.lastCommit.when)}</span>`
    : '';
  const pushBtn = `<button type="button" class="btn sm gd-push"${s.ahead ? '' : ' disabled title="nothing to push"'}>⇧ Push${s.ahead ? ` ${s.ahead}` : ''}</button>`;
  const pullBtn = `<button type="button" class="btn sm gd-pull"${s.behind ? '' : ' disabled title="nothing to pull"'}>⇩ Pull${s.behind ? ` ${s.behind}` : ''}</button>`;

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

  const fileRows = s.files.map((f) => `<div class="gd-file-wrap">
    <label class="gd-file">
      <input type="checkbox" class="gd-sel" value="${esc(f.path)}" checked />
      <span class="code chip ${gitCls(f.kind)}" title="${esc(f.kind)}">${esc(f.code)}</span>
      <span class="gd-path" title="${esc(f.kind)}">${esc(f.path)}</span>
      <button type="button" class="gd-diff" data-path="${esc(f.path)}" title="Show the diff for this file">diff</button>
      <button type="button" class="gd-ignore" data-path="${esc(f.path)}" title="Add to .gitignore and commit the .gitignore">ignore</button>
    </label>
    <pre class="gd-diff-out hidden" data-diff="${esc(f.path)}"></pre>
    </div>`).join('');

  const meta = [`${s.files.length} changed`, s.staged ? `${s.staged} staged` : '', s.untracked ? `${s.untracked} untracked` : '',
    s.ahead ? `${s.ahead} to push` : '', s.behind ? `${s.behind} behind` : ''].filter(Boolean).join(' · ');

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
  $$('.gd-all', box).forEach((a) => a.addEventListener('click', () => $$('.gd-sel', box).forEach((c) => { c.checked = a.dataset.v === '1'; })));
  $$('.gd-ignore', box).forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); gitIgnore(slug, box, b.dataset.path, b); }));
  $$('.gd-diff', box).forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); toggleGitFileDiff(slug, box, b.dataset.path, b); }));
  const cb = $('.gd-commit-btn', box); if (cb) cb.addEventListener('click', () => gitCommit(slug, box, cb));
  const pb = $('.gd-push', box); if (pb) pb.addEventListener('click', () => gitPush(slug, box, pb));
  const plb = $('.gd-pull', box); if (plb) plb.addEventListener('click', () => gitPull(slug, box, plb));
  const brDetails = $('.gd-branches', box);
  if (brDetails) {
    brDetails.addEventListener('toggle', () => { if (brDetails.open) loadGitBranches(slug, brDetails); }, { once: false });
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
  body.innerHTML = '<span class="muted">loading…</span>';
  let b;
  try { b = await api('GET', `/api/git/${encodeURIComponent(slug)}/branches`); }
  catch (e) { body.innerHTML = `<span class="flag">${esc(e.message)}</span>`; return; }
  body.dataset.loaded = '1';
  renderGitBranches(slug, body, b);
}

function renderGitBranches(slug, body, b) {
  const localRows = b.local.map((br) => {
    const tags = [br.current ? '<span class="badge b-blue">current</span>' : '', br.merged ? '<span class="badge b-green">merged</span>' : '<span class="badge b-yellow">unmerged</span>'].filter(Boolean).join(' ');
    const sync = (br.ahead || br.behind) ? `<span class="muted">${br.ahead ? `↑${br.ahead}` : ''}${br.behind ? ` ↓${br.behind}` : ''}</span>` : '';
    const canDelete = br.merged && !br.current && br.name !== b.defaultBranch;
    const delBtn = canDelete ? `<button type="button" class="btn sm gd-branch-del" data-branch="${esc(br.name)}">delete</button>` : '';
    return `<div class="gd-branch-row"><span class="mono">${esc(br.name)}</span> ${tags} <span class="muted">${esc(br.upstream || 'no upstream')}</span> ${sync} ${delBtn}</div>`;
  }).join('') || '<div class="muted">no local branches</div>';
  const remoteRows = b.remoteOnly.map((r) => `<div class="gd-branch-row"><span class="mono">${esc(r.name)}</span> <span class="muted">remote-only</span></div>`).join('');
  body.innerHTML = `<div class="gd-branch-list">${localRows}</div>${remoteRows ? `<div class="section-title" style="margin:8px 0 4px">Remote-only</div><div class="gd-branch-list">${remoteRows}</div>` : ''}`;
  $$('.gd-branch-del', body).forEach((btn) => btn.addEventListener('click', () => deleteGitBranch(slug, body, btn)));
}

async function deleteGitBranch(slug, body, btn) {
  const branch = btn.dataset.branch;
  if (!confirm(`Delete merged branch "${branch}" on ${slug}?`)) return;
  gdBusy(btn, true);
  try {
    await api('DELETE', `/api/git/${encodeURIComponent(slug)}/branches/${encodeURIComponent(branch)}`);
    toast(`Deleted branch ${branch}`);
    body.dataset.loaded = '0';
    const r = await api('GET', `/api/git/${encodeURIComponent(slug)}/branches`);
    body.dataset.loaded = '1';
    renderGitBranches(slug, body, r);
  } catch (e) { toast(`delete failed: ${e.message}`, 'err'); gdBusy(btn, false); }
}

// F5: toggle the per-file diff preview (working tree vs HEAD; whole file if new).
async function toggleGitFileDiff(slug, box, p, btn) {
  const pre = $(`.gd-diff-out[data-diff="${CSS.escape(p)}"]`, box);
  if (!pre) return;
  if (!pre.classList.contains('hidden')) { pre.classList.add('hidden'); return; }
  pre.classList.remove('hidden');
  pre.textContent = 'loading diff…';
  try {
    const r = await api('GET', `/api/git/${encodeURIComponent(slug)}/diff?path=${encodeURIComponent(p)}`);
    pre.textContent = r.diff || (r.untracked ? '(new file — no diff)' : '(no changes vs HEAD)');
  } catch (e) { pre.textContent = `diff failed: ${e.message}`; }
}

function gdBusy(btn, on) {
  if (!btn) return;
  if (on) { btn._orig = btn.textContent; btn.disabled = true; btn.textContent = '…'; }
  else { btn.disabled = false; if (btn._orig) btn.textContent = btn._orig; }
}

async function refreshGitAfterOp(slug, box) {
  let s; try { s = await api('GET', `/api/git/${encodeURIComponent(slug)}`); } catch { return; }
  renderGitDetail(slug, box, s);
  const row = $(`tr.git-row[data-slug="${CSS.escape(slug)}"]`);
  if (!row) return;
  const tds = row.querySelectorAll('td');
  if (tds[1]) {
    const shaCls = { synced: 'b-green', ahead: 'b-yellow', 'diverged-behind': 'b-red', 'no-upstream': 'b-blue' }[s.syncState] || 'b-blue';
    const shaLine = `<span class="badge ${shaCls}" title="local vs remote SHA">${esc(s.localSha || '—')} / ${esc(s.remoteSha || '—')}</span>`;
    tds[1].innerHTML = `<span class="mono">${esc(s.branch || '—')}</span> ${shaLine}`;
  }
  if (tds[2]) tds[2].innerHTML = s.dirty > 0 ? `<span class="badge b-yellow">${s.dirty} uncommitted</span>` : '<span class="badge b-green">clean</span>';
  if (tds[3]) {
    const sync = [];
    if (s.ahead) sync.push(`<span class="badge b-blue">↑${s.ahead}</span>`);
    if (s.behind) sync.push(`<span class="badge b-red">↓${s.behind}</span>`);
    if (!s.ahead && !s.behind) sync.push('<span class="muted">synced</span>');
    tds[3].innerHTML = sync.join(' ');
  }
}

async function gitCommit(slug, box, btn) {
  const paths = $$('.gd-sel', box).filter((c) => c.checked).map((c) => c.value);
  const msg = ($('.gd-msg', box) || {}).value ? $('.gd-msg', box).value.trim() : '';
  if (!paths.length) { toast('Select at least one file to commit', 'err'); return; }
  if (!msg) { toast('Enter a commit message', 'err'); return; }
  gdBusy(btn, true);
  try {
    await api('POST', `/api/git/${encodeURIComponent(slug)}/commit`, { paths, message: msg });
    toast(`Committed ${paths.length} file(s) on ${slug}`);
    await refreshGitAfterOp(slug, box);
  } catch (e) { toast(`commit failed: ${e.message}`, 'err'); gdBusy(btn, false); }
}

async function gitIgnore(slug, box, p, btn) {
  if (!confirm(`Add "${p}" to ${slug}'s .gitignore and commit the .gitignore?\n\nIf the file is currently tracked it will also be removed from the index (git rm --cached) in the same commit.`)) return;
  gdBusy(btn, true);
  try {
    const r = await api('POST', `/api/git/${encodeURIComponent(slug)}/ignore`, { path: p });
    toast(r.noop ? `${p} already ignored` : `Ignored ${p}${r.tracked ? ' (untracked + committed)' : ''}`);
    await refreshGitAfterOp(slug, box);
  } catch (e) { toast(`ignore failed: ${e.message}`, 'err'); gdBusy(btn, false); }
}

async function gitPush(slug, box, btn) {
  gdBusy(btn, true);
  try {
    await api('POST', `/api/git/${encodeURIComponent(slug)}/push`);
    toast(`Pushed ${slug}`);
    await refreshGitAfterOp(slug, box);
  } catch (e) { toast(`push failed: ${e.message}`, 'err'); gdBusy(btn, false); }
}

async function gitPull(slug, box, btn) {
  gdBusy(btn, true);
  try {
    await api('POST', `/api/git/${encodeURIComponent(slug)}/pull`);
    toast(`Pulled ${slug}`);
    await refreshGitAfterOp(slug, box);
  } catch (e) { toast(`pull failed: ${e.message}`, 'err'); gdBusy(btn, false); }
}

// F6: push every site that's ahead of origin, one call, sequential on the server.
async function pushAllSites() {
  const btn = $('#push-all');
  if (!confirm('Push every site that is ahead of origin?\n\nEach pushed site deploys on push. Runs sequentially.')) return;
  gdBusy(btn, true);
  toast('Pushing all sites that need it…');
  try {
    const r = await api('POST', '/api/git/push-all');
    const failed = (r.results || []).filter((x) => !x.ok);
    toast(`Pushed ${r.pushed}/${r.total}${failed.length ? ` · ${failed.length} failed` : ''}`, failed.length ? 'err' : 'ok');
    softRender();
  } catch (e) { toast(`push-all failed: ${e.message}`, 'err'); gdBusy(btn, false); }
}

// F25: pull every site that's behind origin, one call, sequential on the
// server (git.pullAll mirrors git.pushAll exactly).
async function pullAllSites() {
  const btn = $('#pull-all');
  if (!confirm('Pull every site that is behind origin?\n\nSkips any repo with uncommitted changes. Runs sequentially.')) return;
  gdBusy(btn, true);
  toast('Pulling all sites that need it…');
  try {
    const r = await api('POST', '/api/git/pull-all');
    const failed = (r.results || []).filter((x) => !x.ok);
    toast(`Pulled ${r.pulled}/${r.total}${failed.length ? ` · ${failed.length} failed` : ''}`, failed.length ? 'err' : 'ok');
    softRender();
  } catch (e) { toast(`pull-all failed: ${e.message}`, 'err'); gdBusy(btn, false); }
}

/* ===================== GIT STASHES ===================== */
async function renderGitStashes(slug) {
  const app = $('#app');
  if (FRESH) app.innerHTML = '<div class="loading">Loading stashes…</div>';
  if (!slug) { app.innerHTML = '<div class="empty">No site specified.</div>'; return; }
  let list;
  try { list = await api('GET', `/api/git/${encodeURIComponent(slug)}/stashes`); }
  catch (e) { app.innerHTML = `<div class="empty">Failed to load stashes: ${esc(e.message)}</div>`; return; }

  const rows = list.map((s) => `
    <div class="card" style="margin-bottom:10px" data-rk="stash:${esc(s.ref)}">
      <div class="gd-head">
        <span class="mono">${esc(s.ref)}</span>
        <span>${esc(s.message)}</span>
        <span class="muted">${esc(s.when)}</span>
        <button type="button" class="btn sm gs-diff" data-index="${s.index}">view diff</button>
        <button type="button" class="btn sm gs-drop" data-index="${s.index}">drop</button>
      </div>
      <pre class="gd-diff-out hidden" data-stash-diff="${s.index}"></pre>
    </div>`).join('') || '<div class="empty">No stashes for this repo.</div>';

  app.innerHTML = `
    <div class="task-toolbar">
      <a href="#git">← back to Git</a>
      <strong style="margin-left:12px">${esc(slug)} — ${list.length} stash(es)</strong>
    </div>
    ${rows}`;

  $$('.gs-diff', app).forEach((b) => b.addEventListener('click', () => toggleStashDiff(slug, b.dataset.index)));
  $$('.gs-drop', app).forEach((b) => b.addEventListener('click', () => dropStashUI(slug, b.dataset.index)));
  if (!FRESH) applyUISnap();
  stamp();
}

async function toggleStashDiff(slug, index) {
  const pre = $(`.gd-diff-out[data-stash-diff="${index}"]`);
  if (!pre) return;
  if (!pre.classList.contains('hidden')) { pre.classList.add('hidden'); return; }
  pre.classList.remove('hidden');
  pre.textContent = 'loading diff…';
  try {
    const r = await api('GET', `/api/git/${encodeURIComponent(slug)}/stashes/${index}/diff`);
    pre.textContent = r.diff || '(empty diff)';
  } catch (e) { pre.textContent = `diff failed: ${e.message}`; }
}

async function dropStashUI(slug, index) {
  if (!confirm('Drop this stash? This cannot be undone.')) return;
  try {
    await api('DELETE', `/api/git/${encodeURIComponent(slug)}/stashes/${index}`);
    toast('Stash dropped');
    FRESH = true;
    await renderGitStashes(slug);
  } catch (e) { toast(`drop failed: ${e.message}`, 'err'); }
}

/* ===================== ROLES ===================== */
function fmtAge(secs) {
  if (secs == null) return '';
  const s = Math.round(secs);
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.floor(s / 60)}m` : s < 172800 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}
const STATE_RANK = { overdue: 3, stale: 2, never: 1, fresh: 0, paused: -1 };
let ROLEMATRIX = null;
let ROLE_OPEN = null;   // {site, role} while the role-log modal is open (for live-follow)

// Live-follow: every few seconds, re-tail any open log surface (container log
// panels on the Containers tab, and the role-log modal). Stops itself when the
// tab is hidden or nothing is open.
function logFollowTick() {
  if (document.hidden) return;
  if (STATE.view === 'containers') {
    $$('.cn-detail-row:not(.hidden)').forEach((r) => {
      const box = $(`#cl-${CSS.escape(r.dataset.detail)}`);
      if (box) fetchContainerLog(r.dataset.detail, box);
    });
  }
  if (STATE.view === 'agent' && STATE.agent && STATE.agent !== 'engineer') {
    $$('.ag-detail-row:not(.hidden)').forEach((r) => {
      const box = $(`#al-${CSS.escape(r.dataset.detail)}`);
      if (box) fetchAgentLog(r.dataset.detail, STATE.agent, box);
    });
  }
  if (STATE.view === 'errors') {
    $$('.err-detail-row:not(.hidden)').forEach((r) => {
      const box = $(`#el-${CSS.escape(r.dataset.detail)}`);
      if (box) fetchErrorLines(r.dataset.detail, box);
    });
  }
  if (ROLE_OPEN && !$('#modal').classList.contains('hidden')) fetchRoleLog(ROLE_OPEN.site, ROLE_OPEN.role);
}

async function renderControl() {
  const app = $('#app');
  if (FRESH) app.innerHTML = '<div class="loading">Reading role status…</div>';
  let data;
  try { data = await api('GET', '/api/roles'); }
  catch (e) { app.innerHTML = `<div class="empty">Roles read failed: ${esc(e.message)}</div>`; return; }
  ROLEMATRIX = data;
  const sites = data.sites;

  // Columns = roles scheduled on ≥2 sites (common roles); per-site singletons
  // (e.g. a site's bespoke writers) collapse into a trailing "other" cell.
  const count = {};
  sites.forEach((s) => Object.keys(s.cells).forEach((r) => { count[r] = (count[r] || 0) + 1; }));
  const core = data.roles.filter((r) => count[r] >= 2);
  const coreSet = new Set(core);

  const tally = { fresh: 0, stale: 0, overdue: 0, paused: 0, never: 0 };
  sites.forEach((s) => Object.values(s.cells).forEach((c) => { tally[c.state]++; }));

  const agentSet = new Set((STATE.agents || []).map((a) => a.role));
  // F13: fleet-wide pause/resume per role, next to the column header. Only
  // shown when at least one site's cell for this role is worker-controllable
  // (the same gate roles.setEnabled() enforces server-side); the icon/action
  // reflects the majority state so one click flips the whole column.
  const head = '<th class="rsite-h">Site</th>'
    + core.map((r) => {
      const cells = sites.map((s) => s.cells[r]).filter(Boolean);
      const controllable = cells.filter((c) => c.worker);
      const anyEnabled = controllable.some((c) => c.enabled);
      const bulkBtn = controllable.length
        ? `<button class="rcol-bulk" data-role="${esc(r)}" data-act="${anyEnabled ? 'pause' : 'resume'}" title="${anyEnabled ? 'Pause' : 'Resume'} ${esc(r)} on all ${controllable.length} site(s)">${anyEnabled ? '⏸' : '▶'}</button>`
        : '';
      const label = agentSet.has(r)
        ? `<a class="rcol-link" data-role="${esc(r)}" title="Open the ${esc(agentLabel(r))} agent page">${esc(r)} →</a>`
        : `<span>${esc(r)}</span>`;
      return `<th class="rcol">${label}${bulkBtn}</th>`;
    }).join('')
    + '<th class="rcol">other</th>';

  const body = sites.map((s) => {
    const cells = core.map((r) => {
      const c = s.cells[r];
      return `<td class="rcell">${c ? roleDot(s.site, r, c) : '<span class="rdot r-none">·</span>'}</td>`;
    }).join('');
    const others = Object.keys(s.cells).filter((r) => !coreSet.has(r));
    let otherCell = '<td class="rcell"><span class="rdot r-none">·</span></td>';
    if (others.length) {
      const worst = others.reduce((a, r) => STATE_RANK[s.cells[r].state] > STATE_RANK[a] ? s.cells[r].state : a, 'paused');
      const tip = others.map((r) => `${r}: ${s.cells[r].state}${s.cells[r].age != null ? ` (${fmtAge(s.cells[r].age)})` : ''}`).join('\n');
      otherCell = `<td class="rcell"><span class="rcount r-${worst}" title="${esc(tip)}">${others.length}</span></td>`;
    }
    return `<tr data-fleet-row data-site="${esc(s.site)}"><td class="rsite">${siteLink(s.site)}${toolLinks(s.site)}</td>${cells}${otherCell}</tr>`;
  }).join('');

  const lg = dotLegend;
  app.innerHTML = `
    <div class="page-head"><h2 class="page-title">Domain Control</h2><span class="muted">fleet roles across ${sites.length} sites · column headers open an agent page</span></div>
    <div class="task-toolbar">
      <strong>${core.length} common roles</strong>
      <span class="muted">${lg('fresh', tally.fresh + ' fresh')} · ${lg('stale', tally.stale + ' stale')} · ${lg('overdue', tally.overdue + ' overdue')} · ${lg('paused', tally.paused + ' paused')} · ${lg('never', tally.never + ' no-log')}</span>
    </div>
    <div class="card rmatrix-card"><table class="rmatrix">
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <p class="muted" style="margin-top:12px">Each cell = a role scheduled on that site. ${lg('fresh', 'ran within its cadence')} · ${lg('stale', 'overdue >1×')} · ${lg('overdue', 'overdue >2×')} · ${lg('paused', 'paused (.&lt;role&gt;-disabled)')} · ${lg('never', 'scheduled, no log found')} · <span class="rdot r-none">·</span> not installed. Click a column header to open that agent's page, or a cell for its latest log + pause/resume. Bespoke per-site roles are grouped under <b>other</b>. The <b>deployer</b> column reflects deploy health (main vs origin): ${lg('fresh', 'in sync — live via push-to-deploy')} · ${lg('overdue', 'unpushed commits not deployed')}.</p>`;

  $$('.rdot[data-site]').forEach((d) => d.addEventListener('click', () => openRole(d.dataset.site, d.dataset.role)));
  $$('.rcol-link').forEach((a) => a.addEventListener('click', () => go('agent', a.dataset.role)));
  $$('.rcol-bulk').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); bulkToggleRole(b.dataset.role, b.dataset.act); }));
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

// F13: pause/resume one role across every site that schedules it as a
// worker role. Sequenced client-side, one site at a time (same shape as
// pushAllSites), so a single slow/failed site can't block the rest and the
// operator gets a per-site result instead of one opaque spinner.
async function bulkToggleRole(role, act) {
  const sites = (ROLEMATRIX && ROLEMATRIX.sites || []).filter((s) => s.cells[role] && s.cells[role].worker);
  if (!sites.length) { toast(`No worker-controllable sites schedule ${role}`, 'err'); return; }
  const verb = act === 'pause' ? 'Pause' : 'Resume';
  if (!confirm(`${verb} ${role} across ${sites.length} site(s)?`)) return;
  const btn = $(`.rcol-bulk[data-role="${CSS.escape(role)}"]`);
  gdBusy(btn, true);
  toast(`${verb === 'Pause' ? 'Pausing' : 'Resuming'} ${role} on ${sites.length} site(s)…`);
  const results = [];
  for (const s of sites) {
    try {
      await api('POST', `/api/roles/${encodeURIComponent(s.site)}/${encodeURIComponent(role)}/${act}`);
      results.push({ site: s.site, ok: true });
    } catch (e) { results.push({ site: s.site, ok: false, error: e.message }); }
    if (btn) btn.textContent = `${results.length}/${sites.length}`;
  }
  const failed = results.filter((r) => !r.ok);
  toast(`${verb}d ${results.length - failed.length}/${results.length} ${role}${failed.length ? ` · failed: ${failed.map((f) => f.site).join(', ')}` : ''}`, failed.length ? 'err' : 'ok');
  softRender();
}

const STATE_LABEL = { fresh: 'fresh', stale: 'overdue', overdue: 'well overdue', paused: 'paused', never: 'no log found' };
function roleDot(site, role, c) {
  let tip;
  if (c.deploy) {
    // Deployer cell = deploy health: push state (main vs origin) refined by the
    // CF build verdict (did Cloudflare actually ship the latest commit?).
    const d = c.deploy, b = d.build;
    let health;
    if (d.ahead) health = `${d.ahead} commit${d.ahead > 1 ? 's' : ''} not deployed (unpushed)`;
    else if (d.branch && d.branch !== 'main' && d.branch !== 'master') health = `on ${d.branch} (not main)`;
    else if (!d.pushed) health = 'no repo';
    else if (b && b.ok && b.live === false) health = 'pushed — CF build behind (pending/failed)';
    else if (b && b.ok && b.live) health = `live — CF v${b.version}`;
    else if (b && b.error) health = `in sync (CF check: ${b.error})`;
    else health = 'in sync — deployed';
    const extras = [];
    if (d.dirty) extras.push(`${d.dirty} uncommitted`);
    if (c.age != null) extras.push(`last deploy ${fmtAge(c.age)} ago`);
    tip = `deployer — ${health}${extras.length ? ' · ' + extras.join(' · ') : ''}`;
  } else {
    tip = `${role} — ${STATE_LABEL[c.state] || c.state}${c.age != null ? ` · last ${fmtAge(c.age)} ago` : ''} · sched ${c.schedule}`;
  }
  return `<span class="rdot r-${c.state}" data-site="${esc(site)}" data-role="${esc(role)}" title="${esc(tip)}"></span>`;
}

function roleCell(site, role) {
  const s = ROLEMATRIX && ROLEMATRIX.sites.find((x) => x.site === site);
  return s ? s.cells[role] : null;
}

async function openRole(site, role) {
  const title = $('#modal-title'), body = $('#modal-body');
  const c = roleCell(site, role);
  title.textContent = `${site} · ${role}`;
  const badgeCls = !c ? 'b-gray' : !c.enabled ? 'b-gray' : c.state === 'fresh' ? 'b-green' : c.state === 'never' ? 'b-gray' : 'b-yellow';
  const stateTxt = c ? (c.enabled ? (STATE_LABEL[c.state] || c.state) : 'paused') : '';
  const isAgent = (STATE.agents || []).some((a) => a.role === role);
  const ctrl = c && c.worker
    ? `<button class="btn sm" id="role-run">▶ Run now</button> <button class="btn sm ${c.enabled ? 'danger' : 'primary'}" id="role-toggle">${c.enabled ? '⏸ Pause role' : '▶ Resume role'}</button>`
    : (c ? '<span class="muted" style="font-size:11.5px">not pause-controllable</span>' : '');
  body.innerHTML = `
    <div class="role-head">
      <span class="badge ${badgeCls}">${esc(stateTxt)}</span>
      ${c ? `<span class="muted">sched <span class="mono">${esc(c.schedule)}</span>${c.age != null ? ` · last ${fmtAge(c.age)} ago` : ''}</span>` : ''}
      ${isAgent ? `<a class="crumb-link" id="role-openpage">open ${esc(agentLabel(role))} page →</a>` : ''}
      <span class="role-ctrl">${ctrl}</span>
    </div>
    <div class="section-title"><span id="role-logfile">latest log</span> <span class="live-tag">live</span></div>
    <pre class="cn-logs-box" id="role-log">loading latest log…</pre>`;
  $('#modal').classList.remove('hidden');
  ROLE_OPEN = { site, role };
  const tg = $('#role-toggle');
  if (tg) tg.addEventListener('click', () => toggleRole(site, role, c.enabled));
  const op = $('#role-openpage');
  if (op) op.addEventListener('click', () => { closeModal(); go('agent', role); });
  const rn = $('#role-run');
  if (rn) rn.addEventListener('click', () => runAgent(site, role, rn));
  await fetchRoleLog(site, role);
}

async function fetchRoleLog(site, role) {
  const pre = $('#role-log'); if (!pre) return;
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
  try {
    const r = await api('GET', `/api/roles/${encodeURIComponent(site)}/${encodeURIComponent(role)}/log?tail=400`);
    const f = $('#role-logfile'); if (f) f.textContent = r.file || 'no log file found';
    if (pre.textContent !== r.log) { pre.textContent = r.log; if (atBottom) pre.scrollTop = pre.scrollHeight; }
  } catch (e) { if (pre.textContent === 'loading latest log…') pre.textContent = `error: ${e.message}`; }
}

async function toggleRole(site, role, currentlyEnabled) {
  const action = currentlyEnabled ? 'pause' : 'resume';
  const btn = $('#role-toggle'); gdBusy(btn, true);
  try {
    await api('POST', `/api/roles/${encodeURIComponent(site)}/${encodeURIComponent(role)}/${action}`);
    toast(`${action === 'pause' ? 'Paused' : 'Resumed'} ${role} on ${site}`);
    FRESH = false; UISNAP = captureUI();
    await (STATE.view === 'agent' ? renderGenericAgent(STATE.agent) : renderControl());  // refresh active view
    await openRole(site, role);   // re-open with fresh state
  } catch (e) { toast(`${action} failed: ${e.message}`, 'err'); gdBusy(btn, false); }
}

/* ===================== AGENT PAGE (generic) ===================== */
// One role across the fleet: overview of every site that has it (status, last
// run, schedule, pause/resume) + a per-site zoomed log (live-following).
async function renderGenericAgent(role) {
  const app = $('#app');
  if (FRESH) app.innerHTML = `<div class="loading">Loading ${esc(agentLabel(role))} agent…</div>`;
  let data;
  try { data = await api('GET', '/api/roles'); }
  catch (e) { app.innerHTML = `${breadcrumb(role)}<div class="empty">${esc(e.message)}</div>`; wireCrumbs(); return; }
  ROLEMATRIX = data;
  const rows = data.sites.filter((s) => s.cells[role]).map((s) => ({ site: s.site, ...s.cells[role] }));
  if (!rows.length) {
    app.innerHTML = `${breadcrumb(role)}<div class="empty">No sites schedule the <b>${esc(role)}</b> role.</div>`;
    wireCrumbs(); stamp(); return;
  }
  const enabled = rows.filter((r) => r.enabled).length;
  const paused = rows.length - enabled;
  const issues = rows.filter((r) => r.enabled && (r.state === 'stale' || r.state === 'overdue')).length;

  const body = rows.map((r) => {
    const runBtn = r.worker ? `<button class="btn sm ag-run" data-site="${esc(r.site)}">▶ Run</button>` : '';
    const ctrl = r.worker
      ? `${runBtn} <button class="btn sm ${r.enabled ? 'danger' : 'primary'} ag-toggle" data-site="${esc(r.site)}" data-enabled="${r.enabled ? 1 : 0}">${r.enabled ? '⏸ Pause' : '▶ Resume'}</button>`
      : '<span class="muted" style="font-size:11px">not controllable</span>';
    const badge = !r.enabled ? '<span class="badge b-gray">paused</span>'
      : r.state === 'fresh' ? '<span class="badge b-green">fresh</span>'
        : r.state === 'never' ? '<span class="badge b-gray">no log</span>'
          : `<span class="badge b-yellow">${esc(STATE_LABEL[r.state] || r.state)}</span>`;
    return `<tr class="ag-row" data-fleet-row data-site="${esc(r.site)}">
      <td class="site">${siteLink(r.site)}${toolLinks(r.site)}</td>
      <td>${badge}</td>
      <td class="mono muted">${r.age != null ? esc(fmtAge(r.age)) + ' ago' : '—'}</td>
      <td class="mono muted">${esc(r.schedule)}</td>
      <td class="cn-actions"><button class="btn sm ag-logs" data-site="${esc(r.site)}">📜 Logs</button> ${ctrl}</td>
    </tr>
    <tr class="ag-detail-row hidden" data-detail="${esc(r.site)}" data-rk="ag:${esc(r.site)}"><td colspan="5"><div class="cn-log-head muted">latest log · <span class="live-tag">live</span></div><pre class="cn-logs-box" id="al-${esc(r.site)}" data-rkh="ag:${esc(r.site)}"></pre></td></tr>`;
  }).join('');

  app.innerHTML = `
    ${breadcrumb(role)}
    <div class="page-head"><h2 class="page-title">${esc(agentLabel(role))}</h2><span class="muted">${rows.length} sites run this agent</span></div>
    <div class="task-toolbar">
      <strong>${rows.length} sites</strong>
      <span class="muted">${enabled} enabled · ${paused} paused${issues ? ` · <span class="flag">${issues} overdue</span>` : ''}</span>
    </div>
    <div class="card"><table>
      <thead><tr><th>Site</th><th>Status</th><th>Last run</th><th>Schedule</th><th>Actions</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <p class="muted" style="margin-top:12px">Each row is one site running the <b>${esc(agentLabel(role))}</b> agent. Open <b>Logs</b> for the live-tailing latest run, or pause/resume the role per site. ← back to <a class="crumb-link" id="crumb-control2">Domain Control</a>.</p>`;

  wireCrumbs();
  const c2 = $('#crumb-control2'); if (c2) c2.addEventListener('click', () => go('control'));
  $$('.ag-logs').forEach((b) => b.addEventListener('click', () => toggleAgentLog(b.dataset.site, role)));
  $$('.ag-toggle').forEach((b) => b.addEventListener('click', () => toggleRole(b.dataset.site, role, b.dataset.enabled === '1')));
  $$('.ag-run').forEach((b) => b.addEventListener('click', () => runAgent(b.dataset.site, role, b)));
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

// Fire a worker role now on one site (detached run-worker.sh, work-lock safe).
async function runAgent(site, role, btn) {
  if (btn.disabled) return;
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  try {
    const r = await api('POST', `/api/roles/${encodeURIComponent(site)}/${encodeURIComponent(role)}/run`);
    toast(`${agentLabel(role)} triggered on ${site} (${r.container})`);
    btn.textContent = '✓ sent';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 5000);
  } catch (e) { toast(`run failed: ${e.message}`, 'err'); btn.textContent = orig; btn.disabled = false; }
}

async function toggleAgentLog(site, role) {
  const row = $(`tr.ag-detail-row[data-detail="${CSS.escape(site)}"]`);
  const box = $(`#al-${CSS.escape(site)}`);
  if (!row.classList.contains('hidden')) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  box.textContent = 'loading latest log…';
  await fetchAgentLog(site, role, box);
}

async function fetchAgentLog(site, role, box) {
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  try {
    const r = await api('GET', `/api/roles/${encodeURIComponent(site)}/${encodeURIComponent(role)}/log?tail=400`);
    if (box.textContent !== r.log) { box.textContent = r.log; if (atBottom) box.scrollTop = box.scrollHeight; }
  } catch (e) { if (box.textContent === 'loading latest log…') box.textContent = `error: ${e.message}`; }
}

/* ===================== CONTAINERS ===================== */
async function renderContainers() {
  const app = $('#app');
  if (FRESH) app.innerHTML = '<div class="loading">Listing containers…</div>';
  let rows;
  try { rows = await api('GET', '/api/containers'); }
  catch (e) { app.innerHTML = `<div class="empty">Container list failed: ${esc(e.message)}</div>`; return; }

  const cron = rows.filter((r) => r.kind === 'cron');
  const cronUp = cron.filter((r) => r.running).length;
  const workers = rows.filter((r) => r.kind === 'worker').length;

  // F15: health tally, same dot-legend pattern as Domain Control / Git.
  const tally = { healthy: 0, unhealthy: 0, stopped: 0 };
  rows.forEach((r) => { if (!r.running) tally.stopped++; else if (r.unhealthy) tally.unhealthy++; else tally.healthy++; });

  const body = rows.map((r) => {
    const label = r.kind === 'cron' ? 'cron' : r.kind === 'worker' ? 'worker run' : (r.service || r.kind);
    const svc = `<span class="badge ${r.kind === 'cron' ? 'b-blue' : r.kind === 'worker' ? 'b-purple' : 'b-gray'}">${esc(label)}</span>`;
    const acts = [`<button class="btn sm cn-logs" data-id="${esc(r.id)}">📜 Logs</button>`];
    if (r.running) acts.push(`<button class="btn sm cn-act" data-id="${esc(r.id)}" data-act="restart" data-name="${esc(r.name)}">↻ Restart</button>`);
    else acts.push(`<button class="btn sm cn-act" data-id="${esc(r.id)}" data-act="start" data-name="${esc(r.name)}">▶ Start</button>`);
    if (r.kind === 'cron') acts.push(`<button class="btn sm cn-bounce" data-slug="${esc(r.slug)}" data-name="${esc(r.name)}" title="Rebuild image + recreate (Dockerfile/dependency changes)">⟳ Rebuild</button>`);
    if (r.running) acts.push(`<button class="btn sm danger cn-act" data-id="${esc(r.id)}" data-act="stop" data-name="${esc(r.name)}">⏹ Stop</button>`);
    return `<tr class="cn-row" data-fleet-row data-site="${esc(r.scope === 'site' ? r.slug : '')}">
      <td class="mono">${esc(r.name)}</td>
      <td>${r.scope === 'site' ? `<span class="site">${esc(r.slug)}</span>` : '<span class="muted">tool</span>'}</td>
      <td>${svc}</td>
      <td>${containerStatus(r)}</td>
      <td class="mono muted">${esc(r.running ? r.runningFor : '—')}</td>
      <td class="cn-actions">${acts.join(' ')}</td>
    </tr>
    <tr class="cn-detail-row hidden" data-detail="${esc(r.id)}" data-rk="cn:${esc(r.id)}"><td colspan="6">
      <div class="cn-log-toolbar muted">
        <span>logs · <span class="live-tag">live</span></span>
        <span class="cm-spacer"></span>
        <input class="cm-input cn-log-filter" data-id="${esc(r.id)}" type="text" placeholder="Filter lines…" spellcheck="false" />
        <label class="cm-chk"><input type="checkbox" class="cn-log-wrap" data-id="${esc(r.id)}" /> Wrap</label>
        <button type="button" class="btn sm cn-log-copy" data-id="${esc(r.id)}">Copy</button>
        <button type="button" class="btn sm cn-log-download" data-id="${esc(r.id)}" data-name="${esc(r.name)}">Download</button>
      </div>
      <pre class="cn-logs-box" id="cl-${esc(r.id)}" data-rkh="cn:${esc(r.id)}"></pre></td></tr>`;
  }).join('');

  app.innerHTML = `
    <div class="task-toolbar">
      <strong>${rows.length} containers</strong>
      <span class="muted">${dotLegend('fresh', tally.healthy + ' healthy')} · ${dotLegend('overdue', tally.unhealthy + ' unhealthy')} · ${dotLegend('paused', tally.stopped + ' stopped')} · ${cronUp}/${cron.length} cron up · ${workers} worker run${workers === 1 ? '' : 's'} in-flight</span>
      <button class="btn sm" id="restart-crons" style="margin-left:auto">↻ Restart all crons</button>
    </div>
    <div class="card"><table>
      <thead><tr><th>Container</th><th>Site</th><th>Service</th><th>Status</th><th>Up</th><th>Actions</th></tr></thead>
      <tbody>${body || '<tr><td colspan="6" class="muted">No domains containers running.</td></tr>'}</tbody>
    </table></div>
    <p class="muted" style="margin-top:12px"><b>Restart</b> = quick bounce (re-runs the container; picks up bind-mounted crontab / role-flag changes). <b>Rebuild</b> = rebuild image + force-recreate (for Dockerfile / dependency changes). All actions are guard-railed to containers inside the domains repo.</p>`;

  wireContainerRows();
  $('#restart-crons').addEventListener('click', restartAllCrons);
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

async function restartAllCrons() {
  if (!confirm('Restart ALL cron containers across the fleet?\n\nQuick bounce — re-runs each cron container (picks up crontab / role-flag changes). Takes ~15s.')) return;
  const btn = $('#restart-crons'); gdBusy(btn, true);
  toast('Restarting all cron containers…');
  try {
    const r = await api('POST', '/api/containers/restart-crons');
    toast(`Restarted ${r.restarted}/${r.total} cron containers`, r.restarted === r.total ? 'ok' : 'err');
    await reloadContainers();
  } catch (e) { toast(`restart-all failed: ${e.message}`, 'err'); gdBusy(btn, false); }
}

function containerStatus(r) {
  if (!r.running) return '<span class="badge b-red">stopped</span>';
  if (r.unhealthy) return '<span class="badge b-red">unhealthy</span>';
  if (r.healthy) return '<span class="badge b-green">healthy</span>';
  return '<span class="badge b-green">running</span>';
}

function wireContainerRows() {
  $$('.cn-logs').forEach((b) => b.addEventListener('click', () => toggleContainerLogs(b.dataset.id)));
  $$('.cn-act').forEach((b) => b.addEventListener('click', () => containerAction(b.dataset.id, b.dataset.act, b.dataset.name, b)));
  $$('.cn-bounce').forEach((b) => b.addEventListener('click', () => bounceCron(b.dataset.slug, b.dataset.name, b)));
  // F26: filter/copy/download toolbar on the container log view (mirrors the
  // Cron tab's cm-log-filter/copy/download, scoped per container id).
  $$('.cn-log-filter').forEach((inp) => inp.addEventListener('input', () => {
    cnLogState(inp.dataset.id).filter = inp.value;
    cnApplyLogFilter(inp.dataset.id);
  }));
  $$('.cn-log-wrap').forEach((cb) => cb.addEventListener('change', (e) => {
    const box = $(`#cl-${CSS.escape(cb.dataset.id)}`);
    if (box) box.classList.toggle('cm-wrap', e.target.checked);
  }));
  $$('.cn-log-copy').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(cnLogState(b.dataset.id).raw); toast('Copied'); }
    catch { toast('Copy failed', 'err'); }
  }));
  $$('.cn-log-download').forEach((b) => b.addEventListener('click', () => {
    const st = cnLogState(b.dataset.id);
    const blob = new Blob([st.raw], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${b.dataset.name || b.dataset.id}.log`;
    a.click(); URL.revokeObjectURL(a.href);
  }));
}

async function toggleContainerLogs(id) {
  const row = $(`tr[data-detail="${CSS.escape(id)}"]`);
  const box = $(`#cl-${CSS.escape(id)}`);
  if (!row.classList.contains('hidden')) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  box.textContent = 'loading logs…';
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
  box.textContent = (f ? lines.filter((l) => l.toLowerCase().includes(f)) : lines).join('\n');
}

// Fetch (or re-fetch, for live-follow) a container's logs. Keeps the view
// pinned to the bottom only if it was already there (so manual scroll sticks).
async function fetchContainerLog(id, box) {
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  try {
    const r = await api('GET', `/api/containers/${encodeURIComponent(id)}/logs?tail=300`);
    const st = cnLogState(id);
    if (st.raw !== r.logs) { st.raw = r.logs; cnApplyLogFilter(id); if (atBottom) box.scrollTop = box.scrollHeight; }
  } catch (e) { if (!box.textContent || box.textContent === 'loading logs…') box.textContent = `error: ${e.message}`; }
}

// Re-render the containers view in place (preserving open log panels + scroll).
function reloadContainers() { FRESH = false; UISNAP = captureUI(); return renderContainers(); }

async function containerAction(id, act, name, btn) {
  if (act === 'stop' && !confirm(`Stop ${name}? That pauses everything this container runs.`)) return;
  gdBusy(btn, true);
  try {
    await api('POST', `/api/containers/${encodeURIComponent(id)}/${act}`);
    toast(`${act === 'restart' ? 'Restarted' : act === 'stop' ? 'Stopped' : 'Started'} ${name}`);
    await reloadContainers();
  } catch (e) { toast(`${act} failed: ${e.message}`, 'err'); gdBusy(btn, false); }
}

async function bounceCron(slug, name, btn) {
  if (!confirm(`Rebuild and recreate the cron container for ${slug}?\n\nThis rebuilds the image (can take a minute or two) then force-recreates the container.`)) return;
  gdBusy(btn, true);
  toast(`Rebuilding ${slug} cron — this can take a minute…`);
  try {
    await api('POST', `/api/sites/${encodeURIComponent(slug)}/bounce`);
    toast(`Rebuilt + recreated ${name}`);
    await reloadContainers();
  } catch (e) { toast(`rebuild failed: ${e.message}`, 'err'); gdBusy(btn, false); }
}

/* ===================== TASKS ===================== */
const COLS = ['backlog', 'in-progress', 'done', 'hold'];
const COL_LABEL = { 'backlog': 'Backlog', 'in-progress': 'In Progress', 'done': 'Done', 'hold': 'Hold' };
const STAGE_LABEL = { 'backlog': 'not started', 'in-progress': 'in-progress', 'done': 'done', 'hold': 'hold' };
const STAGE_ORDER = { 'in-progress': 0, 'backlog': 1, 'hold': 2, 'done': 3 };
const ROLES = ['engineer', 'planner', 'content-writer', 'news-writer', 'affiliate-editor', 'seo-analyst', 'watchdog', 'maintainer'];
let loadedMeta = {};   // full frontmatter of the task being edited (preserves unknown keys)

// Fleet-aggregator state. Stage defaults to open work (backlog+in-progress),
// matching the page this replaces.
const TASK = {
  mode: 'fleet',                 // 'fleet' | 'board'
  view: 'tree',                  // fleet sub-view: 'tree' | 'table'
  all: [],                       // every task across the fleet
  f: { priority: new Set(), stage: new Set(['backlog', 'in-progress']), type: new Set(), role: new Set(), site: new Set(), blocked: '' },
};

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
  const prev = (!FRESH && $('#task-content')) ? $('#task-content').innerHTML : '<div class="loading">Loading tasks…</div>';
  app.innerHTML = `
    <div class="task-toolbar">
      <div class="seg">
        <button class="seg-btn ${TASK.mode === 'fleet' ? 'active' : ''}" data-mode="fleet">Fleet</button>
        <button class="seg-btn ${TASK.mode === 'board' ? 'active' : ''}" data-mode="board">Board</button>
      </div>
      <div id="task-controls" class="task-controls"></div>
      <button class="btn primary sm" id="new-task" style="margin-left:auto">+ New Task</button>
    </div>
    <div id="task-content">${prev}</div>`;
  $$('.seg-btn').forEach((b) => b.addEventListener('click', () => { TASK.mode = b.dataset.mode; renderTasks(); }));
  $('#new-task').addEventListener('click', () => openTaskModal({ mode: 'create', site: TASK.mode === 'board' ? STATE.taskSite : (STATE.sites[0] || null) }));
  if (TASK.mode === 'board') renderBoardControls(); else renderFleetControls();
  if (TASK.mode === 'board') loadBoard(); else loadFleet();
}

/* ---- Board (per-site CRUD kanban) ---- */
function renderBoardControls() {
  const opts = STATE.sites.map((s) => `<option value="${esc(s)}" ${s === STATE.taskSite ? 'selected' : ''}>${esc(s)}</option>`).join('');
  $('#task-controls').innerHTML = `<label class="muted">Site</label> <select id="task-site">${opts}</select>`;
  $('#task-site').addEventListener('change', (e) => { STATE.taskSite = e.target.value; loadBoard(); });
}

async function loadBoard() {
  const content = $('#task-content');
  if (!STATE.taskSite) { content.innerHTML = '<div class="empty">No sites found.</div>'; return; }
  let data;
  try { data = await api('GET', `/api/tasks/${encodeURIComponent(STATE.taskSite)}`); }
  catch (e) { content.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  content.innerHTML = `<div class="board">${COLS.map((col) => {
    const items = data[col] || [];
    const cards = items.length ? items.map((t) => boardCard(t)).join('') : '<div class="empty" style="padding:20px;font-size:12px">empty</div>';
    return `<div class="col"><div class="col-head"><h3>${COL_LABEL[col]}</h3><span class="count">${items.length}</span></div><div class="col-body">${cards}</div></div>`;
  }).join('')}</div>`;
  $$('.task').forEach((el) => el.addEventListener('click', () => openTaskModal({ mode: 'edit', site: STATE.taskSite, column: el.dataset.col, file: el.dataset.file })));
  if (!FRESH) applyUISnap();
  stamp();
}

// "Opened" label for a card: prefer the explicit `created` frontmatter (the date
// the ticket was opened); fall back to the file's creation time. Shows the date,
// with the full timestamp on hover.
function openedLabel(t) {
  const dateStr = t.created || (t.birthtime ? new Date(t.birthtime).toISOString().slice(0, 10) : null);
  if (!dateStr) return '';
  const full = t.birthtime ? new Date(t.birthtime).toLocaleString() : dateStr;
  return `<div class="t-date" title="opened ${esc(full)}">🕓 ${esc(dateStr)}</div>`;
}

function boardCard(t) {
  const role = t.assigned_role ? `<span class="badge b-blue">${esc(t.assigned_role)}</span>` : '';
  const type = t.type ? `<span class="badge b-gray">${esc(t.type)}</span>` : '';
  const blk = t.blocked_on ? '<span class="blocked-tag">blocked</span>' : '';
  return `<div class="task ${t.blocked_on ? 'task-blocked' : ''}" data-col="${esc(t.column)}" data-file="${esc(t.file)}">
    <div class="t-title">${esc(t.title)}${blk}</div>
    <div class="t-meta">${prioTag(t.priority)}${role}${type}</div>
    ${t.excerpt ? `<div class="t-excerpt">${esc(t.excerpt)}</div>` : ''}
    ${openedLabel(t)}
  </div>`;
}

/* ---- Fleet (cross-site aggregator + filters) ---- */
function renderFleetControls() {
  $('#task-controls').innerHTML = `
    <div class="seg sm">
      <button class="seg-btn ${TASK.view === 'tree' ? 'active' : ''}" id="v-tree">tree</button>
      <button class="seg-btn ${TASK.view === 'table' ? 'active' : ''}" id="v-table">table</button>
    </div>`;
  $('#v-tree').addEventListener('click', () => { TASK.view = 'tree'; renderFleet(); });
  $('#v-table').addEventListener('click', () => { TASK.view = 'table'; renderFleet(); });
}

async function loadFleet() {
  const content = $('#task-content');
  try { TASK.all = await api('GET', '/api/tasks'); }
  catch (e) { content.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  renderFleet();
}

function fleetFiltered() {
  const f = TASK.f;
  return TASK.all.filter((t) => {
    if (f.priority.size && !f.priority.has(String(t.priority))) return false;
    if (f.stage.size && !f.stage.has(t.column)) return false;
    if (f.type.size && !f.type.has(t.type)) return false;
    if (f.role.size && !f.role.has(t.assigned_role)) return false;
    if (f.site.size && !f.site.has(t.site)) return false;
    if (f.blocked === 'yes' && !t.blocked_on) return false;
    if (f.blocked === 'no' && t.blocked_on) return false;
    return true;
  }).sort((a, b) => (STAGE_ORDER[a.column] - STAGE_ORDER[b.column])
    || ((a.priority ?? 9) - (b.priority ?? 9))
    || String(a.created || '9999').localeCompare(String(b.created || '9999')));
}

function pill(group, val, label, extraCls = '') {
  const on = group === 'blocked' ? TASK.f.blocked === val : TASK.f[group].has(val);
  return `<button class="pill ${on ? 'active ' + extraCls : ''}" data-group="${group}" data-val="${esc(val)}">${esc(label)}</button>`;
}

function renderFleet() {
  const content = $('#task-content');
  const all = TASK.all;
  const types = [...new Set(all.map((t) => t.type).filter(Boolean))].sort();
  const roles = [...new Set(all.map((t) => t.assigned_role).filter(Boolean))].sort();
  const sites = [...new Set(all.map((t) => t.site))].sort();
  const rows = fleetFiltered();
  const counts = { total: rows.length, ip: rows.filter((t) => t.column === 'in-progress').length, bl: rows.filter((t) => t.column === 'backlog').length };
  const fc = TASK.f;
  const active = fc.priority.size + fc.stage.size + fc.type.size + fc.role.size + fc.site.size + (fc.blocked ? 1 : 0);

  const filterPanel = `
    <details class="filter-panel" data-rk="filters" ${active ? 'open' : ''}>
      <summary>Filters ${active ? `<span class="badge b-blue">${active} active</span>` : ''}
        ${active ? '<a id="clear-filters" class="filter-clear">clear all</a>' : ''}</summary>
      <div class="filter-row"><span class="filter-label">priority</span><div class="pill-group">
        ${[['1', 'P1', 'p1'], ['2', 'P2', 'p2'], ['3', 'P3', 'p3'], ['4', 'P4', 'pn'], ['5', 'P5', 'pn']].map(([v, l, c]) => pill('priority', v, l, c)).join('')}</div></div>
      <div class="filter-row"><span class="filter-label">stage</span><div class="pill-group">
        ${COLS.map((c) => pill('stage', c, STAGE_LABEL[c])).join('')}</div></div>
      ${types.length ? `<div class="filter-row"><span class="filter-label">type</span><div class="pill-group">${types.map((t) => pill('type', t, t)).join('')}</div></div>` : ''}
      ${roles.length ? `<div class="filter-row"><span class="filter-label">role</span><div class="pill-group">${roles.map((r) => pill('role', r, r)).join('')}</div></div>` : ''}
      <div class="filter-row"><span class="filter-label">site</span><div class="pill-group">${sites.map((s) => pill('site', s, s)).join('')}</div></div>
      <div class="filter-row"><span class="filter-label">blocked</span><div class="pill-group">
        ${pill('blocked', 'no', 'not blocked')}${pill('blocked', 'yes', 'blocked only')}</div></div>
    </details>`;

  const counter = `<div class="tasks-top"><span class="task-count">${counts.ip} in-progress · ${counts.bl} not started · ${counts.total} shown</span></div>`;
  const list = rows.length ? (TASK.view === 'tree' ? fleetTree(rows) : fleetTable(rows)) : '<p class="empty">No tasks match.</p>';
  content.innerHTML = counter + filterPanel + list;

  $$('.pill').forEach((p) => p.addEventListener('click', () => togglePill(p.dataset.group, p.dataset.val)));
  const clr = $('#clear-filters');
  if (clr) clr.addEventListener('click', () => { for (const k of ['priority', 'stage', 'type', 'role', 'site']) TASK.f[k].clear(); TASK.f.blocked = ''; renderFleet(); });
  $$('.tree-task, .ttr').forEach((el) => el.addEventListener('click', () => openTaskModal({ mode: 'edit', site: el.dataset.site, column: el.dataset.col, file: el.dataset.file })));
  $$('.tree-all').forEach((b) => b.addEventListener('click', () => $$('.tree-site').forEach((d) => { d.open = b.dataset.open === '1'; })));
  if (!FRESH) applyUISnap();
  stamp();
}

function togglePill(group, val) {
  if (group === 'blocked') { TASK.f.blocked = TASK.f.blocked === val ? '' : val; }
  else { const s = TASK.f[group]; s.has(val) ? s.delete(val) : s.add(val); }
  renderFleet();
}

function fleetTree(rows) {
  const bySite = {};
  for (const t of rows) (bySite[t.site] = bySite[t.site] || []).push(t);
  const groups = Object.entries(bySite).sort((a, b) => b[1].length - a[1].length);
  const ctrls = `<div class="tree-controls"><button class="tree-all" data-open="1">expand all</button><button class="tree-all" data-open="0">collapse all</button></div>`;
  const body = groups.map(([site, tasks]) => {
    const ip = tasks.filter((t) => t.column === 'in-progress').length;
    const bl = tasks.filter((t) => t.column === 'backlog').length;
    let lastStage = '';
    const items = tasks.map((t) => {
      const label = t.column !== lastStage ? (lastStage = t.column, `<div class="tree-stage-label">${STAGE_LABEL[t.column]}</div>`) : '';
      return label + `<div class="tree-task ${t.blocked_on ? 'task-blocked' : ''}" data-site="${esc(t.site)}" data-col="${esc(t.column)}" data-file="${esc(t.file)}">
        <span class="prio ${prioClass(t.priority)} tree-pri">${t.priority != null ? 'P' + esc(t.priority) : '—'}</span>
        <span class="tree-type">${esc(t.type || '')}</span>
        <span class="tree-title">${esc(t.title)}${t.blocked_on ? '<span class="blocked-tag">blocked</span>' : ''}</span>
        <span class="tree-role">${esc(t.assigned_role || '')}</span>
        <span class="tree-est">${t.estimated_turns ? '~' + esc(t.estimated_turns) + 't' : ''}</span>
      </div>`;
    }).join('');
    return `<details class="tree-site" open data-rk="tree:${esc(site)}"><summary class="tree-summary">
        <span class="tree-site-name">${esc(site)}</span>
        <span class="tree-meta">${ip ? `<span class="badge b-blue">${ip} in-progress</span>` : ''}${bl ? `<span class="badge b-gray">${bl} not started</span>` : ''}</span>
      </summary><div class="tree-tasks">${items}</div></details>`;
  }).join('');
  return ctrls + `<div class="tree-list">${body}</div>`;
}

function fleetTable(rows) {
  let lastStage = '';
  const body = rows.map((t) => {
    const divider = t.column !== lastStage ? (lastStage = t.column, `<tr class="stage-divider"><td colspan="7">${STAGE_LABEL[t.column]}</td></tr>`) : '';
    return divider + `<tr class="ttr ${t.blocked_on ? 'task-blocked' : ''}" data-site="${esc(t.site)}" data-col="${esc(t.column)}" data-file="${esc(t.file)}">
      <td><span class="prio ${prioClass(t.priority)}">${t.priority != null ? 'P' + esc(t.priority) : '—'}</span></td>
      <td class="mono">${esc(t.site)}</td>
      <td><span class="badge b-gray">${STAGE_LABEL[t.column]}</span></td>
      <td>${esc(t.type || '')}</td>
      <td>${esc(t.title)}${t.blocked_on ? '<span class="blocked-tag">blocked</span>' : ''}</td>
      <td>${esc(t.assigned_role || '')}</td>
      <td class="mono">${esc(t.created || '')}</td>
    </tr>`;
  }).join('');
  return `<div class="card"><table class="tasks-table">
    <thead><tr><th>P</th><th>Site</th><th>Stage</th><th>Type</th><th>Title</th><th>Role</th><th>Created</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

/* ---- shared editor / CRUD ---- */
async function openTaskModal({ mode, site, column, file }) {
  const modal = $('#modal'), title = $('#modal-title'), bodyEl = $('#modal-body');
  site = site || STATE.taskSite || STATE.sites[0];
  let meta = { priority: 2 }, body = '';
  loadedMeta = {};

  if (mode === 'edit') {
    try { const t = await api('GET', `/api/tasks/${encodeURIComponent(site)}/${encodeURIComponent(column)}/${encodeURIComponent(file)}`);
      loadedMeta = t.meta || {}; meta = { ...loadedMeta }; body = t.body || '';
    } catch (e) { toast(e.message, 'err'); return; }
  }
  // F16: bulk assignment — create mode only. A checkbox swaps the single-site
  // select for a multi-select; on save, the same POST the single-site path
  // already uses is looped client-side, one task file per selected site
  // (mirrors pushAllSites' "loop + await" bulk pattern — no new bulk endpoint).
  const siteSel = mode === 'create'
    ? `<div class="field" id="f-site-wrap"><label>Site</label><select id="f-site">${STATE.sites.map((s) => `<option value="${esc(s)}" ${s === site ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
       <div class="field"><label><input type="checkbox" id="f-bulk-toggle" /> Assign to multiple sites</label></div>
       <div class="field hidden" id="f-bulk-wrap">
         <label>Sites (ctrl/cmd-click to select multiple)</label>
         <select id="f-sites-multi" multiple size="6">${STATE.sites.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}</select>
         <span class="muted" style="font-size:11px">Creates one copy of this task per selected site.</span>
       </div>`
    : '';
  title.textContent = mode === 'create' ? 'New task' : `Edit · ${site} · ${file}`;

  const colOpts = (sel) => COLS.map((c) => `<option value="${c}" ${c === sel ? 'selected' : ''}>${COL_LABEL[c]}</option>`).join('');
  const roleSet = [...new Set([...ROLES, meta.assigned_role].filter(Boolean))];
  const roleOpts = ['<option value="">—</option>', ...roleSet.map((r) => `<option value="${esc(r)}" ${r === meta.assigned_role ? 'selected' : ''}>${esc(r)}</option>`)].join('');

  bodyEl.innerHTML = `
    ${siteSel}
    <div class="field"><label>Title</label><input id="f-title" value="${esc(meta.title || '')}" placeholder="Short imperative summary" /></div>
    <div class="row3">
      <div class="field"><label>Priority</label><select id="f-priority">${[0, 1, 2, 3, 4, 5].map((p) => `<option value="${p}" ${String(meta.priority) === String(p) ? 'selected' : ''}>P${p}</option>`).join('')}</select></div>
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
    bulkToggle.addEventListener('change', (e) => {
      $('#f-site-wrap').classList.toggle('hidden', e.target.checked);
      $('#f-bulk-wrap').classList.toggle('hidden', !e.target.checked);
    });
  }
}

function collectMeta() {
  const num = (v) => v === '' || v == null ? undefined : Number(v);
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
  if (!meta.title) { toast('Title is required', 'err'); return; }

  const bulkToggle = $('#f-bulk-toggle');
  if (mode === 'create' && bulkToggle && bulkToggle.checked) {
    const sites = [...$('#f-sites-multi').selectedOptions].map((o) => o.value);
    if (!sites.length) { toast('Select at least one site', 'err'); return; }
    const saveBtn = $('#f-save'); gdBusy(saveBtn, true);
    let ok = 0; const failed = [];
    for (const s of sites) {
      try {
        await api('POST', `/api/tasks/${encodeURIComponent(s)}/${encodeURIComponent(targetCol)}`, { ...meta, body });
        ok++;
      } catch (e) { failed.push(`${s}: ${e.message}`); }
    }
    toast(`Created task on ${ok}/${sites.length} site(s)${failed.length ? ' · failed: ' + failed.join('; ') : ''}`, failed.length ? 'err' : 'ok');
    closeModal();
    if (TASK.mode === 'board') loadBoard(); else loadFleet();
    return;
  }

  const targetSite = mode === 'create' ? ($('#f-site') ? $('#f-site').value : site) : site;
  const base = `/api/tasks/${encodeURIComponent(targetSite)}`;
  try {
    if (mode === 'create') {
      await api('POST', `${base}/${encodeURIComponent(targetCol)}`, { ...meta, body });
      toast('Task created');
    } else {
      await api('PUT', `${base}/${encodeURIComponent(origColumn)}/${encodeURIComponent(file)}`, { meta, body });
      if (targetCol !== origColumn) await api('POST', `${base}/${encodeURIComponent(origColumn)}/${encodeURIComponent(file)}/move`, { to: targetCol });
      toast('Task saved');
    }
    closeModal();
    if (TASK.mode === 'board') loadBoard(); else loadFleet();
  } catch (e) { toast(e.message, 'err'); }
}

async function deleteTask(site, column, file) {
  if (!confirm(`Delete task "${file}"?\n\nIt's moved to ops/tasks/.trash/ (recoverable), not permanently removed.`)) return;
  try {
    await api('DELETE', `/api/tasks/${encodeURIComponent(site)}/${encodeURIComponent(column)}/${encodeURIComponent(file)}`);
    toast('Task moved to trash'); closeModal();
    if (TASK.mode === 'board') loadBoard(); else loadFleet();
  } catch (e) { toast(e.message, 'err'); }
}

function closeModal() { $('#modal').classList.add('hidden'); ROLE_OPEN = null; }

/* ===================== CRON ===================== */
// Crontab-line control plane, folded in from the retired cron-manager tool.
// Operates at the crontab-LINE level (edit schedule, comment/remove a line,
// diff vs the baked-in crontab, revert, rebuild) across sites/* AND tools/*.
const CM = {
  bySlug: new Map(),
  collapsed: cmLoadCollapsed(),
  rebuildLog: new Map(),          // slug → last rebuild output (this session)
  runLog: new Map(),              // "slug:role" → last run output (this session)
  editing: null,                  // { slug, lineIndex } while inline-editing
};
function cmLoadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem('fd.cron.collapsed') || '[]')); }
  catch { return new Set(); }
}
function cmSaveCollapsed() {
  try { localStorage.setItem('fd.cron.collapsed', JSON.stringify([...CM.collapsed])); } catch {}
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
  if (FRESH) app.innerHTML = '<div class="loading">Reading crontabs…</div>';
  let systems;
  try { systems = await api('GET', '/api/cron/systems'); }
  catch (e) { app.innerHTML = `<div class="empty">Cron read failed: ${esc(e.message)}</div>`; return; }

  CM.bySlug.clear();
  systems.forEach((s) => CM.bySlug.set(s.slug, s));
  // Failed / stale / down float to the top for immediate visibility.
  systems.sort((a, b) => {
    const rank = (s) => s.failed ? 0 : (s.needsRebuild ? 1 : s.status === 'running' ? 2 : 3);
    return rank(a) - rank(b);
  });

  const running = systems.filter((s) => s.status === 'running').length;
  const failed = systems.filter((s) => s.failed);
  const dirty = systems.filter((s) => s.needsRebuild).length;

  app.innerHTML = `
    <div class="page-head"><h2 class="page-title">Cron</h2><span class="muted">every crontab across ${systems.length} systems · edit a schedule, diff vs the running container, rebuild</span></div>
    <div class="task-toolbar">
      <strong>${systems.length} systems</strong>
      <span class="muted"><span class="cm-st on"></span>${running} running · <span class="cm-st off"></span>${failed.length} failed · ${dirty} need rebuild</span>
      <button class="btn sm" id="cm-collapse-all" style="margin-left:auto">Collapse all</button>
      <button class="btn sm" id="cm-expand-all">Expand all</button>
    </div>
    <div class="cm-systems">${systems.map((s) => cmCard(s)).join('')}</div>
    <p class="muted" style="margin-top:12px">Each card is one cron container (a site or tool). Edits write the on-disk <span class="mono">crontab.docker</span>; the container keeps running its baked-in copy until you <b>Rebuild &amp; restart</b>. <b>Pause/Resume</b> on a worker role toggles its <span class="mono">.&lt;role&gt;-disabled</span> flag (instant, no rebuild). <span class="cm-badge stale">stale</span> = disk crontab changed since the last build — rebuild or revert.</p>`;

  cmWireCards();
  // Apply to the DOM directly, NOT via softRender() — softRender captures the
  // current [data-rk] visibility and re-applies it in applyUISnap(), which would
  // clobber the collapse state we just set (the cards would bounce right back).
  $('#cm-collapse-all').addEventListener('click', () => { systems.forEach((s) => CM.collapsed.add(s.slug)); cmSaveCollapsed(); cmApplyCollapsed(); });
  $('#cm-expand-all').addEventListener('click', () => { CM.collapsed.clear(); cmSaveCollapsed(); cmApplyCollapsed(); });
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

function cmCard(sys) {
  const collapsed = CM.collapsed.has(sys.slug);
  const st = sys.status;
  const isStale = st === 'running' && sys.needsRebuild;
  const badgeCls = sys.failed ? 'failed' : isStale ? 'stale' : st === 'running' ? 'running' : 'stopped';
  const badgeLabel = isStale ? 'stale' : st;
  const exit = sys.exitCode != null ? ` · exit ${sys.exitCode}` : '';
  const badgeTitle = isStale
    ? esc((sys.statusText || st) + ' · crontab changed since last build')
    : esc((sys.statusText || st) + exit);

  const rows = sys.entries.length
    ? sys.entries.map((e) => cmRow(sys, e)).join('')
    : '<tr><td colspan="5" class="muted">No cron entries.</td></tr>';

  const foot = [
    `<button class="btn sm primary cm-rebuild${sys.needsRebuild ? ' dirty' : ''}" data-slug="${esc(sys.slug)}">⟳ Rebuild &amp; restart</button>`,
    `<button class="btn sm cm-logs" data-slug="${esc(sys.slug)}" data-source="container">📜 Logs</button>`,
  ];
  if (isStale) {
    foot.push(`<button class="btn sm cm-diff" data-slug="${esc(sys.slug)}">≡ View diff</button>`);
    foot.push(`<button class="btn sm danger cm-revert" data-slug="${esc(sys.slug)}">↩ Revert</button>`);
  }
  const hint = sys.needsRebuild
    ? `<span class="cm-hint">${isStale ? 'running stale crontab — rebuild or revert' : 'crontab changed — rebuild to apply'}</span>`
    : '';

  return `<section class="cm-card${sys.failed ? ' cm-failed' : ''}" data-fleet-row data-site="${esc(sys.kind === 'site' ? sys.slug : '')}">
    <div class="cm-head" data-slug="${esc(sys.slug)}">
      <button class="cm-collapse" data-slug="${esc(sys.slug)}" aria-expanded="${!collapsed}" title="${collapsed ? 'Expand' : 'Collapse'}">${collapsed ? '▸' : '▾'}</button>
      <span class="cm-name">${esc(sys.slug)}</span>
      <span class="cm-kind">${esc(sys.kind)}</span>
      <span class="cm-badge ${badgeCls}" title="${badgeTitle}">${esc(badgeLabel)}</span>
      ${sys.needsRebuild && !isStale ? '<span class="cm-badge stale">needs rebuild</span>' : ''}
      <span class="cm-container mono">${esc(sys.container)}</span>
    </div>
    <div class="cm-body${collapsed ? ' hidden' : ''}" data-rk="cron:${esc(sys.slug)}">
      <table class="cm-jobs">
        <thead><tr><th>State</th><th>Job</th><th>Schedule</th><th>Last run</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="cm-foot">${foot.join(' ')}${hint}
        <button class="btn sm cm-addjob" data-slug="${esc(sys.slug)}" style="margin-left:auto">+ Add job</button>
      </div>
    </div>
  </section>`;
}

function cmRow(sys, e) {
  const r = cmRel(e.lastRun);
  const exCls = e.lastExit === 0 ? 'ok' : (e.lastExit != null ? 'bad' : '');
  const last = r
    ? `<span class="cm-last${e.hasLog ? ' cm-clickable' : ''}" data-slug="${esc(sys.slug)}" data-role="${esc(e.role || '')}" title="${esc(e.lastRun)}${e.lastExit != null ? ' · exit ' + e.lastExit : ''}">${exCls ? `<span class="cm-ex ${exCls}"></span>` : ''}${esc(r)}</span>`
    : '<span class="muted">—</span>';
  const job = e.role
    ? `<span class="cm-job" title="${esc(e.command)}">${esc(e.role)}</span>`
    : `<span class="cm-job cmd" title="${esc(e.command)}">${esc(e.command)}</span>`;

  const acts = [
    `<button class="btn sm cm-toggle" data-line="${e.lineIndex}">${e.enabled ? 'Pause' : 'Resume'}</button>`,
    `<button class="btn sm cm-edit" data-line="${e.lineIndex}">Edit</button>`,
  ];
  if (e.hasLog) acts.push(`<button class="btn sm cm-rolelog" data-role="${esc(e.role)}">Log</button>`);
  if (e.role && sys.status === 'running') acts.push(`<button class="btn sm cm-run" data-role="${esc(e.role)}">Run</button>`);
  acts.push(`<button class="btn sm danger cm-remove" data-line="${e.lineIndex}">Remove</button>`);

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
  return sys ? sys.entries.find((e) => e.lineIndex === Number(lineIndex)) : null;
}

function cmWireCards() {
  $$('.cm-collapse').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); cmToggleCollapse(b.dataset.slug); }));
  $$('.cm-head').forEach((h) => h.addEventListener('click', (ev) => { if (ev.target.closest('button')) return; cmToggleCollapse(h.dataset.slug); }));
  $$('.cm-rebuild').forEach((b) => b.addEventListener('click', () => cmDoRebuild(b.dataset.slug, b)));
  $$('.cm-logs').forEach((b) => b.addEventListener('click', () => cmOpenLogs(b.dataset.slug, b.dataset.source)));
  $$('.cm-diff').forEach((b) => b.addEventListener('click', () => cmOpenDiff(b.dataset.slug)));
  $$('.cm-revert').forEach((b) => b.addEventListener('click', () => cmDoRevert(b.dataset.slug)));
  $$('.cm-toggle').forEach((b) => b.addEventListener('click', () => cmToggleJob(b.closest('tr').dataset.slug, b.dataset.line)));
  $$('.cm-edit').forEach((b) => b.addEventListener('click', () => cmEditJob(b.closest('tr'))));
  $$('.cm-remove').forEach((b) => b.addEventListener('click', () => cmRemoveJob(b.closest('tr').dataset.slug, b.dataset.line)));
  $$('.cm-run').forEach((b) => b.addEventListener('click', () => cmRunJob(b.closest('tr').dataset.slug, b.dataset.role, b)));
  $$('.cm-rolelog').forEach((b) => b.addEventListener('click', () => cmOpenLogs(b.closest('tr').dataset.slug, `role:${b.dataset.role}`)));
  $$('.cm-last.cm-clickable').forEach((s) => s.addEventListener('click', () => { if (s.dataset.role) cmOpenLogs(s.dataset.slug, `role:${s.dataset.role}`); }));
  $$('.cm-addjob').forEach((b) => b.addEventListener('click', () => cmOpenAddJob(b.dataset.slug)));
}

function cmToggleCollapse(slug) {
  if (CM.collapsed.has(slug)) CM.collapsed.delete(slug); else CM.collapsed.add(slug);
  cmSaveCollapsed();
  cmApplyCollapsed(slug);
}

// Reflect CM.collapsed into the DOM (body .hidden + chevron) without a re-render,
// so it survives applyUISnap(). Pass a slug to update one card, or omit for all.
function cmApplyCollapsed(slug) {
  const btns = slug ? $$(`.cm-collapse[data-slug="${CSS.escape(slug)}"]`) : $$('.cm-collapse');
  btns.forEach((btn) => {
    const s = btn.dataset.slug;
    const collapsed = CM.collapsed.has(s);
    const body = $(`.cm-body[data-rk="cron:${CSS.escape(s)}"]`);
    if (body) body.classList.toggle('hidden', collapsed);
    btn.textContent = collapsed ? '▸' : '▾';
    btn.setAttribute('aria-expanded', String(!collapsed));
  });
}

/* ---- inline schedule editor ---- */
const CM_PRESETS = [
  ['*/15 * * * *', 'Every 15 min'], ['0 * * * *', 'Hourly'], ['*/30 * * * *', 'Every 30 min'],
  ['0 6 * * *', 'Daily 6am'], ['0 7 * * 1', 'Mon 7am'], ['0 9 1 * *', 'Monthly'],
];
function cmCloseEditor() { $$('.cm-editor-row').forEach((r) => r.remove()); CM.editing = null; }

function cmEditJob(tr) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('cm-editor-row')) { cmCloseEditor(); return; }
  cmCloseEditor();
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
      if (!expr) { verdict.className = 'cm-ed-verdict'; verdict.textContent = ''; input.className = 'cm-input cm-cron'; save.disabled = true; return; }
      try {
        const v = await api('GET', '/api/cron/describe?expr=' + encodeURIComponent(expr));
        valid = v.valid;
        input.className = 'cm-input cm-cron ' + (v.valid ? 'valid' : 'invalid');
        verdict.className = 'cm-ed-verdict ' + (v.valid ? 'good' : 'bad');
        verdict.textContent = v.valid ? v.human : (v.error || 'invalid');
        save.disabled = !v.valid || !changed;
      } catch { verdict.textContent = ''; }
    }, 180);
  };
  input.addEventListener('input', check);
  $$('.cm-preset', row).forEach((p) => p.addEventListener('click', () => { input.value = p.dataset.v; input.focus(); check(); }));
  $('.cm-ed-cancel', row).addEventListener('click', cmCloseEditor);
  save.addEventListener('click', async () => {
    if (!valid) return;
    save.disabled = true;
    await cmPostCrontab(slug, { action: 'edit', lineIndex: e.lineIndex, newSchedule: input.value.trim(), expectedRawLine: e.rawLine });
  });
  input.focus(); input.select(); check();
}

/* ---- F28: add a new cron line ---- */
function cmCloseAddJob() { $$('.cm-addjob-row').forEach((r) => r.remove()); }

function cmOpenAddJob(slug) {
  cmCloseEditor(); cmCloseAddJob();
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
        verdict.className = 'cm-ed-verdict'; verdict.textContent = '';
        schedInp.className = 'cm-input cm-cron cm-aj-sched'; save.disabled = true; return;
      }
      try {
        const v = await api('GET', '/api/cron/describe?expr=' + encodeURIComponent(expr));
        valid = v.valid;
        schedInp.className = 'cm-input cm-cron cm-aj-sched ' + (v.valid ? 'valid' : 'invalid');
        verdict.className = 'cm-ed-verdict ' + (v.valid ? 'good' : 'bad');
        verdict.textContent = v.valid ? `${v.human} — ${cmd}` : (v.error || 'invalid');
        save.disabled = !v.valid;
      } catch { verdict.textContent = ''; }
    }, 180);
  };
  kindSel.addEventListener('change', () => { syncKindUI(); check(); });
  roleInp.addEventListener('input', check);
  cmdInp.addEventListener('input', check);
  schedInp.addEventListener('input', check);
  $$('.cm-preset', row).forEach((p) => p.addEventListener('click', () => { schedInp.value = p.dataset.v; schedInp.focus(); check(); }));
  $('.cm-aj-cancel', row).addEventListener('click', cmCloseAddJob);
  save.addEventListener('click', async () => {
    if (!valid) return;
    const command = currentCommand();
    if (!command) { toast('Enter a role or command', 'err'); return; }
    save.disabled = true;
    try {
      await api('POST', `/api/cron/systems/${encodeURIComponent(slug)}/crontab`, { action: 'add', newSchedule: schedInp.value.trim(), command });
      toast('Added to crontab — rebuild to apply');
      cmCloseAddJob();
      softRender();
    } catch (e) { toast(`add failed: ${e.message}`, 'err'); save.disabled = false; }
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
      await api('POST', `/api/cron/systems/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(e.role)}/${e.enabled ? 'disable' : 'enable'}`);
      toast(`${e.enabled ? 'Paused' : 'Resumed'} ${e.role} on ${slug}`);
    } else {
      await api('POST', `/api/cron/systems/${encodeURIComponent(slug)}/crontab`, { action: e.enabled ? 'comment' : 'uncomment', lineIndex: e.lineIndex, expectedRawLine: e.rawLine });
      toast(`${e.enabled ? 'Disabled' : 'Enabled'} line — rebuild to apply`);
    }
    softRender();
  } catch (err) { toast(`failed: ${err.message}`, 'err'); }
}

async function cmRemoveJob(slug, line) {
  const e = cmEntry(slug, line);
  if (!e) return;
  if (!confirm(`Remove this line from ${slug}'s crontab?\n\n${e.rawLine}`)) return;
  await cmPostCrontab(slug, { action: 'remove', lineIndex: e.lineIndex, expectedRawLine: e.rawLine });
}

async function cmPostCrontab(slug, payload) {
  try {
    await api('POST', `/api/cron/systems/${encodeURIComponent(slug)}/crontab`, payload);
    toast('Saved to crontab — rebuild to apply');
    cmCloseEditor();
    softRender();
  } catch (e) { toast(`change failed: ${e.message}`, 'err'); }
}

/* ---- run now (streamed) ---- */
async function cmRunJob(slug, role, btn) {
  const orig = btn.textContent; btn.disabled = true; btn.textContent = '…';
  let text = '';
  try {
    const r = await fetch(`/api/cron/systems/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(role)}/run`, { method: 'POST' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const reader = r.body.getReader(); const dec = new TextDecoder();
    for (;;) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value); }
  } catch (err) { text += `\nclient error: ${err.message}`; }
  const m = text.match(/@@RUN_EXIT (-?\d+)/);
  const code = m ? parseInt(m[1], 10) : null;
  CM.runLog.set(`${slug}:${role}`, text.replace(/@@RUN_EXIT[^\n]*\n?/g, ''));
  btn.disabled = false; btn.textContent = orig;
  toast(code === 0 ? `${role} completed — open Logs ▸ run:${role}` : `${role} exited ${code ?? '?'} — see Logs`, code === 0 ? 'ok' : 'err');
  softRender();
}

/* ---- rebuild (streamed) ---- */
async function cmDoRebuild(slug, btn) {
  if (!confirm(`Rebuild and restart ${slug}'s cron container?\n\nBuilds the image then recreates the container (can take a minute).`)) return;
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Rebuilding…';
  toast(`Rebuilding ${slug} — this can take a minute…`);
  let text = '';
  try {
    const r = await fetch(`/api/cron/systems/${encodeURIComponent(slug)}/rebuild`, { method: 'POST' });
    const reader = r.body.getReader(); const dec = new TextDecoder();
    for (;;) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value); }
  } catch (e) { text += `\nclient error: ${e.message}`; }
  CM.rebuildLog.set(slug, text.replace(/@@VERDICT.*\n?/g, ''));
  const ok = /@@VERDICT ok\b/.test(text);
  btn.disabled = false; btn.textContent = orig;
  toast(ok ? `${slug} cron restarted` : `${slug} failed to start — open Logs ▸ Last rebuild`, ok ? 'ok' : 'err');
  softRender();
}

/* ---- diff viewer ---- */
function cmDiffLines(running, disk) {
  const a = (running || '').split('\n');
  const b = (disk || '').split('\n');
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const out = []; let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) { out.unshift({ type: 'same', line: a[i - 1] }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { out.unshift({ type: 'add', line: b[j - 1] }); j--; }
    else { out.unshift({ type: 'del', line: a[i - 1] }); i--; }
  }
  return out;
}
let CM_DIFF_SLUG = null;
async function cmOpenDiff(slug) {
  CM_DIFF_SLUG = slug;
  $('#cm-diff-title').textContent = `crontab diff — ${slug}`;
  const out = $('#cm-diff-out'); out.textContent = 'Loading…';
  $('#cm-diff-meta').textContent = '';
  $('#cm-diff-modal').classList.remove('hidden');
  try {
    const { disk, running } = await api('GET', `/api/cron/systems/${encodeURIComponent(slug)}/diff`);
    if (running === null) { out.textContent = 'Container is not running — cannot read baked crontab.'; $('#cm-diff-meta').textContent = 'no running container'; return; }
    const lines = cmDiffLines(running, disk);
    const adds = lines.filter((l) => l.type === 'add').length;
    const dels = lines.filter((l) => l.type === 'del').length;
    out.innerHTML = lines.map(({ type, line }) => {
      const e = esc(line);
      if (type === 'add') return `<span class="cm-dl-add">+ ${e}</span>`;
      if (type === 'del') return `<span class="cm-dl-del">- ${e}</span>`;
      return `<span class="cm-dl-same">  ${e}</span>`;
    }).join('\n');
    $('#cm-diff-meta').textContent = (adds || dels) ? `+${adds} / -${dels} lines vs running` : 'no differences (content matches)';
  } catch (e) { out.textContent = e.message; }
}
function cmCloseDiff() { $('#cm-diff-modal').classList.add('hidden'); CM_DIFF_SLUG = null; }

async function cmDoRevert(slug) {
  if (!confirm(`Overwrite ${slug}'s crontab.docker with the version baked into the running container?\n\nYour on-disk changes will be discarded.`)) return;
  try {
    await api('POST', `/api/cron/systems/${encodeURIComponent(slug)}/revert`);
    cmCloseDiff();
    toast(`Reverted ${slug} to the running container's crontab`);
    softRender();
  } catch (e) { toast(`revert failed: ${e.message}`, 'err'); }
}

/* ---- log viewer ---- */
const CMLV = { slug: null, source: 'container', raw: '' };
async function cmOpenLogs(slug, source) {
  const sys = CM.bySlug.get(slug);
  CMLV.slug = slug; CMLV.source = source || 'container';
  $('#cm-log-title').textContent = sys ? sys.container : slug;
  const sources = (sys && sys.logSources ? sys.logSources : [{ id: 'container', label: 'Container' }]).slice();
  if (CM.rebuildLog.has(slug) && !sources.some((s) => s.id === 'rebuild')) sources.splice(1, 0, { id: 'rebuild', label: 'Last rebuild' });
  for (const key of CM.runLog.keys()) {
    if (!key.startsWith(slug + ':')) continue;
    const role = key.slice(slug.length + 1);
    if (!sources.some((s) => s.id === `run:${role}`)) sources.push({ id: `run:${role}`, label: `run: ${role}` });
  }
  const seg = $('#cm-log-sources');
  seg.innerHTML = sources.map((s) => `<button data-id="${esc(s.id)}">${esc(s.label)}</button>`).join('');
  $$('#cm-log-sources button', seg).forEach((b) => b.addEventListener('click', () => { CMLV.source = b.dataset.id; cmFetchLogs(); }));
  $('#cm-log-modal').classList.remove('hidden');
  cmFetchLogs();
}
async function cmFetchLogs() {
  $$('#cm-log-sources button').forEach((b) => b.classList.toggle('active', b.dataset.id === CMLV.source));
  const out = $('#cm-log-out');
  const tail = $('#cm-log-tail').value;
  if (CMLV.source === 'rebuild' && CM.rebuildLog.has(CMLV.slug)) {
    CMLV.raw = CM.rebuildLog.get(CMLV.slug);
  } else if (CMLV.source.startsWith('run:')) {
    CMLV.raw = CM.runLog.get(`${CMLV.slug}:${CMLV.source.slice(4)}`) ?? '(no run output in this session)';
  } else {
    out.textContent = 'Loading…';
    try { CMLV.raw = await (await fetch(`/api/cron/systems/${encodeURIComponent(CMLV.slug)}/logs?source=${encodeURIComponent(CMLV.source)}&tail=${tail}`)).text(); }
    catch (e) { CMLV.raw = `failed to load logs: ${e.message}`; }
  }
  cmApplyLogFilter();
  $('#cm-log-meta').textContent = `${CMLV.source} · tail ${tail}`;
  out.scrollTop = out.scrollHeight;
}
function cmApplyLogFilter() {
  const f = $('#cm-log-filter').value.trim().toLowerCase();
  const lines = CMLV.raw.split('\n');
  const shown = f ? lines.filter((l) => l.toLowerCase().includes(f)) : lines;
  $('#cm-log-out').textContent = shown.join('\n');
  $('#cm-log-count').textContent = f ? `${shown.length} / ${lines.length} lines` : `${lines.length} lines`;
}
function cmCloseLogs() { $('#cm-log-modal').classList.add('hidden'); }

// Wire the cron modals' static controls once at boot.
function cmWireModals() {
  $('#cm-log-close').addEventListener('click', cmCloseLogs);
  $('#cm-log-modal').addEventListener('click', (e) => { if (e.target.id === 'cm-log-modal') cmCloseLogs(); });
  $('#cm-log-filter').addEventListener('input', cmApplyLogFilter);
  $('#cm-log-tail').addEventListener('change', cmFetchLogs);
  $('#cm-log-reload').addEventListener('click', cmFetchLogs);
  $('#cm-log-wrap').addEventListener('change', (e) => $('#cm-log-out').classList.toggle('cm-wrap', e.target.checked));
  $('#cm-log-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#cm-log-out').textContent); toast('Copied'); } catch { toast('Copy failed', 'err'); } });
  $('#cm-log-download').addEventListener('click', () => {
    const blob = new Blob([CMLV.raw], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${CMLV.slug}-${CMLV.source.replace(':', '-')}.log`;
    a.click(); URL.revokeObjectURL(a.href);
  });
  $('#cm-diff-close').addEventListener('click', cmCloseDiff);
  $('#cm-diff-close2').addEventListener('click', cmCloseDiff);
  $('#cm-diff-modal').addEventListener('click', (e) => { if (e.target.id === 'cm-diff-modal') cmCloseDiff(); });
  $('#cm-diff-revert').addEventListener('click', () => { if (CM_DIFF_SLUG) cmDoRevert(CM_DIFF_SLUG); });
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
  if (FRESH) app.innerHTML = '<div class="muted">loading data hub…</div>';
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

  // ---- Panel 2b: Site Pulls (inbound — who consumed what, when) ----
  const pulls = (pl && pl.pulls) || [];
  const plRows = pulls.map((p) => {
    const who = p.site ? siteLink(p.site) : `<span class="dh-host">${esc(p.endpoint || '')}</span>`;
    return `<tr>
      <td class="dh-time">${esc((p.ts || '').replace('T', ' ').slice(0, 19))}</td>
      <td>${who}</td>
      <td class="dh-host">${esc(p.endpoint || '')}</td>
      <td><b>${esc(String(p.item_count ?? 0))}</b></td>
      <td class="dh-ip">${esc(p.client_ip || '—')}</td>
    </tr>`;
  }).join('');
  const pullsHtml = `
    <table class="dh-egress dh-pulls">
      <thead><tr><th>when</th><th>consumer</th><th>endpoint</th><th>items</th><th>client IP</th></tr></thead>
      <tbody>${plRows || '<tr><td colspan="5" class="muted">no pulls yet</td></tr>'}</tbody>
    </table>`;

  // ---- Panel 3: Source Freshness (+ enabled/disabled toggle) ----
  const srcs = (src && src.sources) || [];
  const enabledCount = srcs.filter((s) => s.enabled !== false).length;
  const disabledCount = srcs.length - enabledCount;
  const srcRows = srcs.map((s) => {
    const st = (s.state || {});
    const off = s.enabled === false;
    const stale = (!off && st.stale) ? ' · <span class="dh-stale">stale</span>' : '';
    const ovr = s.overridden ? ' <span class="dh-ovr" title="overridden — differs from the registry default">override</span>' : '';
    const statusCell = off ? '<span class="dh-b dh-skip">disabled</span>' : `${dhBadge(st.status)}${stale}`;
    const toggle = `<button class="btn sm ${off ? 'primary' : 'danger'} dh-src-toggle" data-id="${esc(s.id)}" data-enabled="${off ? 0 : 1}">${off ? '▶ Enable' : '⏸ Disable'}</button>`;
    return `<tr class="${off ? 'dh-row-off' : ''}">
      <td>${esc(s.id)}${ovr}</td>
      <td>${esc(s.type)}</td>
      <td>${statusCell}</td>
      <td class="dh-time">${esc((st.last_fetch_at || '').replace('T', ' ').slice(0, 19) || '—')}</td>
      <td class="dh-srcctl">${toggle}</td>
    </tr>`;
  }).join('');
  const srcHtml = `
    <div class="dh-srccount">${enabledCount} enabled${disabledCount ? ` · <span class="dh-stale">${disabledCount} disabled</span>` : ''}</div>
    <table class="dh-sources">
      <thead><tr><th>source</th><th>type</th><th>status</th><th>last fetch</th><th></th></tr></thead>
      <tbody>${srcRows || '<tr><td colspan="5" class="muted">no source state</td></tr>'}</tbody>
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
      <section class="dh-panel dh-wide" data-rk="dh-pulls"><h3>Site Pulls <span class="dh-sub-h">inbound — who consumed what</span> <span class="live-tag">live</span></h3>${pullsHtml}</section>
      <section class="dh-panel" data-rk="dh-sources"><h3>Source Freshness</h3>${srcHtml}</section>
      <section class="dh-panel" data-rk="dh-datasets"><h3>Datasets</h3>${dsHtml}</section>
      <section class="dh-panel dh-wide" data-rk="dh-matrix"><h3>Source × Site Matrix</h3>${matrixHtml}</section>
    </div>`;

  // Wire the per-source enable/disable toggles (re-bound every render).
  $$('.dh-src-toggle').forEach((b) =>
    b.addEventListener('click', () => dhToggleSource(b.dataset.id, b.dataset.enabled === '1', b)));

  if (!FRESH) applyUISnap();
}

// Toggle a hub source's enabled/disabled override, then soft-refresh the view.
// The change persists in the hub and takes effect on the next collect cycle.
async function dhToggleSource(id, currentlyEnabled, btn) {
  gdBusy(btn, true);
  const r = await api('POST', `/api/datahub/sources/${encodeURIComponent(id)}/enabled`, { enabled: !currentlyEnabled });
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
  return value ? `<span class="badge b-green">${esc(yes)}</span>` : `<span class="badge b-red">${esc(no)}</span>`;
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
  if (key === 'ga4') return (row.measurementIds || []).join(', ') || (c.ga4 == null ? '' : String(c.ga4));
  return c[key] == null ? -1 : Number(c[key]);
}

function openComplianceDetail(row) {
  const modal = $('#modal'), title = $('#modal-title'), body = $('#modal-body');
  const c = row.checks || {}, ev = row.evidence || {};
  const statusCls = row.status === 'pass' ? 'b-green' : row.status === 'fail' ? 'b-red' : 'b-gray';
  const item = (label, value, explanation) => `<div class="compliance-detail-row">
    <div>${complianceCheck(value, 'passed', 'failed')}</div>
    <div><strong>${esc(label)}</strong><div class="muted">${esc(explanation)}</div></div>
  </div>`;
  const extLink = (url, label) => url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`
    : '<span class="muted">No deployed link captured</span>';
  const gaText = c.ga4
    ? `Detected ${esc((row.measurementIds || []).join(', ') || 'a Google tag')}.`
    : 'No GA4 tag was detected; analytics consent gating is not applicable.';
  const consentText = c.ga4 === false ? gaText : c.gaConsentGated
    ? `${gaText} The deployed source contains ${c.defaultDenied ? 'default-denied Google Consent Mode' : 'basic consent-gating logic that controls tag loading from the saved visitor choice'}.`
    : `${gaText} No default-denied or basic gating evidence was found.`;
  const history = (row.history || []).slice().reverse();
  const historyStats = row.historyStats || {};
  const historyHtml = history.length
    ? history.map((entry) => `<div class="compliance-history-item">
        <span class="badge ${entry.status === 'pass' ? 'b-green' : entry.status === 'fail' ? 'b-red' : 'b-gray'}">${esc(entry.status)}</span>
        <span>${esc(new Date(entry.checkedAt).toLocaleString())}</span>
        <span class="muted">${esc(entry.change || '')}${entry.errorType ? ` · ${esc(entry.errorType)}` : ''}</span>
      </div>`).join('')
    : '<span class="muted">History will appear after this site is scanned.</span>';

  title.textContent = `${row.site} — compliance evidence`;
  body.innerHTML = `
    <div class="compliance-detail-head">
      <span class="badge ${statusCls}">${esc(row.status)}</span>
      <span>${extLink(row.url, 'Open scanned homepage')}</span>
      <span class="muted">Checked ${esc(row.checkedAt ? new Date(row.checkedAt).toLocaleString() : 'not yet')}</span>
    </div>
    <p class="compliance-detail-summary">${row.status === 'pass'
      ? 'This site passed the automated technical baseline because every required cookie/analytics check below was detected in the deployed page or its same-origin JavaScript.'
      : row.status === 'fail' ? esc((row.failures || []).join('; ') || 'One or more required checks failed.')
        : esc(row.error || 'The live site could not be verified.')}</p>
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
  if (FRESH) app.innerHTML = '<div class="loading">Loading live compliance evidence…</div>';
  let rows, trend;
  try { [rows, trend] = await Promise.all([api('GET', '/api/compliance'), api('GET', '/api/compliance/history?limit=18')]); }
  catch (e) { app.innerHTML = `<div class="empty">Compliance scan failed: ${esc(e.message)}</div>`; return; }

  const counts = { pass: 0, fail: 0, unknown: 0 };
  rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const lastScan = rows.reduce((latest, row) => {
    const time = row.checkedAt ? Date.parse(row.checkedAt) : 0;
    return time > latest ? time : latest;
  }, 0);
  const staleCutoff = Date.now() - (24 * 60 * 60 * 1000);
  const staleCount = rows.filter((row) => !row.checkedAt || Date.parse(row.checkedAt) < staleCutoff).length;
  const issueGroups = [
    ['banner', 'Banner missing'], ['accept', 'Accept missing'], ['reject', 'Reject missing'],
    ['gaConsentGated', 'GA consent ungated'], ['privacy', 'Privacy missing'], ['terms', 'Terms missing'],
  ].map(([key, label]) => ({ key, label, count: rows.filter((row) => complianceCheckFailed(row, key)).length }))
    .filter((group) => group.count)
    .sort((a, b) => b.count - a.count);
  const unknownGroups = Object.entries(rows.filter((row) => row.status === 'unknown').reduce((out, row) => {
    const key = row.errorType || 'network';
    out[key] = (out[key] || 0) + 1;
    return out;
  }, {})).sort((a, b) => b[1] - a[1]);
  const trendHtml = trend.length
    ? `<div class="compliance-trend" title="Fleet pass rate over recent scan windows">${trend.map((point) =>
      `<i style="height:${Math.max(3, point.passRate * .24)}px" title="${esc(new Date(point.at).toLocaleString())}: ${point.passRate}% pass"></i>`).join('')}<span>${trend[trend.length - 1].passRate}% pass</span></div>`
    : '<span class="muted">Trend begins after the next scan</span>';
  const rowHtml = (r) => {
    const c = r.checks || {};
    const statusCls = r.status === 'pass' ? 'b-green' : r.status === 'fail' ? 'b-red' : 'b-gray';
    const ga = c.ga4 == null ? complianceCheck(null) : c.ga4
      ? `<span class="badge b-blue">${esc((r.measurementIds || []).join(', ') || 'detected')}</span>`
      : '<span class="muted">not detected</span>';
    const evidence = r.error || (r.failures || []).join('; ') || `live HTML + ${r.assetsChecked || 0} same-origin JS bundle(s)`;
    const checked = r.checkedAt ? new Date(r.checkedAt).toLocaleString() : 'not scanned';
    const change = r.change && r.change !== 'unchanged'
      ? `<span class="badge compliance-change ${r.change === 'resolved' ? 'b-green' : r.change === 'regressed' ? 'b-red' : 'b-yellow'}">${esc(r.change)}</span>`
      : '';
    const diagnostic = r.status === 'unknown' ? `<span class="badge b-gray">${esc(r.errorType || 'network')}</span> ` : '';
    return `<tr data-fleet-row data-site="${esc(r.site)}">
      <td class="site">${siteLink(r.site)}</td>
      <td><button class="badge ${statusCls} compliance-status" data-site="${esc(r.site)}" title="Show compliance evidence for ${esc(r.site)}">${esc(r.status)}</button> ${change}</td>
      <td>${complianceCheck(c.banner, 'present', 'missing')}</td>
      <td>${complianceCheck(c.accept, 'present', 'missing')}</td>
      <td>${complianceCheck(c.reject, 'present', 'missing')}</td>
      <td>${ga}</td>
      <td>${c.ga4 === false ? '<span class="muted">N/A</span>' : complianceCheck(c.gaConsentGated, 'gated', 'ungated')}</td>
      <td>${complianceCheck(c.privacy, 'linked', 'missing')}</td>
      <td>${complianceCheck(c.terms, 'linked', 'missing')}</td>
      <td class="compliance-evidence" title="${esc(evidence)}">${diagnostic}${esc(evidence)}</td>
      <td class="mono">${esc(checked)}</td>
      <td><button class="btn sm compliance-rescan" data-site="${esc(r.site)}" title="Rescan only ${esc(r.site)}">↻ Rescan</button></td>
    </tr>`;
  };
  const sortHeader = (label, key) => {
    const active = COMPLIANCE_UI.sort === key;
    const arrow = active ? (COMPLIANCE_UI.direction === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th><button class="compliance-sort${active ? ' active' : ''}" data-sort="${key}" title="Sort by ${esc(label)}">${esc(label)}<span aria-hidden="true">${arrow}</span></button></th>`;
  };

  app.innerHTML = `
    <div class="page-head"><h2 class="page-title">Compliance</h2><span class="muted">Live technical privacy baseline — not legal certification</span><span class="muted compliance-last-scan">Last scan: ${esc(lastScan ? new Date(lastScan).toLocaleString() : 'not yet scanned')}</span></div>
    <div class="task-toolbar compliance-toolbar">
      <strong>${rows.length} domains</strong>
      <button class="badge b-green compliance-filter-tag" data-status="pass" aria-pressed="${COMPLIANCE_UI.statuses.has('pass')}">${counts.pass} pass</button>
      <button class="badge b-red compliance-filter-tag" data-status="fail" aria-pressed="${COMPLIANCE_UI.statuses.has('fail')}">${counts.fail} fail</button>
      <button class="badge b-gray compliance-filter-tag" data-status="unknown" aria-pressed="${COMPLIANCE_UI.statuses.has('unknown')}">${counts.unknown} unknown</button>
      <button id="compliance-open-only" class="btn sm compliance-toggle${COMPLIANCE_UI.openOnly ? ' active' : ''}" aria-pressed="${COMPLIANCE_UI.openOnly}">Open items</button>
      <button id="compliance-stale-only" class="btn sm compliance-toggle${COMPLIANCE_UI.staleOnly ? ' active' : ''}" aria-pressed="${COMPLIANCE_UI.staleOnly}">${staleCount} stale</button>
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
      <button id="compliance-scan" class="btn sm" style="margin-left:auto">↻ Scan live sites now</button>
    </div>
    <div id="compliance-progress" class="compliance-progress hidden"><div><span id="compliance-progress-label">Preparing scan…</span><span id="compliance-progress-sites" class="muted"></span></div><progress id="compliance-progress-bar" value="0" max="1"></progress></div>
    <div class="compliance-overview">
      <div class="compliance-groups"><strong>Open findings</strong>${issueGroups.length
        ? issueGroups.map((group) => `<button class="compliance-group" data-check="${group.key}"><span>${esc(group.label)}</span><b>${group.count}</b></button>`).join('')
        : '<span class="muted">No failed checks</span>'}</div>
      <div class="compliance-groups"><strong>Unknown diagnostics</strong>${unknownGroups.length
        ? unknownGroups.map(([type, count]) => `<span class="compliance-group static"><span>${esc(type)}</span><b>${count}</b></span>`).join('')
        : '<span class="muted">No unknown scans</span>'}</div>
      <div class="compliance-trend-wrap"><strong>Pass-rate trend</strong>${trendHtml}</div>
    </div>
    <div class="compliance-note">A pass requires a detected cookie consent UI with both accept and reject choices, a Privacy Policy, and Terms. If GA4 is present, it must show default-denied consent mode or basic consent gating. “Unknown” means the deployed site could not be verified; it is never treated as a pass or failure.</div>
    <div class="card compliance-table"><table>
      <thead><tr>${sortHeader('Site', 'site')}${sortHeader('Status', 'status')}${sortHeader('Banner', 'banner')}${sortHeader('Accept', 'accept')}${sortHeader('Reject', 'reject')}${sortHeader('GA4', 'ga4')}${sortHeader('GA consent', 'gaConsentGated')}${sortHeader('Privacy', 'privacy')}${sortHeader('Terms', 'terms')}${sortHeader('Evidence / issue', 'evidence')}${sortHeader('Checked', 'checkedAt')}<th>Action</th></tr></thead>
      <tbody id="compliance-body"></tbody>
    </table></div>`;
  $('#compliance-check-filter').value = COMPLIANCE_UI.check;

  const bySite = new Map(rows.map((row) => [row.site, row]));
  const updateRows = () => {
    const query = COMPLIANCE_UI.search.trim().toLowerCase();
    const visible = rows.filter((row) =>
      (!query || row.site.toLowerCase().includes(query))
      && (!COMPLIANCE_UI.statuses.size || COMPLIANCE_UI.statuses.has(row.status))
      && (!COMPLIANCE_UI.openOnly || row.status !== 'pass')
      && (!COMPLIANCE_UI.staleOnly || !row.checkedAt || Date.parse(row.checkedAt) < staleCutoff)
      && (COMPLIANCE_UI.check === 'all' || complianceCheckFailed(row, COMPLIANCE_UI.check)));
    const multiplier = COMPLIANCE_UI.direction === 'asc' ? 1 : -1;
    visible.sort((a, b) => {
      const av = complianceSortValue(a, COMPLIANCE_UI.sort);
      const bv = complianceSortValue(b, COMPLIANCE_UI.sort);
      return multiplier * (typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }));
    });
    $('#compliance-body').innerHTML = visible.map(rowHtml).join('')
      || `<tr><td colspan="12" class="muted">${rows.length ? 'No sites match the current filters' : 'No domains discovered'}</td></tr>`;
    $('#compliance-visible-count').textContent = `Showing ${visible.length} of ${rows.length}`;
    $$('.compliance-status').forEach((button) => button.addEventListener('click', () => openComplianceDetail(bySite.get(button.dataset.site))));
    $$('.compliance-rescan').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true; button.textContent = 'Scanning…';
      try {
        await api('POST', `/api/compliance/${encodeURIComponent(button.dataset.site)}/scan`);
        toast(`${button.dataset.site} scan complete`);
        renderCompliance();
      } catch (e) { toast(`scan failed: ${e.message}`, 'err'); button.disabled = false; button.textContent = '↻ Rescan'; }
    }));
  };
  updateRows();
  $('#compliance-search').addEventListener('input', (event) => {
    COMPLIANCE_UI.search = event.currentTarget.value;
    updateRows();
  });
  $('#compliance-check-filter').addEventListener('change', (event) => {
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
  $$('.compliance-group[data-check]').forEach((button) => button.addEventListener('click', () => {
    COMPLIANCE_UI.check = button.dataset.check;
    $('#compliance-check-filter').value = COMPLIANCE_UI.check;
    updateRows();
  }));
  $$('.compliance-filter-tag').forEach((button) => button.addEventListener('click', () => {
    const status = button.dataset.status;
    if (COMPLIANCE_UI.statuses.has(status)) COMPLIANCE_UI.statuses.delete(status);
    else COMPLIANCE_UI.statuses.add(status);
    $$('.compliance-filter-tag').forEach((tag) => tag.setAttribute('aria-pressed', String(COMPLIANCE_UI.statuses.has(tag.dataset.status))));
    updateRows();
  }));
  $$('.compliance-sort').forEach((button) => button.addEventListener('click', () => {
    const key = button.dataset.sort;
    if (COMPLIANCE_UI.sort === key) COMPLIANCE_UI.direction = COMPLIANCE_UI.direction === 'asc' ? 'desc' : 'asc';
    else { COMPLIANCE_UI.sort = key; COMPLIANCE_UI.direction = 'asc'; }
    renderCompliance();
  }));
  $('#compliance-scan').addEventListener('click', async (event) => {
    const btn = event.currentTarget; btn.disabled = true; btn.textContent = 'Scanning…';
    try { await api('POST', '/api/compliance/scan'); pollComplianceProgress(); }
    catch (e) { toast(`scan failed: ${e.message}`, 'err'); btn.disabled = false; btn.textContent = '↻ Scan live sites now'; }
  });
  pollComplianceProgress();
  if (!FRESH) applyUISnap();
  stamp();
}

async function pollComplianceProgress() {
  clearTimeout(COMPLIANCE_PROGRESS_TIMER);
  if (STATE.view !== 'compliance') return;
  let progress;
  try { progress = await api('GET', '/api/compliance/progress'); } catch { return; }
  const box = $('#compliance-progress'), button = $('#compliance-scan');
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
  $('#compliance-progress-label').textContent = `${progress.completed} / ${progress.total} sites scanned`;
  $('#compliance-progress-sites').textContent = progress.currentSites.length ? `Currently: ${progress.currentSites.join(', ')}` : '';
  const bar = $('#compliance-progress-bar'); bar.max = Math.max(1, progress.total); bar.value = progress.completed;
  COMPLIANCE_PROGRESS_TIMER = setTimeout(pollComplianceProgress, 750);
}

let ANALYTICS_SITE = null; // persists across soft-refreshes

function anDelta(cur, prev) {
  if (prev == null) return '';
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
  if (FRESH) app.innerHTML = '<div class="loading">Loading lint sweep…</div>';
  let d;
  try { d = await api('GET', '/api/lint'); }
  catch (e) { app.innerHTML = `<div class="empty">Lint sweep failed: ${esc(e.message)}</div>`; return; }

  const running = d.progress && d.progress.running;
  if (!d.report) {
    app.innerHTML = `
      <div class="page-head"><h2 class="page-title">Lint</h2><span class="muted">fleet-wide prettier parse + format sweep</span></div>
      <div class="task-toolbar">
        <button class="btn" id="lint-scan" ${running ? 'disabled' : ''}>${running ? 'Sweeping…' : 'Run sweep'}</button>
        <span class="muted">No sweep has run on this host yet.</span>
      </div>`;
    wireLintButtons();
    if (running) setTimeout(() => { if (STATE.view === 'lint') softRender(); }, 5000);
    return;
  }

  const r = d.report;
  const s = r.summary || {};
  const swept = r.generated_at ? fmtAge((Date.now() - new Date(r.generated_at).getTime()) / 1000) + ' ago' : 'unknown';
  const newErrors = r.new_parse_errors || [];

  const rows = (r.sites || []).filter((row) => row.status === 'broken' || row.status === 'drift').map((row) => {
    const open = LINT.open.has(row.site);
    const errs = (row.parse_errors || []).map((e) => `<li><span class="mono">${esc(e.file)}</span><div class="muted">${esc(e.message)}</div></li>`).join('');
    const drift = (row.unformatted || []).map((f) => `<li class="mono muted">${esc(f)}</li>`).join('');
    return `<tr data-fleet-row data-site="${esc(row.site)}">
      <td class="site"><a href="#" class="lint-open" data-site="${esc(row.site)}">${esc(row.site)}</a></td>
      <td>${lintStatusBadge(row.status)}</td>
      <td class="mono">${(row.parse_errors || []).length}</td>
      <td class="mono muted">${(row.unformatted || []).length}</td>
      <td class="mono muted">${row.files_checked}</td>
      <td><button class="btn sm lint-rescan" data-site="${esc(row.site)}" ${running ? 'disabled' : ''}>Rescan</button></td>
    </tr>
    <tr class="cn-detail-row${open ? '' : ' hidden'}" data-detail="lint:${esc(row.site)}" data-rk="lint:${esc(row.site)}"><td colspan="6">
      ${errs ? `<div class="cn-log-head">Prettier cannot parse — the pre-commit hook is skipping these</div><ul>${errs}</ul>` : ''}
      ${drift ? `<div class="cn-log-head muted">Unformatted (auto-fixes on next commit that stages them)</div><ul>${drift}</ul>` : ''}
    </td></tr>`;
  }).join('');

  app.innerHTML = `
    <div class="page-head"><h2 class="page-title">Lint</h2><span class="muted">fleet-wide prettier parse + format sweep — the detector for files the pre-commit hook silently skips</span></div>
    <div class="task-toolbar">
      <strong>${s.parse_errors || 0} unparseable file(s) across ${s.broken || 0} site(s)</strong>
      <span class="muted">${s.unformatted || 0} merely unformatted · ${s.clean || 0} clean · ${s.files_checked || 0} files checked · swept ${esc(swept)}</span>
      <button class="btn" id="lint-scan" ${running ? 'disabled' : ''}>${running ? 'Sweeping…' : 'Rescan fleet'}</button>
    </div>
    ${newErrors.length ? `<div class="card" style="margin-bottom:10px"><div class="cn-log-head">New since the previous sweep (${newErrors.length})</div><ul>${newErrors.map((e) => `<li class="mono">${esc(e.site)}/${esc(e.file)}</li>`).join('')}</ul></div>` : ''}
    <div class="card"><table>
      <thead><tr><th>Site</th><th>Status</th><th>Parse errors</th><th>Unformatted</th><th>Files</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">Every site is clean.</td></tr>'}</tbody>
    </table></div>
    <p class="muted" style="margin-top:12px">A <strong>parse error</strong> is the real signal: <span class="mono">tools/git-hooks/pre-commit</span> pipes prettier through xargs and ignores its exit code, so an unparseable file is never formatted and nothing reports it. Fix the source (JSX-style <span class="mono">{/* … */}</span> comments inside template expressions, no raw <span class="mono">&lt;svg&gt;</span> in attributes, no script bodies inside template expressions) rather than adding a <span class="mono">.prettierignore</span>. Sites shown clean are omitted from the table.</p>`;

  $$('.lint-open').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); lintToggle(a.dataset.site); }));
  wireLintButtons();
  if (running) setTimeout(() => { if (STATE.view === 'lint') softRender(); }, 5000);
  if (!FRESH) applyUISnap();
  applyFleetFilter();
  stamp();
}

function lintToggle(site) {
  const row = $(`tr[data-detail="lint:${CSS.escape(site)}"]`);
  if (!row) return;
  if (LINT.open.has(site)) { LINT.open.delete(site); row.classList.add('hidden'); return; }
  LINT.open.add(site);
  row.classList.remove('hidden');
}

function wireLintButtons() {
  const all = $('#lint-scan');
  if (all) all.addEventListener('click', () => lintScan(all, null));
  $$('.lint-rescan').forEach((b) => b.addEventListener('click', () => lintScan(b, b.dataset.site)));
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

function dhiBadge(status) {
  const s = String(status || '');
  let cls = 'dhi-b';
  if (s === 'ok' || s === 'active') cls += ' dhi-ok';
  else if (s.startsWith('skipped') || s === 'pending') cls += ' dhi-skip';
  else if (s === 'error' || s.startsWith('error') || s === 'blacklisted' || s === 'deleted') cls += ' dhi-err';
  return `<span class="${cls}">${esc(s || '—')}</span>`;
}

function dhiPathBadge(policy, exitNode) {
  if (policy === 'direct') return `<span class="dhi-path dhi-direct">direct</span>`;
  return `<span class="dhi-path dhi-vpn">vpn:${esc(exitNode || '?')}</span>`;
}

function dhiCountTable(title, counts) {
  const rows = Object.entries(counts || {}).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(k || '—')}</td><td><b>${esc(String(v))}</b></td></tr>`).join('');
  return `
    <div class="dhi-countblock">
      <div class="dhi-countblock-h">${esc(title)}</div>
      <table class="dhi-counts"><tbody>${rows || '<tr><td colspan="2" class="muted">none</td></tr>'}</tbody></table>
    </div>`;
}

async function renderDataHubImages() {
  const app = $('#app');
  if (FRESH) app.innerHTML = '<div class="muted">loading data hub images…</div>';
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
  const statsHtml = hubDown ? '<div class="muted">unavailable</div>' : `
    <div class="dhi-stats-grid">
      ${dhiCountTable('by topic', stats.pool_by_topic)}
      ${dhiCountTable('by source', stats.pool_by_source)}
      ${dhiCountTable('by license', stats.pool_by_license)}
      ${dhiCountTable('requests by status', stats.requests_by_status)}
    </div>`;

  // ---- Panel 3: Recent Images (thumbnail grid + curation actions) ----
  const images = (imgs && imgs.images) || [];
  const thumbs = images.map((im) => {
    const credit = im.credit || {};
    const creditLine = credit.photographer || credit.source
      ? `${esc(credit.photographer || '')}${credit.photographer && credit.source ? ' · ' : ''}${esc(credit.source || '')}`
      : esc(im.source_id || '');
    return `
      <div class="dhi-thumb" data-rk="dhi-img-${esc(im.id)}">
        <img src="/api/datahub-images/image/${encodeURIComponent(im.id)}" loading="lazy" alt="${creditLine}" />
        <div class="dhi-thumb-meta">
          <div class="dhi-thumb-credit">${creditLine}</div>
          <div class="dhi-thumb-sub">${esc(im.license || '—')} · score ${esc(String(im.score ?? '—'))} · ${dhiBadge(im.status)}</div>
          <div class="dhi-thumb-actions">
            <button class="btn sm danger dhi-blacklist" data-id="${esc(im.id)}">Blacklist</button>
            <button class="btn sm danger dhi-reject" data-id="${esc(im.id)}">Reject</button>
          </div>
        </div>
      </div>`;
  }).join('');
  const thumbsHtml = `<div class="dhi-thumbs">${thumbs || '<div class="muted">no images in the pool</div>'}</div>`;

  // ---- Panel 4: Source Freshness (+ enabled/disabled toggle) ----
  const srcs = (src && src.sources) || [];
  const enabledCount = srcs.filter((s) => s.enabled !== false).length;
  const disabledCount = srcs.length - enabledCount;
  const srcRows = srcs.map((s) => {
    const st = s.state || {};
    const off = s.enabled === false;
    const stale = (!off && st.stale) ? ' · <span class="dhi-stale">stale</span>' : '';
    const ovr = s.overridden ? ' <span class="dhi-ovr" title="overridden — differs from the registry default">override</span>' : '';
    const statusCell = off ? '<span class="dhi-b dhi-skip">disabled</span>' : `${dhiBadge(st.status)}${stale}`;
    const toggle = `<button class="btn sm ${off ? 'primary' : 'danger'} dhi-src-toggle" data-id="${esc(s.id)}" data-enabled="${off ? 0 : 1}">${off ? '▶ Enable' : '⏸ Disable'}</button>`;
    return `<tr class="${off ? 'dhi-row-off' : ''}">
      <td>${esc(s.id)}${ovr}</td>
      <td>${esc(s.kind)}</td>
      <td>${dhiPathBadge(s.policy, s.exit)}</td>
      <td>${statusCell}</td>
      <td class="dhi-time">${esc((st.last_fetch_at || '').replace('T', ' ').slice(0, 19) || '—')}</td>
      <td class="dhi-srcctl">${toggle}</td>
    </tr>`;
  }).join('');
  const srcHtml = `
    <div class="dhi-srccount">${enabledCount} enabled${disabledCount ? ` · <span class="dhi-stale">${disabledCount} disabled</span>` : ''}</div>
    <table class="dhi-sources">
      <thead><tr><th>source</th><th>kind</th><th>path</th><th>status</th><th>last fetch</th><th></th></tr></thead>
      <tbody>${srcRows || '<tr><td colspan="6" class="muted">no source state</td></tr>'}</tbody>
    </table>`;

  // ---- Panel 5: Outbound Connection Ledger (egress) ----
  const events = (eg && eg.events) || [];
  const egRows = events.map((e) => `
    <tr>
      <td class="dhi-time">${esc((e.ts || '').replace('T', ' ').slice(0, 19))}</td>
      <td>${esc(e.source_id || '')}</td>
      <td class="dhi-host">${esc(e.target_host || '')}</td>
      <td>${dhiPathBadge(e.policy, e.exit_node)}</td>
      <td class="dhi-ip">${esc(e.exit_ip || '—')}</td>
      <td>${dhiBadge(e.status)}</td>
      <td class="dhi-note">${esc(e.note || '')}</td>
    </tr>`).join('');
  const egressHtml = `
    <table class="dhi-egress">
      <thead><tr><th>when</th><th>source</th><th>target</th><th>path</th><th>exit IP</th><th>status</th><th>note</th></tr></thead>
      <tbody>${egRows || '<tr><td colspan="7" class="muted">no egress events yet</td></tr>'}</tbody>
    </table>`;

  // ---- Panel 6: Site Pulls (inbound — who consumed what) ----
  const pulls = (pl && pl.pulls) || [];
  const plRows = pulls.map((p) => {
    const who = p.site ? siteLink(p.site) : `<span class="dhi-host">${esc(p.endpoint || '')}</span>`;
    return `<tr>
      <td class="dhi-time">${esc((p.ts || '').replace('T', ' ').slice(0, 19))}</td>
      <td>${who}</td>
      <td class="dhi-host">${esc(p.endpoint || '')}</td>
      <td><b>${esc(String(p.item_count ?? 0))}</b></td>
      <td class="dhi-ip">${esc(p.client_ip || '—')}</td>
    </tr>`;
  }).join('');
  const pullsHtml = `
    <table class="dhi-egress dhi-pulls">
      <thead><tr><th>when</th><th>consumer</th><th>endpoint</th><th>items</th><th>client IP</th></tr></thead>
      <tbody>${plRows || '<tr><td colspan="5" class="muted">no pulls yet</td></tr>'}</tbody>
    </table>`;

  app.innerHTML = `
    ${hubDown ? `<div class="dhi-banner">⚠ Data hub images API unreachable</div>` : ''}
    <div class="dhi-grid">
      <section class="dhi-panel" data-rk="dhi-health"><h3>VPN Health</h3>${healthHtml}</section>
      <section class="dhi-panel" data-rk="dhi-stats"><h3>Pool Stats</h3>${statsHtml}</section>
      <section class="dhi-panel dhi-wide" data-rk="dhi-images"><h3>Recent Images <span class="live-tag">live</span></h3>${thumbsHtml}</section>
      <section class="dhi-panel" data-rk="dhi-sources"><h3>Source Freshness</h3>${srcHtml}</section>
      <section class="dhi-panel dhi-wide" data-rk="dhi-egress"><h3>Outbound Connection Ledger <span class="live-tag">live</span></h3>${egressHtml}</section>
      <section class="dhi-panel dhi-wide" data-rk="dhi-pulls"><h3>Site Pulls <span class="dhi-sub-h">inbound — who consumed what</span> <span class="live-tag">live</span></h3>${pullsHtml}</section>
    </div>`;

  // Wire the per-source toggle + per-image curation buttons (re-bound every render).
  $$('.dhi-src-toggle').forEach((b) =>
    b.addEventListener('click', () => dhiToggleSource(b.dataset.id, b.dataset.enabled === '1', b)));
  $$('.dhi-blacklist').forEach((b) =>
    b.addEventListener('click', () => dhiBlacklist(b.dataset.id, b)));
  $$('.dhi-reject').forEach((b) =>
    b.addEventListener('click', () => dhiReject(b.dataset.id, b)));

  if (!FRESH) applyUISnap();
}

// Toggle a data-hub-images source's enabled/disabled override, then soft-refresh.
async function dhiToggleSource(id, currentlyEnabled, btn) {
  gdBusy(btn, true);
  const r = await api('POST', `/api/datahub-images/sources/${encodeURIComponent(id)}/enabled`, { enabled: !currentlyEnabled });
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

/* ===================== SHELL ===================== */
const TOP_VIEWS = ['control', 'cron', 'containers', 'git', 'tasks', 'taskbudget', 'aiinventory', 'aiusage', 'datahub', 'datahubimages', 'productfeed', 'analytics', 'compliance', 'lint', 'deploys', 'errors', 'activity', 'devsandbox', 'sitefacts'];

// Hash router. Routes: #control, #cron, #containers, #git, #tasks, #agents/<role>.
// Legacy aliases: #roles → control, #fleet → agents/engineer.
function parseHash() {
  const h = (location.hash || '').replace(/^#/, '');
  if (!h) return { view: 'control', agent: null };
  const parts = h.split('/');
  const [a, b, c] = parts;
  if (a === 'agents' && b) return { view: 'agent', agent: decodeURIComponent(b) };
  if (a === 'fleet') return { view: 'agent', agent: 'engineer' };
  if (a === 'roles') return { view: 'control', agent: null };
  if (a === 'git' && b && c === 'stashes') return { view: 'gitstashes', agent: null, gitSlug: decodeURIComponent(b) };
  if (TOP_VIEWS.includes(a)) return { view: a, agent: null };
  return { view: 'control', agent: null };
}
function hashFor(view, agent) { return view === 'agent' ? `agents/${encodeURIComponent(agent)}` : view; }

// FRESH = true → a navigation/first paint: show loading placeholders.
// FRESH = false → an in-place soft refresh: no loading flash, and each view
// restores scroll + expanded rows from UISNAP after it repaints.
let FRESH = true;
let UISNAP = { open: {}, html: {}, scroll: 0 };

// Snapshot the bits of UI state a full re-render would otherwise discard:
// every [data-rk] element's open/visible state, the inner HTML of lazily
// filled panels ([data-rkh], e.g. expanded git detail), and scroll position.
function captureUI() {
  const open = {}, html = {};
  $$('[data-rk]').forEach((el) => { open[el.dataset.rk] = el.tagName === 'DETAILS' ? el.open : !el.classList.contains('hidden'); });
  $$('[data-rkh]').forEach((el) => { html[el.dataset.rkh] = el.innerHTML; });
  return { open, html, scroll: window.scrollY };
}
function applyUISnap() {
  const s = UISNAP; if (!s) return;
  $$('[data-rkh]').forEach((el) => { const v = s.html[el.dataset.rkh]; if (v && v.trim()) el.innerHTML = v; });
  $$('[data-rk]').forEach((el) => {
    if (!(el.dataset.rk in s.open)) return;
    if (el.tagName === 'DETAILS') el.open = s.open[el.dataset.rk];
    else el.classList.toggle('hidden', !s.open[el.dataset.rk]);
  });
  if (typeof s.scroll === 'number') window.scrollTo(0, s.scroll);
}

function render() {
  $$('.tab[data-view]').forEach((t) => t.classList.toggle('active', t.dataset.view === STATE.view));
  const ddBtn = $('#agents-btn'); if (ddBtn) ddBtn.classList.toggle('active', STATE.view === 'agent');
  document.body.dataset.view = STATE.view;   // lets CSS widen specific views
  syncAgentsMenuActive();
  if (STATE.view === 'control') renderControl();
  else if (STATE.view === 'cron') renderCron();
  else if (STATE.view === 'agent') renderAgent(STATE.agent);
  else if (STATE.view === 'containers') renderContainers();
  else if (STATE.view === 'git') renderGit();
  else if (STATE.view === 'gitstashes') renderGitStashes(STATE.gitSlug);
  else if (STATE.view === 'tasks') renderTasks();
  else if (STATE.view === 'taskbudget') renderTaskBudget();
  else if (STATE.view === 'aiinventory') renderAIInventory();
  else if (STATE.view === 'aiusage') renderAIUsage();
  else if (STATE.view === 'datahub') renderDataHub();
  else if (STATE.view === 'datahubimages') renderDataHubImages();
  else if (STATE.view === 'productfeed') renderProductFeed();
  else if (STATE.view === 'analytics') renderAnalytics();
  else if (STATE.view === 'compliance') renderCompliance();
  else if (STATE.view === 'lint') renderLint();
  else if (STATE.view === 'deploys') renderDeployHealth();
  else if (STATE.view === 'errors') renderErrors();
  else if (STATE.view === 'activity') renderActivity();
  else if (STATE.view === 'devsandbox') renderDevSandbox();
  else if (STATE.view === 'sitefacts') renderSiteFacts();
}

function renderAgent(role) {
  if (role === 'engineer') renderEngineers();
  else renderGenericAgent(role);
}

// In-place refresh of the current view: capture UI state, repaint without the
// loading flash, then the view restores state from UISNAP as it finishes.
function softRender() {
  UISNAP = captureUI();
  FRESH = false;
  render();
}

function go(view, agent) {
  STATE.view = view; STATE.agent = agent || null;
  const hash = hashFor(view, agent);
  if (location.hash !== `#${hash}`) location.hash = hash;   // shareable + back-button
  FRESH = true;
  render();
}

/* ---- agents dropdown ---- */
function buildAgentsMenu() {
  const menu = $('#agents-menu');
  if (!menu) return;
  menu.innerHTML = (STATE.agents || []).map((a) =>
    `<a class="dd-item" data-role="${esc(a.role)}">${esc(agentLabel(a.role))}<span class="dd-count">${a.sites}</span></a>`).join('')
    || '<span class="dd-empty">no agents found</span>';
  $$('.dd-item', menu).forEach((it) => it.addEventListener('click', () => { closeAgentsMenu(); go('agent', it.dataset.role); }));
  syncAgentsMenuActive();
}
function syncAgentsMenuActive() {
  $$('#agents-menu .dd-item').forEach((it) => it.classList.toggle('active', STATE.view === 'agent' && it.dataset.role === STATE.agent));
}
function toggleAgentsMenu() { $('#agents-menu').classList.toggle('hidden'); }
function closeAgentsMenu() { const m = $('#agents-menu'); if (m) m.classList.add('hidden'); }

// Breadcrumb shown atop every agent page.
function breadcrumb(role) {
  return `<div class="crumbs"><a class="crumb-link" id="crumb-control">Domain Control</a><span class="crumb-sep">›</span><span class="muted">Agents</span><span class="crumb-sep">›</span><span class="crumb-cur">${esc(agentLabel(role))}</span></div>`;
}
function wireCrumbs() { const c = $('#crumb-control'); if (c) c.addEventListener('click', () => go('control')); }

/* ---- auto-refresh ---- */
let autoTimer = null, countTimer = null, nextAt = 0;

function autoCfg() {
  return {
    on: localStorage.getItem('fd.auto') !== '0',                       // default ON
    interval: parseInt(localStorage.getItem('fd.interval') || '15000', 10) || 15000,
  };
}
function applyAutoUI() {
  const { on, interval } = autoCfg();
  const cb = $('#auto-on'), sel = $('#auto-int');
  if (cb) cb.checked = on;
  if (sel) sel.value = String(interval);
  document.body.classList.toggle('auto-on', on);
}
function updateCountdown() {
  const next = $('#auto-next'); if (!next) return;
  if (!autoCfg().on) { next.textContent = 'paused'; return; }
  if (SSE_LIVE) { next.textContent = '● live'; return; }   // pushed by the SSE channel
  const s = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
  next.textContent = `↻ ${s}s`;
}
function scheduleAuto() {
  clearInterval(autoTimer); clearInterval(countTimer);
  applyAutoUI();
  if (!autoCfg().on) { updateCountdown(); return; }
  // When the SSE channel is live it drives refresh (throttled to the interval),
  // so we don't also run the local poll timer — just the 1s countdown label.
  if (SSE_LIVE) { countTimer = setInterval(updateCountdown, 1000); updateCountdown(); return; }
  nextAt = Date.now() + autoCfg().interval;
  autoTimer = setInterval(() => { nextAt = Date.now() + autoCfg().interval; refreshTick(); }, autoCfg().interval);
  countTimer = setInterval(updateCountdown, 1000);
  updateCountdown();
}
function refreshTick() {
  if (document.hidden) return;                                          // tab not visible
  if (!$('#modal').classList.contains('hidden')) return;                // editing a task
  const ae = document.activeElement;                                    // mid-typing (e.g. commit msg)
  if (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName)) return;
  softRender();
}

/* ---- live refresh channel (F4) ---- */
let SSE_LIVE = false;       // true while the SSE connection is up (drives refresh)
let lastRefresh = 0;        // throttle: honour the user's chosen interval even on SSE ticks
function openStream() {
  let es;
  try { es = new EventSource('/api/stream'); } catch { return; }   // no EventSource → keep polling
  es.onopen = () => { SSE_LIVE = true; scheduleAuto(); };
  es.onerror = () => { if (SSE_LIVE) { SSE_LIVE = false; scheduleAuto(); } };   // fall back to the poll timer
  es.addEventListener('tick', (ev) => {
    if (!autoCfg().on) return;
    let v; try { v = JSON.parse(ev.data).version; } catch { /* ignore */ }
    if (v && BOOT_VERSION && v !== BOOT_VERSION) return checkVersion();   // a new build shipped → reload
    const now = Date.now();
    if (now - lastRefresh < autoCfg().interval) return;                    // respect the interval
    lastRefresh = now;
    refreshTick();
  });
}

/* ---- dependency preflight banner (F7) ---- */
async function checkDeps() {
  let d; try { d = await api('GET', '/api/health/deps'); } catch { return; }
  const el = $('#deps-banner'); if (!el) return;
  if (!d || d.ok) { el.classList.add('hidden'); el.textContent = ''; return; }
  const bad = Object.entries(d.checks).filter(([, c]) => !c.ok).map(([k, c]) => `${k} — ${c.detail}`);
  el.innerHTML = `<strong>⚠ Degraded</strong> ${bad.map((b) => esc(b)).join(' · ')}`;
  el.classList.remove('hidden');
}

/* ---- self-update: detect a new front-end build and reload cleanly ---- */
let BOOT_VERSION = null;
async function checkVersion() {
  let v; try { v = (await api('GET', '/api/version')).version; } catch { return; }
  if (!BOOT_VERSION) { BOOT_VERSION = v; return; }                      // first call: record baseline
  if (v === BOOT_VERSION) return;
  // A new build is being served. Reload when it won't interrupt anything;
  // otherwise surface a pill so the user reloads when ready.
  const ae = document.activeElement;
  const busy = !$('#modal').classList.contains('hidden') || (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName));
  if (document.hidden || !busy) location.reload();
  else $('#update-pill').classList.remove('hidden');
}

async function boot() {
  // Auth gate (F1): if the server requires a token and we don't have one, show
  // the login overlay and stop — don't render the dashboard behind it.
  const loginForm = $('#login-form'); if (loginForm) loginForm.addEventListener('submit', submitLogin);
  try {
    const a = await api('GET', '/api/auth');
    if (a && a.authRequired && !a.authed) { showLogin(); return; }
  } catch { /* /api/auth is exempt; ignore transient errors */ }

  try { STATE.sites = await api('GET', '/api/sites'); } catch { STATE.sites = []; }
  try { STATE.agents = await api('GET', '/api/agents'); } catch { STATE.agents = []; }
  const r = parseHash(); STATE.view = r.view; STATE.agent = r.agent; STATE.gitSlug = r.gitSlug || null;
  buildAgentsMenu();
  $$('.tab[data-view]').forEach((t) => t.addEventListener('click', () => go(t.dataset.view)));
  $('#agents-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleAgentsMenu(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('#agents-dd')) closeAgentsMenu(); });
  $('#refresh').addEventListener('click', softRender);
  const ff = $('#fleet-filter'); if (ff) ff.addEventListener('input', applyFleetFilter);
  $('#auto-on').addEventListener('change', (e) => { localStorage.setItem('fd.auto', e.target.checked ? '1' : '0'); scheduleAuto(); });
  $('#auto-int').addEventListener('change', (e) => { localStorage.setItem('fd.interval', e.target.value); scheduleAuto(); });
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#update-pill').addEventListener('click', () => location.reload());
  cmWireModals();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); cmCloseLogs(); cmCloseDiff(); cmCloseEditor(); cmCloseAddJob(); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkVersion(); refreshTick(); scheduleAuto(); } });
  checkVersion();
  checkDeps();                         // F7: surface missing python3/docker/etc.
  openStream();                        // F4: live-refresh channel (falls back to polling)
  setInterval(checkVersion, 60000);
  setInterval(checkDeps, 120000);
  setInterval(logFollowTick, 3000);   // live-tail open log surfaces
  window.addEventListener('hashchange', () => {
    const n = parseHash();
    if (n.view !== STATE.view || n.agent !== STATE.agent || (n.gitSlug || null) !== STATE.gitSlug) { STATE.view = n.view; STATE.agent = n.agent; STATE.gitSlug = n.gitSlug || null; FRESH = true; render(); }
  });
  FRESH = true;
  render();
  scheduleAuto();
}

boot();
