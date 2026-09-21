'use strict';
const crypto = require('node:crypto');
const STATES = ['draft', 'planned', 'active', 'paused', 'completed', 'cancelled'];
const CHANNELS = ['seo', 'social', 'email', 'partner', 'affiliate', 'direct'];
function fail(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}
function latest(store, id) {
  return store.list({ entity_type: 'campaign', entity_id: id, limit: 1 })[0]?.payload || null;
}
function create(store, input, knownSite, buildUtmUrl) {
  if (!knownSite(input.site)) throw fail(404, 'unknown site');
  if (String(input.site).toLowerCase() === '3boobs.com') throw fail(403, 'excluded site');
  if (!String(input.name || '').trim() || !CHANNELS.includes(String(input.channel)))
    throw fail(400, 'name and valid channel are required');
  const utm = input.utm || {
    utm_source: input.channel,
    utm_medium: input.channel,
    utm_campaign: String(input.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-'),
  };
  const campaign = {
    campaign_id: input.campaign_id || crypto.randomUUID(),
    site: String(input.site),
    name: String(input.name),
    channel: String(input.channel),
    objective: String(input.objective || 'learn'),
    status: 'draft',
    consent_required: ['email', 'partner'].includes(String(input.channel)),
    utm,
    landing_url: input.landing_url ? buildUtmUrl(input.landing_url, utm) : null,
    created_at: new Date().toISOString(),
  };
  store.record({
    event_type: 'campaign.created',
    source: 'campaigns',
    site_id: `site:${campaign.site}`,
    entity_type: 'campaign',
    entity_id: campaign.campaign_id,
    correlation_id: `campaign:${campaign.campaign_id}`,
    payload: campaign,
  });
  return campaign;
}
function transition(store, id, status) {
  if (!STATES.includes(status)) throw fail(400, 'invalid campaign state');
  const current = latest(store, id);
  if (!current) throw fail(404, 'campaign not found');
  const next = { ...current, status, updated_at: new Date().toISOString() };
  store.record({
    event_type: 'campaign.updated',
    source: 'campaigns',
    site_id: `site:${next.site}`,
    entity_type: 'campaign',
    entity_id: id,
    correlation_id: `campaign:${id}`,
    payload: next,
  });
  return next;
}
function touch(store, input, knownSite) {
  if (!knownSite(input.site)) throw fail(404, 'unknown site');
  const row = {
    touch_id: input.touch_id || crypto.randomUUID(),
    campaign_id: String(input.campaign_id),
    site: String(input.site),
    type: String(input.type || 'click'),
    occurred_at: input.occurred_at || new Date().toISOString(),
  };
  store.record({
    event_type: 'campaign.touch.recorded',
    source: 'campaigns',
    site_id: `site:${row.site}`,
    entity_type: 'campaign-touch',
    entity_id: row.touch_id,
    correlation_id: `campaign:${row.campaign_id}`,
    payload: row,
  });
  return row;
}
function list(store, { site, status, limit = 100 } = {}) {
  const seen = new Map();
  for (const event of store.list({ entity_type: 'campaign', limit: 2000 }))
    if (!seen.has(event.entity_id)) seen.set(event.entity_id, event.payload);
  return [...seen.values()]
    .filter(row => (!site || row.site === site) && (!status || row.status === status))
    .slice(0, Number(limit) || 100);
}
function summary(store) {
  const rows = list(store, { limit: 1000 });
  return {
    generated_at: new Date().toISOString(),
    total: rows.length,
    active: rows.filter(row => row.status === 'active').length,
    by_channel: Object.fromEntries(
      CHANNELS.map(channel => [channel, rows.filter(row => row.channel === channel).length])
    ),
  };
}
module.exports = { STATES, CHANNELS, create, transition, touch, list, summary };
