#!/usr/bin/env bash
set -euo pipefail

# One-shot scheduler entrypoint. The fleet scheduler runs this hourly;
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
settings="$(node -e "const s=require('$ROOT/tools/fleet-dashboard/server/eventstore').open('$ROOT'); const x=s.getExecutiveSettings(); const q=s.getChangeQueueSettings(); const enabled=x.queue_execution_enabled === undefined ? q.enabled === true : x.queue_execution_enabled === true; process.stdout.write([x.tick_enabled === true ? '1' : '0', enabled ? '1' : '0'].join('|')); s.close()" 2>/dev/null || printf '0|0')"
IFS='|' read -r enabled queue_enabled <<<"$settings"
# EXECUTIVE_FORCE bypasses the recurring tick_enabled switch for an operator
# run, but never bypasses the separately reviewed queue_execution setting.
# Reading both settings in every mode also keeps queue_enabled initialized
# under set -u, which previously made forced/manual runs brittle.
if [[ "${EXECUTIVE_FORCE:-0}" != "1" && "$enabled" != "1" ]]; then
  echo "[$(date -Is)] executive scheduled tick skipped: tick_enabled is false"
  exit 0
fi
if [[ "$queue_enabled" == "1" ]]; then
  export EXECUTIVE_ALLOW_QUEUE=1
else
  export EXECUTIVE_ALLOW_QUEUE=0
fi
# Keep the leadership sequence hungry and deterministic. Each pass is still
# bounded, and run-sandbox.sh applies the hard wall-clock/container cap.
export EXECUTIVE_PASSES="${EXECUTIVE_PASSES:-product-manager-fleet,product-manager-sites,cro,ceo,cfo,cto,legal,security,reviewer}"
export EXECUTIVE_PASS_TIMEOUT_MS="${EXECUTIVE_PASS_TIMEOUT_MS:-120000}"
export EXECUTIVE_CONTAINER_TIMEOUT="${EXECUTIVE_CONTAINER_TIMEOUT:-14m}"
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
APPROVED_WORK_STATUS=0
finish_scheduler_action() {
  local exit_code=$?
  node - "$ROOT" "$RUN_ACTION_ID" "$exit_code" "$APPROVED_WORK_STATUS" <<'NODE'
const root = process.argv[2];
const actionId = process.argv[3];
const exitCode = Number(process.argv[4]);
const approvedWorkStatus = Number(process.argv[5]);
const eventstore = require(`${root}/tools/fleet-dashboard/server/eventstore`);
const executive = require(`${root}/tools/fleet-dashboard/server/executive`);
const store = eventstore.open(root);
try {
  const scheduled = store.getExecutiveAction(actionId);
  const scheduledStarted = Date.parse(scheduled?.started_at || '') || 0;
  const tick = store
    .listExecutiveActions({ action_type: 'tick', limit: 20 })
    .find(row => (Date.parse(row.started_at || '') || 0) >= scheduledStarted - 1000);
  const tickError = tick?.error || null;
  executive.finishAction(store, actionId, {
    status: exitCode === 0 ? 'completed' : 'failed',
    error:
      exitCode === 0
        ? null
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
      failed_stage: exitCode === 0 ? null : tickError ? 'executive tick / plan application' : 'scheduler wrapper',
      failure_reason: tickError || (exitCode === 0 ? null : `dispatch exited with code ${exitCode}`),
    },
  });
} finally {
  store.close();
}
NODE
  return "$exit_code"
}
trap finish_scheduler_action EXIT
echo "[$(date -Is)] executive scheduled tick start"
# Approved work is routed deterministically before the model starts. A
# failure here is audited but must not prevent the leadership pass from
# running; the normal queue/reviewer path remains authoritative.
if [[ "$queue_enabled" == "1" ]]; then
  if "$ROOT/tools/executive/run-approved-work.sh"; then
    :
  else
    APPROVED_WORK_STATUS=$?
    echo "[$(date -Is)] approved-work drain failed; continuing with executive tick" >&2
  fi
fi
"$ROOT/tools/executive/run-sandbox.sh"
"$ROOT/tools/executive/checkin.sh"
echo "[$(date -Is)] executive scheduled tick complete"
