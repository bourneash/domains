'use strict';

const fs = require('node:fs');
const path = require('node:path');

const API_BASE = (
  process.env.BING_WEBMASTER_API_BASE_URL || 'https://www.bing.com/webmaster/api.svc/json'
).replace(/\/+$/, '');
const REQUEST_DELAY_MS = Number(process.env.BING_REQUEST_DELAY_MS || 150);
const MAX_LINK_COUNT_PAGES = Number(process.env.BING_MAX_LINK_COUNT_PAGES || 100);
const MAX_DETAIL_PAGES = Number(process.env.BING_MAX_DETAIL_PAGES || 100);
const MAX_TARGET_PAGES = Number(process.env.BING_MAX_TARGET_PAGES || 250);
const MAX_DETAILS = Number(process.env.BING_MAX_DETAILS || 10000);

function sleep(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

function normalizeHost(value) {
  const raw = String(value || '').trim();
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname
      .toLowerCase()
      .replace(/^www\./, '');
  } catch {
    return raw
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\/$/, '');
  }
}

function normalizeSiteUrl(value) {
  const host = normalizeHost(value);
  if (!host) throw new Error('Bing site URL is empty');
  return `https://${host}/`;
}

function parseUserSites(payload) {
  const rows = Array.isArray(payload) ? payload : [];
  return rows
    .map(row => ({
      url: String(row.Url || row.url || ''),
      host: normalizeHost(row.Url || row.url),
      verified: row.IsVerified === true || row.isVerified === true,
    }))
    .filter(row => row.host);
}

function localSiteNames(root) {
  try {
    return fs
      .readdirSync(path.join(root, 'sites'), { withFileTypes: true })
      .filter(
        entry => entry.isDirectory() && fs.existsSync(path.join(root, 'sites', entry.name, '.git'))
      )
      .map(entry => normalizeHost(entry.name));
  } catch {
    return [];
  }
}

async function bingJson(method, params, apiKey) {
  const url = new URL(`${API_BASE}/${method}`);
  for (const [key, value] of Object.entries({ ...params, apikey: apiKey })) {
    if (value !== undefined && value !== null && value !== '')
      url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Bing ${method} returned HTTP ${response.status} with non-JSON data`);
  }
  if (!response.ok) {
    const message =
      body?.Message || body?.message || body?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Bing ${method} failed: ${String(message).slice(0, 240)}`);
  }
  if (body?.ErrorCode || body?.error) {
    const message = body.Message || body.message || body.error?.message || 'API error';
    throw new Error(`Bing ${method} failed: ${String(message).slice(0, 240)}`);
  }
  return body?.d ?? body;
}

async function paged(getPage, totalPages, maxPages) {
  const rows = [];
  const pages = Math.min(Math.max(Number(totalPages) || 1, 1), maxPages);
  for (let page = 0; page < pages; page += 1) {
    if (page) await sleep(REQUEST_DELAY_MS);
    const result = await getPage(page);
    rows.push(result);
  }
  return rows;
}

function summarizeLinks(linkPages, detailPages) {
  const targets = linkPages.flatMap(page => (Array.isArray(page?.Links) ? page.Links : []));
  const details = detailPages.flatMap(page => (Array.isArray(page?.Details) ? page.Details : []));
  const domainCounts = new Map();
  const anchors = new Map();
  for (const detail of details) {
    let host = '';
    try {
      host = normalizeHost(detail.Url);
    } catch {
      /* ignore malformed provider rows */
    }
    if (host) domainCounts.set(host, (domainCounts.get(host) || 0) + 1);
    const anchor = String(detail.AnchorText || '').trim();
    if (anchor) anchors.set(anchor, (anchors.get(anchor) || 0) + 1);
  }
  return {
    targetPages: targets.map(row => ({
      url: String(row.Url || ''),
      count: Number(row.Count) || 0,
    })),
    details,
    backlinkCount: targets.reduce((sum, row) => sum + (Number(row.Count) || 0), 0),
    referringDomainsObserved: domainCounts.size,
    domainCounts: [...domainCounts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    ),
    anchors: [...anchors.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
}

function markdown(value) {
  return String(value || '')
    .replace(/[\\|`]/g, '\\$&')
    .replace(/\r?\n/g, ' ');
}

function renderReport(site, capturedAt, summary, limits) {
  const date = capturedAt.slice(0, 10);
  const targetRows = summary.targetPages.filter(row => row.url).slice(0, limits.maxTargetPages);
  const domainRows = summary.domainCounts.slice(0, 100);
  const anchorRows = summary.anchors.slice(0, 100);
  const detailRows = summary.details.filter(row => row.Url).slice(0, 100);
  return (
    `# Bing Webmaster backlink capture — ${site}\n\n` +
    `- source: Bing Webmaster JSON API (Link Details)\n` +
    `- captured_at: ${capturedAt}\n` +
    `- site: ${normalizeSiteUrl(site)}\n` +
    `- status: measured\n` +
    `- backlinks: ${summary.backlinkCount} (sum of reported target-page counts)\n` +
    `- referring domains: ${summary.referringDomainsObserved} (observed in returned detail rows)\n` +
    `- target pages with links: ${targetRows.filter(row => row.count > 0).length}\n` +
    `- detail rows observed: ${summary.details.length}\n\n` +
    `Bing returns representative link data rather than a guaranteed complete link index; use this as a dated baseline and trend signal.\n\n` +
    `## Referring domains observed\n\n` +
    (domainRows.length
      ? domainRows.map(([domain, count]) => `- ${markdown(domain)} — ${count}`).join('\n')
      : '- None returned.') +
    '\n\n' +
    `## Target pages\n\n` +
    (targetRows.length
      ? targetRows.map(row => `- ${markdown(row.url)} — ${row.count}`).join('\n')
      : '- None returned.') +
    '\n\n' +
    `## Anchor text observed\n\n` +
    (anchorRows.length
      ? anchorRows.map(([anchor, count]) => `- ${markdown(anchor)} — ${count}`).join('\n')
      : '- None returned.') +
    '\n\n' +
    `## Source URL samples\n\n` +
    (detailRows.length
      ? detailRows
          .map(
            row => `- ${markdown(row.Url)}${row.AnchorText ? ` — ${markdown(row.AnchorText)}` : ''}`
          )
          .join('\n')
      : '- None returned.') +
    '\n\n' +
    `## Capture limits\n\n` +
    `- Link-count pages fetched: ${limits.linkCountPages}; detail pages fetched: ${limits.detailPages}; max target pages: ${limits.maxTargetPages}; max detail rows requested: ${limits.maxDetails}.\n` +
    `- The report contains provider-returned observations only; it does not claim that unreturned links are absent.\n`
  );
}

async function captureSite(site, apiKey, userSites = null) {
  const siteUrl = normalizeSiteUrl(site);
  const sites = userSites || parseUserSites(await bingJson('GetUserSites', {}, apiKey));
  const verified = sites.find(row => row.host === normalizeHost(site) && row.verified);
  if (!verified) throw new Error(`${site} is not present as a verified Bing Webmaster site`);

  const countPages = await paged(
    page => bingJson('GetLinkCounts', { siteUrl, page }, apiKey),
    1,
    MAX_LINK_COUNT_PAGES
  );
  const totalCountPages = Number(countPages[0]?.TotalPages) || 1;
  const remainingCountPages =
    totalCountPages > 1
      ? await paged(
          page => bingJson('GetLinkCounts', { siteUrl, page: page + 1 }, apiKey),
          totalCountPages - 1,
          Math.max(0, MAX_LINK_COUNT_PAGES - 1)
        )
      : [];
  const allCountPages = [...countPages, ...remainingCountPages];
  const preliminary = summarizeLinks(allCountPages, []);
  const targets = preliminary.targetPages
    .filter(row => row.url && row.count > 0)
    .slice(0, MAX_TARGET_PAGES);
  const detailPages = [];
  for (const target of targets) {
    const first = await bingJson('GetUrlLinks', { siteUrl, link: target.url, page: 0 }, apiKey);
    detailPages.push(first);
    const totalPages = Number(first?.TotalPages) || 1;
    const rest = await paged(
      page => bingJson('GetUrlLinks', { siteUrl, link: target.url, page: page + 1 }, apiKey),
      totalPages - 1,
      Math.min(MAX_DETAIL_PAGES - 1, Math.max(0, MAX_DETAILS - detailPages.length - 1))
    );
    detailPages.push(...rest);
    if (
      detailPages.reduce(
        (n, page) => n + (Array.isArray(page?.Details) ? page.Details.length : 0),
        0
      ) >= MAX_DETAILS
    )
      break;
  }
  const summary = summarizeLinks(allCountPages, detailPages);
  return {
    site,
    capturedAt: new Date().toISOString(),
    summary,
    limits: {
      linkCountPages: allCountPages.length,
      detailPages: detailPages.length,
      maxTargetPages: MAX_TARGET_PAGES,
      maxDetails: MAX_DETAILS,
    },
  };
}

function selectedSites(argv) {
  const arg = argv.find(value => value.startsWith('--sites='));
  const configured = arg ? arg.slice('--sites='.length) : process.env.BING_BACKLINK_SITES;
  return configured ? [...new Set(configured.split(',').map(normalizeHost).filter(Boolean))] : null;
}

async function main(argv = process.argv.slice(2)) {
  const apiKey = process.env.BING_WEBMASTER_API_KEY;
  if (!apiKey) throw new Error('BING_WEBMASTER_API_KEY is required');
  const rootArg = argv.indexOf('--root');
  const root = path.resolve(
    rootArg >= 0 ? argv[rootArg + 1] : process.env.DOMAINS_ROOT || path.join(__dirname, '..', '..')
  );
  const configuredSites = selectedSites(argv);
  const userSites = configuredSites
    ? null
    : parseUserSites(await bingJson('GetUserSites', {}, apiKey));
  const sites =
    configuredSites ||
    [...new Set(userSites.filter(row => row.verified).map(row => row.host))].filter(site =>
      localSiteNames(root).includes(site)
    );
  if (!sites.length)
    throw new Error(
      'No verified Bing sites overlap the local fleet; set BING_BACKLINK_SITES to override'
    );
  const results = [];
  for (const site of sites) {
    try {
      const result = await captureSite(site, apiKey, userSites);
      const output = path.join(
        root,
        'sites',
        site,
        'ops',
        'seo',
        `backlinks-${result.capturedAt.slice(0, 10)}.md`
      );
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(
        output,
        renderReport(site, result.capturedAt, result.summary, result.limits)
      );
      results.push({ site, status: 'captured', output, backlinks: result.summary.backlinkCount });
    } catch (error) {
      results.push({ site, status: 'failed', error: String(error.message || error) });
    }
  }
  process.stdout.write(`${JSON.stringify(results)}\n`);
  if (results.some(row => row.status === 'failed')) process.exitCode = 1;
  return results;
}

if (require.main === module)
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });

module.exports = {
  localSiteNames,
  normalizeHost,
  normalizeSiteUrl,
  parseUserSites,
  paged,
  summarizeLinks,
  renderReport,
  selectedSites,
};
