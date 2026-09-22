'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const intel = require('./executive-intel');

test('catalog covers the dashboard intelligence needed by executive roles', () => {
  const keys = new Set(intel.TOOL_CATALOG.map(item => item.key));
  for (const key of [
    'registry',
    'analytics',
    'seo_intelligence',
    'revenue',
    'ai_usage',
    'social',
    'datahub',
    'priorities',
    'operations',
    'compliance',
    'data_quality',
  ]) {
    assert.ok(keys.has(key), `missing ${key}`);
  }
});

test('removes excluded-site data at every nesting level', () => {
  const result = intel.removeExcluded({
    sites: [{ site: 'good.example' }, { site: '3boobs.com' }],
    keyed: { 'good.example': { value: 1 }, '3boobs.com': { value: 2 } },
    nested: { domain: '3boobs.com', secret: true },
  });
  assert.deepEqual(result, {
    sites: [{ site: 'good.example' }],
    keyed: { 'good.example': { value: 1 } },
  });
});

test('source wrapper preserves explicit failures instead of presenting zeros', () => {
  const result = intel.source('analytics', { ok: false, error: 'hub unavailable' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'hub unavailable');
  assert.deepEqual(result.data, { ok: false, error: 'hub unavailable' });
});
