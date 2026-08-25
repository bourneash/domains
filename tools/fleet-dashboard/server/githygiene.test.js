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

test('board() exposes every field the Git Hygiene view renders', () => {
  // The tab is rendered from this shape. A server-side change that drops a
  // field should fail here rather than throwing in the browser, where nobody
  // is watching.
  const b = gh.board();
  assert.ok('running' in b);
  assert.ok('lastSweep' in b, 'header renders lastSweep.at/.repos and the summary table');
  assert.ok(Array.isArray(b.queue));
  assert.ok(b.policy && Array.isArray(b.policy.rules));
  assert.ok(Array.isArray(b.policy.ignoreBlock), 'policy card renders ignoreBlock.length');
  assert.equal(typeof b.policy.limits.max_files_per_commit, 'number');
  for (const i of b.queue)
    for (const k of ['slug', 'path', 'reason', 'first_seen'])
      assert.ok(k in i, `queue row is missing ${k}`);
  if (b.lastSweep) {
    assert.ok(Array.isArray(b.lastSweep.summary), 'the "Last sweep" table iterates summary');
    assert.ok(Array.isArray(b.lastSweep.blocked));
    assert.ok(Array.isArray(b.lastSweep.skipped));
  }
});

test('board() never leaks the policy file path or raw rule internals', () => {
  const b = gh.board();
  const s = JSON.stringify(b);
  assert.equal(s.includes('_match'), false, 'compiled regexes are not serialised to the browser');
  assert.equal(s.includes('_scope'), false);
});
