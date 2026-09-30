'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const performance = require('./executive-performance');

function storeFixture() {
  const created = [];
  return {
    created,
    getExecutiveSettings: () => ({ performance_contract: { enabled: true } }),
    listExecutiveActions: () => [
      { action_type: 'tick', status: 'completed', started_at: '2026-09-30T00:00:00.000Z' },
      { action_type: 'tick', status: 'completed', started_at: '2026-09-30T00:15:00.000Z' },
    ],
    listExecutiveProposals: () => [
      { created_at: '2026-09-30T00:05:00.000Z', created_by: 'growth-director', status: 'approved' },
    ],
    listChangeRequests: () => [
      { created_at: '2026-09-30T00:06:00.000Z', requested_by: 'delivery-lead', status: 'verified' },
    ],
    listExecutiveWorkItems: () => [],
    listExecutiveMessages: () => [],
    getExecutiveWorkItem: id => created.find(row => row.work_id === id) || null,
    createExecutiveWorkItem: input => {
      const row = { ...input };
      created.push(row);
      return row;
    },
  };
}

test('performance contract normalizes bounded settings and weights', () => {
  const contract = performance.normalizeContract({
    window_ticks: 99,
    minimum_score: -4,
    weights: { output: 1, outcomes: 1, quality: 1, progress: 1 },
  });
  assert.equal(contract.window_ticks, 20);
  assert.equal(contract.minimum_score, 0);
  assert.equal(
    Object.values(contract.weights).reduce((sum, value) => sum + value, 0),
    100
  );
});

test('performance scores durable outputs and verified outcomes, not messages', () => {
  const store = storeFixture();
  const result = performance.buildPerformance(store, { now: new Date('2026-09-30T00:30:00.000Z') });
  const growth = result.roles.find(row => row.role === 'growth-director');
  const delivery = result.roles.find(row => row.role === 'delivery-lead');
  assert.equal(growth.durable_outputs, 1);
  assert.equal(growth.messages, 0);
  assert.equal(delivery.verified_outcomes, 1);
  assert.ok(delivery.score > 0);
});

test('underperformance creates one repair assignment and remains idempotent', () => {
  const store = storeFixture();
  const first = performance.applyPerformanceRecovery(store, {
    now: new Date('2026-09-30T00:30:00.000Z'),
  });
  assert.ok(first.created.length > 0);
  assert.equal(first.created[0].source_type, 'executive-performance-recovery');
  const second = performance.applyPerformanceRecovery(store, {
    now: new Date('2026-09-30T00:45:00.000Z'),
  });
  assert.equal(second.created.length, 0);
});
