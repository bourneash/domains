#!/usr/bin/env bash
set -euo pipefail

# Build the shared read-only telemetry bundle before the next executive tick.
# This is intentionally deterministic at the orchestration layer: no model is
# needed to collect the data and no owner approval is required.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
node - "$ROOT" <<'NODE'
const root = process.argv[2];
const runner = require(`${root}/tools/executive/runner`);
const intel = require(`${root}/tools/fleet-dashboard/server/executive-intel`);
const snapshot = require(`${root}/tools/fleet-dashboard/server/executive-snapshot`);
const eventstore = require(`${root}/tools/fleet-dashboard/server/eventstore`);
const executive = require(`${root}/tools/fleet-dashboard/server/executive`);

(async () => {
  const sites = runner.executiveSites(root);
  const value = await intel.collect({ root, sites });
  const saved = snapshot.write(root, value);
  const store = eventstore.open(root);
  const audit = executive.action(store, {
    actor: 'system',
    action_type: 'observe',
    summary: 'Scheduled executive intelligence snapshot generated',
    target_type: 'executive-intelligence-snapshot',
    target_id: saved.generated_at,
  });
  executive.finishAction(store, audit.action_id, {
    status: 'completed',
    result: {
      generated_at: saved.generated_at,
      file: saved.file,
      managed_sites: sites.length,
      source_count: Object.keys(value.sources || {}).length,
    },
  });
  store.close();
  process.stdout.write(JSON.stringify({ generated_at: saved.generated_at, sites: sites.length }) + '\n');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
NODE
