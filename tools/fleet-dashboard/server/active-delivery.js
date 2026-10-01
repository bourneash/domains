'use strict';

// The executive-facing delivery layer. This is intentionally a read model over
// the existing change queue and improvement workbench: it does not create a
// second task system or bypass review/deploy gates.

const MAX_ACTIVE_SLOTS = 10;
const EXCLUDED_SITES = new Set(['3boobs.com']);
const ACTIVE_REQUEST_STATUSES = new Set([
  'queued',
  'claimed',
  'running',
  'reviewing',
  'delivery_pending',
  'committed',
]);
const ACTIVE_RUN_STATES = new Set(['proposed', 'building', 'review', 'deployed', 'measuring']);
const TERMINAL_RUN_STATES = new Set(['proven', 'inconclusive', 'failed', 'cancelled']);
const IMPLEMENTATION_STATES = new Set([
  'proposed',
  'building',
  'claimed',
  'running',
  'reviewing',
  'review',
  'committed',
]);

// Measurement is an observation lane, not an implementation worker slot. A
// deployed change must continue collecting evidence, but it must not prevent
// the executive team from starting the next bounded improvement.
function occupiesImplementationSlot(item = {}) {
  return IMPLEMENTATION_STATES.has(String(item.state || '').toLowerCase());
}

function siteOf(row) {
  return String(row?.site || '')
    .trim()
    .toLowerCase();
}

function isExcluded(site) {
  return EXCLUDED_SITES.has(siteOf({ site }));
}

function laneFor(row = {}) {
  const text = [row.title, row.body, row.summary, row.category, row.kind]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/new site|launch|scaffold|site factory|parked domain/.test(text)) return 'site-factory';
  if (/fleet|dashboard|scheduler|tooling|platform|queue|automation/.test(text)) return 'fleet';
  if (/design|ux|visual|layout|imagery|accessib|performance|lcp|web vital/.test(text))
    return 'finish-sites';
  return 'growth-revenue';
}

function priorityRank(value) {
  return { urgent: 0, high: 1, normal: 2, low: 3 }[String(value || '').toLowerCase()] ?? 4;
}

function isImplementationRequest(request) {
  return String(request?.delivery_mode || 'direct').toLowerCase() !== 'report_only';
}

function localDateKey(value, timeZone = 'America/New_York') {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function compactRequest(request, run = null) {
  const site = siteOf(request || run);
  // The request is the authority for a parked review. Its preserved run may
  // still say "review", but no worker can advance it until the infrastructure
  // block is repaired and the request is explicitly revalidated.
  const state =
    request?.status === 'blocked_infrastructure'
      ? 'blocked_infrastructure'
      : run?.state || request?.status || 'unknown';
  return {
    id: request?.request_id || run?.run_id,
    request_id: request?.request_id || run?.source_id || null,
    run_id: run?.run_id || request?.run_id || null,
    source: run ? 'improvement' : 'change-request',
    site,
    title: request?.title || run?.title || 'Untitled delivery work',
    state,
    status: request?.status || null,
    lane: laneFor({ ...request, ...run }),
    owner: request?.assigned_role || run?.assigned_role || 'engineer',
    priority: request?.priority || 'normal',
    delivery_mode: request?.delivery_mode || 'direct',
    created_at: request?.created_at || run?.created_at || null,
    updated_at: request?.updated_at || run?.updated_at || null,
    measurement_due: run?.measurement_due || null,
    deployment_id: run?.deployment_id || null,
    validation: run?.validation || null,
    outcome: run?.outcome || null,
    next_action:
      state === 'review'
        ? 'Complete the review gate and deliver or return with evidence.'
        : state === 'blocked_infrastructure'
          ? 'Repair the recorded infrastructure failure, then revalidate this preserved change.'
          : state === 'measuring'
            ? 'Collect the measurement window; do not start overlapping work in this lane.'
            : state === 'deployed'
              ? 'Start measurement and record the before/after result.'
              : 'Keep the implementation moving toward preview, validation, and review.',
  };
}

function buildDeliveryItems(store, { limit = 1000 } = {}) {
  const requests = store.listChangeRequests({ limit });
  const runs = store.listImprovements({ limit });
  const requestById = new Map(requests.map(row => [String(row.request_id), row]));
  const items = new Map();

  for (const request of requests) {
    const site = siteOf(request);
    if (!site || isExcluded(site) || !isImplementationRequest(request)) continue;
    if (!ACTIVE_REQUEST_STATUSES.has(String(request.status || '').toLowerCase())) continue;
    const run = request.run_id ? store.getImprovement?.(request.run_id) : null;
    const item = compactRequest(request, run);
    items.set(`request:${request.request_id}`, item);
  }

  for (const run of runs) {
    const site = siteOf(run);
    if (!site || isExcluded(site) || !ACTIVE_RUN_STATES.has(String(run.state || '').toLowerCase()))
      continue;
    const request = run.source_id ? requestById.get(String(run.source_id)) : null;
    if (request && !isImplementationRequest(request)) continue;
    const item = compactRequest(request, run);
    const key = request ? `request:${request.request_id}` : `run:${run.run_id}`;
    items.set(key, item);
  }

  return [...items.values()].sort(
    (a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) ||
      Date.parse(a.updated_at || a.created_at || 0) - Date.parse(b.updated_at || b.created_at || 0)
  );
}

function snapshot(store, { now = new Date(), max_slots = MAX_ACTIVE_SLOTS } = {}) {
  const active = buildDeliveryItems(store);
  const capacityActive = active.filter(occupiesImplementationSlot);
  const blocked = active.filter(item => item.state === 'blocked_infrastructure');
  const measuring = active.filter(
    item => !occupiesImplementationSlot(item) && item.state !== 'blocked_infrastructure'
  );
  const slots = capacityActive.slice(0, max_slots);
  const overflow = capacityActive.slice(max_slots);
  const laneCounts = { 'finish-sites': 0, 'growth-revenue': 0, 'site-factory': 0, fleet: 0 };
  for (const item of slots) laneCounts[item.lane] = (laneCounts[item.lane] || 0) + 1;

  const attention = [];
  const siteCounts = new Map();
  for (const item of active) {
    siteCounts.set(item.site, (siteCounts.get(item.site) || 0) + 1);
    if (item.state === 'review') attention.push({ ...item, attention: 'review required' });
    if (item.state === 'blocked_infrastructure')
      attention.push({ ...item, attention: 'infrastructure repair required' });
    if (item.state === 'deployed')
      attention.push({ ...item, attention: 'measurement not started' });
    if (
      item.state === 'measuring' &&
      item.measurement_due &&
      Date.parse(item.measurement_due) < now.getTime()
    )
      attention.push({ ...item, attention: 'measurement overdue' });
  }
  for (const [site, count] of siteCounts) {
    if (count > 1) {
      attention.push({
        id: `site-overlap:${site}`,
        site,
        title: `${count} active delivery items on one site`,
        state: 'attention',
        attention: 'site overlap',
        next_action: 'Finish, pause, or consolidate the existing work before adding more.',
      });
    }
  }

  const requests = store.listChangeRequests({ limit: 1000 });
  const allRuns = store.listImprovements({ limit: 1000 });
  const todayKey = localDateKey(now);
  const todayRequests = requests.filter(row => localDateKey(row.created_at) === todayKey);
  const directToday = todayRequests.filter(isImplementationRequest);
  const reportToday = todayRequests.filter(row => !isImplementationRequest(row));
  const directCompleted = directToday.filter(row =>
    ['deployed', 'verified', 'completed', 'done'].includes(String(row.status || '').toLowerCase())
  );
  const directFailed = directToday.filter(row =>
    ['failed', 'cancelled'].includes(String(row.status || '').toLowerCase())
  );
  const queued = requests.filter(row => row.status === 'queued' && isImplementationRequest(row));
  const oldestQueuedAt = queued
    .map(row => Date.parse(row.created_at || ''))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  const flow = {
    queued_implementation_requests: queued.length,
    oldest_queued_minutes:
      oldestQueuedAt == null
        ? null
        : Math.max(0, Math.floor((now.getTime() - oldestQueuedAt) / 60000)),
    blocked_reviews: blocked.length,
    validated_today: allRuns.filter(
      row =>
        row.validation?.passed === true && localDateKey(row.validation.recorded_at) === todayKey
    ).length,
    deployed_today: allRuns.filter(
      row => localDateKey(row.outcome?.deployment_verified_at) === todayKey
    ).length,
    measured_today: allRuns.filter(
      row =>
        ['proven', 'regressed', 'inconclusive'].includes(row.state) &&
        localDateKey(row.outcome?.measured_at) === todayKey
    ).length,
  };

  return {
    generated_at: new Date(now).toISOString(),
    policy: {
      max_active_slots: max_slots,
      active_slots: slots.length,
      open_slots: Math.max(0, max_slots - slots.length),
      overflow_count: overflow.length,
      measurement_count: measuring.length,
      blocked_review_count: blocked.length,
      excluded_sites: [...EXCLUDED_SITES],
      rule: 'Reports inform delivery; they do not occupy an active delivery slot.',
    },
    slots,
    overflow,
    measuring,
    blocked,
    attention,
    lane_counts: laneCounts,
    flow,
    today: {
      change_requests_created: todayRequests.length,
      implementation_requests_created: directToday.length,
      report_only_requests_created: reportToday.length,
      implementation_requests_completed: directCompleted.length,
      implementation_requests_failed_or_cancelled: directFailed.length,
      reporting_to_delivery_ratio:
        directCompleted.length > 0
          ? Math.round((reportToday.length / directCompleted.length) * 10) / 10
          : null,
    },
    next_actions: [
      ...(overflow.length
        ? [`Reduce ${overflow.length} implementation items to the ten active slots.`]
        : []),
      ...(slots.length < max_slots
        ? [
            `Fill ${max_slots - slots.length} open delivery slot(s) with bounded implementation work.`,
          ]
        : []),
      ...(attention.length
        ? [`Resolve ${attention.length} delivery attention item(s) before generating more reports.`]
        : []),
    ],
  };
}

module.exports = {
  MAX_ACTIVE_SLOTS,
  ACTIVE_REQUEST_STATUSES,
  ACTIVE_RUN_STATES,
  TERMINAL_RUN_STATES,
  occupiesImplementationSlot,
  laneFor,
  isImplementationRequest,
  buildDeliveryItems,
  snapshot,
};
