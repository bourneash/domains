#!/usr/bin/env bash
set -euo pipefail

# One-shot scheduler entrypoint. The fleet scheduler runs this hourly;
# the sandbox wrapper supplies the single-flight lock and bounded container.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="$ROOT/tools/executive/logs"
mkdir -p "$LOG_DIR"
exec >>"$LOG_DIR/scheduled.log" 2>&1
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
export EXECUTIVE_PASSES="${EXECUTIVE_PASSES:-product-manager-fleet,product-manager-sites,cro,ceo,cfo,cto,legal,security,reviewer}"
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
finish_scheduler_action() {
  local exit_code=$?
  node - "$ROOT" "$RUN_ACTION_ID" "$exit_code" <<'NODE'
const root = process.argv[2];
const actionId = process.argv[3];
const exitCode = Number(process.argv[4]);
const eventstore = require(`${root}/tools/fleet-dashboard/server/eventstore`);
const executive = require(`${root}/tools/fleet-dashboard/server/executive`);
const store = eventstore.open(root);
try {
  executive.finishAction(store, actionId, {
    status: exitCode === 0 ? 'completed' : 'failed',
    error: exitCode === 0 ? null : `scheduled executive dispatch exited with code ${exitCode}`,
    result: { exit_code: exitCode, finished_at: new Date().toISOString() },
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
  "$ROOT/tools/executive/run-approved-work.sh" || echo "[$(date -Is)] approved-work drain failed; continuing with executive tick" >&2
fi
"$ROOT/tools/executive/run-sandbox.sh"
"$ROOT/tools/executive/checkin.sh"
echo "[$(date -Is)] executive scheduled tick complete"
