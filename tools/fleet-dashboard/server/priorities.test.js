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
  fs.mkdirSync(path.join(root, 'sites', 'live.example', 'ops', 'roles'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'sites', 'live.example', 'ops', 'roles', 'news-writer.md'),
    '# News writer\n'
  );
  fs.writeFileSync(
    path.join(root, 'sites', 'live.example', 'ops', 'tasks', 'backlog', 'work.md'),
    `---\ntitle: Do work\nassigned_role: missing-role\n---\nBody\n`
  );
  fs.writeFileSync(
    path.join(root, 'sites', 'live.example', 'ops', 'tasks', 'backlog', 'work-copy.md'),
    `---\ntitle: Do work\nassigned_role: missing-role\n---\nBody\n`
  );
  fs.writeFileSync(
    path.join(root, 'sites', 'live.example', 'ops', 'tasks', 'backlog', 'seo.md'),
    `---\ntitle: SEO work\ntype: seo\nassigned_role: engineer\n---\nBody\n`
  );
  fs.writeFileSync(
    path.join(root, 'sites', 'live.example', 'ops', 'tasks', 'backlog', 'content.md'),
    `---\ntitle: Editorial work\ntype: content\nassigned_role: news-writer\n---\nBody\n`
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
  const duplicateOwnerGap = out.items.find(
    x => x.source === 'task-board' && x.title.includes('Do work')
  );
  assert.equal(duplicateOwnerGap.duplicate_count, 2);
  assert.deepEqual(duplicateOwnerGap.task.files, ['backlog/work-copy.md', 'backlog/work.md']);
  assert.ok(
    out.items.some(x => x.source === 'task-board' && x.title.includes('SEO work')),
    'missing SEO ownership must remain an owner gap'
  );
  assert.ok(
    !out.items.some(x => x.source === 'task-routing-audit' && x.title.includes('SEO work')),
    'SEO work must not be rerouted to engineer'
  );
  assert.ok(
    !out.items.some(x => x.title.includes('Editorial work') && x.source === 'task-routing-audit'),
    'installed site-equivalent roles must not become false routing blockers'
  );
  assert.equal(out.scorecards[0].profit_attributable, false);
  assert.equal(out.scorecards[0].allocation, 'repair');
});

test('returns every recommendation so totals and pagination stay complete', () => {
  const root = fixture();
  const actions = Array.from({ length: 275 }, (_, index) => ({
    key: `action-${index}`,
    site: 'live.example',
    title: `Recommendation ${index}`,
    rankScore: 50,
    valueScore: 10,
  }));
  const out = priorities.build({
    root,
    discoveredSites: ['live.example'],
    analyticsHealth: { sites: { 'live.example': {} } },
    revenue: {},
    seo: { actions, sites: [] },
  });
  assert.ok(out.items.length > 250);
  assert.equal(out.items.filter(item => item.action_key?.startsWith('action-')).length, 275);
  assert.equal(out.totals.recommendations, out.items.length);
  assert.ok(out.items.some(item => item.action_key === 'action-274'));
});

test('disabled task roles do not become executive routing candidates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-priorities-disabled-role-'));
  fs.mkdirSync(path.join(root, 'registry'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'registry', 'fleet.yaml'),
    'sites:\n  0daynews.com:\n    status: live\n    disabled_task_roles: [content-writer]\n'
  );
  fs.mkdirSync(path.join(root, 'sites', '0daynews.com', 'ops', 'tasks', 'backlog'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, 'sites', '0daynews.com', 'ops', 'tasks', 'backlog', 'route.md'),
    '---\ntitle: Reassign task to content-writer\ntype: content\nassigned_role: content-writer\n---\n'
  );
  const out = priorities.build({
    root,
    discoveredSites: ['0daynews.com'],
    seo: { actions: [], sites: [] },
    revenue: { attribution: [] },
  });
  assert.equal(
    out.items.some(item => item.site === '0daynews.com' && /content-writer/i.test(item.title)),
    false
  );
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

test('analytics coverage counts successful sources only for live analytics-enabled sites', () => {
  const root = fixture();
  const out = priorities.build({
    root,
    discoveredSites: ['live.example'],
    analyticsHealth: {
      sites: {
        'live.example': { ga4: { status: 'error' }, gsc: { status: 'not_observed' } },
        'retired.example': { ga4: { status: 'ok' } },
      },
    },
    revenue: {},
    seo: { actions: [] },
  });
  assert.equal(out.coverage.analytics_sites, 0);
  assert.equal(out.coverage.analytics_expected_sites, 1);
});
