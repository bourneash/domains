'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const aiusage = require('./aiusage');

const ROOT = path.resolve(__dirname, '..', '..', '..');

test('scriptPath resolves the fleet canonical aggregator', () => {
  assert.equal(aiusage.scriptPath(ROOT), path.join(ROOT, 'tools', 'ai-usage', 'aggregate.py'));
});

test('fleet returns a summary with fleet site counts', async () => {
  const data = await aiusage.fleet(ROOT);
  assert.ok(data.summary.sites_total > 0);
  assert.ok(Array.isArray(data.summary.sites_uninstrumented));
  assert.ok(Array.isArray(data.by_site));
  assert.ok(Array.isArray(data.by_site_role));
  assert.ok(Array.isArray(data.by_day));
  assert.ok(Array.isArray(data.coverage));
  assert.equal(data.coverage.length, data.summary.sites_total);
  assert.ok(data.generated_at);
});

test('fleet accepts an inclusive UTC date range for dashboard time-frame controls', async () => {
  const data = await aiusage.fleet(ROOT, { from: '2026-07-01', to: '2026-07-30' });
  assert.deepEqual(data.filters, { from: '2026-07-01', to: '2026-07-30' });
  assert.ok(Array.isArray(data.by_day_site_role));
});
