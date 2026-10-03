'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('./eventstore');
const queue = require('./changequeue');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-change-queue-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  return { root, store };
}

test('creates a validated, durable request and picks high priority first', () => {
  const { store } = fixture();
  const known = site => site === 'example.com';
  const low = queue.create(
    store,
    { site: 'example.com', title: 'Low', priority: 'low', provider: 'local', max_turns: 8 },
    known
  );
  const high = queue.create(
    store,
    {
      site: 'example.com',
      title: 'High',
      priority: 'high',
      category: 'error',
      provider: 'claude',
      max_turns: 30,
    },
    known
  );
  assert.equal(queue.pick(store, { max: 1 })[0].request_id, high.request_id);
  assert.equal(store.getChangeRequest(low.request_id).status, 'queued');
  assert.equal(store.getChangeQueueSettings().enabled, false);
  store.close();
});

test('an owner-controlled prerequisite can leave the runnable queue without being cancelled', () => {
  const { store } = fixture();
  const known = site => site === 'example.com';
  const request = queue.create(
    store,
    { site: 'example.com', title: 'Activate affiliate tag' },
    known
  );
  const blocked = queue.update(
    store,
    request.request_id,
    { status: 'blocked_owner', error: 'registered affiliate tag must be supplied by the owner' },
    known
  );
  assert.equal(blocked.status, 'blocked_owner');
  assert.match(blocked.error, /affiliate tag/);
  assert.equal(queue.pick(store).length, 0);
  store.close();
});

test('a durable report reconciles a delivery-pending request to verified', () => {
  const { store } = fixture();
  const request = queue.create(
    store,
    { site: 'example.com', title: 'Route an existing task' },
    site => site === 'example.com'
  );
  store.updateChangeRequest(request.request_id, {
    status: 'delivery_pending',
    lease_owner: 'old-worker',
    error: 'stale pending state',
  });
  const verified = queue.reconcileVerified(
    store,
    request.request_id,
    site => site === 'example.com'
  );
  assert.equal(verified.status, 'verified');
  assert.equal(verified.lease_owner, null);
  assert.equal(verified.error, null);
  store.close();
});

test('direct work cannot enter an automatic queue while its own instructions defer execution', () => {
  const { store } = fixture();
  const known = site => site === 'example.com';
  assert.throws(
    () =>
      queue.create(
        store,
        {
          site: 'example.com',
          title: 'Capacity-gated change',
          body: 'Retain as unclaimed work only. Do not execute until a slot opens.',
        },
        known
      ),
    /dispatches automatically/
  );
  assert.throws(
    () =>
      queue.create(
        store,
        {
          site: 'example.com',
          title: 'Wait for approval',
          body: 'Do not start until the owner approves this work.',
        },
        known
      ),
    /unresolved execution prerequisite/
  );
  assert.throws(
    () =>
      queue.create(
        store,
        {
          site: 'example.com',
          title: 'Duplicate revalidation',
          body: 'Revalidate the existing change only. Gate: wait for its measurement and owner confirmation by tomorrow. Do not execute a duplicate change.',
          delivery_mode: 'direct',
        },
        known
      ),
    /unresolved execution prerequisite/
  );
  assert.equal(store.listChangeRequests({ site: 'example.com' }).length, 0);
  store.close();
});

test('body edits and status-only retries cannot bypass execution prerequisites', () => {
  const { store } = fixture();
  const known = () => true;
  const request = queue.create(store, { site: 'example.com', title: 'Improve navigation' }, known);
  assert.throws(
    () =>
      queue.update(
        store,
        request.request_id,
        { body: 'Do not execute until a slot opens.' },
        known
      ),
    /unresolved execution prerequisite/
  );
  assert.equal(store.getChangeRequest(request.request_id).body, '');
  store.updateChangeRequest(request.request_id, {
    status: 'failed',
    body: 'Retain as unclaimed engineer queue work only.',
  });
  assert.throws(
    () => queue.update(store, request.request_id, { status: 'queued' }, known),
    /dispatches automatically/
  );
  assert.equal(store.getChangeRequest(request.request_id).status, 'failed');
  assert.equal(
    queue.update(store, request.request_id, { status: 'cancelled' }, known).status,
    'cancelled'
  );
  store.close();
});

test('legacy claimed work is blocked before execution, without a retry lease', () => {
  const { store } = fixture();
  const request = store.createChangeRequest({
    site: 'example.com',
    title: 'Capacity-gated change',
    body: 'Do not execute until the authoritative capacity ledger is reconciled.',
    delivery_mode: 'direct',
    status: 'queued',
  });
  const claimed = store.claimQueuedChangeRequest(request.request_id, {
    owner: 'test-worker',
    claimedAt: new Date().toISOString(),
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  assert.ok(claimed);
  const blocked = queue.blockDeferredExecution(store, claimed);
  assert.equal(blocked.status, 'blocked_owner');
  assert.equal(blocked.lease_owner, null);
  assert.equal(blocked.lease_expires_at, null);
  assert.equal(blocked.next_attempt_at, null);
  assert.deepEqual(queue.pick(store), []);
  assert.equal(
    queue.blockDeferredExecution(store, { ...claimed, delivery_mode: 'report_only' }),
    null
  );
  store.close();
});

test('pull request delivery honors the same execution prerequisites as direct work', () => {
  const { store } = fixture();
  assert.throws(
    () =>
      queue.create(
        store,
        {
          site: 'example.com',
          title: 'Wait',
          body: 'Do not execute until owner confirmation.',
          delivery_mode: 'pull_request',
        },
        () => true
      ),
    /unresolved execution prerequisite/
  );
  store.close();
});

test('routes SEO requests to the SEO analyst even when engineer is requested', () => {
  const { store } = fixture();
  const known = () => true;
  const request = queue.create(
    store,
    {
      site: 'example.com',
      title: 'Resolve competing pages',
      category: 'seo',
      assigned_role: 'engineer',
    },
    known
  );
  assert.equal(request.assigned_role, 'seo-analyst');

  const repaired = queue.update(store, request.request_id, { assigned_role: 'engineer' }, known);
  assert.equal(repaired.assigned_role, 'seo-analyst');
  store.close();
});

test('routes content requests to the installed site equivalent before queueing', () => {
  const { store } = fixture();
  const request = queue.create(
    store,
    {
      site: '0daynews.com',
      title: 'Editorial task',
      category: 'content',
      assigned_role: 'content-writer',
    },
    site => site === '0daynews.com',
    () => ['news-writer', 'engineer']
  );
  assert.equal(request.assigned_role, 'news-writer');
  store.close();
});

test('rejects unsafe provider, turn budget, and unknown site values', () => {
  const { store } = fixture();
  assert.throws(
    () => queue.create(store, { site: 'nope.com', title: 'x' }, () => false),
    /unknown site/
  );
  assert.throws(
    () => queue.create(store, { site: 'example.com', title: 'x', provider: 'shell' }, () => true),
    /invalid provider/
  );
  assert.throws(
    () => queue.create(store, { site: 'example.com', title: 'x', max_turns: 201 }, () => true),
    /max_turns/
  );
  store.close();
});

test('edits queued requests and prevents edits after pickup', () => {
  const { store } = fixture();
  const known = () => true;
  const request = queue.create(store, { site: 'example.com', title: 'Original' }, known);
  const edited = queue.update(
    store,
    request.request_id,
    { title: 'Updated', body: 'Acceptance criteria' },
    known
  );
  assert.equal(edited.title, 'Updated');
  assert.equal(edited.body, 'Acceptance criteria');
  queue.update(store, request.request_id, { status: 'claimed' }, known);
  const rebound = queue.update(
    store,
    request.request_id,
    { provider: 'chatgpt', model: 'gpt-5' },
    known
  );
  assert.equal(rebound.provider, 'chatgpt');
  assert.equal(rebound.model, 'gpt-5');
  assert.throws(
    () => queue.update(store, request.request_id, { title: 'Too late' }, known),
    /cannot be edited/
  );
  store.close();
});

test('delivery states require the queue lifecycle to advance in order', () => {
  const { store } = fixture();
  const known = () => true;
  const request = queue.create(store, { site: 'example.com', title: 'Deploy me' }, known);
  for (const status of ['claimed', 'running', 'review', 'committed', 'deployed', 'verified'])
    queue.update(store, request.request_id, { status }, known);
  assert.equal(store.getChangeRequest(request.request_id).status, 'verified');
  store.close();
});

test('a reviewed pull-request branch can commit from delivery_pending', () => {
  const { store } = fixture();
  const known = () => true;
  const request = queue.create(
    store,
    {
      site: 'example.com',
      title: 'Publish review branch',
      delivery_mode: 'pull_request',
    },
    known
  );
  for (const status of ['claimed', 'running', 'reviewing', 'delivery_pending', 'committed'])
    queue.update(store, request.request_id, { status }, known);
  assert.equal(store.getChangeRequest(request.request_id).status, 'committed');
  store.close();
});

test('automatic review defaults on and can be disabled per request', () => {
  const { store } = fixture();
  const known = () => true;
  const automatic = queue.create(store, { site: 'example.com', title: 'Automatic' }, known);
  const manual = queue.create(
    store,
    { site: 'example.com', title: 'Manual', auto_review: false },
    known
  );
  assert.equal(automatic.auto_review, 1);
  assert.equal(manual.auto_review, 0);
  const edited = queue.update(store, automatic.request_id, { auto_review: false }, known);
  assert.equal(edited.auto_review, 0);
  assert.equal(store.getChangeQueueSettings().auto_review_enabled, true);
  store.close();
});

test('executive legal requests are report-only', () => {
  const { store } = fixture();
  const known = () => true;
  const request = queue.create(
    store,
    {
      site: 'example.com',
      title: 'Legal evidence packet',
      category: 'other',
      assigned_role: 'legal',
      delivery_mode: 'report_only',
    },
    known
  );
  assert.equal(request.assigned_role, 'legal');
  assert.throws(
    () =>
      queue.create(
        store,
        {
          site: 'example.com',
          title: 'Unsafe legal deploy',
          category: 'other',
          assigned_role: 'legal',
          delivery_mode: 'direct',
        },
        known
      ),
    /report-only/
  );
  store.close();
});

test('reviewing is a valid handoff state before pending review', () => {
  const { store } = fixture();
  const request = queue.create(store, { site: 'example.com', title: 'Review me' }, () => true);
  for (const status of ['claimed', 'running', 'reviewing', 'review'])
    queue.update(store, request.request_id, { status }, () => true);
  assert.equal(store.getChangeRequest(request.request_id).status, 'review');
  store.close();
});

test('a blocked review can be explicitly returned to the worker queue', () => {
  const { store } = fixture();
  const request = queue.create(store, { site: 'example.com', title: 'Retry me' }, () => true);
  for (const status of ['claimed', 'running', 'review'])
    queue.update(store, request.request_id, { status }, () => true);
  const queued = queue.update(
    store,
    request.request_id,
    { status: 'queued', next_attempt_at: new Date().toISOString(), error: null },
    () => true
  );
  assert.equal(queued.status, 'queued');
  store.close();
});

test('report-only requests finish as verified without a deployment state', () => {
  const { store } = fixture();
  const request = queue.create(
    store,
    {
      site: 'example.com',
      title: 'Prepare finance report',
      delivery_mode: 'report_only',
      requested_by: 'cfo',
      source_proposal_id: 'proposal-12345678901234567890',
    },
    () => true
  );
  for (const status of ['claimed', 'running', 'review', 'verified'])
    queue.update(store, request.request_id, { status }, () => true);
  const saved = store.getChangeRequest(request.request_id);
  assert.equal(saved.status, 'verified');
  assert.equal(saved.delivery_mode, 'report_only');
  assert.equal(saved.requested_by, 'cfo');
  assert.equal(saved.source_proposal_id, 'proposal-12345678901234567890');
  store.close();
});

test('infers report-only delivery from an explicit read-only request', () => {
  const { store } = fixture();
  const request = queue.create(
    store,
    {
      site: 'example.com',
      title: 'Run a revenue-readiness baseline',
      body: 'Read-only inspection. Do not deploy or change production.',
      requested_by: 'ceo',
    },
    () => true
  );
  assert.equal(request.delivery_mode, 'report_only');
  store.close();
});

test('repairs legacy direct requests whose body clearly declares report-only work', () => {
  const { store } = fixture();
  const request = queue.create(
    store,
    {
      site: 'example.com',
      title: 'Legacy report',
      body: 'Inspect only; ordinary direct request.',
      delivery_mode: 'direct',
    },
    () => true
  );
  const repaired = queue.update(
    store,
    request.request_id,
    { body: 'Inspect only; no production changes.' },
    () => true
  );
  assert.equal(repaired.delivery_mode, 'report_only');
  store.close();
});

test('reconciles a failed request to verified when a durable report survives', () => {
  const { store } = fixture();
  const request = queue.create(
    store,
    { site: 'example.com', title: 'Recover report', delivery_mode: 'report_only' },
    () => true
  );
  for (const status of ['claimed', 'running', 'failed'])
    queue.update(
      store,
      request.request_id,
      { status, ...(status === 'failed' ? { error: 'stale lease' } : {}) },
      () => true
    );
  const verified = queue.reconcileVerified(store, request.request_id, () => true);
  assert.equal(verified.status, 'verified');
  assert.equal(verified.error, null);
  store.close();
});

test('report-only requests cannot disable automatic review', () => {
  const { store } = fixture();
  assert.throws(
    () =>
      queue.create(
        store,
        {
          site: 'example.com',
          title: 'Unsafe report',
          delivery_mode: 'report_only',
          auto_review: false,
        },
        () => true
      ),
    /automatic review/
  );
  store.close();
});

test('leases persist across store reads and queue settings expose recovery timing', () => {
  const { store } = fixture();
  const request = queue.create(store, { site: 'example.com', title: 'Leased' }, () => true);
  const updated = store.updateChangeRequest(request.request_id, {
    lease_owner: 'worker-a',
    lease_expires_at: '2099-01-01T00:00:00.000Z',
    heartbeat_at: '2026-09-20T00:00:00.000Z',
  });
  assert.equal(updated.lease_owner, 'worker-a');
  assert.equal(updated.lease_expires_at, '2099-01-01T00:00:00.000Z');
  assert.equal(store.getChangeQueueSettings().lease_minutes, 30);
  store.close();
});

test('queued and expired claims are atomic', () => {
  const { store } = fixture();
  const request = queue.create(
    store,
    {
      site: 'example.com',
      title: 'Race safe',
      created_at: '2026-09-19T00:00:00.000Z',
      next_attempt_at: '2026-09-19T00:00:00.000Z',
    },
    () => true
  );
  const first = store.claimQueuedChangeRequest(request.request_id, {
    owner: 'worker-a',
    claimedAt: '2026-09-20T00:00:00.000Z',
    leaseExpiresAt: '2026-09-20T00:30:00.000Z',
  });
  const second = store.claimQueuedChangeRequest(request.request_id, {
    owner: 'worker-b',
    claimedAt: '2026-09-20T00:00:01.000Z',
    leaseExpiresAt: '2026-09-20T00:30:01.000Z',
  });
  assert.equal(first.lease_owner, 'worker-a');
  assert.equal(second, null);
  const recovered = store.claimExpiredChangeRequest(request.request_id, {
    owner: 'worker-c',
    now: '2026-09-20T01:00:00.000Z',
    leaseExpiresAt: '2026-09-20T01:30:00.000Z',
  });
  assert.equal(recovered.lease_owner, 'worker-c');
  const duplicateRecovery = store.claimExpiredChangeRequest(request.request_id, {
    owner: 'worker-d',
    now: '2026-09-20T01:00:01.000Z',
    leaseExpiresAt: '2026-09-20T01:30:01.000Z',
  });
  assert.equal(duplicateRecovery, null);
  store.close();
});

test('conditional release gates preserve implementation delivery while blanket prohibitions remain report-only', () => {
  assert.equal(
    queue.inferredDeliveryMode({
      body: 'Add two links. Do not deploy automatically if any quality gate fails.',
    }),
    'direct'
  );
  assert.equal(
    queue.inferredDeliveryMode({ body: 'Fix the source; do not deploy unless build passes.' }),
    'direct'
  );
  assert.equal(
    queue.inferredDeliveryMode({
      body: 'Read-only audit. Do not deploy automatically if tests fail.',
    }),
    'report_only'
  );
  assert.equal(
    queue.inferredDeliveryMode({ body: 'Do not deploy. Produce a report.' }),
    'report_only'
  );
  assert.equal(queue.inferredDeliveryMode({ body: 'Do not deploy automatically.' }), 'report_only');
  assert.equal(
    queue.inferredDeliveryMode({ body: 'Do not deploy unless tests pass. Do not push.' }),
    'report_only'
  );
  assert.equal(
    queue.inferredDeliveryMode({
      body: 'Do not deploy if tests fail.',
      delivery_mode: 'pull_request',
    }),
    'pull_request'
  );
});
