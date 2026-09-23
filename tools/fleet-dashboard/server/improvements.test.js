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
  fs.mkdirSync(path.join(root, 'sites', 'example.com', 'ops', 'tasks', 'backlog'), {
    recursive: true,
  });
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  return { root, store };
}

const action = {
  key: '0123456789abcdef0123',
  site: 'example.com',
  title: 'Improve page',
  priority: 'high',
  type: 'content-decay',
  evidence: 'Clicks fell 30%',
  recommendation: 'Refresh the page',
  plan: ['Update stale sections', 'Verify metadata'],
  score: 90,
  valueScore: 75,
};

test('starts one correlated improvement with a task and baseline', () => {
  const { root, store } = fixture();
  const first = improvements.start({
    store,
    root,
    site: 'example.com',
    action,
    baseline: { sessions: 42 },
  });
  assert.equal(first.duplicate, false);
  assert.equal(first.run.state, 'proposed');
  assert.equal(first.run.baseline.analytics.sessions, 42);
  assert.ok(
    fs.existsSync(
      path.join(root, 'sites', 'example.com', 'ops', 'tasks', 'backlog', first.run.task_file)
    )
  );
  assert.equal(
    store.list({ correlation_id: first.run.correlation_id })[0].event_type,
    'improvement.started'
  );
  const again = improvements.start({ store, root, site: 'example.com', action });
  assert.equal(again.duplicate, true);
  assert.equal(store.listImprovements().length, 1);
  store.close();
});

test('enforces lifecycle gates and measured outcomes', () => {
  const { root, store } = fixture();
  const { run } = improvements.start({ store, root, site: 'example.com', action });
  assert.throws(
    () => improvements.transition(store, run.run_id, { state: 'deployed' }),
    /cannot transition/
  );
  improvements.transition(store, run.run_id, { state: 'building', branch: 'improve/page' });
  assert.throws(
    () => improvements.transition(store, run.run_id, { state: 'review' }),
    /validation must pass/
  );
  assert.throws(
    () =>
      improvements.transition(store, run.run_id, {
        state: 'review',
        preview_url: 'javascript:alert(1)',
        validation: { passed: true },
      }),
    /preview_url/
  );
  improvements.transition(store, run.run_id, {
    state: 'review',
    validation: { passed: true, build: 'pass' },
  });
  assert.throws(
    () => improvements.transition(store, run.run_id, { state: 'deployed' }),
    /deployment_id/
  );
  improvements.transition(store, run.run_id, { state: 'deployed', deployment_id: 'abc123' });
  improvements.transition(store, run.run_id, { state: 'measuring' });
  assert.throws(
    () => improvements.transition(store, run.run_id, { state: 'proven' }),
    /measured outcome/
  );
  const done = improvements.transition(store, run.run_id, {
    state: 'proven',
    outcome: { measured_at: new Date().toISOString(), sessions_delta: 12 },
  });
  assert.equal(done.outcome.sessions_delta, 12);
  assert.equal(store.list({ correlation_id: run.correlation_id }).length, 6);
  store.close();
});

test('permits reviewer recovery when an interrupted worker left a dirty worktree', () => {
  const { root, store } = fixture();
  const { run } = improvements.start({ store, root, site: 'example.com', action });
  improvements.transition(store, run.run_id, { state: 'building', branch: 'improve/page' });
  const failed = improvements.transition(store, run.run_id, {
    state: 'failed',
    outcome: {
      error: 'worker process is no longer present in its isolated container',
    },
  });
  assert.equal(
    improvements.canRecoverInterruptedWorker(failed, {
      state: 'building',
      recover_worker: true,
      worktree_dirty: true,
    }),
    true
  );
  assert.equal(
    improvements.canRecoverInterruptedWorker(failed, {
      state: 'building',
      recover_worker: true,
      worktree_dirty: false,
    }),
    false
  );
  store.close();
});

test('compares captured and current analytics without inventing missing data', () => {
  const positive = improvements.compareOutcome(
    { sessions: 100, conversions: 2 },
    { has_data: true, window_days: 28, sessions: 112, conversions: 3 },
    '2026-09-15T00:00:00Z'
  );
  assert.equal(positive.classification, 'proven');
  assert.equal(positive.deltas.sessions.percent, 12);
  const missing = improvements.compareOutcome({ sessions: 100 }, { has_data: false });
  assert.equal(missing.classification, 'inconclusive');
  assert.equal(missing.has_data, false);
});

test('requires material changes and adequate samples before claiming an outcome', () => {
  assert.equal(
    improvements.compareOutcome({ sessions: 20 }, { has_data: true, sessions: 40 }).classification,
    'inconclusive'
  );
  assert.equal(
    improvements.compareOutcome({ sessions: 1000 }, { has_data: true, sessions: 890 })
      .classification,
    'regressed'
  );
  assert.equal(
    improvements.compareOutcome({ sessions: 1000 }, { has_data: true, sessions: 950 })
      .classification,
    'inconclusive'
  );
  assert.equal(improvements.expectedTaskColumn('building'), 'in-progress');
  assert.equal(improvements.expectedTaskColumn('proven'), 'done');
  assert.equal(improvements.expectedTaskColumn('failed'), 'hold');
});

test('records failed implementation runs as terminal audit state', () => {
  const { root, store } = fixture();
  const { run } = improvements.startManual({
    store,
    root,
    request: {
      request_id: 'request-1',
      site: 'example.com',
      title: 'Bounded change',
      body: 'Do one thing',
      category: 'engineering',
      priority: 'low',
      assigned_role: 'engineer',
      provider: 'chatgpt',
      model: 'gpt-5.6-luna',
      max_turns: 2,
    },
  });
  improvements.transition(store, run.run_id, { state: 'building' });
  const failed = improvements.transition(store, run.run_id, {
    state: 'failed',
    outcome: { failed_at: new Date().toISOString(), error: 'provider exited' },
  });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.outcome.error, 'provider exited');
  store.close();
});

test('task-routing requests reuse the referenced task instead of creating a duplicate wrapper', () => {
  const { root, store } = fixture();
  const column = path.join(root, 'sites', 'example.com', 'ops', 'tasks', 'in-progress');
  fs.mkdirSync(column, { recursive: true });
  fs.writeFileSync(
    path.join(column, 'existing-task.md'),
    '---\ntitle: Existing\n---\n\nKeep this task.\n'
  );
  const result = improvements.startManual({
    store,
    root,
    request: {
      request_id: 'task-routing-1',
      site: 'example.com',
      action_key: 'task-routing:example.com:existing-task.md',
      title: 'Route existing task',
      body: 'Edit the existing task only.',
      category: 'engineering',
      priority: 'low',
      assigned_role: 'engineer',
      provider: 'chatgpt',
      model: 'gpt-5.6-luna',
      max_turns: 2,
    },
  });
  assert.equal(result.task_file, 'existing-task.md');
  assert.equal(result.task_column, 'in-progress');
  assert.equal(result.task_reused, true);
  assert.equal(
    fs.readdirSync(path.join(root, 'sites', 'example.com', 'ops', 'tasks', 'backlog')).length,
    0
  );
  store.close();
});

test('permits only successful report-only liveness recovery from a failed run', () => {
  const { root, store } = fixture();
  const { run } = improvements.startManual({
    store,
    root,
    request: {
      request_id: 'report-recovery',
      site: 'example.com',
      title: 'Report-only recovery',
      body: 'Capture evidence',
      category: 'seo',
      priority: 'low',
      assigned_role: 'seo-analyst',
      provider: 'chatgpt',
      model: 'gpt-5.6-luna',
      max_turns: 2,
      delivery_mode: 'report_only',
    },
  });
  improvements.transition(store, run.run_id, { state: 'building' });
  const failed = improvements.transition(store, run.run_id, {
    state: 'failed',
    outcome: { error: improvements.FALSE_LIVENESS_ERROR },
  });
  store.updateImprovement(run.run_id, { agent: { status: 'completed', exit_code: 0 } });
  const completed = store.getImprovement(run.run_id);
  assert.equal(
    improvements.canRecoverReportOnly(completed, {
      state: 'reported',
      recover_report_only: true,
      delivery_mode: 'report_only',
    }),
    true
  );
  const reported = improvements.transition(store, run.run_id, {
    state: 'reported',
    recover_report_only: true,
    delivery_mode: 'report_only',
    outcome: { measured_at: new Date().toISOString(), kind: 'report-only' },
  });
  assert.equal(reported.state, 'reported');
  assert.equal(failed.state, 'failed');
  store.close();
});

test('permits report-only recovery when only the redundant reviewer rejected a completed worker', () => {
  const { root, store } = fixture();
  const { run } = improvements.startManual({
    store,
    root,
    request: {
      request_id: 'report-review-rejection',
      site: 'example.com',
      title: 'Report-only reviewer fallback',
      body: 'Capture evidence',
      category: 'seo',
      priority: 'low',
      assigned_role: 'seo-analyst',
      provider: 'chatgpt',
      model: 'gpt-5.6-luna',
      max_turns: 2,
      delivery_mode: 'report_only',
    },
  });
  improvements.transition(store, run.run_id, { state: 'building' });
  improvements.transition(store, run.run_id, {
    state: 'failed',
    outcome: { phase: 'reviewer', error: 'automatic reviewer rejected the change' },
  });
  store.updateImprovement(run.run_id, {
    agent: { phase: 'reviewer', status: 'completed', exit_code: 0 },
  });
  const failed = store.getImprovement(run.run_id);
  assert.equal(
    improvements.canRecoverReportOnly(failed, {
      state: 'reported',
      recover_report_only: true,
      delivery_mode: 'report_only',
    }),
    true
  );
  store.close();
});

test('permits bounded repair after a reviewer rejection was persisted as failed', () => {
  const { root, store } = fixture();
  const { run } = improvements.startManual({
    store,
    root,
    request: {
      request_id: 'direct-review-repair',
      site: 'example.com',
      title: 'Direct reviewer repair',
      body: 'Make one bounded change',
      category: 'seo',
      priority: 'low',
      assigned_role: 'engineer',
      provider: 'chatgpt',
      model: 'gpt-5.6-luna',
      max_turns: 2,
      delivery_mode: 'direct',
    },
  });
  improvements.transition(store, run.run_id, { state: 'building' });
  improvements.transition(store, run.run_id, {
    state: 'failed',
    outcome: { phase: 'reviewer', error: 'automatic reviewer rejected the change' },
  });
  store.updateImprovement(run.run_id, {
    agent: { phase: 'reviewer', status: 'completed', exit_code: 0 },
  });
  const failed = store.getImprovement(run.run_id);
  assert.equal(
    improvements.canRecoverReviewerFailure(failed, {
      state: 'building',
      recover_reviewer: true,
    }),
    true
  );
  const reopened = improvements.transition(store, run.run_id, {
    state: 'building',
    recover_reviewer: true,
  });
  assert.equal(reopened.state, 'building');
  store.close();
});

test('requires a complete evidence shape before recovering a report-only worker', () => {
  assert.equal(
    improvements.reportOnlyEvidenceReady(
      '## One reversible recommendation\nread-only report\n## Measurement plan\nRollback: none'
    ),
    true
  );
  assert.equal(improvements.reportOnlyEvidenceReady('read-only task\nworker interrupted'), false);
});

test('does not create duplicate manual tasks when queue delivery is retried', () => {
  const { root, store } = fixture();
  const request = {
    request_id: 'request-idempotent',
    site: 'example.com',
    title: 'Bounded change',
    body: 'Do one thing',
    category: 'engineering',
    priority: 'low',
    assigned_role: 'engineer',
    provider: 'chatgpt',
    model: 'gpt-5.6-luna',
    max_turns: 2,
  };
  const first = improvements.startManual({ store, root, request });
  const retry = improvements.startManual({ store, root, request });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.run.run_id, first.run.run_id);
  assert.equal(store.listImprovements({ source: 'fleet-dashboard' }).length, 1);
  assert.equal(
    fs.readdirSync(path.join(root, 'sites', 'example.com', 'ops', 'tasks', 'backlog')).length,
    1
  );
  store.close();
});

test('records attributed affiliate deltas without treating unmapped revenue as site revenue', () => {
  const outcome = improvements.compareOutcome(
    {
      sessions: 120,
      revenue: {
        has_data: true,
        ordered_items: 4,
        commission_income: 30,
      },
    },
    {
      has_data: false,
      revenue: {
        has_data: true,
        ordered_items: 5,
        commission_income: 36,
      },
    },
    '2026-09-22T00:00:00Z'
  );
  assert.equal(outcome.deltas.commission_income.absolute, 6);
  assert.equal(outcome.deltas.ordered_items.absolute, 1);
  assert.equal(outcome.classification, 'proven');

  const unavailable = improvements.compareOutcome(
    { revenue: { has_data: false } },
    { revenue: { has_data: false }, has_data: false }
  );
  assert.equal(unavailable.has_data, false);
  assert.equal(unavailable.classification, 'inconclusive');
});
