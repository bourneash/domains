#!/usr/bin/env bash
set -euo pipefail

# Cheap control-plane pass: route already-approved work without invoking a
# model. This keeps the engineer queue moving when an executive model pass is
# skipped, times out, or produces no new implementation plan.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MAX_QUEUE="${EXECUTIVE_MAX_APPROVED_QUEUE_ACTIONS:-6}"

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
  // Reserve half the cheap queue for telemetry/reliability evidence so a
  // large historical failure backlog cannot starve live analytics and
  // attribution gaps forever.
  const failureBudget = Math.max(1, Math.ceil(Number(maxQueue) / 2));
  const failureDiagnostics = runner.drainFailureDiagnostics(store, {
    root,
    maxQueue: failureBudget,
  });
  const dataQuality = runner.drainDataQualityWork(store, {
    root,
    maxQueue: Math.max(0, Number(maxQueue) - failureDiagnostics.filter(row => row.type === 'queued-failure-diagnosis').length),
  });
  const alreadyQueued =
    failureDiagnostics.filter(row => row.type === 'queued-failure-diagnosis').length +
    dataQuality.filter(row => row.type === 'queued-data-quality').length;
  const result = [
    ...failureDiagnostics,
    ...dataQuality,
    ...runner.drainApprovedProposalQueue(store, {
      root,
      maxQueue: Math.max(0, Number(maxQueue) - alreadyQueued),
    }),
  ];
  executive.finishAction(store, audit.action_id, {
    status: 'completed',
    result: {
      max_queue: maxQueue,
      queued:
        result.filter(row =>
          ['queued', 'queued-failure-diagnosis', 'queued-data-quality'].includes(row.type)
        ).length,
      queued_failure_diagnostics: result.filter(row => row.type === 'queued-failure-diagnosis').length,
      queued_data_quality: result.filter(row => row.type === 'queued-data-quality').length,
      reconciled: result.filter(row => row.type === 'work-item-reconciled').length,
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
