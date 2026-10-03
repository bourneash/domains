'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { delivery, fingerprint } = require('./work-evidence');

test('report, branch and self-reported deployment never earn release credit', () => {
  assert.equal(
    delivery({ status: 'verified', delivery_mode: 'report_only' }, { state: 'reported' }).deployed,
    false
  );
  assert.equal(
    delivery(
      { status: 'committed', delivery_mode: 'pull_request' },
      {
        validation: { passed: true, commit: 'abc' },
        approval: { pull_request: { pushed: true } },
      }
    ).stage,
    'committed'
  );
  const run = {
    deployment_id: 'build',
    validation: { passed: true, commit: 'abc' },
    approval: { approved_at: '2026-10-03T00:00:00Z' },
    outcome: { deployment_verified_at: '2026-10-03T00:00:00Z' },
  };
  assert.equal(delivery({ status: 'deployed' }, run).deployed, false);
  run.approval.release = { status: 'verified', build_id: 'build', commit: 'build' };
  assert.equal(delivery({ status: 'deployed', delivery_mode: 'pull_request' }, run).deployed, true);
  assert.equal(delivery({ status: 'cancelled' }, run).deployed, false);
});

test('recovery fingerprint ignores bookkeeping and changes for new evidence', () => {
  const store = { listWorkflowLinks: () => [], listAgentRuns: () => [] };
  const task = { work_id: 'task', summary: 'Fix the search field', evidence: [] };
  const before = fingerprint(store, task);
  assert.equal(
    fingerprint(store, {
      ...task,
      updated_at: new Date().toISOString(),
      next_action: 'Retry 2',
      labels: ['overwatch-retry-2'],
    }),
    before
  );
  assert.notEqual(
    fingerprint(store, {
      ...task,
      evidence: [{ type: 'test', label: 'Browser installed', detail: 'pass' }],
    }),
    before
  );
});

test('connected release collector requires exact commit, successful default branch build and fresh live telemetry', () => {
  const { recordConnectedReleases } = require('./work-evidence');
  const now = Date.parse('2026-10-03T12:00:00Z');
  const run = {
    run_id: 'run',
    source_id: 'request',
    site: 'example.test',
    state: 'deployed',
    deployment_id: 'sha',
    validation: { passed: true, commit: 'sha' },
    approval: {
      approved_at: new Date(now).toISOString(),
      production_checks: { gate: 'passed', commit: 'sha' },
    },
  };
  let saved;
  const store = {
    listImprovements: () => [run],
    getChangeRequest: () => ({ delivery_mode: 'direct' }),
    updateImprovement: (id, patch) => {
      saved = patch;
    },
  };
  const live = {
    live: true,
    version: 2,
    worker: 'example',
    checkedAt: now,
    deployedAt: now / 1000,
  };
  const build = {
    worker: 'example',
    uuid: 'build',
    branch: 'main',
    commitHash: 'sha',
    outcome: 'success',
    stoppedOn: new Date(now - 1000).toISOString(),
  };
  for (const bad of [
    { ...build, commitHash: 'other' },
    { ...build, outcome: 'failed' },
    { ...build, branch: 'feature' },
  ])
    assert.deepEqual(
      recordConnectedReleases(store, { now, health: () => live, builds: [bad] }),
      []
    );
  assert.deepEqual(
    recordConnectedReleases(store, {
      now,
      health: () => ({ ...live, checkedAt: now - 3600000 }),
      builds: [build],
    }),
    []
  );
  assert.deepEqual(recordConnectedReleases(store, { now, health: () => live, builds: [build] }), [
    'run',
  ]);
  assert.equal(delivery({ delivery_mode: 'direct' }, { ...run, ...saved }).deployed, true);
});

test('abbreviated deployment SHA resolves uniquely and persists the full build commit', () => {
  const { recordConnectedReleases } = require('./work-evidence');
  const now = Date.parse('2026-10-03T12:00:00Z');
  const full = 'abcdef0' + '1'.repeat(33);
  const run = {
    run_id: 'run',
    source_id: 'request',
    site: 'example.test',
    state: 'deployed',
    deployment_id: full.slice(0, 7),
    validation: { passed: true, commit: full },
    approval: {
      approved_at: new Date(now).toISOString(),
      production_checks: { gate: 'passed', commit: full },
    },
  };
  let saved;
  const store = {
    listImprovements: () => [run],
    getChangeRequest: () => ({ delivery_mode: 'direct' }),
    updateImprovement: (id, patch) => {
      saved = patch;
    },
  };
  const live = {
    live: true,
    version: 2,
    worker: 'example',
    checkedAt: now,
    deployedAt: now / 1000,
  };
  const build = {
    worker: 'example',
    uuid: 'build',
    branch: 'main',
    commitHash: full,
    outcome: 'success',
    stoppedOn: new Date(now - 1000).toISOString(),
  };
  assert.deepEqual(recordConnectedReleases(store, { now, health: () => live, builds: [build] }), [
    'run',
  ]);
  assert.equal(saved.deployment_id, full);
  assert.equal(delivery({ delivery_mode: 'direct' }, { ...run, ...saved }).deployed, true);
  const ambiguous = { ...build, uuid: 'other', commitHash: full.slice(0, 7) + 'f'.repeat(33) };
  assert.deepEqual(
    recordConnectedReleases(store, { now, health: () => live, builds: [build, ambiguous] }),
    []
  );
  assert.deepEqual(
    recordConnectedReleases(store, {
      now,
      health: () => live,
      builds: [{ ...build, outcome: 'failed' }],
    }),
    []
  );
});

test('direct connected release waits for passing verification of the same production commit', () => {
  const { recordConnectedReleases } = require('./work-evidence');
  const now = 100000,
    run = {
      run_id: 'run',
      source_id: 'request',
      site: 'example.test',
      state: 'deployed',
      deployment_id: 'sha',
      validation: { passed: true, commit: 'sha' },
      approval: { approved_at: 'actual' },
    };
  const store = {
    listImprovements: () => [run],
    getChangeRequest: () => ({ delivery_mode: 'direct' }),
    updateImprovement: () => {},
  };
  const health = () => ({
    live: true,
    version: 2,
    worker: 'example',
    checkedAt: now,
    deployedAt: now / 1000,
  });
  const builds = [
    {
      worker: 'example',
      uuid: 'build',
      branch: 'main',
      commitHash: 'sha',
      outcome: 'success',
      stoppedOn: new Date(now - 1000).toISOString(),
    },
  ];
  for (const receipt of [
    undefined,
    { gate: 'waiting', commit: 'sha' },
    { gate: 'failed', commit: 'sha' },
    { gate: 'passed', commit: 'other' },
  ]) {
    run.approval.production_checks = receipt;
    assert.deepEqual(recordConnectedReleases(store, { now, health, builds }), []);
  }
  run.approval.production_checks = { gate: 'passed', commit: 'sha' };
  assert.deepEqual(recordConnectedReleases(store, { now, health, builds }), ['run']);
});
