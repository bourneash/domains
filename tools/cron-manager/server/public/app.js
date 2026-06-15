'use strict';
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

// ---- small helpers ----
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function rel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 0) return 'just now';
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return d.toLocaleDateString();
}
const ICONS = {
  ok: '<svg class="ico" viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.5 12.5l2.3 2.3 4.7-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  bad: '<svg class="ico" viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 9l6 6M15 9l-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  info: '<svg class="ico" viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v5M12 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  spin: '<svg class="ico spin" viewBox="0 0 24 24" width="18" height="18"><path d="M12 3a9 9 0 1 0 9 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

// ---- state ----
const systemsBySlug = new Map();
const clientRebuildLog = new Map();   // slug -> last rebuild text (this session)
let editing = null;                   // { slug, lineIndex } while inline-editing
const POLL_MS = 30000;
let pollTimer = null;

// ============================================================ load + render
async function load() {
  const main = $('#systems');
  try {
    const systems = await (await fetch('/api/systems')).json();
    systemsBySlug.clear();
    for (const s of systems) systemsBySlug.set(s.slug, s);
    main.innerHTML = '';
    systems.forEach((sys, i) => main.appendChild(renderSystem(sys, i)));
    renderBanner(systems);
    $('#lastUpdated').textContent = new Date().toLocaleTimeString();
  } catch (e) {
    main.innerHTML = `<div class="loading">Failed to load: ${escapeHtml(e.message)}</div>`;
  }
}

function renderBanner(systems) {
  const running = systems.filter((s) => s.status === 'running').length;
  const failed = systems.filter((s) => s.failed);
  const idle = systems.length - running - failed.length;
  const b = $('#healthBanner');
  b.innerHTML =
    `<span class="chip ok"><span class="dot"></span>${running} running</span>` +
    `<span class="chip ${failed.length ? 'bad' : 'idle'}"><span class="dot"></span>${failed.length} failed</span>` +
    `<span class="chip idle"><span class="dot"></span>${idle} idle</span>`;
  b.title = failed.length ? 'Failed: ' + failed.map((s) => s.slug).join(', ') : '';
}

function renderSystem(sys, i) {
  const card = document.createElement('section');
  card.className = 'card' + (sys.failed ? ' failed-card' : '');
  card.style.animationDelay = Math.min(i * 35, 350) + 'ms';
  card.dataset.slug = sys.slug;

  const st = sys.status;
  const cls = sys.failed ? 'failed' : st;
  const exit = sys.exitCode != null ? ` · exit ${sys.exitCode}` : '';
  const head = document.createElement('div');
  head.className = 'card-head';
  head.innerHTML =
    `<span class="name">${escapeHtml(sys.slug)}</span>` +
    `<span class="kind">${escapeHtml(sys.kind)}</span>` +
    `<span class="badge ${cls}" title="${escapeHtml((sys.statusText || st) + exit)}"><span class="dot"></span>${escapeHtml(st)}</span>` +
    (sys.needsRebuild ? `<span class="chip-rebuild" title="crontab edited since last build"><span class="dot"></span>needs rebuild</span>` : '') +
    `<span class="container">${escapeHtml(sys.container)}</span>`;
  card.appendChild(head);

  const table = document.createElement('table');
  table.className = 'jobs';
  table.innerHTML =
    '<colgroup><col class="c-state"><col class="c-job"><col class="c-sched"><col class="c-last"><col class="c-act"></colgroup>' +
    '<thead><tr><th>State</th><th>Job</th><th>Schedule</th><th>Last run</th><th></th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const e of sys.entries) tbody.appendChild(renderRow(sys, e));
  if (!sys.entries.length) tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted)">No cron entries.</td></tr>';
  table.appendChild(tbody);
  card.appendChild(table);

  const foot = document.createElement('div');
  foot.className = 'card-foot';
  const rebuild = document.createElement('button');
  rebuild.className = 'btn rebuild primary' + (sys.needsRebuild ? ' dirty' : '');
  rebuild.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M20 11a8 8 0 1 0-.6 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Rebuild &amp; restart</span>';
  rebuild.onclick = () => doRebuild(sys, rebuild);
  foot.appendChild(rebuild);
  const logs = document.createElement('button');
  logs.className = 'btn ghost';
  logs.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 4h11l3 3v13H5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 11h8M8 15h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Logs</span>';
  logs.onclick = () => openLogs(sys, 'container');
  foot.appendChild(logs);
  if (sys.needsRebuild) {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'crontab changed — rebuild to apply';
    foot.appendChild(hint);
  }
  card.appendChild(foot);
  return card;
}

function renderRow(sys, e) {
  const tr = document.createElement('tr');
  tr.className = 'job-row' + (e.enabled ? '' : ' paused');
  tr.dataset.line = e.lineIndex;

  const stateTd = document.createElement('td');
  stateTd.innerHTML = `<span class="state-cell ${e.enabled ? 'on' : 'off'}"><span class="dot"></span>${e.enabled ? 'on' : 'paused'}</span>`;

  const jobTd = document.createElement('td');
  jobTd.innerHTML = e.role
    ? `<span class="job-name" title="${escapeHtml(e.command)}">${escapeHtml(e.role)}</span>`
    : `<span class="job-name cmd" title="${escapeHtml(e.command)}">${escapeHtml(e.command)}</span>`;

  const schedTd = document.createElement('td');
  schedTd.innerHTML = `<span class="sched"><span class="human">${escapeHtml(e.human || e.schedule)}</span><span class="expr">${escapeHtml(e.schedule)}</span></span>`;

  const lastTd = document.createElement('td');
  const r = rel(e.lastRun);
  if (r) {
    const exCls = e.lastExit === 0 ? 'ok' : (e.lastExit != null ? 'bad' : '');
    lastTd.innerHTML = `<span class="last ${e.hasLog ? 'clickable' : ''}" title="${escapeHtml(e.lastRun)}${e.lastExit != null ? ' · exit ' + e.lastExit : ''}">${exCls ? `<span class="ex ${exCls}"></span>` : ''}${escapeHtml(r)}</span>`;
    if (e.hasLog) lastTd.firstChild.onclick = () => openLogs(sys, `role:${e.role}`);
  } else {
    lastTd.innerHTML = '<span class="last"><span class="never">—</span></span>';
  }

  const actTd = document.createElement('td');
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const toggle = mkBtn(e.enabled ? 'Pause' : 'Resume', 'ghost sm', () => toggleJob(sys, e));
  const edit = mkBtn('Edit', 'ghost sm', () => editJob(sys, e, tr));
  actions.append(toggle, edit);
  if (e.hasLog) actions.appendChild(mkBtn('Log', 'ghost sm', () => openLogs(sys, `role:${e.role}`)));
  actions.appendChild(mkBtn('Remove', 'ghost sm danger', () => removeJob(sys, e)));
  actTd.appendChild(actions);

  tr.append(stateTd, jobTd, schedTd, lastTd, actTd);
  return tr;
}
function mkBtn(label, cls, onclick) {
  const b = document.createElement('button');
  b.className = 'btn ' + cls; b.textContent = label; b.onclick = onclick; return b;
}

// ============================================================ inline cron editor
const PRESETS = [
  ['*/15 * * * *', 'Every 15 min'], ['0 * * * *', 'Hourly'], ['*/30 * * * *', 'Every 30 min'],
  ['0 6 * * *', 'Daily 6am'], ['0 7 * * 1', 'Mon 7am'], ['0 9 1 * *', 'Monthly'],
];
function editJob(sys, e, tr) {
  if (tr.nextSibling && tr.nextSibling.classList && tr.nextSibling.classList.contains('editor-row')) {
    closeEditor(); return;
  }
  closeEditor();
  editing = { slug: sys.slug, lineIndex: e.lineIndex };
  const row = document.createElement('tr');
  row.className = 'editor-row';
  const td = document.createElement('td');
  td.colSpan = 5;
  td.innerHTML = `
    <div class="editor">
      <div class="ed-top">
        <span class="ed-label">Schedule for <b>${escapeHtml(e.role || e.command)}</b></span>
        <input class="input cron" type="text" spellcheck="false" autocomplete="off" value="${escapeHtml(e.schedule)}" />
        <span class="ed-dirty" hidden>● unsaved</span>
      </div>
      <div class="ed-verdict"></div>
      <div class="ed-tips">
        <div class="ed-legend"><span><b>┌ min</b> 0-59</span><span><b>hour</b> 0-23</span><span><b>day</b> 1-31</span><span><b>month</b> 1-12</span><span><b>weekday</b> 0-6</span><span>· use <b>*</b> any, <b>*/n</b> every n, <b>a,b</b> list, <b>a-b</b> range</span></div>
        <div class="ed-presets">${PRESETS.map(([v, l]) => `<button class="preset" data-v="${v}">${l}</button>`).join('')}</div>
      </div>
      <div class="ed-actions">
        <button class="btn primary ed-save" disabled>Save</button>
        <button class="btn ghost ed-cancel">Cancel</button>
      </div>
    </div>`;
  row.appendChild(td);
  tr.after(row);

  const input = $('.input.cron', row);
  const verdict = $('.ed-verdict', row);
  const save = $('.ed-save', row);
  const dirty = $('.ed-dirty', row);
  const original = e.schedule;
  let valid = false;

  const check = debounce(async () => {
    const expr = input.value.trim();
    const changed = expr !== original;
    dirty.hidden = !changed;
    if (!expr) { verdict.className = 'ed-verdict'; verdict.innerHTML = ''; input.className = 'input cron'; save.disabled = true; return; }
    try {
      const v = await (await fetch('/api/cron/describe?expr=' + encodeURIComponent(expr))).json();
      valid = v.valid;
      input.className = 'input cron ' + (v.valid ? 'valid' : 'invalid');
      verdict.className = 'ed-verdict ' + (v.valid ? 'good' : 'bad');
      verdict.innerHTML = v.valid
        ? `${chk()} <span class="plain">${escapeHtml(v.human)}</span>`
        : `${x()} ${escapeHtml(v.error || 'invalid')}`;
      save.disabled = !v.valid || !changed;
    } catch { verdict.textContent = ''; }
  }, 180);

  input.addEventListener('input', check);
  $$('.preset', row).forEach((p) => p.onclick = () => { input.value = p.dataset.v; input.focus(); check(); });
  $('.ed-cancel', row).onclick = closeEditor;
  save.onclick = async () => {
    if (!valid) return;
    save.disabled = true;
    await postCrontab(sys, { action: 'edit', lineIndex: e.lineIndex, newSchedule: input.value.trim(), expectedRawLine: e.rawLine });
    closeEditor();
  };
  input.focus(); input.select(); check();
}
function closeEditor() {
  $$('.editor-row').forEach((r) => r.remove());
  editing = null;
}
function chk() { return '<svg class="mark" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function x() { return '<svg class="mark" viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>'; }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ============================================================ mutations
async function toggleJob(sys, e) {
  if (e.role && sys.kind === 'site') {
    await post(`/api/systems/${sys.slug}/jobs/${e.role}/${e.enabled ? 'disable' : 'enable'}`);
  } else {
    await postCrontab(sys, { action: e.enabled ? 'comment' : 'uncomment', lineIndex: e.lineIndex, expectedRawLine: e.rawLine }, true);
  }
  load();
}
async function removeJob(sys, e) {
  if (!confirm(`Remove this line from ${sys.slug}'s crontab?\n\n${e.rawLine}`)) return;
  await postCrontab(sys, { action: 'remove', lineIndex: e.lineIndex, expectedRawLine: e.rawLine });
}
async function postCrontab(sys, payload, silent) {
  const r = await fetch(`/api/systems/${sys.slug}/crontab`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!r.ok) { toast({ type: 'error', title: 'Change failed', sub: (await r.json().catch(() => ({}))).error || r.statusText }); return; }
  if (!silent) toast({ type: 'success', title: 'Saved to crontab', sub: 'Rebuild to apply the change', timeout: 5000 });
  await load();
}
async function post(url) {
  const r = await fetch(url, { method: 'POST' });
  if (!r.ok) toast({ type: 'error', title: 'Action failed', sub: (await r.json().catch(() => ({}))).error || r.statusText });
}

// ============================================================ rebuild → toast
async function doRebuild(sys, btn) {
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<svg class="spin" viewBox="0 0 24 24" width="14" height="14"><path d="M12 3a9 9 0 1 0 9 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>Rebuilding…</span>';
  const t = toast({ type: 'loading', title: `Rebuilding ${sys.container}`, sub: 'building image · restarting…', sticky: true });
  let text = '';
  try {
    const r = await fetch(`/api/systems/${sys.slug}/rebuild`, { method: 'POST' });
    const reader = r.body.getReader(); const dec = new TextDecoder();
    for (;;) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value); }
  } catch (e) { text += `\nclient error: ${e.message}`; }
  clientRebuildLog.set(sys.slug, text.replace(/@@VERDICT.*\n?/g, ''));
  const ok = /@@VERDICT ok\b/.test(text);
  t.dismiss();
  toast({
    type: ok ? 'success' : 'error',
    title: ok ? `${sys.container} restarted` : `${sys.container} failed to start`,
    sub: ok ? 'container is running' : 'check the rebuild log',
    action: { label: 'View log', fn: () => openLogs(sys, 'rebuild') },
    timeout: ok ? 4500 : 0,
  });
  btn.disabled = false; btn.innerHTML = orig;
  load();
}

// ============================================================ log viewer
const lv = {
  slug: null, source: 'container', raw: '',
  modal: () => $('#logModal'), out: () => $('#logOut'),
};
async function openLogs(sys, source) {
  lv.slug = sys.slug; lv.source = source || 'container';
  $('#logTitle').textContent = sys.container;
  // build source selector
  const sources = (sys.logSources || [{ id: 'container', label: 'Container' }]).slice();
  if (clientRebuildLog.has(sys.slug) && !sources.some((s) => s.id === 'rebuild')) {
    sources.splice(1, 0, { id: 'rebuild', label: 'Last rebuild' });
  }
  const seg = $('#logSources');
  seg.innerHTML = sources.map((s) => `<button data-id="${escapeHtml(s.id)}">${escapeHtml(s.label)}</button>`).join('');
  $$('#logSources button', seg).forEach((b) => b.onclick = () => { lv.source = b.dataset.id; fetchLogs(); });
  lv.modal().classList.remove('hidden');
  fetchLogs();
}
async function fetchLogs() {
  $$('#logSources button').forEach((b) => b.classList.toggle('active', b.dataset.id === lv.source));
  const out = lv.out();
  const tail = $('#logTail').value;
  // client rebuild buffer is freshest
  if (lv.source === 'rebuild' && clientRebuildLog.has(lv.slug)) {
    lv.raw = clientRebuildLog.get(lv.slug);
  } else {
    out.textContent = 'Loading…';
    try { lv.raw = await (await fetch(`/api/systems/${lv.slug}/logs?source=${encodeURIComponent(lv.source)}&tail=${tail}`)).text(); }
    catch (e) { lv.raw = `failed to load logs: ${e.message}`; }
  }
  applyFilter();
  $('#logMeta').textContent = `${lv.source} · tail ${tail}`;
  out.scrollTop = out.scrollHeight;
}
function applyFilter() {
  const f = $('#logFilter').value.trim().toLowerCase();
  const lines = lv.raw.split('\n');
  const shown = f ? lines.filter((l) => l.toLowerCase().includes(f)) : lines;
  lv.out().textContent = shown.join('\n');
  $('#logCount').textContent = f ? `${shown.length} / ${lines.length} lines` : `${lines.length} lines`;
}
function closeLogs() { lv.modal().classList.add('hidden'); }

// ============================================================ toasts
function toast({ type = 'info', title, sub, action, timeout = 4000, sticky = false }) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${ICONS[type === 'success' ? 'ok' : type === 'error' ? 'bad' : type === 'loading' ? 'spin' : 'info']}
    <div class="body"><div class="t-title">${escapeHtml(title || '')}</div>${sub ? `<div class="t-sub">${escapeHtml(sub)}</div>` : ''}</div>
    ${sticky ? '' : '<button class="close" aria-label="Dismiss">×</button>'}`;
  if (action) {
    const a = document.createElement('div'); a.className = 't-action';
    a.innerHTML = `<button class="btn ghost sm">${escapeHtml(action.label)}</button>`;
    a.firstChild.onclick = () => { action.fn(); dismiss(); };
    $('.body', el).appendChild(a);
  }
  $('#toasts').appendChild(el);
  function dismiss() { el.classList.add('out'); setTimeout(() => el.remove(), 250); }
  if (!sticky) { const c = $('.close', el); if (c) c.onclick = dismiss; }
  if (timeout && !sticky) setTimeout(dismiss, timeout);
  return { dismiss, el };
}

// ============================================================ theme + polling
function setTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem('cm-theme', t); } catch {} }
$('#themeToggle').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

function pollEnabled() { try { return localStorage.getItem('cm-autorefresh') !== 'off'; } catch { return true; } }
function applyPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (pollEnabled()) {
    pollTimer = setInterval(() => {
      // never yank the view while editing or reading logs
      if (editing) return;
      if (!lv.modal().classList.contains('hidden')) return;
      load();
    }, POLL_MS);
  }
}
const autoToggle = $('#autoToggle');
autoToggle.checked = pollEnabled();
autoToggle.onchange = () => { try { localStorage.setItem('cm-autorefresh', autoToggle.checked ? 'on' : 'off'); } catch {} applyPolling(); };

// log toolbar wiring
$('#refresh').onclick = load;
$('#logClose').onclick = closeLogs;
$('#logFilter').addEventListener('input', applyFilter);
$('#logTail').addEventListener('change', fetchLogs);
$('#logReload').onclick = fetchLogs;
$('#logWrap').onchange = (e) => lv.out().classList.toggle('wrap', e.target.checked);
$('#logCopy').onclick = async () => { try { await navigator.clipboard.writeText(lv.out().textContent); toast({ type: 'success', title: 'Copied', timeout: 1500 }); } catch { toast({ type: 'error', title: 'Copy failed' }); } };
$('#logDownload').onclick = () => {
  const blob = new Blob([lv.raw], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `${lv.slug}-${lv.source.replace(':', '-')}.log`;
  a.click(); URL.revokeObjectURL(a.href);
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeLogs(); closeEditor(); } });
lv.modal().addEventListener('click', (e) => { if (e.target === lv.modal()) closeLogs(); });

load();
applyPolling();
