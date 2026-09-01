'use strict';

// Domain renewal facts — served from tools/registrar's cache.
//
// The collector (tools/registrar/collect_registrar.py) owns the Cloudflare
// call and runs on a schedule; this module only reads what it wrote. Same
// division of labour as aiinventory/lintfleet: the panel must not depend on a
// third-party API being reachable to render a tab, and the API must not be hit
// once per page view.
//
// Renewals are the portfolio's largest recurring hard cost and nothing in the
// project tracked them before. Two things here are worth more than the dates:
//   * auto_renew — an expiry 40 days out is routine if it renews itself and an
//     emergency if it does not. The flag, not the date, is the signal.
//   * the retrieved-vs-claimed gap — Cloudflare reports more domains on the
//     account than its list endpoint will return. A renewal we cannot see is
//     exactly the one that bites, so that gap is surfaced rather than hidden.

const fs = require('node:fs');
const path = require('node:path');

const CACHE_TTL_MS = 60 * 1000; // the file changes at most daily; this just avoids re-reading per request
const _cache = new Map(); // root -> { at, data, mtime }

function cachePath(root) {
  return path.join(root, 'tools', 'registrar', 'cache', 'latest.json');
}

// How stale is too stale to trust. The collector runs daily; if it has not
// written in three days something is broken and the panel should say so rather
// than presenting old dates as current.
const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

function read(root) {
  const p = cachePath(root);
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      error: 'no registrar cache yet — run tools/registrar/collect_registrar.py',
      domains: [],
      totals: {},
    };
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { ok: false, error: `unreadable cache: ${e.message}`, domains: [], totals: {} };
  }
  const st = fs.statSync(p);
  const ageMs = Date.now() - st.mtimeMs;
  return {
    ok: true,
    collected_at: doc.at || null,
    age_ms: ageMs,
    stale: ageMs > STALE_AFTER_MS,
    totals: doc.totals || {},
    domains: doc.domains || [],
    not_at_cloudflare: doc.not_at_cloudflare || [],
  };
}

function all(root, { fresh = false } = {}) {
  const hit = _cache.get(root);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const data = read(root);
  _cache.set(root, { at: Date.now(), data });
  return data;
}

// domain -> { expires_at, days_to_renewal, auto_renew } for the callers that
// want to decorate their own rows (the parked-inventory panel does this so its
// "Renewal" column stops reading "unknown" for all 23 scaffolds).
function byDomain(root) {
  const d = all(root);
  const out = {};
  if (!d.ok) return out;
  for (const r of d.domains) {
    out[r.domain] = {
      expires_at: r.expires_at,
      days_to_renewal: r.days_to_renewal,
      auto_renew: r.auto_renew,
      attention: r.attention,
    };
  }
  return out;
}

module.exports = { all, byDomain, _read: read };
