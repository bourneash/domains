'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('../fleet-dashboard/server/eventstore');
const lane = require('./delivery-lane');

function fixture({ roles = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-delivery-lane-'));
  if (roles)
    for (const work of lane.WORK) {
      const dir = path.join(root, 'sites', work.site, 'ops', 'roles');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'engineer.md'), '# Engineer\n');
    }
  const store = eventstore.open(root, { file: path.join(root, 'test.sqlite') });
  store.updateChangeQueueSettings({ enabled: true });
  return { root, store };
}

test('queues only HowToFry first and never duplicates the request', () => {
  const { root, store } = fixture();
  const first = lane.reconcile(store, root);
  assert.equal(first.state, 'queued');
  assert.equal(first.site, 'howtofry.com');
  const request = store.getChangeRequest(first.request_id);
  assert.equal(request.delivery_mode, 'pull_request');
  assert.equal(request.assigned_role, 'engineer');
  assert.equal(lane.reconcile(store, root).state, 'working');
  assert.equal(store.listChangeRequests({ limit: 'all' }).length, 1);
  store.close();
});

test('advances MagicEscorts only after a real review pull request', () => {
  const { root, store } = fixture();
  const first = lane.reconcile(store, root);
  store.updateChangeRequest(first.request_id, { status: 'committed' });
  assert.equal(lane.reconcile(store, root).state, 'waiting-on-review-pr');
  const run = store.createImprovement({
    site: 'howtofry.com',
    source: 'test',
    source_id: first.request_id,
    title: 'Review',
    approval: {
      pull_request: { number: 1, url: 'https://github.com/bourneash/howtofry.com/pull/1' },
    },
  });
  store.updateChangeRequest(first.request_id, { run_id: run.run_id });
  const second = lane.reconcile(store, root);
  assert.equal(second.state, 'queued');
  assert.equal(second.site, 'magicescorts.com');
  assert.equal(store.getChangeRequest(second.request_id).delivery_mode, 'pull_request');
  store.close();
});

test('flags four-hour no-artifact delay despite a fresh heartbeat', () => {
  const { root, store } = fixture();
  const now = Date.now();
  const request = store.createChangeRequest({
    site: 'howtofry.com',
    title: 'Test owner lane work',
    action_key: lane.WORK[0].action_key,
    delivery_mode: 'pull_request',
    category: 'engineering',
    created_at: new Date(now - 5 * 60 * 60_000).toISOString(),
  });
  store.updateChangeRequest(request.request_id, {
    status: 'running',
    updated_at: new Date(now).toISOString(),
  });
  const state = lane.reconcile(store, root, now);
  assert.equal(state.state, 'stalled');
  assert.ok(state.age_minutes >= 300);
  store.close();
});

test('missing owner and failed work stop the lane and produce one domain-ops alert', async () => {
  const { root, store } = fixture({ roles: false });
  const missing = lane.reconcile(store, root);
  assert.equal(missing.state, 'missing-site-owner');
  assert.equal(store.listChangeRequests({ limit: 'all' }).length, 0);
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    assert.equal(JSON.parse(options.body).channel, 'domain-ops');
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const firstAlert = await lane.alert(store, root, missing, {
    env: { SLACK_BOT_TOKEN: 'test' },
    fetchImpl,
  });
  assert.equal(firstAlert.sent, true);
  await lane.alert(store, root, missing, { env: { SLACK_BOT_TOKEN: 'test' }, fetchImpl });
  assert.equal(calls, 1);
  store.close();
});
