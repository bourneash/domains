'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('./eventstore');
const runtime = require('../../executive/agent-runtime');
const dispatcher = require('../../executive/agent-dispatcher');
const portability = require('../../executive/organization-portability');

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

    const skill = store.createAgentSkill({ slug: 'launch-review', name: 'Launch review' });
    store.publishAgentSkillVersion(skill.skill_id, {
      instructions: 'Review launch evidence.',
      created_by: 'owner-1',
    });
    store.assignAgentSkill({ agent_id: agent.agent_id, skill_id: skill.skill_id, version: 1 });
    assert.equal(store.resolveAgentSkills(agent.agent_id)[0].version.version, 1);
    store.upsertAgentMemory({
      agent_id: agent.agent_id,
      memory_key: 'rollback',
      content: 'Always verify rollback evidence.',
      confidence: 0.9,
    });
    assert.equal(
      store.listAgentMemories({ agent_id: agent.agent_id })[0].content,
      'Always verify rollback evidence.'
    );
    store.upsertRuntimePlugin({
      slug: 'audit-plugin',
      manifest: { name: 'Audit plugin', capabilities: ['read'] },
      status: 'active',
    });
    const pluginJob = store.enqueueRuntimePluginJob({
      plugin_id: 'audit-plugin',
      idempotency_key: 'audit-job-1',
      payload: { run_id: started.run.run_id },
    });
    assert.equal(store.claimRuntimePluginJob('plugin-worker').job_id, pluginJob.job_id);
    assert.equal(
      store.completeRuntimePluginJob(pluginJob.job_id, { result: { ok: true } }).status,
      'succeeded'
    );
    const connector = store.upsertRuntimeConnector({
      slug: 'linear',
      kind: 'ticket-system',
      capabilities: ['issues.read'],
      status: 'active',
    });
    const connectorCall = store.enqueueRuntimeConnectorCall({
      connector_id: connector.connector_id,
      operation: 'issues.read',
      idempotency_key: 'linear-call-1',
      payload: { project: 'fleet' },
    });
    assert.equal(
      store.claimRuntimeConnectorCall('connector-worker').call_id,
      connectorCall.call_id
    );
    assert.equal(
      store.completeRuntimeConnectorCall(connectorCall.call_id, { result: { issues: [] } }).status,
      'succeeded'
    );
    store.appendAgentRunLog({
      run_id: started.run.run_id,
      level: 'info',
      message: 'adapter completed',
    });
    assert.equal(store.listAgentRunLogs({ run_id: started.run.run_id }).length, 1);

    const bundle = portability.exportOrganization(store, organization.organization_id);
    assert.equal(bundle.secrets.omitted, true);
    assert.equal(JSON.stringify(bundle).includes('super-secret'), false);
    const imported = portability.importOrganization(store, bundle);
    assert.notEqual(imported.organization.organization_id, organization.organization_id);

    const worker = store.createAgent({
      organization_id: organization.organization_id,
      slug: 'acme-worker',
      name: 'Acme Worker',
      title: 'Worker',
      role: 'engineer',
      adapter: 'test-adapter',
    });
    store.upsertAgentDelegation({
      from_agent_id: agent.agent_id,
      to_agent_id: worker.agent_id,
      work_kind: 'implementation',
    });
    assert.equal(store.listAgentDelegations({ from_agent_id: agent.agent_id }).length, 1);
    store.createAgentRoutine({
      agent_id: worker.agent_id,
      name: 'on-work',
      trigger_type: 'event',
      schedule: 'work.created',
    });
    const eventDispatch = require('../../executive/agent-heartbeat').triggerEvent(store, {
      event_type: 'work.created',
      event_id: 'event-1',
      payload: { work_id: work.work_id },
    });
    assert.equal(eventDispatch.dispatched.length, 1);
    assert.equal(
      require('../../executive/agent-heartbeat').triggerEvent(store, {
        event_type: 'work.created',
        event_id: 'event-1',
      }).dispatched[0].reused,
      true
    );
    const provider = store.upsertRuntimeProvider({
      slug: 'local-sandbox',
      kind: 'local',
      capabilities: ['workspace'],
      status: 'active',
    });
    const workspace = store.createAgentWorkspace({
      agent_id: worker.agent_id,
      provider_id: provider.provider_id,
      path: '/tmp/platform-provider-workspace',
    });
    assert.equal(workspace.provider_id, provider.provider_id);

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
