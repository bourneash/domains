'use strict';

// fleet-doctor — the fleet's container/image invariants, in the panel (F33).
//
// The check itself lives in tools/fleet-images/bin/fleet-doctor and stays the
// source of truth; this module only runs it and serves the last result. The
// sweep shells out to docker once per site (33 sites, ~600 checks) and takes
// tens of seconds, which is far too slow to run inside a GET — so a background
// timer owns the run and the route serves the cache, same division of labour
// as deployhealth.js and gatushealth.js.
//
// `truncated` is passed through as a first-class field rather than being
// inferred from counts. fleet-doctor's own header says why: reporting all-green
// after checking 1 of 33 sites is precisely the failure the gate exists to
// prevent, so a consumer must be able to see an incomplete sweep and refuse to
// call it healthy.

const path = require('node:path');
const { execFile } = require('node:child_process');

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const REFRESH_MS = 15 * 60 * 1000; // the invariants drift on deploys, not seconds
const MAX_BUFFER = 32 * 1024 * 1024; // ~600 checks of JSON; the default 1MB truncates it

let CACHE = null;
let lastRun = 0;
let lastError = null;
let RUNNING = null; // one sweep at a time per process — a pile-up would just queue docker calls

function scriptPath(root) {
  return path.join(root, 'tools', 'fleet-images', 'bin', 'fleet-doctor');
}

function run(root) {
  if (RUNNING) return RUNNING;
  RUNNING = new Promise((resolve) => {
    execFile(
      scriptPath(root),
      ['--json'],
      { timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
      (err, stdout) => {
        RUNNING = null;
        // NOTE: fleet-doctor exits non-zero when any check FAILS. That is a
        // successful run reporting bad news, not a broken run — so stdout is
        // parsed first and the exit code is only consulted if there is nothing
        // to parse.
        const text = (stdout || '').trim();
        if (text) {
          try {
            CACHE = JSON.parse(text);
            lastRun = Date.now();
            lastError = null;
            return resolve(CACHE);
          } catch (e) {
            lastError = `unparseable output: ${e.message}`;
            return resolve(null);
          }
        }
        lastError = err ? String(err.message || err) : 'no output';
        resolve(null);
      },
    );
  });
  return RUNNING;
}

function all() {
  return {
    ok: !!CACHE,
    error: lastError,
    last_run: lastRun ? new Date(lastRun).toISOString() : null,
    age_ms: lastRun ? Date.now() - lastRun : null,
    running: !!RUNNING,
    ...(CACHE || { totals: {}, sites: [], checks: [] }),
  };
}

function start(root) {
  run(root);
  const t = setInterval(() => run(root), REFRESH_MS);
  if (t.unref) t.unref();
}

module.exports = { all, run, start };
