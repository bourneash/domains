'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const delivery = require('./active-delivery');

function store(requests, runs) {
  return {
    listChangeRequests: () => requests,
    listImprovements: () => runs,
    getImprovement: id => runs.find(row => row.run_id === id) || null,
  };
}

test('active delivery excludes reports and queued work from implementation slots', () => {
  const requests = Array.from({ length: 12 }, (_, index) => ({
    request_id: `r${index}`,
    site: `site-${index}.com`,
    title: `Ship improvement ${index}`,
    status: 'queued',
    delivery_mode: 'direct',
    priority: 'normal',
    created_at: `2026-09-28T0${index}:00:00.000Z`,
    updated_at: `2026-09-28T0${index}:00:00.000Z`,
  }));
  requests.push({
    request_id: 'report',
    site: 'report.example',
    title: 'Baseline report',
    status: 'queued',
    delivery_mode: 'report_only',
    created_at: '2026-09-28T11:00:00.000Z',
  });
  requests.push({
    request_id: 'excluded',
    site: '3boobs.com',
    title: 'Excluded work',
    status: 'queued',
    delivery_mode: 'direct',
  });
  const result = delivery.snapshot(store(requests, []), {
    now: new Date('2026-09-28T12:00:00.000Z'),
  });
  assert.equal(result.policy.active_slots, 0);
  assert.equal(result.policy.overflow_count, 0);
  assert.equal(result.policy.open_slots, 10);
  assert.equal(result.today.report_only_requests_created, 1);
  assert.ok(result.slots.every(row => row.site !== '3boobs.com'));
});

test('active delivery caps started implementation work at ten slots', () => {
  const requests = Array.from({ length: 12 }, (_, index) => ({
    request_id: `r${index}`,
    site: `site-${index}.com`,
    title: `Ship improvement ${index}`,
    status: 'running',
    delivery_mode: 'direct',
    priority: 'normal',
    created_at: `2026-09-28T0${index}:00:00.000Z`,
    updated_at: `2026-09-28T0${index}:00:00.000Z`,
  }));
  const result = delivery.snapshot(store(requests, []), {
    now: new Date('2026-09-28T12:00:00.000Z'),
  });
  assert.equal(result.policy.active_slots, 10);
  assert.equal(result.policy.overflow_count, 2);
});

test('improvement runs enrich the corresponding request instead of duplicating it', () => {
  const result = delivery.snapshot(
    store(
      [
        {
          request_id: 'r1',
          run_id: 'run1',
          site: 'example.com',
          title: 'Improve UX',
          status: 'review',
          delivery_mode: 'direct',
          assigned_role: 'engineer',
        },
      ],
      [
        {
          run_id: 'run1',
          source_id: 'r1',
          site: 'example.com',
          title: 'Improve UX',
          state: 'review',
          deployment_id: null,
        },
      ]
    ),
    { now: new Date('2026-09-28T12:00:00.000Z') }
  );
  assert.equal(result.slots.length, 1);
  assert.equal(result.slots[0].run_id, 'run1');
  assert.equal(result.attention.length, 1);
});

test('measuring improvements continue showing as measurement work without consuming implementation slots', () => {
  const runs = Array.from({ length: 10 }, (_, index) => ({
    run_id: `measure-${index}`,
    site: `measure-${index}.com`,
    title: `Measure improvement ${index}`,
    state: 'measuring',
    measurement_due: '2026-10-12',
  }));
  const result = delivery.snapshot(store([], runs), {
    now: new Date('2026-09-29T12:00:00.000Z'),
  });
  assert.equal(result.policy.active_slots, 0);
  assert.equal(result.policy.open_slots, 10);
  assert.equal(result.policy.measurement_count, 10);
  assert.equal(result.measuring.length, 10);
});

test('delivery handoffs and blocked reviews do not consume implementation slots', () => {
  const result = delivery.snapshot(
    store(
      [
        {
          request_id: 'pending',
          site: 'pending.example.com',
          title: 'Ready for deterministic delivery',
          status: 'delivery_pending',
          delivery_mode: 'direct',
        },
        {
          request_id: 'blocked',
          site: 'blocked.example.com',
          title: 'Needs infrastructure repair',
          status: 'blocked_infrastructure',
          delivery_mode: 'direct',
        },
      ],
      []
    )
  );
  assert.equal(result.policy.active_slots, 0);
  assert.equal(result.policy.open_slots, 10);
});

test('a preserved review linked to an infrastructure block is attention, not capacity', () => {
  const result = delivery.snapshot(
    store(
      [
        {
          request_id: 'blocked',
          site: 'blocked.example.com',
          title: 'Preserved change',
          status: 'blocked_infrastructure',
          delivery_mode: 'direct',
        },
      ],
      [
        {
          run_id: 'preserved',
          source_id: 'blocked',
          site: 'blocked.example.com',
          title: 'Preserved change',
          state: 'review',
        },
      ]
    )
  );
  assert.equal(result.policy.active_slots, 0);
  assert.equal(result.policy.blocked_review_count, 1);
  assert.equal(result.policy.measurement_count, 0);
  assert.equal(result.blocked[0].state, 'blocked_infrastructure');
  assert.equal(result.attention[0].attention, 'infrastructure repair required');
});

test('a failed request does not keep a slot through its preserved review worktree', () => {
  const result = delivery.snapshot(
    store(
      [
        {
          request_id: 'failed',
          run_id: 'preserved',
          site: 'example.com',
          title: 'Rejected change',
          status: 'failed',
          delivery_mode: 'direct',
        },
      ],
      [
        {
          run_id: 'preserved',
          source_id: 'failed',
          site: 'example.com',
          title: 'Rejected change',
          state: 'review',
        },
      ]
    )
  );
  assert.equal(result.policy.active_slots, 0);
  assert.equal(result.policy.open_slots, 10);
  assert.equal(result.slots.length, 0);
  assert.equal(result.attention.length, 0);
});
