const $ = (sel, el = document) => el.querySelector(sel);

async function load() {
  const main = $('#systems');
  if (!main.dataset.loaded) main.textContent = 'Loading…';   // avoid flicker on poll refreshes
  const systems = await (await fetch('/api/systems')).json();
  main.innerHTML = '';
  for (const sys of systems) main.appendChild(renderSystem(sys));
  main.dataset.loaded = '1';
  const stamp = $('#lastUpdated');
  if (stamp) stamp.textContent = 'updated ' + new Date().toLocaleTimeString();
}

function renderSystem(sys) {
  const card = document.createElement('section');
  card.className = 'card';
  const st = escapeHtml(sys.status);
  const badge = `<span class="status ${st}">${st}</span>`;
  card.innerHTML = `<h2>${escapeHtml(sys.slug)} <span class="kind">${escapeHtml(sys.kind)}</span> ${badge}
    <span class="container">${escapeHtml(sys.container)}</span></h2>`;
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>State</th><th>Schedule</th><th>Runs</th><th>Actions</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const e of sys.entries) tbody.appendChild(renderRow(sys, e));
  table.appendChild(tbody);
  card.appendChild(table);
  const rebuild = document.createElement('button');
  rebuild.textContent = 'Rebuild & restart cron';
  rebuild.className = 'rebuild';
  rebuild.onclick = () => doRebuild(sys.slug);
  card.appendChild(rebuild);
  return card;
}

function renderRow(sys, e) {
  const tr = document.createElement('tr');
  if (!e.enabled) tr.classList.add('paused');
  const label = e.role ? `<code>${e.role}</code>` : `<span class="cmd">${escapeHtml(e.command)}</span>`;
  tr.innerHTML = `
    <td>${e.enabled ? '🟢 on' : '⏸ paused'}</td>
    <td title="${escapeHtml(e.schedule)}">${escapeHtml(e.human || e.schedule)}</td>
    <td>${label}</td>`;
  const actions = document.createElement('td');

  const toggle = document.createElement('button');
  toggle.textContent = e.enabled ? 'Pause' : 'Resume';
  toggle.onclick = () => toggleJob(sys, e);
  actions.appendChild(toggle);

  const edit = document.createElement('button');
  edit.textContent = 'Edit';
  edit.onclick = () => editJob(sys, e);
  actions.appendChild(edit);

  const remove = document.createElement('button');
  remove.textContent = 'Remove';
  remove.className = 'danger';
  remove.onclick = () => removeJob(sys, e);
  actions.appendChild(remove);

  tr.appendChild(actions);
  return tr;
}

async function toggleJob(sys, e) {
  if (e.role && sys.kind === 'site') {
    const action = e.enabled ? 'disable' : 'enable';
    await post(`/api/systems/${sys.slug}/jobs/${e.role}/${action}`);
  } else {
    const action = e.enabled ? 'comment' : 'uncomment';
    await postCrontab(sys, { action, lineIndex: e.lineIndex, expectedRawLine: e.rawLine });
  }
  load();
}

async function editJob(sys, e) {
  const newSchedule = prompt(`New cron schedule for "${e.role || e.command}":`, e.schedule);
  if (!newSchedule) return;
  await postCrontab(sys, { action: 'edit', lineIndex: e.lineIndex, newSchedule, expectedRawLine: e.rawLine });
  load();
}

async function removeJob(sys, e) {
  if (!confirm(`Remove this line from ${sys.slug}'s crontab?\n\n${e.rawLine}`)) return;
  await postCrontab(sys, { action: 'remove', lineIndex: e.lineIndex, expectedRawLine: e.rawLine });
  load();
}

async function postCrontab(sys, payload) {
  const r = await fetch(`/api/systems/${sys.slug}/crontab`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!r.ok) alert((await r.json()).error || 'failed');
  else alert('Saved. This change needs a rebuild to go live — click "Rebuild & restart cron".');
}

async function post(url) {
  const r = await fetch(url, { method: 'POST' });
  if (!r.ok) alert((await r.json()).error || 'failed');
}

async function doRebuild(slug) {
  const modal = $('#logModal'); const out = $('#logOut');
  out.textContent = ''; modal.classList.remove('hidden');
  const r = await fetch(`/api/systems/${slug}/rebuild`, { method: 'POST' });
  const reader = r.body.getReader(); const dec = new TextDecoder();
  for (;;) { const { done, value } = await reader.read(); if (done) break; out.textContent += dec.decode(value); }
  load();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- Auto-refresh polling (on by default, persisted, user-toggleable) ----
const POLL_MS = 30000;
let pollTimer = null;

function pollEnabled() {
  return localStorage.getItem('cm-autorefresh') !== 'off';   // default ON
}

function applyPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (pollEnabled()) {
    // Don't refresh while a rebuild modal is open — it would yank the view.
    pollTimer = setInterval(() => {
      if ($('#logModal').classList.contains('hidden')) load();
    }, POLL_MS);
  }
}

const autoToggle = $('#autoToggle');
autoToggle.checked = pollEnabled();
autoToggle.onchange = () => {
  localStorage.setItem('cm-autorefresh', autoToggle.checked ? 'on' : 'off');
  applyPolling();
};

$('#refresh').onclick = load;
$('#logClose').onclick = () => $('#logModal').classList.add('hidden');

load();
applyPolling();
