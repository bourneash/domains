const { test } = require('node:test');
const assert = require('node:assert');
const { containerStatus, inspectContainer, confirmHealthy, containerLogs } = require('../server/docker');

// Fakes return the `docker ps --format "{{.State}}\t{{.Status}}"` shape.
function fakeExec(output) {
  return async () => ({ stdout: output, stderr: '' });
}

// ---- inspectContainer: the honest-status core (A1) ----

test('running container → ok, not failed', async () => {
  const i = await inspectContainer('americastrikes-cron', fakeExec('running\tUp 3 hours\n'));
  assert.strictEqual(i.state, 'running');
  assert.strictEqual(i.ok, true);
  assert.strictEqual(i.failed, false);
  assert.strictEqual(i.exitCode, null);
});

test('created container (failed start) → failed, exitCode parsed', async () => {
  const i = await inspectContainer('x-cron', fakeExec('created\tCreated\n'));
  assert.strictEqual(i.state, 'created');
  assert.strictEqual(i.ok, false);
  assert.strictEqual(i.failed, true);     // the bug-of-the-day: invisible before
});

test('exited non-zero → failed with exit code', async () => {
  const i = await inspectContainer('x-cron', fakeExec('exited\tExited (127) 2 minutes ago\n'));
  assert.strictEqual(i.state, 'exited');
  assert.strictEqual(i.exitCode, 127);
  assert.strictEqual(i.failed, true);
  assert.strictEqual(i.ok, false);
});

test('exited zero → stopped cleanly, not failed', async () => {
  const i = await inspectContainer('x-cron', fakeExec('exited\tExited (0) 2 days ago\n'));
  assert.strictEqual(i.exitCode, 0);
  assert.strictEqual(i.failed, false);
  assert.strictEqual(i.ok, false);
});

test('restarting (crash loop) → failed', async () => {
  const i = await inspectContainer('x-cron', fakeExec('restarting\tRestarting (1) 5 seconds ago\n'));
  assert.strictEqual(i.state, 'restarting');
  assert.strictEqual(i.failed, true);
});

test('no such container → never-built, not failed', async () => {
  const i = await inspectContainer('nope-cron', fakeExec('\n'));
  assert.strictEqual(i.state, 'never-built');
  assert.strictEqual(i.failed, false);
  assert.strictEqual(i.ok, false);
});

test('docker unreachable → unknown, never throws', async () => {
  const throwing = async () => { throw new Error('docker daemon unreachable'); };
  const i = await inspectContainer('x-cron', throwing);
  assert.strictEqual(i.state, 'unknown');
  assert.strictEqual(i.failed, false);
});

// ---- containerStatus: back-compat string wrapper ----

test('containerStatus running → running', async () => {
  assert.strictEqual(await containerStatus('x', fakeExec('running\tUp 3 hours\n')), 'running');
});

test('containerStatus exited → stopped', async () => {
  assert.strictEqual(await containerStatus('x', fakeExec('exited\tExited (0) 2 days ago\n')), 'stopped');
});

test('containerStatus missing → never-built', async () => {
  assert.strictEqual(await containerStatus('x', fakeExec('\n')), 'never-built');
});

test('containerStatus docker error → never-built (degrades)', async () => {
  const throwing = async () => { throw new Error('docker daemon unreachable'); };
  assert.strictEqual(await containerStatus('x', throwing), 'never-built');
});

// ---- confirmHealthy: post-rebuild verification (A2) ----

test('confirmHealthy polls through a transient gap, then reports running', async () => {
  let calls = 0;
  // Models the race where `docker ps` briefly returns nothing (never-built)
  // while the container is being created, then it comes up running.
  const runner = async () => {
    calls++;
    return { stdout: calls < 2 ? '\n' : 'running\tUp 1 second\n', stderr: '' };
  };
  const r = await confirmHealthy('x-cron', runner, { tries: 5, sleep: async () => {} });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state, 'running');
});

test('confirmHealthy bails immediately on a failed state', async () => {
  let calls = 0;
  const runner = async () => { calls++; return { stdout: 'created\tCreated\n', stderr: '' }; };
  const r = await confirmHealthy('x-cron', runner, { tries: 5, sleep: async () => {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.failed, true);
  assert.strictEqual(calls, 1, 'should not keep polling a failed container');
});

// ---- containerLogs (A4) ----

test('containerLogs returns merged output', async () => {
  const out = await containerLogs('x-cron', async () => ({ stdout: 'line1\nline2\n', stderr: '' }), 50);
  assert.match(out, /line1/);
});

test('containerLogs never throws', async () => {
  const out = await containerLogs('x-cron', async () => { throw new Error('boom'); });
  assert.match(out, /error fetching logs/);
});
