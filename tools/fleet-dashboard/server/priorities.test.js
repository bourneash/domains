'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const priorities = require('./priorities');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-priorities-'));
  fs.mkdirSync(path.join(root, 'registry'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'registry', 'fleet.yaml'),
    `sites:\n  live.example:\n    status: live\n    capabilities: [ops, analytics]\n  parked.example:\n    status: scaffold\n`
  );
  fs.mkdirSync(path.join(root, 'sites', 'live.example', 'ops', 'tasks', 'backlog'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, 'sites', 'live.example', 'ops', 'tasks', 'backlog', 'work.md'),
    `---\ntitle: Do work\nassigned_role: missing-role\n---\nBody\n`
  );
  fs.writeFileSync(
    path.join(root, 'sites', 'live.example', 'ops', 'tasks', 'backlog', 'seo.md'),
    `---\ntitle: SEO work\ntype: seo\nassigned_role: engineer\n---\nBody\n`
  );
  return root;
}

test('joins lifecycle, analytics gaps, task ownership and growth actions', () => {
  const root = fixture();
  const out = priorities.build({
    root,
    discoveredSites: ['live.example'],
    analyticsHealth: { sites: {} },
    revenue: { connected: false },
    seo: {
      actions: [
        {
          key: 'abc',
          site: 'live.example',
          title: 'Grow page',
          evidence: '100 impressions',
          rankScore: 77,
          valueScore: 42,
          filed: false,
        },
      ],
    },
  });
  assert.equal(out.coverage.live_sites, 1);
  assert.equal(out.coverage.revenue_attributed, false);
  assert.equal(out.items.find(x => x.action_key === 'abc').expected_profit_usd, null);
  assert.ok(out.items.some(x => x.source === 'analytics-health'));
  assert.ok(out.items.some(x => x.source === 'task-board' && x.state === 'blocked'));
  assert.ok(
    out.items.some(x => x.source === 'task-routing-audit' && x.task.expected_role === 'seo-analyst')
  );
  assert.equal(out.scorecards[0].profit_attributable, false);
  assert.equal(out.scorecards[0].allocation, 'repair');
});

test('does not demand production coverage from scaffold sites', () => {
  const root = fixture();
  const out = priorities.build({
    root,
    discoveredSites: ['live.example'],
    analyticsHealth: { sites: { 'live.example': {} } },
    revenue: {},
    seo: { actions: [] },
  });
  assert.ok(!out.items.some(x => x.site === 'parked.example'));
});
