'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('./eventstore');
const runtime = require('../../executive/agent-runtime');
const dispatcher = require('../../executive/agent-dispatcher');

test('durable adapters, secrets, organizations, project work, and plan approvals work together', async () => {
  const previousKey = process.env.FD_SECRET_KEY;
  process.env.FD_SECRET_KEY = 'test-only-platform-key';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'executive-platform-gaps-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  try {
    const organization = store.createOrganization({ slug: 'acme', name: 'Acme' });
    store.upsertOrganizationMember({
      organization_id: organization.organization_id,
      actor_id: 'owner-1',
      role: 'owner',
    });
    assert.equal(
      store.canOrganizationActor(organization.organization_id, 'owner-1', ['owner']),
      true
    );
    const agent = store.createAgent({
      organization_id: organization.organization_id,
      slug: 'acme-ceo',
      name: 'Acme CEO',
      title: 'CEO',
      role: 'ceo',
      adapter: 'test-adapter',
    });
    assert.equal(
      store.listAgents({ organization_id: 'fleet' }).some(row => row.agent_id === agent.agent_id),
      false
    );

    const started = runtime.beginRun(store, {
      agent_id: agent.agent_id,
      idempotency_key: 'acme-run-1',
    });
    const processed = await dispatcher.processOne(store, {
      workerId: 'worker-1',
      adapters: { 'test-adapter': async () => ({ verified: true }) },
    });
    assert.equal(processed.processed, true);
    assert.equal(store.getAgentRun(started.run.run_id).status, 'succeeded');

    store.upsertAgentToolGrant({
      agent_id: agent.agent_id,
      tool_name: 'secret:api-token',
      approval_required: false,
    });
    store.upsertAgentSecret({
      name: 'api-token',
      value: 'super-secret',
      scope: { agent_id: agent.agent_id },
    });
    assert.equal(store.getAgentSecret('api-token').value, undefined);
    assert.equal(
      store.resolveAgentSecret('api-token', { agent_id: agent.agent_id }),
      'super-secret'
    );
    assert.throws(
      () => store.resolveAgentSecret('api-token', { agent_id: 'other-agent' }),
      /not authorized/
    );

    const goal = store.createExecutiveGoal({
      title: 'Ship',
      statement: 'Ship the product',
      owner: 'ceo',
    });
    const project = store.createExecutiveProject({ name: 'Launch', goal_id: goal.goal_id });
    const work = store.createExecutiveWorkItem({
      title: 'Prepare launch',
      kind: 'implementation',
      owner: 'cto',
      project_id: project.project_id,
      labels: ['launch', 'high-value'],
    });
    assert.deepEqual(store.getExecutiveWorkItem(work.work_id).labels, ['launch', 'high-value']);
    store.createWorkComment({
      work_id: work.work_id,
      author: 'owner-1',
      body: 'Please verify the rollback.',
    });
    store.createWorkAttachment({
      work_id: work.work_id,
      label: 'acceptance',
      uri: '/tmp/acceptance.md',
    });
    assert.equal(store.listWorkComments({ work_id: work.work_id }).length, 1);
    assert.equal(store.listWorkAttachments({ work_id: work.work_id }).length, 1);

    const plan = store.createExecutivePlan({ title: 'Launch plan', goal_id: goal.goal_id });
    assert.equal(
      store.addExecutivePlanVersion(plan.plan_id, {
        body: { steps: ['test', 'release'] },
        change_summary: 'initial plan',
        created_by: 'ceo',
      }).version,
      1
    );
    assert.equal(
      store.decideExecutivePlan(plan.plan_id, {
        decision: 'approved',
        version: 1,
        decided_by: 'owner-1',
      }).status,
      'approved'
    );
  } finally {
    store.close();
    if (previousKey === undefined) delete process.env.FD_SECRET_KEY;
    else process.env.FD_SECRET_KEY = previousKey;
  }
});
