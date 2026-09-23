'use strict';

// A small, deterministic outcome layer for the executive control plane. This
// deliberately reads the durable event store and improvement workbench rather
// than asking a model whether a run was useful.

const TERMINAL_REQUESTS = new Set(['verified', 'failed', 'cancelled']);
const DELIVERED_REQUESTS = new Set(['committed', 'deployed', 'verified']);
const MEASURED_IMPROVEMENTS = new Set(['proven', 'regressed', 'inconclusive']);

function countBy(rows, key) {
  return rows.reduce((counts, row) => {
    const value = String(row[key] || 'unknown');
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function inWindow(value, cutoff) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) && timestamp >= cutoff;
}

function finiteNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function metricDeltas(improvements) {
  const totals = {};
  for (const improvement of improvements) {
    for (const [metric, delta] of Object.entries(improvement.outcome?.deltas || {})) {
      const absolute = finiteNumber(delta?.absolute);
      if (absolute === null) continue;
      totals[metric] = (totals[metric] || 0) + absolute;
    }
  }
  return totals;
}

function proposalExecutionSummary(proposals, requests) {
  const requestRows = Array.isArray(requests) ? requests : [];
  const proposalRows = Array.isArray(proposals) ? proposals : [];
  const requestsById = new Map(requestRows.map(row => [String(row.request_id), row]));
  const requestsByProposal = new Map();
  for (const request of requestRows) {
    if (!request.source_proposal_id) continue;
    const key = String(request.source_proposal_id);
    if (!requestsByProposal.has(key)) requestsByProposal.set(key, []);
    requestsByProposal.get(key).push(request);
  }
  const approved = proposalRows.filter(row => row.status === 'approved');
  const linked = approved.map(proposal => {
    const explicitRequest = proposal.linked_request_id
      ? requestsById.get(String(proposal.linked_request_id)) || null
      : null;
    const sourceRequests = requestsByProposal.get(String(proposal.proposal_id)) || [];
    const request = explicitRequest || sourceRequests[0] || null;
    return { proposal, request };
  });
  const unexecuted = linked
    .filter(row => !row.request)
    .map(({ proposal }) => ({
      proposal_id: proposal.proposal_id,
      title: proposal.title,
      proposal_type: proposal.proposal_type,
      created_by: proposal.created_by,
      created_at: proposal.created_at,
      summary: proposal.summary,
      requested_action: proposal.requested_action,
      has_implementation: Boolean(
        proposal.implementation && Object.keys(proposal.implementation).length
      ),
    }));
  const terminal = linked.filter(row => ['failed', 'cancelled'].includes(row.request?.status));
  return {
    approved_proposals: approved.length,
    approved_proposals_with_execution: approved.length - unexecuted.length,
    approved_proposals_unexecuted: unexecuted.length,
    approved_proposal_execution_rate_percent: approved.length
      ? Math.round(((approved.length - unexecuted.length) / approved.length) * 100)
      : null,
    approved_proposals_with_terminal_request: terminal.length,
    unexecuted_proposals: unexecuted.slice(0, 12),
    linked_request_statuses: countBy(
      linked.filter(row => row.request).map(row => ({ status: row.request.status })),
      'status'
    ),
  };
}

function buildScorecard(store, { now = new Date(), windowDays = 30 } = {}) {
  if (!store) throw new Error('executive scorecard requires an event store');
  const days = Math.max(1, Math.min(365, Number(windowDays) || 30));
  const cutoff = now.getTime() - days * 86400000;
  const actions = store
    .listExecutiveActions({ limit: 5000 })
    .filter(row => inWindow(row.started_at, cutoff));
  const proposals = store
    .listExecutiveProposals({ limit: 1000 })
    .filter(row => inWindow(row.created_at, cutoff));
  const requests = store
    .listChangeRequests({ limit: 1000 })
    .filter(row => inWindow(row.created_at, cutoff));
  const requestsById = new Map(requests.map(row => [String(row.request_id), row]));
  const proposalExecution = proposalExecutionSummary(proposals, requests);
  const improvements = store
    .listImprovements({ limit: 1000 })
    .filter(row => inWindow(row.created_at, cutoff) || row.state === 'measuring');
  // Tick actions are the durable source of truth. Older installations did not
  // emit an executive.tick event consistently, so do not undercount cadence by
  // depending on that secondary event stream.
  const ticks = actions.filter(row => row.action_type === 'tick');

  const queueActions = actions.filter(row => row.action_type === 'queue-work');
  const approvedWorkDrains = actions.filter(
    row => row.action_type === 'queue-work' && row.target_type === 'approved-executive-work'
  );
  const failedTicks = ticks.filter(row => row.status === 'failed');
  const deliveredRequests = requests.filter(row => DELIVERED_REQUESTS.has(row.status));
  const measured = improvements.filter(row => MEASURED_IMPROVEMENTS.has(row.state));
  const proven = improvements.filter(row => row.state === 'proven');
  const isLiveImprovement = row => {
    if (row.source !== 'fleet-dashboard' || !row.source_id) return true;
    const request = requestsById.get(String(row.source_id));
    return !request || !['cancelled', 'failed'].includes(String(request.status));
  };
  const active = improvements.filter(
    row =>
      isLiveImprovement(row) &&
      ['proposed', 'building', 'review', 'deployed', 'measuring'].includes(row.state)
  );
  const pendingMeasurement = improvements.filter(row =>
    ['deployed', 'measuring'].includes(row.state)
  );
  const pendingApprovals = proposals.filter(row => ['proposed', 'feedback'].includes(row.status));
  const failedRequests = requests.filter(row => row.status === 'failed');
  const queueCountForTick = row =>
    row.result?.created_counts
      ? Number(row.result.created_counts.change_requests || 0)
      : Number(row.result?.counts?.change_requests || 0);
  const ticksWithQueueWork = ticks.filter(row => queueCountForTick(row) > 0);
  const ticksWithProposals = ticks.filter(row => Number(row.result?.counts?.proposals || 0) > 0);
  const queueEligibleTicks = ticks.filter(row => row.result?.allowQueue === true);
  const ticksWithQueueWorkWhenEligible = queueEligibleTicks.filter(
    row => queueCountForTick(row) > 0
  );
  // Older tick rows did not persist allowQueue. Keep their historical metric
  // comparable, but once the field exists, do not score deliberate dry runs as
  // CEO no-ops. The dashboard now reports both views so audit history remains
  // intact while the operating KPI reflects executable cycles.
  const hasQueueModeMetadata = ticks.some(row => typeof row.result?.allowQueue === 'boolean');
  const actionabilityDenominator = hasQueueModeMetadata ? queueEligibleTicks.length : ticks.length;
  const actionabilityNumerator = hasQueueModeMetadata
    ? ticksWithQueueWorkWhenEligible.length
    : ticksWithQueueWork.length;
  const actionabilityRate = actionabilityDenominator
    ? Math.round((actionabilityNumerator / actionabilityDenominator) * 100)
    : null;
  const allTicksActionabilityRate = ticks.length
    ? Math.round((ticksWithQueueWork.length / ticks.length) * 100)
    : null;

  let status = 'no-delivery';
  let nextStep =
    'The next full executive run must select one bounded, measurable action or explain why every candidate was rejected.';
  if (proven.length) {
    status = 'results-measured';
    nextStep =
      'Keep the proven change, compare its metric delta to the expected upside, and select the next highest-value opportunity.';
  } else if (measured.length) {
    status = 'results-measured-inconclusive';
    nextStep =
      'Review the measured outcomes and either roll back, iterate, or select the next evidence-backed improvement.';
  } else if (pendingMeasurement.length) {
    status = 'results-pending';
    nextStep =
      'Wait for or run the measurement gate; do not call the work successful until the outcome is recorded.';
  } else if (active.length || deliveredRequests.length) {
    status = 'work-in-flight';
    nextStep =
      'Finish the active implementation, then deploy and measure it through the improvement pipeline.';
  }

  return {
    schema: 'executive-scorecard/v1',
    generated_at: now.toISOString(),
    window_days: days,
    status,
    next_step: nextStep,
    cadence: {
      ticks: ticks.length,
      queue_eligible_ticks: hasQueueModeMetadata ? queueEligibleTicks.length : null,
      queue_disabled_ticks: hasQueueModeMetadata
        ? ticks.filter(row => row.result?.allowQueue === false).length
        : null,
      ticks_with_queue_action: ticksWithQueueWork.length,
      ticks_with_queue_action_when_enabled: hasQueueModeMetadata
        ? ticksWithQueueWorkWhenEligible.length
        : ticksWithQueueWork.length,
      queued_actions_created: ticks.reduce((sum, row) => sum + queueCountForTick(row), 0),
      ticks_with_proposals: ticksWithProposals.length,
      actionability_rate_percent: actionabilityRate,
      all_ticks_actionability_rate_percent: allTicksActionabilityRate,
    },
    decisions: {
      proposals: proposals.length,
      pending_owner_approval: pendingApprovals.length,
      approved: proposals.filter(row => row.status === 'approved').length,
      declined: proposals.filter(row => row.status === 'declined').length,
      by_type: countBy(proposals, 'proposal_type'),
    },
    execution: {
      audited_actions: actions.length,
      queue_actions: queueActions.length,
      approved_work_drain_runs: approvedWorkDrains.length,
      approved_work_drained: approvedWorkDrains.reduce(
        (sum, row) => sum + Number(row.result?.queued || 0),
        0
      ),
      failed_ticks: failedTicks.length,
      historical_failures_retained: failedTicks.length > 0,
      by_action: countBy(actions, 'action_type'),
      requests_created: requests.length,
      requests_by_status: countBy(requests, 'status'),
      delivered_requests: deliveredRequests.length,
      failed_requests: failedRequests.length,
      approved_proposals: proposalExecution.approved_proposals,
      approved_proposals_with_execution: proposalExecution.approved_proposals_with_execution,
      approved_proposals_unexecuted: proposalExecution.approved_proposals_unexecuted,
      approved_proposals_with_terminal_request:
        proposalExecution.approved_proposals_with_terminal_request,
      approved_proposal_execution_rate_percent:
        proposalExecution.approved_proposal_execution_rate_percent,
    },
    outcomes: {
      improvements_started: improvements.length,
      active: active.length,
      pending_measurement: pendingMeasurement.length,
      measured: measured.length,
      proven: proven.length,
      regressed: improvements.filter(row => row.state === 'regressed').length,
      inconclusive: improvements.filter(row => row.state === 'inconclusive').length,
      metric_deltas: metricDeltas(measured),
    },
    attention: [
      ...(pendingApprovals.length ? [`${pendingApprovals.length} owner approval(s) waiting`] : []),
      ...(pendingMeasurement.length
        ? [`${pendingMeasurement.length} deployed improvement(s) awaiting measurement`]
        : []),
      ...(failedRequests.length
        ? [`${failedRequests.length} implementation request(s) failed`]
        : []),
      ...(failedTicks.length
        ? [`${failedTicks.length} executive tick failure(s) retained in the audit log`]
        : []),
      ...(proposalExecution.approved_proposals_unexecuted
        ? [
            `${proposalExecution.approved_proposals_unexecuted} approved proposal(s) lack an execution request`,
          ]
        : []),
      ...(proposalExecution.approved_proposals_with_terminal_request
        ? [
            `${proposalExecution.approved_proposals_with_terminal_request} approved proposal(s) have failed or cancelled execution requests`,
          ]
        : []),
    ],
    proposal_execution: proposalExecution,
  };
}

module.exports = {
  DELIVERED_REQUESTS: [...DELIVERED_REQUESTS],
  MEASURED_IMPROVEMENTS: [...MEASURED_IMPROVEMENTS],
  proposalExecutionSummary,
  buildScorecard,
};
