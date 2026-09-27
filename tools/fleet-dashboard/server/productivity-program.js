'use strict';

// A small, durable productivity experiment for the executive fleet. The
// program measures shipped work, not proposals or messages, and compares a
// treatment cohort using the new delivery roles with a control cohort running
// through the existing process.

const LANES = Object.freeze(['finish-sites', 'growth-revenue', 'site-factory']);
const COMPLETED_REQUEST_STATUSES = new Set(['deployed', 'verified', 'completed', 'done']);
const COMPLETED_WORK_STATUSES = new Set(['done', 'completed', 'resolved']);

function normalizeSites(value) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .map(site => String(site).trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
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

function emptyGroup() {
  return {
    sites: 0,
    requests_created: 0,
    requests_completed: 0,
    requests_failed: 0,
    work_completed: 0,
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
  for (const row of rows.requests) {
    if (!allowed.has(String(row.site || '').toLowerCase()) || !inWindow(row.created_at, from, to))
      continue;
    group.requests_created += 1;
    if (COMPLETED_REQUEST_STATUSES.has(String(row.status || '').toLowerCase())) {
      group.requests_completed += 1;
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
    if (!allowed.has(String(row.site || '').toLowerCase()) || !inWindow(row.updated_at, from, to))
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
  const reasons = [];
  const treatmentDelta = t.shipped_output - baselineTreatment.shipped_output;
  const controlDelta = c.shipped_output - baselineControl.shipped_output;
  const completionRate = t.requests_created ? t.requests_completed / t.requests_created : 0;
  if (treatmentDelta <= controlDelta) reasons.push('treatment shipped no more output than control');
  if (completionRate < 0.8 && t.requests_created > 0)
    reasons.push('treatment completion rate below 80%');
  if (t.output_per_site < 2) reasons.push('treatment shipped fewer than two outputs per site');
  if (t.requests_failed > baselineTreatment.requests_failed + 1)
    reasons.push('treatment failures increased beyond tolerance');
  return {
    schema: 'executive-productivity-evaluation/v1',
    passed: reasons.length === 0,
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

module.exports = { LANES, normalizeSites, snapshot, evaluate, laneFor, treatmentBatch };
