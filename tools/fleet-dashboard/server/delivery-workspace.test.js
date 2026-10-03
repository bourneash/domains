'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { preparePublication } = require('./delivery-workspace');
function fixture() {
  const run = {
    run_id: 'original-run',
    site: 'example.com',
    branch: 'improvement/original',
    workspace_path: '/isolated/original',
    validation: { passed: true },
    agent: { status: 'completed' },
    sandbox: { instance: 'original', started: true },
  };
  const calls = [],
    store = {
      updateImprovement(id, patch) {
        calls.push('persist');
        Object.assign(run, patch);
        return run;
      },
      record() {
        calls.push('record');
      },
    };
  const controls = {
    async stop() {
      calls.push('stop');
    },
    async restore() {
      calls.push('restore');
      return ['site/.astro/types.d.ts'];
    },
    async snapshot() {
      calls.push('snapshot');
      return { branch: run.branch, commit: 'tested-head', dirty: 0 };
    },
  };
  return { run, calls, store, controls };
}
test('publication stops preview writers before restoring generated files and checking cleanliness', async () => {
  const f = fixture();
  const run = await preparePublication(f.store, f.run, f.controls);
  assert.deepEqual(f.calls, ['stop', 'persist', 'restore', 'snapshot', 'record']);
  assert.equal(run.sandbox.started, false);
  f.calls.length = 0;
  await preparePublication(f.store, run, f.controls);
  assert.deepEqual(f.calls, ['restore', 'snapshot', 'record']);
});
test('publication rejects active workers and failed validation without stopping or restoring anything', async () => {
  for (const patch of [{ agent: { status: 'running' } }, { validation: { passed: false } }]) {
    const f = fixture();
    Object.assign(f.run, patch);
    await assert.rejects(
      preparePublication(f.store, f.run, f.controls),
      error => error.httpStatus === 409
    );
    assert.deepEqual(f.calls, []);
  }
});
test('unexpected dirty files and branch changes remain blockers after quiescing', async () => {
  for (const result of [
    { branch: 'improvement/original', dirty: 1 },
    { branch: 'different', dirty: 0 },
  ]) {
    const f = fixture();
    f.controls.snapshot = async () => result;
    await assert.rejects(
      preparePublication(f.store, f.run, f.controls),
      error => error.httpStatus === 409
    );
    assert.ok(!f.calls.includes('record'));
  }
});
test('failed preview shutdown cannot reach restore or publication', async () => {
  const f = fixture();
  f.controls.stop = async () => {
    throw Error('shutdown failed');
  };
  await assert.rejects(preparePublication(f.store, f.run, f.controls), /shutdown failed/);
  assert.deepEqual(f.calls, []);
});

test('already-running sandbox flag never substitutes for a recorded shutdown', async () => {
  const f = fixture();
  f.run.sandbox.started = false;
  await preparePublication(f.store, f.run, f.controls);
  assert.equal(f.calls[0], 'stop');
  assert.ok(f.run.sandbox.quiesced_at);
  f.calls.length = 0;
  f.run.validation.recorded_at = new Date(
    Date.parse(f.run.sandbox.quiesced_at) + 1000
  ).toISOString();
  await preparePublication(f.store, f.run, f.controls);
  assert.equal(f.calls[0], 'stop');
});
