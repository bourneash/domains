'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Discover every live site directory under sites/. Matches the convention the
// Python audit and cron-manager use: a directory that is not hidden and not a
// DISABLED-* tombstone. We additionally require it to look like a site (has an
// ops/ dir) so stray folders never leak in.
function discoverSites(root) {
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

// Validate a slug came from discovery — the single gate every mutating route
// passes through before touching the filesystem.
function isKnownSite(root, slug) {
  return typeof slug === 'string' && discoverSites(root).includes(slug);
}

function siteDir(root, slug) {
  return path.join(root, 'sites', slug);
}

module.exports = { discoverSites, isKnownSite, siteDir };
