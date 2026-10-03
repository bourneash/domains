'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const CACHE_TTL_MS = 30000;
const CACHE_MAX_ENTRIES = 32;
const reportCache = new Map();
const reportPending = new Map();

// Keep the aggregation logic in one place. The dashboard consumes the same
// JSON emitted by the CLI instead of maintaining a second JavaScript rollup.
function scriptPath(root) {
  return path.join(root, 'tools', 'ai-usage', 'aggregate.py');
}

function day(value, name) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must be YYYY-MM-DD`);
  return value;
}

function fleet(root, filters = {}) {
  const from = day(filters.from, 'from');
  const to = day(filters.to, 'to');
  if (from && to && from > to) throw new Error('from must not be after to');
  const granularity = filters.granularity || null;
  const summaryOnly = Boolean(filters.summaryOnly);
  const rolesOnly = filters.rolesOnly == null ? null : [...new Set(filters.rolesOnly)].sort();
  if (
    rolesOnly &&
    (!rolesOnly.length || rolesOnly.some(role => !/^[a-z0-9][a-z0-9-]{0,79}$/i.test(role)))
  )
    throw new Error('rolesOnly must contain valid role names');
  if (granularity && !['day', 'hour'].includes(granularity))
    throw new Error('granularity must be day or hour');
  const key = JSON.stringify([path.resolve(root), from, to, granularity, summaryOnly, rolesOnly]);
  const now = Date.now();
  const cached = reportCache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.report);
  if (cached) reportCache.delete(key);
  const existing = reportPending.get(key);
  if (existing) return existing;

  const args = [scriptPath(root), '--root', root, '--json', '--compact-json'];
  if (from) args.push('--from', from);
  if (to) args.push('--to', to);
  if (granularity) args.push('--granularity', granularity);
  if (summaryOnly) args.push('--summary-only');
  if (rolesOnly) for (const role of rolesOnly) args.push('--role', role);
  const request = new Promise((resolve, reject) => {
    execFile('python3', args, { timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const report = JSON.parse(stdout);
        resolve({ generated_at: new Date().toISOString(), ...report });
      } catch (e) {
        reject(new Error(`AI usage JSON parse failed: ${e.message}`));
      }
    });
  });
  let shared;
  shared = request
    .then(report => {
      const storedAt = Date.now();
      for (const [entryKey, entry] of reportCache) {
        if (storedAt - entry.at >= CACHE_TTL_MS) reportCache.delete(entryKey);
      }
      while (reportCache.size >= CACHE_MAX_ENTRIES) {
        reportCache.delete(reportCache.keys().next().value);
      }
      reportCache.set(key, { at: storedAt, report });
      return report;
    })
    .finally(() => {
      if (reportPending.get(key) === shared) reportPending.delete(key);
    });
  reportPending.set(key, shared);
  return shared;
}

module.exports = { fleet, scriptPath };
