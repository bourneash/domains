const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const webvitals = require('./webvitals');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-web-vitals-'));
  const reports = path.join(root, 'tools/web-vitals/reports');
  fs.mkdirSync(reports, { recursive: true });
  fs.mkdirSync(path.join(root, 'tools/scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools/scripts/vitals-sweep-cron.sh'), '#!/bin/sh\n');
  const at = '2026-09-21T12:00:00Z';
  for (const factor of ['mobile', 'desktop']) {
    fs.writeFileSync(
      path.join(reports, `latest-${factor}.json`),
      JSON.stringify({
        at,
        form_factor: factor,
        budgets: {},
        totals: { sites: 1 },
        sites: [
          {
            site: 'example.com',
            error: null,
            metrics: {
              performance: factor === 'mobile' ? 0.99 : 0.98,
              lcp_ms: 1500,
              cls: 0,
              tbt_ms: 40,
            },
            budget_breaches: [],
            regressions: [],
          },
        ],
      })
    );
  }
  fs.writeFileSync(
    path.join(reports, 'history.jsonl'),
    JSON.stringify({
      at,
      site: 'example.com',
      form_factor: 'mobile',
      performance: 0.99,
      lcp_ms: 1500,
      cls: 0,
      tbt_ms: 40,
    }) + '\n'
  );
  return root;
}

test('snapshot keeps mobile and desktop baselines separate and includes trend data', () => {
  const result = webvitals.snapshot(fixture(), Date.parse('2026-09-21T12:01:00Z'));
  assert.equal(result.sites.length, 1);
  assert.equal(result.sites[0].mobile.metrics.lcp_ms, 1500);
  assert.equal(result.sites[0].desktop.metrics.performance, 0.98);
  assert.equal(result.sites[0].mobile.trend.length, 1);
  assert.equal(result.factors.mobile.age_seconds, 60);
});

test('snapshot preserves explicit skipped-site rows', () => {
  const root = fixture();
  const file = path.join(root, 'tools/web-vitals/reports/latest-mobile.json');
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  report.sites.push({
    site: 'gated.example',
    status: 'skipped',
    error: null,
    reason: 'access_gated',
    warnings: [],
  });
  fs.writeFileSync(file, JSON.stringify(report));
  const result = webvitals.snapshot(root, Date.parse('2026-09-21T12:01:00Z'));
  assert.equal(result.sites.find(row => row.site === 'gated.example').mobile.reason, 'access_gated');
});

test('run queues the matching fleet scheduler job without launching a local process', async () => {
  const root = fixture();
  const calls = [];
  const result = await webvitals.run(root, 'desktop', async (method, route, query) => {
    calls.push({ method, route, query });
    if (route === 'jobs') return { status: 200, data: [{ id: 42, name: 'vitals-sweep-cron-2' }] };
    return { status: 200, data: { run_id: 99 } };
  });
  assert.equal(result.run_id, 99);
  assert.deepEqual(calls, [
    { method: 'GET', route: 'jobs', query: { site: 'fleet' } },
    { method: 'POST', route: 'jobs/42/run', query: {} },
  ]);
});
