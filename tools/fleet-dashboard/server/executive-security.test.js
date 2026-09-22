'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const security = require('./executive-security');

test('builds a bounded read-only security baseline for managed sites', () => {
  const result = security.collect({ sites: ['example.com'] });
  assert.deepEqual(result.scope.sites, ['example.com']);
  assert.equal(result.sitefacts.sites.length, 1);
  assert.ok(Array.isArray(result.limitations));
  assert.ok(Object.hasOwn(result, 'fleet_doctor'));
});
