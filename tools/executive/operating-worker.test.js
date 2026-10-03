'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('../fleet-dashboard/server/eventstore');
const executive = require('../fleet-dashboard/server/executive');
const worker = require('./operating-worker');
const dispatcher = require('./agent-dispatcher');
const runtime = require('./agent-runtime');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-operating-worker-'));
  fs.mkdirSync(path.join(root, 'sites'), { recursive: true });
  return { root, store: eventstore.open(root, { file: path.join(root, 'events.sqlite') }) };
}

test('manager follows the same linked worker through review and confirmed release', () => {
  const { store } = fixture();
  const owner = executive.ownerRequest(store, { body: 'Fix the search input.' });
  const request = store.createChangeRequest({
    site: 'example.test',
    title: 'Fix search',
    delivery_mode: 'pull_request',
    status: 'committed',
  });
  store.createWorkflowLink({
    from_type: 'work-item',
    from_id: owner.execution.task.work_id,
    to_type: 'request',
    to_id: request.request_id,
    relation: 'related_to',
  });
  worker.reconcileManagerDelivery(store);
  assert.equal(store.getExecutiveWorkItem(owner.execution.task.work_id).status, 'in_progress');
  const improvement = store.createImprovement({
    site: 'example.test',
    title: 'Fix search',
    source: 'fleet-dashboard',
    source_id: request.request_id,
    state: 'measuring',
    deployment_id: 'build',
    validation: { passed: true, commit: 'abc' },
    approval: {
      approved_at: new Date().toISOString(),
      release: { status: 'verified', build_id: 'build', commit: 'build' },
    },
    outcome: { deployment_verified_at: new Date().toISOString() },
  });
  store.updateChangeRequest(request.request_id, { status: 'deployed', run_id: improvement.run_id });
  worker.reconcileManagerDelivery(store);
  assert.equal(store.getExecutiveWorkItem(owner.execution.task.work_id).status, 'done');
  assert.equal(store.getExecutiveWorkItem(owner.work_item.work_id).lifecycle_state, 'closed');
  assert.equal(worker.reconcileManagerDelivery(store).length, 0);
  store.close();
});

test('revalidation preserves release hold and invokes no model or replacement worker', async () => {
  const { root, store } = fixture();
  const owner = executive.ownerRequest(store, {
    body: 'Deny deployment: site preview failed; preserve for revalidation.',
  });
  const result = await worker.processOperatingManager(
    store,
    root,
    { owner: 'engineering-manager', slug: 'fleet-engineering-manager', promptRole: 'cto' },
    {
      sandboxRunner: () => {
        throw new Error('must not invoke model');
      },
    }
  );
  assert.ok(result.result, JSON.stringify({ result, owner }));
  assert.equal(result.result.delivery_status, 'blocked_with_owner');
  assert.equal(store.getExecutiveWorkItem(owner.execution.task.work_id).status, 'blocked');
  assert.equal(store.listChangeRequests({ limit: 100 }).length, 0);
  store.close();
});

test('site factory consumer turns a manager dispatch into a host onboarding job', async () => {
  const { root, store } = fixture();
  const request = executive.ownerRequest(store, {
    body: 'Build and onboard a new website at fryexample.test for the fleet.',
  });
  const result = await worker.processSiteFactory(store, root, {
    workerId: 'test-operating-worker',
  });
  assert.equal(result.processed, true);
  assert.equal(result.error, undefined);
  assert.equal(result.result.lane, 'site-factory');
  assert.equal(result.result.domain, 'fryexample.test');
  assert.equal(store.getAgentDispatch(result.dispatch.run_id).status, 'succeeded');
  assert.equal(store.listAgentArtifacts({ work_id: request.execution.task.work_id }).length, 1);
  const jobs = fs.readdirSync(path.join(root, 'tools', 'fleet-dashboard', 'data', 'domain-jobs'));
  assert.equal(
    jobs.some(file => file.endsWith('.json')),
    true
  );
  store.close();
});

test('consumer fails closed for unsupported manager lanes', async () => {
  const { root, store } = fixture();
  const request = executive.ownerRequest(store, { body: 'Improve the SEO of the portfolio.' });
  const result = await worker.processSiteFactory(store, root, {
    workerId: 'test-operating-worker',
  });
  assert.equal(result.processed, false);
  assert.equal(store.getAgentDispatch(request.execution.run.run_id).status, 'queued');
  store.close();
});

test('a clean sandbox with no executable output is a failed delivery', async () => {
  const { store } = fixture();
  runtime.ensureRegistry(store);
  const agent = store.createAgent({
    slug: 'test-delivery-manager',
    name: 'Test Delivery Manager',
    title: 'Test Delivery Manager',
    role: 'manager',
    provider: 'chatgpt',
    adapter: 'codex',
  });
  const started = runtime.beginRun(store, {
    agent_id: agent.agent_id,
    work_id: 'failed-delivery-test',
    idempotency_key: 'failed-delivery-test',
  });
  const result = await dispatcher.processOne(store, {
    workerId: 'failed-delivery-test-worker',
    claimOptions: { agent_id: agent.agent_id, adapter: 'codex' },
    adapters: {
      codex: async () => ({
        delivery_status: 'failed_to_deliver',
        delivery_error: 'no executable output',
      }),
    },
  });
  assert.equal(result.delivery_failed, true);
  assert.equal(store.getAgentRun(started.run.run_id).status, 'failed');
  assert.equal(store.getAgentDispatch(started.run.run_id).status, 'failed');
  store.close();
});

test('reconciles host onboarding into a persistent build request without closing the owner request', async () => {
  const { root, store } = fixture();
  const request = executive.ownerRequest(store, {
    body: 'Build and onboard a new website at reconciliation.test for the fleet.',
  });
  const queued = await worker.processSiteFactory(store, root, {
    workerId: 'test-operating-worker',
  });
  const jobPath = path.join(
    root,
    'tools',
    'fleet-dashboard',
    'data',
    'domain-jobs',
    `${queued.result.job_id}.json`
  );
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  job.status = 'done';
  job.finishedAt = new Date().toISOString();
  job.exitCode = 0;
  fs.writeFileSync(jobPath, JSON.stringify(job, null, 2));
  fs.mkdirSync(path.join(root, 'sites', 'reconciliation.test'), { recursive: true });
  const reconciled = worker.reconcileSiteFactory(store, root);
  assert.equal(reconciled[0].status, 'building');
  assert.equal(store.getExecutiveWorkItem(request.execution.task.work_id).status, 'in_progress');
  assert.equal(store.getExecutiveWorkItem(request.work_item.work_id).lifecycle_state, 'actioned');
  const build = store.getChangeRequest(reconciled[0].build_request_id);
  assert.equal(build.delivery_mode, 'pull_request');
  assert.match(build.body, /Build and onboard a new website/);
  assert.equal(worker.reconcileSiteFactory(store, root).length, 0);
  store.close();
});

test('sensitive site onboarding remains an explicit owner concept gate', async () => {
  const { root, store } = fixture();
  const request = executive.ownerRequest(store, {
    body: 'Build magicescorts.com as a fictional magic performance site.',
  });
  const queued = await worker.processSiteFactory(store, root, {
    workerId: 'test-operating-worker',
  });
  const jobPath = path.join(
    root,
    'tools',
    'fleet-dashboard',
    'data',
    'domain-jobs',
    `${queued.result.job_id}.json`
  );
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  job.status = 'done';
  job.exitCode = 0;
  fs.writeFileSync(jobPath, JSON.stringify(job));
  fs.mkdirSync(path.join(root, 'sites', 'magicescorts.com'), { recursive: true });
  const reconciled = worker.reconcileSiteFactory(store, root);
  assert.equal(reconciled[0].status, 'blocked');
  assert.equal(
    store.getExecutiveWorkItem(request.execution.task.work_id).waiting_on,
    'owner-concept-decision'
  );
  assert.notEqual(store.getExecutiveWorkItem(request.work_item.work_id).lifecycle_state, 'closed');
  assert.equal(store.listChangeRequests({ site: 'magicescorts.com' }).length, 0);
  store.close();
});

test('completed host onboarding cannot overwrite a later owner decision or live milestone', async () => {
  const { root, store } = fixture();
  const request = executive.ownerRequest(store, {
    body: 'Build magicescorts.com as a magic performance site.',
  });
  const queued = await worker.processSiteFactory(store, root, {
    workerId: 'test-operating-worker',
  });
  const jobPath = path.join(
    root,
    'tools',
    'fleet-dashboard',
    'data',
    'domain-jobs',
    `${queued.result.job_id}.json`
  );
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  job.status = 'done';
  job.exitCode = 0;
  fs.writeFileSync(jobPath, JSON.stringify(job));
  fs.mkdirSync(path.join(root, 'sites', 'magicescorts.com'), { recursive: true });
  worker.reconcileSiteFactory(store, root);
  for (const id of [request.execution.task.work_id, request.work_item.work_id]) {
    store.updateExecutiveWorkItem(id, {
      status: 'in_progress',
      waiting_on: 'site-factory-manager',
      next_action: 'Public coming-soon site is live; finish affiliate and role work.',
    });
  }
  assert.deepEqual(worker.reconcileSiteFactory(store, root), []);
  for (const id of [request.execution.task.work_id, request.work_item.work_id]) {
    const item = store.getExecutiveWorkItem(id);
    assert.equal(item.status, 'in_progress');
    assert.equal(item.waiting_on, 'site-factory-manager');
    assert.match(item.next_action, /Public coming-soon site is live/);
  }
  store.close();
});
