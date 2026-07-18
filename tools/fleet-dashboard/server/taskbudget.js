'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');

// Single source of truth for the writer-role turn-budget audit is the Python
// CLI (tools/task-budget/turn_budget.py). The web layer shells out to it for
// `audit --json` so there is exactly one implementation of the selection/
// budget logic — the same pattern as audit.js -> engineer-status.py. We
// never re-derive it here.
function scriptPath(root) {
  return path.join(root, 'tools', 'task-budget', 'turn_budget.py');
}

// Full fleet audit: per-site, per-role configured static MAX_TURNS vs. what
// the dynamic budget would compute right now from the next backlog task,
// plus dead-role task drift (assigned_role values with no matching
// ops/roles/*.md file on that site).
function fleet(root) {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [scriptPath(root), 'audit', '--fleet-root', root, '--json'],
      { timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout)); }
        catch (e) { reject(new Error(`task-budget audit JSON parse failed: ${e.message}`)); }
      }
    );
  });
}

module.exports = { fleet };
