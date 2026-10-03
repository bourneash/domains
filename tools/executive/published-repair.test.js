'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('../fleet-dashboard/server/eventstore');
const repair = require('./published-repair');
const headSha = 'a'.repeat(40),
  baseSha = 'b'.repeat(40);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'published-repair-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = store.createChangeRequest({
    site: 'example.com',
    title: 'Repair user navigation',
    body: 'Concrete scoped repair',
    delivery_mode: 'pull_request',
  });
  const run = store.createImprovement({
    site: request.site,
    source: 'fleet-dashboard',
    source_id: request.request_id,
    title: request.title,
    branch: 'improvement/original',
    workspace_path: path.join(root, 'original-workspace'),
    state: 'review',
    validation: { passed: true },
    approval: {
      pull_request: {
        url: 'https://github.com/org/example/pull/3',
        state: 'open',
        head_sha: headSha,
      },
    },
  });
  store.updateChangeRequest(request.request_id, { status: 'committed', run_id: run.run_id });
  const workId = `delivery-recovery:${request.request_id}`;
  store.createExecutiveWorkItem({
    work_id: workId,
    title: 'Repair original delivery',
    kind: 'incident',
    status: 'ready',
    site: request.site,
    source_id: request.request_id,
    owner: 'engineering-manager',
  });
  return { store, requestId: request.request_id, headSha, baseSha, workId, run };
}

test('published repair preserves request, run, workspace and PR and invalidates old validation', t => {
  const f = fixture(t),
    result = repair.begin(f.store, { ...f, leaseOwner: 'owned-run' });
  assert.equal(result.run.run_id, f.run.run_id);
  assert.equal(result.run.workspace_path, f.run.workspace_path);
  assert.equal(result.run.approval.pull_request.url, f.run.approval.pull_request.url);
  assert.equal(result.run.validation.passed, false);
  assert.equal(f.store.getChangeRequest(f.requestId).status, 'committed');
  assert.equal(f.store.getExecutiveWorkItem(f.workId).lease_owner, 'owned-run');
  assert.throws(() => repair.begin(f.store, { ...f, leaseOwner: 'other-run' }), /original open PR/);
});

test('stale observations and competing leases cannot start published repair', t => {
  const f = fixture(t);
  assert.throws(() => repair.begin(f.store, { ...f, headSha: 'c'.repeat(40) }), /current head/);
  assert.ok(f.store.claimExecutiveWorkItem(f.workId, 'first-owner', 900));
  assert.throws(
    () => repair.begin(f.store, { ...f, leaseOwner: 'second-owner' }),
    /owned by another/
  );
  assert.equal(f.store.getImprovement(f.run.run_id).state, 'review');
});

test('repair completion is fenced and requires canonical CI evidence before review', t => {
  const f = fixture(t);
  repair.begin(f.store, { ...f, leaseOwner: 'first-owner' });
  assert.throws(
    () => repair.finish(f.store, { ...f, leaseOwner: 'stale-owner', passed: true, evidence: {} }),
    /stale repair callback/
  );
  assert.throws(
    () =>
      repair.finish(f.store, {
        ...f,
        leaseOwner: 'first-owner',
        passed: true,
        evidence: { canonical_ci_passed: true },
      }),
    /actual canonical CI/
  );
  repair.finish(f.store, {
    ...f,
    leaseOwner: 'first-owner',
    passed: true,
    evidence: {
      canonical_ci_passed: true,
      validation: { passed: true, checks: { ci: { status: 'pass' } } },
    },
  });
  assert.equal(f.store.getImprovement(f.run.run_id).state, 'review');
  assert.equal(f.store.getExecutiveWorkItem(f.workId).status, 'waiting');
  assert.equal(f.store.getChangeRequest(f.requestId).status, 'committed');
  assert.throws(
    () => repair.begin(f.store, { ...f, leaseOwner: 'second-owner' }),
    /unchanged delivery evidence/
  );
});

test('failed repair remains blocked with original implementation and actual failure evidence', t => {
  const f = fixture(t);
  repair.begin(f.store, { ...f, leaseOwner: 'first-owner' });
  repair.finish(f.store, {
    ...f,
    leaseOwner: 'first-owner',
    passed: false,
    evidence: { error: 'canonical CI failed', canonical_ci_passed: false },
  });
  assert.equal(f.store.getImprovement(f.run.run_id).state, 'building');
  assert.equal(
    f.store.getImprovement(f.run.run_id).outcome.published_repair.evidence.error,
    'canonical CI failed'
  );
  assert.equal(f.store.getExecutiveWorkItem(f.workId).status, 'blocked');
  assert.equal(f.store.getChangeRequest(f.requestId).status, 'committed');
});

test('new persisted failure evidence permits a different bounded observation without forgetting prior attempts', t => {
  const f = fixture(t);
  repair.begin(f.store, { ...f, leaseOwner: 'first-owner' });
  repair.finish(f.store, {
    ...f,
    leaseOwner: 'first-owner',
    passed: true,
    evidence: {
      canonical_ci_passed: true,
      validation: { passed: true, checks: { ci: { status: 'pass' } } },
    },
  });
  assert.throws(
    () => repair.begin(f.store, { ...f, observationSha: 'invented', leaseOwner: 'second-owner' }),
    /persisted evidence digest/
  );
  repair.begin(f.store, { ...f, observationSha: 'c'.repeat(64), leaseOwner: 'second-owner' });
  assert.equal(f.store.getExecutiveWorkItem(f.workId).attempts, 2);
  assert.equal(
    f.store.getExecutiveWorkItem(f.workId).labels.filter(x => x.startsWith('repair-observation:'))
      .length,
    2
  );
  assert.equal(
    f.store.getImprovement(f.run.run_id).outcome.published_repair.observation_sha,
    'c'.repeat(64)
  );
});
