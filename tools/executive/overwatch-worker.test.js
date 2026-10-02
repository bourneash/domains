'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const eventstore = require('../fleet-dashboard/server/eventstore');
const runtime = require('./agent-runtime');
const {
  captureSnapshot,
  collectEvidence,
  classifyOutcome,
  repairHandoffs,
  repairStuckManagerTasks,
} = require('./overwatch-worker');

test('monitoring an active executive handoff succeeds without claiming delivery', () => {
  const before = {
    cycles: [{ status: 'completed' }],
    real_work: { new_active_direct_change_requests: 2, recent_verified_deliveries: 0 },
  };
  const after = {
    real_work: { verified_deliveries: 0, verified_artifacts: 0, new_direct_change_requests: 0 },
  };
  assert.deepEqual(classifyOutcome({ sandboxCode: 0, modelStatus: 'succeeded', before, after }), {
    status: 'succeeded',
    deliveryStatus: 'observing_active_delivery',
    verified: false,
    queued: false,
  });
});

test('no executive delivery or handoff remains a genuine Overwatch failure', () => {
  const before = {
    cycles: [{ status: 'failed' }],
    real_work: { new_active_direct_change_requests: 0, recent_verified_deliveries: 0 },
  };
  const after = {
    real_work: { verified_deliveries: 0, verified_artifacts: 0, new_direct_change_requests: 0 },
  };
  assert.equal(
    classifyOutcome({ sandboxCode: 0, modelStatus: 'succeeded', before, after }).status,
    'failed'
  );
  assert.equal(
    classifyOutcome({ sandboxCode: 79, modelStatus: 'failed', before, after }).deliveryStatus,
    'runner_failed'
  );
});

test('a blocked queued request does not make Overwatch healthy', () => {
  const before = {
    cycles: [{ status: 'completed' }],
    real_work: {
      new_active_direct_change_requests: 0,
      recent_verified_deliveries: 0,
      stale_eligible_direct_requests: 0,
    },
  };
  const after = {
    real_work: {
      verified_deliveries: 0,
      verified_artifacts: 0,
      new_direct_change_requests: 1,
      new_eligible_direct_change_requests: 0,
    },
  };
  assert.equal(
    classifyOutcome({ sandboxCode: 0, modelStatus: 'succeeded', before, after }).status,
    'failed'
  );
  before.real_work.stale_eligible_direct_requests = 1;
  assert.equal(
    classifyOutcome({ sandboxCode: 0, modelStatus: 'succeeded', before, after }).deliveryStatus,
    'eligible_queue_stalled'
  );
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-overwatch-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  runtime.ensureRegistry(store);
  return { root, store };
}

test('registry bootstrap provisions an independent hourly Overwatch routine', () => {
  const { store } = fixture();
  const agent = store.getAgent('fleet-exec-overwatch');
  const routine = store.listAgentRoutines({ agent_id: agent.agent_id, limit: 10 })[0];
  assert.equal(agent.role, 'exec-overwatch');
  assert.equal(agent.workspace.overwatch.aggression, 'aggressive');
  assert.equal(routine.schedule, '0 * * * *');
  assert.equal(routine.max_concurrency, 1);
  store.close();
});

test('handoff repair requeues eligible failed manager dispatches', () => {
  const { store } = fixture();
  const agent = store.createAgent({
    slug: 'fleet-operations-manager',
    name: 'Fleet Operations Manager',
    title: 'Operations Manager',
    role: 'operations-manager',
    provider: 'chatgpt',
    adapter: 'codex',
  });
  const started = runtime.beginRun(store, {
    agent_id: agent.agent_id,
    work_id: 'overwatch-test-work',
    idempotency_key: 'overwatch-test-dispatch',
  });
  const dispatch = store.getAgentDispatch(started.run.run_id);
  store.completeAgentDispatch(dispatch.dispatch_id, { status: 'failed', error: 'test failure' });
  const repaired = repairHandoffs(store);
  assert.equal(repaired.length, 1);
  assert.equal(store.getAgentDispatch(dispatch.dispatch_id).status, 'queued');
  store.close();
});

test('evidence distinguishes real work from repeated checkpoint updates', () => {
  const { store } = fixture();
  store.createExecutiveWorkItem({
    work_id: 'overwatch-test-existing',
    title: 'Existing checkpoint',
    owner: 'operations-manager',
    status: 'in_progress',
    source_type: 'system',
  });
  const evidence = collectEvidence(store);
  assert.equal(evidence.real_work.completed_work_items, 0);
  assert.equal(evidence.real_work.actionable, false);
  store.close();
});

test('evidence uses an exact baseline instead of subtracting rolling counts', () => {
  const { store } = fixture();
  const baseline = captureSnapshot(store);
  store.createExecutiveWorkItem({
    work_id: 'overwatch-new-executable',
    title: 'Implement a real site improvement',
    owner: 'engineering-manager',
    site: 'example.test',
    kind: 'implementation',
    status: 'open',
    source_type: 'operating-task',
  });
  const evidence = collectEvidence(store, { baseline, since: Date.now() - 1000 });
  assert.equal(evidence.real_work.new_work_items, 1);
  assert.equal(evidence.real_work.new_executable_work_items, 1);
  assert.equal(evidence.real_work.new_change_requests, 0);
  assert.equal(evidence.real_work.actionable, false);
  store.close();
});

test('a newly queued direct request is a handoff, not verified delivery', () => {
  const { store } = fixture();
  const baseline = captureSnapshot(store);
  store.createChangeRequest({
    site: 'example.test',
    title: 'Build a real page',
    delivery_mode: 'direct',
    status: 'queued',
  });
  const evidence = collectEvidence(store, { baseline, since: Date.now() - 1000 });
  assert.equal(evidence.real_work.new_direct_change_requests, 1);
  assert.equal(evidence.real_work.verified_deliveries, 0);
  assert.equal(evidence.real_work.verified_artifacts, 0);
  store.close();
});

test('fleet reports do not count as site delivery handoffs', () => {
  const { store } = fixture();
  const baseline = captureSnapshot(store);
  store.createChangeRequest({
    site: 'fleet',
    title: 'Fleet status report',
    delivery_mode: 'fleet_report',
    status: 'deployed',
  });
  const evidence = collectEvidence(store, { baseline, since: Date.now() - 1000 });
  assert.equal(evidence.real_work.new_change_requests, 1);
  assert.equal(evidence.real_work.new_direct_change_requests, 0);
  assert.equal(evidence.real_work.verified_deliveries, 0);
  assert.equal(evidence.real_work.actionable, false);
  store.close();
});

test('stale manager tasks are requeued and eventually escalated', () => {
  const { store } = fixture();
  const agent = store.createAgent({
    slug: 'fleet-operations-manager',
    name: 'Fleet Operations Manager',
    title: 'Operations Manager',
    role: 'operations-manager',
    provider: 'chatgpt',
    adapter: 'codex',
  });
  store.createExecutiveWorkItem({
    work_id: 'overwatch-stuck-manager-task',
    title: 'Deliver an operations change',
    owner: 'operations-manager',
    site: 'example.test',
    kind: 'implementation',
    status: 'in_progress',
    source_type: 'operating-task',
    waiting_on: 'downstream-queue',
    last_error: 'manager plan produced no executable work product',
  });
  const first = repairStuckManagerTasks(store, { max: 1, staleMs: 0 });
  assert.equal(first[0].action, 'requeued_stuck_manager');
  assert.equal(
    store.listAgentDispatches({ agent_id: agent.agent_id, status: 'queued', limit: 10 }).length,
    1
  );
  const task = store.getExecutiveWorkItem('overwatch-stuck-manager-task');
  store.updateExecutiveWorkItem(task.work_id, {
    waiting_on: 'downstream-queue',
    last_error: 'manager plan produced no executable work product',
  });
  const second = repairStuckManagerTasks(store, { max: 1, staleMs: -1 });
  assert.equal(second[0].action, 'requeued_stuck_manager');
  store.updateExecutiveWorkItem(task.work_id, {
    waiting_on: 'downstream-queue',
    last_error: 'manager plan produced no executable work product',
  });
  const third = repairStuckManagerTasks(store, { max: 1, staleMs: -1 });
  assert.equal(third[0].action, 'escalated_after_retries');
  assert.equal(store.getExecutiveWorkItem(task.work_id).status, 'blocked');
  store.close();
});
