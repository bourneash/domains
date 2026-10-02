'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { measurementHold, snapshot } = require('./delivery-readiness');

test('holds a direct request that overlaps an active measurement window', () => {
  const request = {
    site: 'example.com',
    delivery_mode: 'direct',
    category: 'seo',
    title: 'Improve /guides/controller search snippet',
  };
  const runs = [
    {
      run_id: 'measuring-1',
      site: 'example.com',
      state: 'measuring',
      category: 'seo',
      title: 'Measure /guides/controller CTR',
      measurement_due: '2026-10-16T00:00:00Z',
    },
  ];
  assert.deepEqual(measurementHold(request, runs), {
    reason: 'overlaps an active measurement window',
    due_at: '2026-10-16T00:00:00Z',
    run_ids: ['measuring-1'],
  });
  assert.equal(
    measurementHold({ ...request, title: 'Improve /about page layout', category: 'design' }, runs),
    null
  );
});

test('blocked queued work is not an eligible executive handoff', () => {
  const now = Date.parse('2026-10-02T18:00:00Z');
  const request = {
    request_id: 'queued-1',
    site: 'example.com',
    status: 'queued',
    delivery_mode: 'direct',
    category: 'seo',
    title: 'Improve /guides/controller snippet',
    created_at: '2026-10-02T17:00:00Z',
  };
  const store = {
    listChangeRequests: () => [request],
    listImprovements: () => [
      {
        run_id: 'measuring-1',
        site: 'example.com',
        state: 'measuring',
        category: 'seo',
        title: 'Measure /guides/controller CTR',
        measurement_due: '2026-10-16T00:00:00Z',
      },
    ],
    getChangeQueueSettings: () => ({ max_concurrent: 6 }),
  };
  const result = snapshot(store, '/missing', now);
  assert.equal(result.eligibleQueued.length, 0);
  assert.equal(result.blockedQueued.length, 1);
  assert.equal(result.blockedQueued[0].queue_block.primary.code, 'measurement_window');
});
