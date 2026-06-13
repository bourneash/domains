const { test } = require('node:test');
const assert = require('node:assert');
const { containerStatus } = require('../server/docker');

function fakeExec(output) {
  return async () => ({ stdout: output, stderr: '' });
}

test('running container → running', async () => {
  const st = await containerStatus('americastrikes-cron', fakeExec('Up 3 hours\n'));
  assert.strictEqual(st, 'running');
});

test('exited container → stopped', async () => {
  const st = await containerStatus('americastrikes-cron', fakeExec('Exited (0) 2 days ago\n'));
  assert.strictEqual(st, 'stopped');
});

test('no such container → never-built', async () => {
  const st = await containerStatus('nope-cron', fakeExec('\n'));
  assert.strictEqual(st, 'never-built');
});

test('docker error → never-built (degrades, never throws)', async () => {
  const throwingExec = async () => { throw new Error('docker daemon unreachable'); };
  const st = await containerStatus('x-cron', throwingExec);
  assert.strictEqual(st, 'never-built');
});
