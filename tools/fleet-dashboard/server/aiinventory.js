'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const CACHE_TTL_MS = 3000;
const CACHE_LIMIT = 32;
const reportCache = new Map();
const reportPending = new Map();

// Keep the dispatch classifier in one place. The dashboard consumes the same
// JSON emitted by the CLI instead of maintaining a second JavaScript heuristic.
function scriptPath(root) {
  return path.join(root, 'tools', 'ai-inventory', 'audit-ai.py');
}

function fleet(root) {
  const key = path.resolve(root);
  const now = Date.now();
  const cached = reportCache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.report);
  if (cached) reportCache.delete(key);
  const existing = reportPending.get(key);
  if (existing) return existing;

  const request = new Promise((resolve, reject) => {
    execFile(
      'python3',
      [scriptPath(root), '--root', root, '--json'],
      { timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const rows = JSON.parse(stdout);
          const providers = {};
          for (const row of rows) providers[row.provider] = (providers[row.provider] || 0) + 1;
          resolve({
            generated_at: new Date().toISOString(),
            rows,
            summary: {
              services: rows.length,
              ai: rows.filter(r => r.provider !== 'None').length,
              local: rows.filter(r => r.policy === 'Local').length,
              remote: rows.filter(r => r.policy === 'Remote').length,
              disabled: rows.filter(r => r.status === 'DISABLED').length,
              conditional: rows.filter(r => r.conditional).length,
              providers,
            },
          });
        } catch (e) {
          reject(new Error(`AI inventory JSON parse failed: ${e.message}`));
        }
      }
    );
  });
  let shared;
  shared = request
    .then(report => {
      const storedAt = Date.now();
      for (const [entryKey, entry] of reportCache) {
        if (storedAt - entry.at >= CACHE_TTL_MS) reportCache.delete(entryKey);
      }
      while (reportCache.size >= CACHE_LIMIT) reportCache.delete(reportCache.keys().next().value);
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
