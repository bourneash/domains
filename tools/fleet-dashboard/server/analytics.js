'use strict';

const API = process.env.DATAHUB_API || 'http://host.docker.internal:4760';

async function _get(pathname, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${API}${pathname}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`hub ${pathname} → HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function health() {
  const r = await _get('/metrics/health');
  return r.ok === false ? { ...r, sites: {} } : r;
}

async function summary(site, window = 28) {
  const r = await _get(`/metrics/summary?site=${encodeURIComponent(site)}&window=${encodeURIComponent(window)}`);
  return r.ok === false ? { ...r, has_data: false } : r;
}

async function topGa4(site, metric, window = 28, limit = 10) {
  const qs = `site=${encodeURIComponent(site)}&source=ga4&metric=${encodeURIComponent(metric)}&window=${encodeURIComponent(window)}&limit=${encodeURIComponent(limit)}`;
  const r = await _get(`/metrics/top?${qs}`);
  return r.ok === false ? { ...r, top: [] } : r;
}

async function topGsc(site, metric, window = 28, limit = 10) {
  const qs = `site=${encodeURIComponent(site)}&source=gsc&metric=${encodeURIComponent(metric)}&window=${encodeURIComponent(window)}&limit=${encodeURIComponent(limit)}`;
  const r = await _get(`/metrics/top?${qs}`);
  return r.ok === false ? { ...r, top: [] } : r;
}

async function _series(site, kind, days) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const r = await _get(`/metrics/${kind}?site=${encodeURIComponent(site)}&grain=site&since=${since}&limit=${days + 2}`);
  return r.ok === false ? { ...r, records: [] } : r;
}
async function ga4Series(site, days = 14) { return _series(site, 'ga4', days); }
async function gscSeries(site, days = 14) { return _series(site, 'gsc', days); }

// Split the trailing rows (assumed to already be a ~14-day window) into the
// most-recent 7-row bucket ("cur") and the 7 before it ("prev"), sorted
// ascending by date first. Rows past the trailing 14 are dropped rather than
// silently included in "prev" — callers control the window via the `days`
// argument passed to *Series above.
function _splitWeeks(records) {
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));
  const last14 = sorted.slice(-14);
  const cur = last14.slice(-7);
  const prev = last14.slice(0, Math.max(0, last14.length - 7));
  return { cur, prev };
}

function _sum(rows, keys) {
  const out = {};
  for (const k of keys) out[k] = rows.reduce((s, r) => s + (r[k] || 0), 0);
  return out;
}

const GA4_WOW_KEYS = ['sessions', 'users', 'new_users', 'views', 'conversions'];
const GSC_WOW_KEYS = ['clicks', 'impressions'];

// Week-over-week deltas for one site, computed from raw daily rows (not two
// overlapping /metrics/summary calls) so the two 7-day buckets never double-
// count a day. Absence is not zero: a source key is omitted entirely when
// that source returned zero rows for the trailing window, matching
// /metrics/summary's contract.
async function wow(site) {
  const [ga4, gsc] = await Promise.all([ga4Series(site, 14), gscSeries(site, 14)]);
  const out = { site };
  if (ga4.records && ga4.records.length) {
    const { cur, prev } = _splitWeeks(ga4.records);
    out.ga4 = { cur: _sum(cur, GA4_WOW_KEYS), prev: _sum(prev, GA4_WOW_KEYS) };
  }
  if (gsc.records && gsc.records.length) {
    const { cur, prev } = _splitWeeks(gsc.records);
    out.gsc = { cur: _sum(cur, GSC_WOW_KEYS), prev: _sum(prev, GSC_WOW_KEYS) };
  }
  return out;
}

module.exports = {
  health, summary, topGa4, topGsc, ga4Series, gscSeries, wow,
  _splitWeeks, _sum, API,
};
