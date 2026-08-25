'use strict';

// Social Hub panel — a thin proxy onto tools/social-hub's HTTP API.
//
// The hub is a host process with its own full UI on :4772; this module exists
// so the fleet's single control plane can answer "what is waiting for me" and
// let you approve or reject a post without opening a second, differently
// styled app. Deep work (composing, calendar, inbox threads, insights) still
// belongs in the hub's own UI, and the panel links out to it.
//
// Everything degrades: when the hub is not running the tab renders an explicit
// "hub is not reachable" state rather than an error, because the hub being down
// is a normal condition (it is started by hand / at boot, not by this panel).
//
// Auth: the hub binds loopback by default. To be reachable from inside this
// container it must bind off-loopback, and it refuses to do that without
// SOCIAL_HUB_TOKEN set — so the token is always present when the proxy is
// actually needed, and is forwarded as a bearer header (never a query string).

const API = process.env.SOCIALHUB_API || 'http://host.docker.internal:4772';
const TOKEN = process.env.SOCIAL_HUB_TOKEN || '';
const TIMEOUT_MS = 12000;
// The hub's tick can take minutes (it drafts with an LLM); the panel's button
// only kicks it off and reports what came back, so give it real room.
const TICK_TIMEOUT_MS = 240000;

function headers() {
  return TOKEN
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }
    : { 'Content-Type': 'application/json' };
}

async function call(path, { method = 'GET', body, timeout = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
    if (!res.ok) {
      const err = new Error(
        (parsed && (parsed.detail || parsed.error)) || `hub returned ${res.status}`
      );
      err.httpStatus = res.status === 401 ? 502 : res.status;
      throw err;
    }
    return parsed;
  } catch (e) {
    if (e.httpStatus) throw e;
    const err = new Error(
      e.name === 'AbortError' ? 'social-hub did not respond in time' : e.message
    );
    err.unreachable = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// One round trip for the whole tab: per-site state, everything awaiting
// review, and 30-day engagement. Three small local calls beat making the
// browser orchestrate three proxied ones.
async function overview() {
  try {
    const [status, drafts, metrics] = await Promise.all([
      call('/api/status'),
      call('/api/posts?status=draft&limit=100'),
      call('/api/metrics?days=30&limit=5'),
    ]);
    return {
      available: true,
      url: publicUrl(),
      sites: status.sites || {},
      drafts: drafts.posts || [],
      metrics: metrics.summary || { platforms: {} },
      top: metrics.top || [],
      generatedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      available: false,
      url: publicUrl(),
      error: e.message,
      hint: e.unreachable
        ? 'Start it on the host: `social-hub serve --host 0.0.0.0` (SOCIAL_HUB_TOKEN must be set)'
        : 'The hub responded but rejected the request — check SOCIAL_HUB_TOKEN matches on both sides.',
    };
  }
}

// The browser reaches the hub directly on the host, not through this
// container's address for it.
function publicUrl() {
  return process.env.SOCIALHUB_PUBLIC_URL || 'http://127.0.0.1:4772';
}

async function approve(id) {
  // Attribution is an audit fact: an approval made from this panel says so,
  // and never carries a person's name it cannot verify.
  return call(`/api/posts/${id}/approve`, { method: 'POST', body: { by: 'fleet-dashboard' } });
}

async function reject(id, reason) {
  return call(`/api/posts/${id}/reject`, {
    method: 'POST',
    body: { by: 'fleet-dashboard', reason: String(reason || '').slice(0, 300) },
  });
}

async function edit(id, bodyText) {
  return call(`/api/posts/${id}`, {
    method: 'PATCH',
    body: { body: String(bodyText || '').slice(0, 4000), editor: 'fleet-dashboard' },
  });
}

async function tick(site) {
  return call('/api/tick', {
    method: 'POST',
    body: { site: site || null, publish: true },
    timeout: TICK_TIMEOUT_MS,
  });
}

function registerRoutes(app) {
  app.get('/api/socialhub', async (_req, res) => {
    res.json(await overview());
  });

  const forward = handler => async (req, res) => {
    try {
      res.json(await handler(req));
    } catch (e) {
      res.status(e.httpStatus || 502).json({ error: e.message });
    }
  };

  app.post(
    '/api/socialhub/posts/:id/approve',
    forward(req => approve(Number(req.params.id)))
  );
  app.post(
    '/api/socialhub/posts/:id/reject',
    forward(req => reject(Number(req.params.id), req.body && req.body.reason))
  );
  app.patch(
    '/api/socialhub/posts/:id',
    forward(req => edit(Number(req.params.id), req.body && req.body.body))
  );
  app.post(
    '/api/socialhub/tick',
    forward(req => tick(req.body && req.body.site))
  );
}

module.exports = { overview, approve, reject, edit, tick, registerRoutes, publicUrl };
