'use strict';

// Live, evidence-based privacy baseline scanner. This intentionally reports a
// technical status (pass/fail/unknown), never a legal certification.

const fs = require('node:fs');
const path = require('node:path');

const MAX_ASSETS = 12;
const MAX_BODY_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 12_000;
const SCAN_INTERVAL_MS = 60 * 60 * 1000;
const CONCURRENCY = 5;
const CACHE = Object.create(null);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'compliance-latest.json');
const HISTORY_FILE = path.join(DATA_DIR, 'compliance-history.json');
const HISTORY_LIMIT = 180;
let HISTORY = Object.create(null);
let PROGRESS = { running: false, total: 0, completed: 0, startedAt: null, finishedAt: null, currentSites: [] };

function loadState() {
  if (process.env.NODE_ENV === 'test') return;
  try { Object.assign(CACHE, JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))); } catch { /* first run */ }
  try { HISTORY = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { /* first run */ }
}

function saveState() {
  if (process.env.NODE_ENV === 'test') return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(CACHE));
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(HISTORY));
  } catch { /* best-effort cache; scanning must still succeed */ }
}

function record(row) {
  const entries = HISTORY[row.site] || [];
  const previous = entries[entries.length - 1];
  const change = !previous ? 'new' : previous.status === row.status ? 'unchanged'
    : row.status === 'pass' ? 'resolved' : previous.status === 'pass' ? 'regressed' : 'changed';
  const entry = {
    checkedAt: row.checkedAt,
    status: row.status,
    failures: row.failures || [],
    errorType: row.errorType || null,
    change,
  };
  HISTORY[row.site] = [...entries, entry].slice(-HISTORY_LIMIT);
  row.change = change;
  row.previousStatus = previous ? previous.status : null;
}

loadState();

function has(re, text) { return re.test(text); }

function cleanText(value) {
  return String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();
}

function short(value, max = 280) {
  const text = cleanText(value);
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function quotedStrings(source, max = 700) {
  const out = [];
  // Vite/Rollup emits user-facing JSX strings as double-quoted constants.
  // Parsing both quote styles with one regex lets apostrophes inside those
  // strings masquerade as delimiters and swallow minified code fragments.
  // Human-facing labels/copy do not contain embedded quote escapes in our
  // compiled bundles. Keeping this deliberately simple makes the extraction
  // deterministic and avoids a minified escape sequence consuming the text.
  const re = /"([^"\r\n]{1,700})"/g;
  for (let m; (m = re.exec(source));) {
    const value = m[1].replace(/\\(["\\])/g, '$1').replace(/\\n/g, ' ');
    if (value.length <= max) out.push(short(value, max));
  }
  return out;
}

function elementText(source, tag, words) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]{0,800}?)<\\/${tag}>`, 'gi');
  for (let m; (m = re.exec(source));) {
    const text = short(m[1], 120);
    if (text && words.test(text)) return text;
  }
  const exactQuoted = new RegExp(`['\"](${words.source})['\"]`, 'i').exec(source);
  if (exactQuoted) return short(exactQuoted[1], 120);
  // Hydrated apps often keep labels as standalone quoted strings in a JS
  // bundle. Only accept a whole-label match; never return a code fragment that
  // merely contains a word such as "acceptsBooleans".
  return quotedStrings(source, 80).find((value) => {
    const exact = new RegExp(`^(?:${words.source})$`, 'i');
    return exact.test(value.trim());
  }) || null;
}

function bannerWording(source) {
  const direct = /['"]([^'"]{0,20}(?:we (?:use|store)|this (?:site )?uses)[^'"]{0,500}(?:cookie|consent)[^'"]{0,300})['"]/i.exec(source);
  if (direct) return short(direct[1]);
  const strings = quotedStrings(source).filter((value) =>
    value.length >= 25
    && /cookie|consent|privacy choices|tracking preferences/i.test(value)
    && !/[{};=]{2,}|=>|function\b|localStorage\b/i.test(value));
  strings.sort((a, b) => {
    const score = (s) => (/\bwe (?:use|store)\b/i.test(s) ? 100 : 0)
      + (/privacy-respecting|see which pages|get read|no ad tracking/i.test(s) ? 300 : 0)
      + (/analytics cookie/i.test(s) ? 100 : 0) + Math.min(s.length, 180);
    return score(b) - score(a);
  });
  if (strings[0]) return short(strings[0]);
  const blocks = /<(?:div|section|aside)\b[^>]*(?:cookie|consent|banner|dialog|modal)[^>]*>([\s\S]{0,3000}?)<\/(?:div|section|aside)>/gi;
  for (let m; (m = blocks.exec(source));) {
    const text = short(m[1]);
    if (/cookie|consent|privacy choices|tracking preferences/i.test(text)) return text;
  }
  return null;
}

function legalLink(source, kind, pageUrl) {
  const re = /<a\b[^>]*href\s*=\s*['"]([^'"]+)['"][^>]*>([\s\S]{0,300}?)<\/a>/gi;
  for (let m; (m = re.exec(source));) {
    const combined = `${m[1]} ${cleanText(m[2])}`;
    const wanted = kind === 'privacy' ? /privacy/i : /terms|conditions/i;
    if (!wanted.test(combined)) continue;
    try { return new URL(m[1], pageUrl).href; } catch { return m[1]; }
  }
  // React/Vue routers compile <Link to="/privacy"> into adjacent string
  // constants instead of an HTML anchor. Require both a quoted route and
  // page-specific legal wording so an unrelated mention is not enough.
  const route = kind === 'privacy' ? '/privacy' : '/terms';
  const routeRe = new RegExp(`['\"]${route.replace('/', '\\/')}\\/?['\"]`, 'i');
  const contentRe = kind === 'privacy'
    ? /privacy policy|information we collect|your privacy rights/i
    : /terms of (?:use|service)|by using .{0,80} you agree|limitation of liability/i;
  if (routeRe.test(source) && contentRe.test(source)) {
    try { return new URL(route, pageUrl).href; } catch { return route; }
  }
  return null;
}

function analyze(text, { url = '' } = {}) {
  const source = String(text || '');
  const lower = source.toLowerCase();
  // GA4 web measurement IDs use G- followed by exactly ten alphanumerics.
  // Keeping this strict avoids UI/CSS tokens such as "G-GRADIENT".
  const measurementIds = [...new Set(source.match(/\bG-[A-Z0-9]{10}\b/gi) || [])].map((id) => id.toUpperCase());
  const ga4 = measurementIds.length > 0
    || has(/googletagmanager\.com\/(?:gtag\/js|gtm\.js)|google-analytics\.com\/g\/collect/i, source);
  const cookieLanguage = has(/cookie|consent|privacy choices|tracking preferences/i, lower);
  const accept = has(/accept(?:\s+all)?|allow(?:\s+all)?|agree|grant/i, lower);
  const reject = has(/reject(?:\s+all)?|decline(?:\s+all)?|deny|necessary only|essential only/i, lower);
  const banner = cookieLanguage && accept && has(/banner|dialog|modal|cookie-consent|cookie_banner|consent-banner|consentmanager|cookiebot/i, lower);
  const defaultDenied = (
    has(/gtag\s*\(\s*['"]consent['"]\s*,\s*['"]default['"]/i, source)
    && has(/analytics_storage[\s\S]{0,120}denied/i, source)
  ) || has(/setDefaultConsentState[\s\S]{0,240}analytics_storage[\s\S]{0,120}denied/i, source);
  const consentUpdate = has(/gtag\s*\(\s*['"]consent['"]\s*,\s*['"]update['"]|updateConsentState/i, source);
  const basicGate = ga4 && has(/consent|cookie/i, lower)
    && has(/localStorage|sessionStorage|document\.cookie|consent-granted|analytics_consent|cookie_consent/i, source)
    && has(/load(?:Analytics|GA|Gtag)|appendChild\s*\(|createElement\s*\(\s*['"]script|googletagmanager/i, source);
  const gaConsentGated = !ga4 || defaultDenied || basicGate;
  const privacyUrl = legalLink(source, 'privacy', url);
  const termsUrl = legalLink(source, 'terms', url);
  const privacy = Boolean(privacyUrl);
  const terms = Boolean(termsUrl);
  const https = /^https:/i.test(url);
  const evidence = {
    bannerWording: bannerWording(source),
    acceptLabel: elementText(source, '(?:button|a)', /accept(?:\s+all)?|allow(?:\s+all)?|agree/i),
    rejectLabel: elementText(source, '(?:button|a)', /reject(?:\s+all)?|decline(?:\s+all)?|necessary only|essential only/i),
    privacyUrl,
    termsUrl,
  };

  const failures = [];
  if (!banner) failures.push('cookie banner not detected');
  if (!accept) failures.push('accept choice not detected');
  if (!reject) failures.push('reject/decline choice not detected');
  if (ga4 && !gaConsentGated) failures.push('GA4 detected without default-denied or basic consent gating');
  if (!privacy) failures.push('privacy policy page/link not detected');
  if (!terms) failures.push('terms page/link not detected');

  return {
    status: failures.length ? 'fail' : 'pass',
    checks: { https, banner, accept, reject, ga4, gaConsentGated, defaultDenied, consentUpdate, privacy, terms },
    measurementIds,
    failures,
    evidence,
  };
}

class ScanError extends Error {
  constructor(message, type, details = {}) {
    super(message);
    this.type = type;
    Object.assign(this, details);
  }
}

async function fetchText(url, { requireHtml = false } = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'fleet-dashboard/compliance (+technical privacy audit)' },
  });
  if (!response.ok) throw new ScanError(`HTTP ${response.status}`, 'http', { httpStatus: response.status });
  const type = response.headers.get('content-type') || '';
  if (requireHtml && !/text\/html/i.test(type)) {
    throw new ScanError(`unsupported content type: ${type || 'missing'}`, 'unsupported-content');
  }
  if (!/(?:text\/html|javascript|ecmascript|text\/plain)/i.test(type)) return '';
  const text = await response.text();
  return text.slice(0, MAX_BODY_BYTES);
}

function scriptUrls(html, pageUrl) {
  const urls = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"][^>]*>/gi;
  for (let m; (m = re.exec(html)) && urls.length < MAX_ASSETS;) {
    try {
      const u = new URL(m[1], pageUrl);
      if (u.origin === new URL(pageUrl).origin && /^https?:$/.test(u.protocol)) urls.push(u.href);
    } catch { /* malformed src: ignore */ }
  }
  return [...new Set(urls)];
}

async function scanSite(site) {
  const requestedUrl = `https://${site}/`;
  const checkedAt = new Date().toISOString();
  try {
    const html = await fetchText(requestedUrl, { requireHtml: true });
    const assets = scriptUrls(html, requestedUrl);
    const bundles = await Promise.all(assets.map((url) => fetchText(url).catch(() => '')));
    const result = analyze([html, ...bundles].join('\n'), { url: requestedUrl });
    return { site, checkedAt, reachable: true, url: requestedUrl, assetsChecked: assets.length, ...result };
  } catch (error) {
    const causeCode = error && error.cause && error.cause.code;
    const message = String(error.message || error);
    const errorType = error.type
      || (/timeout|abort/i.test(`${error.name || ''} ${message}`) ? 'timeout'
        : /ENOTFOUND|EAI_AGAIN|DNS/i.test(`${causeCode || ''} ${message}`) ? 'dns'
          : /certificate|CERT_|TLS|SSL/i.test(`${causeCode || ''} ${message}`) ? 'tls'
            : 'network');
    return {
      site, checkedAt, reachable: false, url: requestedUrl, assetsChecked: 0, status: 'unknown',
      checks: { https: true, banner: null, accept: null, reject: null, ga4: null, gaConsentGated: null, defaultDenied: null, consentUpdate: null, privacy: null, terms: null },
      measurementIds: [], failures: [], evidence: {}, error: message, errorType,
      errorCode: causeCode || null, httpStatus: error.httpStatus || null,
    };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

let running = null;
async function scanAll(sites) {
  if (running) return running;
  PROGRESS = {
    running: true, total: sites.length, completed: 0,
    startedAt: new Date().toISOString(), finishedAt: null, currentSites: [],
  };
  running = mapLimit(sites, CONCURRENCY, async (site) => {
    PROGRESS.currentSites = [...PROGRESS.currentSites, site];
    const row = await scanSite(site);
    record(row);
    CACHE[site] = row;
    PROGRESS.completed += 1;
    PROGRESS.currentSites = PROGRESS.currentSites.filter((item) => item !== site);
    return row;
  }).then((rows) => {
    saveState();
    return rows;
  }).finally(() => {
    PROGRESS.running = false;
    PROGRESS.finishedAt = new Date().toISOString();
    PROGRESS.currentSites = [];
    running = null;
  });
  return running;
}

async function scanOne(site) {
  const row = await scanSite(site);
  record(row);
  CACHE[site] = row;
  saveState();
  return row;
}

function startScan(sites) {
  if (!running) scanAll(sites).catch(() => {});
  return progress();
}

function progress() { return { ...PROGRESS, currentSites: [...PROGRESS.currentSites] }; }

function fleetHistory(sites, limit = 20) {
  const events = sites.flatMap((site) => (HISTORY[site] || []).map((entry) => ({ site, ...entry })))
    .sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt));
  const buckets = new Map();
  for (const event of events) {
    const key = event.checkedAt.slice(0, 13);
    if (!buckets.has(key)) buckets.set(key, new Map());
    buckets.get(key).set(event.site, event.status);
  }
  return [...buckets.entries()].slice(-Math.max(1, Math.min(Number(limit) || 20, 100))).map(([at, statuses]) => {
    const values = [...statuses.values()];
    const pass = values.filter((status) => status === 'pass').length;
    return { at: `${at}:00:00.000Z`, pass, total: values.length, passRate: values.length ? Math.round(100 * pass / values.length) : 0 };
  });
}

function historyStats(entries) {
  let failureSince = null;
  let lastResolvedAt = null;
  let lastResolutionMs = null;
  for (const entry of entries) {
    if (entry.status !== 'pass' && !failureSince) failureSince = entry.checkedAt;
    if (entry.status === 'pass' && failureSince) {
      lastResolvedAt = entry.checkedAt;
      lastResolutionMs = Date.parse(entry.checkedAt) - Date.parse(failureSince);
      failureSince = null;
    }
  }
  return { failureSince, lastResolvedAt, lastResolutionMs };
}

function matrix(sites) {
  return sites.map((site) => {
    const row = CACHE[site] || {
    site, checkedAt: null, reachable: null, status: 'unknown', checks: {}, measurementIds: [], failures: [], evidence: {}, error: 'not scanned yet',
      errorType: 'not-scanned',
    };
    const allHistory = HISTORY[site] || [];
    return { ...row, history: allHistory.slice(-12), historyStats: historyStats(allHistory) };
  });
}

function start(getSites) {
  const tick = () => scanAll(getSites()).catch(() => {});
  tick();
  const timer = setInterval(tick, SCAN_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

module.exports = { analyze, scriptUrls, scanSite, scanAll, scanOne, startScan, progress, fleetHistory, matrix, start };
