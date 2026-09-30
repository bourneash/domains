'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('../fleet-dashboard/server/eventstore');
const runtime = require('./agent-runtime');
const operatingLayer = require('./operating-layer');

test('registry bootstrap is idempotent and run sessions are resumable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-unit-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  const first = runtime.ensureRegistry(store, { model: 'test-model' });
  assert.equal(first.created.length, runtime.DEFAULT_AGENTS.length);
  assert.equal(runtime.ensureRegistry(store, { model: 'test-model' }).created.length, 0);
  const agent = store.getAgent('fleet-ceo');
  const started = runtime.beginRun(store, {
    agent_id: agent.agent_id,
    idempotency_key: 'session-1',
    work_id: 'w1',
  });
  assert.equal(
    runtime.beginRun(store, { agent_id: agent.agent_id, idempotency_key: 'session-1' }).reused,
    true
  );
  assert.equal(runtime.heartbeat(store, started.run.run_id).status, 'running');
  const finished = runtime.finish(store, started.run.run_id, {
    input_tokens: 10,
    output_tokens: 20,
    result: { ok: true },
  });
  assert.equal(finished.total_tokens, 30);
  assert.throws(() => runtime.heartbeat(store, started.run.run_id), /terminal/);
  const artifact = runtime.attachArtifact(store, finished, {
    kind: 'report',
    label: 'result',
    uri: '/tmp/result.json',
  });
  assert.equal(artifact.run_id, finished.run_id);
  store.close();
});

test('two failed manager deliveries pause the lane and block new dispatches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-accountability-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  runtime.ensureRegistry(store, { model: 'test-model' });
  operatingLayer.ensureOperatingTeam(store);
  const agent = store.getAgent('fleet-operations-manager');
  for (const key of ['accountability-1', 'accountability-2']) {
    const started = runtime.beginRun(store, {
      agent_id: agent.agent_id,
      idempotency_key: key,
      work_id: key,
    });
    runtime.finish(store, started.run.run_id, {
      status: 'succeeded',
      result: { passes: [{ role: 'delivery-lead' }] },
    });
    runtime.finish(store, started.run.run_id, {
      status: 'failed',
      error: 'failed_to_deliver: no executable output',
      result: { delivery_status: 'failed_to_deliver' },
    });
  }
  const paused = store.getAgent(agent.agent_id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.workspace.accountability.consecutive_failures, 2);
  assert.throws(
    () => runtime.beginRun(store, { agent_id: agent.agent_id, idempotency_key: 'blocked-next' }),
    /agent is paused/
  );
  store.close();
});
