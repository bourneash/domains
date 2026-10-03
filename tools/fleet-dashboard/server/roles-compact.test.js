'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const roles = require('./roles');

test('compact Agent health keeps only fields used by the expanded execution history', () => {
  const slots = Array.from({ length: 100 }, (_, at) => ({
    at,
    status: 'ok',
    observedAt: at + 1,
    file: `run-${at}.log`,
  }));
  const full = {
    summary: { expected: 100, missed: 4 },
    rows: [{ execution: { expected: 100, slots, extras: [{ at: 101, status: 'unknown' }] } }],
  };

  const compact = roles.compactHealth(full);

  assert.deepEqual(compact.summary, full.summary);
  assert.deepEqual(compact.rows[0].execution.slots, slots.slice(-12).map(({ at, status, observedAt }) => ({ at, status, observedAt })));
  assert.equal('extras' in compact.rows[0].execution, false);
  assert.equal(full.rows[0].execution.slots.length, 100);
  assert.equal(full.rows[0].execution.slots[0].file, 'run-0.log');
});
