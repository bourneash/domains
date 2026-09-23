'use strict';

const registry = require('./fleetregistry');
const ANALYTICS_SOURCES = ['ga4', 'gsc'];

function analyticsSourceCoverage(expectedSites, analyticsSites) {
  const sourceCoverage = {};
  const sourceIssues = [];
  for (const source of ANALYTICS_SOURCES) {
    const details = expectedSites.map(site => {
      const health = analyticsSites[site]?.[source] || {};
      return {
        site,
        source,
        status: health.status || 'not_observed',
        error: health.error || null,
        last_fetch_at: health.last_fetch_at || null,
      };
    });
    const observed = details.filter(detail => detail.status === 'ok');
    const issues = details.filter(detail => detail.status !== 'ok');
    sourceCoverage[source] = {
      expected_sites: details.length,
      observed_sites: observed.length,
      missing_sites: issues.map(detail => detail.site),
      error_sites: issues
        .filter(detail => detail.status !== 'not_observed')
        .map(detail => detail.site),
      issues,
    };
    sourceIssues.push(...issues);
  }
  return { sourceCoverage, sourceIssues };
}

function assess({
  root,
  discoveredSites = [],
  analyticsHealth = {},
  seo = {},
  revenue = {},
  aiUsage = {},
}) {
  const reg = registry.read(root);
  const discovered = new Set(discoveredSites);
  const live = reg.sites.filter(
    s => s.lifecycle === 'live' && (!discovered.size || discovered.has(s.domain))
  );
  const expectedAnalytics = live
    .filter(s => s.capabilities.includes('analytics'))
    .map(s => s.domain);
  const analyticsSites = analyticsHealth.sites || {};
  const { sourceCoverage, sourceIssues } = analyticsSourceCoverage(
    expectedAnalytics,
    analyticsSites
  );
  const analyticsMissingDetails = site => {
    const row = analyticsSites[site] || {};
    return {
      site,
      configured: row.configured === true,
      ga4_status: row.ga4?.status || 'not_observed',
      gsc_status: row.gsc?.status || 'not_observed',
      ga4_last_fetch_at: row.ga4?.last_fetch_at || null,
      gsc_last_fetch_at: row.gsc?.last_fetch_at || null,
    };
  };
  const analyticsObserved = site => {
    const row = analyticsSites[site];
    return Boolean(row && (row.ga4?.status === 'ok' || row.gsc?.status === 'ok'));
  };
  const analyticsMissingSites = expectedAnalytics.filter(site => !analyticsObserved(site));
  const aggregateRevenue = (revenue.attribution || []).filter(
    row => row.attribution_scope === 'aggregate'
  );
  const unmappedRevenue = (revenue.attribution || []).filter(
    row => !row.site && row.attribution_scope !== 'aggregate'
  );
  const siteAttributionRows = (revenue.attribution || []).filter(
    row => row.attribution_scope !== 'aggregate'
  );
  const aggregateIncome = aggregateRevenue.reduce(
    (sum, row) => sum + (Number(row.commission_income) || 0),
    0
  );
  const attributionStatus =
    revenue.attribution_status ||
    (unmappedRevenue.length
      ? 'incomplete_unmapped'
      : aggregateIncome > 0
        ? 'partial_aggregate'
        : 'complete');
  const now = Date.now();
  const contracts = [
    contract('fleet-registry', reg.ok, reg.sites.length, reg.sites.length, null, reg.error),
    contract(
      'operational-checkouts',
      true,
      live.length,
      live.filter(s => discoveredSites.includes(s.domain)).length
    ),
    contract(
      'analytics',
      analyticsHealth.ok !== false,
      expectedAnalytics.length,
      expectedAnalytics.filter(analyticsObserved).length,
      newest(
        Object.values(analyticsSites).flatMap(s => [s.ga4?.last_fetch_at, s.gsc?.last_fetch_at])
      )
    ),
    contract(
      'seo-intelligence',
      seo.upstream?.ok !== false,
      Object.keys(analyticsSites).length,
      seo.sources?.analyticsConfigured || 0,
      seo.generatedAt,
      seo.upstream?.error
    ),
    contract(
      'ai-usage',
      true,
      live.length,
      new Set((aiUsage.by_site || []).map(r => r.site)).size,
      aiUsage.generated_at
    ),
    contract(
      'amazon-revenue',
      Boolean(revenue.has_data),
      1,
      revenue.has_data ? 1 : 0,
      revenue.fetched_at,
      revenue.message
    ),
    contract(
      'revenue-attribution',
      Boolean(
        revenue.has_data &&
        (revenue.site_level_attribution_complete ?? revenue.attribution_complete)
      ),
      siteAttributionRows.length,
      siteAttributionRows.filter(r => r.site).length,
      revenue.fetched_at,
      revenue.has_data && unmappedRevenue.length
        ? 'Some tracking IDs cannot be mapped uniquely to a site.'
        : aggregateRevenue.length
          ? 'Amazon supplied aggregate tracking rows; they are visible but cannot be assigned to a site.'
          : null
    ),
  ];
  for (const row of contracts) {
    row.age_ms = row.freshest_at ? Math.max(0, now - Date.parse(row.freshest_at)) : null;
    row.status = !row.ok ? 'red' : row.completeness < 1 ? 'yellow' : 'green';
  }
  const analyticsContract = contracts.find(row => row.source === 'analytics');
  if (analyticsContract && sourceIssues.length && analyticsContract.status === 'green') {
    analyticsContract.status = 'yellow';
    analyticsContract.notice =
      'At least one GA4 or GSC source is unavailable or returning an error.';
  }
  const attributionContract = contracts.find(row => row.source === 'revenue-attribution');
  if (attributionContract && aggregateRevenue.length && attributionContract.status === 'green') {
    attributionContract.status = 'yellow';
    attributionContract.notice =
      'Amazon supplied aggregate earnings that are visible but cannot be assigned to a site.';
  }
  return {
    generated_at: new Date().toISOString(),
    contracts,
    coverage: {
      analytics: {
        expected_sites: expectedAnalytics.length,
        observed_sites: expectedAnalytics.length - analyticsMissingSites.length,
        missing_sites: analyticsMissingSites,
        missing_details: analyticsMissingSites.map(analyticsMissingDetails),
        source_coverage: sourceCoverage,
        source_issues: sourceIssues,
        next_action: analyticsMissingSites.length
          ? 'Provision or verify GA4/GSC access for the listed sites; missing telemetry is unavailable, not zero.'
          : sourceIssues.length
            ? 'Repair the listed GA4/GSC source permissions or collector errors; do not treat the failing source as zero.'
            : null,
      },
      revenue_attribution: {
        status: attributionStatus,
        tracking_rows: (revenue.attribution || []).length,
        mapped_rows: (revenue.attribution || []).filter(row => row.site).length,
        unmapped_rows: unmappedRevenue.length,
        unmapped_tracking_ids: unmappedRevenue.map(row => row.tracking_id).filter(Boolean),
        aggregate_rows: aggregateRevenue.length,
        aggregate_tracking_ids: aggregateRevenue.map(row => row.tracking_id).filter(Boolean),
        aggregate_unattributed_income: aggregateRevenue.reduce(
          (sum, row) => sum + (Number(row.commission_income) || 0),
          0
        ),
        next_action: unmappedRevenue.length
          ? 'Map each unmatched affiliate tracking ID to one managed site before assigning revenue or ROI.'
          : aggregateRevenue.length
            ? 'Keep aggregate provider rows visible; require every new site link to use its registered tracking ID.'
            : null,
      },
    },
    next_actions: [
      ...(analyticsMissingSites.length ? ['close analytics coverage gaps'] : []),
      ...(sourceIssues.length ? ['repair analytics source permissions or collector errors'] : []),
      ...(unmappedRevenue.length ? ['resolve affiliate tracking-ID attribution'] : []),
    ],
    totals: {
      green: contracts.filter(r => r.status === 'green').length,
      yellow: contracts.filter(r => r.status === 'yellow').length,
      red: contracts.filter(r => r.status === 'red').length,
    },
  };
}

function contract(source, ok, expected, observed, freshest_at = null, error = null) {
  return {
    source,
    ok: Boolean(ok),
    expected,
    observed,
    completeness: expected ? observed / expected : ok ? 1 : 0,
    freshest_at: freshest_at || null,
    error: error || null,
  };
}
function newest(values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

module.exports = { assess };
