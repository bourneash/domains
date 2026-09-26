'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const board = require('./workflow-board');

test('workflow board joins all durable fleet work sources without changing them', () => {
  const store = {
    listChangeRequests: () => [{ request_id: 'r1', status: 'queued', assigned_role: 'engineer', title: 'Queued work' }],
    listExecutiveWorkItems: () => [{ work_id: 'w1', status: 'waiting', waiting_on: 'owner', title: 'Waiting work', next_action: 'Decide' }],
    listExecutiveProposals: () => [{ proposal_id: 'p1' }],
    listExecutiveActions: () => [{ action_id: 'a1' }],
    list: () => [{ event_id: 'e1' }],
    listWorkflowLinks: () => [],
    getChangeQueueSettings: () => ({ enabled: true }),
    getExecutiveSettings: () => ({ tick_enabled: true }),
  };
  const snapshot = board.snapshot(store);
  assert.equal(snapshot.requests[0].request_id, 'r1');
  assert.equal(snapshot.work_items[0].work_id, 'w1');
  assert.deepEqual(snapshot.proposals, [{ proposal_id: 'p1' }]);
  assert.deepEqual(snapshot.actions, [{ action_id: 'a1' }]);
  assert.equal(snapshot.settings.change_queue.enabled, true);
  assert.equal(snapshot.diagnostics.length, 2);
});
