'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const retention = require('./retention');

const POLICY = `# leading comment that must survive an edit
version: 1

defaults:
  retain_days: 30
  delete_after_days: null

classes:
  stats_ledgers:
    label: Stats ledgers
    paths:
      - tools/cf-stats/out
    method: gzip
    retain_days: 30
    delete_after_days: null
    why: >-
      irreplaceable, nothing backs it up
  sweep_reports:
    label: Sweep reports
    paths:
      - tools/lint-fleet/reports
    method: gzip
    retain_days: 90
    delete_after_days: null
    never_touch:
      - "latest.json"
`;

function fixture(body = POLICY) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-retention-'));
  fs.mkdirSync(path.join(root, 'tools', 'retention'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'retention', 'policy.yaml'), body);
  return root;
}

test('reads every class with its own retain_days', () => {
  const d = retention.read(fixture());
  assert.equal(d.ok, true);
  const by = Object.fromEntries(d.classes.map(c => [c.name, c]));
  assert.equal(by.stats_ledgers.retain_days, 30);
  assert.equal(by.sweep_reports.retain_days, 90);
});

test('deletion is off everywhere and is not in the editable set', () => {
  // The whole point of the policy: retention means compress, not delete.
  const d = retention.read(fixture());
  for (const c of d.classes) assert.equal(c.delete_after_days, null);
  assert.deepEqual(d.editable, ['retain_days']);
});

test('an edit changes only the target class and preserves comments', () => {
  const root = fixture();
  const p = path.join(root, 'tools', 'retention', 'policy.yaml');
  const before = fs.readFileSync(p, 'utf8');
  const r = retention.setRetainDays(root, { klass: 'sweep_reports', days: 120 });
  assert.equal(r.ok, true);
  const after = fs.readFileSync(p, 'utf8');
  // Comments carry the reasoning for every number in that file; a naive
  // yaml.dump() round-trip would silently delete all of them.
  assert.ok(after.includes('# leading comment that must survive an edit'));
  assert.equal(before.split('#').length, after.split('#').length);
  const by = Object.fromEntries(retention.read(root).classes.map(c => [c.name, c]));
  assert.equal(by.sweep_reports.retain_days, 120);
  assert.equal(by.stats_ledgers.retain_days, 30, 'other classes untouched');
});

test('out-of-range and non-integer days are refused', () => {
  const root = fixture();
  for (const bad of [0, -5, 4000, 1.5, 'thirty', null]) {
    const r = retention.setRetainDays(root, { klass: 'stats_ledgers', days: bad });
    assert.equal(r.ok, false, `should refuse ${bad}`);
  }
  assert.equal(retention.read(root).classes.find(c => c.name === 'stats_ledgers').retain_days, 30);
});

test('an unknown class is refused rather than appended', () => {
  const root = fixture();
  const r = retention.setRetainDays(root, { klass: 'not_a_class', days: 30 });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown class/);
});

test('a missing policy file degrades to ok:false', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-retention-none-'));
  assert.equal(retention.read(root).ok, false);
  assert.equal(retention.setRetainDays(root, { klass: 'x', days: 30 }).ok, false);
});

test('an unparseable policy is reported, never thrown', () => {
  const root = fixture('classes:\n  - [unbalanced\n');
  const d = retention.read(root);
  assert.equal(d.ok, false);
  assert.match(d.error, /unparseable/);
});
