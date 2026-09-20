'use strict';

// Fleet Scheduler control plane — thin authenticated proxy to tools/fleet-scheduler.
//
// The scheduler owns all state (SQLite, single writer); the dashboard never touches
// its DB. This module only forwards a fixed allowlist of method+path pairs so the
// dashboard's own auth/actionlog/viewer-vs-admin gating applies, and the scheduler's
// bearer token never reaches the browser.

const fs = require('node:fs');

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

function makeClient(env = process.env, fetchImpl = globalThis.fetch) {
  const base = (env.FLEET_SCHEDULER_URL || 'http://fleet-scheduler:4790').replace(/\/+$/, '');
  const tokenFile = env.FLEET_SCHEDULER_TOKEN_FILE || '';
  let cached = { mtime: 0, value: '' };
  function token() {
    if (env.FLEET_SCHEDULER_TOKEN) return env.FLEET_SCHEDULER_TOKEN;
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
      const e = new Error('scheduler token not configured (FLEET_SCHEDULER_TOKEN_FILE)');
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
  const call = opts.call || makeClient();
  app.all(/^\/api\/scheduler\/(.+)$/, async (req, res) => {
    const path = req.params[0].replace(/\/+$/, '');
    const allowed = ROUTES.some(([m, re]) => m === req.method && re.test(path));
    if (!allowed) return res.status(404).json({ error: 'not found' });
    const actor = (req.user && (req.user.name || req.user.role)) || 'fleet-dashboard';
    try {
      const { status, data } = await call(req.method, path, req.query, req.body, String(actor));
      res.status(status).json(data);
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });
}

module.exports = { register, makeClient, ROUTES };
