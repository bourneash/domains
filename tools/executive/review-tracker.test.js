'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('../fleet-dashboard/server/eventstore');
const { buildFor, reconcile } = require('./review-tracker');

test('connected build evidence must match the merged main commit', () => {
  const cache = {
    builds: [
      { repo: 'example.com', branch: 'improvement/abc', commitHash: 'merge', outcome: 'success' },
      { repo: 'example.com', branch: 'main', commitHash: 'other', outcome: 'success' },
    ],
  };
  assert.equal(buildFor(cache, 'example.com', 'merge'), null);
  cache.builds.push({
    repo: 'example.com',
    branch: 'main',
    commitHash: 'merge',
    outcome: 'success',
    uuid: 'build-1',
  });
  assert.equal(buildFor(cache, 'example.com', 'merge').uuid, 'build-1');
});

test('failed connected review check blocks release without counting a deployment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-tracker-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  const work = require('./delivery-lane').WORK[0];
  const request = store.createChangeRequest({
    site: work.site,
    title: work.title,
    action_key: work.action_key,
    delivery_mode: 'pull_request',
    status: 'committed',
  });
  const run = store.createImprovement({
    site: work.site,
    source: 'test',
    source_id: request.request_id,
    title: work.title,
    approval: {
      pull_request: { number: 1, url: 'https://github.com/bourneash/howtofry.com/pull/1' },
    },
  });
  store.updateChangeRequest(request.request_id, { run_id: run.run_id });
  const api = async (_root, _repo, endpoint) =>
    endpoint.startsWith('/pulls/')
      ? {
          state: 'open',
          merged_at: null,
          merge_commit_sha: null,
          html_url: 'https://github.com/bourneash/howtofry.com/pull/1',
          head: { sha: 'head' },
        }
      : {
          check_runs: [
            { name: 'verify', conclusion: 'success' },
            { name: 'Workers Builds: howtofry-com', conclusion: 'failure' },
          ],
        };
  const rows = await reconcile(store, root, { api, cache: { builds: [] } });
  assert.equal(rows[0].gate, 'failed');
  assert.equal(store.getChangeRequest(request.request_id).status, 'committed');
  assert.equal(store.getImprovement(run.run_id).approval.review_gate, 'failed');
  store.close();
});
