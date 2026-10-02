'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const eventstore = require('./eventstore');
const { briefHash } = require('./site-build-contract');

function writeSiteBrief(root, site, brief) {
  const repo = path.join(root, 'sites', site);
  fs.mkdirSync(path.join(repo, 'ops'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'CLAUDE.md'),
    `# ${site}\n\nOwner brief SHA256: ${briefHash(brief)}\n`
  );
  fs.writeFileSync(path.join(repo, 'ops', 'AGENT_BUILD_PROMPT.md'), `# Owner brief\n\n${brief}\n`);
}

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
  assert.equal(store.listChangeRequests({ limit: 1 }).length, 1);
  for (let index = 0; index < 249; index += 1)
    store.createChangeRequest({ site: 'example.com', title: `Extra task ${index}` });
  assert.equal(store.listChangeRequests().length, 250);
  assert.equal(store.listChangeRequests({ limit: 'all' }).length, 251);
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

test('site-factory completion rejects onboarding-only evidence and requires a real build', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-site-build-gate-'));
  const site = 'built.example';
  const pages = path.join(root, 'sites', site, 'site', 'src', 'pages');
  fs.mkdirSync(pages, { recursive: true });
  const brief = 'Build a preview-only website with a homepage for built.example.';
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  const parent = store.createExecutiveWorkItem({
    title: 'Owner site build',
    source_type: 'owner-request',
    owner: 'ceo',
    summary: brief,
    status: 'in_progress',
  });
  const task = store.createExecutiveWorkItem({
    title: 'Build the site',
    source_type: 'operating-task',
    parent_work_id: parent.work_id,
    owner: 'site-factory-manager',
    site,
    status: 'in_progress',
    evidence: [{ type: 'artifact', label: 'Onboarding job passed' }],
  });
  assert.throws(
    () => store.updateExecutiveWorkItem(task.work_id, { status: 'done', outcome: 'Onboarded' }),
    /site build completion requires site-build\/v1 evidence/
  );
  assert.throws(
    () => store.updateExecutiveWorkItem(parent.work_id, { status: 'done', outcome: 'Onboarded' }),
    /site-factory task to pass acceptance/
  );
  const proof = {
    type: 'artifact',
    label: 'Site build acceptance',
    contract: 'site-build/v1',
    site,
    brief_sha256: briefHash(brief),
    pages: ['index.astro'],
    build: { command: 'npm run build', exit_code: 0, commit: 'a'.repeat(40) },
    preview: {
      url: 'http://127.0.0.1:4321/',
      status: 'verified-private',
      checked_at: new Date().toISOString(),
    },
  };
  assert.throws(
    () => store.updateExecutiveWorkItem(task.work_id, { status: 'done', evidence: [proof] }),
    /site instructions and AGENT_BUILD_PROMPT/
  );
  writeSiteBrief(root, site, brief);
  assert.throws(
    () => store.updateExecutiveWorkItem(task.work_id, { status: 'done', evidence: [proof] }),
    /existing page index.astro/
  );
  fs.writeFileSync(path.join(pages, 'index.astro'), '<h1>COMING SOON</h1>'.repeat(30));
  assert.throws(
    () => store.updateExecutiveWorkItem(task.work_id, { status: 'done', evidence: [proof] }),
    /non-placeholder content/
  );
  fs.writeFileSync(
    path.join(pages, 'index.astro'),
    '<main><h1>Frying guide</h1><p>Practical frying safety and recipes.</p></main>'.repeat(5)
  );
  assert.throws(
    () => store.updateExecutiveWorkItem(task.work_id, { status: 'done', evidence: [proof] }),
    /downstream build request/
  );
  const request = store.createChangeRequest({
    site,
    title: 'Build site',
    body: brief,
    action_key: `site-build:${parent.work_id}`,
    delivery_mode: 'pull_request',
  });
  store.updateChangeRequest(request.request_id, { status: 'verified' });
  const completed = store.updateExecutiveWorkItem(task.work_id, {
    status: 'done',
    evidence: [proof],
  });
  assert.equal(completed.status, 'done');
  assert.equal(
    store.updateExecutiveWorkItem(parent.work_id, {
      status: 'done',
      outcome: 'Build accepted for private review',
    }).status,
    'done'
  );
  store.close();
});

test('public site acceptance requires production proof and verifies an external builder commit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-public-site-gate-'));
  const site = 'launch.example';
  const repo = path.join(root, 'sites', site);
  const pages = path.join(repo, 'site', 'src', 'pages');
  fs.mkdirSync(pages, { recursive: true });
  fs.writeFileSync(
    path.join(pages, 'index.astro'),
    '<main><h1>Public cooking site</h1><p>Complete tested launch content.</p></main>'.repeat(5)
  );
  const object = Buffer.from('commit 0\0');
  const commit = crypto.createHash('sha1').update(object).digest('hex');
  const gitDir = path.join(repo, '.git');
  const objectDir = path.join(gitDir, 'objects', commit.slice(0, 2));
  fs.mkdirSync(objectDir, { recursive: true });
  fs.writeFileSync(path.join(objectDir, commit.slice(2)), zlib.deflateSync(object));
  fs.writeFileSync(path.join(gitDir, 'HEAD'), `${commit}\n`);
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  const brief = 'Build and launch a full public site for launch.example.';
  writeSiteBrief(root, site, brief);
  const parent = store.createExecutiveWorkItem({
    title: 'Owner public site build',
    source_type: 'owner-request',
    owner: 'ceo',
    summary: brief,
    status: 'in_progress',
  });
  const task = store.createExecutiveWorkItem({
    title: 'Build public site',
    source_type: 'operating-task',
    parent_work_id: parent.work_id,
    owner: 'site-factory-manager',
    site,
    status: 'in_progress',
  });
  const proof = {
    type: 'artifact',
    label: 'External build acceptance',
    contract: 'site-build/v1',
    source: 'external-builder',
    site,
    brief_sha256: briefHash(brief),
    pages: ['index.astro'],
    build: { command: 'npm run build', exit_code: 0, commit, log_uri: 'build-log.txt' },
    preview: {
      url: 'http://127.0.0.1:4321/',
      status: 'verified-private',
      checked_at: new Date().toISOString(),
    },
  };
  assert.throws(
    () => store.updateExecutiveWorkItem(task.work_id, { status: 'done', evidence: [proof] }),
    /production deployment/
  );
  proof.preview = {
    url: `https://${site}/`,
    status: 'verified-production',
    checked_at: new Date().toISOString(),
  };
  proof.deployment = {
    method: 'github-cloudflare-workers-builds',
    status: 'success',
    commit,
    checked_at: new Date().toISOString(),
  };
  const badCommit = {
    ...proof,
    build: { ...proof.build, commit: 'a'.repeat(40) },
    deployment: { ...proof.deployment, commit: 'a'.repeat(40) },
  };
  assert.throws(
    () => store.updateExecutiveWorkItem(task.work_id, { status: 'done', evidence: [badCommit] }),
    /checked-out site-repository commit/
  );
  assert.equal(
    store.updateExecutiveWorkItem(task.work_id, {
      status: 'done',
      evidence: [proof],
    }).status,
    'done'
  );
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

test('fail-orphan watchdogs terminalize runs and release their dispatch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-watchdog-recovery-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  const agent = store.createAgent({
    slug: 'orphan-agent',
    name: 'Orphan Agent',
    title: 'Worker',
    role: 'engineer',
    adapter: 'codex',
  });
  const run = store.createAgentRun({
    agent_id: agent.agent_id,
    started_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    status: 'running',
  });
  const dispatch = store.createAgentDispatch({ run_id: run.run_id });
  store.createAgentSession({
    agent_id: agent.agent_id,
    run_id: run.run_id,
    session_id: 'orphan-session',
  });
  store.createAgentWatchdog({
    run_id: run.run_id,
    timeout_seconds: 30,
    recovery_action: 'fail-orphan',
  });
  const audit = store.auditAgentWatchdogs({ now: new Date('2026-01-01T00:01:00.000Z') });
  assert.equal(audit.fired.length, 1);
  assert.equal(store.getAgentRun(run.run_id).status, 'failed');
  assert.equal(store.getAgentDispatch(dispatch.dispatch_id).status, 'failed');
  assert.equal(store.getAgentSession('orphan-session').status, 'closed');
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
