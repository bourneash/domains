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

test('queues independent site work while keeping same-site work serialized', () => {
  const { root, store } = fixture();
  const first = lane.reconcile(store, root);
  assert.equal(first.state, 'queued');
  assert.equal(first.site, 'howtofry.com');
  const request = store.getChangeRequest(first.request_id);
  assert.equal(request.delivery_mode, 'pull_request');
  assert.equal(request.assigned_role, 'engineer');
  const second = lane.reconcile(store, root);
  assert.equal(second.state, 'queued');
  assert.equal(second.site, 'magicescorts.com');
  assert.equal(store.listChangeRequests({ limit: 'all' }).length, 2);
  assert.equal(lane.reconcile(store, root).state, 'working');
  assert.equal(store.listChangeRequests({ limit: 'all' }).length, 2);
  store.close();
});

test('a missing review pull request does not block independent MagicEscorts work', () => {
  const { root, store } = fixture();
  const first = lane.reconcile(store, root);
  store.updateChangeRequest(first.request_id, { status: 'committed' });
  const second = lane.reconcile(store, root);
  assert.equal(second.state, 'queued');
  assert.equal(second.site, 'magicescorts.com');
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
  assert.equal(store.getChangeRequest(second.request_id).delivery_mode, 'pull_request');
  store.close();
});

test('a failed review on one site does not freeze the next approved site task', () => {
  const { root, store } = fixture();
  for (const [index, status] of [
    [0, 'deployed'],
    [1, 'deployed'],
    [2, 'committed'],
  ]) {
    const work = lane.WORK[index];
    const request = store.createChangeRequest({
      site: work.site,
      title: work.title,
      action_key: work.action_key,
      delivery_mode: 'pull_request',
      status,
    });
    if (index === 2) {
      const run = store.createImprovement({
        site: work.site,
        source: 'test',
        source_id: request.request_id,
        title: work.title,
        state: 'review',
        approval: {
          review_gate: 'failed',
          review_checks: { worker_build_url: 'https://example.com/build' },
          pull_request: { number: 2, url: 'https://github.com/bourneash/howtofry.com/pull/2' },
        },
      });
      store.updateChangeRequest(request.request_id, { run_id: run.run_id });
    }
  }
  const next = lane.reconcile(store, root);
  assert.equal(next.state, 'queued');
  assert.equal(next.site, 'magicescorts.com');
  assert.equal(next.blocked_sites[0].site, 'howtofry.com');
  assert.equal(next.blocked_sites[0].status, 'review-check-failed');
  assert.equal(
    store
      .listChangeRequests({ site: 'howtofry.com', limit: 'all' })
      .some(row => row.action_key === lane.WORK[4].action_key),
    false
  );
  store.close();
});

test('flags a four-hour no-artifact delay without blocking an independent site', () => {
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
  assert.equal(state.state, 'queued');
  assert.equal(state.site, 'magicescorts.com');
  assert.equal(state.blocked_sites[0].status, 'running');
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
