'use strict';

// Site health/uptime poller — reads tools/fleet-gatus's REST API (Gatus,
// see tools/fleet-gatus/README.md) and caches a rolled-up per-site verdict
// in memory for the Health tab. Same shape as deployhealth.js: a background
// timer owns the actual HTTP call, the route just serves the last sweep.
//
// Gatus itself already has a dashboard (http://127.0.0.1:8580) — this module
// exists so that data can be re-rendered inside this panel's own look
// instead of pointing people at a second, differently-styled UI.
//
// Fleet-wide (2026-08-20): every site with an ops/smoke.yaml is auto-discovered
// by tools/fleet-gatus/scripts/generate_config.py — a site is only absent from
// the response if it has no smoke.yaml, or `enabled: false` in it.

const POLL_MS = 60 * 1000; // Gatus itself checks every 5m; poll its cache often, it's a local call
const STALE_AFTER = 10 * 60 * 1000; // ms: ignore the cache if the poller stopped updating
const FETCH_TIMEOUT_MS = 8000;

// Container-network address (see tools/fleet-gatus/docker-compose.yml — joins
// the same shared vpn_proxy network as this panel). Override with GATUS_API
// for local/non-docker dev (e.g. http://127.0.0.1:8580).
const GATUS_API = process.env.GATUS_API || 'http://fleet-gatus:8080';

let CACHE = { sites: {}, order: [] };
let lastSweep = 0;
let lastError = null;

function rollUp(raw) {
  const sites = {};
  const order = [];
  for (const ep of raw) {
    const group = ep.group || '(ungrouped)';
    if (!sites[group]) {
      sites[group] = { total: 0, passing: 0, failing: 0, checks: [] };
      order.push(group);
    }
    const s = sites[group];
    const results = ep.results || [];
    const latest = results[results.length - 1] || null;
    const success = latest ? !!latest.success : false;
    const uptimeWindow = results.length
      ? results.filter(r => r.success).length / results.length
      : null;
    s.total += 1;
    if (success) s.passing += 1;
    else s.failing += 1;
    s.checks.push({
      name: ep.name,
      success,
      statusCode: latest ? latest.status : null,
      lastCheckedAt: latest ? latest.timestamp : null,
      durationMs: latest && latest.duration ? Math.round(latest.duration / 1e6) : null,
      uptime: uptimeWindow, // fraction over Gatus's cached result window (up to 200 runs)
      errors:
        latest && latest.conditionResults
          ? latest.conditionResults.filter(c => !c.success).map(c => c.condition)
          : [],
    });
  }
  order.sort((a, b) => a.localeCompare(b));
  for (const g of order)
    sites[g].checks.sort((a, b) => (a.success === b.success ? 0 : a.success ? 1 : -1));
  return { sites, order };
}

async function sweep() {
  try {
    const r = await fetch(`${GATUS_API}/api/v1/endpoints/statuses`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.json();
    const { sites, order } = rollUp(Array.isArray(raw) ? raw : []);
    CACHE = { sites, order };
    lastSweep = Date.now();
    lastError = null;
  } catch (e) {
    // Leave CACHE as-is (stale-but-shown beats blank) — surface the error so
    // the tab can say "Gatus unreachable" instead of silently going quiet.
    lastError = e.name === 'TimeoutError' ? 'timeout reaching Gatus' : e.message || 'fetch failed';
  }
}

function start() {
  const tick = () => {
    sweep();
  };
  tick();
  const t = setInterval(tick, POLL_MS);
  if (t.unref) t.unref();
}

function all() {
  const stale = !lastSweep || Date.now() - lastSweep > STALE_AFTER;
  return { lastSweep, stale, error: lastError, sites: CACHE.sites, order: CACHE.order };
}

module.exports = { start, all };
