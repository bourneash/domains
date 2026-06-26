'use strict';

const { execFile } = require('node:child_process');
const { siteDir } = require('./sites');

// Resolve both streams regardless of exit code (docker logs exits non-zero in
// some states but still prints useful output).
function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000, maxBuffer: 16 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' }));
  });
}
function httpErr(status, msg) { const e = new Error(msg); e.httpStatus = status; return e; }
function dockerErr(r) { return (r.stderr || r.err && r.err.message || 'docker error').trim(); }

const SEP = '\x1f';
const FIELDS = ['{{.ID}}', '{{.Names}}', '{{.Image}}', '{{.State}}', '{{.Status}}', '{{.RunningFor}}',
  '{{.Label "com.docker.compose.project"}}', '{{.Label "com.docker.compose.service"}}',
  '{{.Label "com.docker.compose.oneoff"}}', '{{.Label "com.docker.compose.project.working_dir"}}'].join(SEP);

// Every container whose compose working_dir is inside the domains repo. Running
// ones, plus any cron container even if it's down (so a wedged cron is visible);
// exited one-off worker runs are dropped as noise.
async function list(root) {
  const r = await sh('docker', ['ps', '-a', '--no-trunc', '--format', FIELDS]);
  if (r.err) throw httpErr(500, dockerErr(r));
  const inRepo = (w) => w && (w === root || w.startsWith(root + '/'));
  const rows = r.stdout.split('\n').filter(Boolean).map((ln) => {
    const [id, name, image, state, status, runningFor, project, service, oneoff, workdir] = ln.split(SEP);
    return { id, name, image, state, status, runningFor, project: project || null,
      service: service || null, oneoff: oneoff === 'True', workdir: workdir || null };
  }).filter((c) => inRepo(c.workdir));

  return rows
    .filter((c) => c.state === 'running' || c.service === 'cron')
    .map((c) => {
      const m = c.workdir.match(/\/sites\/([^/]+)/);
      const isSite = !!m;
      const slug = m ? m[1] : c.workdir.split('/').pop();
      const kind = c.service === 'cron' ? 'cron' : c.service === 'worker' ? 'worker' : (isSite ? 'site' : 'tool');
      return {
        ...c, slug, kind, scope: isSite ? 'site' : 'tool',
        healthy: /\(healthy\)/.test(c.status),
        unhealthy: /\(unhealthy\)/.test(c.status),
        running: c.state === 'running',
      };
    })
    .sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'site' ? -1 : 1)
      || String(a.slug).localeCompare(String(b.slug))
      || String(a.kind).localeCompare(String(b.kind)));
}

// Guardrail: never act on a container outside the domains repo.
async function assertDomains(root, id) {
  const r = await sh('docker', ['inspect', id, '--format', '{{index .Config.Labels "com.docker.compose.project.working_dir"}}']);
  if (r.err) throw httpErr(404, 'no such container');
  const w = r.stdout.trim();
  if (!w || !(w === root || w.startsWith(root + '/'))) {
    throw httpErr(403, 'refusing to act on a container outside the domains repo');
  }
  return w;
}

// Lifecycle: restart (the quick "bounce"), stop, start. Plain docker — no
// compose plugin needed; picks up bind-mounted crontab / role-flag changes.
async function action(root, id, act) {
  if (!['restart', 'stop', 'start'].includes(act)) throw httpErr(400, 'unknown action');
  await assertDomains(root, id);
  const r = await sh('docker', [act, id], { timeout: 60000 });
  if (r.err) throw httpErr(500, dockerErr(r));
  return { ok: true, action: act };
}

async function logs(root, id, tail) {
  await assertDomains(root, id);
  const n = Math.max(1, Math.min(parseInt(tail, 10) || 300, 2000));
  const r = await sh('docker', ['logs', '--tail', String(n), '--timestamps', id], { timeout: 20000 });
  const out = `${r.stdout}${r.stderr}`.trim();
  return { ok: true, logs: out || '(no output)' };
}

// Full "bounce": rebuild the site's cron image and force-recreate it — the
// cron-bouncer path. Requires the compose plugin in the panel image. Slow.
async function bounce(root, slug) {
  const cwd = siteDir(root, slug);
  const env = { ...process.env, HOME: process.env.HOME || '/home/jesse' };
  const build = await sh('docker', ['compose', 'build', 'cron'], { cwd, env, timeout: 300000 });
  if (build.err) throw httpErr(500, `build failed: ${dockerErr(build)}`);
  const up = await sh('docker', ['compose', 'up', '-d', '--force-recreate', 'cron'], { cwd, env, timeout: 120000 });
  if (up.err) throw httpErr(500, `recreate failed: ${dockerErr(up)}`);
  return { ok: true, out: (up.stderr || up.stdout || '').trim() };
}

module.exports = { list, action, logs, bounce };
