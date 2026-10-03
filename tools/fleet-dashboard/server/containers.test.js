'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const containers = require('./containers');

test('container list is cached for the rail interval with a bounded fresh-read path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-container-cache-'));
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'calls');
  fs.mkdirSync(bin);
  const docker = path.join(bin, 'docker');
  fs.writeFileSync(docker, '#!/bin/sh\nprintf x >> "$CONTAINER_TEST_CALLS"\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  const oldCalls = process.env.CONTAINER_TEST_CALLS;
  const oldNow = Date.now;
  let now = 1_000_000;
  process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
  process.env.CONTAINER_TEST_CALLS = calls;
  Date.now = () => now;
  containers.invalidateList(root);
  try {
    assert.deepEqual(await containers.list(root), []);
    assert.deepEqual(await containers.list(root), []);
    assert.equal(fs.readFileSync(calls, 'utf8'), 'x');

    now += 5001;
    assert.deepEqual(await containers.list(root, { force: true }), []);
    assert.equal(fs.readFileSync(calls, 'utf8'), 'xx');

    assert.deepEqual(await containers.list(root), []);
    assert.equal(fs.readFileSync(calls, 'utf8'), 'xx');
  } finally {
    Date.now = oldNow;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldCalls === undefined) delete process.env.CONTAINER_TEST_CALLS;
    else process.env.CONTAINER_TEST_CALLS = oldCalls;
    containers.invalidateList(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
