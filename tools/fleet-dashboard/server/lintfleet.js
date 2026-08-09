'use strict';

// Fleet lint sweep — surfaces tools/lint-fleet/lint-sweep.py.
//
// The sweep takes ~25s fleet-wide, which is far too slow to run inside a GET.
// So the CLI owns both the logic AND the cache: every run writes
// tools/lint-fleet/reports/latest.json, this module just serves that file and
// can kick off a fresh run in the background. Same division of labour as
// aiinventory.js/aiusage.js — never re-derive the classification here.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SCAN_TIMEOUT_MS = 15 * 60 * 1000;

// One sweep at a time per process. The CLI takes its own flock against the host
// cron, but this keeps the dashboard from queueing a pile of redundant runs
// behind a single impatient click.
let RUNNING = null;

function scriptPath(root) {
  return path.join(root, 'tools', 'lint-fleet', 'lint-sweep.py');
}

function reportPath(root) {
  return path.join(root, 'tools', 'lint-fleet', 'reports', 'latest.json');
}

function progress() {
  return RUNNING
    ? { running: true, scope: RUNNING.scope, startedAt: RUNNING.startedAt }
    : { running: false, scope: null, startedAt: null };
}

function latest(root) {
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(reportPath(root), 'utf8'));
  } catch {
    // No sweep has ever run on this host — that is a real state the UI shows,
    // not an error.
  }
  return { report, progress: progress() };
}

function scan(root, site) {
  if (RUNNING) {
    const e = new Error(`a ${RUNNING.scope} sweep is already running`);
    e.httpStatus = 409;
    throw e;
  }
  if (site && !/^[a-z0-9][a-z0-9.-]*$/i.test(site)) {
    const e = new Error('invalid site');
    e.httpStatus = 400;
    throw e;
  }
  const args = [scriptPath(root), '--root', root, '--json'];
  if (site) args.push('--site', site);

  RUNNING = { scope: site || 'fleet', startedAt: new Date().toISOString() };
  const done = new Promise((resolve) => {
    execFile(
      'python3',
      args,
      { timeout: SCAN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        RUNNING = null;
        // The CLI already persisted its report; the dashboard reads that on the
        // next poll. Only the failure detail is worth carrying back.
        resolve(err ? { ok: false, error: (stderr || err.message || '').slice(0, 2000) } : { ok: true, bytes: stdout.length });
      }
    );
  });
  return { started: true, ...progress(), done };
}

module.exports = { latest, scan, progress, scriptPath, reportPath };
