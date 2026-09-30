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
