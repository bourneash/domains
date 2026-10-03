'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { reconcile, latestVerify } = require('./production-verification');
function fixture(name) {
  const request = {
    request_id: 'request',
    run_id: 'run',
    site: 'example.test',
    title: 'Feature',
    delivery_mode: 'direct',
    status: 'deployed',
  };
  const run = {
    run_id: 'run',
    site: 'example.test',
    state: 'deployed',
    deployment_id: 'a'.repeat(40),
    approval: { approved_at: 'actual' },
    outcome: { delivery_claimed: true },
  };
  const cases = new Map(),
    events = [];
  const store = {
    listChangeRequests: () => [request],
    getImprovement: () => run,
    updateImprovement: (id, patch) => Object.assign(run, patch),
    updateChangeRequest: (id, patch) => Object.assign(request, patch),
    getExecutiveWorkItem: id => cases.get(id),
    createExecutiveWorkItem: row => cases.set(row.work_id, row),
    updateExecutiveWorkItem: (id, patch) => Object.assign(cases.get(id), patch),
    record: row => events.push(row),
  };
  return {
    store,
    request,
    run,
    cases,
    events,
    root: '/tmp/production-check-' + name,
    options: { now: 100000, repositoryForSite: () => 'owner/repo' },
  };
}
test('exact production commit stays unverified while required check is pending or missing', async () => {
  for (const check of [null, { name: 'verify', status: 'in_progress', conclusion: null }]) {
    const f = fixture('pending-' + Boolean(check));
    await reconcile(f.store, f.root, {
      ...f.options,
      api: async () => ({ check_runs: check ? [check] : [] }),
    });
    assert.equal(f.run.approval.production_checks.gate, 'waiting');
    assert.equal(f.request.status, 'deployed');
    assert.equal(f.cases.size, 0);
  }
});
test('newest required check attempt controls the exact commit receipt', async () => {
  const f = fixture('passed'),
    rows = [
      { name: 'verify', status: 'completed', conclusion: 'failure', started_at: '2026-10-01' },
      {
        name: 'verify',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-10-03',
        details_url: 'https://github.com/owner/repo/actions/runs/2',
      },
    ];
  assert.equal(latestVerify(rows).conclusion, 'success');
  let called;
  await reconcile(f.store, f.root, {
    ...f.options,
    api: async (root, repo, endpoint) => {
      called = { repo, endpoint };
      return { check_runs: rows };
    },
  });
  assert.equal(called.repo, 'owner/repo');
  assert.match(called.endpoint, new RegExp(f.run.deployment_id));
  assert.equal(f.run.approval.production_checks.gate, 'passed');
  assert.equal(f.run.approval.production_checks.commit, f.run.deployment_id);
  assert.equal(
    (
      await reconcile(f.store, f.root, {
        ...f.options,
        api: async () => {
          throw Error('must not reread passing immutable receipt');
        },
      })
    ).length,
    0
  );
});
test('failed required production check preserves source and opens original recovery case', async () => {
  const f = fixture('failed'),
    commit = f.run.deployment_id;
  await reconcile(f.store, f.root, {
    ...f.options,
    api: async (root, repo, endpoint) =>
      endpoint.includes('/annotations')
        ? [{ message: 'Artifact storage quota hit' }]
        : {
            check_runs: [
              {
                id: 12,
                name: 'verify',
                status: 'completed',
                conclusion: 'failure',
                details_url: 'https://github.com/owner/repo/actions/runs/1',
              },
            ],
          },
  });
  assert.equal(f.request.status, 'failed');
  assert.equal(f.run.state, 'failed');
  assert.equal(f.run.deployment_id, commit);
  assert.equal(f.run.outcome.phase, 'production-verification');
  assert.match(f.request.error, /Artifact storage quota/);
  const work = f.cases.get('delivery-recovery:request');
  assert.equal(work.source_id, 'request');
  assert.equal(work.owner, 'engineering-manager');
  assert.equal(f.events.length, 1);
});
test('API errors preserve workflow state and concurrent pulses share one bounded poll', async () => {
  const f = fixture('network');
  await assert.rejects(
    reconcile(f.store, f.root, {
      ...f.options,
      api: async () => {
        throw Error('network unavailable');
      },
    }),
    /network unavailable/
  );
  assert.equal(f.request.status, 'deployed');
  assert.equal(f.run.approval.production_checks, undefined);
  const g = fixture('concurrent');
  let unblock;
  const api = () =>
    new Promise(resolve => {
      unblock = resolve;
    });
  const first = reconcile(g.store, g.root, { ...g.options, api });
  assert.deepEqual(await reconcile(g.store, g.root, { ...g.options, api }), []);
  unblock({ check_runs: [] });
  await first;
});
