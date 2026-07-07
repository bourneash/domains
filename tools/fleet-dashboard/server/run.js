'use strict';

const { execFile } = require('node:child_process');
const roles = require('./roles');
const { siteCronContainer } = require('./cron/discovery');

function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve(stdout);
    });
  });
}

// Resolve the running cron container for a site dir name (e.g. "americastrikes.com").
//
// B1 fix: match EXACTLY against running container names — never `startsWith`,
// which let two sites sharing a first label (mynewgm.com / mynewgm.info both
// stem to "mynewgm") resolve to each other's container and run an agent (and its
// git push) against the wrong repo. Candidates, most-authoritative first:
//   1. the site's own compose `container_name:` (siteCronContainer) — the same
//      source the cron control plane uses, so both paths agree;
//   2. the dots→dashes base form "<base>-cron" (mynewgm.info → mynewgm-info-cron);
//   3. the "<stem>-cron" convention (last, because it's the collision-prone one).
// Two same-stem sites MUST set distinct container_name values in their compose
// for (1)/(2) to disambiguate them; the stem fallback cannot.
async function cronContainer(root, slug) {
  const out = await sh('docker', ['ps', '--format', '{{.Names}}']);
  const names = new Set(out.split('\n').map((n) => n.trim()).filter(Boolean));
  const candidates = [
    siteCronContainer(root, slug),
    `${slug.replace(/\./g, '-')}-cron`,
    `${slug.split('.')[0]}-cron`,
  ];
  for (const c of candidates) {
    if (c && names.has(c)) return c;
  }
  return null;
}

// Fire the engineer role immediately inside the site's cron container, detached —
// exactly the command cron runs (`bash ops/scripts/run-worker.sh engineer`). The
// engineer's own work-lock serializes the pass, so triggering one while another is
// in flight no-ops safely. We don't wait for completion (a real pass can take
// minutes); the liveness pulse + Slack report the outcome.
async function runEngineer(root, slug) {
  const container = await cronContainer(root, slug);
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
  const container = await cronContainer(root, slug);
  if (!container) { const e = new Error(`no running cron container for ${slug}`); e.httpStatus = 409; throw e; }
  await sh('docker', ['exec', '-d', container, 'bash', 'ops/scripts/run-worker.sh', r]);
  return container;
}

module.exports = { runEngineer, runRole, cronContainer };
