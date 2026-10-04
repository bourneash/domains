'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { conflictPort, runWithPortRetry } = require('./sandbox-port-retry');
const failure = port => ({
  code: 125,
  stderr: `docker failed to bind host port 127.0.0.1:${port}/tcp: address already in use`,
});
test('only an actual conflict on this sandbox published port permits retry', () => {
  assert.equal(conflictPort(failure(8828).stderr, { ttyd: 7800, dev: 8828 }), 8828);
  assert.equal(conflictPort(failure(8829).stderr, { ttyd: 7800, dev: 8828 }), null);
  assert.equal(conflictPort('network unavailable', { ttyd: 7800, dev: 8828 }), null);
});
test('occupied host listener is skipped without stopping its owner or altering isolation', async () => {
  const calls = [],
    args = [
      'run',
      '-d',
      '--name',
      'own-sandbox',
      '--user',
      '1000:1000',
      '--cap-drop',
      'ALL',
      '-p',
      '127.0.0.1:7800:7681',
      '-p',
      '127.0.0.1:8828:4321',
      '--mount',
      'type=bind,src=/safe/site,dst=/safe/site',
      'image',
    ];
  const result = await runWithPortRetry({
    args,
    name: 'own-sandbox',
    ports: { ttyd: 7800, dev: 8828 },
    run: async argv => {
      calls.push(argv);
      return calls.length === 1 ? failure(8828) : { code: 0, stdout: 'created' };
    },
    allocate: async reserved => {
      assert.ok(reserved.has(8828));
      return { ttyd: 7800, dev: 8829 };
    },
  });
  assert.equal(result.result.code, 0);
  assert.deepEqual(result.port_conflicts, [8828]);
  assert.deepEqual(calls[1], ['rm', 'own-sandbox']);
  assert.deepEqual(
    calls[2],
    args.map(x => (x === '127.0.0.1:8828:4321' ? '127.0.0.1:8829:4321' : x))
  );
  assert.ok(args.includes('127.0.0.1:8828:4321'));
});
test('non-port failures are returned without retries or container removal', async () => {
  let calls = 0;
  const r = await runWithPortRetry({
    args: ['run'],
    name: 'own',
    ports: { ttyd: 7800, dev: 8828 },
    run: async () => {
      calls++;
      return { code: 1, stderr: 'image unavailable' };
    },
    allocate: async () => {
      throw Error('not allowed');
    },
  });
  assert.equal(calls, 1);
  assert.equal(r.result.stderr, 'image unavailable');
});
test('port retries are bounded and never force removal of a running container', async () => {
  let attempts = 0,
    removals = 0;
  const r = await runWithPortRetry({
    args: ['run', '-p', '127.0.0.1:8828:4321'],
    name: 'own',
    ports: { ttyd: 7800, dev: 8828 },
    run: async argv => {
      if (argv[0] === 'rm') {
        assert.deepEqual(argv, ['rm', 'own']);
        removals++;
        return { code: 0 };
      }
      return failure(8828 + attempts++);
    },
    allocate: async () => ({ ttyd: 7800, dev: 8828 + attempts }),
  });
  assert.equal(attempts, 3);
  assert.equal(removals, 3);
  assert.equal(r.result.code, 125);
  assert.deepEqual(r.port_conflicts, [8828, 8829, 8830]);
});
test('refused non-forced cleanup fails safely before another attempt', async () => {
  let count = 0;
  const r = await runWithPortRetry({
    args: ['run'],
    name: 'own',
    ports: { ttyd: 7800, dev: 8828 },
    run: async () => (++count === 1 ? failure(8828) : { code: 1, stderr: 'container is running' }),
    allocate: async () => {
      throw Error('not allowed');
    },
  });
  assert.equal(count, 2);
  assert.match(r.result.stderr, /container is running/);
});
