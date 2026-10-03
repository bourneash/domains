'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gates = require('./execution-gates');

const now = Date.parse('2026-10-02T18:00:00Z');
const cleared = {
  gate_revision: 'revision-1',
  gate_clearance_revision: 'revision-1',
  hold_condition: 'Capacity ledger reconciled and one slot released',
  gate_cleared_by: 'Jesse',
  gate_cleared_at: '2026-10-02T17:59:00Z',
  gate_clearance_evidence: 'Capacity snapshot 12; slot release decision 13',
};

test('elapsed dates and incomplete clearance cannot release implementation', () => {
  assert.match(
    gates.reason({ hold_condition: 'Capacity', gate_not_before: '2026-10-01T18:00:00Z' }, { now }),
    /clearance/
  );
  assert.match(gates.reason(cleared, { now }), /explicit release/);
  const released = {
    ...cleared,
    gate_released_by: 'Jesse',
    gate_released_at: '2026-10-02T18:00:00Z',
  };
  assert.equal(gates.reason(released, { now }), null);
  assert.match(
    gates.reason({ ...released, gate_not_before: '2026-10-03T18:00:00Z' }, { now }),
    /time has not cleared/
  );
  assert.match(gates.reason({ ...released, gate_clearance_evidence: '' }, { now }), /evidence/);
  assert.match(
    gates.reason({ ...released, gate_released_at: '2026-10-02T17:58:00Z' }, { now }),
    /invalid/
  );
});

test('explicit structured gates apply to reports while legacy diagnosis prose remains readable', () => {
  assert.equal(
    gates.reason({
      delivery_mode: 'report_only',
      body: 'Diagnose: do not execute until capacity clears.',
    }),
    null
  );
  assert.match(
    gates.reason({ delivery_mode: 'report_only', hold_condition: 'Owner clearance' }),
    /clearance/
  );
  for (const body of [
    'Hold until the ledger is reconciled.',
    'Requires owner confirmation before implementation.',
    'Do not dispatch until approval.',
  ])
    assert.match(gates.reason({ body }), /prerequisite/);
});

test('malformed gate fields fail closed before persistence', () => {
  assert.throws(() => gates.validate({ gate_not_before: 'tomorrow' }), /ISO timestamp/);
  assert.throws(
    () => gates.validate({ gate_not_before: '2026-10-02T18:00:00Z' }),
    /requires hold_condition/
  );
  assert.throws(
    () => gates.validate({ hold_condition: ' ', gate_cleared_by: 'Jesse' }),
    /nonempty/
  );
  assert.throws(
    () => gates.validate({ hold_condition: 'Capacity', gate_clearance_evidence: {} }),
    /nonempty/
  );
});

test('clearance cannot authorize another scope revision', () => {
  assert.match(
    gates.reason({ ...cleared, gate_revision: 'revision-2' }, { now }),
    /stale request revision/
  );
});
