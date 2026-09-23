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
