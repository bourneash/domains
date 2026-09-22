#!/usr/bin/env bash
set -euo pipefail

# Deterministic measurement is cheap and does not launch an AI worker. It runs
# before the next executive tick so the CEO sees the latest measured outcomes.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
node - "$ROOT" <<'NODE'
const root = process.argv[2];
const measurements = require(`${root}/tools/fleet-dashboard/server/measurement-runner`);
measurements.run({ root })
  .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
  .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
NODE
