'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { accessibilityStructureCheck } = require('./server');

test('preview structure accepts server-rendered landmarks', () => {
  assert.deepEqual(
    accessibilityStructureCheck('<html lang="en"><main><h1>Home</h1></main></html>'),
    { status: 'pass' }
  );
});

test('preview structure accepts a language-tagged client-rendered shell', () => {
  const result = accessibilityStructureCheck('<html lang="en"><body><div id="root"></div></body></html>');
  assert.equal(result.status, 'pass');
  assert.match(result.evidence, /client-rendered application shell/);
});

test('preview structure still rejects incomplete documents', () => {
  const result = accessibilityStructureCheck('<html><body><div id="app"></div></body></html>');
  assert.equal(result.status, 'fail');
  assert.match(result.evidence, /lang/);
});
