'use strict';

const fs = require('node:fs');
const path = require('node:path');

function read(root) {
  const file = path.join(root, 'registry', 'fleet.yaml');
  try {
    // The isolated executive image has no fleet registry or YAML package.
    // Queue eligibility still works there; only descriptive site context is absent.
    const yaml = require('js-yaml');
    const doc = yaml.load(fs.readFileSync(file, 'utf8')) || {};
    const sites = Object.entries(doc.sites || {}).map(([domain, row]) => ({
      site_id: `site:${domain}`,
      domain,
      lifecycle: row.status || 'unknown',
      visibility: row.visibility || 'public',
      description: row.description || null,
      smoke_string: row.smoke_string || null,
      tags: Array.isArray(row.tags) ? row.tags : [],
      repo: row.repo || null,
      worker: row.worker || null,
      capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
      disabled_task_roles: Array.isArray(row.disabled_task_roles) ? row.disabled_task_roles : [],
      registered_in: Array.isArray(row.registered_in) ? row.registered_in : [],
    }));
    return { ok: true, file, sites, byDomain: Object.fromEntries(sites.map(s => [s.domain, s])) };
  } catch (error) {
    return { ok: false, file, error: String(error.message || error), sites: [], byDomain: {} };
  }
}

module.exports = { read };
