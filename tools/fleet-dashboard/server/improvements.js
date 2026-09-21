'use strict';

const crypto = require('node:crypto');
const tasks = require('./tasks');

const TRANSITIONS = {
  proposed: ['building', 'cancelled'],
  building: ['review', 'reported', 'cancelled'],
  review: ['building', 'deployed', 'cancelled'],
  deployed: ['measuring', 'rolled-back'],
  measuring: ['proven', 'regressed', 'inconclusive', 'rolled-back'],
  regressed: ['building', 'rolled-back'],
  proven: [],
  inconclusive: [],
  cancelled: [],
  'rolled-back': [],
  reported: [],
};

function measurementDate(days = 28, now = Date.now()) {
  return new Date(now + days * 86400000).toISOString().slice(0, 10);
}

function start({ store, root, site, action, baseline = {} }) {
  if (!action || !action.key || action.site !== site)
    throw httpErr(400, 'invalid improvement action');
  const duplicate = store
    .listImprovements({ source: 'seo-intelligence', source_id: action.key, limit: 10 })
    .find(row => !['cancelled', 'rolled-back'].includes(row.state));
  if (duplicate) return { run: duplicate, duplicate: true };
  const runId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const correlationId = `improvement:${runId}`;
  const due = measurementDate();
  const plan = (action.plan || []).map((step, index) => `${index + 1}. ${step}`).join('\n');
  const file = tasks.create(root, site, 'backlog', {
    task_id: taskId,
    title: action.title,
    priority: action.priority === 'high' ? 1 : action.priority === 'medium' ? 2 : 3,
    type: 'site-improvement',
    estimated_turns: action.priority === 'high' ? 3 : 2,
    assigned_role: ['web-vitals', 'broken-links', 'crawlability'].includes(action.type)
      ? 'engineer'
      : 'seo-analyst',
    source: 'improvement-workbench',
    source_id: action.key,
    correlation_id: correlationId,
    measurement_due: due,
    body: `## Evidence\n\n${action.evidence || ''}\n\n## Proposed change\n\n${action.recommendation || action.title}\n\n## Execution plan\n\n${plan}\n\n## Acceptance criteria\n\n- Complete the proposed change in an isolated branch.\n- Record build, test, accessibility, performance, link, metadata, analytics, and visual checks.\n- Review a preview before deployment.\n- Compare post-deployment results with the captured baseline.\n\nimprovement-run: ${runId}\nseo-intelligence-key: ${action.key}\n`,
  });
  const run = store.createImprovement({
    run_id: runId,
    site,
    source: 'seo-intelligence',
    source_id: action.key,
    correlation_id: correlationId,
    task_id: taskId,
    task_file: file,
    title: action.title,
    measurement_due: due,
    agent: {
      assigned_role: ['web-vitals', 'broken-links', 'crawlability'].includes(action.type)
        ? 'engineer'
        : 'seo-analyst',
      status: 'not-started',
    },
    baseline: {
      captured_at: new Date().toISOString(),
      analytics: baseline,
      evidence: action.evidence || '',
      opportunity_score: action.score || 0,
      value_score: action.valueScore || 0,
    },
  });
  store.record({
    event_type: 'improvement.started',
    source: 'improvement-workbench',
    site_id: `site:${site}`,
    entity_type: 'improvement',
    entity_id: runId,
    correlation_id: correlationId,
    payload: { task_id: taskId, task_file: file, source_id: action.key },
  });
  return { run, duplicate: false };
}

function startManual({ store, root, request }) {
  const runId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const correlationId = `change-request:${request.request_id}`;
  const file = tasks.create(root, request.site, 'backlog', {
    task_id: taskId,
    title: request.title,
    priority: request.priority === 'high' ? 1 : request.priority === 'medium' ? 2 : 3,
    type: request.category,
    estimated_turns: request.max_turns,
    assigned_role: request.assigned_role || 'engineer',
    source: 'fleet-dashboard',
    source_id: request.request_id,
    correlation_id: correlationId,
    body: `## Human request\n\n${request.body}\n\n## Agent configuration\n\n- Provider: ${request.provider}\n- Model: ${request.model || 'provider default'}\n- Max turns: ${request.max_turns}\n- Role: ${request.assigned_role || 'engineer'}\n\nchange-request: ${request.request_id}\n`,
  });
  const run = store.createImprovement({
    run_id: runId,
    site: request.site,
    source: 'fleet-dashboard',
    source_id: request.request_id,
    correlation_id: correlationId,
    task_id: taskId,
    task_file: file,
    title: request.title,
    agent: {
      assigned_role: request.assigned_role || 'engineer',
      provider: request.provider,
      model: request.model || null,
      max_turns: request.max_turns,
      status: 'not-started',
    },
    baseline: {
      captured_at: new Date().toISOString(),
      evidence: request.body,
      request_category: request.category,
    },
  });
  store.record({
    event_type: 'improvement.started',
    source: 'fleet-dashboard',
    site_id: `site:${request.site}`,
    entity_type: 'improvement',
    entity_id: runId,
    correlation_id: correlationId,
    payload: { task_id: taskId, task_file: file, request_id: request.request_id },
  });
  return { run, task_file: file };
}

function transition(store, runId, input = {}) {
  const current = store.getImprovement(runId);
  if (!current) throw httpErr(404, 'improvement run not found');
  const state = String(input.state || '');
  if (!(TRANSITIONS[current.state] || []).includes(state))
    throw httpErr(409, `cannot transition ${current.state} to ${state}`);
  if (state === 'deployed' && !input.deployment_id) throw httpErr(400, 'deployment_id is required');
  if (input.preview_url && !/^https?:\/\/[^\s]+$/i.test(String(input.preview_url)))
    throw httpErr(400, 'preview_url must be http or https');
  if (
    state === 'review' &&
    current.validation?.passed !== true &&
    input.validation?.passed !== true
  )
    throw httpErr(409, 'build, tests and diff validation must pass before review');
  if (
    ['proven', 'regressed', 'inconclusive'].includes(state) &&
    (!input.outcome || !input.outcome.measured_at)
  )
    throw httpErr(400, 'a measured outcome is required');
  const patch = { state };
  for (const key of [
    'branch',
    'preview_url',
    'deployment_id',
    'measurement_due',
    'validation',
    'outcome',
    'approval',
    'production_before',
  ])
    if (Object.prototype.hasOwnProperty.call(input, key)) patch[key] = input[key];
  const run = store.updateImprovement(runId, patch);
  store.record({
    event_type: `improvement.${state}`,
    source: 'improvement-workbench',
    site_id: `site:${run.site}`,
    entity_type: 'improvement',
    entity_id: runId,
    correlation_id: run.correlation_id,
    payload: { from: current.state, ...patch },
  });
  return run;
}

function summary(runs) {
  const staleBefore = Date.now() - 24 * 60 * 60 * 1000;
  runs = runs.map(run => ({
    ...run,
    stale:
      !['proven', 'inconclusive', 'cancelled', 'rolled-back'].includes(run.state) &&
      Date.parse(run.updated_at) < staleBefore,
  }));
  const totals = { all: runs.length };
  for (const run of runs) totals[run.state] = (totals[run.state] || 0) + 1;
  return { runs, totals, states: Object.keys(TRANSITIONS), transitions: TRANSITIONS };
}

function expectedTaskColumn(state) {
  if (state === 'proposed') return 'backlog';
  if (['building', 'review'].includes(state)) return 'in-progress';
  if (state === 'cancelled') return 'hold';
  return 'done';
}

function compareOutcome(baseline, current, measuredAt = new Date().toISOString()) {
  const keys = ['sessions', 'conversions', 'clicks', 'impressions'];
  const deltas = {};
  for (const key of keys) {
    if (!Number.isFinite(Number(baseline?.[key])) || !Number.isFinite(Number(current?.[key])))
      continue;
    const before = Number(baseline[key]),
      after = Number(current[key]);
    deltas[key] = {
      before,
      after,
      absolute: after - before,
      percent: before === 0 ? null : Math.round(((after - before) / before) * 1000) / 10,
    };
  }
  const conversion = deltas.conversions;
  const traffic = deltas.sessions || deltas.clicks;
  const sample = Math.max(Number(baseline?.sessions) || 0, Number(baseline?.impressions) || 0);
  const enoughTraffic =
    (deltas.sessions && Number(baseline.sessions) >= 100) ||
    (deltas.clicks && Number(baseline.impressions) >= 500);
  const enoughConversions = conversion && Number(baseline.conversions) >= 5;
  let classification = 'inconclusive';
  if (
    (enoughConversions && conversion.percent >= 10) ||
    (enoughTraffic && traffic.percent != null && traffic.percent >= 10)
  )
    classification = 'proven';
  else if (
    (enoughConversions && conversion.percent <= -10) ||
    (enoughTraffic && traffic.percent != null && traffic.percent <= -10)
  )
    classification = 'regressed';
  return {
    measured_at: measuredAt,
    window_days: current?.window_days || 28,
    has_data: current?.has_data !== false && Object.keys(deltas).length > 0,
    deltas,
    confidence: sample >= 1000 ? 'high' : sample >= 100 ? 'medium' : 'low',
    thresholds: { minimum_sessions: 100, minimum_impressions: 500, material_change_percent: 10 },
    classification:
      current?.has_data === false || !Object.keys(deltas).length ? 'inconclusive' : classification,
  };
}

function httpErr(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

module.exports = {
  start,
  startManual,
  transition,
  summary,
  compareOutcome,
  expectedTaskColumn,
  measurementDate,
  TRANSITIONS,
};
