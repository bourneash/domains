'use strict';
// Proxy for tools/product-feed's API — same degrade-to-{ok:false} shape as
// server/datahub.js, never throws so the dashboard route never 500s just
// because the hub container is down.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const API = process.env.PRODUCTFEED_API || 'http://host.docker.internal:4761';
const ROOT = process.env.FD_DOMAINS_ROOT || `${process.env.HOME || '/home/jesse'}/projects/domains`;
const REG = path.join(ROOT, 'tools', 'product-feed', 'registry');

async function _get(pathname, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${API}${pathname}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`product-feed ${pathname} → HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function health() { return _get('/health'); }
async function stats() { return _get('/stats'); }

function subscriptions() {
  try {
    const doc = yaml.load(fs.readFileSync(path.join(REG, 'subscriptions.yaml'), 'utf8')) || {};
    return doc;
  } catch (e) {
    return {};
  }
}

// One row per registered subscription with its live depth — the dashboard's
// core view. Depth calls hit the hub per site (small N, registry-sized) so
// a single hub-down blip degrades every row the same way rather than
// failing the whole page.
async function subscriptionsWithDepth() {
  const subs = subscriptions();
  const sites = Object.keys(subs);
  const rows = await Promise.all(sites.map(async (site) => {
    const depth = await _get(`/subscriptions/${encodeURIComponent(site)}/depth`);
    return {
      site,
      tags_any: subs[site]?.tags_any || [],
      site_origin_allow: subs[site]?.site_origin_allow || null,
      max_queue_depth: subs[site]?.max_queue_depth ?? null,
      depth: depth.ok === false ? null : depth.depth,
      error: depth.ok === false ? depth.error : null,
    };
  }));
  return rows;
}

async function recentCandidates(limit = 30) {
  const r = await _get(`/candidates?limit=${encodeURIComponent(limit)}`);
  return r.ok === false ? { ...r, items: [] } : r;
}

module.exports = { health, stats, subscriptionsWithDepth, recentCandidates };
