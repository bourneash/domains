'use strict';

// Fleet-level executive work is deliberately narrower than site implementation
// work. These operations run in the trusted Fleet Manager control plane, never
// in a site checkout, and are allowlisted by action_key before they can write.

const fs = require('node:fs');
const path = require('node:path');
const { discoverSites } = require('./sites');
const executiveSnapshot = require('./executive-snapshot');

const ACTION_KEY = 'publish-fleet-operating-baseline';

function artifactPath(root, requestId) {
  return path.join(
    root,
    'tools',
    'fleet-dashboard',
    'data',
    'executive-reports',
    `${requestId}.json`
  );
}

function managedSites(root) {
  return discoverSites(root).filter(site => site !== '3boobs.com');
}

function execute({ root, store, request } = {}) {
  if (!request || request.site !== 'fleet' || request.action_key !== ACTION_KEY)
    throw new Error('unsupported fleet operation');

  const sites = managedSites(root);
  const requests = store.listChangeRequests({ limit: 1000 });
  const improvements = store.listImprovements({ limit: 1000 });
  const snapshot = executiveSnapshot.readLatest(root, { sites });
  const baseline = {
    schema: 'executive-fleet-operating-baseline/v1',
    generated_at: new Date().toISOString(),
    source: 'executive-control-plane',
    action_key: ACTION_KEY,
    scope: { managed_sites: sites, excluded_sites: ['3boobs.com'] },
    evidence: {
      discovered_sites: sites.length,
      queued_requests: requests.filter(row => row.status === 'queued').length,
      active_requests: requests.filter(row =>
        ['claimed', 'running', 'reviewing'].includes(row.status)
      ).length,
      review_requests: requests.filter(row => row.status === 'review').length,
      failed_requests: requests.filter(row => row.status === 'failed').length,
      active_improvements: improvements.filter(row =>
        ['proposed', 'building', 'review', 'deployed', 'measuring'].includes(row.state)
      ).length,
      executive_snapshot_generated_at: snapshot?.generated_at || null,
      executive_snapshot_available: Boolean(snapshot),
    },
    interpretation:
      'This is a factual operating baseline for executive prioritization. Missing telemetry is represented as unavailable, never as zero.',
  };
  const file = artifactPath(root, request.request_id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(baseline, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
  return {
    action_key: ACTION_KEY,
    artifact: { file, url: `/api/change-requests/${request.request_id}/report` },
    evidence: baseline.evidence,
  };
}

module.exports = { ACTION_KEY, artifactPath, managedSites, execute };
