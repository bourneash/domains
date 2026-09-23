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
  const result = runner.drainApprovedProposalQueue(store, { root, maxQueue });
  executive.finishAction(store, audit.action_id, {
    status: 'completed',
    result: {
      max_queue: maxQueue,
      queued: result.filter(row => row.type === 'queued').length,
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
