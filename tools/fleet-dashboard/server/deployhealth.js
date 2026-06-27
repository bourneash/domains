'use strict';

// Deploy-health poller. The deployer column reflects push state (git ahead of
// origin) cheaply on every request; THIS adds the authoritative half — did
// Cloudflare actually ship the latest commit? We can't probe CF on every
// dashboard load (slow + rate-limited), so a background timer polls each
// worker's newest version timestamp, compares it to the site's HEAD commit
// time, and caches the verdict in memory for roles.matrix() to fold in.
//
// Read-only: unlike tools/deployment-tester (which pushes a probe commit), this
// only GETs each worker's version list. No writes, no git, no CF mutations.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { siteDir } = require('./sites');

const POLL_MS = 5 * 60 * 1000;     // refresh cadence
const CONCURRENCY = 4;             // parallel CF calls (be gentle on the API)
const PENDING_GRACE = 15 * 60;     // sec: CF lagging HEAD within this of a fresh push = "building", not failed
const STALE_AFTER = 30 * 60 * 1000; // ms: ignore the cache if the poller stopped updating

let CACHE = {};                    // slug -> verdict
let lastSweep = 0;
let creds = null;                  // { accountId, token } | null

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 15000 }, (err, out) => resolve(err ? null : out.toString().trim()));
  });
}

// CF account id + token from the repo-root .env (same source as deployment-tester).
function loadCreds(root) {
  if (creds !== null) return creds;
  creds = false;
  try {
    const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
    // Value = first token after `=`, stopping at whitespace, quote, or an inline
    // `#` comment (mirrors how the shell sources this same .env).
    const pick = (k) => {
      const m = env.match(new RegExp('^\\s*' + k + '\\s*=\\s*["\']?([^\\s"\'#]+)', 'm'));
      return m ? m[1] : null;
    };
    const accountId = pick('CLOUDFLARE_ACCOUNT_ID');
    const token = pick('CLOUDFLARE_API_TOKEN');
    if (accountId && token) creds = { accountId, token };
  } catch { /* no .env → no CF checks */ }
  return creds;
}

// Authoritative worker name: site/wrangler.jsonc `name`, else dot→dash of slug
// (matches deployment-tester, and handles the CF dot-stripping drift).
function workerName(root, slug) {
  try {
    const wr = fs.readFileSync(path.join(siteDir(root, slug), 'site', 'wrangler.jsonc'), 'utf8');
    const m = wr.match(/"name"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
  } catch { /* fall through */ }
  return slug.replace(/\./g, '-');
}

function isoToEpoch(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

// One site: compare CF's newest worker version timestamp to the HEAD commit time.
async function checkOne(root, slug, c) {
  const worker = workerName(root, slug);
  const cwd = siteDir(root, slug);
  const headSec = parseInt(await git(cwd, ['log', '-1', '--format=%ct']) || '0', 10) || null;
  const out = { slug, worker, ok: false, live: null, deployedAt: null, version: null, headTime: headSec, error: null, checkedAt: Date.now() };
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${c.accountId}/workers/scripts/${worker}/versions`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(12000) });
    const j = await r.json();
    if (!j || j.success !== true) { out.error = (j && j.errors && j.errors[0] && j.errors[0].message) || `HTTP ${r.status}`; return out; }
    const item = j.result && j.result.items && j.result.items[0];
    if (!item) { out.error = 'no versions'; return out; }
    out.version = item.number ?? (item.id ? item.id.slice(0, 8) : null);
    out.deployedAt = isoToEpoch(item.metadata && item.metadata.created_on);
    out.ok = out.deployedAt != null && headSec != null;
    if (out.ok) out.live = out.deployedAt >= headSec - 120;   // small slack for build lag
  } catch (e) {
    out.error = e.name === 'TimeoutError' ? 'timeout' : (e.message || 'fetch failed');
  }
  return out;
}

async function sweep(root, slugs) {
  const c = loadCreds(root);
  if (!c) return;                                   // no creds → leave cache empty, deployer cell falls back to push state
  const queue = slugs.slice();
  const next = {};
  async function worker() {
    for (let s = queue.shift(); s; s = queue.shift()) next[s] = await checkOne(root, s, c);
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  CACHE = next;
  lastSweep = Date.now();
}

// Start the background timer (immediate first sweep, then every POLL_MS). The
// timer is unref'd so it never holds the process open on shutdown.
function start(root, getSlugs) {
  const tick = () => { sweep(root, getSlugs()).catch(() => { /* swallow; cache simply goes stale */ }); };
  tick();
  const t = setInterval(tick, POLL_MS);
  if (t.unref) t.unref();
}

// Verdict for a slug, or null if we have no fresh data (poller off / creds
// missing / sweep stale) — callers fall back to push state.
function get(slug) {
  if (!lastSweep || Date.now() - lastSweep > STALE_AFTER) return null;
  return CACHE[slug] || null;
}

function all() { return { lastSweep, sites: CACHE }; }

module.exports = { start, get, all, _checkOne: checkOne, _loadCreds: loadCreds, _workerName: workerName };
