'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registrar = require('./registrar');

function fixture(doc, { mtimeDaysAgo = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-registrar-'));
  const dir = path.join(root, 'tools', 'registrar', 'cache');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'latest.json');
  fs.writeFileSync(f, JSON.stringify(doc));
  if (mtimeDaysAgo) {
    const when = new Date(Date.now() - mtimeDaysAgo * 86400000);
    fs.utimesSync(f, when, when);
  }
  return root;
}

test('a missing cache degrades to ok:false rather than throwing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-registrar-empty-'));
  const d = registrar._read(root);
  assert.equal(d.ok, false);
  assert.deepEqual(d.domains, []);
});

test('corrupt JSON is reported, never thrown', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-registrar-bad-'));
  const dir = path.join(root, 'tools', 'registrar', 'cache');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest.json'), '{not json');
  const d = registrar._read(root);
  assert.equal(d.ok, false);
  assert.match(d.error, /unreadable/);
});

test('a cache older than three days is flagged stale', () => {
  const fresh = registrar._read(fixture({ at: 'x', totals: {}, domains: [] }));
  assert.equal(fresh.stale, false);
  const old = registrar._read(fixture({ at: 'x', totals: {}, domains: [] }, { mtimeDaysAgo: 5 }));
  assert.equal(old.stale, true);
});

test('byDomain exposes auto_renew, not just the date', () => {
  // The date alone is not the signal: an expiry 40 days out is routine when it
  // renews itself and an emergency when it does not.
  const root = fixture({
    at: 'x',
    totals: {},
    domains: [
      { domain: 'a.com', expires_at: '2027-01-01T00:00:00.000Z', days_to_renewal: 400, auto_renew: true, attention: null },
      { domain: 'b.com', expires_at: '2026-10-01T00:00:00.000Z', days_to_renewal: 30, auto_renew: false, attention: 'auto-renew OFF and renewal due' },
    ],
  });
  const m = registrar.byDomain(root);
  assert.equal(m['a.com'].auto_renew, true);
  assert.equal(m['b.com'].auto_renew, false);
  assert.match(m['b.com'].attention, /auto-renew OFF/);
});

test('byDomain is empty (not throwing) when the collector has never run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-registrar-none-'));
  assert.deepEqual(registrar.byDomain(root), {});
});

test('the retrieved-vs-claimed gap survives into totals', () => {
  // Cloudflare reports more domains on the account than its list endpoint
  // returns. A renewal we cannot see is the one that bites, so the gap must not
  // be silently dropped on the way to the panel.
  const root = fixture({
    at: 'x',
    totals: { domains: 56, claimed_by_cloudflare: 66, retrieved: 56, unretrievable: 10 },
    domains: [],
  });
  const d = registrar._read(root);
  assert.equal(d.totals.unretrievable, 10);
  assert.equal(d.totals.claimed_by_cloudflare, 66);
});
