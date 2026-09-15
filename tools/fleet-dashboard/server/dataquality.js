'use strict';

const registry = require('./fleetregistry');

function assess({ root, discoveredSites = [], analyticsHealth = {}, seo = {}, revenue = {}, aiUsage = {} }) {
  const reg = registry.read(root);
  const live = reg.sites.filter(s => s.lifecycle === 'live');
  const expectedAnalytics = live.filter(s => s.capabilities.includes('analytics')).map(s => s.domain);
  const analyticsSites = analyticsHealth.sites || {};
  const now = Date.now();
  const contracts = [
    contract('fleet-registry', reg.ok, reg.sites.length, reg.sites.length, null, reg.error),
    contract('operational-checkouts', true, live.length, live.filter(s => discoveredSites.includes(s.domain)).length),
    contract('analytics', true, expectedAnalytics.length, expectedAnalytics.filter(s => analyticsSites[s]).length,
      newest(Object.values(analyticsSites).flatMap(s => [s.ga4?.last_fetch_at, s.gsc?.last_fetch_at]))),
    contract('seo-intelligence', seo.upstream?.ok !== false, Object.keys(analyticsSites).length, seo.sources?.analyticsConfigured || 0,
      seo.generatedAt, seo.upstream?.error),
    contract('ai-usage', true, live.length, new Set((aiUsage.by_site || []).map(r => r.site)).size,
      aiUsage.generated_at),
    contract('amazon-revenue', Boolean(revenue.has_data), 1, revenue.has_data ? 1 : 0, revenue.fetched_at, revenue.message),
    contract('revenue-attribution', Boolean(revenue.has_data && revenue.attribution_complete), revenue.attribution?.length || 0,
      (revenue.attribution || []).filter(r => r.site).length, revenue.fetched_at,
      revenue.has_data && !revenue.attribution_complete ? 'Some tracking IDs cannot be mapped uniquely to a site.' : null),
  ];
  for (const row of contracts) {
    row.age_ms = row.freshest_at ? Math.max(0, now - Date.parse(row.freshest_at)) : null;
    row.status = !row.ok ? 'red' : row.completeness < 1 ? 'yellow' : 'green';
  }
  return { generated_at: new Date().toISOString(), contracts, totals: {
    green: contracts.filter(r => r.status === 'green').length,
    yellow: contracts.filter(r => r.status === 'yellow').length,
    red: contracts.filter(r => r.status === 'red').length,
  }};
}

function contract(source, ok, expected, observed, freshest_at = null, error = null) {
  return { source, ok: Boolean(ok), expected, observed, completeness: expected ? observed / expected : (ok ? 1 : 0), freshest_at: freshest_at || null, error: error || null };
}
function newest(values) { return values.filter(Boolean).sort().at(-1) || null; }

module.exports = { assess };
