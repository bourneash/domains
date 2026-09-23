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
measurements.run({ root })
  .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
  .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
NODE
