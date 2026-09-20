'use strict';

// Fleet Scheduler control plane — thin authenticated proxy to tools/fleet-scheduler.
//
// The scheduler owns all state (SQLite, single writer); the dashboard never touches
// its DB. This module only forwards a fixed allowlist of method+path pairs so the
// dashboard's own auth/actionlog/viewer-vs-admin gating applies, and the scheduler's
// bearer token never reaches the browser.

const fs = require('node:fs');
const path = require('node:path');

const ROUTES = [
  ['GET', /^status$/],
  ['GET', /^jobs$/],
  ['POST', /^jobs$/],
  ['PATCH', /^jobs\/\d+$/],
  ['DELETE', /^jobs\/\d+$/],
  ['POST', /^jobs\/\d+\/run$/],
  ['GET', /^runs$/],
  ['GET', /^runs\/\d+$/],
  ['POST', /^runs\/\d+\/cancel$/],
  ['GET', /^settings$/],
  ['PATCH', /^settings$/],
  ['POST', /^sites\/[A-Za-z0-9][A-Za-z0-9.-]*\/(adopt|release)$/],
  ['GET', /^audit$/],
];
const TIMEOUT_MS = 12000;

// One client per scheduler instance. Defaults describe the sites scheduler; the fleet-tools
// instance (tools/fleet-cron, port 4791) passes its own env keys.
const INSTANCES = {
  scheduler: {
    urlKey: 'FLEET_SCHEDULER_URL',
    tokenKey: 'FLEET_SCHEDULER_TOKEN',
    tokenFileKey: 'FLEET_SCHEDULER_TOKEN_FILE',
    defaultUrl: 'http://fleet-scheduler:4790',
  },
  'scheduler-fleet': {
    urlKey: 'FLEET_CRON_SCHEDULER_URL',
    tokenKey: 'FLEET_CRON_SCHEDULER_TOKEN',
    tokenFileKey: 'FLEET_CRON_SCHEDULER_TOKEN_FILE',
    defaultUrl: 'http://fleet-cron:4791',
  },
};

function makeClient(env = process.env, fetchImpl = globalThis.fetch, inst = INSTANCES.scheduler) {
  const base = (env[inst.urlKey] || inst.defaultUrl).replace(/\/+$/, '');
  const tokenFile = env[inst.tokenFileKey] || '';
  let cached = { mtime: 0, value: '' };
  function token() {
    if (env[inst.tokenKey]) return env[inst.tokenKey];
    if (!tokenFile) return '';
    try {
      const st = fs.statSync(tokenFile);
      if (st.mtimeMs !== cached.mtime)
        cached = { mtime: st.mtimeMs, value: fs.readFileSync(tokenFile, 'utf8').trim() };
      return cached.value;
    } catch {
      return '';
    }
  }
  return async function call(method, path, query, body, actor) {
    const tok = token();
    if (!tok) {
      const e = new Error(`scheduler token not configured (${inst.tokenFileKey})`);
      e.status = 503;
      throw e;
    }
    const qs =
      query && Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : '';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetchImpl(`${base}/api/${path}${qs}`, {
        method,
        headers: {
          authorization: `Bearer ${tok}`,
          'content-type': 'application/json',
          'x-actor': actor || 'fleet-dashboard',
        },
        body:
          body !== undefined && method !== 'GET' && method !== 'DELETE'
            ? JSON.stringify(body)
            : undefined,
        signal: ctl.signal,
      });
      const txt = await r.text();
      let data;
      try {
        data = txt ? JSON.parse(txt) : null;
      } catch {
        data = { error: 'scheduler returned non-JSON' };
      }
      return { status: r.status, data };
    } catch (err) {
      const e = new Error(
        err.name === 'AbortError' ? 'scheduler timed out' : `scheduler unreachable: ${err.message}`
      );
      e.status = 502;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
}

function register(app, opts = {}) {
  const calls = {
    scheduler: opts.call || makeClient(process.env, globalThis.fetch, INSTANCES.scheduler),
    'scheduler-fleet':
      opts.callFleet ||
      opts.call ||
      makeClient(process.env, globalThis.fetch, INSTANCES['scheduler-fleet']),
  };
  app.all(/^\/api\/(scheduler|scheduler-fleet)\/(.+)$/, async (req, res) => {
    const which = req.params[0];
    const path = req.params[1].replace(/\/+$/, '');
    let allowed = ROUTES.some(([m, re]) => m === req.method && re.test(path));
    // The fleet-tools instance has one implicit always-live group; adopt/release is meaningless
    // there and "release" would silence every fleet job — not exposed.
    if (which === 'scheduler-fleet' && path.startsWith('sites/')) allowed = false;
    if (!allowed) return res.status(404).json({ error: 'not found' });
    const actor = (req.user && (req.user.name || req.user.role)) || 'fleet-dashboard';
    try {
      const { status, data } = await calls[which](
        req.method,
        path,
        req.query,
        req.body,
        String(actor)
      );
      res.status(status).json(data);
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });
}

// A site is "adopted" when the scheduler owns its jobs (marker maintained by the scheduler in its
// data dir, visible here through the repo bind mount). Adopted sites have NO per-site cron
// container, so anything that execs into / rebuilds one must go through the scheduler instead.
function isAdopted(root, site) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(String(site || ''))) return false;
  return fs.existsSync(path.join(root, 'tools', 'fleet-scheduler', 'data', 'adopted', site));
}

// Run-now for an adopted site: same job the schedule fires, executed by the scheduler.
async function runNow(site, role, actor, call = makeClient()) {
  const list = await call('GET', 'jobs', { site }, undefined, actor);
  const job = Array.isArray(list.data) && list.data.find(j => j.name === role);
  if (!job) {
    const e = new Error(`no scheduler job "${role}" for ${site}`);
    e.httpStatus = 404;
    throw e;
  }
  const r = await call('POST', `jobs/${job.id}/run`, {}, {}, actor);
  if (r.status !== 200) {
    const e = new Error((r.data && r.data.error) || `scheduler returned ${r.status}`);
    e.httpStatus = r.status === 409 ? 409 : 502;
    throw e;
  }
  return `fleet-scheduler (run #${r.data.run_id})`;
}

const ADOPTED_MSG =
  'this site is managed by the fleet-scheduler — use Ops ▸ Scheduler (a legacy cron container would double-fire every job)';

module.exports = { register, makeClient, ROUTES, INSTANCES, isAdopted, runNow, ADOPTED_MSG };
