'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('../fleet-dashboard/server/eventstore');
const heartbeat = require('./agent-heartbeat');

test('heartbeat dispatches due routines and audits watchdogs once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-heartbeat-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  const agent = store.createAgent({
    slug: 'heartbeat-agent',
    name: 'Heartbeat',
    title: 'Worker',
    role: 'engineer',
    adapter: 'codex',
  });
  store.createAgentRoutine({
    agent_id: agent.agent_id,
    name: 'due',
    schedule: '60',
    next_due_at: '2026-01-01T00:00:00.000Z',
  });
  const result = heartbeat.tick(store, { now: new Date('2026-01-01T00:00:01.000Z') });
  assert.equal(result.dispatched.length, 1);
  assert.equal(store.listAgentRoutines({ due_before: '2026-01-01T00:00:01.000Z' }).length, 0);
  assert.equal(store.list({ event_type: 'agent.heartbeat.tick' }).length, 1);
  store.close();
});
