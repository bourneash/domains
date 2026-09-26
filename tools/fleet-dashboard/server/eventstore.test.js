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
  store.record({
    event_id: 'signal-1',
    event_type: 'signal.detected',
    source: 'seo-intelligence',
    site_id: 'site:example.com',
    entity_type: 'recommendation',
    entity_id: 'rec-1',
    correlation_id: 'chain-1',
    payload: { score: 88 },
  });
  store.record({
    event_id: 'task-evt-1',
    event_type: 'recommendation.task_filed',
    source: 'seo-intelligence',
    site_id: 'site:example.com',
    entity_type: 'task',
    entity_id: 'task-1',
    correlation_id: 'chain-1',
    causation_id: 'signal-1',
  });
  const rows = store.list({ correlation_id: 'chain-1' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].entity_id, 'task-1');
  assert.equal(rows[1].payload.score, 88);
  store.close();
});

test('rejects unbounded event vocabulary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-events-'));
  const store = eventstore.open(dir, { file: path.join(dir, 'events.sqlite') });
  assert.throws(
    () => store.record({ event_type: 'bad type', source: 'test' }),
    /invalid event_type/
  );
  store.close();
});

test('persists and updates improvement runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-improvements-'));
  const store = eventstore.open(dir, { file: path.join(dir, 'events.sqlite') });
  const created = store.createImprovement({
    site: 'example.com',
    source: 'test-source',
    source_id: 'signal-1',
    title: 'Improve landing page',
    baseline: { sessions: 10 },
  });
  assert.equal(created.state, 'proposed');
  assert.equal(store.listImprovements({ site: 'example.com' })[0].baseline.sessions, 10);
  const updated = store.updateImprovement(created.run_id, {
    state: 'building',
    branch: 'improve/landing',
  });
  assert.equal(updated.branch, 'improve/landing');
  assert.equal(store.getImprovement(created.run_id).state, 'building');
  store.close();
});

test('delivery claims are atomic and stale claims can be recovered', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-delivery-claims-'));
  const store = eventstore.open(dir, { file: path.join(dir, 'events.sqlite') });
  const created = store.createImprovement({
    site: 'example.com',
    source: 'test-source',
    title: 'Claim delivery',
  });
  const first = store.claimImprovementDelivery(created.run_id, {
    claimedAt: '2026-09-23T12:00:00.000Z',
    claimedBy: 'worker-a',
  });
  assert.equal(first.outcome.delivery_claimed, true);
  assert.equal(first.outcome.delivery_claimed_by, 'worker-a');
  assert.equal(
    store.claimImprovementDelivery(created.run_id, {
      claimedAt: '2026-09-23T12:05:00.000Z',
      claimedBy: 'worker-b',
    }),
    null
  );
  const recovered = store.claimImprovementDelivery(created.run_id, {
    maxAgeMs: 60_000,
    claimedAt: '2026-09-23T12:16:00.000Z',
    claimedBy: 'worker-b',
  });
  assert.equal(recovered.outcome.delivery_claimed_by, 'worker-b');
  store.close();
});

test('filters the change queue by implementation role', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-change-role-'));
  const store = eventstore.open(dir, { file: path.join(dir, 'events.sqlite') });
  store.createChangeRequest({
    site: 'example.com',
    title: 'Normal task',
    assigned_role: 'engineer',
  });
  store.createChangeRequest({
    site: 'example.com',
    title: 'Urgent task',
    assigned_role: 'principal-engineer',
  });
  assert.equal(store.listChangeRequests({ assigned_role: 'principal-engineer' }).length, 1);
  assert.equal(
    store.listChangeRequests({ assigned_role: 'principal-engineer' })[0].title,
    'Urgent task'
  );
  store.close();
});

test('requires completion evidence and rejects stale work-item writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-work-item-gates-'));
  const store = eventstore.open(dir, { file: path.join(dir, 'events.sqlite') });
  const created = store.createExecutiveWorkItem({ title: 'Evidence-gated work' });
  assert.throws(() => store.updateExecutiveWorkItem(created.work_id, { status: 'done' }), /completion requires/);
  const updated = store.updateExecutiveWorkItem(created.work_id, { status: 'in_progress' });
  assert.throws(() => store.updateExecutiveWorkItem(created.work_id, { status: 'done', expected_updated_at: created.updated_at }), /changed/);
  const done = store.updateExecutiveWorkItem(updated.work_id, { status: 'done', outcome: 'Verified in production.', expected_updated_at: updated.updated_at });
  assert.equal(done.status, 'done');
  store.close();
});
