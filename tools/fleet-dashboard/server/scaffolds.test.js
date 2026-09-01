'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scaffolds = require('./scaffolds');

// Build a throwaway repo root with a registry/fleet.yaml. No git repos are
// created, so firstCommitDay() returns null everywhere — which is itself the
// case worth pinning: a registry row with no checkout on disk must degrade to
// "unknown", never to a guessed date.
function fixture(yamlBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-scaffolds-'));
  fs.mkdirSync(path.join(root, 'registry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'registry', 'fleet.yaml'), yamlBody);
  return root;
}

test('selects only status: scaffold entries', () => {
  const root = fixture(`
sites:
  live-one.com:
    status: live
    repo: bourneash/live-one.com
  parked-one.com:
    status: scaffold
    repo: bourneash/parked-one.com
    capabilities: [site, ops, social]
  parked-two.com:
    status: scaffold
    repo: bourneash/parked-two.com
`);
  const d = scaffolds._build(root);
  assert.equal(d.ok, true);
  assert.deepEqual(
    d.rows.map(r => r.domain).sort(),
    ['parked-one.com', 'parked-two.com'],
  );
  assert.equal(d.summary.scaffolds, 2);
  assert.equal(d.summary.total_registry_entries, 3);
  assert.equal(d.summary.parked_pct, 67);
});

test('renewal date is never invented — absent means null, not a guess', () => {
  const root = fixture(`
sites:
  no-date.com:
    status: scaffold
  has-date.com:
    status: scaffold
    registrar_expires: '2099-01-01'
`);
  const d = scaffolds._build(root);
  const byName = Object.fromEntries(d.rows.map(r => [r.domain, r]));
  assert.equal(byName['no-date.com'].registrar_expires, null);
  assert.equal(byName['no-date.com'].days_to_renewal, null);
  assert.equal(byName['has-date.com'].registrar_expires, '2099-01-01');
  assert.ok(byName['has-date.com'].days_to_renewal > 0);
  assert.equal(d.summary.unknown_renewal, 1);
});

test('days_parked is null when there is no checkout to date it from', () => {
  const root = fixture(`
sites:
  ghost.com:
    status: scaffold
`);
  const d = scaffolds._build(root);
  assert.equal(d.rows[0].scaffolded_on, null);
  assert.equal(d.rows[0].days_parked, null);
});

test('renewals_due_90d counts only dates inside the window', () => {
  const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const later = new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10);
  const root = fixture(`
sites:
  soon.com:
    status: scaffold
    registrar_expires: '${soon}'
  later.com:
    status: scaffold
    registrar_expires: '${later}'
`);
  const d = scaffolds._build(root);
  assert.equal(d.summary.renewals_due_90d, 1);
});

test('a missing registry degrades to ok:false rather than throwing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-scaffolds-empty-'));
  const d = scaffolds._build(root);
  assert.equal(d.ok, false);
  assert.deepEqual(d.rows, []);
});

test('an empty fleet reports 0% parked instead of dividing by zero', () => {
  const root = fixture('sites: {}\n');
  const d = scaffolds._build(root);
  assert.equal(d.ok, true);
  assert.equal(d.summary.parked_pct, 0);
  assert.equal(d.summary.oldest_days_parked, null);
});

test('the real fleet registry parses and yields rows', () => {
  const realRoot = path.resolve(__dirname, '..', '..', '..');
  if (!fs.existsSync(path.join(realRoot, 'registry', 'fleet.yaml'))) return; // not in a checkout
  const d = scaffolds._build(realRoot);
  assert.equal(d.ok, true);
  assert.ok(d.summary.total_registry_entries > 0);
  for (const r of d.rows) {
    assert.equal(typeof r.domain, 'string');
    assert.ok(Array.isArray(r.capabilities));
  }
});
