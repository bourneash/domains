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
