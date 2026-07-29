'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');

// Keep the aggregation logic in one place. The dashboard consumes the same
// JSON emitted by the CLI instead of maintaining a second JavaScript rollup.
function scriptPath(root) {
  return path.join(root, 'tools', 'ai-usage', 'aggregate.py');
}

function fleet(root) {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [scriptPath(root), '--root', root, '--json'],
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
