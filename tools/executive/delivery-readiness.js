'use strict';

// Use the queue's own blocker model for executive accounting. A queued row is
// not an executable handoff when measurement, an execution gate, or capacity
// prevents the worker from claiming it.
const changequeueView = require('../fleet-dashboard/server/changequeue-view');

const DELIVERY_MODES = new Set(['direct', 'pull_request']);
const WORKING_STATUSES = new Set(['claimed', 'running', 'reviewing', 'review', 'delivery_pending']);
const DELIVERED_STATUSES = new Set(['committed', 'deployed', 'verified']);

function isDelivery(request) {
  return DELIVERY_MODES.has(String(request?.delivery_mode || 'direct'));
}

function snapshot(store, root, now = Date.now()) {
  const requests = store.listChangeRequests({ limit: 1000 });
  const improvements = store.listImprovements({ limit: 1000 });
  const settings = store.getChangeQueueSettings();
  const enriched = changequeueView.enrichChangeRequests(
    root,
    requests,
    settings,
    improvements,
    now
  );
  const direct = enriched.filter(isDelivery);
  const eligibleQueued = direct.filter(
    request => request.status === 'queued' && request.queue_block?.blocked === false
  );
  const blockedQueued = direct.filter(
    request => request.status === 'queued' && request.queue_block?.blocked === true
  );
  const working = direct.filter(request => WORKING_STATUSES.has(request.status));
  const delivered = direct.filter(request => DELIVERED_STATUSES.has(request.status));
  return {
    requests: enriched,
    improvements,
    settings,
    eligibleQueued,
    blockedQueued,
    working,
    delivered,
  };
}

function measurementHold(request, improvements) {
  if (!isDelivery(request)) return null;
  const conflicts = improvements.filter(
    run =>
      run.state === 'measuring' &&
      String(run.site || '').toLowerCase() === String(request.site || '').toLowerCase() &&
      changequeueView.measurementConflict(request, run)
  );
  if (!conflicts.length) return null;
  const dueAt =
    conflicts
      .map(run => run.measurement_due)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
  return {
    reason: 'overlaps an active measurement window',
    due_at: dueAt,
    run_ids: conflicts.map(run => run.run_id),
  };
}

module.exports = { isDelivery, snapshot, measurementHold };
