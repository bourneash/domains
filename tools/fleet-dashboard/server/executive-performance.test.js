'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const performance = require('./executive-performance');

function storeFixture() {
  const created = [];
  return {
    created,
    getExecutiveSettings: () => ({
      performance_contract: { enabled: true, automatic_recovery: true },
    }),
    listExecutiveActions: () => [
      { action_type: 'tick', status: 'completed', started_at: '2026-09-30T00:00:00.000Z' },
      { action_type: 'tick', status: 'completed', started_at: '2026-09-30T00:15:00.000Z' },
    ],
    listExecutiveProposals: () => [
      { created_at: '2026-09-30T00:05:00.000Z', created_by: 'growth-director', status: 'approved' },
    ],
    listChangeRequests: () => [
      {
        request_id: 'release',
        run_id: 'run-release',
        delivery_mode: 'pull_request',
        created_at: '2026-09-30T00:06:00.000Z',
        requested_by: 'delivery-lead',
        status: 'deployed',
      },
    ],
    listImprovements: () => [
      {
        run_id: 'run-release',
        deployment_id: 'build-release',
        validation: { passed: true, commit: 'abc' },
        approval: {
          approved_at: '2026-09-30T00:10:00Z',
          release: { status: 'verified', build_id: 'build-release', commit: 'build-release' },
        },
        outcome: { deployment_verified_at: '2026-09-30T00:10:00Z' },
      },
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

test('legacy zero outcome targets cannot earn credit from reports or proposals', () => {
  const store = storeFixture();
  store.listChangeRequests = () => [
    {
      created_at: '2026-09-30T00:06:00Z',
      requested_by: 'ceo',
      status: 'verified',
      delivery_mode: 'report_only',
    },
  ];
  store.listImprovements = () => [];
  store.getExecutiveSettings = () => ({
    performance_contract: { enabled: true, roles: { ceo: { verified_outcomes: 0 } } },
  });
  const result = performance.buildPerformance(store, { now: new Date('2026-09-30T00:30:00Z') });
  assert.equal(result.roles.find(row => row.role === 'ceo').score, 0);
  assert.equal(result.roles.find(row => row.role === 'growth-director').score, 0);
  assert.equal(performance.applyPerformanceRecovery(store).created.length, 0);
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

test('active recovery remains measurable after leaving the score window', () => {
  const store = storeFixture();
  store.listExecutiveActions = () => [
    { action_type: 'tick', status: 'completed', started_at: '2026-09-30T00:00:00.000Z' },
    { action_type: 'tick', status: 'completed', started_at: '2026-09-30T00:15:00.000Z' },
    { action_type: 'tick', status: 'completed', started_at: '2026-09-30T00:30:00.000Z' },
  ];
  store.listExecutiveWorkItems = () => [
    {
      work_id: 'executive-performance-recovery:ceo',
      owner: 'ceo',
      source_type: 'executive-performance-recovery',
      source_id: 'ceo',
      status: 'in_progress',
      created_at: '2026-09-29T23:00:00.000Z',
    },
  ];
  const result = performance.buildPerformance(store, {
    now: new Date('2026-09-30T00:45:00.000Z'),
    contract: {
      enabled: true,
      automatic_recovery: true,
      window_ticks: 2,
      restricted_after_windows: 1,
      escalation_after_windows: 2,
    },
  });
  const ceo = result.roles.find(row => row.role === 'ceo');
  assert.equal(ceo.recovery_windows, 3);
  assert.equal(ceo.status, 'escalated');
});

test('report-only activity and zero outcome targets grant no delivery points or automatic recovery', () => {
  const store = storeFixture();
  store.getExecutiveSettings = () => ({ performance_contract: { enabled: true } });
  store.listChangeRequests = () => [
    {
      request_id: 'report',
      run_id: 'report-run',
      requested_by: 'delivery-lead',
      delivery_mode: 'report_only',
      status: 'verified',
      created_at: '2026-09-30T00:10:00Z',
    },
  ];
  store.listImprovements = () => [
    { run_id: 'report-run', state: 'reported', updated_at: '2026-09-30T00:10:00Z' },
  ];
  const result = performance.buildPerformance(store, { now: new Date('2026-09-30T00:30:00Z') });
  const role = result.roles.find(row => row.role === 'delivery-lead');
  assert.equal(role.score, 0);
  assert.equal(role.reports, 1);
  assert.equal(role.verified_outcomes, 0);
  assert.equal(result.contract.automatic_recovery, false);
  assert.equal(performance.applyPerformanceRecovery(store, result).created.length, 0);
});
