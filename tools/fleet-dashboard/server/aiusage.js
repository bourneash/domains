'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');

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
  const args = [scriptPath(root), '--root', root, '--json'];
  if (from) args.push('--from', from);
  if (to) args.push('--to', to);
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      args,
      { timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const report = JSON.parse(stdout);
          resolve({ generated_at: new Date().toISOString(), ...report });
        } catch (e) {
          reject(new Error(`AI usage JSON parse failed: ${e.message}`));
        }
      }
    );
  });
}

module.exports = { fleet, scriptPath };
