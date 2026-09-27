#!/usr/bin/env bash
set -euo pipefail

# Deterministic measurement is cheap and does not launch an AI worker. It runs
# before the next executive tick so the CEO sees the latest measured outcomes.
# This is hourly and deterministic; it does not consume model tokens.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# The production job runs inside fleet-cron, where data-hub-api is reachable
# by service name. Keep manual/operator invocations deterministic too, while
# still allowing the scheduler's explicit DATAHUB_API override.
if [[ -z "${DATAHUB_API:-}" ]]; then
  if [[ -f /.dockerenv ]]; then
    export DATAHUB_API="http://datahub-api:4760"
  else
    export DATAHUB_API="http://127.0.0.1:4760"
  fi
fi
node - "$ROOT" <<'NODE'
const root = process.argv[2];
const measurements = require(`${root}/tools/fleet-dashboard/server/measurement-runner`);
const eventstore = require(`${root}/tools/fleet-dashboard/server/eventstore`);
const productivity = require(`${root}/tools/fleet-dashboard/server/productivity-program`);
measurements.run({ root })
  .then(result => {
    const store = eventstore.open(root);
    const pilots = store.listProductivityPilots({ status: 'active', limit: 20 });
    const snapshots = [];
    for (const pilot of pilots) {
      const current = productivity.snapshot(store, {
        from: pilot.start_at,
        to: new Date().toISOString(),
        treatment_sites: pilot.treatment_sites,
        control_sites: pilot.control_sites,
      });
      const last = store.listProductivitySnapshots(pilot.pilot_id, { limit: 1 })[0];
      const lastAt = Date.parse(last?.created_at || '');
      // Measurement jobs may run more often than the evidence cadence. Keep
      // the trail useful without writing duplicate snapshots in one interval.
      if (Number.isFinite(lastAt) && Date.now() - lastAt < 10 * 60 * 1000) continue;
      store.createProductivitySnapshot({
        pilot_id: pilot.pilot_id,
        phase: 'progress',
        snapshot: current,
      });
      snapshots.push({ pilot_id: pilot.pilot_id, snapshot: current });
    }
    store.close();
    process.stdout.write(JSON.stringify({ measurement: result, productivity_snapshots: snapshots }) + '\n');
  })
  .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
NODE
