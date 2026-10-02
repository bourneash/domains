'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const output = require('./scheduler-output');

test('report-only and fleet reports do not satisfy executable delivery', () => {
  const requests = [{ delivery_mode: 'report_only' }, { delivery_mode: 'fleet_report' }];
  assert.deepEqual(output.executableRequests(requests), []);
  assert.equal(output.failedToDeliver({ exitCode: 0, tickStatus: 'completed', requests }), true);
});

test('direct requests, pull requests, or executable work satisfy delivery', () => {
  for (const delivery_mode of ['direct', 'pull_request']) {
    assert.equal(
      output.failedToDeliver({
        exitCode: 0,
        tickStatus: 'completed',
        requests: [{ delivery_mode }],
      }),
      false
    );
  }
  assert.equal(
    output.failedToDeliver({
      exitCode: 0,
      tickStatus: 'completed',
      requests: [{ delivery_mode: 'report_only' }],
      workItems: [{ kind: 'implementation' }],
    }),
    false
  );
});

test('failed infrastructure cycles are not relabeled as no-output failures', () => {
  assert.equal(output.failedToDeliver({ exitCode: 1, tickStatus: 'failed' }), false);
});

test('planning workbench rows do not count without a real worker dispatch', () => {
  const rows = [
    { work_id: 'checkpoint', kind: 'implementation', site: 'fleet', status: 'in_progress' },
  ];
  const store = { listAgentRuns: () => [], getAgentDispatch: () => null };
  assert.deepEqual(output.executableWorkItems(store, rows, 100), []);
  assert.equal(
    output.failedToDeliver({ exitCode: 0, tickStatus: 'completed', workItems: [] }),
    true
  );
});

test('a newly dispatched operating task counts as executable work', () => {
  const rows = [{ work_id: 'task', kind: 'implementation', site: 'example.com', status: 'ready' }];
  const store = {
    listAgentRuns: () => [
      { run_id: 'run-1', started_at: '2026-10-02T20:00:00Z', status: 'running' },
    ],
    getAgentDispatch: () => ({ dispatch_id: 'dispatch-1', status: 'queued' }),
  };
  assert.deepEqual(
    output.executableWorkItems(store, rows, Date.parse('2026-10-02T19:59:00Z')),
    rows
  );
});
