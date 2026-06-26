'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let STATE = { view: 'control', agent: null, sites: [], agents: [], taskSite: null };

function agentLabel(role) { return String(role).split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '); }

// The site dir name is the live domain — link straight to it (new tab).
function siteLink(site) {
  return `<a class="site-link" href="https://${esc(site)}" target="_blank" rel="noopener noreferrer" title="Open https://${esc(site)}">${esc(site)}<span class="ext">↗</span></a>`;
}

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
  const head = '<th class="rsite-h">Site</th>'
    + core.map((r) => agentSet.has(r)
      ? `<th class="rcol"><a class="rcol-link" data-role="${esc(r)}" title="Open the ${esc(agentLabel(r))} agent page">${esc(r)} →</a></th>`
      : `<th class="rcol">${esc(r)}</th>`).join('')
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
    return `<tr><td class="rsite">${siteLink(s.site)}</td>${cells}${otherCell}</tr>`;
  }).join('');

  const lg = (st, txt) => `<span class="rdot r-${st}"></span> ${txt}`;
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
    <p class="muted" style="margin-top:12px">Each cell = a role scheduled on that site. ${lg('fresh', 'ran within its cadence')} · ${lg('stale', 'overdue >1×')} · ${lg('overdue', 'overdue >2×')} · ${lg('paused', 'paused (.&lt;role&gt;-disabled)')} · ${lg('never', 'scheduled, no log found')} · <span class="rdot r-none">·</span> not installed. Click a column header to open that agent's page, or a cell for its latest log + pause/resume. Bespoke per-site roles are grouped under <b>other</b>.</p>`;

  $$('.rdot[data-site]').forEach((d) => d.addEventListener('click', () => openRole(d.dataset.site, d.dataset.role)));
  $$('.rcol-link').forEach((a) => a.addEventListener('click', () => go('agent', a.dataset.role)));
  if (!FRESH) applyUISnap();
  stamp();
}

const STATE_LABEL = { fresh: 'fresh', stale: 'overdue', overdue: 'well overdue', paused: 'paused', never: 'no log found' };
function roleDot(site, role, c) {
  const tip = `${role} — ${STATE_LABEL[c.state] || c.state}${c.age != null ? ` · last ${fmtAge(c.age)} ago` : ''} · sched ${c.schedule}`;
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
    return `<tr class="ag-row">
      <td class="site">${siteLink(r.site)}</td>
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
  const attention = rows.filter((r) => r.unhealthy || (r.kind === 'cron' && !r.running)).length;

  const body = rows.map((r) => {
    const label = r.kind === 'cron' ? 'cron' : r.kind === 'worker' ? 'worker run' : (r.service || r.kind);
    const svc = `<span class="badge ${r.kind === 'cron' ? 'b-blue' : r.kind === 'worker' ? 'b-purple' : 'b-gray'}">${esc(label)}</span>`;
    const acts = [`<button class="btn sm cn-logs" data-id="${esc(r.id)}">📜 Logs</button>`];
    if (r.running) acts.push(`<button class="btn sm cn-act" data-id="${esc(r.id)}" data-act="restart" data-name="${esc(r.name)}">↻ Restart</button>`);
    else acts.push(`<button class="btn sm cn-act" data-id="${esc(r.id)}" data-act="start" data-name="${esc(r.name)}">▶ Start</button>`);
    if (r.kind === 'cron') acts.push(`<button class="btn sm cn-bounce" data-slug="${esc(r.slug)}" data-name="${esc(r.name)}" title="Rebuild image + recreate (Dockerfile/dependency changes)">⟳ Rebuild</button>`);
    if (r.running) acts.push(`<button class="btn sm danger cn-act" data-id="${esc(r.id)}" data-act="stop" data-name="${esc(r.name)}">⏹ Stop</button>`);
    return `<tr class="cn-row">
      <td class="mono">${esc(r.name)}</td>
      <td>${r.scope === 'site' ? `<span class="site">${esc(r.slug)}</span>` : '<span class="muted">tool</span>'}</td>
      <td>${svc}</td>
      <td>${containerStatus(r)}</td>
      <td class="mono muted">${esc(r.running ? r.runningFor : '—')}</td>
      <td class="cn-actions">${acts.join(' ')}</td>
    </tr>
    <tr class="cn-detail-row hidden" data-detail="${esc(r.id)}" data-rk="cn:${esc(r.id)}"><td colspan="6"><div class="cn-log-head muted">logs · <span class="live-tag">live</span></div><pre class="cn-logs-box" id="cl-${esc(r.id)}" data-rkh="cn:${esc(r.id)}"></pre></td></tr>`;
  }).join('');

  app.innerHTML = `
    <div class="task-toolbar">
      <strong>${rows.length} containers</strong>
      <span class="muted">${cronUp}/${cron.length} cron up · ${workers} worker run${workers === 1 ? '' : 's'} in-flight${attention ? ` · <span class="flag">${attention} need attention</span>` : ''}</span>
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
}

async function toggleContainerLogs(id) {
  const row = $(`tr[data-detail="${CSS.escape(id)}"]`);
  const box = $(`#cl-${CSS.escape(id)}`);
  if (!row.classList.contains('hidden')) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  box.textContent = 'loading logs…';
  await fetchContainerLog(id, box);
}

// Fetch (or re-fetch, for live-follow) a container's logs. Keeps the view
// pinned to the bottom only if it was already there (so manual scroll sticks).
async function fetchContainerLog(id, box) {
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  try {
    const r = await api('GET', `/api/containers/${encodeURIComponent(id)}/logs?tail=300`);
    if (box.textContent !== r.logs) { box.textContent = r.logs; if (atBottom) box.scrollTop = box.scrollHeight; }
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

function closeModal() { $('#modal').classList.add('hidden'); ROLE_OPEN = null; }

/* ===================== SHELL ===================== */
const TOP_VIEWS = ['control', 'containers', 'git', 'tasks'];

// Hash router. Routes: #control, #containers, #git, #tasks, #agents/<role>.
// Legacy aliases: #roles → control, #fleet → agents/engineer.
function parseHash() {
  const h = (location.hash || '').replace(/^#/, '');
  if (!h) return { view: 'control', agent: null };
  const [a, b] = h.split('/');
  if (a === 'agents' && b) return { view: 'agent', agent: decodeURIComponent(b) };
  if (a === 'fleet') return { view: 'agent', agent: 'engineer' };
  if (a === 'roles') return { view: 'control', agent: null };
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
  syncAgentsMenuActive();
  if (STATE.view === 'control') renderControl();
  else if (STATE.view === 'agent') renderAgent(STATE.agent);
  else if (STATE.view === 'containers') renderContainers();
  else if (STATE.view === 'git') renderGit();
  else if (STATE.view === 'tasks') renderTasks();
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
  try { STATE.agents = await api('GET', '/api/agents'); } catch { STATE.agents = []; }
  const r = parseHash(); STATE.view = r.view; STATE.agent = r.agent;
  buildAgentsMenu();
  $$('.tab[data-view]').forEach((t) => t.addEventListener('click', () => go(t.dataset.view)));
  $('#agents-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleAgentsMenu(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('#agents-dd')) closeAgentsMenu(); });
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
  setInterval(logFollowTick, 3000);   // live-tail open log surfaces
  window.addEventListener('hashchange', () => {
    const n = parseHash();
    if (n.view !== STATE.view || n.agent !== STATE.agent) { STATE.view = n.view; STATE.agent = n.agent; FRESH = true; render(); }
  });
  FRESH = true;
  render();
  scheduleAuto();
}

boot();
