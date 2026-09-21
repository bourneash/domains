'use strict';

// Durable, read-only executive telemetry snapshots. The live intelligence
// adapter remains available for dashboard requests; snapshots let scheduled
// executive roles read a consistent, recent evidence bundle without creating a
// proposal or waiting for an owner decision.

const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_SCHEMA = 'executive-intelligence-snapshot/v1';
const DEFAULT_MAX_AGE_MS = 7 * 60 * 60 * 1000;

function snapshotDir(root) {
  return path.join(root, 'tools', 'executive', 'data', 'intelligence');
}

function latestPath(root) {
  return path.join(snapshotDir(root), 'latest.json');
}

function write(root, intelligence, { now = new Date() } = {}) {
  if (!intelligence || typeof intelligence !== 'object')
    throw new Error('executive intelligence snapshot requires an object');
  const generatedAt = now.toISOString();
  const snapshot = {
    schema: SNAPSHOT_SCHEMA,
    generated_at: generatedAt,
    scope: intelligence.scope || null,
    intelligence,
  };
  const dir = snapshotDir(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dated = path.join(dir, `snapshot-${generatedAt.replace(/[^0-9TZ.-]/g, '-')}.json`);
  const latest = latestPath(root);
  for (const file of [dated, latest]) {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  return { ...snapshot, file: latest };
}

function readLatest(root, { maxAgeMs = DEFAULT_MAX_AGE_MS, sites = [] } = {}) {
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(latestPath(root), 'utf8'));
  } catch {
    return null;
  }
  if (snapshot?.schema !== SNAPSHOT_SCHEMA || !snapshot.intelligence) return null;
  const generatedAt = Date.parse(snapshot.generated_at || '');
  if (!Number.isFinite(generatedAt) || Date.now() - generatedAt > maxAgeMs) return null;
  const managed = new Set(snapshot.scope?.managed_sites || []);
  if (sites.some(site => !managed.has(site))) return null;
  return snapshot;
}

module.exports = {
  SNAPSHOT_SCHEMA,
  DEFAULT_MAX_AGE_MS,
  snapshotDir,
  latestPath,
  write,
  readLatest,
};
