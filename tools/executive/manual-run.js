'use strict';

// Detached operator-triggered executive run. The dashboard creates the
// durable action before spawning this process; this process owns completion so
// the HTTP request is not held open for the model/container run.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const eventstore = require('../fleet-dashboard/server/eventstore');
const executive = require('../fleet-dashboard/server/executive');

const root = process.env.FD_DOMAINS_ROOT || path.resolve(__dirname, '..', '..');
const actionId = String(process.argv[2] || '');
if (!actionId) process.exit(2);

const logDir = path.join(root, 'tools', 'executive', 'logs');
fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
const logPath = path.join(logDir, `manual-${actionId}.log`);
const log = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
const child = spawn('bash', [path.join(root, 'tools', 'executive', 'run-scheduled.sh')], {
  cwd: root,
  // The manual action is the run's durable handle. Pass it through so the
  // scheduler wrapper updates this row instead of creating a second,
  // indistinguishable scheduled row for the same invocation.
  env: { ...process.env, EXECUTIVE_FORCE: '1', EXECUTIVE_ACTION_ID: actionId },
  stdio: ['ignore', 'pipe', 'pipe'],
});
{
  const store = eventstore.open(root);
  try {
    executiveActionUpdate(store, actionId, {
      phase: 'running',
      running_at: new Date().toISOString(),
      pid: child.pid,
    });
  } finally {
    store.close();
  }
}
child.stdout.pipe(log);
child.stderr.pipe(log);

function executiveActionUpdate(store, id, result) {
  return store.updateExecutiveAction(id, { result });
}

let finished = false;
const finish = (code, signal) => {
  if (finished) return;
  finished = true;
  log.write(`\n[manual-run] exited code=${code} signal=${signal || ''}\n`);
  log.end();
  const store = eventstore.open(root);
  try {
    const tick = store
      .listExecutiveActions({ action_type: 'tick', limit: 20 })
      .find(row => Date.parse(row.started_at || '') >= Date.now() - 2 * 60 * 60 * 1000);
    executive.finishAction(store, actionId, {
      status: code === 0 ? 'completed' : 'failed',
      error:
        code === 0
          ? null
          : `executive runner exited with code ${code}${signal ? ` (${signal})` : ''}`,
      result: {
        exit_code: code,
        signal: signal || null,
        log_path: logPath,
        tick_action_id: tick?.action_id || null,
        tick_status: tick?.status || null,
        tick_result: tick?.result || null,
      },
    });
  } catch (error) {
    // Preserve a useful process-level failure even if the audit store itself
    // is temporarily unavailable; the log remains available for diagnosis.
    try {
      const retry = eventstore.open(root);
      executive.finishAction(retry, actionId, { status: 'failed', error: error.message });
      retry.close();
    } catch {
      /* best effort */
    }
  } finally {
    store.close();
  }
};

child.on('error', error => finish(1, error.message));
child.on('close', finish);
