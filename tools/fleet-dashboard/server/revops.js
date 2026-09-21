'use strict';

const crypto = require('node:crypto');

const STAGES = [
  'subscriber',
  'lead',
  'mql',
  'sql',
  'opportunity',
  'customer',
  'evangelist',
  'recycled',
  'disqualified',
];
const FIT_WEIGHTS = { company: 20, role: 15, geography: 10, intent: 25 };
const ENGAGEMENT_WEIGHTS = {
  page_view: 2,
  content_download: 8,
  pricing_view: 12,
  affiliate_click: 10,
  form_submit: 20,
  meeting_booked: 30,
};

function err(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

function assertSite(site, knownSite) {
  if (!String(site || '').trim() || (knownSite && !knownSite(site))) throw err(404, 'unknown site');
  if (String(site).toLowerCase() === '3boobs.com') throw err(403, 'excluded site');
}

function scoreLead(input = {}) {
  const fit = Math.min(
    70,
    Object.entries(FIT_WEIGHTS).reduce((n, [key, weight]) => n + (input.fit?.[key] ? weight : 0), 0)
  );
  const engagement = Math.min(
    30,
    Object.entries(input.engagement || {}).reduce(
      (n, [key, value]) => n + (ENGAGEMENT_WEIGHTS[key] || 0) * Math.min(Number(value) || 0, 3),
      0
    )
  );
  const score = Math.min(100, fit + engagement);
  return {
    fit,
    engagement,
    score,
    stage: score >= 70 ? 'mql' : score >= 35 ? 'lead' : 'subscriber',
  };
}

function publicLead(input = {}) {
  const scored = scoreLead(input);
  return {
    lead_id: String(input.lead_id || crypto.randomUUID()),
    site: String(input.site),
    source: String(input.source || 'unknown'),
    consent: input.consent === true,
    contact_ref: input.contact_ref ? String(input.contact_ref) : null,
    owner: String(input.owner || 'ceo'),
    stage: STAGES.includes(String(input.stage)) ? String(input.stage) : scored.stage,
    fit_score: scored.fit,
    engagement_score: scored.engagement,
    score: scored.score,
    fit: input.fit || {},
    engagement: input.engagement || {},
    created_at: input.created_at || new Date().toISOString(),
    last_activity_at: input.last_activity_at || input.created_at || new Date().toISOString(),
    sla_due_at: input.sla_due_at || null,
  };
}

function createLead(store, input, knownSite) {
  assertSite(input.site, knownSite);
  const lead = publicLead(input);
  if (!lead.consent && input.contact_ref) throw err(400, 'contact_ref requires consent');
  store.record({
    event_type: 'revops.lead.created',
    source: 'revops',
    site_id: `site:${lead.site}`,
    entity_type: 'revops-lead',
    entity_id: lead.lead_id,
    correlation_id: `lead:${lead.lead_id}`,
    payload: lead,
  });
  return lead;
}

function updateLead(store, id, patch, knownSite) {
  const current = latest(store, id);
  if (!current) throw err(404, 'lead not found');
  if (patch.site) assertSite(patch.site, knownSite);
  if (patch.stage && !STAGES.includes(String(patch.stage)))
    throw err(400, 'invalid lifecycle stage');
  const next = publicLead({ ...current, ...patch, lead_id: id, site: patch.site || current.site });
  store.record({
    event_type: 'revops.lead.updated',
    source: 'revops',
    site_id: `site:${next.site}`,
    entity_type: 'revops-lead',
    entity_id: id,
    correlation_id: `lead:${id}`,
    payload: next,
  });
  return next;
}

function recordActivity(store, input, knownSite) {
  assertSite(input.site, knownSite);
  const activity = {
    activity_id: input.activity_id || crypto.randomUUID(),
    lead_id: input.lead_id || null,
    site: String(input.site),
    type: String(input.type || 'page_view'),
    value: Number(input.value) || 1,
    source: String(input.source || 'first-party'),
    occurred_at: input.occurred_at || new Date().toISOString(),
  };
  if (!/^[a-z][a-z0-9_]{1,50}$/.test(activity.type)) throw err(400, 'invalid activity type');
  store.record({
    event_type: 'revops.activity.recorded',
    source: 'revops',
    site_id: `site:${activity.site}`,
    entity_type: 'revops-activity',
    entity_id: activity.activity_id,
    correlation_id: activity.lead_id
      ? `lead:${activity.lead_id}`
      : `activity:${activity.activity_id}`,
    payload: activity,
  });
  if (activity.lead_id) {
    const lead = latest(store, activity.lead_id);
    if (lead)
      updateLead(
        store,
        activity.lead_id,
        {
          last_activity_at: activity.occurred_at,
          engagement: {
            ...(lead.engagement || {}),
            [activity.type]: (lead.engagement?.[activity.type] || 0) + activity.value,
          },
        },
        knownSite
      );
  }
  return activity;
}

function latest(store, id) {
  return (
    store.list({ entity_type: 'revops-lead', entity_id: String(id), limit: 1 })[0]?.payload || null
  );
}

function leads(store, { site, stage, limit = 250 } = {}) {
  const seen = new Map();
  for (const event of store.list({
    entity_type: 'revops-lead',
    limit: Math.min(Number(limit) * 5, 2000),
  })) {
    if (!seen.has(event.entity_id)) seen.set(event.entity_id, event.payload);
  }
  return [...seen.values()]
    .filter(row => (!site || row.site === site) && (!stage || row.stage === stage))
    .slice(0, Number(limit) || 250);
}

function summary(store, { site } = {}) {
  const rows = leads(store, { site, limit: 1000 });
  const stages = Object.fromEntries(
    STAGES.map(stage => [stage, rows.filter(row => row.stage === stage).length])
  );
  const now = Date.now();
  const overdue = rows.filter(
    row =>
      row.sla_due_at &&
      Date.parse(row.sla_due_at) < now &&
      !['customer', 'disqualified', 'recycled'].includes(row.stage)
  ).length;
  return {
    generated_at: new Date().toISOString(),
    sites: site ? [site] : [...new Set(rows.map(row => row.site))],
    total_leads: rows.length,
    stages,
    mqls: stages.mql || 0,
    sqls: stages.sql || 0,
    opportunities: stages.opportunity || 0,
    customers: stages.customer || 0,
    overdue_sla: overdue,
    score_average: rows.length
      ? Math.round(rows.reduce((n, row) => n + Number(row.score || 0), 0) / rows.length)
      : 0,
  };
}

function buildUtmUrl(baseUrl, params = {}) {
  const url = new URL(String(baseUrl));
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    if (params[key] != null && String(params[key]).trim())
      url.searchParams.set(
        key,
        String(params[key])
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9._~-]+/g, '-')
      );
  }
  return url.toString();
}

module.exports = {
  STAGES,
  scoreLead,
  createLead,
  updateLead,
  recordActivity,
  leads,
  summary,
  buildUtmUrl,
};
