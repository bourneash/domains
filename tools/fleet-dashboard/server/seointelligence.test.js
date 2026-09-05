'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const seo = require('./seointelligence');

test('aggregateQueries weights position by impressions and derives CTR', () => {
  const rows = seo.aggregateQueries([
    { dim_key: 'blue widgets', clicks: 2, impressions: 100, position: 8 },
    { dim_key: 'blue widgets', clicks: 3, impressions: 50, position: 14 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].impressions, 150);
  assert.equal(rows[0].clicks, 5);
  assert.equal(rows[0].position, 10);
  assert.equal(Math.round(rows[0].ctr * 1000), 33);
});

test('queryActions produces an evidence-backed striking-distance action', () => {
  const actions = seo.queryActions('example.com', [
    { dim_key: 'widget guide', clicks: 8, impressions: 800, position: 9.2 },
  ]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'striking-distance');
  assert.equal(actions[0].site, 'example.com');
  assert.match(actions[0].evidence, /800 impressions/);
  assert.ok(actions[0].score >= 48);
});

test('queryActions does not invent an opportunity from tiny samples', () => {
  assert.deepEqual(seo.queryActions('example.com', [
    { dim_key: 'rare term', clicks: 0, impressions: 4, position: 8 },
  ]), []);
});

test('normalizePage joins canonical GSC URLs to GA4 paths', () => {
  assert.equal(seo.normalizePage('example.com', 'https://example.com/guides/widget/?utm_source=x'), '/guides/widget');
  assert.equal(seo.normalizePage('example.com', '/guides/widget/'), '/guides/widget');
  assert.equal(seo.normalizePage('example.com', '(not set)'), null);
});

test('pageActions combines search demand with conversion value', () => {
  const actions = seo.pageActions('example.com', [{
    dim_key: 'https://example.com/guides/widget/', clicks: 5, impressions: 500, position: 8,
  }], [{
    dim_key: '/guides/widget', sessions: 120, views: 160, engaged_sessions: 70, conversions: 2,
  }]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'page-opportunity');
  assert.equal(actions[0].page, '/guides/widget');
  assert.ok(actions[0].valueScore > 0);
  assert.match(actions[0].evidence, /2 conversions/);
});

test('pageActions flags high-traffic zero-conversion engagement risk', () => {
  const actions = seo.pageActions('example.com', [], [{
    dim_key: '/confusing', sessions: 100, views: 120, engaged_sessions: 20, conversions: 0,
  }]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'engagement-risk');
  assert.match(actions[0].evidence, /20% engaged/);
});

test('pageDecayActions compares non-overlapping 28-day periods', () => {
  const rows = [];
  for (let day = 10; day <= 23; day++) {
    rows.push({ date: `2026-07-${day}`, dim_key: '/declining', sessions: 5, conversions: 1 });
  }
  for (let day = 5; day <= 18; day++) {
    rows.push({ date: `2026-08-${String(day).padStart(2, '0')}`, dim_key: '/declining', sessions: 2, conversions: 0 });
  }
  const actions = seo.pageDecayActions('example.com', rows, new Date('2026-09-01T12:00:00Z'));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'content-decay');
  assert.match(actions[0].evidence, /down 60%/);
});

test('actionPlan provides concrete execution and verification steps', () => {
  const plan = seo.actionPlan({ type: 'content-decay', recommendation: 'Refresh it.' });
  assert.equal(plan.length, 3);
  assert.match(plan[2], /baseline/);
});

test('buildSnapshot joins page sources and emits ranked plans', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-snapshot-'));
  const fetchImpl = async url => {
    let payload;
    if (url.includes('/metrics/health')) payload = { sites: {
      'example.com': { gsc: { status: 'ok' }, ga4: { status: 'ok' } },
    } };
    else if (url.includes('grain=query')) payload = { records: [] };
    else if (url.includes('grain=site')) payload = { records: [] };
    else if (url.includes('/metrics/gsc') && url.includes('grain=page')) payload = { records: [{
      date: '2026-08-31', dim_key: 'https://example.com/guide/', clicks: 4,
      impressions: 200, position: 7,
    }] };
    else if (url.includes('/metrics/ga4') && url.includes('grain=page')) payload = { records: [{
      date: '2026-08-31', dim_key: '/guide', sessions: 80, views: 100,
      engaged_sessions: 50, conversions: 2,
    }] };
    else throw new Error(`unexpected URL ${url}`);
    return { ok: true, status: 200, json: async () => payload };
  };
  const snapshot = await seo.buildSnapshot({
    root, fetchImpl, force: true, now: new Date('2026-09-01T12:00:00Z'),
  });
  assert.equal(snapshot.totals.pagesMeasured, 1);
  assert.equal(snapshot.totals.conversions, 2);
  assert.equal(snapshot.sources.gscPageSites, 1);
  assert.equal(snapshot.sources.ga4PageSites, 1);
  assert.equal(snapshot.actions[0].type, 'page-opportunity');
  assert.ok(snapshot.actions[0].rankScore >= snapshot.actions[0].score);
  assert.equal(snapshot.actions[0].plan.length, 3);
});

test('trendActions requires complete weeks and flags a material click decline', () => {
  const rows = [];
  for (let day = 1; day <= 14; day++) {
    rows.push({ date: `2026-08-${String(day).padStart(2, '0')}`, clicks: day <= 7 ? 10 : 5 });
  }
  const actions = seo.trendActions('example.com', rows);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].priority, 'high');
  assert.match(actions[0].title, /50%/);
});

test('webVitalsActions consolidates multiple breaches into one site action', () => {
  const actions = seo.webVitalsActions({ form_factor: 'mobile', sites: [{
    site: 'example.com', error: null, metrics: { performance: 0.7, lcp_ms: 4200, cls: 0, tbt_ms: 50 },
    budget_breaches: ['performance', 'lcp_ms'],
  }] });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].priority, 'high');
  assert.match(actions[0].evidence, /LCP 4200ms/);
});

test('linkActions turns a missing sitemap into a crawlability action', () => {
  const actions = seo.linkActions({ sites: [{ site: 'example.com', error: 'no sitemap', findings: [] }] });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'crawlability');
  assert.equal(actions[0].priority, 'high');
});

test('filedActionKeys finds durable task markers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-intel-'));
  const dir = path.join(root, 'sites', 'example.com', 'ops', 'tasks', 'backlog');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'task.md'), 'seo-intelligence-key: abcdef0123456789abcd\n');
  assert.deepEqual([...seo.filedActionKeys(root, ['example.com'])], ['abcdef0123456789abcd']);
});
