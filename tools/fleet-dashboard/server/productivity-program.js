'use strict';

// A small, durable productivity experiment for the executive fleet. The
// program measures shipped work, not proposals or messages, and compares a
// treatment cohort using the new delivery roles with a control cohort running
// through the existing process.

const LANES = Object.freeze(['finish-sites', 'growth-revenue', 'site-factory']);
const COMPLETED_REQUEST_STATUSES = new Set(['deployed', 'verified', 'completed', 'done']);
const COMPLETED_WORK_STATUSES = new Set(['done', 'completed', 'resolved']);
const DEFAULT_EXCLUDED_SITES = Object.freeze(['3boobs.com']);

function normalizeSites(value) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .map(site => String(site).trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
}

function validatePilotCohorts(
  { treatment_sites = [], control_sites = [] } = {},
  { excluded_sites = DEFAULT_EXCLUDED_SITES, known_sites = null } = {}
) {
  const treatment = normalizeSites(treatment_sites);
  const control = normalizeSites(control_sites);
  const excluded = new Set(normalizeSites(excluded_sites));
  const known = known_sites === null ? null : new Set(normalizeSites(known_sites));
  const errors = [];
  if (!treatment.length || !control.length) errors.push('pilot requires treatment and control sites');
  const overlap = treatment.filter(site => control.includes(site));
  if (overlap.length) errors.push(`pilot cohorts overlap: ${overlap.join(', ')}`);
  const excludedInCohort = [...new Set([...treatment, ...control].filter(site => excluded.has(site)))];
  if (excludedInCohort.length)
    errors.push(`pilot cohort includes excluded site(s): ${excludedInCohort.join(', ')}`);
  if (known) {
    const unknown = [...new Set([...treatment, ...control].filter(site => !known.has(site)))];
    if (unknown.length) errors.push(`pilot cohort includes unknown site(s): ${unknown.join(', ')}`);
  }
  return {
    valid: errors.length === 0,
    errors,
    treatment_sites: treatment,
    control_sites: control,
    excluded_sites: [...excluded],
  };
}

function inWindow(value, from, to) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) && time >= from && time <= to;
}

function laneFor(row) {
  const text =
    `${row.category || ''} ${row.title || ''} ${row.body || ''} ${row.summary || ''}`.toLowerCase();
  if (/design|ux|visual|layout|imagery|accessib/.test(text)) return 'finish-sites';
  if (/affiliate|attribution|amazon|revenue|conversion|monetiz/.test(text)) return 'growth-revenue';
  if (/new site|launch|scaffold|site factory|parked/.test(text)) return 'site-factory';
  if (/seo|search|internal link|content|performance|web vital/.test(text)) return 'growth-revenue';
  return 'finish-sites';
}

function treatmentBatch(pilot) {
  const sites = normalizeSites(pilot?.treatment_sites);
  const pilotId = String(pilot?.pilot_id || pilot?.id || '').trim();
  if (!pilotId) throw new Error('pilot_id is required to build a treatment batch');
  return sites.flatMap(site => [
    {
      site,
      lane: 'finish-sites',
      action_key: `productivity-pilot:${pilotId}:design:${site}`,
      title: 'Treatment pilot: ship one measurable design or UX improvement',
      category: 'design',
      body: 'Select the smallest high-confidence design, layout, accessibility, imagery, or CTA improvement supported by current evidence. Create a preview, record the before state, implement only the scoped change, validate deterministic checks, and report the after state. Include the success metric, measurement window, and rollback path. Do not claim a conversion lift before measurement.',
    },
    {
      site,
      lane: 'growth-revenue',
      action_key: `productivity-pilot:${pilotId}:growth-revenue:${site}`,
      title: 'Treatment pilot: repair one SEO or affiliate revenue path',
      category: 'seo',
      body: 'Use current SEO, analytics, and affiliate evidence to select one repair with a measurable target: crawlability, internal linking, search intent coverage, tracking attribution, or a broken affiliate path. Preserve disclosures and existing revenue paths, validate tracking before and after, and include a rollback path. Do not invent traffic, ranking, or revenue results.',
    },
  ]);
}

function siteCategoryEligibility(site, category, { privatePreviewSites = [] } = {}) {
  const normalizedSite = String(site || '')
    .trim()
    .toLowerCase();
  const normalizedCategory = String(category || '')
    .trim()
    .toLowerCase();
  const privateSites = new Set(normalizeSites(privatePreviewSites));
  if (
    privateSites.has(normalizedSite) &&
    ['seo', 'marketing', 'sales'].includes(normalizedCategory)
  )
    return {
      eligible: false,
      reason:
        'private-preview site is not eligible for SEO, affiliate, or revenue work until launch',
    };
  return { eligible: true, reason: null };
}

function queueReadiness(store, sites) {
  const normalized = normalizeSites(sites);
  const activeRequests = store
    .listChangeRequests({ limit: 1000 })
    .filter(row =>
      ['queued', 'claimed', 'running', 'reviewing', 'review', 'committed'].includes(
        String(row.status || '').toLowerCase()
      )
    );
  const activeRuns = store
    .listImprovements({ limit: 1000 })
    .filter(row => ['proposed', 'building', 'review', 'deployed', 'measuring'].includes(row.state));
  const blocked = [];
  const ready = [];
  for (const site of normalized) {
    const request = activeRequests.find(row => String(row.site || '').toLowerCase() === site);
    const run = activeRuns.find(row => String(row.site || '').toLowerCase() === site);
    if (request || run) {
      blocked.push({
        site,
        reason: request
          ? `active change request: ${request.status}`
          : `active improvement: ${run.state}`,
        measurement_due: run?.measurement_due || null,
      });
    } else ready.push(site);
  }
  return { sites: normalized, ready_sites: ready, blocked_sites: blocked };
}

function emptyGroup() {
  return {
    sites: 0,
    requests_created: 0,
    requests_completed: 0,
    requests_failed: 0,
    work_completed: 0,
    valuable_outputs: 0,
    measurement_ready_outputs: 0,
    design_items: 0,
    seo_items: 0,
    affiliate_items: 0,
    average_cycle_hours: null,
    shipped_output: 0,
  };
}

function measureGroup(rows, sites, from, to) {
  const allowed = new Set(sites);
  const group = emptyGroup();
  group.sites = sites.length;
  const cycleHours = [];
  const runsByRequest = new Map(
    rows.runs.filter(run => run.source_id).map(run => [String(run.source_id), run])
  );
  for (const row of rows.requests) {
    if (!allowed.has(String(row.site || '').toLowerCase()) || !inWindow(row.created_at, from, to))
      continue;
    group.requests_created += 1;
    if (COMPLETED_REQUEST_STATUSES.has(String(row.status || '').toLowerCase())) {
      group.requests_completed += 1;
      const run = runsByRequest.get(String(row.request_id));
      const reportCompleted = row.delivery_mode === 'report_only' && run?.state === 'reported';
      const implementationValidated =
        run?.validation?.passed === true &&
        ['deployed', 'measuring', 'proven', 'inconclusive'].includes(String(run.state || ''));
      if (reportCompleted || implementationValidated) {
        group.valuable_outputs += 1;
        const hasBaseline = run?.baseline && typeof run.baseline === 'object';
        const hasMeasurementWindow =
          reportCompleted || Boolean(String(run?.measurement_due || '').trim());
        if (hasBaseline && hasMeasurementWindow) group.measurement_ready_outputs += 1;
      }
      const start = Date.parse(row.created_at || '');
      const end = Date.parse(row.updated_at || row.finished_at || '');
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start)
        cycleHours.push((end - start) / 3600000);
    }
    if (['failed', 'cancelled'].includes(String(row.status || '').toLowerCase()))
      group.requests_failed += 1;
    const lane = laneFor(row);
    if (
      lane === 'finish-sites' &&
      /design|ux|visual|layout|imagery|accessib/i.test(`${row.category} ${row.title} ${row.body}`)
    )
      group.design_items += 1;
    if (
      /seo|search|internal link|content|performance|web vital/i.test(
        `${row.category} ${row.title} ${row.body}`
      )
    )
      group.seo_items += 1;
    if (
      /affiliate|attribution|amazon|revenue|conversion|monetiz/i.test(
        `${row.category} ${row.title} ${row.body}`
      )
    )
      group.affiliate_items += 1;
  }
  for (const row of rows.work) {
    // Failure-followup rows are recovery projections, not shipped product
    // work. They may be closed when a diagnosis or descendant repair ends,
    // but counting that reconciliation as output would inflate the pilot.
    if (row.source_type === 'failed-change-request') continue;
    // Work items are frequently reconciled when an executive run observes
    // them, even though the underlying work predates the pilot. Counting on
    // updated_at would turn reconciliation activity into fake throughput.
    // Require the work item itself to have entered the measured window. A
    // future explicitly pilot-scoped source can opt in through its source
    // type, but ordinary pre-existing backlog remains out of scope.
    const pilotScoped = String(row.source_type || '').toLowerCase() === 'productivity-pilot';
    if (
      !allowed.has(String(row.site || '').toLowerCase()) ||
      (!inWindow(row.created_at, from, to) && !pilotScoped)
    )
      continue;
    if (COMPLETED_WORK_STATUSES.has(String(row.status || '').toLowerCase()))
      group.work_completed += 1;
  }
  group.average_cycle_hours = cycleHours.length
    ? Number((cycleHours.reduce((sum, value) => sum + value, 0) / cycleHours.length).toFixed(2))
    : null;
  group.shipped_output = group.requests_completed + group.work_completed;
  return group;
}

function snapshot(store, { from, to, treatment_sites = [], control_sites = [] } = {}) {
  const end = to ? Date.parse(to) : Date.now();
  const start = from ? Date.parse(from) : end - 14 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
    throw new Error('invalid productivity measurement window');
  const rows = {
    requests: store.listChangeRequests({ limit: 1000 }),
    work: store.listExecutiveWorkItems({ limit: 1000 }),
    runs: store.listImprovements({ limit: 1000 }),
  };
  const treatment = normalizeSites(treatment_sites);
  const control = normalizeSites(control_sites);
  const result = {
    schema: 'executive-productivity-snapshot/v1',
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    treatment: measureGroup(rows, treatment, start, end),
    control: measureGroup(rows, control, start, end),
  };
  result.treatment.output_per_site = treatment.length
    ? Number((result.treatment.shipped_output / treatment.length).toFixed(2))
    : 0;
  result.control.output_per_site = control.length
    ? Number((result.control.shipped_output / control.length).toFixed(2))
    : 0;
  return result;
}

function evaluate(baseline, current) {
  const t = current?.treatment || emptyGroup();
  const c = current?.control || emptyGroup();
  const baselineTreatment = baseline?.treatment || emptyGroup();
  const baselineControl = baseline?.control || emptyGroup();
  const observedFrom = Date.parse(current?.from || '');
  const observedTo = Date.parse(current?.to || '');
  const observationDays =
    Number.isFinite(observedFrom) && Number.isFinite(observedTo) && observedTo >= observedFrom
      ? (observedTo - observedFrom) / 86400000
      : null;
  const minimumObservationDays = 7;
  if (observationDays !== null && observationDays < minimumObservationDays) {
    return {
      schema: 'executive-productivity-evaluation/v1',
      status: 'inconclusive',
      passed: null,
      observation_days: Number(observationDays.toFixed(2)),
      minimum_observation_days: minimumObservationDays,
      treatment_delta: null,
      control_delta: null,
      completion_rate: null,
      reasons: [
        `measurement window is incomplete: ${Number(observationDays.toFixed(2))} of ${minimumObservationDays} minimum days observed`,
      ],
      guardrails: {
        no_unsafe_authority_change: true,
        legal_security_review_required: true,
        measurement_required: true,
      },
    };
  }
  const reasons = [];
  const treatmentDelta = t.shipped_output - baselineTreatment.shipped_output;
  const controlDelta = c.shipped_output - baselineControl.shipped_output;
  const completionRate = t.requests_created ? t.requests_completed / t.requests_created : 0;
  if (treatmentDelta <= controlDelta) reasons.push('treatment shipped no more output than control');
  if (completionRate < 0.8 && t.requests_created > 0)
    reasons.push('treatment completion rate below 80%');
  if (t.output_per_site < 2) reasons.push('treatment shipped fewer than two outputs per site');
  if ((t.valuable_outputs || 0) < t.shipped_output)
    reasons.push('treatment shipped output lacks a validated implementation or report artifact');
  if ((t.measurement_ready_outputs || 0) < t.shipped_output)
    reasons.push('treatment shipped output lacks durable baseline and measurement evidence');
  if (t.requests_failed > baselineTreatment.requests_failed + 1)
    reasons.push('treatment failures increased beyond tolerance');
  return {
    schema: 'executive-productivity-evaluation/v1',
    status: reasons.length === 0 ? 'passed' : 'needs-adjustment',
    passed: reasons.length === 0,
    observation_days: observationDays === null ? null : Number(observationDays.toFixed(2)),
    minimum_observation_days: minimumObservationDays,
    treatment_delta: treatmentDelta,
    control_delta: controlDelta,
    completion_rate: Number(completionRate.toFixed(3)),
    reasons,
    guardrails: {
      no_unsafe_authority_change: true,
      legal_security_review_required: true,
      measurement_required: true,
    },
  };
}

function recordPilotMeasurement(store, pilot, { now = new Date() } = {}) {
  if (!store || !pilot) throw new Error('store and pilot are required');
  const measuredAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(measuredAt.getTime())) throw new Error('invalid measurement time');
  const current = snapshot(store, {
    from: pilot.start_at,
    to: measuredAt.toISOString(),
    treatment_sites: pilot.treatment_sites,
    control_sites: pilot.control_sites,
  });
  const dueAt = Date.parse(pilot.end_at || '');
  const final = Number.isFinite(dueAt) && measuredAt.getTime() >= dueAt;
  const evaluation = evaluate(pilot.baseline, current);
  if (final) {
    store.createProductivitySnapshot({
      pilot_id: pilot.pilot_id,
      phase: 'evaluation',
      snapshot: current,
      created_at: measuredAt.toISOString(),
    });
    const status =
      evaluation.passed === true
        ? 'passed'
        : evaluation.passed === false
          ? 'needs-adjustment'
          : 'active';
    return {
      final: true,
      current,
      evaluation,
      pilot: store.updateProductivityPilot(pilot.pilot_id, { status, evaluation }),
    };
  }
  store.createProductivitySnapshot({
    pilot_id: pilot.pilot_id,
    phase: 'progress',
    snapshot: current,
    created_at: measuredAt.toISOString(),
  });
  return { final: false, current, evaluation, pilot };
}

module.exports = {
  LANES,
  normalizeSites,
  snapshot,
  evaluate,
  laneFor,
  treatmentBatch,
  siteCategoryEligibility,
  validatePilotCohorts,
  queueReadiness,
  recordPilotMeasurement,
};
