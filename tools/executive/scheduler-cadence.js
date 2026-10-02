'use strict';

// Cron remains a cheap ten-minute poll, but model planning is hourly unless an
// owner has supplied a new instruction. Delivery workers and measurements have
// their own schedules and must not be throttled with the planning loop.
function shouldRunPlanning(store, { now = Date.now(), minimumMinutes = 60 } = {}) {
  const latest = store
    .listExecutiveActions({ limit: 200 })
    .find(
      action =>
        action.target_type === 'scheduled-executive-run' &&
        action.summary === 'Scheduled executive team run'
    );
  if (!latest) return { run: true, reason: 'first scheduled cycle' };
  const lastStarted = Date.parse(latest.started_at || '');
  if (!Number.isFinite(lastStarted)) return { run: true, reason: 'unknown last cycle time' };
  const newOwnerRequest = store
    .listExecutiveWorkItems({ source_type: 'owner-request', limit: 1000, quiet: 0 })
    .some(item => Date.parse(item.created_at || '') > lastStarted);
  if (newOwnerRequest) return { run: true, reason: 'new owner request' };
  if (now - lastStarted >= minimumMinutes * 60 * 1000)
    return { run: true, reason: 'hourly delivery triage due' };
  return {
    run: false,
    reason: `planning cooldown; next hourly triage at ${new Date(lastStarted + minimumMinutes * 60 * 1000).toISOString()}`,
  };
}

module.exports = { shouldRunPlanning };
