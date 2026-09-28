'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const eventstore = require('./eventstore');
const { createApp } = require('./server');
const runtime = require('../../executive/agent-runtime');
const dispatcher = require('../../executive/agent-dispatcher');
const runtimeProvider = require('../../executive/runtime-provider');
const runtimePlugin = require('../../executive/runtime-plugin');
const evalRunner = require('../../executive/eval-runner');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-platform-v2-'));
  return { dir, store: eventstore.open(dir, { file: path.join(dir, 'events.sqlite') }) };
}

test('platform identity supports users, scoped credentials, invites, and sessions', () => {
  const { store } = fixture();
  const org = store.createOrganization({ slug: 'identity-test', name: 'Identity Test' });
  const user = store.createHumanUser({ email: 'owner@example.com', display_name: 'Owner' });
  const credential = store.createApiCredential({
    user_id: user.user_id,
    organization_id: org.organization_id,
    label: 'agent',
  });
  assert.equal(store.authenticateApiCredential(credential.token).user_id, user.user_id);
  assert.equal(store.authenticateApiCredential('wrong-token'), null);
  const invite = store.createOrganizationInvite({
    organization_id: org.organization_id,
    email: user.email,
    role: 'owner',
    invited_by: 'system',
  });
  assert.equal(store.acceptOrganizationInvite(invite.token, user.user_id).role, 'owner');
  const agent = store.createAgent({
    organization_id: org.organization_id,
    slug: 'identity-agent',
    name: 'Identity Agent',
    title: 'Worker',
    role: 'worker',
    provider: 'test',
    adapter: 'test',
  });
  const session = store.createAgentSession({ agent_id: agent.agent_id, context: { goal: 'test' } });
  assert.equal(
    store.heartbeatAgentSession(session.session_id, { context: { goal: 'updated' } }).context.goal,
    'updated'
  );
  store.close();
});

test('issues enforce dependencies and atomic checkout', () => {
  const { store } = fixture();
  const org = store.createOrganization({ slug: 'issue-test', name: 'Issue Test' });
  const blocked = store.createAgentIssue({
    organization_id: org.organization_id,
    title: 'Blocked',
  });
  const prerequisite = store.createAgentIssue({
    organization_id: org.organization_id,
    title: 'Prerequisite',
  });
  store.addAgentIssueDependency({
    issue_id: blocked.issue_id,
    depends_on_issue_id: prerequisite.issue_id,
  });
  assert.throws(() => store.checkoutAgentIssue(blocked.issue_id, 'agent-a'), /blocked/);
  store.updateAgentIssue(prerequisite.issue_id, { status: 'done' });
  assert.equal(store.checkoutAgentIssue(blocked.issue_id, 'agent-a').checkout_owner, 'agent-a');
  assert.equal(store.checkoutAgentIssue(blocked.issue_id, 'agent-b'), null);
  store.close();
});

test('governance policies, evaluation suites/runs, and object metadata persist', () => {
  const { store } = fixture();
  const org = store.createOrganization({ slug: 'governance-test', name: 'Governance Test' });
  const agent = store.createAgent({
    organization_id: org.organization_id,
    slug: 'eval-agent',
    name: 'Eval Agent',
    title: 'Worker',
    role: 'worker',
    provider: 'test',
    adapter: 'test',
  });
  const policy = store.upsertExecutionPolicy({
    organization_id: org.organization_id,
    name: 'Ship gate',
    stages: ['review', 'approval'],
  });
  const decision = store.createGovernanceDecision({
    organization_id: org.organization_id,
    policy_id: policy.policy_id,
    entity_type: 'agent-run',
    entity_id: 'run-1',
    decision: 'approved',
    reason: 'test',
  });
  assert.equal(store.listGovernanceDecisions({ entity_id: decision.entity_id }).length, 1);
  const suite = store.createEvalSuite({
    organization_id: org.organization_id,
    name: 'Quality',
    cases: [{ input: 'x', expected: 'y' }],
  });
  assert.equal(
    store.createEvalRun({ suite_id: suite.suite_id, agent_id: agent.agent_id }).suite_id,
    suite.suite_id
  );
  assert.equal(
    store.createObjectBlob({
      organization_id: org.organization_id,
      owner_type: 'eval',
      owner_id: suite.suite_id,
      storage_uri: 'file:///tmp/eval.json',
    }).owner_id,
    suite.suite_id
  );
  store.close();
});

test('approval policies block live runs until an auditable decision exists', () => {
  const { store } = fixture();
  const org = store.createOrganization({ slug: 'approval-test', name: 'Approval Test' });
  const agent = store.createAgent({
    organization_id: org.organization_id,
    slug: 'approval-agent',
    name: 'Approval Agent',
    title: 'Worker',
    role: 'worker',
    provider: 'test',
    adapter: 'test',
  });
  store.upsertExecutionPolicy({
    organization_id: org.organization_id,
    name: 'Run approval',
    stages: ['run'],
  });
  const runId = 'approval-run-1';
  assert.throws(
    () => store.createAgentRun({ run_id: runId, agent_id: agent.agent_id, status: 'running' }),
    /approval required/
  );
  store.createGovernanceDecision({
    organization_id: org.organization_id,
    entity_type: 'agent-run',
    entity_id: runId,
    decision: 'approved',
    actor_id: 'owner',
  });
  assert.equal(
    store.createAgentRun({ run_id: runId, agent_id: agent.agent_id, status: 'running' }).status,
    'running'
  );
  store.close();
});

test('budget enforcement covers agent scopes and cancels queued dispatches', () => {
  const { store } = fixture();
  const agent = store.createAgent({
    slug: 'budget-agent',
    name: 'Budget Agent',
    title: 'Worker',
    role: 'worker',
    provider: 'test',
    adapter: 'test',
  });
  const run = store.createAgentRun({ agent_id: agent.agent_id });
  store.createAgentDispatch({ run_id: run.run_id, adapter: 'test' });
  store.upsertBudgetPolicy({
    scope_type: 'agent',
    scope_id: agent.agent_id,
    period: 'month',
    limit_usd: 1,
    spent_usd: 1,
  });
  assert.throws(() => store.createAgentRun({ agent_id: agent.agent_id }), /budget exceeded/);
  const stopped = store.enforceBudgetStops();
  assert.equal(
    stopped.some(row => row.run_id === run.run_id),
    true
  );
  assert.equal(store.getAgentDispatch(run.run_id).status, 'cancelled');
  store.close();
});

test('external adapter workers receive signed run context and return usage', async () => {
  const { store } = fixture();
  const agent = store.createAgent({
    slug: 'http-agent',
    name: 'HTTP Agent',
    title: 'Worker',
    role: 'worker',
    provider: 'test',
    adapter: 'http-adapter',
  });
  store.upsertRuntimeAdapter({
    slug: 'http-adapter',
    kind: 'http',
    endpoint: 'http://adapter.invalid/run',
    status: 'online',
  });
  const started = runtime.beginRun(store, {
    agent_id: agent.agent_id,
    idempotency_key: 'http-run-1',
  });
  const previousFetch = global.fetch;
  let received;
  global.fetch = async (_url, options) => {
    received = { options, body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          result: { verified: true, input_tokens: 3, output_tokens: 5, cost_usd: 0.02 },
        }),
    };
  };
  try {
    const processed = await dispatcher.processOne(store, { workerId: 'http-worker' });
    assert.equal(processed.result.verified, true);
    assert.equal(store.getAgentRun(started.run.run_id).total_tokens, 8);
    assert.match(received.options.headers.authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
    assert.equal(received.body.run.run_id, started.run.run_id);
  } finally {
    global.fetch = previousFetch;
    store.close();
  }
});

test('runtime providers provision and close isolated workspaces through the provider protocol', async () => {
  const { store } = fixture();
  const agent = store.createAgent({
    slug: 'provider-agent',
    name: 'Provider Agent',
    title: 'Worker',
    role: 'worker',
    provider: 'test',
    adapter: 'test',
  });
  const provider = store.upsertRuntimeProvider({
    slug: 'sandbox-provider',
    kind: 'container',
    status: 'active',
    config: { endpoint: 'http://provider.invalid' },
  });
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          workspace_path: '/tmp/provider-workspace',
          preview_url: 'https://preview.invalid/run',
        }),
    };
  };
  try {
    const workspace = await runtimeProvider.provision(store, {
      provider_id: provider.provider_id,
      agent_id: agent.agent_id,
      mode: 'isolated',
    });
    assert.equal(workspace.provider_id, provider.provider_id);
    assert.equal(workspace.preview_url, 'https://preview.invalid/run');
    await runtimeProvider.close(store, workspace.workspace_id);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/v1\/workspaces$/);
    assert.match(calls[1].url, /\/close$/);
    store.close();
  } finally {
    global.fetch = previousFetch;
  }
});

test('out-of-process plugins execute jobs and return structured results', async () => {
  const { store } = fixture();
  const plugin = store.upsertRuntimePlugin({
    slug: 'http-plugin',
    status: 'active',
    manifest: {
      name: 'HTTP Plugin',
      worker_endpoint: 'http://plugin.invalid',
      capabilities: ['knowledge.write'],
      ui: { panel: 'knowledge' },
    },
  });
  const job = store.enqueueRuntimePluginJob({ plugin_id: plugin.plugin_id, payload: { value: 7 } });
  const previousFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ result: { accepted: body.job.payload.value === 7 } }),
    };
  };
  try {
    const processed = await runtimePlugin.processOne(store, { workerId: 'plugin-worker' });
    assert.equal(processed.job.status, 'succeeded');
    assert.equal(processed.result.accepted, true);
    assert.equal(store.getRuntimePluginJob(job.job_id).status, 'succeeded');
  } finally {
    global.fetch = previousFetch;
    store.close();
  }
});

test('evaluation runner persists case scores, threshold, and feedback', async () => {
  const { store } = fixture();
  const agent = store.createAgent({
    slug: 'eval-runner-agent',
    name: 'Eval Runner',
    title: 'Worker',
    role: 'worker',
    provider: 'test',
    adapter: 'test',
  });
  const suite = store.createEvalSuite({
    name: 'Regression suite',
    cases: [{ input: 'a' }, { input: 'b' }],
    threshold: 0.9,
  });
  const result = await evalRunner.run(store, {
    suite_id: suite.suite_id,
    agent_id: agent.agent_id,
    results: [{ score: 1 }, { score: 0.75 }],
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.scores.average, 0.875);
  assert.equal(result.scores.passed, false);
  store.close();
});

test('platform APIs complete an authenticated issue, governance, eval, and storage flow', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-platform-api-'));
  const server = createApp({ root }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (method, pathname, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.address().port,
          path: pathname,
          method,
          headers: {
            ...(body === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(payload),
                }),
            ...headers,
          },
        },
        res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            let body;
            try {
              body = JSON.parse(text);
            } catch {
              body = text;
            }
            resolve({ status: res.statusCode, body });
          });
        }
      );
      req.on('error', reject);
      req.end(payload);
    });
  const org = (await request('POST', '/api/organizations', { slug: 'api-test', name: 'API Test' }))
    .body.organization;
  const agent = (
    await request('POST', '/api/agents', {
      organization_id: org.organization_id,
      slug: 'api-agent',
      name: 'API Agent',
      title: 'Worker',
      role: 'worker',
      provider: 'test',
      adapter: 'test',
    })
  ).body.agent;
  const user = (
    await request('POST', '/api/platform/users', {
      email: 'api@example.com',
      display_name: 'API User',
    })
  ).body.user;
  const credential = (
    await request('POST', '/api/platform/credentials', {
      user_id: user.user_id,
      organization_id: org.organization_id,
      label: 'e2e',
      scopes: ['*'],
    })
  ).body.credential;
  const authHeaders = { 'x-agent-key': credential.token };
  assert.equal(
    (await request('GET', '/api/platform/actor', undefined, authHeaders)).body.actor.access,
    'agent'
  );
  const issue = (
    await request(
      'POST',
      '/api/agent-issues',
      { organization_id: org.organization_id, title: 'API issue' },
      authHeaders
    )
  ).body.issue;
  assert.equal(
    (
      await request(
        'POST',
        `/api/agent-issues/${issue.issue_id}/comments`,
        { body: 'operator note' },
        authHeaders
      )
    ).status,
    201
  );
  assert.equal(
    (
      await request(
        'POST',
        `/api/agent-issues/${issue.issue_id}/attachments`,
        { label: 'evidence', uri: 'file:///tmp/evidence.txt' },
        authHeaders
      )
    ).status,
    201
  );
  assert.equal(
    (
      await request(
        'POST',
        `/api/agent-issues/${issue.issue_id}/checkout`,
        { owner: agent.agent_id },
        authHeaders
      )
    ).body.issue.status,
    'in_progress'
  );
  const policy = (
    await request(
      'POST',
      '/api/execution-policies',
      { organization_id: org.organization_id, name: 'API gate', stages: ['approval'] },
      authHeaders
    )
  ).body.policy;
  assert.equal(
    (
      await request(
        'POST',
        '/api/governance-decisions',
        {
          organization_id: org.organization_id,
          policy_id: policy.policy_id,
          entity_type: 'issue',
          entity_id: issue.issue_id,
          decision: 'approved',
        },
        authHeaders
      )
    ).body.decision.decision,
    'approved'
  );
  const suite = (
    await request(
      'POST',
      '/api/eval-suites',
      { organization_id: org.organization_id, name: 'API quality', cases: [{ input: 'x' }] },
      authHeaders
    )
  ).body.suite;
  assert.equal(
    (
      await request(
        'POST',
        '/api/eval-runs',
        { suite_id: suite.suite_id, agent_id: agent.agent_id },
        authHeaders
      )
    ).body.run.suite_id,
    suite.suite_id
  );
  const blob = (
    await request(
      'POST',
      '/api/object-blobs',
      {
        organization_id: org.organization_id,
        owner_type: 'issue',
        owner_id: issue.issue_id,
        content_type: 'text/plain',
        content_base64: Buffer.from('verified artifact').toString('base64'),
      },
      authHeaders
    )
  ).body.blob;
  const content = await request(
    'GET',
    `/api/object-blobs/${blob.blob_id}/content`,
    undefined,
    authHeaders
  );
  assert.equal(content.status, 200);
  const adapter = (
    await request(
      'POST',
      '/api/runtime-adapters',
      { slug: 'api-adapter', kind: 'http', capabilities: ['run'], status: 'offline' },
      authHeaders
    )
  ).body.adapter;
  assert.equal(
    (
      await request(
        'POST',
        `/api/runtime-adapters/${adapter.adapter_id}/heartbeat`,
        { version: '1.0.0' },
        authHeaders
      )
    ).body.adapter.status,
    'online'
  );
  const connector = (
    await request(
      'POST',
      '/api/runtime-connectors',
      { slug: 'api-mcp', kind: 'mcp', capabilities: ['search'], status: 'active' },
      authHeaders
    )
  ).body.connector;
  const initialized = await request(
    'POST',
    `/api/mcp/${connector.connector_id}`,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } },
    },
    authHeaders
  );
  assert.equal(initialized.body.result.serverInfo.name, 'api-mcp');
  assert.equal(
    (
      await request(
        'POST',
        `/api/mcp/${connector.connector_id}`,
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        authHeaders
      )
    ).body.result.tools[0].name,
    'search'
  );
  const callResponse = await request(
    'POST',
    `/api/mcp/${connector.connector_id}`,
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'search', arguments: { q: 'test' } },
    },
    authHeaders
  );
  assert.equal(callResponse.status, 200, JSON.stringify(callResponse.body));
  assert.match(callResponse.body.result.content[0].text, /queued connector call/);
  const limited = (
    await request('POST', '/api/platform/credentials', {
      user_id: user.user_id,
      organization_id: org.organization_id,
      label: 'limited',
      scopes: ['work:write'],
    })
  ).body.credential;
  assert.equal(
    (
      await request(
        'POST',
        '/api/governance-decisions',
        {
          organization_id: org.organization_id,
          entity_type: 'issue',
          entity_id: issue.issue_id,
          decision: 'denied',
        },
        { 'x-agent-key': limited.token }
      )
    ).status,
    403
  );
});
