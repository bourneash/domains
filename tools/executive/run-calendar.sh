#!/usr/bin/env bash
set -euo pipefail

# Durable calendar dispatcher. Claims are atomic and leased; only the fixed
# action registry in executive-calendar.js can launch a process.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOCK_FILE="$ROOT/tools/executive/data/calendar-dispatch.lock"
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 75

node - "$ROOT" <<'NODE'
const root = process.argv[2];
const cal = require(`${root}/tools/fleet-dashboard/server/executive-calendar`);
const { spawn } = require('node:child_process');
cal.reconcile(root, Date.now(), 'system');
const claims = cal.claimDue(root, Date.now(), 'system');
for (const event of claims) {
  let child = null;
  const action = event.action || { type: 'reminder' };
  if (action.type === 'executive-run') {
    const job = cal.JOBS['executive-run'];
    child = spawn('bash', [`${root}/${job.script}`], { cwd: root, detached: true, stdio: 'ignore', env: { ...process.env, EXECUTIVE_FORCE: '1', CALENDAR_EVENT_ID: event.id, CALENDAR_CLAIM_ID: event.claim_id } });
  } else if (action.type === 'job') {
    const job = cal.JOBS[action.key];
    child = spawn('bash', [`${root}/${job.script}`, ...job.args], { cwd: root, detached: true, stdio: 'ignore', env: { ...process.env, CALENDAR_EVENT_ID: event.id, CALENDAR_CLAIM_ID: event.claim_id } });
  }
  cal.markDispatched(root, event.id, event.claim_id, child ? { pid: child.pid, dispatched: true } : { dispatched: false, note: 'reminder requires role pickup' }, 'system');
  if (child) child.unref();
}
NODE

git -C "$ROOT" add -- ops/executive/calendar.json
if ! git -C "$ROOT" diff --cached --quiet -- ops/executive/calendar.json; then
  git -C "$ROOT" commit -m "chore(executive): persist calendar dispatch" -- ops/executive/calendar.json || exit 1
  git -C "$ROOT" push origin main || { echo "calendar push failed; local committed state remains for retry" >&2; exit 1; }
fi
