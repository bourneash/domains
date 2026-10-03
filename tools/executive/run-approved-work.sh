#!/usr/bin/env bash
set -euo pipefail

# Cheap control-plane pass: route already-approved work without invoking a
# model. This keeps the engineer queue moving when an executive model pass is
# skipped, times out, or produces no new implementation plan.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MAX_QUEUE="${EXECUTIVE_MAX_APPROVED_QUEUE_ACTIONS:-6}"

# PR/check/connected-build state is authoritative for review and release.
# A telemetry outage must not strand local queue accounting, but it is logged.
timeout 90s node "$ROOT/tools/executive/review-tracker.js" || \
  echo "[$(date -Is)] review/release reconciliation failed" >&2

# Reconcile the owner lane before any historical proposal drain. A live named
# implementation takes priority over more queue activity from old plans.
DELIVERY_LANE_STATE="$(node "$ROOT/tools/executive/delivery-lane.js")"
echo "$DELIVERY_LANE_STATE"
if node -e 'process.exit(JSON.parse(process.argv[1]).freeze_planning === true ? 0 : 1)' "$DELIVERY_LANE_STATE"; then
  echo "[$(date -Is)] approved proposal drain paused for owner delivery lane"
  exit 0
fi

node - "$ROOT" "$MAX_QUEUE" <<'NODE'
const root = process.argv[2];
const maxQueue = Number(process.argv[3]);
const eventstore = require(`${root}/tools/fleet-dashboard/server/eventstore`);
const executive = require(`${root}/tools/fleet-dashboard/server/executive`);
const runner = require(`${root}/tools/executive/runner`);

const store = eventstore.open(root);
const audit = executive.action(store, {
  actor: 'system',
  action_type: 'queue-work',
  summary: 'Drain already-approved executive work before model execution',
  target_type: 'approved-executive-work',
});
try {
  // Reserve capacity for approved implementation-ready proposals. Historical
  // diagnostics remain useful, but they must not consume every cheap queue
  // slot and leave the executive team's actionable work waiting indefinitely.
  const budgets = runner.approvedWorkQueueBudgets(maxQueue);
  const reconciledFailureFollowups = runner.reconcileCompletedFailureFollowups(store);
  const failureDiagnostics = runner.drainFailureDiagnostics(store, {
    root,
    maxQueue: budgets.failureDiagnostics,
  });
  const dataQuality = runner.drainDataQualityWork(store, {
    root,
    maxQueue: budgets.dataQuality,
  });
  const result = [
    ...reconciledFailureFollowups,
    ...failureDiagnostics,
    ...dataQuality,
    ...runner.drainApprovedProposalQueue(store, {
      root,
      maxQueue: budgets.proposals,
    }),
  ];
  executive.finishAction(store, audit.action_id, {
    status: 'completed',
    result: {
      max_queue: maxQueue,
      budgets,
      queued:
        result.filter(row =>
          ['queued', 'queued-failure-diagnosis', 'queued-data-quality'].includes(row.type)
        ).length,
      queued_failure_diagnostics: result.filter(row => row.type === 'queued-failure-diagnosis').length,
      queued_data_quality: result.filter(row => row.type === 'queued-data-quality').length,
      reconciled: result.filter(row => row.type === 'work-item-reconciled').length,
      reconciled_failure_followups: result.filter(row => row.type === 'failure-followup-reconciled').length,
      blocked: result.filter(row => row.type === 'work-item-created' && row.status === 'blocked').length,
    },
  });
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  executive.finishAction(store, audit.action_id, { status: 'failed', error: error.message });
  console.error(error.message);
  process.exitCode = 1;
} finally {
  store.close();
}
NODE
