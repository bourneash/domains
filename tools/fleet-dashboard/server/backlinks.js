'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const audit = require('../../backlink-audit/audit');
const tasks = require('./tasks');

function snapshotPath(root) {
  return path.join(root, 'tools', 'fleet-dashboard', 'data', 'backlinks-latest.json');
}

function readSnapshot(root) {
  try {
    const value = JSON.parse(fs.readFileSync(snapshotPath(root), 'utf8'));
    if (value && value.schemaVersion === 1 && Array.isArray(value.sites)) return value;
  } catch {
    /* live rebuild below */
  }
  return audit.buildSnapshot(root);
}

function detail(root, site) {
  const snapshot = readSnapshot(root);
  const row = snapshot.sites.find(item => item.site === site);
  return row ? { generatedAt: snapshot.generatedAt, ...row } : null;
}

function taskCollections(root, site) {
  const board = tasks.list(root, site);
  return Object.values(board).flat();
}

// Queue a baseline task for every site that does not yet have a quantified,
// current capture. This is deliberately idempotent and never turns missing
// data into a zero-valued backlink result.
function createBaselineTasks(root) {
  const snapshot = readSnapshot(root);
  const created = [];
  const existing = [];
  for (const record of snapshot.sites || []) {
    if (record.status === 'current') continue;
    const duplicate = taskCollections(root, record.site).find(
      task => task.source === 'backlink-baseline' && task.source_id === record.site
    );
    if (duplicate) {
      existing.push({ site: record.site, file: duplicate.file, column: duplicate.column });
      continue;
    }
    const priority = record.priority === 'high' ? 1 : record.priority === 'medium' ? 2 : 3;
    const file = tasks.create(root, record.site, 'backlog', {
      task_id: crypto.randomUUID(),
      title: `Establish quantified backlink baseline for ${record.site}`,
      priority,
      type: 'seo',
      estimated_turns: 2,
      assigned_role: 'seo-analyst',
      source: 'backlink-baseline',
      source_id: record.site,
      correlation_id: `backlink-baseline:${record.site}`,
      body:
        `## Current status\n\n${record.label}: ${record.recommendation}\n\n` +
        `## Acceptance criteria\n\n` +
        `Run the strongest available legitimate source (Bing Webmaster, Moz, Ahrefs, or DataForSEO). ` +
        `Record the provider, capture date, referring-domain count, backlink count, anchor/target samples, ` +
        'and any legacy URLs worth reclaiming in `ops/seo/backlinks-YYYY-MM-DD.md`. ' +
        `If no provider is available, document the exact blocker and leave counts unmeasured; do not infer zero. ` +
        `That documented no-provider path satisfies this task; do not leave it blocked or escalate merely because provider access is unavailable.\n`,
    });
    created.push({ site: record.site, file });
  }
  return {
    ok: true,
    generatedAt: snapshot.generatedAt,
    eligible: (snapshot.sites || []).filter(record => record.status !== 'current').length,
    created,
    existing,
    createdCount: created.length,
    existingCount: existing.length,
  };
}

module.exports = { createBaselineTasks, detail, readSnapshot, snapshotPath };
