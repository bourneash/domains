'use strict';

/* Scheduler view — Ops ▸ Scheduler. Talks to /api/scheduler/* (proxy to tools/fleet-scheduler).
   Loaded BEFORE app.js; only references app.js globals (api, $, $$, esc, toast, stamp, FRESH) at call time. */

const SCH = {
  site: '',
  text: '',
  jobState: 'all',
  openRun: null,
  inst: 'scheduler',
  page: 1,
  runPage: 1,
  pageSize: window.matchMedia?.('(max-width: 700px)').matches ? 10 : 25,
  runPageSize: window.matchMedia?.('(max-width: 700px)').matches ? 10 : 25,
};
const schBase = () => `/api/${SCH.inst}`;

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

function schJobState(job) {
  if (!job.enabled) return 'disabled';
  if (job.last_run && ['failed', 'timeout', 'lost'].includes(job.last_run.status))
    return 'attention';
  if (job.last_run && ['running', 'queued'].includes(job.last_run.status)) return 'running';
  return 'healthy';
}

async function renderScheduler() {
  const app = $('#app');
  if (FRESH)
    app.innerHTML =
      '<div class="loading" role="status" aria-live="polite">Reading scheduler…</div>';
  let st, jobs, runs;
  try {
    [st, jobs, runs] = await Promise.all([
      api('GET', `${schBase()}/status`),
      api('GET', schBase() + '/jobs' + (SCH.site ? `?site=${encodeURIComponent(SCH.site)}` : '')),
      api(
        'GET',
        schBase() + '/runs?limit=60' + (SCH.site ? `&site=${encodeURIComponent(SCH.site)}` : '')
      ),
    ]);
  } catch (e) {
    const message = `Scheduler unreachable: ${e.message}`;
    if (typeof globalThis.fleetRenderViewError === 'function') {
      globalThis.fleetRenderViewError(app, message);
    } else {
      app.innerHTML = `<div class="page-head"><h2 class="page-title">Scheduler</h2></div><div class="error-box">${esc(message)}<br><span class="muted mono">tools/fleet-scheduler/bin/fleet-scheduler up</span></div>`;
    }
    return;
  }
  const q = SCH.text.trim().toLowerCase();
  const stateJobs = (
    SCH.jobState === 'all' ? jobs : jobs.filter(j => schJobState(j) === SCH.jobState)
  )
    .slice()
    .sort((a, b) => {
      const rank = { attention: 0, running: 1, healthy: 2, disabled: 3 };
      return (
        rank[schJobState(a)] - rank[schJobState(b)] ||
        a.site.localeCompare(b.site) ||
        a.name.localeCompare(b.name)
      );
    });
  const shown = q
    ? stateJobs.filter(j => `${j.site} ${j.name} ${j.schedule}`.toLowerCase().includes(q))
    : stateJobs;
  const jobPageCount = Math.max(1, Math.ceil(shown.length / SCH.pageSize));
  SCH.page = Math.min(SCH.page, jobPageCount);
  const jobPageStart = (SCH.page - 1) * SCH.pageSize;
  const pageJobs = shown.slice(jobPageStart, jobPageStart + SCH.pageSize);
  const runPageCount = Math.max(1, Math.ceil(runs.length / SCH.runPageSize));
  SCH.runPage = Math.min(SCH.runPage, runPageCount);
  const runPageStart = (SCH.runPage - 1) * SCH.runPageSize;
  const pageRuns = runs.slice(runPageStart, runPageStart + SCH.runPageSize);
  if (SCH.openRun && !pageRuns.some(run => run.id === SCH.openRun)) SCH.openRun = null;
  const sites = st.sites || [];
  const adoptedN = sites.filter(s => s.adopted).length;
  const failing = jobs.filter(
    j => j.active && j.last_run && ['failed', 'timeout', 'lost'].includes(j.last_run.status)
  ).length;
  const c = st.counters || {};

  app.innerHTML = `
    <div id="sch-root">
    <div class="page-head"><h1 class="sr-only">Scheduler</h1>
      <div role="tablist" aria-label="Scheduler scope">
        <button type="button" role="tab" class="btn sm ${SCH.inst === 'scheduler' ? 'primary' : ''}" id="sch-tab-sites" aria-selected="${SCH.inst === 'scheduler'}" aria-controls="sch-panel" data-inst="scheduler">Sites</button>
        <button type="button" role="tab" class="btn sm ${SCH.inst === 'scheduler-fleet' ? 'primary' : ''}" id="sch-tab-fleet" aria-selected="${SCH.inst === 'scheduler-fleet'}" aria-controls="sch-panel" data-inst="scheduler-fleet">Fleet tools</button>
      </div>
      <span class="muted">${SCH.inst === 'scheduler' ? `one DB-backed scheduler for ${sites.length} sites · ${adoptedN} adopted · replaces per-site cron containers` : 'fleet-level jobs (tools/fleet-cron): reapers, auth watchdog, social hub tick, AI optimizer…'}</span></div>
    <div id="sch-panel" role="tabpanel" aria-labelledby="${SCH.inst === 'scheduler' ? 'sch-tab-sites' : 'sch-tab-fleet'}">
    <div class="task-toolbar">
      <span class="badge ${st.paused ? 'b-red' : 'b-green'}">${st.paused ? 'PAUSED' : 'active'}</span>
      <strong>${st.running} running · ${st.queued} queued</strong>
      <span class="muted">${st.scheduled}/${st.jobs} jobs scheduled · ${failing} failing · up ${Math.round(st.uptime_s / 3600)}h · lag ${st.loop_lag_s}s</span>
      <span class="muted">runs since start: ${['ok', 'failed', 'timeout', 'skipped_overlap', 'skipped_queue', 'missed'].map(k => `${k} ${c[k] || 0}`).join(' · ')}</span>
      <button type="button" class="btn sm" id="sch-pause" style="margin-left:auto">${st.paused ? 'Resume all' : 'Pause all'}</button>
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
      <button type="button" class="btn sm" id="sch-caps-save">Save caps</button>
      <span class="muted">Heavy = spawns a worker / runs Claude. Excess fires queue instead of all starting on one minute boundary.</span>
    </div>

    <h2 style="margin:14px 0 6px">Sites</h2>
    <div class="table-wrap" style="max-height:260px">
    <table class="tbl"><caption class="sr-only">Scheduler sites and adoption status</caption><thead><tr><th>Site</th><th>Jobs</th><th>Mode</th><th>Actions</th></tr></thead><tbody>
      ${sites
        .map(
          s => `<tr>
        <td><a href="#" class="sch-site" data-site="${esc(s.site)}">${esc(s.site)}</a></td>
        <td>${s.enabled}/${s.jobs}</td>
        <td>${s.adopted ? '<span class="badge b-green">scheduler</span>' : '<span class="badge b-gray">legacy cron container</span>'}</td>
        <td style="text-align:right">${
          SCH.inst === 'scheduler-fleet'
            ? ''
            : s.adopted
              ? `<button type="button" class="btn sm" data-act="release" data-site="${esc(s.site)}" aria-label="Release → legacy for ${esc(s.site)}" title="Release ${esc(s.site)} to its legacy cron container">Release → legacy</button>`
              : `<button type="button" class="btn sm primary" data-act="adopt" data-site="${esc(s.site)}" aria-label="Adopt ${esc(s.site)} into scheduler" title="Adopt ${esc(s.site)} into the database-backed scheduler">Adopt</button>`
        }</td></tr>`
        )
        .join('')}
    </tbody></table>
    </div>

    <h2 style="margin:18px 0 6px">Jobs ${SCH.site ? `— ${esc(SCH.site)} <a href="#" id="sch-clear">(all sites)</a>` : ''}
      <label class="sr-only" for="sch-text">Filter jobs</label><input id="sch-text" type="search" aria-label="Filter scheduler jobs" placeholder="filter…" value="${esc(SCH.text)}" style="margin-left:12px;width:180px"></h2>
    <div class="task-toolbar" role="group" aria-label="Scheduler job views" style="margin-top:0">
      <span class="muted">Show</span>
      ${[
        ['all', `All jobs (${jobs.length})`],
        [
          'attention',
          `Needs attention (${jobs.filter(j => schJobState(j) === 'attention').length})`,
        ],
        ['running', `Running (${jobs.filter(j => schJobState(j) === 'running').length})`],
        ['disabled', `Disabled (${jobs.filter(j => schJobState(j) === 'disabled').length})`],
      ]
        .map(
          ([key, label]) =>
            `<button type="button" class="btn sm ${SCH.jobState === key ? 'primary' : ''}" data-job-state="${key}" aria-pressed="${SCH.jobState === key}">${label}</button>`
        )
        .join('')}
      <span class="muted">${shown.length} matching jobs</span>
    </div>
    ${jobPageCount > 1 ? `<nav class="sch-pagination" aria-label="Scheduled job pages"><span class="muted" id="sch-job-page-status" role="status" aria-live="polite">Showing jobs ${jobPageStart + 1}–${Math.min(jobPageStart + SCH.pageSize, shown.length)} of ${shown.length}</span><label>Rows <select id="sch-job-page-size" aria-label="Scheduled jobs per page">${[10, 25, 50].map(size => `<option value="${size}" ${size === SCH.pageSize ? 'selected' : ''}>${size}</option>`).join('')}</select></label><button type="button" class="btn sm" id="sch-job-prev" aria-label="Previous scheduled job page" ${SCH.page <= 1 ? 'disabled' : ''}>← Previous</button><button type="button" class="btn sm" id="sch-job-next" aria-label="Next scheduled job page" ${SCH.page >= jobPageCount ? 'disabled' : ''}>Next →</button></nav>` : ''}
    <div class="table-wrap"><table class="tbl" id="sch-jobs-table"><caption class="sr-only">Scheduled jobs and controls</caption><thead><tr><th>Site</th><th>Job</th><th>Schedule</th><th>Class</th><th>State</th><th>Next</th><th>Last run</th><th>Actions</th></tr></thead><tbody>
      ${
        pageJobs.length
          ? pageJobs
              .map(
                j => `<tr>
        <td>${esc(j.site)}</td><td>${esc(j.name)}</td><td class="mono">${esc(j.schedule)}</td>
        <td>${esc(j.class)}</td>
        <td>${j.enabled ? (j.active ? '<span class="badge b-green">on</span>' : '<span class="badge b-gray">idle (site not adopted)</span>') : '<span class="badge b-yellow">disabled</span>'}</td>
        <td>${j.active ? schFmtNext(j.next_fire) : '—'}</td>
        <td>${j.last_run ? `${schBadge(j.last_run.status)} <span class="muted">${schFmtTime(j.last_run.finished_at || j.last_run.started_at)}</span>` : '<span class="muted">never</span>'}</td>
        <td style="white-space:nowrap">
          <button type="button" class="btn sm" data-act="run" data-id="${j.id}" aria-label="Run ${esc(j.name)} for ${esc(j.site)}" title="Run ${esc(j.name)} for ${esc(j.site)}">Run</button>
          <button type="button" class="btn sm" data-act="toggle" data-id="${j.id}" data-en="${j.enabled ? 1 : 0}" aria-label="${j.enabled ? 'Disable' : 'Enable'} ${esc(j.name)} for ${esc(j.site)}" title="${j.enabled ? 'Disable' : 'Enable'} ${esc(j.name)} for ${esc(j.site)}">${j.enabled ? 'Disable' : 'Enable'}</button>
          <button type="button" class="btn sm" data-act="sched" data-id="${j.id}" data-cur="${esc(j.schedule)}" aria-label="Edit schedule for ${esc(j.name)} on ${esc(j.site)}" title="Edit schedule for ${esc(j.name)} on ${esc(j.site)}">Edit</button></td></tr>`
              )
              .join('')
          : '<tr><td colspan="8" class="muted">No scheduled jobs match the current filters.</td></tr>'
      }
    </tbody></table></div>

    <h2 style="margin:18px 0 6px">Recent runs <span class="muted">${runs.length} loaded</span></h2>
    ${runPageCount > 1 ? `<nav class="sch-pagination" aria-label="Recent run pages"><span class="muted" id="sch-run-page-status" role="status" aria-live="polite">Showing runs ${runPageStart + 1}–${Math.min(runPageStart + SCH.runPageSize, runs.length)} of ${runs.length}</span><label>Rows <select id="sch-run-page-size" aria-label="Scheduler runs per page">${[10, 25, 50].map(size => `<option value="${size}" ${size === SCH.runPageSize ? 'selected' : ''}>${size}</option>`).join('')}</select></label><button type="button" class="btn sm" id="sch-run-prev" aria-label="Previous scheduler run page" ${SCH.runPage <= 1 ? 'disabled' : ''}>← Previous</button><button type="button" class="btn sm" id="sch-run-next" aria-label="Next scheduler run page" ${SCH.runPage >= runPageCount ? 'disabled' : ''}>Next →</button></nav>` : ''}
    <div class="table-wrap"><table class="tbl" id="sch-runs-table"><caption class="sr-only">Recent scheduler runs</caption><thead><tr><th>Queued</th><th>Site</th><th>Job</th><th>Status</th><th>Exit</th><th>Took</th><th>Note</th></tr></thead><tbody>
      ${
        pageRuns.length
          ? pageRuns
              .map(
                r => `<tr class="sch-run" data-id="${r.id}" role="button" tabindex="0" aria-label="Open run details for ${esc(r.name)} on ${esc(r.site)}" aria-expanded="${SCH.openRun === r.id}" aria-controls="sch-out-${r.id}" style="cursor:pointer">
        <td>${schFmtTime(r.queued_at)}</td><td>${esc(r.site)}</td><td>${esc(r.name)}${r.trigger === 'manual' ? ' <span class="badge b-blue">manual</span>' : ''}</td>
        <td>${schBadge(r.status)}</td><td>${r.exit_code ?? ''}</td><td>${schDur(r)}</td><td class="muted">${esc(r.note || '')}</td></tr>
        <tr class="sch-out ${SCH.openRun === r.id ? '' : 'hidden'}" id="sch-out-${r.id}" data-for="${r.id}"><td colspan="7"><pre class="mono" style="white-space:pre-wrap;max-height:280px;overflow:auto;margin:0">${SCH.openRun === r.id ? 'loading…' : ''}</pre></td></tr>`
              )
              .join('')
          : '<tr><td colspan="7" class="muted">No scheduler runs are available yet.</td></tr>'
      }
    </tbody></table></div>
    <p class="muted" style="margin-top:12px"><b>Adopt</b> stops the site's legacy cron container, then fires its jobs from this scheduler (no doubled ticks); <b>Release</b> reverses it. Schedules edited here are stored in the scheduler DB, not in <span class="mono">crontab.docker</span>.</p>
    </div>
    </div>`;

  wireScheduler();
  if (SCH.openRun) loadSchRun(SCH.openRun);
  stamp();
}

async function loadSchRun(id) {
  const row = $(`tr.sch-out[data-for="${id}"]`);
  if (!row) return;
  try {
    const r = await api('GET', `${schBase()}/runs/${id}`);
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
      () => api('PATCH', schBase() + '/settings', { paused: !paused }),
      paused ? 'resumed' : 'paused'
    );
  });
  $('#sch-caps-save').addEventListener('click', () => {
    const body = {};
    $$('.sch-cap', root).forEach(i => (body[i.dataset.k] = parseInt(i.value, 10)));
    schAct(() => api('PATCH', schBase() + '/settings', body), 'caps saved');
  });
  const txt = $('#sch-text');
  txt.addEventListener('input', () => {
    SCH.text = txt.value;
    SCH.page = 1;
    clearTimeout(wireScheduler._t);
    wireScheduler._t = setTimeout(renderScheduler, 250);
  });
  $$('[data-job-state]', root).forEach(button =>
    button.addEventListener('click', () => {
      SCH.jobState = button.dataset.jobState;
      SCH.page = 1;
      renderScheduler();
    })
  );
  $('#sch-job-page-size')?.addEventListener('change', event => {
    SCH.pageSize = Number(event.target.value) || 10;
    SCH.page = 1;
    renderScheduler();
  });
  $('#sch-job-prev')?.addEventListener('click', () => {
    SCH.page--;
    renderScheduler();
  });
  $('#sch-job-next')?.addEventListener('click', () => {
    SCH.page++;
    renderScheduler();
  });
  $('#sch-run-page-size')?.addEventListener('change', event => {
    SCH.runPageSize = Number(event.target.value) || 10;
    SCH.runPage = 1;
    SCH.openRun = null;
    renderScheduler();
  });
  $('#sch-run-prev')?.addEventListener('click', () => {
    SCH.runPage--;
    SCH.openRun = null;
    renderScheduler();
  });
  $('#sch-run-next')?.addEventListener('click', () => {
    SCH.runPage++;
    SCH.openRun = null;
    renderScheduler();
  });
  const clr = $('#sch-clear');
  if (clr)
    clr.addEventListener('click', e => {
      e.preventDefault();
      SCH.site = '';
      SCH.jobState = 'all';
      SCH.page = 1;
      SCH.runPage = 1;
      renderScheduler();
    });
  root.addEventListener('click', async e => {
    const ib = e.target.closest('button[data-inst]');
    if (ib) {
      SCH.inst = ib.dataset.inst;
      SCH.site = '';
      SCH.page = 1;
      SCH.runPage = 1;
      SCH.openRun = null;
      renderScheduler();
      return;
    }
    const siteLink = e.target.closest('.sch-site');
    if (siteLink) {
      e.preventDefault();
      SCH.site = siteLink.dataset.site;
      SCH.page = 1;
      SCH.runPage = 1;
      renderScheduler();
      return;
    }
    const runRow = e.target.closest('.sch-run');
    if (runRow) {
      const id = +runRow.dataset.id;
      SCH.openRun = SCH.openRun === id ? null : id;
      runRow.setAttribute('aria-expanded', String(SCH.openRun === id));
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
    if (act === 'run') schAct(() => api('POST', `${schBase()}/jobs/${id}/run`), 'queued');
    else if (act === 'toggle')
      schAct(
        () => api('PATCH', `${schBase()}/jobs/${id}`, { enabled: b.dataset.en !== '1' }),
        b.dataset.en === '1' ? 'disabled' : 'enabled'
      );
    else if (act === 'sched') {
      const v = await globalThis.fleetTextPrompt?.({
        title: 'Change cron schedule',
        label: 'New cron schedule (5 fields, America/New_York)',
        placeholder: b.dataset.cur,
        required: true,
        submitLabel: 'Update schedule',
      });
      if (v && v.trim() !== b.dataset.cur)
        schAct(
          () => api('PATCH', `${schBase()}/jobs/${id}`, { schedule: v.trim() }),
          'schedule updated'
        );
    } else if (act === 'adopt') {
      if (
        await globalThis.fleetConfirm?.({
          title: `Adopt ${site}`,
          message:
            'This stops and removes its legacy cron container, then runs its jobs from the scheduler.',
          confirmLabel: 'Adopt site',
          danger: true,
        })
      )
        schAct(
          () => api('POST', `/api/scheduler/sites/${encodeURIComponent(site)}/adopt`),
          `${site} adopted`
        );
    } else if (act === 'release') {
      if (
        await globalThis.fleetConfirm?.({
          title: `Release ${site}`,
          message: 'Release this site back to its legacy cron container?',
          confirmLabel: 'Release site',
        })
      )
        schAct(
          () => api('POST', `/api/scheduler/sites/${encodeURIComponent(site)}/release`),
          `${site} released`
        );
    }
  });
  root.addEventListener('keydown', e => {
    const runRow = e.target.closest('.sch-run');
    if (!runRow || !['Enter', ' '].includes(e.key)) return;
    e.preventDefault();
    runRow.click();
  });
}
