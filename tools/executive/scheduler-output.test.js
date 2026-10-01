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
