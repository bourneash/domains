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
      {
        action_type: 'queue-work',
        target_type: 'approved-executive-work',
        started_at: '2026-09-22T00:02:00.000Z',
        result: { queued: 2 },
      },
      { action_type: 'propose', started_at: '2026-09-22T00:03:00.000Z', result: {} },
    ],
    listExecutiveProposals: () => [
      { status: 'approved', proposal_type: 'growth', created_at: '2026-09-21T00:00:00.000Z' },
      { status: 'proposed', proposal_type: 'engineering', created_at: '2026-09-22T00:00:00.000Z' },
    ],
    listChangeRequests: () => [
      {
        request_id: 'release',
        run_id: 'run-release',
        status: 'deployed',
        delivery_mode: 'pull_request',
        created_at: '2026-09-22T00:01:00.000Z',
      },
      { status: 'queued', created_at: '2026-09-22T00:04:00.000Z' },
    ],
    listImprovements: () => [
      {
        run_id: 'run-release',
        site: 'example.test',
        deployment_id: 'build-release',
        validation: { passed: true, commit: 'abc' },
        approval: {
          approved_at: '2026-09-21T00:00:00Z',
          release: { status: 'verified', build_id: 'build-release', commit: 'build-release' },
        },
        state: 'proven',
        created_at: '2026-09-20T00:00:00.000Z',
        outcome: {
          measurement_contract: 'measurement-evidence/v2',
          deployment_verified_at: '2026-09-21T00:00:00Z',
          deltas: { conversions: { absolute: 4 } },
        },
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
  assert.equal(result.execution.queued_requests, 1);
  assert.equal(result.execution.blocked_reviews, 0);
  assert.equal(result.execution.approved_work_drain_runs, 1);
  assert.equal(result.execution.approved_work_drained, 2);
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

test('scorecard distinguishes fleet and domain-manager tick scopes', () => {
  const store = {
    listExecutiveActions: () => [
      {
        action_type: 'tick',
        started_at: '2026-09-22T00:00:00.000Z',
        result: { scope: 'fleet', allowQueue: true, created_counts: { change_requests: 1 } },
      },
      {
        action_type: 'tick',
        started_at: '2026-09-22T00:05:00.000Z',
        result: { scope: 'domain-manager', allowQueue: false, created_counts: {} },
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
  assert.deepEqual(result.cadence.scopes, { fleet: 1, 'domain-manager': 1 });
  assert.equal(result.cadence.fleet_ticks, 1);
  assert.equal(result.cadence.domain_manager_ticks, 1);
});

test('accountability escalates repeated executable no-op cycles', () => {
  const result = scorecard.buildExecutiveAccountability([
    {
      started_at: '2026-09-22T00:00:00.000Z',
      result: { allowQueue: true, created_counts: { change_requests: 1 } },
    },
    {
      started_at: '2026-09-22T01:00:00.000Z',
      result: { allowQueue: true, created_counts: { change_requests: 0, work_items: 1 } },
    },
    {
      started_at: '2026-09-22T02:00:00.000Z',
      result: { allowQueue: true, created_counts: { change_requests: 0, work_items: 0 } },
    },
  ]);
  assert.equal(result.productive_ticks, 1);
  assert.equal(result.no_action_streak, 2);
  assert.equal(result.escalation_required, true);
  assert.equal(result.status, 'escalate-ceo');
});

test('accountability excludes deliberately disabled queue cycles', () => {
  const result = scorecard.buildExecutiveAccountability([
    {
      started_at: '2026-09-22T00:00:00.000Z',
      result: { allowQueue: false, created_counts: { change_requests: 0 } },
    },
    {
      started_at: '2026-09-22T01:00:00.000Z',
      result: { allowQueue: true, created_counts: { work_items: 1, follow_through: 1 } },
    },
  ]);
  assert.equal(result.eligible_ticks, 1);
  assert.equal(result.productive_ticks, 1);
  assert.equal(result.escalation_required, false);
  assert.equal(result.status, 'on-track');
});

test('accountability counts explicit blocker escalations but not generic work updates', () => {
  const result = scorecard.buildExecutiveAccountability([
    {
      started_at: '2026-09-22T00:00:00.000Z',
      result: { allowQueue: true, created_counts: { work_items: 1 } },
    },
    {
      started_at: '2026-09-22T01:00:00.000Z',
      result: { allowQueue: true, created_counts: { accountability_actions: 1 } },
    },
  ]);
  assert.equal(result.productive_ticks, 1);
  assert.equal(result.no_action_streak, 0);
  assert.equal(result.escalation_required, false);
});

test('tracking-stream updates remain visible in audit results but never count as delivery', () => {
  const result = scorecard.buildExecutiveAccountability([
    {
      started_at: '2026-09-22T00:00:00.000Z',
      result: { allowQueue: true, created_counts: { tracking_updates: 12 } },
    },
  ]);
  assert.equal(result.productive_ticks, 0);
  assert.equal(result.no_action_ticks, 1);
  assert.equal(result.escalation_required, false);
});

test('owner-request handoffs count as productive dispatches', () => {
  const result = scorecard.buildExecutiveAccountability([
    {
      started_at: '2026-09-22T00:00:00.000Z',
      result: { allowQueue: true, created_counts: { owner_handoffs: 1 } },
    },
  ]);
  assert.equal(result.productive_ticks, 1);
  assert.equal(result.no_action_ticks, 0);
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

test('scorecard exposes open repair work for terminal worker failures', () => {
  const store = {
    listExecutiveActions: () => [],
    listExecutiveProposals: () => [],
    listChangeRequests: () => [{ status: 'failed', created_at: '2026-09-22T00:00:00.000Z' }],
    listImprovements: () => [{ state: 'deployed', created_at: '2026-09-20T00:00:00.000Z' }],
    listExecutiveWorkItems: () => [
      { source_type: 'failed-change-request', status: 'open', owner: 'cto' },
      { source_type: 'failed-change-request', status: 'done', owner: 'principal-engineer' },
    ],
    list: () => [],
  };
  const result = scorecard.buildScorecard(store, {
    now: new Date('2026-09-22T01:00:00.000Z'),
  });
  assert.equal(result.execution.failure_followups_open, 1);
  assert.deepEqual(result.execution.failure_followups_by_owner, { cto: 1 });
  assert.match(result.attention.join('\n'), /open repair work items/);
  assert.match(result.next_step, /failure-repair/);
});

test('scorecard alerts when an owner request survives a run unanswered', () => {
  const store = {
    listExecutiveActions: () => [
      {
        action_type: 'tick',
        started_at: '2026-09-22T00:30:00.000Z',
        result: { allowQueue: true, created_counts: { messages: 0 } },
      },
    ],
    listExecutiveProposals: () => [],
    listChangeRequests: () => [],
    listImprovements: () => [],
    listExecutiveWorkItems: () => [
      {
        work_id: 'owner-request-1',
        source_type: 'owner-request',
        lifecycle_state: 'submitted',
        created_at: '2026-09-22T00:00:00.000Z',
        title: 'Owner request: answer me',
        next_action: 'Executive team to reply',
      },
    ],
    list: () => [],
  };
  const result = scorecard.buildScorecard(store, {
    now: new Date('2026-09-22T01:00:00.000Z'),
  });
  assert.equal(result.execution.owner_requests_stale, 1);
  assert.match(result.attention.join('\n'), /owner request\(s\) survived/);
  assert.equal(result.owner_requests.stale[0].work_id, 'owner-request-1');
});
