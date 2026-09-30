'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const eventstore = require('../fleet-dashboard/server/eventstore');
const runtime = require('./agent-runtime');
const { collectEvidence, repairHandoffs } = require('./overwatch-worker');

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
