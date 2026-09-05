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

function normalizePage(site, value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '(not set)') return null;
  try {
    const parsed = new URL(raw, `https://${site}`);
    let pathname = parsed.pathname.replace(/\/{2,}/g, '/');
    if (pathname.length > 1) pathname = pathname.replace(/\/$/, '');
    return pathname || '/';
  } catch {
    return null;
  }
}

function aggregatePages(site, records, source) {
  const pages = new Map();
  for (const row of records || []) {
    const page = normalizePage(site, row.dim_key);
    if (!page) continue;
    const current = pages.get(page) || {
      page, clicks: 0, impressions: 0, positionWeight: 0,
      sessions: 0, views: 0, engagedSessions: 0, conversions: 0,
    };
    if (source === 'gsc') {
      const impressions = Number(row.impressions) || 0;
      current.clicks += Number(row.clicks) || 0;
      current.impressions += impressions;
      current.positionWeight += (Number(row.position) || 0) * impressions;
    } else {
      current.sessions += Number(row.sessions) || 0;
      current.views += Number(row.views) || 0;
      current.engagedSessions += Number(row.engaged_sessions) || 0;
      current.conversions += Number(row.conversions) || 0;
    }
    pages.set(page, current);
  }
  return [...pages.values()].map(row => ({
    ...row,
    ctr: row.impressions ? row.clicks / row.impressions : 0,
    position: row.impressions ? row.positionWeight / row.impressions : null,
    engagementRate: row.sessions ? row.engagedSessions / row.sessions : null,
  }));
}

function pageValueScore(row) {
  return Math.min(100, Math.round(
    Math.min(55, (Number(row.conversions) || 0) * 11) +
    Math.min(30, Math.log10((Number(row.sessions) || 0) + 1) * 14) +
    Math.min(15, Math.log10((Number(row.impressions) || 0) + 1) * 5)
  ));
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

function pageActions(site, gscRecords, ga4Records) {
  const search = new Map(aggregatePages(site, gscRecords, 'gsc').map(row => [row.page, row]));
  const analytics = new Map(aggregatePages(site, ga4Records, 'ga4').map(row => [row.page, row]));
  const actions = [];
  for (const row of search.values()) {
    if (row.impressions < 50 || row.position == null || row.position < 4 || row.position > 20) continue;
    const ga4 = analytics.get(row.page) || {};
    const pos = Math.round(row.position * 10) / 10;
    const valueScore = pageValueScore({
      impressions: row.impressions,
      sessions: ga4.sessions,
      conversions: ga4.conversions,
    });
    const base = Math.round(30 + Math.log10(row.impressions + 1) * 14 + (20 - pos) * 1.5);
    const score = Math.min(100, base + Math.round(valueScore * 0.2));
    actions.push({
      id: `${site}:page-opportunity:${row.page}`, site, type: 'page-opportunity',
      priority: priorityForScore(score), score, valueScore,
      title: `Grow organic reach for ${row.page}`,
      evidence: `${row.impressions.toLocaleString()} impressions at position ${pos} · ${row.clicks.toLocaleString()} clicks · ${(ga4.sessions || 0).toLocaleString()} sessions · ${(ga4.conversions || 0).toLocaleString()} conversions`,
      recommendation: 'Strengthen this page around the search demand it already earns, improve its internal-link support, and preserve any converting intent.',
      metric: { label: 'page impressions', value: row.impressions },
      page: row.page,
    });
  }
  for (const row of analytics.values()) {
    if (row.sessions < 50 || row.conversions > 0 || row.engagementRate == null || row.engagementRate >= 0.35) continue;
    const valueScore = pageValueScore(row);
    const score = Math.min(100, Math.round(45 + Math.log10(row.sessions + 1) * 12 + (0.35 - row.engagementRate) * 45));
    actions.push({
      id: `${site}:engagement-risk:${row.page}`, site, type: 'engagement-risk',
      priority: priorityForScore(score), score, valueScore,
      title: `Improve weak engagement on ${row.page}`,
      evidence: `${row.sessions.toLocaleString()} sessions · ${Math.round(row.engagementRate * 100)}% engaged · 0 conversions · ${row.views.toLocaleString()} views`,
      recommendation: 'Check intent alignment, first-screen clarity, navigation paths, and conversion placement before sending more traffic to this page.',
      metric: { label: 'sessions at risk', value: row.sessions },
      page: row.page,
    });
  }
  return actions;
}

function pageDecayActions(site, ga4Records, now = new Date()) {
  const currentSince = new Date(now.getTime() - 28 * 86400000).toISOString().slice(0, 10);
  const previousSince = new Date(now.getTime() - 56 * 86400000).toISOString().slice(0, 10);
  const byPage = new Map();
  for (const row of ga4Records || []) {
    const page = normalizePage(site, row.dim_key);
    if (!page || String(row.date) < previousSince) continue;
    const bucket = String(row.date) >= currentSince ? 'current' : 'previous';
    const value = byPage.get(page) || { page, current: 0, previous: 0, currentDays: new Set(), previousDays: new Set(), conversions: 0 };
    value[bucket] += Number(row.sessions) || 0;
    value[`${bucket}Days`].add(String(row.date));
    if (bucket === 'previous') value.conversions += Number(row.conversions) || 0;
    byPage.set(page, value);
  }
  const actions = [];
  for (const row of byPage.values()) {
    if (row.currentDays.size < 7 || row.previousDays.size < 7 || row.previous < 30 || row.current >= row.previous * 0.7) continue;
    const decline = Math.round((1 - row.current / row.previous) * 100);
    const valueScore = pageValueScore({ sessions: row.previous, conversions: row.conversions });
    const score = Math.min(100, 58 + Math.round(decline / 2) + Math.round(valueScore * 0.15));
    actions.push({
      id: `${site}:content-decay:${row.page}`, site, type: 'content-decay',
      priority: priorityForScore(score), score, valueScore,
      title: `Recover declining traffic to ${row.page}`,
      evidence: `${row.previous.toLocaleString()} sessions in the prior 28 days versus ${row.current.toLocaleString()} now · down ${decline}%`,
      recommendation: 'Determine whether rankings, demand, freshness, or a site change caused the loss; refresh only after isolating the cause.',
      metric: { label: 'sessions lost', value: row.previous - row.current },
      page: row.page,
    });
  }
  return actions;
}

function actionPlan(action) {
  const plans = {
    'page-opportunity': ['Inspect the page’s leading queries and competing results.', 'Improve intent coverage and add relevant internal links.', 'Recheck impressions, position, clicks, and conversions after 28 days.'],
    'content-decay': ['Compare losing dates, queries, and deploy history.', 'Separate demand loss from ranking, indexing, and content causes.', 'Apply the smallest corrective change and verify against the baseline.'],
    'engagement-risk': ['Review source intent and the first screen on mobile.', 'Clarify the next useful action and remove interaction friction.', 'Measure engagement and conversions after a full traffic cycle.'],
    'striking-distance': ['Identify the ranking page and competing result format.', 'Close the intent gap and strengthen contextual internal links.', 'Track the query for 28 days without changing its URL.'],
    'low-ctr': ['Compare the current snippet with neighboring results.', 'Rewrite title and description around a specific benefit.', 'Monitor CTR while holding the URL and page intent stable.'],
    'traffic-decline': ['Segment losses by query and landing page.', 'Check indexing, deploys, SERP changes, and seasonality.', 'File targeted fixes only for the confirmed cause.'],
    'web-vitals': ['Profile the slowest shared template on mobile.', 'Fix the dominant image, font, script, or rendering bottleneck.', 'Rerun the pinned fleet measurement and compare each breached metric.'],
    'broken-links': ['Export each failing source and destination pair.', 'Replace internal links with the final canonical destination.', 'Rerun link-rot and confirm zero remaining failures.'],
    crawlability: ['Restore a valid sitemap of canonical indexable URLs.', 'Reference it from robots.txt and verify successful retrieval.', 'Rerun the crawl and confirm discovered page coverage.'],
  };
  return plans[action.type] || [action.recommendation, 'Verify the result against the recorded baseline.'];
}

async function mapLimit(values, limit, iteratee) {
  const queue = [...values];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await iteratee(queue.shift());
  });
  await Promise.all(workers);
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

function buildSiteRows(siteNames, queryData, actions, gscPageData = {}, ga4PageData = {}) {
  const blank = site => ({ site, actions: 0, high: 0, medium: 0, impressions: 0, clicks: 0, queries: 0, pages: 0, sessions: 0, conversions: 0 });
  const bySite = new Map(siteNames.map(site => [site, blank(site)]));
  for (const [site, records] of Object.entries(queryData)) {
    const row = bySite.get(site) || blank(site);
    const queries = aggregateQueries(records);
    row.queries = queries.length;
    row.impressions = queries.reduce((n, q) => n + q.impressions, 0);
    row.clicks = queries.reduce((n, q) => n + q.clicks, 0);
    bySite.set(site, row);
  }
  for (const site of siteNames) {
    const row = bySite.get(site) || blank(site);
    const gscPages = aggregatePages(site, gscPageData[site], 'gsc');
    const ga4Pages = aggregatePages(site, ga4PageData[site], 'ga4');
    row.pages = new Set([...gscPages.map(page => page.page), ...ga4Pages.map(page => page.page)]).size;
    row.sessions = ga4Pages.reduce((n, page) => n + page.sessions, 0);
    row.conversions = ga4Pages.reduce((n, page) => n + page.conversions, 0);
    bySite.set(site, row);
  }
  for (const action of actions) {
    const row = bySite.get(action.site) || blank(action.site);
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
  const pageSince = new Date(now.getTime() - 56 * 86400000).toISOString().slice(0, 10);
  const queryData = {};
  const siteData = {};
  const gscPageData = {};
  const ga4PageData = {};
  // Data Hub records every pull in the same SQLite database it reads. Keep the
  // portfolio fan-out serial so those tiny audit writes cannot contend with
  // each other and turn otherwise healthy sources into transient HTTP 500s.
  await mapLimit(siteNames, 1, async site => {
    const paths = [
      `/metrics/gsc?site=${encodeURIComponent(site)}&grain=query&since=${since}&limit=5000`,
      `/metrics/gsc?site=${encodeURIComponent(site)}&grain=site&since=${new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10)}&limit=20`,
      `/metrics/gsc?site=${encodeURIComponent(site)}&grain=page&since=${pageSince}&limit=10000`,
      `/metrics/ga4?site=${encodeURIComponent(site)}&grain=page&since=${pageSince}&limit=10000`,
    ];
    const results = [];
    for (const pathname of paths) {
      try { results.push({ status: 'fulfilled', value: await getJson(pathname, fetchImpl) }); }
      catch (reason) { results.push({ status: 'rejected', reason }); }
    }
    const records = index => results[index].status === 'fulfilled' ? results[index].value.records || [] : [];
    queryData[site] = records(0);
    siteData[site] = records(1);
    gscPageData[site] = records(2);
    ga4PageData[site] = records(3);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) upstreamError ||= String(failed.reason?.message || failed.reason);
  });

  const siteValueScores = Object.fromEntries(siteNames.map(site => {
    const totals = aggregatePages(site, ga4PageData[site], 'ga4').reduce((out, row) => ({
      sessions: out.sessions + row.sessions,
      conversions: out.conversions + row.conversions,
    }), { sessions: 0, conversions: 0 });
    return [site, pageValueScore(totals)];
  }));
  const rankedActions = [
    ...Object.entries(queryData).flatMap(([site, rows]) => queryActions(site, rows)),
    ...Object.entries(siteData).flatMap(([site, rows]) => trendActions(site, rows)),
    ...siteNames.flatMap(site => pageActions(site, gscPageData[site], ga4PageData[site])),
    ...siteNames.flatMap(site => pageDecayActions(site, ga4PageData[site], now)),
    ...webVitalsActions(webVitals),
    ...linkActions(linkRot),
  ].map(action => {
    const valueScore = action.valueScore || siteValueScores[action.site] || 0;
    const rankScore = Math.min(100, action.score + Math.round(valueScore * 0.15));
    const priority = priorityForScore(Math.max(action.score, rankScore));
    return { ...action, priority, valueScore, rankScore, plan: actionPlan(action) };
  }).sort((a, b) => b.rankScore - a.rankScore || b.valueScore - a.valueScore || b.metric.value - a.metric.value || a.site.localeCompare(b.site)).slice(0, 200);
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
  const siteRows = buildSiteRows(allSites, queryData, actions, gscPageData, ga4PageData);
  const hasAnalyticsEvidence = Object.values(queryData).some(rows => rows.length) ||
    Object.values(ga4PageData).some(rows => rows.length);
  const value = {
    generatedAt: now.toISOString(),
    windowDays: days,
    upstream: { ok: !upstreamError, partial: Boolean(upstreamError && hasAnalyticsEvidence), error: upstreamError },
    sources: {
      analyticsConfigured: siteNames.length,
      gscReady: Object.values(health.sites || {}).filter(s => (s.gsc?.status || '').startsWith('ok')).length,
      ga4Ready: Object.values(health.sites || {}).filter(s => (s.ga4?.status || '').startsWith('ok')).length,
      gscPageSites: Object.values(gscPageData).filter(rows => rows.length).length,
      ga4PageSites: Object.values(ga4PageData).filter(rows => rows.length).length,
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
      pagesMeasured: new Set(siteNames.flatMap(site => [
        ...aggregatePages(site, gscPageData[site], 'gsc').map(row => `${site}:${row.page}`),
        ...aggregatePages(site, ga4PageData[site], 'ga4').map(row => `${site}:${row.page}`),
      ])).size,
      conversions: Object.entries(ga4PageData).reduce((total, [site, rows]) =>
        total + aggregatePages(site, rows, 'ga4').reduce((sum, row) => sum + row.conversions, 0), 0),
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
  API, aggregateQueries, normalizePage, aggregatePages, pageValueScore, splitWeeks,
  queryActions, trendActions, pageActions, pageDecayActions, actionPlan,
  webVitalsActions, linkActions, buildSiteRows, actionKey, filedActionKeys,
  buildSnapshot, clearCache,
};
