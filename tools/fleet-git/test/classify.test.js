'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { compilePolicy } = require('../lib/policy');
const { plan } = require('../lib/classify');
const realPolicy = require('../lib/policy').load();

const st = (files, extra = {}) => ({
  isRepo: true,
  branch: 'main',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  detached: false,
  files,
  ...extra,
});
const f = (path, kind = 'modified') => ({ path, kind, code: kind === 'untracked' ? '??' : ' M' });
const P = { slug: 'x.com', policy: realPolicy };

test('unmatched paths go to review, never to a commit', () => {
  const p = plan(st([f('site/src/pages/index.astro')]), P);
  assert.equal(p.commit.length, 0);
  assert.equal(p.review.length, 1);
});

test('commit rules group by group key with one message each', () => {
  const p = plan(st([f('ops/tasks/a.md'), f('ops/tasks/b.md'), f('ops/social/queue.jsonl')]), P);
  assert.equal(p.commit.length, 2);
  const tasks = p.commit.find(c => c.group === 'tasks');
  assert.deepEqual(tasks.paths.sort(), ['ops/tasks/a.md', 'ops/tasks/b.md']);
});

test('an untracked generated path is ignored', () => {
  const p = plan(st([f('ops/scripts/__pycache__/', 'untracked')]), P);
  assert.equal(p.ignore.length, 1);
  assert.equal(p.ignore[0].untrack, true);
});

test('a TRACKED path an ignore rule matches is only untracked when the rule opted in', () => {
  const optedIn = plan(st([f('ops/board/last-run.json')]), P);
  assert.equal(optedIn.ignore.length, 1);

  const policy = compilePolicy({
    version: 1,
    ignore_block: [],
    rules: [{ id: 'no-untrack', action: 'ignore', scope: 'fleet', match: ['ops/thing.json'] }],
  });
  const p = plan(st([f('ops/thing.json')]), { slug: 'x.com', policy });
  assert.equal(p.ignore.length, 0);
  assert.match(p.review[0].reason, /already tracked/);
});

test('a credential-shaped path halts the whole repo', () => {
  const p = plan(st([f('.env'), f('ops/tasks/a.md')]), P);
  assert.equal(p.blocked.length, 1);
  assert.equal(p.commit.length, 0, 'nothing is committed while a secret sits in the tree');
  assert.equal(p.ignore.length, 0);
  assert.match(p.skip, /blocked/);
});

test('.env.example is not treated as a secret', () => {
  const p = plan(st([f('.env.example')]), P);
  assert.equal(p.blocked.length, 0);
});

test('a repo behind upstream is reported, never acted on', () => {
  const p = plan(st([f('ops/tasks/a.md')], { behind: 3 }), P);
  assert.match(p.skip, /behind upstream/);
  assert.equal(p.commit.length, 0);
});

test('a detached HEAD is skipped', () => {
  assert.match(plan(st([], { detached: true, branch: null }), P).skip, /detached/);
});

test('parent-repo gitlink changes become pointers, not file commits', () => {
  const p = plan(st([f('sites/a.com'), f('tools/x.js')]), {
    slug: 'domains',
    policy: realPolicy,
    isParent: true,
    submodulePaths: new Set(['sites/a.com']),
  });
  assert.deepEqual(p.pointers, [{ path: 'sites/a.com' }]);
  assert.equal(p.review.length, 1);
});

test('an oversized commit group is routed to review instead of rubber-stamped', () => {
  const many = Array.from({ length: 250 }, (_, i) => f(`ops/tasks/${i}.md`));
  const p = plan(st(many), P);
  assert.equal(p.commit.length, 0);
  assert.equal(p.review.length, 250);
});
