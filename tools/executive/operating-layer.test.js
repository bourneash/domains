'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('../fleet-dashboard/server/eventstore');
const executive = require('../fleet-dashboard/server/executive');
const operating = require('./operating-layer');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-operating-layer-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  store.root = root;
  return store;
}

test('a deployment denial never creates a site factory job', () => {
  const store = fixture();
  const result = executive.ownerRequest(store, {
    body: 'Deny deployment: website build passes but preview failed; preserve for revalidation.',
  });
  assert.equal(result.execution.task.kind, 'implementation');
  assert.equal(result.execution.task.owner, 'engineering-manager');
  assert.ok(result.execution.task.labels.includes('intent:revalidation'));
  assert.match(result.execution.task.next_action, /Preserve the existing implementation/);
  const denial = executive.ownerRequest(store, { body: 'Deny deployment of the website.' });
  assert.equal(denial.execution.dispatch, null);
  assert.equal(denial.work_item.status, 'waiting');
  assert.equal(store.listChangeRequests({ limit: 100 }).length, 0);
  store.close();
});

test('historical denial is reclassified without restarting or authorizing work', () => {
  const store = fixture();
  const source = store.createExecutiveWorkItem({
    title: 'Owner hold',
    source_type: 'owner-request',
    summary: 'Deny deployment of the site.',
    owner: 'ceo',
  });
  const task = store.createExecutiveWorkItem({
    title: 'Execute owner request',
    source_type: 'operating-task',
    parent_work_id: source.work_id,
    summary: source.summary,
    kind: 'implementation',
    owner: 'site-factory-manager',
    status: 'in_progress',
  });
  const changed = operating.reconcileIntake(store, source, task);
  assert.equal(changed.kind, 'decision');
  assert.equal(changed.status, 'blocked');
  assert.equal(operating.reconcileIntake(store, source, changed).updated_at, changed.updated_at);
  store.close();
});

test('owner request creates manager task, run, and real dispatch', () => {
  const store = fixture();
  const result = executive.ownerRequest(store, {
    body: 'Build a new website for example.com and onboard it to the fleet.',
  });
  assert.equal(result.dispatch_error, undefined);
  assert.equal(result.execution.task.owner, 'site-factory-manager');
  assert.equal(result.execution.dispatch.status, 'queued');
  assert.equal(result.execution.run.work_id, result.execution.task.work_id);
  assert.equal(store.getExecutiveWorkItem(result.work_item.work_id).lifecycle_state, 'actioned');
  assert.equal(
    store.listAgentDispatches({ agent_id: result.execution.run.agent_id, status: 'queued' }).length,
    1
  );
  store.close();
});

test('operating layer routes non-site work to the correct manager', () => {
  const store = fixture();
  const result = executive.ownerRequest(store, {
    body: 'Improve SEO and fix the search visibility problems on the portfolio.',
  });
  assert.equal(result.execution.task.owner, 'growth-manager');
  assert.equal(result.execution.task.status, 'in_progress');
  assert.match(result.work_item.next_action, /operating manager run is queued/i);
  store.close();
});

test('reconcile repairs acknowledged requests missing execution dispatch', () => {
  const store = fixture();
  const request = store.createExecutiveWorkItem({
    title: 'Owner request: repair this case',
    source_type: 'owner-request',
    source_id: 'owner-message-1',
    summary: 'Develop the requested platform fix.',
    status: 'in_progress',
    lifecycle_state: 'acknowledged',
    owner: 'ceo',
  });
  const repaired = operating.reconcileOwnerRequests(store);
  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].dispatch.status, 'queued');
  assert.equal(store.getExecutiveWorkItem(request.work_id).lifecycle_state, 'actioned');
  assert.equal(
    store.listExecutiveWorkItems({ parent_work_id: request.work_id, quiet: '0' }).length,
    1
  );
  store.close();
});

test('reconcile preserves site-factory milestone and owner blocker on the parent request', () => {
  const store = fixture();
  const owner = executive.ownerRequest(store, { body: 'Build a new website for milestone.test.' });
  const task = store.updateExecutiveWorkItem(owner.execution.task.work_id, {
    status: 'blocked',
    waiting_on: 'owner-concept-decision',
    next_action: 'Owner must approve the concept before a publicly reachable preview.',
  });
  operating.reconcileOwnerRequests(store);
  const parent = store.getExecutiveWorkItem(owner.work_item.work_id);
  assert.equal(parent.status, 'blocked');
  assert.equal(parent.waiting_on, task.waiting_on);
  assert.equal(parent.next_action, task.next_action);
  assert.equal(operating.reconcileOwnerRequests(store).length, 0);
  store.close();
});

test('site build continuation preserves the full owner brief and is idempotent', () => {
  const store = fixture();
  const root = store.root;
  fs.mkdirSync(path.join(root, 'sites', 'fryexample.test'), { recursive: true });
  const brief =
    'Build fryexample.test with a colorful cooking guide.\nRequired: frying safety, recipes, and ingredient guides.';
  const owner = executive.ownerRequest(store, { body: brief });
  const first = operating.ensureSiteBuildRequest(store, owner.execution.task, {
    root,
    site: 'fryexample.test',
  });
  assert.equal(first.request.delivery_mode, 'pull_request');
  assert.equal(first.request.action_key, `site-build:${owner.work_item.work_id}`);
  assert.match(first.request.body, /Required: frying safety, recipes, and ingredient guides/);
  assert.equal(store.getExecutiveWorkItem(owner.execution.task.work_id).status, 'in_progress');
  assert.equal(store.getExecutiveWorkItem(owner.work_item.work_id).status, 'in_progress');
  const again = operating.ensureSiteBuildRequest(store, owner.execution.task, {
    root,
    site: 'fryexample.test',
  });
  assert.equal(again.reused, true);
  assert.equal(again.request.request_id, first.request.request_id);
  store.close();
});

test('sensitive site concept does not auto-dispatch a publicly reachable build preview', () => {
  const store = fixture();
  const root = store.root;
  fs.mkdirSync(path.join(root, 'sites', 'magicescorts.com'), { recursive: true });
  const owner = executive.ownerRequest(store, {
    body: 'Build magicescorts.com for a private review.',
  });
  const continuation = operating.ensureSiteBuildRequest(store, owner.execution.task, {
    root,
    site: 'magicescorts.com',
  });
  assert.equal(continuation.blocked, true);
  assert.equal(continuation.request, null);
  assert.equal(store.listChangeRequests({ site: 'magicescorts.com' }).length, 0);
  store.close();
});

test('narrow recovery reopens onboarding-only completion with an audit event', () => {
  const store = fixture();
  const parent = store.createExecutiveWorkItem({
    title: 'Owner request: build fryexample.test',
    source_type: 'owner-request',
    owner: 'ceo',
    summary: 'Build a new website for fryexample.test.',
    status: 'done',
    lifecycle_state: 'closed',
    outcome: 'Host onboarding passed',
  });
  store.createExecutiveWorkItem({
    title: 'Execute owner request',
    source_type: 'operating-task',
    parent_work_id: parent.work_id,
    owner: 'site-factory-manager',
    labels: ['site-factory'],
    status: 'done',
    outcome: 'Host onboarding passed',
  });
  const recovered = operating.reopenOnboardingOnlySiteBuild(store, parent.work_id, {
    site: 'fryexample.test',
  });
  assert.equal(recovered.task.status, 'in_progress');
  assert.equal(recovered.parent.lifecycle_state, 'actioned');
  assert.equal(recovered.parent.status, 'in_progress');
  assert.equal(recovered.parent.summary, 'Build a new website for fryexample.test.');
  assert.equal(
    store.list({ correlation_id: `executive-work-item:${parent.work_id}` })[0].event_type,
    'executive.owner-request.site-build-reopened'
  );
  assert.throws(
    () =>
      operating.reopenOnboardingOnlySiteBuild(store, parent.work_id, { site: 'fryexample.test' }),
    /onboarding-only closed request/
  );
  store.close();
});

test('older duplicate site brief is reopened as merged without a second build dispatch', () => {
  const store = fixture();
  const root = store.root;
  fs.mkdirSync(path.join(root, 'sites', 'fryexample.test'), { recursive: true });
  const older = store.createExecutiveWorkItem({
    title: 'Owner request: older fryexample',
    source_type: 'owner-request',
    owner: 'ceo',
    summary: 'Build a new website for fryexample.test.',
    status: 'done',
    lifecycle_state: 'closed',
    outcome: 'Onboarded',
  });
  store.createExecutiveWorkItem({
    title: 'Older operating task',
    source_type: 'operating-task',
    parent_work_id: older.work_id,
    owner: 'site-factory-manager',
    labels: ['site-factory'],
    status: 'done',
    outcome: 'Onboarded',
  });
  const newer = executive.ownerRequest(store, {
    body: 'Build a new website for fryexample.test with media and full recipe guides.',
  });
  const merged = operating.reopenOnboardingOnlySiteBuild(store, older.work_id, {
    site: 'fryexample.test',
    supersededBy: newer.work_item.work_id,
  });
  assert.equal(merged.task.status, 'waiting');
  assert.equal(merged.parent.status, 'in_progress');
  assert.match(merged.parent.next_action, new RegExp(newer.work_item.request_ref));
  assert.throws(
    () => operating.ensureSiteBuildRequest(store, merged.task, { root, site: 'fryexample.test' }),
    /merged into a newer owner request/
  );
  assert.equal(store.listChangeRequests({ site: 'fryexample.test' }).length, 0);
  store.close();
});

test('recovery can defer canonical build dispatch while an existing builder is working', () => {
  const store = fixture();
  const root = store.root;
  fs.mkdirSync(path.join(root, 'sites', 'fryexample.test'), { recursive: true });
  const parent = store.createExecutiveWorkItem({
    title: 'Owner request: fryexample',
    source_type: 'owner-request',
    owner: 'ceo',
    summary: 'Build a new website for fryexample.test.',
    status: 'done',
    lifecycle_state: 'closed',
    outcome: 'Onboarded',
  });
  store.createExecutiveWorkItem({
    title: 'Operating task',
    source_type: 'operating-task',
    parent_work_id: parent.work_id,
    owner: 'site-factory-manager',
    labels: ['site-factory'],
    status: 'done',
    outcome: 'Onboarded',
  });
  const reopened = operating.reopenOnboardingOnlySiteBuild(store, parent.work_id, {
    site: 'fryexample.test',
    deferBuildDispatch: true,
  });
  assert.equal(reopened.task.status, 'waiting');
  assert.equal(reopened.task.waiting_on, 'existing-site-builder');
  assert.throws(
    () => operating.ensureSiteBuildRequest(store, reopened.task, { root, site: 'fryexample.test' }),
    /deferred to an existing builder/
  );
  store.close();
});
