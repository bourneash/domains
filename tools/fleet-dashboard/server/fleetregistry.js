'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

function read(root) {
  const file = path.join(root, 'registry', 'fleet.yaml');
  try {
    const doc = yaml.load(fs.readFileSync(file, 'utf8')) || {};
    const sites = Object.entries(doc.sites || {}).map(([domain, row]) => ({
      site_id: `site:${domain}`,
      domain,
      lifecycle: row.status || 'unknown',
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
