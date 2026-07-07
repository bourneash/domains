'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Short-TTL memoization (B11): several routes call discoverSites() multiple
// times per request (requireSite gate, then the handler), and it does O(sites)
// readdir+statSync each call. A 5s cache collapses that to one disk scan per
// burst while still picking up new/removed sites within a few seconds.
const DISCOVERY_TTL_MS = 5000;
const _cache = new Map();   // root -> { at, sites }

function _scanSites(root) {
  const dir = path.join(root, 'sites');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory()
      && !d.name.startsWith('.')
      && !d.name.startsWith('DISABLED-')
      && fs.existsSync(path.join(dir, d.name, 'ops')))
    .map((d) => d.name)
    .sort();
}

// Discover every live site directory under sites/. Matches the convention the
// Python audit and cron-manager use: a directory that is not hidden and not a
// DISABLED-* tombstone. We additionally require it to look like a site (has an
// ops/ dir) so stray folders never leak in. Result is memoized per root for a
// few seconds (see DISCOVERY_TTL_MS).
function discoverSites(root, { fresh = false } = {}) {
  const hit = _cache.get(root);
  if (!fresh && hit && (Date.now() - hit.at) < DISCOVERY_TTL_MS) return hit.sites;
  const sites = _scanSites(root);
  _cache.set(root, { at: Date.now(), sites });
  return sites;
}

// Validate a slug came from discovery — the single gate every mutating route
// passes through before touching the filesystem.
function isKnownSite(root, slug) {
  return typeof slug === 'string' && discoverSites(root).includes(slug);
}

function siteDir(root, slug) {
  return path.join(root, 'sites', slug);
}

module.exports = { discoverSites, isKnownSite, siteDir };
