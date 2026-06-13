'use strict';

const { exec } = require('node:child_process');
const { promisify } = require('node:util');
const execP = promisify(exec);

// Returns "running" | "stopped" | "never-built".
// `runner` is injectable for tests; defaults to the real docker CLI.
async function containerStatus(container, runner = defaultRunner) {
  try {
    const { stdout } = await runner(
      `docker ps -a --filter name=^/${container}$ --format "{{.Status}}"`
    );
    const status = stdout.trim();
    if (!status) return 'never-built';
    return /^Up\b/.test(status) ? 'running' : 'stopped';
  } catch {
    return 'never-built';
  }
}

function defaultRunner(cmd) {
  return execP(cmd, { timeout: 10000 });
}

// Rebuild + restart a system's cron container. Streams output via onData.
// Resolves { ok, code }. Never rejects on non-zero exit.
function rebuildCron(cwd, onData) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', 'docker compose build cron && docker compose up -d cron'],
      { cwd });
    child.stdout.on('data', (d) => onData(d.toString()));
    child.stderr.on('data', (d) => onData(d.toString()));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
    child.on('error', (e) => { onData(`spawn error: ${e.message}\n`); resolve({ ok: false, code: -1 }); });
  });
}

module.exports = { containerStatus, rebuildCron };
