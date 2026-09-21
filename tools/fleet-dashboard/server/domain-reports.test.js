'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const reports = require('./domain-reports');

function intelligence() {
  return {
    sources: {
      analytics: { ok: true, observed_at: '2026-09-21T00:00:00Z' },
      seo_intelligence: { ok: true, observed_at: '2026-09-21T00:00:00Z' },
      revenue: { ok: true, observed_at: '2026-09-21T00:00:00Z' },
      ai_usage: { ok: true, observed_at: '2026-09-21T00:00:00Z' },
      operations: { ok: true, observed_at: '2026-09-21T00:00:00Z' },
    },
    decision_support: {
      analytics: { sites: { 'example.com': { configured: true, ga4: { status: 'ok' } } } },
      seo: { sites: [{ site: 'example.com', high: 1, clicks: 3, conversions: 1 }] },
      ai_usage: { by_site: [{ site: 'example.com', errors: 2 }] },
      priorities: { scorecards: [{ site: 'example.com', opportunity_score: 4 }] },
    },
  };
}

test('domain reports are exception-first and preserve unavailable evidence', () => {
  const row = reports.siteReport('example.com', intelligence(), 'six_hour');
  assert.equal(row.classification, 'exception');
  assert.deepEqual(row.exceptions.sort(), ['ai_errors_observed', 'high_priority_seo_actions']);
  assert.equal(row.metrics.analytics.configured, true);
  assert.match(row.interpretation, /Measured exception/);
});

test('report cadence contract rejects invalid cadences', async () => {
  await assert.rejects(
    reports.generate({ root: '/tmp/does-not-exist', cadence: 'monthly' }),
    /invalid report cadence/
  );
});
