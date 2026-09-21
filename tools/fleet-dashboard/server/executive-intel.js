'use strict';

// Read-only, bounded intelligence contract for the executive roles. Keep this
// adapter separate from the dashboard UI so the CEO, CTO, and CRO consume the
// same normalized evidence that Fleet Manager displays.

const analytics = require('./analytics');
const aiusage = require('./aiusage');
const datahub = require('./datahub');
const deployhealth = require('./deployhealth');
const errorscan = require('./errorscan');
const fleetdoctor = require('./fleetdoctor');
const fleetregistry = require('./fleetregistry');
const gatushealth = require('./gatushealth');
const priorities = require('./priorities');
const revenue = require('./revenue');
const seoIntelligence = require('./seointelligence');
const social = require('./social');

const EXCLUDED_SITES = new Set(['3boobs.com']);

const TOOL_CATALOG = [
  { key: 'registry', purpose: 'portfolio scope, lifecycle, capabilities, and site ownership' },
  { key: 'analytics', purpose: 'GA4/GSC health, traffic, conversions, and search performance' },
  {
    key: 'seo_intelligence',
    purpose: 'evidence-backed SEO, crawlability, web-vitals, and link opportunities',
  },
  { key: 'revenue', purpose: 'Amazon earnings and site-level attribution where available' },
  { key: 'ai_usage', purpose: 'AI spend, usage, and cost by site or role' },
  {
    key: 'social',
    purpose: 'account coverage, platform status, and social work requiring attention',
  },
  { key: 'datahub', purpose: 'feed/source health, pulls, and available datasets' },
  {
    key: 'priorities',
    purpose: 'cross-source ranked opportunities, health gaps, and site scorecards',
  },
  {
    key: 'operations',
    purpose: 'deployment health, uptime, fleet doctor findings, and error rollups',
  },
];

function isExcluded(value) {
  return typeof value === 'string' && EXCLUDED_SITES.has(value.toLowerCase());
}

// Prevent excluded-site data from reaching prompts even when a source has a
// broader registry than the executive scope.
function removeExcluded(value) {
  if (Array.isArray(value)) {
    return value.map(removeExcluded).filter(item => item !== null);
  }
  if (!value || typeof value !== 'object') return isExcluded(value) ? null : value;
  if (isExcluded(value.site) || isExcluded(value.domain)) return null;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (isExcluded(key)) continue;
    const next = removeExcluded(item);
    if (next !== null) out[key] = next;
  }
  return out;
}

function source(name, result, { observedAt = null, error = null } = {}) {
  const value = removeExcluded(result);
  const inferredError =
    error || (value && value.ok === false ? value.error || 'source reported failure' : null);
  return {
    source: name,
    ok: !inferredError,
    observed_at: observedAt || value?.generated_at || value?.generatedAt || null,
    error: inferredError,
    data: value,
  };
}

async function settle(name, work) {
  try {
    return source(name, await work());
  } catch (error) {
    return source(name, null, { error: error.message || String(error) });
  }
}

function compactDataHubSources(value) {
  if (!value || typeof value !== 'object') return value;
  const rows = Array.isArray(value.sources) ? value.sources : [];
  return {
    ...value,
    sources: rows.map(row => ({
      id: row.id,
      type: row.type,
      enabled: row.enabled,
      status: row.status,
      last_pull_at: row.last_pull_at || row.lastPullAt || null,
      error: row.error || null,
    })),
  };
}

function diagnostics(result, extra = {}) {
  const data = result?.data;
  return {
    source: result?.source,
    ok: result?.ok !== false,
    observed_at: result?.observed_at || null,
    error: result?.error || null,
    ...extra,
    ...(data && typeof data === 'object'
      ? {
          generated_at: data.generated_at || data.generatedAt || null,
        }
      : {}),
  };
}

function compactAnalytics(data) {
  const sites = {};
  for (const [site, row] of Object.entries(data?.sites || {})) {
    sites[site] = {
      configured: row?.configured !== false,
      ga4: row?.ga4
        ? { status: row.ga4.status || null, last_fetch_at: row.ga4.last_fetch_at || null }
        : null,
      gsc: row?.gsc
        ? { status: row.gsc.status || null, last_fetch_at: row.gsc.last_fetch_at || null }
        : null,
    };
  }
  return { ok: data?.ok !== false, configured_sites: Object.keys(sites).length, sites };
}

function compactSeo(data) {
  const sites = (data?.sites || []).map(row => ({
    site: row.site,
    actions: row.actions,
    high: row.high,
    medium: row.medium,
    impressions: row.impressions,
    clicks: row.clicks,
    sessions: row.sessions,
    conversions: row.conversions,
    pages: row.pages,
  }));
  const actions = (data?.actions || []).slice(0, 40).map(action => ({
    key: action.key,
    site: action.site,
    type: action.type,
    title: action.title,
    evidence: action.evidence,
    priority: action.priority,
    rankScore: action.rankScore,
    valueScore: action.valueScore,
    filed: action.filed,
  }));
  return {
    generated_at: data?.generatedAt || null,
    upstream: data?.upstream || null,
    sources: data?.sources || null,
    totals: {
      sites: sites.length,
      actions: sites.reduce((n, row) => n + (Number(row.actions) || 0), 0),
      high: sites.reduce((n, row) => n + (Number(row.high) || 0), 0),
      medium: sites.reduce((n, row) => n + (Number(row.medium) || 0), 0),
      impressions: sites.reduce((n, row) => n + (Number(row.impressions) || 0), 0),
      clicks: sites.reduce((n, row) => n + (Number(row.clicks) || 0), 0),
      sessions: sites.reduce((n, row) => n + (Number(row.sessions) || 0), 0),
      conversions: sites.reduce((n, row) => n + (Number(row.conversions) || 0), 0),
      pagesMeasured: sites.reduce((n, row) => n + (Number(row.pages) || 0), 0),
    },
    sites,
    actions,
  };
}

function compactUsage(data, managedSites) {
  const allowed = new Set([...managedSites, '_fleet']);
  const rows = (data?.by_site || []).filter(row => allowed.has(row.site));
  const numeric = key => rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
  const scopeSummary = {
    calls: numeric('calls'),
    errors: numeric('errors'),
    transient_errors: numeric('transient_errors'),
    input_tokens: numeric('input_tokens'),
    output_tokens: numeric('output_tokens'),
    cache_creation_input_tokens: numeric('cache_creation_input_tokens'),
    cache_read_input_tokens: numeric('cache_read_input_tokens'),
    total_cost_usd: numeric('total_cost_usd'),
    sites_total: rows.filter(row => row.site !== '_fleet').length,
    sites_instrumented: rows.filter(row => row.site !== '_fleet' && Number(row.calls) > 0).length,
    excluded_from_scope: '3boobs.com',
  };
  return {
    generated_at: data?.generated_at || null,
    window: data?.window || null,
    summary: scopeSummary,
    error: data?.error || null,
    by_site: rows.slice(0, 60).map(row => ({
      site: row.site,
      total_cost_usd: row.total_cost_usd,
      total_tokens: row.total_tokens,
      runs: row.runs,
      calls: row.calls,
    })),
  };
}

function compactPriorities(data) {
  return {
    generated_at: data?.generated_at || null,
    value_basis: data?.value_basis || null,
    notice: data?.notice || null,
    coverage: data?.coverage || null,
    totals: data?.totals || null,
    scorecards: (data?.scorecards || []).slice(0, 25).map(row => ({
      site: row.site,
      lifecycle: row.lifecycle,
      allocation: row.allocation,
      opportunity_score: row.opportunity_score,
      sessions: row.sessions,
      conversions: row.conversions,
      ai_cost_usd: row.ai_cost_usd,
      revenue_usd: row.revenue_usd,
      margin_usd: row.margin_usd,
    })),
    items: (data?.items || []).slice(0, 20).map(item => ({
      id: item.id,
      kind: item.kind,
      site: item.site,
      title: item.title,
      evidence: item.evidence,
      score: item.score,
      state: item.state,
      source: item.source,
    })),
  };
}

function compactOperations(value) {
  const deploy = value?.deploy_health || {};
  const uptime = value?.uptime || {};
  const doctor = value?.fleet_doctor || {};
  const errors = value?.errors || {};
  return {
    deploy_health: {
      last_sweep: deploy.lastSweep || null,
      site_count: Object.keys(deploy.sites || {}).length,
      failed: Object.values(deploy.sites || {})
        .filter(row => row && row.live === false)
        .slice(0, 40),
    },
    uptime: {
      last_sweep: uptime.lastSweep || null,
      site_count: Object.keys(uptime.sites || {}).length,
      groups: (uptime.order || []).slice(0, 40).map(group => ({
        group,
        ...(uptime.sites[group] || {}),
        checks: (uptime.sites[group]?.checks || []).slice(0, 10),
      })),
    },
    fleet_doctor: {
      ok: doctor.ok,
      error: doctor.error || null,
      last_run: doctor.last_run || null,
      age_ms: doctor.age_ms || null,
      totals: doctor.totals || {},
      failing_sites: (doctor.sites || []).filter(row => row && row.ok === false).slice(0, 40),
    },
    errors: {
      generated_at: errors.generated_at || errors.generatedAt || null,
      totals: errors.totals || errors.summary || null,
      top: Array.isArray(errors.errors)
        ? errors.errors.slice(0, 40)
        : Array.isArray(errors)
          ? errors.slice(0, 40)
          : [],
    },
  };
}

async function collect({ root, sites = [] } = {}) {
  const managedSites = sites.filter(site => !EXCLUDED_SITES.has(site));
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  const registry = fleetregistry.read(root);
  const analyticsResult = await settle('analytics', () => analytics.health());
  const seoResult = await settle('seo_intelligence', () => seoIntelligence.buildSnapshot({ root }));
  const revenueResult = source('revenue', revenue.amazonSummary(root));
  const aiResult = await settle('ai_usage', () => aiusage.fleet(root, { from, to }));
  const socialResult = source('social', social.summary(managedSites));
  const dataHubResults = await Promise.all([
    settle('datahub_health', () => datahub.health()),
    settle('datahub_sources', () => datahub.sources()),
    settle('datahub_datasets', () => datahub.datasets()),
  ]);

  const analyticsData = analyticsResult.data || {};
  const seoData = seoResult.data || {};
  const revenueData = revenueResult.data || {};
  const aiData = aiResult.data || {};
  const safeAnalyticsData = removeExcluded(analyticsData);
  const safeSeoData = removeExcluded(seoData);
  const safeRevenueData = removeExcluded(revenueData);
  const safeAiData = removeExcluded(aiData);
  const priorityData = removeExcluded(
    priorities.build({
      root,
      discoveredSites: managedSites,
      seo: seoData,
      revenue: revenueData,
      analyticsHealth: analyticsData,
      aiUsage: aiData,
    })
  );

  return {
    generated_at: new Date().toISOString(),
    scope: { managed_sites: managedSites, excluded_sites: [...EXCLUDED_SITES] },
    tool_catalog: TOOL_CATALOG,
    sources: {
      registry: diagnostics(source('registry', registry), { site_count: registry.sites.length }),
      analytics: diagnostics(analyticsResult, {
        configured_sites: Object.keys(analyticsData.sites || {}).length,
      }),
      seo_intelligence: diagnostics(seoResult, { action_count: (seoData.actions || []).length }),
      revenue: diagnostics(revenueResult, {
        has_data: Boolean(revenueData.has_data),
        connected: Boolean(revenueData.connected),
      }),
      ai_usage: diagnostics(aiResult, { site_count: (aiData.by_site || []).length }),
      social: diagnostics(socialResult, { account_count: socialResult.data?.accounts || null }),
      datahub_health: diagnostics(dataHubResults[0]),
      datahub_sources: diagnostics(dataHubResults[1], {
        source_count: (dataHubResults[1].data?.sources || []).length,
      }),
      datahub_datasets: diagnostics(dataHubResults[2], {
        dataset_count: (dataHubResults[2].data?.datasets || []).length,
      }),
    },
    // These are the compact, decision-useful views. Raw source payloads remain
    // available under sources for audit/debugging without making the prompt huge.
    decision_support: {
      registry: {
        ok: registry.ok,
        site_count: registry.sites.length,
        lifecycle: registry.sites.reduce((out, row) => {
          out[row.lifecycle] = (out[row.lifecycle] || 0) + 1;
          return out;
        }, {}),
        capabilities: registry.sites.reduce((out, row) => {
          for (const cap of row.capabilities) out[cap] = (out[cap] || 0) + 1;
          return out;
        }, {}),
      },
      analytics: compactAnalytics(safeAnalyticsData),
      seo: compactSeo(safeSeoData),
      revenue: safeRevenueData,
      ai_usage: compactUsage({ ...safeAiData, window: { from, to } }, managedSites),
      social: socialResult.data,
      priorities: compactPriorities(priorityData),
      operations: compactOperations(
        removeExcluded({
          deploy_health: deployhealth.all(),
          uptime: gatushealth.all(),
          fleet_doctor: fleetdoctor.all(),
          errors: errorscan.rollup(),
        })
      ),
    },
  };
}

module.exports = { EXCLUDED_SITES, TOOL_CATALOG, removeExcluded, source, collect };
