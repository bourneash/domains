'use strict';

const crypto = require('node:crypto');

const STATES = ['draft', 'running', 'paused', 'completed', 'cancelled'];

function error(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

function validateVariant(row) {
  if (!row || !String(row.key || '').match(/^[a-z0-9_-]{1,40}$/))
    throw error(400, 'variant key is required');
  return {
    key: String(row.key),
    label: String(row.label || row.key),
    allocation: Number(row.allocation || 0),
  };
}

function create(store, input, knownSite) {
  if (!knownSite(input.site)) throw error(404, 'unknown site');
  if (String(input.site).toLowerCase() === '3boobs.com') throw error(403, 'excluded site');
  if (!String(input.hypothesis || '').trim() || !String(input.primary_metric || '').trim())
    throw error(400, 'hypothesis and primary_metric are required');
  const variants = (input.variants || []).map(validateVariant);
  if (variants.length < 2 || variants.length > 4)
    throw error(400, 'experiments require 2-4 variants');
  const experiment = {
    experiment_id: input.experiment_id || crypto.randomUUID(),
    site: String(input.site),
    name: String(input.name || 'Untitled experiment'),
    hypothesis: String(input.hypothesis),
    primary_metric: String(input.primary_metric),
    guardrail_metrics: Array.isArray(input.guardrail_metrics)
      ? input.guardrail_metrics.map(String).slice(0, 10)
      : [],
    variants,
    minimum_samples: Math.max(50, Number(input.minimum_samples) || 1000),
    state: 'draft',
    created_at: new Date().toISOString(),
  };
  store.record({
    event_type: 'experiment.created',
    source: 'experiments',
    site_id: `site:${experiment.site}`,
    entity_type: 'experiment',
    entity_id: experiment.experiment_id,
    correlation_id: `experiment:${experiment.experiment_id}`,
    payload: experiment,
  });
  return experiment;
}

function latest(store, id) {
  return store.list({ entity_type: 'experiment', entity_id: id, limit: 1 })[0]?.payload || null;
}
function transition(store, id, state) {
  if (!STATES.includes(state)) throw error(400, 'invalid experiment state');
  const current = latest(store, id);
  if (!current) throw error(404, 'experiment not found');
  if (state === 'running' && current.state !== 'draft' && current.state !== 'paused')
    throw error(409, 'experiment cannot start from current state');
  const next = { ...current, state, updated_at: new Date().toISOString() };
  store.record({
    event_type: 'experiment.updated',
    source: 'experiments',
    site_id: `site:${next.site}`,
    entity_type: 'experiment',
    entity_id: id,
    correlation_id: `experiment:${id}`,
    payload: next,
  });
  return next;
}

function recordEvent(store, input, knownSite) {
  if (!knownSite(input.site)) throw error(404, 'unknown site');
  const experiment = latest(store, input.experiment_id);
  if (!experiment) throw error(404, 'experiment not found');
  if (!experiment.variants.some(row => row.key === input.variant))
    throw error(400, 'unknown experiment variant');
  const row = {
    event_id: input.event_id || crypto.randomUUID(),
    experiment_id: input.experiment_id,
    site: String(input.site),
    variant: String(input.variant),
    metric: String(input.metric || experiment.primary_metric),
    converted: input.converted === true,
    subject_ref: input.subject_ref ? String(input.subject_ref) : null,
    occurred_at: input.occurred_at || new Date().toISOString(),
  };
  store.record({
    event_type: 'experiment.event.recorded',
    source: 'experiments',
    site_id: `site:${row.site}`,
    entity_type: 'experiment-event',
    entity_id: row.event_id,
    correlation_id: `experiment:${row.experiment_id}`,
    payload: row,
  });
  return row;
}

function analyze(store, id) {
  const experiment = latest(store, id);
  if (!experiment) throw error(404, 'experiment not found');
  const events = store
    .list({ entity_type: 'experiment-event', limit: 2000 })
    .map(row => row.payload)
    .filter(row => row.experiment_id === id);
  const variants = experiment.variants.map(variant => {
    const rows = events.filter(row => row.variant === variant.key);
    const conversions = rows.filter(row => row.converted).length;
    return {
      ...variant,
      exposures: rows.length,
      conversions,
      conversion_rate: rows.length ? conversions / rows.length : null,
    };
  });
  const control = variants[0];
  return {
    experiment,
    generated_at: new Date().toISOString(),
    variants,
    sample_ready: variants.every(row => row.exposures >= experiment.minimum_samples),
    winner:
      (control &&
        variants
          .slice(1)
          .filter(row => row.conversion_rate != null && control.conversion_rate != null)
          .sort((a, b) => b.conversion_rate - a.conversion_rate)[0]?.key) ||
      null,
  };
}

function list(store, { site, state, limit = 100 } = {}) {
  const seen = new Map();
  for (const event of store.list({ entity_type: 'experiment', limit: 2000 }))
    if (!seen.has(event.entity_id)) seen.set(event.entity_id, event.payload);
  return [...seen.values()]
    .filter(row => (!site || row.site === site) && (!state || row.state === state))
    .slice(0, Number(limit) || 100)
    .map(row => ({ ...row, analysis: analyze(store, row.experiment_id) }));
}

function summary(store) {
  const rows = list(store, { limit: 1000 });
  return {
    generated_at: new Date().toISOString(),
    total: rows.length,
    running: rows.filter(row => row.state === 'running').length,
    draft: rows.filter(row => row.state === 'draft').length,
    completed: rows.filter(row => row.state === 'completed').length,
    sample_ready: rows.filter(row => row.analysis.sample_ready).length,
  };
}

module.exports = { STATES, create, transition, recordEvent, analyze, list, summary };
