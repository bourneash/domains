'use strict';

// Deploy-health poller. The deployer column reflects push state (git ahead of
// origin) cheaply on every request; THIS adds the authoritative half — did
// Cloudflare actually ship the latest deployable commit? A repository HEAD
// may contain ops-only commits, which Workers Builds intentionally excludes.
// Comparing the Worker to absolute HEAD therefore creates fleet-wide false
// failures. We compare against the latest commit that changed site/ (or the
// explicit .deploy-probe) and retain absolute HEAD separately for display.
//
// Read-only: unlike tools/deployment-tester (which pushes a probe commit), this
// only GETs each worker's version list. No writes, no git, no CF mutations.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { siteDir } = require('./sites');
const cloudflarebuilds = require('./cloudflarebuilds');

const POLL_MS = 5 * 60 * 1000;     // refresh cadence
const CONCURRENCY = 4;             // parallel CF calls (be gentle on the API)
const PENDING_GRACE = 15 * 60;     // sec: CF lagging a fresh deployable commit = "deploying", not failed
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

// One site: compare CF's newest worker version timestamp to the latest
// deployable commit, not the absolute repository HEAD.
async function checkOne(root, slug, c) {
  const worker = workerName(root, slug);
  const cwd = siteDir(root, slug);
  const headHash = await git(cwd, ['log', '-1', '--format=%H']);
  const headSec = parseInt(await git(cwd, ['log', '-1', '--format=%ct']) || '0', 10) || null;
  const deployableRaw = await git(cwd, ['log', '-1', '--format=%H%x00%ct', '--', 'site', '.deploy-probe']);
  const [deployableHash, deployableTimeRaw] = String(deployableRaw || '').split('\u0000');
  const deployableSec = parseInt(deployableTimeRaw || '0', 10) || null;
  let changedSinceDeployable = [];
  if (deployableHash && headHash && deployableHash !== headHash) {
    const changed = await git(cwd, ['diff', '--name-only', `${deployableHash}..HEAD`]);
    changedSinceDeployable = String(changed || '').split('\n').filter(Boolean);
  }
  const opsOnly = Boolean(
    deployableHash && headHash && deployableHash !== headHash && changedSinceDeployable.length &&
      changedSinceDeployable.every(file => file.startsWith('ops/'))
  );
  const out = {
    slug, worker, ok: false, live: null, status: 'unknown',
    reason: 'Cloudflare deployment telemetry unavailable',
    deployedAt: null, version: null, headHash, headTime: headSec,
    deployableHash: deployableHash || null, deployableTime: deployableSec,
    opsOnly, changedSinceDeployable, build: null, error: null, checkedAt: Date.now(),
  };
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${c.accountId}/workers/scripts/${worker}/versions`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(12000) });
    const j = await r.json();
    if (!j || j.success !== true) {
      out.error = (j && j.errors && j.errors[0] && j.errors[0].message) || `HTTP ${r.status}`;
      out.reason = `Cloudflare check failed: ${out.error}`;
      return out;
    }
    const item = j.result && j.result.items && j.result.items[0];
    if (!item) { out.error = 'no versions'; out.reason = 'No live Worker version found'; return out; }
    out.version = item.number ?? (item.id ? item.id.slice(0, 8) : null);
    out.deployedAt = isoToEpoch(item.metadata && item.metadata.created_on);
    out.ok = out.deployedAt != null && headSec != null;
    const build = cloudflarebuilds._state().builds.find(row =>
      row.worker === worker || row.repo === slug || row.repo === slug.replace(/\.com$/, '')
    );
    if (build) {
      out.build = {
        commitHash: build.commitHash || null,
        outcome: build.outcome || null,
        status: build.status || null,
        createdOn: build.createdOn || null,
        commitMessage: build.commitMessage || null,
      };
    }
    if (!out.ok || !deployableSec) {
      out.reason = 'Insufficient commit or deployment timestamps';
      return out;
    }
    out.live = out.deployedAt >= deployableSec - 120;
    if (out.live) {
      out.status = opsOnly ? 'ops-only' : 'live';
      out.reason = opsOnly
        ? 'Only ops changes are newer; production is unaffected'
        : 'Latest deployable site commit is live';
    } else if (
      out.build && out.build.commitHash === deployableHash &&
      out.build.outcome && out.build.outcome !== 'success'
    ) {
      out.status = 'failed';
      out.reason = `Cloudflare build ${out.build.outcome}`;
    } else if (Date.now() / 1000 - deployableSec <= PENDING_GRACE) {
      out.status = 'deploying';
      out.reason = 'Deployable site commit was pushed recently and is not live yet';
    } else {
      out.status = 'behind';
      out.reason = 'A deployable site commit is not live';
    }
  } catch (e) {
    out.error = e.name === 'TimeoutError' ? 'timeout' : (e.message || 'fetch failed');
    out.reason = `Cloudflare check failed: ${out.error}`;
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
