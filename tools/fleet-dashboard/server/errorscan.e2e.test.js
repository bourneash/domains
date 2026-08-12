'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const test = require('node:test');
const { promisify } = require('node:util');
const errorscan = require('./errorscan');

const execFileAsync = promisify(execFile);

async function docker(args) {
  return execFileAsync('docker', args, { timeout: 30000 });
}

test('real Docker logs suppress build-success noise and retain a genuine critical line', {
  skip: process.env.ERRORSCAN_E2E !== '1',
}, async (t) => {
  const name = `fleet-errorscan-e2e-${process.pid}-${Date.now()}`;
  t.after(async () => {
    try { await docker(['rm', '-f', name]); } catch { /* exact test container may already be gone */ }
    errorscan._resetForTest();
  });

  const emit = [
    "console.log('18:11:09   ├─ /articles/ship-bab-el-mandeb-fatal/index.html (+29ms)')",
    "console.log('Done. 1 succeeded, 0 failed.')",
    "console.log('FATAL database unavailable')",
    "console.log('WARNING retry scheduled')",
  ].join(';');
  await docker(['create', '--name', name, 'fleet-dashboard:latest', 'node', '-e', emit]);
  await docker(['start', '-a', name]);
  const inspected = await docker(['inspect', '--format', '{{.Id}}', name]);
  const id = inspected.stdout.trim();

  errorscan._resetForTest();
  await errorscan._scanOne('/tmp/fleet-errorscan-e2e', {
    id,
    name,
    slug: 'example.com',
    kind: 'worker',
    scope: 'site',
    running: false,
    oneoff: true,
  });

  const row = errorscan.rollup().containers.find((c) => c.id === id);
  assert.ok(row);
  assert.equal(row.count1h, 2);
  assert.equal(row.crit24h, 1);
  assert.equal(row.warn24h, 1);
  assert.equal(row.error24h, 0);
  assert.equal(row.lastLine, 'WARNING retry scheduled');
});
