'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const scorecard = require('./executive-scorecard');

function fakeStore() {
  return {
    listExecutiveActions: () => [
      {
        action_type: 'tick',
        started_at: '2026-09-22T00:00:00.000Z',
        result: { counts: { change_requests: 1 } },
      },
      { action_type: 'queue-work', started_at: '2026-09-22T00:02:00.000Z', result: {} },
      { action_type: 'propose', started_at: '2026-09-22T00:03:00.000Z', result: {} },
    ],
    listExecutiveProposals: () => [
      { status: 'approved', proposal_type: 'growth', created_at: '2026-09-21T00:00:00.000Z' },
      { status: 'proposed', proposal_type: 'engineering', created_at: '2026-09-22T00:00:00.000Z' },
    ],
    listChangeRequests: () => [
      { status: 'verified', created_at: '2026-09-22T00:01:00.000Z' },
      { status: 'queued', created_at: '2026-09-22T00:04:00.000Z' },
    ],
    listImprovements: () => [
      {
        state: 'proven',
        created_at: '2026-09-20T00:00:00.000Z',
        outcome: { deltas: { conversions: { absolute: 4 } } },
      },
    ],
    list: () => [],
  };
}

test('scorecard reports delivery and measurable outcomes instead of activity alone', () => {
  const result = scorecard.buildScorecard(fakeStore(), {
    now: new Date('2026-09-22T01:00:00.000Z'),
  });
  assert.equal(result.status, 'results-measured');
  assert.equal(result.outcomes.proven, 1);
  assert.equal(result.outcomes.metric_deltas.conversions, 4);
  assert.equal(result.execution.delivered_requests, 1);
  assert.equal(result.decisions.pending_owner_approval, 1);
  assert.equal(result.cadence.ticks, 1);
  assert.equal(result.cadence.actionability_rate_percent, 100);
});

test('scorecard makes an unproductive executive cycle visible', () => {
  const empty = {
    listExecutiveActions: () => [],
    listExecutiveProposals: () => [],
    listChangeRequests: () => [],
    listImprovements: () => [],
    list: () => [{ occurred_at: '2026-09-22T00:00:00.000Z' }],
  };
  const result = scorecard.buildScorecard(empty, {
    now: new Date('2026-09-22T01:00:00.000Z'),
  });
  assert.equal(result.status, 'no-delivery');
  assert.match(result.next_step, /bounded, measurable action/);
});

test('proposal execution summary distinguishes approved work from unexecuted approvals', () => {
  const summary = scorecard.proposalExecutionSummary(
    [
      {
        proposal_id: 'p-linked',
        status: 'approved',
        title: 'Ship the bounded improvement',
        implementation: { site: 'example.com' },
      },
      {
        proposal_id: 'p-source-linked',
        status: 'approved',
        title: 'Run the evidence task',
      },
      {
        proposal_id: 'p-unexecuted',
        status: 'approved',
        title: 'Needs a real follow-through task',
        implementation: {},
      },
      { proposal_id: 'p-pending', status: 'proposed', title: 'Not approved yet' },
    ],
    [
      { request_id: 'r-linked', source_proposal_id: 'p-linked', status: 'verified' },
      { request_id: 'r-source', source_proposal_id: 'p-source-linked', status: 'queued' },
    ]
  );
  assert.equal(summary.approved_proposals, 3);
  assert.equal(summary.approved_proposals_with_execution, 2);
  assert.equal(summary.approved_proposals_unexecuted, 1);
  assert.equal(summary.approved_proposal_execution_rate_percent, 67);
  assert.deepEqual(summary.linked_request_statuses, { verified: 1, queued: 1 });
  assert.equal(summary.unexecuted_proposals[0].proposal_id, 'p-unexecuted');
});

test('scorecard does not score deliberate dry runs as executable no-ops', () => {
  const store = {
    listExecutiveActions: () => [
      {
        action_type: 'tick',
        started_at: '2026-09-22T00:00:00.000Z',
        result: {
          allowQueue: false,
          counts: { change_requests: 4 },
          created_counts: { change_requests: 0 },
        },
      },
      {
        action_type: 'tick',
        started_at: '2026-09-22T00:10:00.000Z',
        result: { allowQueue: true, created_counts: { change_requests: 2 } },
      },
    ],
    listExecutiveProposals: () => [],
    listChangeRequests: () => [],
    listImprovements: () => [],
    list: () => [],
  };
  const result = scorecard.buildScorecard(store, {
    now: new Date('2026-09-22T01:00:00.000Z'),
  });
  assert.equal(result.cadence.queue_eligible_ticks, 1);
  assert.equal(result.cadence.queue_disabled_ticks, 1);
  assert.equal(result.cadence.actionability_rate_percent, 100);
  assert.equal(result.cadence.all_ticks_actionability_rate_percent, 50);
});
