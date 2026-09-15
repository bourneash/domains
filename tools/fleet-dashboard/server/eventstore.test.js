'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('./eventstore');

test('records and follows a durable causal chain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-events-'));
  const store = eventstore.open(dir, { file: path.join(dir, 'events.sqlite') });
  store.record({ event_id: 'signal-1', event_type: 'signal.detected', source: 'seo-intelligence', site_id: 'site:example.com', entity_type: 'recommendation', entity_id: 'rec-1', correlation_id: 'chain-1', payload: { score: 88 } });
  store.record({ event_id: 'task-evt-1', event_type: 'recommendation.task_filed', source: 'seo-intelligence', site_id: 'site:example.com', entity_type: 'task', entity_id: 'task-1', correlation_id: 'chain-1', causation_id: 'signal-1' });
  const rows = store.list({ correlation_id: 'chain-1' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].entity_id, 'task-1');
  assert.equal(rows[1].payload.score, 88);
  store.close();
});

test('rejects unbounded event vocabulary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-events-'));
  const store = eventstore.open(dir, { file: path.join(dir, 'events.sqlite') });
  assert.throws(() => store.record({ event_type: 'bad type', source: 'test' }), /invalid event_type/);
  store.close();
});

test('persists and updates improvement runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-improvements-'));
  const store = eventstore.open(dir, { file: path.join(dir, 'events.sqlite') });
  const created = store.createImprovement({ site: 'example.com', source: 'test-source',
    source_id: 'signal-1', title: 'Improve landing page', baseline: { sessions: 10 } });
  assert.equal(created.state, 'proposed');
  assert.equal(store.listImprovements({ site: 'example.com' })[0].baseline.sessions, 10);
  const updated = store.updateImprovement(created.run_id, { state: 'building', branch: 'improve/landing' });
  assert.equal(updated.branch, 'improve/landing');
  assert.equal(store.getImprovement(created.run_id).state, 'building');
  store.close();
});
