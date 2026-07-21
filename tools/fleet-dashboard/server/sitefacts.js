'use strict';

// Per-site SEO/trust/branding/ads/legal fact checks + Amazon ASIN health +
// manual annotations — folded in from the standalone site-tracker tool,
// which was stalled since 2026-05 and covered only 15 of ~59 sites. Its
// git/github/deploy-freshness facts are dropped here as genuinely redundant
// with this dashboard's own Git/Deploys tabs (confirmed against fleet-dashboard's
// own history); its CF zone-level checks (zone_active, email_routing) are
// deferred — not ported yet, would need a per-site CF zone lookup this
// dashboard doesn't do anywhere else today.
//
// Same recipe model site-tracker used (regex_on_head / regex_on_body /
// path_status), reimplemented over native fetch instead of Python+httpx.
// Background poller sweeps all sites on a timer and caches results in
// memory + a JSON file (data/site-facts.json), same pattern as
// deployhealth.js. Manual per-site annotations are a small separate CRUD
// surface backed by data/site-facts-manual.json.

const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');

const POLL_MS = 60 * 60 * 1000;   // hourly — these facts change rarely
const CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 8000;
const MAX_MANUAL_VALUE_LEN = 500;
const MANUAL_KEY_RE = /^[a-zA-Z0-9._-]+$/;

const DATA_DIR = process.env.FD_DATA_DIR || path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'site-facts.json');
const MANUAL_FILE = path.join(DATA_DIR, 'site-facts-manual.json');
const AMZ_LATEST = process.env.FD_AMZ_LATEST
  || path.join(__dirname, '..', '..', 'amz-stats', 'out', 'latest.json');

function httpErr(status, msg) { const e = new Error(msg); e.httpStatus = status; return e; }

// ---- fact catalog -----------------------------------------------------
// state_rule: 'green_red' | 'green_yellow' | 'n_a' (n_a facts never render red/yellow)
const FACTS = [
  { key: 'seo.has_canonical', family: 'seo', describe: '<link rel="canonical"> present', kind: 'head_regex', pattern: /<link[^>]+rel=["']canonical["']/i, rule: 'green_yellow' },
  { key: 'seo.has_og_tags', family: 'seo', describe: 'Open Graph meta tags present', kind: 'head_regex', pattern: /property=["']og:(title|image|description)["']/i, rule: 'green_yellow' },
  { key: 'seo.has_schema_org', family: 'seo', describe: 'schema.org structured data present', kind: 'head_regex', pattern: /application\/ld\+json|itemscope/i, rule: 'green_yellow' },
  { key: 'seo.has_viewport_meta', family: 'seo', describe: '<meta name="viewport"> present', kind: 'head_regex', pattern: /name=["']viewport["']/i, rule: 'green_yellow' },
  { key: 'seo.has_rss', family: 'seo', describe: 'RSS/Atom feed linked from head', kind: 'head_regex', pattern: /type=["'](application\/(rss|atom)\+xml)["']/i, rule: 'green_yellow' },
  { key: 'ads.has_ads_txt', family: 'ads', describe: '/ads.txt published', kind: 'path_status', urlPath: '/ads.txt', rule: 'green_yellow' },
  { key: 'contact.has_contact_email', family: 'contact', describe: 'mailto: link present', kind: 'head_regex', pattern: /mailto:[\w.\-+]+@/i, rule: 'green_yellow' },
  { key: 'legal.has_privacy_page', family: 'legal', describe: '/privacy returns 200', kind: 'path_status', urlPath: '/privacy', rule: 'green_yellow' },
  { key: 'legal.has_terms_page', family: 'legal', describe: '/terms returns 200', kind: 'path_status', urlPath: '/terms', rule: 'green_yellow' },
  { key: 'legal.has_security_txt', family: 'legal', describe: '/.well-known/security.txt returns 200', kind: 'path_status', urlPath: '/.well-known/security.txt', rule: 'green_yellow' },
  { key: 'legal.has_affiliate_disclosure', family: 'legal', describe: 'affiliate/Amazon Associates disclosure present', kind: 'body_regex', pattern: /amazon associate|affiliate (link|disclosure)|earn.{0,40}commission/i, rule: 'green_yellow' },
  { key: 'branding.has_favicon', family: 'branding', describe: '/favicon.ico returns 200', kind: 'path_status', urlPath: '/favicon.ico', rule: 'green_yellow' },
  { key: 'branding.has_about_page', family: 'branding', describe: '/about returns 200', kind: 'path_status', urlPath: '/about', rule: 'green_yellow' },
  { key: 'http.ga4_present', family: 'http', describe: 'GA4 tag in <head>', kind: 'head_regex', pattern: /gtag\(['"]config['"],\s*['"]G-|googletagmanager\.com\/gtag\/js\?id=G-/i, rule: 'green_yellow' },
  { key: 'http.adsense_present', family: 'http', describe: 'AdSense tag in <head>', kind: 'head_regex', pattern: /pagead2\.googlesyndication\.com|adsbygoogle/i, rule: 'green_yellow' },
  { key: 'http.meta_pixel_present', family: 'http', describe: 'Meta Pixel in <head>', kind: 'head_regex', pattern: /connect\.facebook\.net.*fbevents|fbq\(['"]init['"]/i, rule: 'green_yellow' },
  { key: 'http.gtm_present', family: 'http', describe: 'GTM tag in <head>', kind: 'head_regex', pattern: /googletagmanager\.com\/gtm\.js/i, rule: 'green_yellow' },
];

function evalHeadRegex(homepage, pattern) {
  if (homepage == null) return null;
  const head = homepage.slice(0, 200_000).split('</head>', 1)[0];
  return pattern.test(head);
}
function evalBodyRegex(homepage, pattern) {
  if (homepage == null) return null;
  return pattern.test(homepage.slice(0, 500_000));
}

async function fetchText(url) {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'User-Agent': 'fleet-dashboard/sitefacts' } });
    if (r.status >= 500) return null;
    return { status: r.status, text: await r.text() };
  } catch { return null; }
}
async function fetchStatus(url) {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'User-Agent': 'fleet-dashboard/sitefacts' } });
    return r.status;
  } catch { return null; }
}

// Days until the site's TLS cert expires, via a raw TLS handshake (no HTTP).
function tlsExpiryDays(hostname) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host: hostname, port: 443, servername: hostname, timeout: FETCH_TIMEOUT_MS }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      if (!cert || !cert.valid_to) return resolve(null);
      const days = Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86400000);
      resolve(Number.isFinite(days) ? days : null);
    });
    sock.on('error', () => resolve(null));
    sock.on('timeout', () => { sock.destroy(); resolve(null); });
  });
}

async function collectSite(site) {
  const base = `https://${site}`;
  // The path_status checks + the TLS handshake are all independent network
  // calls — run them concurrently instead of one-at-a-time, or a full sweep
  // (39 sites × ~6 sequential fetches, up to 8s timeout each) can take
  // several minutes longer than it needs to.
  const [homepage, tlsDays, ...pathResults] = await Promise.all([
    fetchText(`${base}/`),
    tlsExpiryDays(site),
    ...FACTS.filter((f) => f.kind === 'path_status').map((f) => fetchStatus(`${base}${f.urlPath}`)),
  ]);
  const homepageText = homepage ? homepage.text : null;
  const out = { 'tls.expiry_days': tlsDays };

  let pi = 0;
  for (const f of FACTS) {
    if (f.kind === 'head_regex') out[f.key] = evalHeadRegex(homepageText, f.pattern);
    else if (f.kind === 'body_regex') out[f.key] = evalBodyRegex(homepageText, f.pattern);
    else if (f.kind === 'path_status') {
      const status = pathResults[pi++];
      out[f.key] = status == null ? null : status === 200;
    }
  }
  return out;
}

// ---- Amazon ASIN health (read-only re-surface of tools/amz-stats output) --
function amzFactsFor(site) {
  try {
    const snap = JSON.parse(fs.readFileSync(AMZ_LATEST, 'utf8'));
    const row = snap.summary && snap.summary.per_site && snap.summary.per_site[site];
    if (!row) return {};
    return {
      'amz.asin_count': row.asin_count ?? null,
      'amz.oos_count': row.oos_count ?? null,
      'amz.delisted_count': row.delisted_count ?? null,
      'amz.last_scan': snap.timestamp || null,
    };
  } catch { return {}; }
}

// ---- cache + poller (mirrors deployhealth.js) --------------------------
let CACHE = {};       // site -> { facts, checkedAt }
let lastSweep = 0;

function loadCacheFromDisk() {
  try { CACHE = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { /* first run */ }
}
function saveCacheToDisk() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(CACHE)); } catch { /* best-effort */ }
}

async function sweep(sites) {
  const queue = sites.slice();
  const next = { ...CACHE };
  async function worker() {
    for (let s = queue.shift(); s; s = queue.shift()) {
      try { next[s] = { facts: { ...(await collectSite(s)), ...amzFactsFor(s) }, checkedAt: Date.now() }; }
      catch { /* leave previous cache entry for this site */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  CACHE = next;
  lastSweep = Date.now();
  saveCacheToDisk();
}

function start(getSites) {
  loadCacheFromDisk();
  const tick = () => { sweep(getSites()).catch(() => { /* swallow; cache simply goes stale */ }); };
  tick();
  const t = setInterval(tick, POLL_MS);
  if (t.unref) t.unref();
}

// ---- manual annotations -------------------------------------------------
function loadManual() {
  try { return JSON.parse(fs.readFileSync(MANUAL_FILE, 'utf8')); } catch { return {}; }
}
function saveManual(m) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MANUAL_FILE, JSON.stringify(m, null, 2));
}
function validateManual(key, value) {
  if (!MANUAL_KEY_RE.test(key)) throw httpErr(400, "key must be letters, numbers, '.', '_', '-' only");
  if (typeof value !== 'string' || !value.trim()) throw httpErr(400, 'value is required');
  if (value.length > MAX_MANUAL_VALUE_LEN) throw httpErr(400, `value too long (max ${MAX_MANUAL_VALUE_LEN} chars)`);
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw httpErr(400, 'value contains control characters');
}
function setManualFact(site, key, value) {
  validateManual(key, value);
  const m = loadManual();
  m[site] = m[site] || {};
  m[site][key] = { value: value.trim(), setAt: new Date().toISOString() };
  saveManual(m);
  return m[site][key];
}
function deleteManualFact(site, key) {
  const m = loadManual();
  if (m[site]) { delete m[site][key]; saveManual(m); }
}
function manualFor(site) { return loadManual()[site] || {}; }

// ---- public read surface -------------------------------------------------
function familyState(rows) {
  // Worst-of rollup: red > yellow/unknown > green > n_a. These recipe facts
  // only ever produce green/yellow/unknown (never red — a missing SEO tag
  // isn't a red-alert the way a broken deploy is), matching site-tracker's
  // own bool_green_yellow rule for everything ported here.
  if (rows.some((v) => v === false)) return 'yellow';
  if (rows.some((v) => v == null)) return 'unknown';
  return 'green';
}

function matrix(sites) {
  const families = [...new Set(FACTS.map((f) => f.family))];
  const rows = sites.map((site) => {
    const cached = CACHE[site];
    const facts = (cached && cached.facts) || {};
    const cells = {};
    for (const fam of families) {
      const famFacts = FACTS.filter((f) => f.family === fam);
      cells[fam] = familyState(famFacts.map((f) => facts[f.key]));
    }
    return { site, cells, checkedAt: cached ? cached.checkedAt : null };
  });
  return { families, rows, lastSweep };
}

function siteDetail(site) {
  const cached = CACHE[site];
  const facts = (cached && cached.facts) || {};
  const rows = FACTS.map((f) => ({ key: f.key, describe: f.describe, value: facts[f.key] ?? null }));
  const amz = { asin_count: facts['amz.asin_count'] ?? null, oos_count: facts['amz.oos_count'] ?? null, delisted_count: facts['amz.delisted_count'] ?? null, last_scan: facts['amz.last_scan'] ?? null };
  const tlsExpiryDaysVal = facts['tls.expiry_days'] ?? null;
  return { site, rows, amz, tlsExpiryDays: tlsExpiryDaysVal, checkedAt: cached ? cached.checkedAt : null, manual: manualFor(site) };
}

module.exports = { start, matrix, siteDetail, setManualFact, deleteManualFact };
