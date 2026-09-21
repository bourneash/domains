#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
node - "$ROOT" <<'NODE'
const root = process.argv[2];
const dispatcher = require(`${root}/tools/fleet-dashboard/server/domain-dispatcher`);
(async () => {
  const queued = dispatcher.enqueueLatest(root);
  const result = await dispatcher.runOne(root);
  process.stdout.write(JSON.stringify({ added: queued.added.length, result }) + '\n');
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
NODE
