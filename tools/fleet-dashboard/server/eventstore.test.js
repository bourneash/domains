'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('./eventstore');

test('records and follows a durable causal chain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-events-'));
  const store = eventstore.open(dir, { file: path.join(dir, 'events.sqlite') });
  store.record({
    event_id: 'signal-1',
    event_type: 'signal.detected',
    source: 'seo-intelligence',
    site_id: 'site:example.com',
    entity_type: 'recommendation',
    entity_id: 'rec-1',
    correlation_id: 'chain-1',
    payload: { score: 88 },
  });
  store.record({
    event_id: 'task-evt-1',
    event_type: 'recommendation.task_filed',
    source: 'seo-intelligence',
    site_id: 'site:example.com',
    entity_type: 'task',
    entity_id: 'task-1',
    correlation_id: 'chain-1',
    causation_id: 'signal-1',
  });
  const rows = store.list({ correlation_id: 'chain-1' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].entity_id, 'task-1');
  assert.equal(rows[1].payload.score, 88);
  store.close();
});

test('filters executive messages and proposals by Product Manager role', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-executive-role-summary-'));
  const store = eventstore.open(dir, { file: path.join(dir, 'events.sqlite') });
  store.createExecutiveMessage({
    actor: 'product-manager-fleet',
    body: 'Fleet strategy update',
    created_at: '2026-10-01T12:00:00.000Z',
  });
  store.createExecutiveMessage({
    actor: 'ceo',
    body: 'Message for fleet product manager',
    metadata: { to: 'product-manager-fleet' },
    created_at: '2026-10-02T12:00:00.000Z',
  });
  store.createExecutiveMessage({ actor: 'ceo', body: 'Unrelated update' });
  store.createExecutiveProposal({
    title: 'Fleet proposal',
    summary: 'A role scoped proposal',
    requested_action: 'Review the proposal',
    created_by: 'product-manager-fleet',
  });
  store.createExecutiveProposal({
    title: 'Sites proposal',
    summary: 'A different role proposal',
    requested_action: 'Review the proposal',
    created_by: 'product-manager-sites',
  });

  const messages = store.listExecutiveMessages({ actor: 'product-manager-fleet', limit: 1 });
  assert.equal(store.countExecutiveMessages({ actor: 'product-manager-fleet' }), 2);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, 'Message for fleet product manager');
  assert.equal(
    store.listExecutiveProposals({ created_by: 'product-manager-fleet' })[0].title,
    'Fleet proposal'
  );
  assert.equal(store.countExecutiveProposals({ created_by: 'product-manager-fleet' }), 1);
  store.close();
});

test('projects recent conversation rows without their unused scorecard metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-executive-message-preview-'));
  const store = eventstore.open(dir, { file: path.join(dir, 'events.sqlite') });
  store.createExecutiveMessage({
    actor: 'system',
    body: 'Recent conversation text',
    work_id: 'request-1',
    metadata: { scorecard: 'large unused scorecard payload '.repeat(1000) },
  });

  const preview = store.listExecutiveMessagePreviews()[0];
  assert.deepEqual(Object.keys(preview).sort(), ['actor', 'body', 'created_at', 'work_id']);
  assert.equal(preview.body, 'Recent conversation text');
  assert.equal(preview.work_id, 'request-1');
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) < 200);
  store.close();
});

test('pages transcript messages in SQLite and returns only a bounded body preview', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-executive-transcript-page-'));
  const store = eventstore.open(dir, { file: path.join(dir, 'events.sqlite') });
  const old = store.createExecutiveMessage({
    actor: 'ceo',
    body: 'older transcript '.repeat(1000),
    message_type: 'model-prompt',
    created_at: '2026-10-01T12:00:00.000Z',
  });
  const background = store.createExecutiveMessage({
    actor: 'system',
    body: 'Run milestone',
    message_type: 'background',
    created_at: '2026-10-01T11:00:00.000Z',
  });
  const latest = store.createExecutiveMessage({
    actor: 'ceo',
    body: 'latest transcript '.repeat(1000),
    message_type: 'model-response',
    created_at: '2026-10-02T12:00:00.000Z',
  });
  store.createExecutiveMessage({
    actor: 'ceo',
    body: 'unrelated large message '.repeat(1000),
    message_type: 'update',
    created_at: '2026-10-03T12:00:00.000Z',
  });

  const firstPage = store.listExecutiveTranscript({ limit: 1, previewChars: 100 });
  assert.equal(store.countExecutiveTranscript(), 3);
  assert.equal(firstPage.length, 1);
  assert.equal(firstPage[0].message_id, latest.message_id);
  assert.equal(firstPage[0].body.length, 100);
  assert.equal(firstPage[0].body_length, latest.body.length);
  const olderPage = store.listExecutiveTranscript({
    beforeCreatedAt: firstPage[0].created_at,
    beforeMessageId: firstPage[0].message_id,
    limit: 1,
  });
  assert.equal(olderPage[0].message_id, old.message_id);
  assert.equal(
    store.listExecutiveTranscript({ messageTypes: ['background'] })[0].message_id,
    background.message_id
  );
  assert.equal(store.getExecutiveTranscriptMessage(latest.message_id).body, latest.body);
  assert.equal(store.getExecutiveTranscriptMessage('unrelated'), null);
  store.close();
});

test('rejects unbounded event vocabulary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-events-'));
  const store = eventstore.open(dir, { file: path.join(dir, 'events.sqlite') });
  assert.throws(
    () => store.record({ event_type: 'bad type', source: 'test' }),
    /invalid event_type/
  );
  store.close();
});

test('preserves a completed executive tick when handoff check-in needs retry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-executive-actions-'));
  const store = eventstore.open(dir, { file: path.join(dir, 'events.sqlite') });
  const action = store.createExecutiveAction({
    actor: 'system',
    action_type: 'other',
    summary: 'Scheduled executive team run',
    target_type: 'scheduled-executive-run',
  });
  const finished = store.finishExecutiveAction(action.action_id, {
    status: 'completed_with_warning',
    error: 'executive handoff check-in exited with code 75',
    result: { checkin_status: 75, checkin_warning: 'retry is required' },
  });
  assert.equal(finished.status, 'completed_with_warning');
  assert.equal(finished.result.checkin_status, 75);
  store.close();
});

test('persists and updates improvement runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-improvements-'));
  const store = eventstore.open(dir, { file: path.join(dir, 'events.sqlite') });
  const created = store.createImprovement({
    site: 'example.com',
    source: 'test-source',
    source_id: 'signal-1',
    title: 'Improve landing page',
    baseline: { sessions: 10 },
  });
  assert.equal(created.state, 'proposed');
  assert.equal(store.listImprovements({ site: 'example.com' })[0].baseline.sessions, 10);
  const updated = store.updateImprovement(created.run_id, {
    state: 'building',
    branch: 'improve/landing',
  });
  assert.equal(updated.branch, 'improve/landing');
  assert.equal(store.getImprovement(created.run_id).state, 'building');
  store.close();
});

test('delivery claims are atomic and stale claims can be recovered', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-delivery-claims-'));
  const store = eventstore.open(dir, { file: path.join(dir, 'events.sqlite') });
  const created = store.createImprovement({
    site: 'example.com',
    source: 'test-source',
    title: 'Claim delivery',
  });
  const first = store.claimImprovementDelivery(created.run_id, {
    claimedAt: '2026-09-23T12:00:00.000Z',
    claimedBy: 'worker-a',
  });
  assert.equal(first.outcome.delivery_claimed, true);
  assert.equal(first.outcome.delivery_claimed_by, 'worker-a');
  assert.equal(
    store.claimImprovementDelivery(created.run_id, {
      claimedAt: '2026-09-23T12:05:00.000Z',
      claimedBy: 'worker-b',
    }),
    null
  );
  const recovered = store.claimImprovementDelivery(created.run_id, {
    maxAgeMs: 60_000,
    claimedAt: '2026-09-23T12:16:00.000Z',
    claimedBy: 'worker-b',
  });
  assert.equal(recovered.outcome.delivery_claimed_by, 'worker-b');
  store.close();
});

test('filters the change queue by implementation role', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-change-role-'));
  const store = eventstore.open(dir, { file: path.join(dir, 'events.sqlite') });
  store.createChangeRequest({
    site: 'example.com',
    title: 'Normal task',
    assigned_role: 'engineer',
  });
  store.createChangeRequest({
    site: 'example.com',
    title: 'Urgent task',
    assigned_role: 'principal-engineer',
  });
  assert.equal(store.listChangeRequests({ assigned_role: 'principal-engineer' }).length, 1);
  assert.equal(
    store.listChangeRequests({ assigned_role: 'principal-engineer' })[0].title,
    'Urgent task'
  );
  store.close();
});

test('requires completion evidence and rejects stale work-item writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-work-item-gates-'));
  const store = eventstore.open(dir, { file: path.join(dir, 'events.sqlite') });
  const created = store.createExecutiveWorkItem({ title: 'Evidence-gated work' });
  assert.throws(
    () => store.updateExecutiveWorkItem(created.work_id, { status: 'done' }),
    /completion requires/
  );
  const updated = store.updateExecutiveWorkItem(created.work_id, { status: 'in_progress' });
  assert.throws(
    () =>
      store.updateExecutiveWorkItem(created.work_id, {
        status: 'done',
        expected_updated_at: created.updated_at,
      }),
    /changed/
  );
  const done = store.updateExecutiveWorkItem(updated.work_id, {
    status: 'done',
    outcome: 'Verified in production.',
    expected_updated_at: updated.updated_at,
  });
  assert.equal(done.status, 'done');
  store.close();
});

test('agent registry, resumable runs, artifacts, and hard-stop budgets are durable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  const ceo = store.createAgent({
    slug: 'fleet-ceo',
    name: 'Fleet CEO',
    title: 'Chief Executive Officer',
    role: 'ceo',
    provider: 'chatgpt',
    model: 'gpt-5',
    adapter: 'codex',
    permissions: ['read:intelligence'],
  });
  assert.equal(store.getAgent('fleet-ceo').agent_id, ceo.agent_id);
  assert.throws(
    () =>
      store.createAgent({
        slug: 'fleet-ceo',
        name: 'Duplicate',
        title: 'CEO',
        role: 'ceo',
        adapter: 'codex',
      }),
    /agent slug already exists/
  );

  store.upsertBudgetPolicy({
    scope_type: 'agent',
    scope_id: ceo.agent_id,
    period: 'run',
    limit_usd: 1,
  });
  assert.equal(
    store.reserveBudget({
      scope_type: 'agent',
      scope_id: ceo.agent_id,
      period: 'run',
      amount_usd: 0.75,
    }).allowed,
    true
  );
  assert.equal(
    store.reserveBudget({
      scope_type: 'agent',
      scope_id: ceo.agent_id,
      period: 'run',
      amount_usd: 0.3,
    }).allowed,
    false
  );
  assert.equal(
    store.getBudgetPolicy({ scope_type: 'agent', scope_id: ceo.agent_id, period: 'run' }).spent_usd,
    0.75
  );
  store.upsertBudgetPolicy({
    scope_type: 'fleet',
    scope_id: 'domains',
    period: 'run',
    limit_usd: 1,
  });
  assert.throws(
    () =>
      store.reserveBudgetBatch([
        { scope_type: 'agent', scope_id: ceo.agent_id, period: 'run', amount_usd: 0.1 },
        { scope_type: 'fleet', scope_id: 'domains', period: 'run', amount_usd: 1.1 },
      ]),
    /budget exceeded/
  );
  assert.equal(
    store.getBudgetPolicy({ scope_type: 'agent', scope_id: ceo.agent_id, period: 'run' }).spent_usd,
    0.75
  );

  const run = store.createAgentRun({
    agent_id: ceo.agent_id,
    work_id: 'work-1',
    idempotency_key: 'tick-1',
  });
  assert.equal(
    store.createAgentRun({ agent_id: ceo.agent_id, idempotency_key: 'tick-1' }).run_id,
    run.run_id
  );
  const resumed = store.updateAgentRun(run.run_id, {
    status: 'running',
    session_id: run.session_id,
  });
  assert.equal(resumed.status, 'running');
  const artifact = store.createAgentArtifact({
    run_id: run.run_id,
    agent_id: ceo.agent_id,
    kind: 'report',
    label: 'tick report',
    uri: '/reports/tick.json',
  });
  assert.equal(
    store.listAgentArtifacts({ run_id: run.run_id })[0].artifact_id,
    artifact.artifact_id
  );
  store.close();
});

test('routines and watchdogs provide durable scheduling and stalled-run detection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-watchdog-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  const agent = store.createAgent({
    slug: 'watchdog-agent',
    name: 'Watchdog',
    title: 'Worker',
    role: 'engineer',
    adapter: 'codex',
  });
  const routine = store.createAgentRoutine({
    agent_id: agent.agent_id,
    name: 'hourly-check',
    schedule: '3600',
  });
  assert.equal(
    store.listAgentRoutines({ agent_id: agent.agent_id })[0].routine_id,
    routine.routine_id
  );
  const run = store.createAgentRun({
    agent_id: agent.agent_id,
    started_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    status: 'running',
  });
  store.createAgentWatchdog({ run_id: run.run_id, timeout_seconds: 30 });
  const audit = store.auditAgentWatchdogs({ now: new Date('2026-01-01T00:01:00.000Z') });
  assert.equal(audit.fired.length, 1);
  assert.equal(store.listAgentWatchdogs({ status: 'fired' }).length, 1);
  store.close();
});

test('evaluations, tool grants, and workspaces are scoped and auditable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-governance-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  const agent = store.createAgent({
    slug: 'governed-agent',
    name: 'Governed',
    title: 'Worker',
    role: 'engineer',
    adapter: 'codex',
  });
  const evaluation = store.createAgentEval({
    agent_id: agent.agent_id,
    dimension: 'quality',
    score: 92,
    feedback: 'verified output',
  });
  assert.equal(store.agentEvalSummary(agent.agent_id).by_dimension.quality.average, 92);
  assert.equal(evaluation.agent_id, agent.agent_id);
  store.upsertAgentToolGrant({
    agent_id: agent.agent_id,
    tool_name: 'read:gsc',
    scope: { sites: ['example.com'] },
  });
  assert.equal(
    store.canAgentUseTool(agent.agent_id, 'read:gsc', { site: 'example.com' }).allowed,
    false
  );
  assert.equal(
    store.canAgentUseTool(agent.agent_id, 'read:gsc', { site: 'example.com', approved: true })
      .allowed,
    true
  );
  assert.equal(
    store.canAgentUseTool(agent.agent_id, 'read:gsc', { site: 'other.example', approved: true })
      .allowed,
    false
  );
  assert.equal(store.canAgentUseTool(agent.agent_id, 'write:deploy').allowed, false);
  const workspace = store.createAgentWorkspace({
    agent_id: agent.agent_id,
    path: '/tmp/agent-workspace',
  });
  assert.equal(store.closeAgentWorkspace(workspace.workspace_id).status, 'closed');
  assert.throws(
    () => store.createAgentWorkspace({ agent_id: agent.agent_id, path: '../escape' }),
    /invalid workspace path/
  );
  store.close();
});
