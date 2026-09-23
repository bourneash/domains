'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('./eventstore');
const improvements = require('./improvements');
const measurement = require('./measurement-runner');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'improvement-measurement-'));
  fs.mkdirSync(path.join(root, 'sites', 'example.com', 'ops', 'tasks', 'backlog'), {
    recursive: true,
  });
  const store = eventstore.open(root);
  const createdAt = '2026-09-01T00:00:00.000Z';
  store.createImprovement({
    run_id: 'run-1',
    site: 'example.com',
    source: 'fleet-dashboard',
    source_id: 'request-1',
    title: 'Bounded SEO change',
    state: 'deployed',
    created_at: createdAt,
    measurement_due: '2026-09-15',
    deployment_id: 'abc123',
    baseline: {
      captured_at: createdAt,
      analytics: { sessions: 100, impressions: 50, clicks: 2, conversions: 0 },
    },
    approval: { approved_at: createdAt },
  });
  store.close();
  return root;
}

test('measures after the day gate and preserves the gate evidence', async () => {
  const root = fixture();
  const result = await measurement.run({
    root,
    now: new Date('2026-09-16T00:00:00.000Z'),
    analytics: {
      gscSeries: async () => ({ records: [{ date: '2026-09-15', impressions: 100 }] }),
      summary: async () => ({
        has_data: true,
        sessions: 120,
        impressions: 150,
        clicks: 5,
        conversions: 1,
        window_days: 14,
      }),
    },
  });
  assert.equal(result.results[0].status, 'measured');
  const store = eventstore.open(root);
  const run = store.getImprovement('run-1');
  assert.equal(run.state, 'proven');
  assert.equal(run.outcome.measurement_gate.ready_reason, '100_new_impressions');
  assert.equal(run.outcome.measurement_gate.new_impressions, 100);
  assert.equal(run.measurement_due, null);
  store.close();
});

test('does not measure before either gate', async () => {
  const root = fixture();
  const result = await measurement.run({
    root,
    now: new Date('2026-09-05T00:00:00.000Z'),
    analytics: {
      gscSeries: async () => ({ records: [{ date: '2026-09-04', impressions: 2 }] }),
      summary: async () => ({ has_data: true, sessions: 100, impressions: 52 }),
    },
  });
  assert.equal(result.results[0].status, 'waiting');
  const store = eventstore.open(root);
  const run = store.getImprovement('run-1');
  assert.equal(run.state, 'measuring');
  assert.equal(run.outcome.measurement_observations.length, 1);
  assert.equal(run.outcome.measurement_observations[0].analytics.sessions, 100);
  store.close();
});

test('keeps unavailable search telemetry distinct from zero impressions', async () => {
  const root = fixture();
  const result = await measurement.run({
    root,
    now: new Date('2026-09-05T00:00:00.000Z'),
    analytics: {
      gscSeries: async () => ({ ok: false, error: 'data hub unavailable', records: [] }),
      summary: async () => ({ has_data: false }),
    },
  });
  assert.equal(result.results[0].new_impressions, null);
});

test('captures site-attributed affiliate data alongside analytics', async () => {
  const root = fixture();
  const metrics = await measurement.captureMetrics(
    root,
    'example.com',
    { summary: async () => ({ has_data: false }) },
    {
      amazonSummary: () => ({
        has_data: true,
        attribution_complete: false,
        attribution: [
          {
            site: 'example.com',
            tracking_id: 'example-20',
            rows: 1,
            clicks: 12,
            ordered_items: 4,
            shipped_items: 3,
            commission_income: 30,
          },
        ],
      }),
      siteAttribution: (summary, site) => ({ ...summary.attribution[0], site, has_data: true }),
    }
  );
  assert.equal(metrics.has_data, false);
  assert.equal(metrics.revenue.site, 'example.com');
  assert.equal(metrics.revenue.commission_income, 30);
});
