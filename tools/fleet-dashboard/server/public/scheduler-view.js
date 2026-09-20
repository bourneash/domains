'use strict';

/* Scheduler view — Ops ▸ Scheduler. Talks to /api/scheduler/* (proxy to tools/fleet-scheduler).
   Loaded BEFORE app.js; only references app.js globals (api, $, $$, esc, toast, stamp, FRESH) at call time. */

const SCH = { site: '', text: '', openRun: null };

function schFmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const same = d.toDateString() === new Date().toDateString();
  return same
    ? d.toLocaleTimeString()
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function schFmtNext(ts) {
  if (!ts) return '—';
  const s = ts - Date.now() / 1000;
  if (s < 90) return 'now';
  if (s < 5400) return `in ${Math.round(s / 60)}m`;
  if (s < 172800) return `in ${Math.round(s / 3600)}h`;
  return new Date(ts * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function schDur(r) {
  if (!r.started_at) return '';
  const s = (r.finished_at || Date.now() / 1000) - r.started_at;
  return s < 90
    ? `${Math.round(s)}s`
    : s < 5400
      ? `${Math.round(s / 60)}m`
      : `${(s / 3600).toFixed(1)}h`;
}
function schBadge(status) {
  const cls =
    {
      ok: 'b-green',
      running: 'b-blue',
      queued: 'b-gray',
      failed: 'b-red',
      timeout: 'b-red',
      lost: 'b-red',
      killed: 'b-yellow',
      missed: 'b-yellow',
      skipped_overlap: 'b-gray',
      skipped_queue: 'b-yellow',
    }[status] || 'b-gray';
  return `<span class="badge ${cls}">${esc(status || '—')}</span>`;
}

async function renderScheduler() {
  const app = $('#app');
  if (FRESH) app.innerHTML = '<div class="loading">Reading scheduler…</div>';
  let st, jobs, runs;
  try {
    [st, jobs, runs] = await Promise.all([
      api('GET', '/api/scheduler/status'),
      api('GET', '/api/scheduler/jobs' + (SCH.site ? `?site=${encodeURIComponent(SCH.site)}` : '')),
      api(
        'GET',
        '/api/scheduler/runs?limit=60' + (SCH.site ? `&site=${encodeURIComponent(SCH.site)}` : '')
      ),
    ]);
  } catch (e) {
    app.innerHTML = `<div class="page-head"><h2 class="page-title">Scheduler</h2></div><div class="empty">Scheduler unreachable: ${esc(e.message)}<br><span class="muted mono">tools/fleet-scheduler/bin/fleet-scheduler up</span></div>`;
    return;
  }
  const q = SCH.text.trim().toLowerCase();
  const shown = q
    ? jobs.filter(j => `${j.site} ${j.name} ${j.schedule}`.toLowerCase().includes(q))
    : jobs;
  const sites = st.sites || [];
  const adoptedN = sites.filter(s => s.adopted).length;
  const failing = jobs.filter(
    j => j.active && j.last_run && ['failed', 'timeout', 'lost'].includes(j.last_run.status)
  ).length;
  const c = st.counters || {};

  app.innerHTML = `
    <div id="sch-root">
    <div class="page-head"><h2 class="page-title">Scheduler</h2>
      <span class="muted">one DB-backed scheduler for ${sites.length} sites · ${adoptedN} adopted · replaces per-site cron containers</span></div>
    <div class="task-toolbar">
      <span class="badge ${st.paused ? 'b-red' : 'b-green'}">${st.paused ? 'PAUSED' : 'active'}</span>
      <strong>${st.running} running · ${st.queued} queued</strong>
      <span class="muted">${st.scheduled}/${st.jobs} jobs scheduled · ${failing} failing · up ${Math.round(st.uptime_s / 3600)}h · lag ${st.loop_lag_s}s</span>
      <span class="muted">runs since start: ${['ok', 'failed', 'timeout', 'skipped_overlap', 'skipped_queue', 'missed'].map(k => `${k} ${c[k] || 0}`).join(' · ')}</span>
      <button class="btn sm" id="sch-pause" style="margin-left:auto">${st.paused ? 'Resume all' : 'Pause all'}</button>
    </div>
    <div class="task-toolbar">
      <span class="muted">Concurrency caps</span>
      ${[
        ['light_cap', 'light'],
        ['heavy_cap', 'heavy'],
        ['site_heavy_cap', 'heavy / site'],
      ]
        .map(
          ([k, l]) =>
            `<label class="muted">${l} <input class="sch-cap" data-k="${k}" type="number" min="1" style="width:64px" value="${esc(st.settings[k])}"></label>`
        )
        .join('')}
      <button class="btn sm" id="sch-caps-save">Save caps</button>
      <span class="muted">Heavy = spawns a worker / runs Claude. Excess fires queue instead of all starting on one minute boundary.</span>
    </div>

    <h3 style="margin:14px 0 6px">Sites</h3>
    <table class="tbl"><thead><tr><th>Site</th><th>Jobs</th><th>Mode</th><th></th></tr></thead><tbody>
      ${sites
        .map(
          s => `<tr>
        <td><a href="#" class="sch-site" data-site="${esc(s.site)}">${esc(s.site)}</a></td>
        <td>${s.enabled}/${s.jobs}</td>
        <td>${s.adopted ? '<span class="badge b-green">scheduler</span>' : '<span class="badge b-gray">legacy cron container</span>'}</td>
        <td style="text-align:right">${
          s.adopted
            ? `<button class="btn sm" data-act="release" data-site="${esc(s.site)}">Release → legacy</button>`
            : `<button class="btn sm primary" data-act="adopt" data-site="${esc(s.site)}">Adopt</button>`
        }</td></tr>`
        )
        .join('')}
    </tbody></table>

    <h3 style="margin:18px 0 6px">Jobs ${SCH.site ? `— ${esc(SCH.site)} <a href="#" id="sch-clear">(all sites)</a>` : ''}
      <input id="sch-text" placeholder="filter…" value="${esc(SCH.text)}" style="margin-left:12px;width:180px"></h3>
    <table class="tbl"><thead><tr><th>Site</th><th>Job</th><th>Schedule</th><th>Class</th><th>State</th><th>Next</th><th>Last run</th><th></th></tr></thead><tbody>
      ${shown
        .map(
          j => `<tr>
        <td>${esc(j.site)}</td><td>${esc(j.name)}</td><td class="mono">${esc(j.schedule)}</td>
        <td>${esc(j.class)}</td>
        <td>${j.enabled ? (j.active ? '<span class="badge b-green">on</span>' : '<span class="badge b-gray">idle (site not adopted)</span>') : '<span class="badge b-yellow">disabled</span>'}</td>
        <td>${j.active ? schFmtNext(j.next_fire) : '—'}</td>
        <td>${j.last_run ? `${schBadge(j.last_run.status)} <span class="muted">${schFmtTime(j.last_run.finished_at || j.last_run.started_at)}</span>` : '<span class="muted">never</span>'}</td>
        <td style="white-space:nowrap">
          <button class="btn sm" data-act="run" data-id="${j.id}">Run</button>
          <button class="btn sm" data-act="toggle" data-id="${j.id}" data-en="${j.enabled ? 1 : 0}">${j.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn sm" data-act="sched" data-id="${j.id}" data-cur="${esc(j.schedule)}">Edit</button></td></tr>`
        )
        .join('')}
    </tbody></table>

    <h3 style="margin:18px 0 6px">Recent runs</h3>
    <table class="tbl"><thead><tr><th>Queued</th><th>Site</th><th>Job</th><th>Status</th><th>Exit</th><th>Took</th><th>Note</th></tr></thead><tbody>
      ${runs
        .map(
          r => `<tr class="sch-run" data-id="${r.id}" style="cursor:pointer">
        <td>${schFmtTime(r.queued_at)}</td><td>${esc(r.site)}</td><td>${esc(r.name)}${r.trigger === 'manual' ? ' <span class="badge b-blue">manual</span>' : ''}</td>
        <td>${schBadge(r.status)}</td><td>${r.exit_code ?? ''}</td><td>${schDur(r)}</td><td class="muted">${esc(r.note || '')}</td></tr>
        <tr class="sch-out ${SCH.openRun === r.id ? '' : 'hidden'}" data-for="${r.id}"><td colspan="7"><pre class="mono" style="white-space:pre-wrap;max-height:280px;overflow:auto;margin:0">${SCH.openRun === r.id ? 'loading…' : ''}</pre></td></tr>`
        )
        .join('')}
    </tbody></table>
    <p class="muted" style="margin-top:12px"><b>Adopt</b> stops the site's legacy cron container, then fires its jobs from this scheduler (no doubled ticks); <b>Release</b> reverses it. Schedules edited here are stored in the scheduler DB, not in <span class="mono">crontab.docker</span>.</p>
    </div>`;

  wireScheduler();
  if (SCH.openRun) loadSchRun(SCH.openRun);
  stamp();
}

async function loadSchRun(id) {
  const row = $(`tr.sch-out[data-for="${id}"]`);
  if (!row) return;
  try {
    const r = await api('GET', `/api/scheduler/runs/${id}`);
    row.querySelector('pre').textContent = r.output_tail || '(no output)';
  } catch (e) {
    row.querySelector('pre').textContent = 'failed to load: ' + e.message;
  }
}

async function schAct(fn, okMsg) {
  try {
    const out = await fn();
    const warn = out && out.warnings && out.warnings.length ? ' — ' + out.warnings.join('; ') : '';
    toast(okMsg + warn, warn ? 'warn' : 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
  renderScheduler();
}

function wireScheduler() {
  const root = $('#sch-root');
  $('#sch-pause').addEventListener('click', () => {
    const paused = $('#sch-pause').textContent.startsWith('Resume');
    schAct(
      () => api('PATCH', '/api/scheduler/settings', { paused: !paused }),
      paused ? 'resumed' : 'paused'
    );
  });
  $('#sch-caps-save').addEventListener('click', () => {
    const body = {};
    $$('.sch-cap', root).forEach(i => (body[i.dataset.k] = parseInt(i.value, 10)));
    schAct(() => api('PATCH', '/api/scheduler/settings', body), 'caps saved');
  });
  const txt = $('#sch-text');
  txt.addEventListener('input', () => {
    SCH.text = txt.value;
    clearTimeout(wireScheduler._t);
    wireScheduler._t = setTimeout(renderScheduler, 250);
  });
  const clr = $('#sch-clear');
  if (clr)
    clr.addEventListener('click', e => {
      e.preventDefault();
      SCH.site = '';
      renderScheduler();
    });
  root.addEventListener('click', e => {
    const siteLink = e.target.closest('.sch-site');
    if (siteLink) {
      e.preventDefault();
      SCH.site = siteLink.dataset.site;
      renderScheduler();
      return;
    }
    const runRow = e.target.closest('.sch-run');
    if (runRow) {
      const id = +runRow.dataset.id;
      SCH.openRun = SCH.openRun === id ? null : id;
      $$('tr.sch-out', root).forEach(r => r.classList.add('hidden'));
      if (SCH.openRun) {
        $(`tr.sch-out[data-for="${id}"]`).classList.remove('hidden');
        loadSchRun(id);
      }
      return;
    }
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const { act, id, site } = b.dataset;
    if (act === 'run') schAct(() => api('POST', `/api/scheduler/jobs/${id}/run`), 'queued');
    else if (act === 'toggle')
      schAct(
        () => api('PATCH', `/api/scheduler/jobs/${id}`, { enabled: b.dataset.en !== '1' }),
        b.dataset.en === '1' ? 'disabled' : 'enabled'
      );
    else if (act === 'sched') {
      const v = prompt('New cron schedule (5 fields, America/New_York):', b.dataset.cur);
      if (v && v.trim() !== b.dataset.cur)
        schAct(
          () => api('PATCH', `/api/scheduler/jobs/${id}`, { schedule: v.trim() }),
          'schedule updated'
        );
    } else if (act === 'adopt') {
      if (
        confirm(
          `Adopt ${site}?\n\nThis STOPS and removes its legacy cron container, then runs its jobs from the scheduler.`
        )
      )
        schAct(
          () => api('POST', `/api/scheduler/sites/${encodeURIComponent(site)}/adopt`),
          `${site} adopted`
        );
    } else if (act === 'release') {
      if (confirm(`Release ${site} back to its legacy cron container?`))
        schAct(
          () => api('POST', `/api/scheduler/sites/${encodeURIComponent(site)}/release`),
          `${site} released`
        );
    }
  });
}
