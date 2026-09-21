'use strict';

// Read-only telemetry request broker. Data requests are fulfilled by the
// trusted control plane from the fresh snapshot when possible, or by the
// existing first-party adapters when a fresh snapshot is unavailable. They do
// not enter the implementation/approval queue.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const executive = require('./executive');
const executiveSnapshot = require('./executive-snapshot');

const ACTORS = new Set(['owner', 'ceo', 'cto', 'cfo', 'cro', 'domain-manager', 'researcher']);
const SOURCES = new Set([
  'registry',
  'analytics',
  'seo_intelligence',
  'revenue',
  'ai_usage',
  'social',
  'datahub_health',
  'datahub_sources',
  'datahub_datasets',
  'revops',
  'experiments',
  'campaigns',
  'priorities',
  'operations',
]);
const MAX_QUESTION = 500;
const MAX_SITES = 10;
const MAX_SOURCES = 8;

function dir(root) {
  return path.join(root, 'tools', 'executive', 'data', 'data-requests');
}

function normalize(input = {}, managedSites = []) {
  const requestedBy = String(input.requested_by || input.actor || 'owner').trim();
  if (!ACTORS.has(requestedBy)) throw new Error('invalid data request actor');
  const question = String(input.question || '').trim();
  if (!question || question.length > MAX_QUESTION) throw new Error('invalid data request question');
  const sites = [...new Set((Array.isArray(input.sites) ? input.sites : []).map(String))]
    .filter(site => managedSites.includes(site))
    .slice(0, MAX_SITES);
  const sources = [...new Set((Array.isArray(input.sources) ? input.sources : []).map(String))]
    .filter(source => SOURCES.has(source))
    .slice(0, MAX_SOURCES);
  return {
    request_id: input.request_id || crypto.randomUUID(),
    requested_by: requestedBy,
    question,
    sites,
    sources,
  };
}

function selectBundle(bundle, request) {
  const intelligence = bundle.intelligence || bundle;
  const wanted = request.sources.length ? request.sources : Object.keys(intelligence.sources || {});
  const sources = Object.fromEntries(wanted.map(key => [key, intelligence.sources?.[key] || null]));
  const decisionSupport = Object.fromEntries(
    wanted
      .filter(key => intelligence.decision_support?.[key] !== undefined)
      .map(key => [key, intelligence.decision_support[key]])
  );
  return {
    request_id: request.request_id,
    requested_by: request.requested_by,
    question: request.question,
    generated_at: bundle.generated_at || intelligence.generated_at,
    scope: bundle.scope || intelligence.scope || null,
    sources,
    decision_support: decisionSupport,
  };
}

async function fulfill({ store, root, request, managedSites = [] } = {}) {
  const normalized = normalize(request, managedSites);
  const requestedAt = new Date().toISOString();
  store.record({
    event_type: 'executive.data-requested',
    source: 'executive-data-broker',
    entity_type: 'executive-data-request',
    entity_id: normalized.request_id,
    correlation_id: `executive-data-request:${normalized.request_id}`,
    payload: normalized,
  });
  try {
    const cached = executiveSnapshot.readLatest(root, { sites: normalized.sites });
    const bundle = cached
      ? cached
      : {
          ...(await require('./executive-intel').collect({ root, sites: normalized.sites })),
          schema: 'live',
        };
    const result = selectBundle(bundle, normalized);
    const outputDir = dir(root);
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    const file = path.join(outputDir, `${normalized.request_id}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    const response = {
      request_id: normalized.request_id,
      requested_by: normalized.requested_by,
      status: 'fulfilled',
      source: cached ? 'scheduled-snapshot' : 'live-collection',
      generated_at: result.generated_at,
      artifact: `/api/executive/data-requests/${normalized.request_id}`,
      sources: Object.fromEntries(
        Object.entries(result.sources).map(([key, value]) => [
          key,
          {
            ok: value?.ok !== false,
            observed_at: value?.observed_at || null,
            error: value?.error || null,
          },
        ])
      ),
    };
    store.record({
      event_type: 'executive.data-fulfilled',
      source: 'executive-data-broker',
      entity_type: 'executive-data-request',
      entity_id: normalized.request_id,
      correlation_id: `executive-data-request:${normalized.request_id}`,
      payload: response,
    });
    executive.message(store, {
      actor: 'system',
      body: `Data request fulfilled for ${normalized.requested_by}: ${normalized.question}. Result: ${response.artifact}; source=${response.source}; generated=${response.generated_at}.`,
      metadata: { kind: 'executive-data-response', ...response },
    });
    return response;
  } catch (error) {
    const response = { request_id: normalized.request_id, status: 'failed', error: error.message };
    store.record({
      event_type: 'executive.data-failed',
      source: 'executive-data-broker',
      entity_type: 'executive-data-request',
      entity_id: normalized.request_id,
      correlation_id: `executive-data-request:${normalized.request_id}`,
      payload: response,
    });
    executive.message(store, {
      actor: 'system',
      body: `Data request failed for ${normalized.requested_by}: ${normalized.question}. Error: ${error.message}.`,
      metadata: { kind: 'executive-data-response', ...response },
    });
    return response;
  }
}

function recent(store, limit = 20) {
  return store
    .list({ event_type: 'executive.data-fulfilled', limit })
    .map(event => event.payload || {});
}

function read(root, id) {
  if (!/^[a-f0-9-]{20,80}$/i.test(String(id))) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(root), `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { SOURCES: [...SOURCES], normalize, fulfill, recent, read };
