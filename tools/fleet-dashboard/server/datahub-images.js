'use strict';

// Thin proxy over the data-hub-images FastAPI service (tools/data-hub-images,
// port 4770). Mirrors server/datahub.js exactly: every exported read degrades
// to { ok:false, error } (plus an empty-shaped list/object field) instead of
// throwing, so a down/unreachable service never crashes an Express route —
// the route just forwards the degraded object as 200 JSON.
const API = process.env.DATAHUB_IMAGES_API || 'http://host.docker.internal:4770';

async function _get(pathname, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${API}${pathname}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`datahub-images ${pathname} → HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function _post(pathname, body, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const opt = { method: 'POST', signal: ctrl.signal };
    if (body !== undefined) {
      opt.headers = { 'Content-Type': 'application/json' };
      opt.body = JSON.stringify(body);
    }
    const r = await fetch(`${API}${pathname}`, opt);
    if (!r.ok) throw new Error(`datahub-images ${pathname} → HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function health() { return _get('/health'); }

async function stats() {
  const r = await _get('/stats');
  return r.ok === false
    ? { ...r, pool_by_topic: {}, pool_by_source: {}, pool_by_license: {}, requests_by_status: {} }
    : r;
}

// Builds ?topic=&site=&status=&limit= in that fixed order, omitting any key
// that's undefined/null/''. No params → empty string (no leading '?').
function _imagesQs(params = {}) {
  const usp = new URLSearchParams();
  for (const k of ['topic', 'site', 'status', 'limit']) {
    const v = params[k];
    if (v !== undefined && v !== null && v !== '') usp.set(k, v);
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

async function images(params = {}) {
  const r = await _get(`/images${_imagesQs(params)}`);
  return r.ok === false ? { ...r, images: [] } : r;
}

async function sources() {
  const r = await _get('/sources');
  return r.ok === false ? { ...r, sources: [] } : r;
}

async function egress(limit = 200) {
  const r = await _get(`/egress?limit=${encodeURIComponent(limit)}`);
  return r.ok === false ? { ...r, events: [] } : r;
}

async function pulls(limit = 200) {
  const r = await _get(`/pulls?limit=${encodeURIComponent(limit)}`);
  return r.ok === false ? { ...r, pulls: [] } : r;
}

// Toggle a source's enabled/disabled override on the hub (persists in the
// hub's SQLite; takes effect on the next collect cycle).
async function setSourceEnabled(id, enabled) {
  return _post(`/sources/${encodeURIComponent(id)}/enabled`, { enabled: !!enabled });
}

async function blacklistImage(id) {
  return _post(`/images/${encodeURIComponent(id)}/blacklist`);
}

async function rejectImage(id) {
  return _post(`/images/${encodeURIComponent(id)}/reject`);
}

// Raw-bytes passthrough for GET /image/{id}. Returns the upstream
// content-type so the Express route can set it on the response, or
// { ok:false, status, error? } when the upstream 404s or is unreachable.
async function imageBytes(id, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${API}/image/${encodeURIComponent(id)}`, { signal: ctrl.signal });
    if (!r.ok) return { ok: false, status: r.status };
    const contentType = r.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await r.arrayBuffer());
    return { ok: true, status: r.status, contentType, buffer };
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  health, stats, images, sources, egress, pulls,
  setSourceEnabled, blacklistImage, rejectImage, imageBytes, API,
};
