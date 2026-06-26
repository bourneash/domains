'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let STATE = { view: 'fleet', sites: [], taskSite: null };

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  const txt = await r.text();
  let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  return data;
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
    const cover = h ? `<span class="${h.coverage < 70 ? 'flag' : 'muted'}">${h.coverage}%</span>` : '<span class="muted">—</span>';
    const tasksBtn = `<button class="btn sm tasks-link" data-site="${esc(r.site)}" title="Open ${esc(r.site)}'s task board">📋 Tasks${r.queue ? ` <span class="qn">${r.queue}</span>` : ''}</button>`;
    const runBtn = r.engineer
      ? `<button class="btn sm run-eng" data-site="${esc(r.site)}"${r.cron_up ? '' : ' disabled title="cron container not running"'}>▶ Run</button> `
      : '';
    const actions = r.engineer ? runBtn + tasksBtn : tasksBtn;
    return `<tr>
      <td class="site">${esc(r.site)}</td>
      <td>${tier(r.tier)}</td>
      <td>${r.engineer ? feats(r) : '<span class="muted">—</span>'}</td>
      <td>${cron}</td>
      <td>${pulseBadge(r)}</td>
      <td>${ageCell(r)}</td>
      <td class="mono">${r.render ? esc(r.render) : '—'}</td>
      <td>${cf}</td>
      <td class="mono">${r.queue || 0}</td>
      <td>${cover} ${h ? sparkline(h.spark) : ''}</td>
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
    ['3d cover', '3-day coverage', 'Pulse coverage over the last 3 days: pulses seen / pulses expected (48/day at 30-min cadence). Under 70% is flagged — the cron is missing runs. The bars are a per-tick sparkline (filled = healthy, short = a bad/missed tick).'],
    ['Flags', 'Flags', 'Audit warnings for this row, e.g. no-cron-container (engineer installed but its cron container is not running) or archetype drift. Empty = no warnings.'],
    ['Actions', 'Actions', '▶ Run fires this engineer immediately — the exact command cron runs (bash ops/scripts/run-worker.sh engineer) inside the site\'s cron container, detached; the work-lock makes a mid-pass click no-op safely, and ▶ Run is disabled when the cron container is down. 📋 Tasks jumps to this site\'s task board (the number is its open engineer-queue count).'],
  ];
  const thead = COLHELP.map(([label, name, tip]) =>
    `<th class="th-help" title="${esc(name)} — ${esc(tip)}">${esc(label)}</th>`).join('');

  app.innerHTML = `
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
    <p class="muted" style="margin-top:12px">Feat: <b>L</b>=work-lock <b>P</b>=liveness-pulse <b>D</b>=daily-summary · Age <b>!</b> = pulse &gt; 35m (possibly wedged) · cover = pulses seen / expected (48/day). <a id="fleet-help-link" class="filter-clear" style="margin-left:0">full column key →</a></p>`;
  const helpBox = $('#fleet-help');
  const toggleHelp = () => helpBox.classList.toggle('hidden');
  $('#fleet-help-toggle').addEventListener('click', toggleHelp);
  $('#fleet-help-link').addEventListener('click', () => { helpBox.classList.remove('hidden'); helpBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
  $$('.run-eng').forEach((b) => b.addEventListener('click', () => runEngineerNow(b.dataset.site, b)));
  $$('.tasks-link').forEach((b) => b.addEventListener('click', () => openSiteTasks(b.dataset.site)));
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

  const body = rows.map((r) => {
    if (!r.isRepo) return `<tr><td class="site">${esc(r.slug)}</td><td colspan="5"><span class="muted">${esc(r.error || 'not a repo')}</span></td></tr>`;
    const dirty = r.dirty > 0 ? `<span class="badge b-yellow">${r.dirty} uncommitted</span>` : '<span class="badge b-green">clean</span>';
    const sync = [];
    if (r.ahead) sync.push(`<span class="badge b-blue">↑${r.ahead}</span>`);
    if (r.behind) sync.push(`<span class="badge b-red">↓${r.behind}</span>`);
    if (!r.ahead && !r.behind) sync.push('<span class="muted">synced</span>');
    return `<tr class="git-row" data-slug="${esc(r.slug)}">
      <td class="site">${esc(r.slug)} <span class="muted">▸</span></td>
      <td class="mono">${esc(r.branch || '—')}</td>
      <td>${dirty}</td>
      <td>${sync.join(' ')}</td>
    </tr>
    <tr class="git-detail-row hidden" data-detail="${esc(r.slug)}" data-rk="git:${esc(r.slug)}"><td colspan="4"><div class="git-detail" id="gd-${esc(r.slug)}" data-rkh="git:${esc(r.slug)}"></div></td></tr>`;
  }).join('');

  app.innerHTML = `
    <div class="task-toolbar">
      <strong>${rows.length} repos</strong>
      <span class="muted">${dirtyCount} dirty · ${pushCount} need push</span>
    </div>
    <div class="card"><table>
      <thead><tr><th>Site</th><th>Branch</th><th>Working tree</th><th>Remote</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;

  $$('.git-row').forEach((tr) => tr.addEventListener('click', () => toggleGitDetail(tr.dataset.slug)));
  if (!FRESH) applyUISnap();
  // applyUISnap re-injects the saved innerHTML of any expanded detail but not its
  // event listeners — re-wire the live ops for every still-open detail panel.
  $$('.git-detail-row:not(.hidden)').forEach((r) => {
    const box = $(`#gd-${CSS.escape(r.dataset.detail)}`);
    if (box && box.querySelector('.gd-files, .gd-push')) wireGitOps(r.dataset.detail, box);
  });
  stamp();
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

  if (!s.files.length) {
    box.innerHTML = `<div class="gd-head">${lc}</div>
      <div class="muted gd-clean">working tree clean${s.behind ? ` · ${s.behind} behind` : ''}</div>
      <div class="gd-commit">${pushBtn}</div><div class="gd-result"></div>`;
    wireGitOps(slug, box);
    return;
  }

  const fileRows = s.files.map((f) => `<label class="gd-file">
      <input type="checkbox" class="gd-sel" value="${esc(f.path)}" checked />
      <span class="code chip ${gitCls(f.kind)}" title="${esc(f.kind)}">${esc(f.code)}</span>
      <span class="gd-path" title="${esc(f.kind)}">${esc(f.path)}</span>
      <button type="button" class="gd-ignore" data-path="${esc(f.path)}" title="Add to .gitignore and commit the .gitignore">ignore</button>
    </label>`).join('');

  const meta = [`${s.files.length} changed`, s.staged ? `${s.staged} staged` : '', s.untracked ? `${s.untracked} untracked` : '',
    s.ahead ? `${s.ahead} to push` : '', s.behind ? `${s.behind} behind` : ''].filter(Boolean).join(' · ');

  box.innerHTML = `
    <div class="gd-head"><span class="section-title" style="margin:0">${esc(meta)}</span>${lc}</div>
    <div class="gd-controls"><a class="gd-all" data-v="1">select all</a><a class="gd-all" data-v="0">none</a></div>
    <div class="gd-files">${fileRows}</div>
    <div class="gd-commit">
      <input class="gd-msg" placeholder="commit message for the selected files…" />
      <button type="button" class="btn sm primary gd-commit-btn">Commit selected</button>
      ${pushBtn}
    </div>
    <div class="gd-result"></div>`;
  wireGitOps(slug, box);
}

function wireGitOps(slug, box) {
  $$('.gd-all', box).forEach((a) => a.addEventListener('click', () => $$('.gd-sel', box).forEach((c) => { c.checked = a.dataset.v === '1'; })));
  $$('.gd-ignore', box).forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); gitIgnore(slug, box, b.dataset.path, b); }));
  const cb = $('.gd-commit-btn', box); if (cb) cb.addEventListener('click', () => gitCommit(slug, box, cb));
  const pb = $('.gd-push', box); if (pb) pb.addEventListener('click', () => gitPush(slug, box, pb));
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
  if (tds[1]) tds[1].innerHTML = `<span class="mono">${esc(s.branch || '—')}</span>`;
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
  const siteSel = mode === 'create'
    ? `<div class="field"><label>Site</label><select id="f-site">${STATE.sites.map((s) => `<option value="${esc(s)}" ${s === site ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>`
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
  const targetSite = mode === 'create' ? ($('#f-site') ? $('#f-site').value : site) : site;
  const meta = collectMeta();
  const body = $('#f-body').value;
  const targetCol = $('#f-col').value;
  if (!meta.title) { toast('Title is required', 'err'); return; }
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
  if (!confirm(`Delete task "${file}"? This removes the file on disk.`)) return;
  try {
    await api('DELETE', `/api/tasks/${encodeURIComponent(site)}/${encodeURIComponent(column)}/${encodeURIComponent(file)}`);
    toast('Task deleted'); closeModal();
    if (TASK.mode === 'board') loadBoard(); else loadFleet();
  } catch (e) { toast(e.message, 'err'); }
}

function closeModal() { $('#modal').classList.add('hidden'); }

/* ===================== SHELL ===================== */
const VIEWS = ['fleet', 'git', 'tasks'];

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
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === STATE.view));
  if (STATE.view === 'fleet') renderEngineers();
  else if (STATE.view === 'git') renderGit();
  else if (STATE.view === 'tasks') renderTasks();
}

// In-place refresh of the current view: capture UI state, repaint without the
// loading flash, then the view restores state from UISNAP as it finishes.
function softRender() {
  UISNAP = captureUI();
  FRESH = false;
  render();
}

function go(view) {
  STATE.view = view;
  if (location.hash !== `#${view}`) location.hash = view;   // shareable + back-button
  FRESH = true;
  render();
}

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
  const s = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
  next.textContent = `↻ ${s}s`;
}
function scheduleAuto() {
  clearInterval(autoTimer); clearInterval(countTimer);
  applyAutoUI();
  if (!autoCfg().on) { updateCountdown(); return; }
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
  try { STATE.sites = await api('GET', '/api/sites'); } catch { STATE.sites = []; }
  const fromHash = (location.hash || '').replace('#', '');
  if (VIEWS.includes(fromHash)) STATE.view = fromHash;
  $$('.tab').forEach((t) => t.addEventListener('click', () => go(t.dataset.view)));
  $('#refresh').addEventListener('click', softRender);
  $('#auto-on').addEventListener('change', (e) => { localStorage.setItem('fd.auto', e.target.checked ? '1' : '0'); scheduleAuto(); });
  $('#auto-int').addEventListener('change', (e) => { localStorage.setItem('fd.interval', e.target.value); scheduleAuto(); });
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#update-pill').addEventListener('click', () => location.reload());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkVersion(); refreshTick(); scheduleAuto(); } });
  checkVersion();
  setInterval(checkVersion, 60000);
  window.addEventListener('hashchange', () => {
    const v = (location.hash || '').replace('#', '');
    if (VIEWS.includes(v) && v !== STATE.view) { STATE.view = v; FRESH = true; render(); }
  });
  FRESH = true;
  render();
  scheduleAuto();
}

boot();
