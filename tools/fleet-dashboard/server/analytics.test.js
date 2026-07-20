'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const an = require('./analytics');

test('health() returns the upstream body verbatim on success', async () => {
  global.fetch = async (url) => {
    assert.equal(url, `${an.API}/metrics/health`);
    return { ok: true, status: 200, json: async () => ({ sites: { 'x.com': {} }, generated_at: 't' }) };
  };
  const r = await an.health();
  assert.deepEqual(r, { sites: { 'x.com': {} }, generated_at: 't' });
});

test('health() degrades to {ok:false, sites:{}} when fetch rejects', async () => {
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const r = await an.health();
  assert.equal(r.ok, false);
  assert.deepEqual(r.sites, {});
  assert.match(r.error, /ECONNREFUSED/);
});

test('summary(site, window) builds the correct querystring', async () => {
  let calledUrl = null;
  global.fetch = async (url) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({ site: 'x.com', window_days: 7, has_data: false }) };
  };
  await an.summary('x.com', 7);
  assert.equal(calledUrl, `${an.API}/metrics/summary?site=x.com&window=7`);
});

test('summary() degrades to {has_data:false} on failure, never fabricates data', async () => {
  global.fetch = async () => { throw new Error('down'); };
  const r = await an.summary('x.com');
  assert.equal(r.ok, false);
  assert.equal(r.has_data, false);
});

test('topGa4(site, metric, window, limit) builds source=ga4 querystring', async () => {
  let calledUrl = null;
  global.fetch = async (url) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({ top: [] }) };
  };
  await an.topGa4('x.com', 'sessions', 28, 10);
  assert.equal(calledUrl, `${an.API}/metrics/top?site=x.com&source=ga4&metric=sessions&window=28&limit=10`);
});

test('topGsc(site, metric, window, limit) builds source=gsc querystring', async () => {
  let calledUrl = null;
  global.fetch = async (url) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({ top: [] }) };
  };
  await an.topGsc('x.com', 'clicks', 28, 5);
  assert.equal(calledUrl, `${an.API}/metrics/top?site=x.com&source=gsc&metric=clicks&window=28&limit=5`);
});

test('topGa4()/topGsc() degrade to {top:[]} on failure', async () => {
  global.fetch = async () => { throw new Error('down'); };
  const ga4 = await an.topGa4('x.com', 'sessions');
  const gsc = await an.topGsc('x.com', 'clicks');
  assert.deepEqual(ga4.top, []);
  assert.deepEqual(gsc.top, []);
});

test('_splitWeeks(records) splits the trailing 14 rows into two 7-row buckets by ascending date', () => {
  const records = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.UTC(2026, 6, 20 - i)).toISOString().slice(0, 10);
    records.push({ date: d, sessions: i });
  }
  const { cur, prev } = an._splitWeeks(records);
  assert.equal(cur.length, 7);
  assert.equal(prev.length, 7);
  assert.equal(cur[0].date < cur[6].date, true);
  assert.equal(prev[6].date < cur[0].date, true);
});

test('_splitWeeks(records) handles fewer than 14 rows without throwing', () => {
  const { cur, prev } = an._splitWeeks([{ date: '2026-07-01', sessions: 1 }]);
  assert.equal(cur.length, 1);
  assert.equal(prev.length, 0);
});

test('_sum(rows, keys) sums each key across rows, treating missing values as 0', () => {
  const rows = [{ sessions: 3, users: null }, { sessions: 4 }];
  const out = an._sum(rows, ['sessions', 'users']);
  assert.deepEqual(out, { sessions: 7, users: 0 });
});

test('wow(site) omits ga4/gsc keys entirely when that source has zero rows (absence is not zero)', async () => {
  global.fetch = async (url) => {
    if (url.includes('/metrics/ga4')) return { ok: true, status: 200, json: async () => ({ records: [] }) };
    return { ok: true, status: 200, json: async () => ({ records: [{ date: '2026-07-19', clicks: 5, impressions: 50 }] }) };
  };
  const r = await an.wow('x.com');
  assert.equal('ga4' in r, false);
  assert.equal('gsc' in r, true);
  assert.deepEqual(r.gsc.cur, { clicks: 5, impressions: 50 });
  assert.deepEqual(r.gsc.prev, { clicks: 0, impressions: 0 });
});
