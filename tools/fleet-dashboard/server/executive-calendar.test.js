'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cal = require('./executive-calendar');

test('calendar events persist, become overdue, and can be picked up/completed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'executive-calendar-'));
  const e = cal.create(root, { title: 'Review investigation', at: '2020-01-01T00:00:00Z', action: { type: 'reminder' } });
  assert.equal(cal.reconcile(root)[0].state, 'overdue');
  assert.equal(cal.transition(root, e.id, 'picked_up').state, 'picked_up');
  assert.equal(cal.transition(root, e.id, 'completed', { followup_status: 'written', followup_note: 'Write the findings into the next brief.' }).followup_note, 'Write the findings into the next brief.');
});

test('calendar validates action and timestamp', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'executive-calendar-'));
  assert.throws(() => cal.create(root, { title: 'x', at: 'later', action: { type: 'shell' } }), /ISO|unsupported/);
});

test('claims are idempotent and only the claim owner can complete an action', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'executive-calendar-'));
  const e = cal.create(root, { title: 'Run once', at: '2020-01-01T00:00:00Z', action: { type: 'executive-run' } });
  const claims = cal.claimDue(root, Date.now());
  assert.equal(claims.length, 1);
  assert.equal(cal.claimDue(root, Date.now()).length, 0);
  assert.throws(() => cal.completeClaim(root, e.id, 'wrong', { exit_code: 0 }), /claim/);
  const done = cal.completeClaim(root, e.id, claims[0].claim_id, { exit_code: 0 });
  assert.equal(done.state, 'completed');
});

test('arbitrary scripts and invalid transitions are rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'executive-calendar-'));
  assert.throws(() => cal.create(root, { title: 'x', at: '2030-01-01T00:00:00Z', action: { type: 'run-script', script: 'rm.sh' } }), /unsupported/);
  const e = cal.create(root, { title: 'x', at: '2030-01-01T00:00:00Z' });
  assert.throws(() => cal.transition(root, e.id, 'completed', { followup_status: 'none' }), /cannot transition/);
});
