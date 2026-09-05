'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const API = process.env.DATAHUB_API || 'http://host.docker.internal:4760';
const CACHE_MS = 5 * 60 * 1000;
let cache = null;

async function getJson(pathname, fetchImpl = fetch, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${API}${pathname}`, { signal: ctrl.signal });
    if (!response.ok) throw new Error(`data-hub ${pathname} -> HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function readReport(root, relative) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
  } catch {
    return null;
  }
}

function aggregateQueries(records) {
  const byQuery = new Map();
  for (const row of records || []) {
    const query = String(row.dim_key || '').trim();
    if (!query) continue;
    const impressions = Number(row.impressions) || 0;
    const current = byQuery.get(query) || { query, clicks: 0, impressions: 0, positionWeight: 0 };
    current.clicks += Number(row.clicks) || 0;
    current.impressions += impressions;
    current.positionWeight += (Number(row.position) || 0) * impressions;
    byQuery.set(query, current);
  }
  return [...byQuery.values()].map(row => ({
    query: row.query,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.impressions ? row.clicks / row.impressions : 0,
    position: row.impressions ? row.positionWeight / row.impressions : null,
  }));
}

function splitWeeks(records) {
  const rows = [...(records || [])].sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-14);
  return { previous: rows.slice(0, Math.max(0, rows.length - 7)), current: rows.slice(-7) };
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

function priorityForScore(score) {
  return score >= 75 ? 'high' : score >= 48 ? 'medium' : 'low';
}

function queryActions(site, records) {
  const actions = [];
  for (const row of aggregateQueries(records)) {
    if (row.impressions < 20 || row.position == null) continue;
    const pos = Math.round(row.position * 10) / 10;
    const ctrPct = Math.round(row.ctr * 1000) / 10;
    if (pos >= 5 && pos <= 20) {
      const score = Math.min(100, Math.round(28 + Math.log10(row.impressions + 1) * 16 + (20 - pos) * 1.8));
      actions.push({
        id: `${site}:striking:${row.query}`,
        site,
        type: 'striking-distance',
        priority: priorityForScore(score),
        score,
        title: `Move “${row.query}” onto page one`,
        evidence: `${row.impressions.toLocaleString()} impressions, ${row.clicks.toLocaleString()} clicks, position ${pos}, ${ctrPct}% CTR`,
        recommendation: 'Identify the ranking page, strengthen its intent match and internal links, then monitor the query for 28 days.',
        metric: { label: 'impressions', value: row.impressions },
      });
      continue;
    }
    const expectedCtr = pos <= 3 ? 0.03 : pos <= 5 ? 0.02 : pos <= 10 ? 0.01 : 0;
    if (pos <= 10 && row.impressions >= 50 && row.ctr < expectedCtr) {
      const score = Math.min(100, Math.round(35 + Math.log10(row.impressions + 1) * 15 + (expectedCtr - row.ctr) * 600));
      actions.push({
        id: `${site}:ctr:${row.query}`,
        site,
        type: 'low-ctr',
        priority: priorityForScore(score),
        score,
        title: `Improve the snippet for “${row.query}”`,
        evidence: `${row.impressions.toLocaleString()} impressions at position ${pos}, but only ${ctrPct}% CTR`,
        recommendation: 'Review the ranking page title and description against the live search intent; make the benefit more specific without changing the URL.',
        metric: { label: 'impressions', value: row.impressions },
      });
    }
  }
  return actions;
}

function trendActions(site, records) {
  const { previous, current } = splitWeeks(records);
  if (previous.length < 5 || current.length < 5) return [];
  const previousClicks = sum(previous, 'clicks');
  const currentClicks = sum(current, 'clicks');
  if (previousClicks < 10 || currentClicks >= previousClicks * 0.8) return [];
  const decline = Math.round((1 - currentClicks / previousClicks) * 100);
  const score = Math.min(100, 58 + Math.round(decline / 2));
  return [{
    id: `${site}:decline:clicks`,
    site,
    type: 'traffic-decline',
    priority: priorityForScore(score),
    score,
    title: `Investigate a ${decline}% weekly search-click decline`,
    evidence: `${previousClicks.toLocaleString()} clicks in the prior seven days versus ${currentClicks.toLocaleString()} now`,
    recommendation: 'Compare losing queries and pages, then check recent deploys, indexing, content changes, and SERP displacement before editing.',
    metric: { label: 'clicks lost', value: previousClicks - currentClicks },
  }];
}

function webVitalsActions(report) {
  const actions = [];
  for (const row of report?.sites || []) {
    if (row.error || !(row.budget_breaches || []).length) continue;
    const m = row.metrics || {};
    const severe = Number(m.performance) < 0.75 || Number(m.lcp_ms) > 4000 || Number(m.cls) > 0.2;
    const score = severe ? 82 : Math.min(74, 48 + row.budget_breaches.length * 8);
    const evidence = [];
    if (row.budget_breaches.includes('performance')) evidence.push(`performance ${Math.round((m.performance || 0) * 100)}`);
    if (row.budget_breaches.includes('lcp_ms')) evidence.push(`LCP ${Math.round(m.lcp_ms)}ms`);
    if (row.budget_breaches.includes('cls')) evidence.push(`CLS ${Number(m.cls).toFixed(3)}`);
    if (row.budget_breaches.includes('tbt_ms')) evidence.push(`TBT ${Math.round(m.tbt_ms)}ms`);
    actions.push({
      id: `${row.site}:web-vitals`, site: row.site, type: 'web-vitals',
      priority: priorityForScore(score), score,
      title: `Fix ${row.budget_breaches.join(', ').toUpperCase()} performance budgets`,
      evidence: `${evidence.join(' · ')} (${report.form_factor || 'unknown'} lab run)`,
      recommendation: 'Profile the slowest template and fix the shared rendering, image, font, or script bottleneck; verify against the pinned fleet baseline.',
      metric: { label: 'budget breaches', value: row.budget_breaches.length },
    });
  }
  return actions;
}

function linkActions(report) {
  const actions = [];
  for (const row of report?.sites || []) {
    if (row.error) {
      actions.push({
        id: `${row.site}:crawl-error`, site: row.site, type: 'crawlability', priority: 'high', score: 86,
        title: 'Restore the sitemap crawl path', evidence: row.error,
        recommendation: 'Publish a valid sitemap containing canonical, indexable URLs and reference it from robots.txt, then rerun link-rot.',
        metric: { label: 'pages scanned', value: row.pages_scanned || 0 },
      });
      continue;
    }
    const findings = row.findings || [];
    const broken = findings.filter(f => ['broken', 'unreachable', 'page-unreachable'].includes(f.kind || f.type));
    const chains = findings.filter(f => (f.kind || f.type) === 'redirect-chain');
    if (!broken.length && !chains.length) continue;
    const score = Math.min(100, 55 + broken.length * 8 + chains.length * 3);
    actions.push({
      id: `${row.site}:link-health`, site: row.site, type: 'broken-links', priority: priorityForScore(score), score,
      title: `Repair ${broken.length} broken and ${chains.length} redirected links`,
      evidence: `${row.pages_scanned || 0} pages and ${row.links_checked || 0} distinct links checked`,
      recommendation: 'Update internal links to the final live URL; remove dead destinations and rerun the fleet link sweep.',
      metric: { label: 'findings', value: broken.length + chains.length },
    });
  }
  return actions;
}

function buildSiteRows(siteNames, queryData, actions) {
  const bySite = new Map(siteNames.map(site => [site, { site, actions: 0, high: 0, medium: 0, impressions: 0, clicks: 0, queries: 0 }]));
  for (const [site, records] of Object.entries(queryData)) {
    const row = bySite.get(site) || { site, actions: 0, high: 0, medium: 0, impressions: 0, clicks: 0, queries: 0 };
    const queries = aggregateQueries(records);
    row.queries = queries.length;
    row.impressions = queries.reduce((n, q) => n + q.impressions, 0);
    row.clicks = queries.reduce((n, q) => n + q.clicks, 0);
    bySite.set(site, row);
  }
  for (const action of actions) {
    const row = bySite.get(action.site) || { site: action.site, actions: 0, high: 0, medium: 0, impressions: 0, clicks: 0, queries: 0 };
    row.actions += 1;
    if (action.priority === 'high') row.high += 1;
    if (action.priority === 'medium') row.medium += 1;
    bySite.set(action.site, row);
  }
  return [...bySite.values()].sort((a, b) => b.high - a.high || b.actions - a.actions || b.impressions - a.impressions || a.site.localeCompare(b.site));
}

function actionKey(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 20);
}

function filedActionKeys(root, siteNames) {
  const keys = new Set();
  const pattern = /seo-intelligence-key:\s*([a-f0-9]{20})/g;
  for (const site of siteNames) {
    for (const column of ['backlog', 'in-progress', 'done', 'hold']) {
      const dir = path.join(root, 'sites', site, 'ops', 'tasks', column);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.md')) continue;
        let text = '';
        try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
        for (const match of text.matchAll(pattern)) keys.add(match[1]);
      }
    }
  }
  return keys;
}

async function buildSnapshot({ root, fetchImpl = fetch, days = 90, now = new Date(), force = false } = {}) {
  if (!force && cache && cache.root === root && cache.days === days && Date.now() - cache.at < CACHE_MS) return cache.value;
  const webVitals = readReport(root, 'tools/web-vitals/reports/latest.json');
  const linkRot = readReport(root, 'tools/link-rot/reports/latest.json');
  let health = { sites: {} };
  let upstreamError = null;
  try {
    health = await getJson('/metrics/health', fetchImpl);
  } catch (error) {
    upstreamError = String(error.message || error);
  }
  const siteNames = Object.keys(health.sites || {}).sort();
  const since = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  const queryData = {};
  const siteData = {};
  await Promise.all(siteNames.map(async site => {
    try {
      const [queries, totals] = await Promise.all([
        getJson(`/metrics/gsc?site=${encodeURIComponent(site)}&grain=query&since=${since}&limit=5000`, fetchImpl),
        getJson(`/metrics/gsc?site=${encodeURIComponent(site)}&grain=site&since=${new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10)}&limit=20`, fetchImpl),
      ]);
      queryData[site] = queries.records || [];
      siteData[site] = totals.records || [];
    } catch (error) {
      queryData[site] = [];
      siteData[site] = [];
      upstreamError ||= String(error.message || error);
    }
  }));

  const rankedActions = [
    ...Object.entries(queryData).flatMap(([site, rows]) => queryActions(site, rows)),
    ...Object.entries(siteData).flatMap(([site, rows]) => trendActions(site, rows)),
    ...webVitalsActions(webVitals),
    ...linkActions(linkRot),
  ].sort((a, b) => b.score - a.score || b.metric.value - a.metric.value || a.site.localeCompare(b.site)).slice(0, 200);
  const allSites = [...new Set([
    ...siteNames,
    ...(webVitals?.sites || []).map(s => s.site),
    ...(linkRot?.sites || []).map(s => s.site),
  ])].filter(Boolean).sort();
  const filed = filedActionKeys(root, allSites);
  const actions = rankedActions.map(action => {
    const key = actionKey(action.id);
    return { ...action, key, filed: filed.has(key) };
  });
  const types = {};
  for (const action of actions) types[action.type] = (types[action.type] || 0) + 1;
  const siteRows = buildSiteRows(allSites, queryData, actions);
  const value = {
    generatedAt: now.toISOString(),
    windowDays: days,
    upstream: { ok: !upstreamError, error: upstreamError },
    sources: {
      analyticsConfigured: siteNames.length,
      gscReady: Object.values(health.sites || {}).filter(s => (s.gsc?.status || '').startsWith('ok')).length,
      ga4Ready: Object.values(health.sites || {}).filter(s => (s.ga4?.status || '').startsWith('ok')).length,
      webVitalsSites: webVitals?.sites?.length || 0,
      webVitalsAt: webVitals?.at || null,
      linkRotSites: linkRot?.sites?.length || 0,
      linkRotAt: linkRot?.at || null,
    },
    totals: {
      sites: allSites.length,
      actions: actions.length,
      high: actions.filter(a => a.priority === 'high').length,
      medium: actions.filter(a => a.priority === 'medium').length,
      impressions: siteRows.reduce((n, s) => n + s.impressions, 0),
      clicks: siteRows.reduce((n, s) => n + s.clicks, 0),
    },
    types,
    sites: siteRows,
    actions,
  };
  cache = { root, days, at: Date.now(), value };
  return value;
}

function clearCache() { cache = null; }

module.exports = {
  API, aggregateQueries, splitWeeks, queryActions, trendActions, webVitalsActions,
  linkActions, buildSiteRows, actionKey, filedActionKeys, buildSnapshot, clearCache,
};
