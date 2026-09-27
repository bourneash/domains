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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-e2e-'));
  const server = createApp({ root }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

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
});
