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
