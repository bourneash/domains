'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { toRegex, normPath } = require('../lib/glob');

const m = (pat, p) => toRegex(pat).test(normPath(p));

test('* stays within one segment', () => {
  assert.ok(m('*.png', 'a.png'));
  assert.ok(!m('*.png', 'dir/a.png'));
});

test('**/ matches zero or more leading segments', () => {
  assert.ok(m('**/.DS_Store', '.DS_Store'));
  assert.ok(m('**/.DS_Store', 'a/b/.DS_Store'));
});

test('X/** matches the dir itself and everything under it', () => {
  assert.ok(m('ops/tasks/**', 'ops/tasks'));
  assert.ok(m('ops/tasks/**', 'ops/tasks/hold/x.md'));
  assert.ok(!m('ops/tasks/**', 'ops/task'));
});

test('a trailing-slash pattern behaves like a dir prefix', () => {
  assert.ok(m('**/__pycache__/', 'ops/scripts/__pycache__'));
  assert.ok(m('**/__pycache__/', 'ops/scripts/__pycache__/x.pyc'));
});

test('git untracked-directory entries (trailing slash) normalise', () => {
  assert.equal(normPath('ops/tasks/hold/'), 'ops/tasks/hold');
  assert.ok(m('ops/tasks/**', 'ops/tasks/hold/'));
});

test('regex metacharacters in a pattern are literal', () => {
  assert.ok(m('ops/board/last-run.json', 'ops/board/last-run.json'));
  assert.ok(!m('ops/board/last-run.json', 'ops/board/lastXrun.json'));
});
