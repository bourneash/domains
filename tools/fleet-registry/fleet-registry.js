'use strict';

// Read-only loader for registry/fleet.yaml — the canonical fleet site list.
//
// Node twin of fleet_registry.py. Consumers (fleet-dashboard, post-notify,
// content-guardrails) ask this who exists instead of keeping their own roster;
// tool-specific settings stay in the tool's config keyed by domain.
//
//   const reg = require('../fleet-registry/fleet-registry');
//   reg.sites(root, { status: 'live' })
//   reg.withCapability(root, 'cron')
//   reg.get(root, 'totaljerks.com')
//
// Mirrors sites.js's short-TTL memoization so hot routes don't re-parse YAML.

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const TTL_MS = 5000;
const _cache = new Map(); // path -> { at, sites }

function registryPath(root) {
  if (process.env.FLEET_REGISTRY) return process.env.FLEET_REGISTRY;
  return path.join(root || path.resolve(__dirname, '..', '..'), 'registry', 'fleet.yaml');
}

function load(root, { fresh = false } = {}) {
  const file = registryPath(root);
  const hit = _cache.get(file);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.sites;
  let sites = {};
  try {
    sites = (yaml.load(fs.readFileSync(file, 'utf8')) || {}).sites || {};
  } catch {
    sites = {};
  }
  _cache.set(file, { at: Date.now(), sites });
  return sites;
}

function sites(root, { status = null, fresh = false } = {}) {
  const entries = load(root, { fresh });
  return Object.keys(entries)
    .filter(d => status === null || entries[d].status === status)
    .sort();
}

function get(root, domain) {
  return load(root)[domain] || null;
}

function withCapability(root, capability) {
  const entries = load(root);
  return Object.keys(entries)
    .filter(d =>
      (entries[d].capabilities_override || entries[d].capabilities || []).includes(capability)
    )
    .sort();
}

module.exports = { load, sites, get, withCapability, registryPath };
