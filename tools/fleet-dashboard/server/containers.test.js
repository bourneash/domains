'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLister } = require('./containers');

test('coalesces concurrent container listings and clears the in-flight request', async () => {
  let calls = 0;
  let finish;
  const run = () => {
    calls++;
    if (calls > 1) return Promise.resolve({ err: null, stdout: '', stderr: '' });
    return new Promise(resolve => {
      finish = resolve;
    });
  };
  const list = createLister(run);

  const first = list('/domains');
  const concurrent = list('/domains');
  assert.equal(calls, 1);
  assert.strictEqual(first, concurrent);

  finish({ err: null, stdout: '', stderr: '' });
  assert.deepEqual(await first, []);

  await list('/domains');
  assert.equal(calls, 2);
});

test('does not coalesce listings for different roots', async () => {
  const roots = [];
  const list = createLister(async (_cmd, _args) => {
    roots.push(roots.length);
    await new Promise(resolve => setImmediate(resolve));
    return { err: null, stdout: '', stderr: '' };
  });

  await Promise.all([list('/domains-a'), list('/domains-b')]);
  assert.equal(roots.length, 2);
});
