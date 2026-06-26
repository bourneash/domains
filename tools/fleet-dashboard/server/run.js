'use strict';

const { execFile } = require('node:child_process');
const roles = require('./roles');

function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve(stdout);
    });
  });
}

// Resolve the running cron container for a site dir name (e.g. "americastrikes.com").
// Mirrors the name match in engineer-status.py: the container is "<first-label>-cron"
// (americastrikes.com → americastrikes-cron, rc-9.com → rc-9-cron) or, as a fallback,
// the dots→dashes form "<base>-cron".
async function cronContainer(slug) {
  const out = await sh('docker', ['ps', '--format', '{{.Names}}']);
  const names = out.split('\n').map((n) => n.trim()).filter(Boolean);
  const base = slug.replace(/\./g, '-');
  const first = slug.split('.')[0];
  return names.find((c) => c === first + '-cron' || c === base + '-cron'
    || c.startsWith(first + '-cron') || c.startsWith(base + '-cron')) || null;
}

// Fire the engineer role immediately inside the site's cron container, detached —
// exactly the command cron runs (`bash ops/scripts/run-worker.sh engineer`). The
// engineer's own work-lock serializes the pass, so triggering one while another is
// in flight no-ops safely. We don't wait for completion (a real pass can take
// minutes); the liveness pulse + Slack report the outcome.
async function runEngineer(slug) {
  const container = await cronContainer(slug);
  if (!container) {
    const e = new Error(`no running cron container for ${slug}`);
    e.httpStatus = 409;
    throw e;
  }
  await sh('docker', ['exec', '-d', container, 'bash', 'ops/scripts/run-worker.sh', 'engineer']);
  return container;
}

// Fire any worker role immediately inside the site's cron container, detached —
// the exact command cron runs (`bash ops/scripts/run-worker.sh <role>`). Limited
// to scheduled run-worker.sh roles (which honour the per-role work-lock, so an
// ad-hoc run while one is in flight no-ops safely).
async function runRole(root, slug, role) {
  const r = String(role || '').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(r)) { const e = new Error('invalid role'); e.httpStatus = 400; throw e; }
  const entry = roles.roleEntry(root, slug, r);
  if (!entry) { const e = new Error('role is not scheduled on this site'); e.httpStatus = 404; throw e; }
  if (!entry.worker) { const e = new Error('role is not run-now-capable (not a run-worker.sh role)'); e.httpStatus = 400; throw e; }
  const container = await cronContainer(slug);
  if (!container) { const e = new Error(`no running cron container for ${slug}`); e.httpStatus = 409; throw e; }
  await sh('docker', ['exec', '-d', container, 'bash', 'ops/scripts/run-worker.sh', r]);
  return container;
}

module.exports = { runEngineer, runRole, cronContainer };
