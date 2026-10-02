#!/usr/bin/env bash
set -euo pipefail

# One-shot scheduler entrypoint. The fleet scheduler runs this every ten minutes;
# the sandbox wrapper supplies the single-flight lock and bounded container.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="$ROOT/tools/executive/logs"
mkdir -p "$LOG_DIR"
exec >>"$LOG_DIR/scheduled.log" 2>&1
# Serialize the entire scheduled transaction, including approved-work draining
# and check-in. This is the same lock used by manual dashboard runs and the
# sandbox; a second cron fire exits cleanly instead of overlapping work.
LOCK_FILE="${EXECUTIVE_LOCK_FILE:-$ROOT/tools/executive/data/executive.lock}"
exec 8>"$LOCK_FILE"
flock -n 8 || { echo "[$(date -Is)] executive scheduled tick already running"; exit 75; }
export EXECUTIVE_LOCK_HELD=1
export EXECUTIVE_SCOPE=fleet
settings="$(node -e "const s=require('$ROOT/tools/fleet-dashboard/server/eventstore').open('$ROOT'); const x=s.getExecutiveSettings(); const q=s.getChangeQueueSettings(); const enabled=x.queue_execution_enabled === undefined ? q.enabled === true : x.queue_execution_enabled === true; process.stdout.write([x.tick_enabled === true ? '1' : '0', enabled ? '1' : '0'].join('|')); s.close()" 2>/dev/null || printf '0|0')"
IFS='|' read -r enabled queue_enabled <<<"$settings"
complete_calendar_skip() {
  [[ -n "${CALENDAR_EVENT_ID:-}" ]] || return 0
  node - "$ROOT" "$CALENDAR_EVENT_ID" "$1" <<'NODE'
const root = process.argv[2];
const id = process.argv[3];
const reason = process.argv[4];
const cal = require(`${root}/tools/fleet-dashboard/server/executive-calendar`);
cal.completeClaim(root, id, process.env.CALENDAR_CLAIM_ID, { exit_code: 0, skipped: true, reason });
NODE
}
# EXECUTIVE_FORCE bypasses the recurring tick_enabled switch for an operator
# run, but never bypasses the separately reviewed queue_execution setting.
# Reading both settings in every mode also keeps queue_enabled initialized
# under set -u, which previously made forced/manual runs brittle.
if [[ ( "${EXECUTIVE_FORCE:-0}" != "1" || -n "${CALENDAR_EVENT_ID:-}" ) && "$enabled" != "1" ]]; then
  echo "[$(date -Is)] executive scheduled tick skipped: tick_enabled is false"
  complete_calendar_skip 'tick disabled'
  exit 0
fi
if [[ "$queue_enabled" == "1" ]]; then
  export EXECUTIVE_ALLOW_QUEUE=1
else
  export EXECUTIVE_ALLOW_QUEUE=0
fi
# Keep the deterministic approved-work drain on every cron fire. Only the
# speculative model planning pass is cooled down; delivery must not stall.
APPROVED_WORK_STATUS=0
if [[ "$queue_enabled" == "1" ]]; then
  if "$ROOT/tools/executive/run-approved-work.sh"; then
    :
  else
    APPROVED_WORK_STATUS=$?
    echo "[$(date -Is)] approved-work drain failed; continuing with delivery triage" >&2
  fi
fi
# Pressure is checked after the deterministic approved-work drain so an
# immediately executable handoff is not misreported as an empty pipeline.
node "$ROOT/tools/executive/delivery-pressure.js" || echo "[$(date -Is)] delivery pressure check failed" >&2
if [[ "${EXECUTIVE_FORCE:-0}" != "1" || -n "${CALENDAR_EVENT_ID:-}" ]]; then
  cadence="$(node - "$ROOT" <<'NODE'
const root = process.argv[2];
const store = require(`${root}/tools/fleet-dashboard/server/eventstore`).open(root);
const { shouldRunPlanning } = require(`${root}/tools/executive/scheduler-cadence`);
try { process.stdout.write(JSON.stringify(shouldRunPlanning(store))); }
finally { store.close(); }
NODE
)"
  if [[ "$(node -p 'JSON.parse(process.argv[1]).run' "$cadence")" != "true" ]]; then
    echo "[$(date -Is)] executive scheduled tick skipped: $(node -p 'JSON.parse(process.argv[1]).reason' "$cadence")"
    complete_calendar_skip 'planning cooldown'
    exit 0
  fi
fi
# Keep the leadership sequence hungry and deterministic. Each pass is still
# bounded, and run-sandbox.sh applies the hard wall-clock/container cap.
export EXECUTIVE_PASSES="${EXECUTIVE_PASSES:-adaptive}"
export EXECUTIVE_PASS_TIMEOUT_MS="${EXECUTIVE_PASS_TIMEOUT_MS:-120000}"
export EXECUTIVE_CONTAINER_TIMEOUT="${EXECUTIVE_CONTAINER_TIMEOUT:-9m}"
RUN_ACTION_ID="$(node - "$ROOT" "${EXECUTIVE_ACTION_ID:-}" <<'NODE'
const root = process.argv[2];
const existingActionId = process.argv[3];
const eventstore = require(`${root}/tools/fleet-dashboard/server/eventstore`);
const executive = require(`${root}/tools/fleet-dashboard/server/executive`);
const store = eventstore.open(root);
try {
  if (existingActionId) {
    const existing = store.getExecutiveAction(existingActionId);
    if (!existing) throw new Error(`executive action not found: ${existingActionId}`);
    process.stdout.write(existing.action_id);
  } else {
    const action = executive.action(store, {
      actor: 'system',
      action_type: 'other',
      summary: process.env.EXECUTIVE_FORCE === '1' ? 'Manual executive scheduler dispatch' : 'Scheduled executive team run',
      target_type: 'scheduled-executive-run',
      target_id: 'fleet',
      result: { phase: 'running', started_at: new Date().toISOString() },
    });
    process.stdout.write(action.action_id);
  }
} finally {
  store.close();
}
NODE
)"
export RUN_ACTION_ID
CHECKIN_STATUS=0
finish_scheduler_action() {
  local exit_code=$?
  node - "$ROOT" "$RUN_ACTION_ID" "$exit_code" "$APPROVED_WORK_STATUS" "$CHECKIN_STATUS" <<'NODE'
const root = process.argv[2];
const actionId = process.argv[3];
const exitCode = Number(process.argv[4]);
const approvedWorkStatus = Number(process.argv[5]);
const checkinStatus = Number(process.argv[6]);
const eventstore = require(`${root}/tools/fleet-dashboard/server/eventstore`);
const executive = require(`${root}/tools/fleet-dashboard/server/executive`);
const schedulerOutput = require(`${root}/tools/executive/scheduler-output`);
const deliveryReadiness = require(`${root}/tools/executive/delivery-readiness`);
const store = eventstore.open(root);
try {
  const scheduled = store.getExecutiveAction(actionId);
  const scheduledStarted = Date.parse(scheduled?.started_at || '') || 0;
  const tick = store
    .listExecutiveActions({ action_type: 'tick', limit: 20 })
    .find(row => (Date.parse(row.started_at || '') || 0) >= scheduledStarted - 1000);
  const tickError = tick?.error || null;
  const windowStart = scheduledStarted - 1000;
  const newRequests = store
    .listChangeRequests({ limit: 2000 })
    .filter(row => (Date.parse(row.created_at || '') || 0) >= windowStart);
  const newExecutableWork = schedulerOutput.executableWorkItems(
    store,
    store.listExecutiveWorkItems({ limit: 2000, quiet: 0 }).filter(row =>
      (Date.parse(row.created_at || '') || 0) >= windowStart
    ),
    windowStart
  );
  const readiness = deliveryReadiness.snapshot(store, root);
  const eligibleIds = new Set(
    [...readiness.eligibleQueued, ...readiness.working, ...readiness.delivered].map(
      row => row.request_id
    )
  );
  const newExecutableRequests = schedulerOutput.executableRequests(newRequests).filter(
    row => eligibleIds.has(row.request_id)
  );
  const failedToDeliver = schedulerOutput.failedToDeliver({
    exitCode,
    tickStatus: tick?.status,
    requests: newExecutableRequests,
    workItems: newExecutableWork,
  });
  const ceo = store.getAgent('fleet-ceo');
  const ceoRun = ceo
    ? store
        .listAgentRuns({ agent_id: ceo.agent_id, limit: 100 })
        .find(row => (Date.parse(row.started_at || '') || 0) >= windowStart)
    : null;
  if (failedToDeliver && ceoRun && !['failed', 'cancelled'].includes(ceoRun.status)) {
    store.updateAgentRun(ceoRun.run_id, {
      status: 'failed',
      error: 'executive failed_to_deliver: no executable change request or work item was created',
      result: { ...(ceoRun.result || {}), delivery_status: 'failed_to_deliver' },
    });
    store.completeAgentDispatchForRun(
      ceoRun.run_id,
      'failed',
      'executive failed_to_deliver: no executable change request or work item was created'
    );
  }
  const ownerAcknowledged = store
    .listExecutiveWorkItems({ source_type: 'owner-request', limit: 1000 })
    .some(item => {
      const answered = Date.parse(item.answered_at || '');
      return Number.isFinite(answered) && answered >= scheduledStarted;
    });
  const providerDeferred = /selected model is at capacity|model is at capacity|provider model is at capacity/i.test(
    String(tickError || '')
  );
  const status =
    failedToDeliver
      ? 'failed'
      : ownerAcknowledged && exitCode !== 0
      ? 'completed_with_warning'
      : exitCode !== 0
      ? providerDeferred
        ? 'completed_with_warning'
        : 'failed'
      : checkinStatus !== 0
        ? 'completed_with_warning'
        : 'completed';
  executive.finishAction(store, actionId, {
    status,
    error:
      failedToDeliver
        ? 'executive failed_to_deliver: no executable change request or work item was created'
        : ownerAcknowledged && exitCode !== 0
        ? `executive run degraded after acknowledging owner request; ${tickError || `dispatch exited with code ${exitCode}`}`
        : exitCode === 0
        ? checkinStatus !== 0
          ? `executive handoff check-in exited with code ${checkinStatus}`
          : null
        : providerDeferred
          ? `executive provider deferred the leadership pass: ${tickError}`
        : tickError
          ? `executive tick failed: ${tickError}`
          : `scheduled executive dispatch exited with code ${exitCode}`,
    result: {
      exit_code: exitCode,
      finished_at: new Date().toISOString(),
      tick_action_id: tick?.action_id || null,
      tick_status: tick?.status || null,
      tick_error: tickError,
      approved_work_status: approvedWorkStatus,
      approved_work_warning:
        approvedWorkStatus === 0 ? null : 'approved-work drain failed; executive tick continued',
      checkin_status: checkinStatus,
      checkin_warning:
        checkinStatus === 0 ? null : 'executive handoff check-in failed; retry is required',
      provider_deferred: providerDeferred,
      delivery_status: failedToDeliver ? 'failed_to_deliver' : 'delivered_or_blocked',
      new_change_requests: newRequests.length,
      new_executable_change_requests: newExecutableRequests.length,
      new_executable_work_items: newExecutableWork.length,
      owner_request_acknowledged: ownerAcknowledged,
      failed_stage:
        providerDeferred
          ? 'provider availability'
          : exitCode === 0
          ? checkinStatus === 0
            ? null
            : 'executive handoff check-in'
          : tickError
            ? 'executive tick / plan application'
            : 'scheduler wrapper',
      failure_reason:
        providerDeferred
          ? `provider unavailable: ${tickError}`
          : tickError ||
        (exitCode !== 0
          ? `dispatch exited with code ${exitCode}`
          : checkinStatus !== 0
            ? `handoff check-in exited with code ${checkinStatus}`
            : null),
    },
  });
} finally {
  store.close();
}
NODE
  if [[ -n "${CALENDAR_EVENT_ID:-}" ]]; then
    node - "$ROOT" "$CALENDAR_EVENT_ID" "$exit_code" <<'NODE'
const root = process.argv[2];
const id = process.argv[3];
const code = Number(process.argv[4]);
const cal = require(`${root}/tools/fleet-dashboard/server/executive-calendar`);
try {
  cal.completeClaim(root, id, process.env.CALENDAR_CLAIM_ID, { exit_code: code });
} catch (e) { if (e.status !== 404) throw e; }
NODE
    calendar_lock="${FLEET_GIT_MUTATION_LOCK_FILE:-$ROOT/tools/.git-mutation.lock}"
    exec 7>"$calendar_lock"
    if flock -w "${FLEET_GIT_MUTATION_LOCK_WAIT_SECONDS:-90}" 7; then
      git -C "$ROOT" add -- ops/executive/calendar.json
      if ! git -C "$ROOT" diff --cached --quiet -- ops/executive/calendar.json; then
        git -C "$ROOT" commit -m "chore(executive): record calendar run" -- ops/executive/calendar.json || true
        git -C "$ROOT" push origin main || echo "calendar completion push failed" >&2
      fi
    else
      echo "calendar completion check-in deferred: top-level Git mutation lock is busy" >&2
    fi
  fi
  return "$exit_code"
}
trap finish_scheduler_action EXIT
echo "[$(date -Is)] executive scheduled tick start"
"$ROOT/tools/executive/run-sandbox.sh"
if "$ROOT/tools/executive/checkin.sh"; then
  :
else
  CHECKIN_STATUS=$?
  echo "[$(date -Is)] executive handoff check-in failed; executive tick remains successful" >&2
fi
echo "[$(date -Is)] executive scheduled tick complete"
