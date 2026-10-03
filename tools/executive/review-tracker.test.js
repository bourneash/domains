'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('../fleet-dashboard/server/eventstore');
const { busyImplementationSites } = require('../fleet-dashboard/server/changequeue-view');
const { buildFor, latestCheck, reconcile } = require('./review-tracker');

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

test('review reconciliation uses the newest attempt for duplicate GitHub checks', () => {
  const checks = [
    { name: 'verify', conclusion: 'failure', started_at: '2026-10-03T01:00:00Z' },
    { name: 'verify', conclusion: 'success', started_at: '2026-10-03T02:00:00Z' },
    {
      name: 'Workers Builds: howtofry-com',
      conclusion: 'failure',
      created_at: '2026-10-03T01:00:00Z',
    },
    { name: 'Workers Builds: howtofry-com', conclusion: null, started_at: '2026-10-03T02:00:00Z' },
  ];
  assert.equal(latestCheck(checks, 'verify').conclusion, 'success');
  assert.equal(latestCheck(checks, 'Workers Builds: howtofry-com').conclusion, null);
  assert.equal(latestCheck(checks, 'missing'), null);
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

test('successful merged-main build completes review run and frees the next site task', async () => {
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
    state: 'review',
    validation: { passed: true, commit: 'head' },
    approval: {
      pull_request: { number: 1, url: 'https://github.com/bourneash/howtofry.com/pull/1' },
    },
  });
  store.updateChangeRequest(request.request_id, { run_id: run.run_id });
  const api = async (_root, _repo, endpoint) =>
    endpoint.startsWith('/pulls/')
      ? {
          state: 'closed',
          merged_at: '2026-10-03T02:24:00Z',
          merge_commit_sha: 'merged-main',
          html_url: 'https://github.com/bourneash/howtofry.com/pull/1',
          head: { sha: 'head' },
        }
      : {
          check_runs: [
            { name: 'verify', conclusion: 'success' },
            { name: 'Workers Builds: howtofry-com', conclusion: 'success' },
          ],
        };
  const cache = {
    builds: [
      {
        repo: work.site,
        branch: 'main',
        commitHash: 'merged-main',
        outcome: 'success',
        uuid: 'connected-build',
      },
    ],
  };
  await reconcile(store, root, { api, cache });
  assert.equal(store.getChangeRequest(request.request_id).status, 'deployed');
  assert.equal(store.getImprovement(run.run_id).state, 'deployed');
  assert.equal(store.getImprovement(run.run_id).deployment_id, 'merged-main');
  assert.equal(
    busyImplementationSites(
      store.listImprovements({ site: work.site }),
      store.listChangeRequests({ site: work.site })
    ).has(work.site),
    false
  );
  await reconcile(store, root, { api, cache });
  assert.equal(store.getImprovement(run.run_id).state, 'deployed');
  store.close();
});

test('ordinary published backlog PRs are tracked using their actual repository URL', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-all-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  try {
    const request = store.createChangeRequest({
      site: 'ordinary.example',
      title: 'Repair route',
      delivery_mode: 'pull_request',
      status: 'committed',
    });
    const run = store.createImprovement({
      site: request.site,
      title: request.title,
      source: 'test',
      source_id: request.request_id,
      state: 'review',
      validation: { passed: true, commit: 'head' },
      approval: {
        pull_request: { number: 12, url: 'https://github.com/bourneash/non-domain-repo/pull/12' },
      },
    });
    store.updateChangeRequest(request.request_id, { run_id: run.run_id });
    let calls = 0;
    const api = async (_root, repo, endpoint) => {
      calls++;
      assert.equal(repo, 'bourneash/non-domain-repo');
      return endpoint.startsWith('/pulls/')
        ? { state: 'open', head: { sha: 'head' }, html_url: run.approval.pull_request.url }
        : { check_runs: [{ name: 'verify', conclusion: 'failure' }] };
    };
    const rows = await reconcile(store, root, {
      api,
      cache: { builds: [] },
      alert: async () => {},
    });
    assert.equal(calls, 2);
    assert.equal(rows[0].gate, 'failed');
    assert.equal(store.getImprovement(run.run_id).approval.review_gate, 'failed');
    assert.equal(store.getChangeRequest(request.request_id).status, 'committed');
    const caseId = `delivery-recovery:${request.request_id}`;
    assert.equal(store.getExecutiveWorkItem(caseId).source_id, request.request_id);
    const before = store.getExecutiveWorkItem(caseId).updated_at;
    await reconcile(store, root, {
      api,
      cache: { builds: [] },
      alert: async () => {
        throw new Error('unchanged failure must not alert');
      },
    });
    assert.equal(store.getExecutiveWorkItem(caseId).updated_at, before);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('registered worker names and merge conflicts block ordinary delivery correctly', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-worker-'));
  fs.mkdirSync(path.join(root, 'registry'));
  fs.writeFileSync(
    path.join(root, 'registry/fleet.yaml'),
    'sites:\n  example.com:\n    worker: custom-worker\n'
  );
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  try {
    const request = store.createChangeRequest({
      site: 'example.com',
      title: 'Fix feature',
      delivery_mode: 'pull_request',
      status: 'committed',
    });
    const run = store.createImprovement({
      site: request.site,
      title: request.title,
      source: 'test',
      source_id: request.request_id,
      state: 'review',
      validation: { passed: true, commit: 'head' },
      approval: {
        pull_request: { number: 1, url: 'https://github.com/bourneash/custom-repo/pull/1' },
      },
    });
    store.updateChangeRequest(request.request_id, { run_id: run.run_id });
    let conflict = false;
    const api = async (_root, _repo, endpoint) =>
      endpoint.startsWith('/pulls/')
        ? {
            state: 'open',
            head: { sha: 'head' },
            mergeable: !conflict,
            mergeable_state: conflict ? 'dirty' : 'clean',
            html_url: run.approval.pull_request.url,
          }
        : {
            check_runs: [
              { name: 'verify', conclusion: 'success' },
              {
                name: 'Workers Builds: custom-worker',
                conclusion: conflict ? 'success' : 'failure',
              },
            ],
          };
    const options = { api, cache: { builds: [] }, alert: async () => {} };
    assert.equal((await reconcile(store, root, options))[0].gate, 'failed');
    conflict = true;
    assert.equal((await reconcile(store, root, options))[0].gate, 'failed');
    assert.equal(store.getChangeRequest(request.request_id).status, 'committed');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verified release resolves the original recovery case after its owner releases the lease', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-case-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  try {
    const request = store.createChangeRequest({
      site: 'example.com',
      title: 'Original repair',
      delivery_mode: 'pull_request',
      status: 'committed',
    });
    const run = store.createImprovement({
      site: request.site,
      title: request.title,
      source: 'test',
      source_id: request.request_id,
      state: 'review',
      validation: { passed: true, commit: 'head' },
      approval: { pull_request: { number: 1, url: 'https://github.com/bourneash/example/pull/1' } },
    });
    store.updateChangeRequest(request.request_id, { run_id: run.run_id });
    const workId = `delivery-recovery:${request.request_id}`;
    store.createExecutiveWorkItem({
      work_id: workId,
      title: 'Repair original delivery',
      kind: 'incident',
      status: 'ready',
      priority: 'high',
      owner: 'engineering-manager',
      site: request.site,
      source_type: 'change-request',
      source_id: request.request_id,
    });
    const owned = store.claimExecutiveWorkItem(workId, 'repair-owner', 1800);
    assert.ok(owned);
    const api = async (_root, _repo, endpoint) =>
      endpoint.startsWith('/pulls/')
        ? {
            state: 'closed',
            merged_at: '2026-10-03T02:00:00Z',
            merge_commit_sha: 'merge',
            html_url: run.approval.pull_request.url,
            head: { sha: 'head' },
          }
        : {
            check_runs: [
              { name: 'verify', conclusion: 'success' },
              { name: 'Workers Builds: example-com', conclusion: 'success' },
            ],
          };
    const cache = {
      builds: [
        {
          repo: request.site,
          branch: 'main',
          commitHash: 'merge',
          outcome: 'success',
          uuid: 'build-1',
          stoppedOn: '2026-10-03T02:01:00Z',
        },
      ],
    };
    await reconcile(store, root, { api, cache, alert: async () => {} });
    assert.notEqual(store.getExecutiveWorkItem(workId).status, 'done');
    store.releaseExecutiveWorkItem(workId, 'repair-owner');
    await reconcile(store, root, { api, cache, alert: async () => {} });
    const resolved = store.getExecutiveWorkItem(workId);
    assert.equal(resolved.status, 'done');
    assert.match(resolved.resolution_note, /merge.*build-1/);
    assert.equal(resolved.evidence.at(-1).verified_at, '2026-10-03T02:01:00Z');
    const before = resolved.updated_at;
    await reconcile(store, root, { api, cache, alert: async () => {} });
    assert.equal(store.getExecutiveWorkItem(workId).updated_at, before);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('post-merge verification must pass even when the PR and connected build passed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-gate-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  try {
    const request = store.createChangeRequest({
      site: 'example.com',
      title: 'Real feature',
      delivery_mode: 'pull_request',
      status: 'committed',
    });
    const run = store.createImprovement({
      site: request.site,
      title: request.title,
      source: 'test',
      source_id: request.request_id,
      state: 'review',
      validation: { passed: true, commit: 'head' },
      approval: { pull_request: { number: 1, url: 'https://github.com/bourneash/example/pull/1' } },
    });
    store.updateChangeRequest(request.request_id, { run_id: run.run_id });
    let conclusion = null;
    const api = async (_root, _repo, endpoint) =>
      endpoint.startsWith('/pulls/')
        ? {
            state: 'closed',
            merged_at: '2026-10-03T02:00:00Z',
            merge_commit_sha: 'merge',
            html_url: run.approval.pull_request.url,
            head: { sha: 'head' },
          }
        : {
            check_runs: [
              { name: 'verify', conclusion: endpoint.includes('/merge/') ? conclusion : 'success' },
              { name: 'Workers Builds: example-com', conclusion: 'success' },
            ],
          };
    const options = {
      api,
      cache: {
        builds: [
          {
            repo: request.site,
            branch: 'main',
            commitHash: 'merge',
            outcome: 'success',
            uuid: 'build-1',
          },
        ],
      },
      alert: async () => {},
    };
    assert.equal((await reconcile(store, root, options))[0].release, 'awaiting-connected-build');
    assert.equal(store.getChangeRequest(request.request_id).status, 'committed');
    conclusion = 'failure';
    assert.equal((await reconcile(store, root, options))[0].release, 'failed');
    assert.equal(store.getImprovement(run.run_id).approval.production_checks.gate, 'failed');
    assert.equal(
      store.getExecutiveWorkItem(`delivery-recovery:${request.request_id}`).status,
      'ready'
    );
    assert.equal(store.getChangeRequest(request.request_id).status, 'committed');
    conclusion = 'success';
    assert.equal((await reconcile(store, root, options))[0].release, 'verified');
    assert.equal(store.getChangeRequest(request.request_id).status, 'deployed');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
