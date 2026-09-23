'use strict';

// Durable, read-only executive telemetry snapshots. The live intelligence
// adapter remains available for dashboard requests; snapshots let scheduled
// executive roles read a consistent, recent evidence bundle without creating a
// proposal or waiting for an owner decision.

const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_SCHEMA = 'executive-intelligence-snapshot/v1';
const DEFAULT_MAX_AGE_MS = 7 * 60 * 60 * 1000;

function hasUnavailableCriticalSource(intelligence) {
  // An unavailable analytics adapter is not the same thing as zero traffic or
  // incomplete coverage. Keep the degraded artifact for audit, but never let
  // it replace the last usable bundle consumed by executive roles.
  return intelligence?.sources?.analytics?.ok === false;
}

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
  const degraded = hasUnavailableCriticalSource(intelligence);
  const dated = path.join(
    dir,
    `snapshot-${generatedAt.replace(/[^0-9TZ.-]/g, '-')}${degraded ? '.degraded' : ''}.json`
  );
  const latest = latestPath(root);
  const files = degraded ? [dated] : [dated, latest];
  for (const file of files) {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  return { ...snapshot, file: degraded ? dated : latest, degraded, latest_updated: !degraded };
}

function readLatest(
  root,
  {
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    sites = [],
    allowStale = false,
    staleMaxAgeMs = 24 * 60 * 60 * 1000,
  } = {}
) {
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(latestPath(root), 'utf8'));
  } catch {
    return null;
  }
  if (snapshot?.schema !== SNAPSHOT_SCHEMA || !snapshot.intelligence) return null;
  if (hasUnavailableCriticalSource(snapshot.intelligence)) return null;
  const generatedAt = Date.parse(snapshot.generated_at || '');
  const ageMs = Number.isFinite(generatedAt) ? Math.max(0, Date.now() - generatedAt) : Infinity;
  if (!Number.isFinite(generatedAt) || (ageMs > maxAgeMs && (!allowStale || ageMs > staleMaxAgeMs)))
    return null;
  const managed = new Set(snapshot.scope?.managed_sites || []);
  if (sites.some(site => !managed.has(site))) return null;
  return {
    ...snapshot,
    freshness: {
      stale: ageMs > maxAgeMs,
      age_ms: ageMs,
      max_age_ms: maxAgeMs,
    },
  };
}

module.exports = {
  SNAPSHOT_SCHEMA,
  DEFAULT_MAX_AGE_MS,
  hasUnavailableCriticalSource,
  snapshotDir,
  latestPath,
  write,
  readLatest,
};
