'use strict';

// Social Hub panel — the fleet's only client onto tools/social-hub's HTTP API.
//
// The hub itself ships no UI of its own (see api.py) beyond the raw API — this
// panel is it. Everything a human does with the hub (review the queue, browse
// post history, manage the inbox and channels, read the event log) happens
// here so there is one control plane, not two differently-styled apps.
//
// Everything degrades: when the supervised hub container is not running the
// tab renders an explicit "hub is not reachable" state rather than hiding it.
//
// Auth: the hub binds loopback by default. To be reachable from inside this
// container it must bind off-loopback, and it refuses to do that without
// SOCIAL_HUB_TOKEN set — so the token is always present when the proxy is
// actually needed, and is forwarded as a bearer header (never a query string,
// never handed to the browser).

const API = process.env.SOCIALHUB_API || 'http://social-hub-api:4772';
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

// One round trip for the whole overview tab: per-site state, everything
// awaiting review, and 30-day engagement. Three small local calls beat making
// the browser orchestrate three proxied ones.
async function overview() {
  try {
    const [status, drafts, metrics, oversight] = await Promise.all([
      call('/api/status'),
      call('/api/posts?status=draft&limit=100'),
      call('/api/metrics?days=30&limit=5'),
      call('/api/oversight'),
    ]);
    return {
      available: true,
      sites: status.sites || {},
      drafts: drafts.posts || [],
      metrics: metrics.summary || { platforms: {} },
      top: metrics.top || [],
      insights: metrics.insights || {},
      oversight,
      generatedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      available: false,
      error: e.message,
      hint: e.unreachable
        ? 'Start it with `docker compose -f tools/social-hub/docker-compose.yml up -d` and inspect social-hub-api health.'
        : 'The hub responded but rejected the request — check SOCIAL_HUB_TOKEN matches on both sides.',
    };
  }
}

function qs(params) {
  const parts = Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

async function listPosts(params) {
  return call(`/api/posts${qs(params)}`);
}

async function createPost(payload) {
  const body = {
    site: String(payload.site || '').trim(),
    platform: String(payload.platform || '').trim(),
    body: String(payload.body || '').slice(0, 4000),
    link: String(payload.link || '').slice(0, 2000),
    schedule: payload.schedule === true,
    author: 'fleet-dashboard',
  };
  if (!body.site || !body.platform) {
    const err = new Error('site and platform are required');
    err.httpStatus = 400;
    throw err;
  }
  const post = await call('/api/posts', { method: 'POST', body });
  if (payload.scheduled_at) return patchPost(post.id, { scheduled_at: String(payload.scheduled_at) });
  return post;
}

async function calendar(site, days) {
  // The hub owns the scheduling rules and its /api/calendar endpoint is the
  // authoritative upcoming-post view. Keep the browser away from that service
  // (and its bearer token) by proxying it through the dashboard like every
  // other Social Hub surface. Bound the horizon so a typo cannot ask the hub
  // for an unhelpfully large result set.
  const horizon = Math.min(31, Math.max(1, Number(days) || 7));
  return call(`/api/calendar${qs({ site, days: horizon })}`);
}

async function approve(id) {
  // Attribution is an audit fact: an approval made from this panel says so,
  // and never carries a person's name it cannot verify.
  return call(`/api/posts/${id}/approve`, { method: 'POST', body: { by: 'fleet-dashboard' } });
}

async function reject(id, reason, category = 'other') {
  return call(`/api/posts/${id}/reject`, {
    method: 'POST',
    body: { by: 'fleet-dashboard', reason: String(reason || '').slice(0, 300), category },
  });
}

async function patchPost(id, payload) {
  const body = { editor: 'fleet-dashboard' };
  if (payload.body !== undefined) body.body = String(payload.body).slice(0, 4000);
  if (payload.link !== undefined) body.link = String(payload.link).slice(0, 2000);
  if (payload.scheduled_at !== undefined) body.scheduled_at = payload.scheduled_at;
  return call(`/api/posts/${id}`, { method: 'PATCH', body });
}

async function publishNow(id) {
  return call(`/api/posts/${id}/publish`, { method: 'POST', timeout: TICK_TIMEOUT_MS });
}

async function cancelPost(id) {
  return call(`/api/posts/${id}/cancel`, { method: 'POST' });
}

async function channels(site) {
  return call(`/api/channels${qs({ site })}`);
}

async function patchChannel(id, payload) {
  const body = {};
  if (payload.enabled !== undefined) body.enabled = !!payload.enabled;
  return call(`/api/channels/${id}`, { method: 'PATCH', body });
}

async function verifyChannel(id) {
  return call(`/api/channels/${id}/verify`, { method: 'POST', timeout: TICK_TIMEOUT_MS });
}

async function inbox(site, status) {
  return call(`/api/inbox${qs({ site, status })}`);
}

async function draftReply(id) {
  return call(`/api/inbox/${id}/draft`, { method: 'POST', timeout: TICK_TIMEOUT_MS });
}

async function mentionStatus(id, status) {
  return call(`/api/inbox/${id}/status`, { method: 'POST', body: { status } });
}

async function events(site, limit) {
  return call(`/api/events${qs({ site, limit })}`);
}

async function tick(site) {
  return call('/api/tick', {
    method: 'POST',
    body: { site: site || null, publish: true },
    timeout: TICK_TIMEOUT_MS,
  });
}

async function setController(enabled) {
  return call('/api/oversight/controller', { method: 'POST', body: { enabled: !!enabled } });
}

async function reviewProposal(id, state) {
  return call(`/api/learning-proposals/${id}/review`, {
    method: 'POST', body: { state, actor: 'fleet-dashboard' },
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

  app.get(
    '/api/socialhub/posts',
    forward(req =>
      listPosts({
        site: req.query.site,
        platform: req.query.platform,
        kind: req.query.kind,
        status: req.query.status,
        limit: req.query.limit || 100,
      })
    )
  );
  app.post('/api/socialhub/posts', forward(req => createPost(req.body || {})));
  app.get(
    '/api/socialhub/calendar',
    forward(req => calendar(req.query.site, req.query.days))
  );
  app.post(
    '/api/socialhub/posts/:id/approve',
    forward(req => approve(Number(req.params.id)))
  );
  app.post(
    '/api/socialhub/posts/:id/reject',
    forward(req => reject(Number(req.params.id), req.body && req.body.reason, req.body && req.body.category))
  );
  app.patch(
    '/api/socialhub/posts/:id',
    forward(req => patchPost(Number(req.params.id), req.body || {}))
  );
  app.post(
    '/api/socialhub/posts/:id/publish',
    forward(req => publishNow(Number(req.params.id)))
  );
  app.post(
    '/api/socialhub/posts/:id/cancel',
    forward(req => cancelPost(Number(req.params.id)))
  );
  app.get(
    '/api/socialhub/channels',
    forward(req => channels(req.query.site))
  );
  app.patch(
    '/api/socialhub/channels/:id',
    forward(req => patchChannel(Number(req.params.id), req.body || {}))
  );
  app.post(
    '/api/socialhub/channels/:id/verify',
    forward(req => verifyChannel(Number(req.params.id)))
  );
  app.get(
    '/api/socialhub/inbox',
    forward(req => inbox(req.query.site, req.query.status))
  );
  app.post(
    '/api/socialhub/inbox/:id/draft',
    forward(req => draftReply(Number(req.params.id)))
  );
  app.post(
    '/api/socialhub/inbox/:id/status',
    forward(req => mentionStatus(Number(req.params.id), req.body && req.body.status))
  );
  app.get(
    '/api/socialhub/events',
    forward(req => events(req.query.site, req.query.limit || 150))
  );
  app.post(
    '/api/socialhub/tick',
    forward(req => tick(req.body && req.body.site))
  );
  app.post(
    '/api/socialhub/controller',
    forward(req => setController(req.body && req.body.enabled))
  );
  app.post(
    '/api/socialhub/learning/:id/review',
    forward(req => reviewProposal(Number(req.params.id), req.body && req.body.state))
  );
}

module.exports = {
  overview,
  listPosts,
  calendar,
  createPost,
  approve,
  reject,
  patchPost,
  publishNow,
  cancelPost,
  channels,
  patchChannel,
  verifyChannel,
  inbox,
  draftReply,
  mentionStatus,
  events,
  tick,
  setController,
  reviewProposal,
  registerRoutes,
};
