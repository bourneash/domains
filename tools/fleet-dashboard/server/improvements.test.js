'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('./eventstore');
const improvements = require('./improvements');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'improvement-workbench-'));
  fs.mkdirSync(path.join(root, 'sites', 'example.com', 'ops', 'tasks', 'backlog'), { recursive: true });
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  return { root, store };
}

const action = { key: '0123456789abcdef0123', site: 'example.com', title: 'Improve page',
  priority: 'high', type: 'content-decay', evidence: 'Clicks fell 30%', recommendation: 'Refresh the page',
  plan: ['Update stale sections', 'Verify metadata'], score: 90, valueScore: 75 };

test('starts one correlated improvement with a task and baseline', () => {
  const { root, store } = fixture();
  const first = improvements.start({ store, root, site: 'example.com', action, baseline: { sessions: 42 } });
  assert.equal(first.duplicate, false);
  assert.equal(first.run.state, 'proposed');
  assert.equal(first.run.baseline.analytics.sessions, 42);
  assert.ok(fs.existsSync(path.join(root, 'sites', 'example.com', 'ops', 'tasks', 'backlog', first.run.task_file)));
  assert.equal(store.list({ correlation_id: first.run.correlation_id })[0].event_type, 'improvement.started');
  const again = improvements.start({ store, root, site: 'example.com', action });
  assert.equal(again.duplicate, true);
  assert.equal(store.listImprovements().length, 1);
  store.close();
});

test('enforces lifecycle gates and measured outcomes', () => {
  const { root, store } = fixture();
  const { run } = improvements.start({ store, root, site: 'example.com', action });
  assert.throws(() => improvements.transition(store, run.run_id, { state: 'deployed' }), /cannot transition/);
  improvements.transition(store, run.run_id, { state: 'building', branch: 'improve/page' });
  assert.throws(() => improvements.transition(store, run.run_id, { state: 'review' }), /validation must pass/);
  assert.throws(() => improvements.transition(store, run.run_id, { state: 'review', preview_url: 'javascript:alert(1)', validation: { passed: true } }), /preview_url/);
  improvements.transition(store, run.run_id, { state: 'review', validation: { passed: true, build: 'pass' } });
  assert.throws(() => improvements.transition(store, run.run_id, { state: 'deployed' }), /deployment_id/);
  improvements.transition(store, run.run_id, { state: 'deployed', deployment_id: 'abc123' });
  improvements.transition(store, run.run_id, { state: 'measuring' });
  assert.throws(() => improvements.transition(store, run.run_id, { state: 'proven' }), /measured outcome/);
  const done = improvements.transition(store, run.run_id, { state: 'proven', outcome: { measured_at: new Date().toISOString(), sessions_delta: 12 } });
  assert.equal(done.outcome.sessions_delta, 12);
  assert.equal(store.list({ correlation_id: run.correlation_id }).length, 6);
  store.close();
});

test('compares captured and current analytics without inventing missing data', () => {
  const positive = improvements.compareOutcome({ sessions: 100, conversions: 2 }, { has_data: true, window_days: 28, sessions: 112, conversions: 3 }, '2026-09-15T00:00:00Z');
  assert.equal(positive.classification, 'proven');
  assert.equal(positive.deltas.sessions.percent, 12);
  const missing = improvements.compareOutcome({ sessions: 100 }, { has_data: false });
  assert.equal(missing.classification, 'inconclusive');
  assert.equal(missing.has_data, false);
});

test('requires material changes and adequate samples before claiming an outcome', () => {
  assert.equal(improvements.compareOutcome({ sessions: 20 }, { has_data: true, sessions: 40 }).classification, 'inconclusive');
  assert.equal(improvements.compareOutcome({ sessions: 1000 }, { has_data: true, sessions: 890 }).classification, 'regressed');
  assert.equal(improvements.compareOutcome({ sessions: 1000 }, { has_data: true, sessions: 950 }).classification, 'inconclusive');
  assert.equal(improvements.expectedTaskColumn('building'), 'in-progress');
  assert.equal(improvements.expectedTaskColumn('proven'), 'done');
});
