'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');

// Single source of truth for the engineer liveness audit is the Python CLI
// (tools/engineer-fleet/engineer-status.py). The web layer shells out to it
// for `--json` so there is exactly one implementation of the tier/pulse/queue
// logic. We never re-derive it here.
function scriptPath(root) {
  return path.join(root, 'tools', 'engineer-fleet', 'engineer-status.py');
}

function runPython(root, extraArgs) {
  return new Promise((resolve, reject) => {
    execFile('python3', [scriptPath(root), ...extraArgs], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout)); }
        catch (e) { reject(new Error(`audit JSON parse failed: ${e.message}`)); }
      });
  });
}

// Full per-site engineer audit (tier, features, cron, latest pulse, queue, flags).
function fleet(root) {
  return runPython(root, ['--json']);
}

// Pulse-log history summary over the last `days` days (ticks, status mix,
// coverage %, last failure, spark series).
function history(root, days = 3) {
  const d = Math.max(1, Math.min(parseInt(days, 10) || 3, 30));
  return runPython(root, ['--history', String(d), '--json']);
}

module.exports = { fleet, history };
