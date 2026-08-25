'use strict';
const test = require('node:test');
const assert = require('node:assert');
const gh = require('./githygiene');

const ROOT = require('node:path').join(__dirname, '..', '..', '..');

test('board() is a pure read — no git calls, always shaped', () => {
  const b = gh.board();
  assert.equal(typeof b.running, 'boolean');
  assert.ok(Array.isArray(b.queue));
  assert.ok(Array.isArray(b.policy.rules));
  assert.ok(b.policy.rules.length > 0);
});

test('resolve rejects paths that could escape the repo or be read as a git option', async () => {
  for (const bad of ['../../etc/passwd', '/etc/passwd', '-f', '', 'a/../../b']) {
    await assert.rejects(
      () => gh.resolve(ROOT, { slug: 'domains', path: bad, decision: 'commit' }),
      /invalid path/,
      `expected ${JSON.stringify(bad)} to be rejected`
    );
  }
});

test('resolve rejects an unknown decision before touching any repo', async () => {
  await assert.rejects(
    () => gh.resolve(ROOT, { slug: 'domains', path: 'ops/x.md', decision: 'yolo' }),
    /bad decision/
  );
});

test('resolve rejects a slug that is not a real repo', async () => {
  await assert.rejects(
    () => gh.resolve(ROOT, { slug: '../evil', path: 'ops/x.md', decision: 'dismiss' }),
    /invalid slug/
  );
  await assert.rejects(
    () => gh.resolve(ROOT, { slug: 'not-a-site.com', path: 'ops/x.md', decision: 'dismiss' }),
    /unknown repo/
  );
});
