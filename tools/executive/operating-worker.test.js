'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('../fleet-dashboard/server/eventstore');
const executive = require('../fleet-dashboard/server/executive');
const worker = require('./operating-worker');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-operating-worker-'));
  fs.mkdirSync(path.join(root, 'sites'), { recursive: true });
  return { root, store: eventstore.open(root, { file: path.join(root, 'events.sqlite') }) };
}

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
