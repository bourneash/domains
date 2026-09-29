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

test('active delivery excludes reports and excluded sites and caps the portfolio at ten', () => {
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
  assert.equal(result.policy.active_slots, 10);
  assert.equal(result.policy.overflow_count, 2);
  assert.equal(result.today.report_only_requests_created, 1);
  assert.ok(result.slots.every(row => row.site !== '3boobs.com'));
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
