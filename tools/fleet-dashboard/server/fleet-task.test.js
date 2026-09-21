'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('./eventstore');
const fleetTask = require('./fleet-task');

test('publishes an audited fleet operating baseline without touching a site checkout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-task-'));
  fs.mkdirSync(path.join(root, 'sites', 'example.com', 'ops'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sites', '3boobs.com', 'ops'), { recursive: true });
  const store = eventstore.open(root);
  const request = {
    request_id: 'fleet-test-request',
    site: 'fleet',
    action_key: fleetTask.ACTION_KEY,
  };
  const result = fleetTask.execute({ root, store, request });
  assert.equal(result.action_key, fleetTask.ACTION_KEY);
  assert.equal(result.evidence.discovered_sites, 1);
  const artifact = JSON.parse(
    fs.readFileSync(fleetTask.artifactPath(root, request.request_id), 'utf8')
  );
  assert.deepEqual(artifact.scope.excluded_sites, ['3boobs.com']);
  assert.equal(artifact.evidence.discovered_sites, 1);
  store.close();
});

test('rejects any non-allowlisted fleet operation', () => {
  assert.throws(
    () =>
      fleetTask.execute({
        root: os.tmpdir(),
        store: { listChangeRequests: () => [], listImprovements: () => [] },
        request: { site: 'fleet', action_key: 'anything-else' },
      }),
    /unsupported fleet operation/
  );
});
