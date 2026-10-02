'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { shouldRunPlanning } = require('./scheduler-cadence');

function store(lastStarted, ownerCreated = [], status = 'completed') {
  return {
    listExecutiveActions: () =>
      lastStarted
        ? [
            {
              action_type: 'tick',
              status,
              started_at: lastStarted,
            },
          ]
        : [],
    listExecutiveWorkItems: () => ownerCreated.map(created_at => ({ created_at })),
  };
}

test('scheduled planning runs once per hour while owner work is unchanged', () => {
  const now = Date.parse('2026-10-02T02:00:00Z');
  assert.equal(shouldRunPlanning(store('2026-10-02T01:30:00Z'), { now }).run, false);
  assert.equal(shouldRunPlanning(store('2026-10-02T01:00:00Z'), { now }).run, true);
});

test('new owner instructions bypass planning cooldown', () => {
  const now = Date.parse('2026-10-02T02:00:00Z');
  const result = shouldRunPlanning(store('2026-10-02T01:50:00Z', ['2026-10-02T01:55:00Z']), {
    now,
  });
  assert.equal(result.run, true);
  assert.equal(result.reason, 'new owner request');
});

test('first scheduled planning cycle runs', () => {
  assert.equal(shouldRunPlanning(store(null)).run, true);
});

test('failed executive tick retries after ten minutes, not every calendar minute', () => {
  const now = Date.parse('2026-10-02T02:00:00Z');
  assert.equal(shouldRunPlanning(store('2026-10-02T01:55:00Z', [], 'failed'), { now }).run, false);
  assert.equal(
    shouldRunPlanning(store('2026-10-02T01:50:00Z', [], 'failed'), { now }).reason,
    'failed tick retry due'
  );
});

test('approved work drains before planning cooldown can skip the model pass', () => {
  const shell = fs.readFileSync(path.join(__dirname, 'run-scheduled.sh'), 'utf8');
  assert.ok(shell.indexOf('run-approved-work.sh') < shell.indexOf('scheduler-cadence'));
});

test('calendar-dispatched runs obey the same planning cooldown', () => {
  const shell = fs.readFileSync(path.join(__dirname, 'run-scheduled.sh'), 'utf8');
  assert.match(shell, /EXECUTIVE_FORCE:-0.*CALENDAR_EVENT_ID:-/);
  assert.match(shell, /complete_calendar_skip 'planning cooldown'/);
  assert.match(
    shell,
    /completeClaim\(root, id, process\.env\.CALENDAR_CLAIM_ID, \{ exit_code: 0, skipped: true, reason \}\)/
  );
});
