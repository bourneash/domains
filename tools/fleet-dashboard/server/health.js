'use strict';

// Dependency preflight (F7). The dashboard shells out to python3 (engineer
// audit), the docker CLI/daemon (containers + cron), and reads
// engineer-status.py. When any is missing, routes throw opaque 500s; this
// endpoint reports each dependency so the UI can show a clear degraded banner
// instead of a blank screen.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function probe(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err) => resolve(!err));
  });
}

async function deps(root) {
  const [python, docker] = await Promise.all([
    probe('python3', ['--version']),
    probe('docker', ['version', '--format', '{{.Server.Version}}']),
  ]);
  const scriptPath = path.join(root, 'tools', 'engineer-fleet', 'engineer-status.py');
  const auditScript = fs.existsSync(scriptPath);
  const dockerSocket = fs.existsSync('/var/run/docker.sock');

  const checks = {
    python3: { ok: python, detail: python ? 'available' : 'python3 not found — the engineer audit (/api/fleet) will fail' },
    docker: { ok: docker, detail: docker ? 'daemon reachable' : 'docker CLI/daemon unreachable — Containers & Cron features are degraded' },
    dockerSocket: { ok: dockerSocket, detail: dockerSocket ? 'mounted' : '/var/run/docker.sock not present — container control unavailable' },
    auditScript: { ok: auditScript, detail: auditScript ? 'present' : `${scriptPath} missing — engineer audit unavailable` },
  };
  return { ok: Object.values(checks).every((c) => c.ok), checks };
}

module.exports = { deps };
