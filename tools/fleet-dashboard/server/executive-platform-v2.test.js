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
          res.on('end', () =>
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) })
          );
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
  assert.equal(
    (
      await request(
        'POST',
        '/api/object-blobs',
        {
          organization_id: org.organization_id,
          owner_type: 'issue',
          owner_id: issue.issue_id,
          storage_uri: 's3://test/result.json',
        },
        authHeaders
      )
    ).status,
    201
  );
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
