#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
node - "$ROOT" <<'NODE'
const root = process.argv[2];
const eventstore = require(`${root}/tools/fleet-dashboard/server/eventstore`);
const executive = require(`${root}/tools/fleet-dashboard/server/executive`);
const manager = require(`${root}/tools/executive/project-manager`);
const runner = require(`${root}/tools/executive/runner`);
const sites = require(`${root}/tools/fleet-dashboard/server/sites`);
const store = eventstore.open(root);
const audit = executive.action(store, {
  actor: 'project-manager',
  action_type: 'delegate',
  summary: 'Fleet project manager triage tick',
  target_type: 'fleet-workflow-board',
  target_id: 'fleet',
});
try {
  executive.ensureOwnerRequests(store);
  const sla_notifications = executive.escalateOverdueWorkItems(store);
  const result = manager.run(store, {
    knownSite: site => site === 'fleet' || sites.isKnownSite(root, site),
    availableRolesForSite: site => {
      try { return require('node:fs').readdirSync(`${root}/sites/${site}/ops/roles`).filter(x => x.endsWith('.md')).map(x => x.slice(0, -3)); }
      catch { return []; }
    },
  });
  // Keep approved report-only proposals moving even when the hourly model
  // pass is skipped or fails. This uses the same bounded queue/review path as
  // the executive scheduler and never approves a proposal.
  result.approved_follow_through = runner.drainApprovedProposalQueue(store, { root, maxQueue: 2 });
  result.sla_notifications = sla_notifications.length;
  executive.finishAction(store, audit.action_id, { status: 'completed', result });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  executive.finishAction(store, audit.action_id, { status: 'failed', error: error.message });
  throw error;
} finally { store.close(); }
NODE
