'use strict';
const test = require('node:test');
const assert = require('node:assert');
const r = require('./relay');

function reset() { r.buffers.clear(); r.outages.clear(); }

test('DNS failures are classified as resolution, not as a site bug', () => {
  const c = r.classify(['Get "https://girlpain.com/": dial tcp: lookup girlpain.com on 127.0.0.11:53: no such host']);
  assert.match(c.label, /DNS did not resolve/);
  assert.match(c.hint, /custom-domain record/);
});

test('an empty error list means the status condition failed, not a monitor artefact', () => {
  const c = r.classify([]);
  assert.match(c.label, /Unexpected HTTP status/);
  assert.match(c.hint, /real application\/routing failure/);
});

test('an unrecognised error is passed through verbatim, never guessed at', () => {
  const c = r.classify(['some novel transport explosion']);
  assert.equal(c.label, 'some novel transport explosion');
  assert.equal(c.hint, null);
});

test('all-checks-down reads as site-wide; a subset reads as page-scoped', () => {
  assert.match(r.scopeSentence(9, 9), /site-wide/);
  assert.match(r.scopeSentence(1, 9), /still passing/);
  assert.match(r.scopeSentence(1, 9), /scoped to the page named above/);
  assert.equal(r.scopeSentence(1, 1), '');
});

test('nine endpoints failing in one window collapse to a single grouped message', () => {
  reset();
  const names = ['Homepage','Guides index','Picks index','About','Contact','Affiliate disclosure','Privacy','Terms','Sitemap'];
  for (const n of names) {
    r.ingest({ site: 'girlpain.com', channel: 'domain-girlpain-com', name: n, total: 9,
      resolved: false, errors: ['dial tcp: lookup girlpain.com on 127.0.0.11:53: no such host'] });
  }
  assert.equal(r.buffers.size, 1, 'one buffered message, not nine');
  const buf = [...r.buffers.values()][0];
  assert.equal(buf.triggered.size, 9);
  const msg = r.buildTriggered('girlpain.com', [...buf.triggered.values()], 9);
  assert.match(msg.text, /9 of 9 checks down/);
  assert.match(msg.text, /site-wide/);
  assert.match(msg.text, /\+4 more/, 'long lists are truncated');
});

test('the same endpoint alerting twice in a window does not duplicate a line', () => {
  reset();
  for (let i = 0; i < 3; i++) {
    r.ingest({ site: 'x.com', channel: 'c', name: 'Homepage', total: 2, resolved: false, errors: [] });
  }
  assert.equal([...r.buffers.values()][0].triggered.size, 1);
});

test('resolution reports how long the site was actually down', () => {
  reset();
  r.buildTriggered('girlpain.com', [{ name: 'Homepage', errors: [] }], 9);
  r.outages.get('girlpain.com').since = Date.now() - 55 * 60 * 1000;
  const msg = r.buildResolved('girlpain.com', [{ name: 'Homepage', errors: [] }], 9);
  assert.match(msg.text, /recovered/);
  assert.match(msg.text, /Down for:\* 55m/);
  assert.equal(r.outages.has('girlpain.com'), false, 'outage cleared on full recovery');
});

test('a partial recovery says so instead of claiming the site is healthy', () => {
  reset();
  r.buildTriggered('s.com', [{ name: 'A', errors: [] }, { name: 'B', errors: [] }], 5);
  const msg = r.buildResolved('s.com', [{ name: 'A', errors: [] }], 5);
  assert.match(msg.text, /1 check recovered, 1 still down/);
  assert.equal(msg.color, '#e8912d');
  assert.equal(r.outages.get('s.com').count, 1);
});

test('durations render in human units', () => {
  assert.equal(r.humanDuration(30_000), 'under a minute');
  assert.equal(r.humanDuration(55 * 60_000), '55m');
  assert.equal(r.humanDuration(125 * 60_000), '2h05m');
});

test('separate sites never merge into one message', () => {
  reset();
  r.ingest({ site: 'a.com', channel: 'ca', name: 'Homepage', total: 1, resolved: false, errors: [] });
  r.ingest({ site: 'b.com', channel: 'cb', name: 'Homepage', total: 1, resolved: false, errors: [] });
  assert.equal(r.buffers.size, 2);
});

test('a body carrying the real Gatus DNS error survives parsing intact', () => {
  // This exact string broke a JSON body: it contains double quotes AND colons.
  const raw = [
    'channel: domain-girlpain-com',
    'site: girlpain.com',
    'name: Homepage',
    'url: https://girlpain.com/',
    'total: 9',
    'status: TRIGGERED',
    'errors: [Get "https://girlpain.com/": dial tcp: lookup girlpain.com on 127.0.0.11:53: no such host]',
  ].join('\n');
  const evt = r.parseBody(raw);
  assert.equal(evt.site, 'girlpain.com');
  assert.equal(evt.total, '9');
  assert.equal(evt.status, 'TRIGGERED');
  const errs = r.parseErrors(evt.errors);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /no such host/);
  assert.match(r.classify(errs).label, /DNS did not resolve/);
});

test('an empty Gatus error list is a condition failure, not an unknown error', () => {
  const evt = r.parseBody('channel: c\nsite: s.com\nname: Homepage\ntotal: 3\nstatus: TRIGGERED\nerrors: []');
  assert.deepEqual(r.parseErrors(evt.errors), []);
  assert.match(r.classify(r.parseErrors(evt.errors)).label, /Unexpected HTTP status/);
});

test('a multi-line error body is absorbed whole rather than truncated', () => {
  const evt = r.parseBody('channel: c\nsite: s.com\nname: A\nstatus: TRIGGERED\nerrors: [line one\nline two: with colon]');
  assert.match(evt.errors, /line two: with colon/);
});
