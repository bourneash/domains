'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dataquality = require('./dataquality');

test('distinguishes missing data from zero and reports completeness', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-quality-'));
  fs.mkdirSync(path.join(root, 'registry'));
  fs.writeFileSync(
    path.join(root, 'registry', 'fleet.yaml'),
    'sites:\n  a.com:\n    status: live\n    capabilities: [analytics]\n  b.com:\n    status: live\n    capabilities: [analytics]\n'
  );
  const out = dataquality.assess({
    root,
    discoveredSites: ['a.com', 'b.com'],
    analyticsHealth: {
      sites: {
        'a.com': { ga4: { status: 'ok', last_fetch_at: '2026-09-15T00:00:00Z' } },
      },
    },
    seo: { upstream: { ok: true }, sources: { analyticsConfigured: 1 } },
    revenue: { has_data: false, message: 'not connected' },
    aiUsage: { by_site: [{ site: 'a.com' }] },
  });
  const analytics = out.contracts.find(r => r.source === 'analytics');
  assert.equal(analytics.completeness, 0.5);
  assert.equal(analytics.status, 'yellow');
  assert.equal(out.contracts.find(r => r.source === 'amazon-revenue').status, 'red');
  assert.deepEqual(out.coverage.analytics.missing_sites, ['b.com']);
  assert.match(out.coverage.analytics.next_action, /Provision or verify/);
});

test('does not count an analytics row with no successful source as observed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-quality-null-source-'));
  fs.mkdirSync(path.join(root, 'registry'));
  fs.writeFileSync(
    path.join(root, 'registry', 'fleet.yaml'),
    'sites:\n  a.com:\n    status: live\n    capabilities: [analytics]\n'
  );
  const out = dataquality.assess({
    root,
    discoveredSites: ['a.com'],
    analyticsHealth: { sites: { 'a.com': { ga4: null, gsc: null } } },
  });
  const analytics = out.contracts.find(r => r.source === 'analytics');
  assert.equal(analytics.observed, 0);
  assert.deepEqual(out.coverage.analytics.missing_sites, ['a.com']);
});

test('uses the managed-site scope when assessing analytics coverage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-quality-scope-'));
  fs.mkdirSync(path.join(root, 'registry'));
  fs.writeFileSync(
    path.join(root, 'registry', 'fleet.yaml'),
    'sites:\n  excluded.example:\n    status: live\n    capabilities: [analytics]\n  managed.example:\n    status: live\n    capabilities: [analytics]\n'
  );
  const out = dataquality.assess({
    root,
    discoveredSites: ['managed.example'],
    analyticsHealth: {
      sites: {
        'excluded.example': { ga4: null, gsc: null },
        'managed.example': { ga4: null, gsc: null },
      },
    },
  });
  const analytics = out.contracts.find(r => r.source === 'analytics');
  assert.equal(analytics.expected, 1);
  assert.deepEqual(out.coverage.analytics.missing_sites, ['managed.example']);
});

test('surfaces unmapped affiliate IDs as an attribution action', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-quality-revenue-'));
  fs.mkdirSync(path.join(root, 'registry'));
  fs.writeFileSync(
    path.join(root, 'registry', 'fleet.yaml'),
    'sites:\n  a.com:\n    status: live\n    capabilities: [analytics]\n'
  );
  const out = dataquality.assess({
    root,
    discoveredSites: ['a.com'],
    analyticsHealth: { sites: { 'a.com': {} } },
    revenue: {
      has_data: true,
      attribution_complete: false,
      attribution: [
        { site: 'a.com', tracking_id: 'a-20' },
        { tracking_id: 'other', commission_income: 4.92 },
      ],
    },
  });
  assert.deepEqual(out.coverage.revenue_attribution.unmapped_tracking_ids, ['other']);
  assert.ok(out.next_actions.includes('resolve affiliate tracking-ID attribution'));
});

test('does not turn an Amazon aggregate Other row into a false site mapping blocker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-quality-aggregate-'));
  fs.mkdirSync(path.join(root, 'registry'));
  fs.writeFileSync(
    path.join(root, 'registry', 'fleet.yaml'),
    'sites:\n  a.com:\n    status: live\n    capabilities: [analytics]\n'
  );
  const out = dataquality.assess({
    root,
    discoveredSites: ['a.com'],
    analyticsHealth: { sites: { 'a.com': {} } },
    revenue: {
      has_data: true,
      attribution_complete: true,
      site_level_attribution_complete: true,
      attribution: [
        { site: 'a.com', tracking_id: 'a-20', attribution_scope: 'site' },
        { tracking_id: 'other', attribution_scope: 'aggregate', commission_income: 4.92 },
      ],
    },
  });
  const contract = out.contracts.find(row => row.source === 'revenue-attribution');
  assert.equal(contract.status, 'green');
  assert.deepEqual(out.coverage.revenue_attribution.unmapped_tracking_ids, []);
  assert.deepEqual(out.coverage.revenue_attribution.aggregate_tracking_ids, ['other']);
  assert.equal(out.next_actions.includes('resolve affiliate tracking-ID attribution'), false);
});
