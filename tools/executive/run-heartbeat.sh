#!/usr/bin/env bash
set -euo pipefail

# Cheap hourly control-plane check. This does not invoke a model: it records
# whether executive work is moving toward a measured outcome and only posts a
# message when the delivery state changes or a new attention item appears.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
node - "$ROOT" <<'NODE'
const root = process.argv[2];
const heartbeat = require(`${root}/tools/executive/heartbeat`);
const agentHeartbeat = require(`${root}/tools/executive/agent-heartbeat`);
const eventstore = require(`${root}/tools/fleet-dashboard/server/eventstore`);
const result = heartbeat.run({ root });
const store = eventstore.open(root);
try {
  const runtime = agentHeartbeat.tick(store);
  process.stdout.write(JSON.stringify({ scorecard: result.scorecard, runtime }) + '\n');
} finally {
  store.close();
}
NODE
