'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { readyCases, trackHandoffs } = require('./overwatch-delivery-recovery');
function fixture() {
  const task = {
    work_id: 'delivery-recovery:original',
    source_id: 'original',
    status: 'ready',
    site: 'example.com',
    created_at: '2026-10-03',
    summary: 'Required CI failed',
    owner: 'engineering-manager',
    evidence: [],
  };
  const requests = {
    original: {
      request_id: 'original',
      status: 'failed',
      run_id: 'old',
      site: task.site,
      delivery_mode: 'direct',
    },
  };
  let agent = { agent_id: 'watch', workspace: {} };
  const events = [],
    links = [];
  const store = {
    listExecutiveWorkItems: () => [task],
    getExecutiveWorkItem: () => task,
    getChangeRequest: id => requests[id],
    getImprovement: () => ({ approval: { production_checks: { gate: 'failed' } } }),
    listWorkflowLinks: () => links,
    getAgent: () => agent,
    updateAgent: (id, p) => (agent = { ...agent, ...p }),
    updateExecutiveWorkItem: (id, p) => Object.assign(task, p),
    record: e => events.push(e),
  };
  const add = (id, site = task.site) => {
    requests[id] = { request_id: id, status: 'queued', site, delivery_mode: 'direct' };
    links.push({
      relation: 'related_to',
      from_type: 'work-item',
      from_id: task.work_id,
      to_type: 'request',
      to_id: id,
    });
  };
  return {
    store,
    task,
    requests,
    get agent() {
      return agent;
    },
    events,
    add,
  };
}
test('ready recovery requires original exact production failure and no active successor', () => {
  const f = fixture();
  assert.equal(readyCases(f.store, { site: 'example.com', agent: f.agent }).length, 1);
  assert.equal(readyCases(f.store, { site: 'other.com' }).length, 0);
  f.requests.original.status = 'deployed';
  assert.equal(readyCases(f.store).length, 0);
  f.requests.original.status = 'failed';
  f.add('successor');
  assert.equal(readyCases(f.store).length, 0);
});
test('controlled recovery owns and picks up only a new linked request in the same site', async () => {
  const f = fixture(),
    cases = readyCases(f.store);
  f.add('old');
  f.add('wrong', 'other.com');
  f.add('new');
  let picked = [];
  const results = await trackHandoffs(
    f.store,
    f.agent,
    { requests: new Set(['old']) },
    {
      root: '/tmp',
      cases,
      controlled: true,
      initiatingRunId: 'watch-run',
      pickupImpl: async (r, q) => {
        picked.push(q.request_id);
        return { run_id: 'worker-run' };
      },
    }
  );
  assert.deepEqual(picked, ['new']);
  assert.equal(results[0].action, 'started_recovery_worker');
  assert.equal(f.task.status, 'waiting');
  assert.equal(f.agent.workspace.overwatch_recovery[f.task.work_id].initiating_run_id, 'watch-run');
  assert.deepEqual(f.agent.workspace.overwatch_recovery[f.task.work_id].request_ids, ['new']);
  assert.equal(
    (
      await trackHandoffs(
        f.store,
        f.agent,
        { requests: new Set(['old']) },
        {
          cases,
          controlled: true,
          pickupImpl: async () => {
            throw Error('duplicate');
          },
        }
      )
    ).length,
    0
  );
});
test('pickup failure is an explicit failed receipt and bounded attempts cannot restart', async () => {
  const f = fixture(),
    cases = readyCases(f.store);
  f.add('new');
  const receipts = await trackHandoffs(
    f.store,
    f.agent,
    { requests: new Set() },
    {
      cases,
      controlled: true,
      pickupImpl: async () => {
        throw Error('pickup refused');
      },
    }
  );
  assert.equal(receipts[0].action, 'recovery_pickup_failed');
  assert.equal(receipts[0].error, 'pickup refused');
  assert.equal(f.events.length, 1);
  f.agent.workspace.overwatch_recovery[f.task.work_id].attempt_count = 2;
  f.task.status = 'ready';
  f.requests.new.status = 'failed';
  assert.equal(readyCases(f.store, { agent: f.agent }).length, 0);
});
test('ordinary scheduled handoff does not bypass the scheduler pickup', async () => {
  const f = fixture(),
    cases = readyCases(f.store);
  f.add('new');
  const receipts = await trackHandoffs(
    f.store,
    f.agent,
    { requests: new Set() },
    {
      cases,
      controlled: false,
      pickupImpl: async () => {
        throw Error('must not call');
      },
    }
  );
  assert.equal(receipts[0].action, 'queued_recovery_handoff');
});

test('actual recovery pickup remains a handoff until its own verified release', () => {
  const { classifyOutcome } = require('./overwatch-worker');
  const result = classifyOutcome({
    sandboxCode: 0,
    modelStatus: 'succeeded',
    before: { cycles: [], real_work: {} },
    after: { real_work: {} },
    repairs: [{ action: 'started_recovery_worker' }],
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.deliveryStatus, 'handoff_pending');
  assert.equal(result.verified, false);
});

test('original queued work requires a substantive model review before normal pickup', async () => {
  const f = fixture();
  f.task.work_id = 'queued-delivery:original';
  f.requests.original.status = 'queued';
  f.task.next_action = 'Review original';
  const before = { ...f.task };
  const actions = [];
  f.store.listExecutiveActions = () => actions;
  const cases = readyCases(f.store);
  assert.equal(cases[0].recovery_type, 'queued-backlog');
  let picked = 0;
  const baseline = {
    requests: new Set(['original']),
    work: new Map([[f.task.work_id, before]]),
    tracking_actions: new Set(['old-review']),
  };
  const options = {
    cases,
    controlled: true,
    initiatingRunId: 'watch-queue',
    pickupImpl: async () => {
      picked++;
      return { run_id: 'original-worker' };
    },
  };
  assert.deepEqual(await trackHandoffs(f.store, f.agent, baseline, options), []);
  actions.push({
    action_id: 'old-review',
    status: 'completed',
    target_id: f.task.work_id,
    summary: 'Prior review',
    result: {
      source: 'executive-plan',
      status: 'in_progress',
      next_action: 'Old pickup',
      evidence: [{ type: 'source' }],
    },
  });
  assert.deepEqual(await trackHandoffs(f.store, f.agent, baseline, options), []);
  actions.push({
    action_id: 'fresh-review',
    status: 'completed',
    target_id: f.task.work_id,
    summary: 'Reviewed exact current source and all three observed labels',
    result: {
      source: 'executive-plan',
      status: 'in_progress',
      next_action: 'Start original worker through normal gates',
      evidence: [{ type: 'measurement', label: 'actual lab' }],
    },
  });
  const results = await trackHandoffs(f.store, f.agent, baseline, options);
  assert.equal(picked, 1);
  assert.equal(results[0].request_id, 'original');
  assert.equal(results[0].action, 'started_recovery_worker');
  assert.equal(f.requests.original.status, 'queued');
  assert.equal(
    f.agent.workspace.overwatch_recovery[f.task.work_id].review_action_id,
    'fresh-review'
  );
});
test('blocked original requests cannot become eligible queued recovery cases', () => {
  const f = fixture();
  f.task.work_id = 'queued-delivery:original';
  for (const status of ['blocked_owner', 'failed', 'running']) {
    f.requests.original.status = status;
    assert.equal(readyCases(f.store).length, 0);
  }
  f.requests.original.status = 'queued';
  f.requests.original.hold_condition = 'Owner measurement hold';
  assert.equal(readyCases(f.store).length, 0);
});
test('queued-case creation requires explicit controlled site and preserves original request', () => {
  const { ensureQueuedCases } = require('./overwatch-delivery-recovery'),
    f = fixture();
  f.requests.original.status = 'queued';
  const created = [];
  f.store.listChangeRequests = () => Object.values(f.requests);
  f.store.getExecutiveWorkItem = () => null;
  f.store.createExecutiveWorkItem = q => created.push(q);
  f.store.createWorkflowLink = () => ({});
  assert.deepEqual(ensureQueuedCases(f.store, { site: 'example.com', controlled: false }), []);
  assert.deepEqual(ensureQueuedCases(f.store, { controlled: true }), []);
  assert.equal(created.length, 0);
  assert.deepEqual(ensureQueuedCases(f.store, { site: 'example.com', controlled: true }), [
    'queued-delivery:original',
  ]);
  assert.equal(created[0].source_id, 'original');
  assert.equal(f.requests.original.status, 'queued');
  assert.match(created[0].summary, /not a failed worker attempt/);
});

test('expected recovery cannot count passive observation as a successful handoff', () => {
  const { classifyOutcome } = require('./overwatch-worker');
  const result = classifyOutcome({
    sandboxCode: 0,
    modelStatus: 'succeeded',
    before: {
      cycles: [{ status: 'completed' }],
      real_work: { new_active_direct_change_requests: 1 },
    },
    after: { real_work: {} },
    expectedRecoveries: true,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.deliveryStatus, 'recovery_handoff_missing');
});

test('only concrete failed port startup admits bounded retry of original waiting case', async () => {
  const f = fixture();
  f.task.work_id = 'queued-delivery:original';
  f.task.status = 'waiting';
  f.requests.original.error =
    'Docker failed to bind host port 127.0.0.1:8828/tcp: address already in use';
  f.agent.workspace.overwatch_recovery = {
    [f.task.work_id]: { attempt_count: 1, fingerprint: 'prior' },
  };
  const cases = readyCases(f.store, { agent: f.agent });
  assert.equal(cases.length, 1);
  assert.equal(cases[0].recovery_type, 'failed-startup');
  f.store.listExecutiveActions = () => [
    {
      action_id: 'new-review',
      status: 'completed',
      target_id: f.task.work_id,
      summary: 'Verified infrastructure correction and retained original scope',
      result: {
        source: 'executive-plan',
        status: 'in_progress',
        next_action: 'Retry original request normally',
        evidence: [{ type: 'test', label: 'port collision regression' }],
      },
    },
  ];
  let picked = [];
  const receipts = await trackHandoffs(
    f.store,
    f.agent,
    {
      requests: new Set(['original']),
      work: new Map([[f.task.work_id, { ...f.task }]]),
      tracking_actions: new Set(),
    },
    {
      cases,
      controlled: true,
      pickupImpl: async (root, q) => {
        picked.push(q.request_id);
        return { run_id: 'retry-run' };
      },
    }
  );
  assert.deepEqual(picked, ['original']);
  assert.equal(receipts[0].action, 'started_recovery_worker');
  assert.equal(f.agent.workspace.overwatch_recovery[f.task.work_id].attempt_count, 2);
  assert.equal(f.requests.original.status, 'failed');
  assert.deepEqual(readyCases(f.store, { agent: f.agent }), []);
});
test('startup retry cannot reopen cancellation or arbitrary failure', () => {
  const f = fixture();
  f.task.work_id = 'queued-delivery:original';
  f.task.status = 'waiting';
  for (const [status, error] of [
    ['cancelled', 'failed to bind host port: address already in use'],
    ['failed', 'review failed'],
    ['failed', 'address already in use'],
  ]) {
    Object.assign(f.requests.original, { status, error });
    assert.deepEqual(readyCases(f.store), []);
  }
});
