'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const recovery = require('./executive-run-recovery');

const startedAt = new Date('2026-09-28T01:00:00.000Z').toISOString();
const run = {
  status: 'started',
  target_type: 'manual-executive-run',
  started_at: startedAt,
  result: { pid: 1234 },
};

test('does not orphan a detached run during its bounded startup/pass grace period', () => {
  assert.equal(
    recovery.isOrphanedManualRun(run, {
      now: Date.parse(startedAt) + 5 * 60 * 1000,
      pidAlive: () => false,
    }),
    false
  );
});

test('marks a dead manual run orphaned only after the grace period', () => {
  assert.equal(
    recovery.isOrphanedManualRun(run, {
      now: Date.parse(startedAt) + recovery.MANUAL_RUN_ORPHAN_GRACE_MS + 1,
      pidAlive: () => false,
    }),
    true
  );
});

test('keeps a live manual run active after the grace period', () => {
  assert.equal(
    recovery.isOrphanedManualRun(run, {
      now: Date.parse(startedAt) + recovery.MANUAL_RUN_ORPHAN_GRACE_MS + 1,
      pidAlive: () => true,
    }),
    false
  );
});
