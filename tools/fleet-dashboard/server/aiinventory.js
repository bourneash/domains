'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');

// Keep the dispatch classifier in one place. The dashboard consumes the same
// JSON emitted by the CLI instead of maintaining a second JavaScript heuristic.
function scriptPath(root) {
  return path.join(root, 'tools', 'ai-inventory', 'audit-ai.py');
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
          const rows = JSON.parse(stdout);
          const providers = {};
          for (const row of rows) providers[row.provider] = (providers[row.provider] || 0) + 1;
          resolve({
            generated_at: new Date().toISOString(),
            rows,
            summary: {
              services: rows.length,
              ai: rows.filter((r) => r.provider !== 'None').length,
              local: rows.filter((r) => r.policy === 'Local').length,
              remote: rows.filter((r) => r.policy === 'Remote').length,
              disabled: rows.filter((r) => r.status === 'DISABLED').length,
              conditional: rows.filter((r) => r.conditional).length,
              providers,
            },
          });
        } catch (e) {
          reject(new Error(`AI inventory JSON parse failed: ${e.message}`));
        }
      }
    );
  });
}

module.exports = { fleet, scriptPath };
