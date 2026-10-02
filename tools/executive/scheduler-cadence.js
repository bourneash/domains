'use strict';

// Cron remains a cheap ten-minute poll, but model planning is hourly unless an
// owner has supplied a new instruction. Delivery workers and measurements have
// their own schedules and must not be throttled with the planning loop.
function shouldRunPlanning(store, { now = Date.now(), minimumMinutes = 60 } = {}) {
  const latestTick = store.listExecutiveActions({ action_type: 'tick', limit: 20 })[0];
  // The scheduler can fail a technically completed model tick when its plan
  // produced no executable handoff. Retry from that delivery verdict, not the
  // model's process-level completion.
  const dispatches = store
    .listExecutiveActions({ action_type: 'other', limit: 50 })
    .filter(row => row.target_type === 'scheduled-executive-run');
  const failedDispatch = dispatches.find(
    row => row.target_type === 'scheduled-executive-run' && row.status === 'failed'
  );
  const latest =
    failedDispatch &&
    (!latestTick ||
      Date.parse(failedDispatch.finished_at || failedDispatch.started_at || '') >=
        Date.parse(latestTick.started_at || ''))
      ? failedDispatch
      : latestTick;
  if (!latest) return { run: true, reason: 'first scheduled cycle' };
  const lastStarted = Date.parse(latest.started_at || '');
  if (!Number.isFinite(lastStarted)) return { run: true, reason: 'unknown last cycle time' };
  const newOwnerRequest = store
    .listExecutiveWorkItems({ source_type: 'owner-request', limit: 1000, quiet: 0 })
    .some(item => Date.parse(item.created_at || '') > lastStarted);
  if (newOwnerRequest) return { run: true, reason: 'new owner request' };
  // Two no-output passes in an hour mean another paid model pass is unlikely
  // to unblock the fleet. Keep deterministic drains/alerts on every poll, but
  // back planning off to hourly until new owner instructions arrive.
  const recentNoDelivery = dispatches.filter(
    row =>
      row.status === 'failed' &&
      /failed_to_deliver/.test(String(row.error || '')) &&
      now - (Date.parse(row.started_at || '') || 0) < 60 * 60_000
  ).length;
  const repeatedNoDelivery = latest.status === 'failed' && recentNoDelivery >= 2;
  const cooldownMinutes =
    latest.status === 'failed' && !repeatedNoDelivery
      ? Math.min(minimumMinutes, 10)
      : minimumMinutes;
  // Fleet cron polls on whole-minute boundaries. Anchor cooldown to the
  // start minute so a tick that begins seconds into a poll does not miss its
  // next due poll and wait another full interval.
  const lastStartMinute = Math.floor(lastStarted / 60_000) * 60_000;
  if (now - lastStartMinute >= cooldownMinutes * 60 * 1000)
    return {
      run: true,
      reason: repeatedNoDelivery
        ? 'hourly retry after repeated no-delivery failures'
        : latest.status === 'failed'
          ? 'failed tick retry due'
          : 'hourly delivery triage due',
    };
  return {
    run: false,
    reason: `planning cooldown; next triage at ${new Date(lastStartMinute + cooldownMinutes * 60 * 1000).toISOString()}`,
  };
}

module.exports = { shouldRunPlanning };
