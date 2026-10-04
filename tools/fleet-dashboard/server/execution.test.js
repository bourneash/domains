'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { cronMatches, expectedRuns, executionHistory } = require('./execution');

test('cron matching handles steps and the cron day-of-month/day-of-week rule', () => {
  assert.equal(cronMatches(new Date(2026, 8, 20, 2, 0), '0 */2 * * *'), true);
  assert.equal(cronMatches(new Date(2026, 8, 20, 3, 0), '0 */2 * * *'), false);
  assert.equal(cronMatches(new Date(2026, 8, 20, 3, 15), '15 3 1 * 0'), true); // Sunday OR day 1
});

test('expected runs preserve cron matching and inclusive minute bounds', () => {
  const from = new Date(2026, 8, 20, 1, 58);
  const to = new Date(2026, 8, 22, 3, 16);
  const schedule = '15,45 2-3 1-22 * 0,2';
  const expected = [];
  for (let at = Math.ceil(from.getTime() / 60000) * 60000; at <= to.getTime(); at += 60000) {
    if (cronMatches(new Date(at), schedule)) expected.push(at);
  }
  assert.deepEqual(expectedRuns(schedule, from, to), expected);
  assert.deepEqual(expectedRuns('invalid', from, to), []);
});

test('execution history distinguishes successful, missed, and failed expected slots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-execution-'));
  const logs = path.join(root, 'sites', 'example.com', 'ops', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(
    path.join(logs, 'promoter-2026-09-19-1000.log'),
    '=== role=promoter started at 2026-09-19T10:00:00Z ===\n=== role=promoter finished at 2026-09-19T10:00:02Z (exit=0) ===\n'
  );
  fs.writeFileSync(
    path.join(logs, 'promoter-2026-09-19-1100.log'),
    '=== role=promoter started at 2026-09-19T11:00:00Z ===\n=== role=promoter finished at 2026-09-19T11:00:02Z (exit=1) ===\n'
  );
  const history = executionHistory(root, 'example.com', 'promoter', '*/30 * * * *', {
    from: new Date('2026-09-19T10:00:00Z'),
    to: new Date('2026-09-19T11:00:00Z'),
  });
  assert.equal(history.expected, 3);
  assert.equal(history.succeeded, 1);
  assert.equal(history.failed, 1);
  assert.equal(history.missed, 1);
});

test('execution history keeps nearest-run matching within the cron tolerance window', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-execution-window-'));
  const logs = path.join(root, 'sites', 'example.com', 'ops', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(
    path.join(logs, 'promoter-2026-09-19-1003.log'),
    '=== role=promoter started at 2026-09-19T10:03:00Z ===\n=== role=promoter finished at 2026-09-19T10:03:02Z (exit=0) ===\n'
  );
  const history = executionHistory(root, 'example.com', 'promoter', '*/5 * * * *', {
    from: new Date('2026-09-19T10:00:00Z'),
    to: new Date('2026-09-19T10:05:00Z'),
  });
  assert.equal(history.expected, 2);
  assert.equal(history.succeeded, 1);
  assert.equal(history.missed, 1);
  assert.equal(history.slots[0].status, 'ok');
  assert.equal(history.slots[1].status, 'missed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('execution history skips logs untouched before its bounded read window', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-execution-log-window-'));
  const logs = path.join(root, 'sites', 'example.com', 'ops', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const oldLog = path.join(logs, 'promoter-2026-09-17-1000.log');
  const recentLog = path.join(logs, 'promoter-2026-09-19-1000.log');
  fs.writeFileSync(oldLog, 'old historical run');
  fs.writeFileSync(
    recentLog,
    '=== role=promoter started at 2026-09-19T10:00:00Z ===\n=== role=promoter finished at 2026-09-19T10:00:02Z (exit=0) ===\n'
  );
  const oldTime = new Date('2026-09-17T10:00:00Z');
  fs.utimesSync(oldLog, oldTime, oldTime);
  let logReads = 0;
  const originalRead = fs.readFileSync;
  fs.readFileSync = function (file, ...args) {
    if (String(file).startsWith(logs + path.sep)) logReads++;
    return originalRead.call(this, file, ...args);
  };
  try {
    const history = executionHistory(root, 'example.com', 'promoter', '0 * * * *', {
      from: new Date('2026-09-19T10:00:00Z'),
      to: new Date('2026-09-19T10:00:00Z'),
    });
    assert.equal(history.observed, 1);
    assert.equal(history.succeeded, 1);
    assert.equal(logReads, 1);
  } finally {
    fs.readFileSync = originalRead;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('paused roles do not create missed execution slots', () => {
  const history = executionHistory('/does-not-exist', 'example.com', 'promoter', '*/5 * * * *', {
    from: new Date('2026-09-19T10:00:00Z'),
    to: new Date('2026-09-19T11:00:00Z'),
    enabled: false,
  });
  assert.equal(history.expected, 0);
  assert.equal(history.missed, 0);
});

test('compact execution history preserves counts and the final twelve visible slots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-execution-compact-'));
  const from = new Date('2026-09-01T00:00:00Z');
  const to = new Date('2026-09-03T00:00:00Z');
  try {
    const full = executionHistory(root, 'example.com', 'promoter', '0 * * * *', { from, to });
    const compact = executionHistory(root, 'example.com', 'promoter', '0 * * * *', {
      from,
      to,
      compact: true,
    });
    for (const key of ['expected', 'observed', 'succeeded', 'failed', 'missed', 'unknown'])
      assert.equal(compact[key], full[key], key);
    assert.deepEqual(compact.slots, full.slots.slice(-12));
    assert.deepEqual(compact.extras, []);
    assert.equal(full.slots.length, 49);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
