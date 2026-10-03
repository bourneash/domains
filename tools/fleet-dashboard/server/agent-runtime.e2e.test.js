'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createApp } = require('./server');

function request(server, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: pathname,
        method,
        headers:
          body === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
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
}

test('agent runtime APIs support registry, runs, artifacts, and enforced budgets', async t => {
  const previousSecretKey = process.env.FD_SECRET_KEY;
  process.env.FD_SECRET_KEY = 'agent-runtime-e2e-key';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-e2e-'));
  const server = createApp({ root }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    if (previousSecretKey === undefined) delete process.env.FD_SECRET_KEY;
    else process.env.FD_SECRET_KEY = previousSecretKey;
    return new Promise(resolve => server.close(resolve));
  });

  const inventory = await request(server, 'GET', '/api/agent-runtime/inventory-summary');
  assert.equal(inventory.status, 200);
  for (const key of [
    'actor', 'users', 'issues', 'policies', 'decisions', 'suites', 'evalRuns', 'blobs',
    'plugins', 'connectors', 'providers', 'adapters', 'delegations', 'dispatches',
    'artifacts', 'skills', 'memories', 'productivityPilots',
  ]) assert.ok(inventory.body[key], `inventory summary includes ${key}`);
  assert.ok(Array.isArray(inventory.body.issues.issues));
  assert.ok(Array.isArray(inventory.body.productivityPilots.pilots));

  const created = await request(server, 'POST', '/api/agents', {
    slug: 'runtime-ceo',
    name: 'Runtime CEO',
    title: 'Chief Executive Officer',
    role: 'ceo',
    adapter: 'codex',
  });
  assert.equal(created.status, 201);
  const agent = created.body.agent;

  const budget = await request(server, 'POST', '/api/budgets', {
    scope_type: 'agent',
    scope_id: agent.agent_id,
    period: 'run',
    limit_usd: 2,
  });
  assert.equal(budget.status, 201);
  assert.equal(
    (
      await request(server, 'POST', '/api/budgets/reserve', {
        scope_type: 'agent',
        scope_id: agent.agent_id,
        period: 'run',
        amount_usd: 1.5,
      })
    ).body.allowed,
    true
  );
  assert.equal(
    (
      await request(server, 'POST', '/api/budgets/reserve', {
        scope_type: 'agent',
        scope_id: agent.agent_id,
        period: 'run',
        amount_usd: 0.6,
      })
    ).status,
    409
  );

  const run = await request(server, 'POST', '/api/agent-runs', {
    agent_id: agent.agent_id,
    work_id: 'work-e2e',
    idempotency_key: 'e2e-run-1',
  });
  assert.equal(run.status, 201);
  assert.equal(
    (
      await request(server, 'POST', '/api/agent-runs', {
        agent_id: agent.agent_id,
        idempotency_key: 'e2e-run-1',
      })
    ).body.run.run_id,
    run.body.run.run_id
  );
  assert.equal(
    (
      await request(server, 'PATCH', `/api/agent-runs/${run.body.run.run_id}`, {
        status: 'succeeded',
        result: { verified: true },
      })
    ).body.run.status,
    'succeeded'
  );
  assert.equal(
    (
      await request(server, 'GET', `/api/agent-evals?run_id=${run.body.run.run_id}`)
    ).body.evaluations.some(row => row.dimension === 'completion'),
    true
  );

  const artifact = await request(server, 'POST', '/api/agent-artifacts', {
    run_id: run.body.run.run_id,
    agent_id: agent.agent_id,
    kind: 'test',
    label: 'E2E result',
    uri: '/artifact/e2e.json',
  });
  assert.equal(artifact.status, 201);
  assert.equal(
    (await request(server, 'GET', `/api/agent-artifacts?run_id=${run.body.run.run_id}`)).body
      .artifacts.length,
    1
  );

  const routine = await request(server, 'POST', '/api/agent-routines', {
    agent_id: agent.agent_id,
    name: 'e2e-heartbeat',
    schedule: '60',
    next_due_at: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(routine.status, 201);
  const evaluation = await request(server, 'POST', '/api/agent-evals', {
    agent_id: agent.agent_id,
    dimension: 'quality',
    score: 95,
    feedback: 'end-to-end verified',
  });
  assert.equal(evaluation.status, 201);
  const grant = await request(server, 'POST', '/api/agent-tools', {
    agent_id: agent.agent_id,
    tool_name: 'read:intelligence',
    scope: { sites: ['example.com'] },
  });
  assert.equal(grant.status, 201);
  assert.equal(
    (
      await request(
        server,
        'GET',
        `/api/agent-tools/check?agent_id=${agent.agent_id}&tool_name=read%3Aintelligence&site=example.com`
      )
    ).body.allowed,
    false
  );
  assert.equal(
    (
      await request(
        server,
        'GET',
        `/api/agent-tools/check?agent_id=${agent.agent_id}&tool_name=read%3Aintelligence&site=example.com&approved=true`
      )
    ).body.allowed,
    true
  );
  const safeGrant = await request(server, 'POST', '/api/agent-tools', {
    agent_id: agent.agent_id,
    tool_name: 'agents.list',
    approval_required: false,
  });
  assert.equal(safeGrant.status, 201);
  const invoked = await request(server, 'POST', '/api/agent-tools/invoke', {
    agent_id: agent.agent_id,
    tool_name: 'agents.list',
    args: { limit: 10 },
  });
  assert.equal(invoked.status, 200);
  assert.ok(Array.isArray(invoked.body.result.agents));
  const workspace = await request(server, 'POST', '/api/agent-workspaces', {
    agent_id: agent.agent_id,
    path: '/tmp/runtime-e2e-workspace',
    mode: 'isolated',
  });
  assert.equal(workspace.status, 201);
  assert.equal(
    (
      await request(
        server,
        'POST',
        `/api/agent-workspaces/${workspace.body.workspace.workspace_id}/close`
      )
    ).body.workspace.status,
    'closed'
  );
  const work = await request(server, 'POST', '/api/executive/work-items', {
    title: 'Claimable work',
    owner: 'cto',
  });
  assert.equal(
    (
      await request(
        server,
        'POST',
        `/api/executive/work-items/${work.body.work_item.work_id}/claim`,
        {
          lease_owner: 'agent:runtime-ceo',
        }
      )
    ).status,
    200
  );
  assert.equal((await request(server, 'POST', '/api/agent-heartbeat/tick', {})).status, 200);

  const skill = await request(server, 'POST', '/api/agent-skills', {
    slug: 'e2e-skill',
    name: 'E2E skill',
  });
  assert.equal(skill.status, 201);
  assert.equal(
    (
      await request(server, 'POST', `/api/agent-skills/${skill.body.skill.skill_id}/versions`, {
        instructions: 'Run the E2E check.',
      })
    ).status,
    201
  );
  assert.equal(
    (
      await request(server, 'POST', '/api/agent-skill-assignments', {
        agent_id: agent.agent_id,
        skill_id: skill.body.skill.skill_id,
        version: 1,
      })
    ).status,
    201
  );
  assert.equal(
    (
      await request(server, 'POST', '/api/agent-memories', {
        agent_id: agent.agent_id,
        memory_key: 'e2e',
        content: 'persisted context',
      })
    ).status,
    201
  );
  assert.equal(
    (
      await request(server, 'POST', '/api/runtime-plugins', {
        slug: 'e2e-plugin',
        manifest: { name: 'E2E plugin' },
      })
    ).status,
    201
  );
  assert.equal(
    (
      await request(server, 'POST', '/api/runtime-connectors', {
        slug: 'e2e-linear',
        kind: 'ticket-system',
        capabilities: ['issues.read'],
      })
    ).status,
    201
  );
  const provider = await request(server, 'POST', '/api/runtime-providers', {
    slug: 'e2e-provider',
    kind: 'local',
    status: 'active',
  });
  assert.equal(provider.status, 201);
  assert.equal(
    (
      await request(server, 'POST', '/api/agent-secrets', {
        name: 'e2e-secret',
        value: 'never-list-me',
        scope: { agent_id: agent.agent_id },
      })
    ).status,
    201
  );
  assert.equal(
    (
      await request(server, 'POST', '/api/agent-tools', {
        agent_id: agent.agent_id,
        tool_name: 'secret:e2e-secret',
        approval_required: false,
      })
    ).status,
    201
  );
  const resolvedSecret = await request(server, 'POST', '/api/agent-secrets/resolve', {
    agent_id: agent.agent_id,
    name: 'e2e-secret',
  });
  assert.equal(resolvedSecret.body.value, 'never-list-me');
  assert.equal(
    (
      await request(server, 'POST', '/api/agent-delegations', {
        from_agent_id: agent.agent_id,
        to_agent_id: agent.agent_id,
      })
    ).status,
    400
  );
  const organization = await request(server, 'POST', '/api/organizations', {
    slug: 'e2e-org',
    name: 'E2E org',
  });
  assert.equal(organization.status, 201);
  const plan = await request(server, 'POST', '/api/executive/plans', { title: 'E2E plan' });
  assert.equal(plan.status, 201);
  assert.equal(
    (
      await request(server, 'POST', `/api/executive/plans/${plan.body.plan.plan_id}/versions`, {
        body: { check: true },
      })
    ).status,
    201
  );
  assert.equal(
    (
      await request(server, 'POST', `/api/executive/plans/${plan.body.plan.plan_id}/approve`, {
        version: 1,
        decided_by: 'owner',
      })
    ).body.plan.status,
    'approved'
  );
  assert.equal(
    (
      await request(
        server,
        'GET',
        `/api/organizations/${organization.body.organization.organization_id}/export`
      )
    ).body.schema,
    'executive-organization/v1'
  );
  assert.equal((await request(server, 'GET', '/api/agent-dispatches?limit=10')).status, 200);
  assert.equal((await request(server, 'GET', '/api/agent-runs?limit=10')).status, 200);
});
