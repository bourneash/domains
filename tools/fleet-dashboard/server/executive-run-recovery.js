'use strict';

// A manual run is detached from the dashboard request and may spend several
// minutes building the isolated image, authenticating the provider, and
// completing multiple executive passes. A missing PID during that window is
// not enough evidence of an orphan: the launcher can briefly disappear while
// its child process is still finishing the durable action.
const MANUAL_RUN_ORPHAN_GRACE_MS = 15 * 60 * 1000;

function isOrphanedManualRun(run, { now = Date.now(), pidAlive } = {}) {
  if (
    !run ||
    run.status !== 'started' ||
    run.target_type !== 'manual-executive-run' ||
    !run.result?.pid
  )
    return false;
  const started = Date.parse(run.started_at || '');
  if (!Number.isFinite(started) || now - started < MANUAL_RUN_ORPHAN_GRACE_MS) return false;
  if (typeof pidAlive !== 'function') return false;
  return !pidAlive(Number(run.result.pid));
}

module.exports = { MANUAL_RUN_ORPHAN_GRACE_MS, isOrphanedManualRun };
