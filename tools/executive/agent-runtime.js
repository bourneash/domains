'use strict';

// Paperclip-inspired runtime contract for fleet agents. The executive and
// site-specific policies remain authoritative; this module supplies the
// common identity, run, budget, session, and artifact lifecycle beneath them.

const crypto = require('node:crypto');

const DEFAULT_AGENTS = [
  ['fleet-ceo', 'Fleet CEO', 'Chief Executive Officer', 'ceo', 'chatgpt', 'codex'],
  ['fleet-cto', 'Fleet CTO', 'Chief Technology Officer', 'cto', 'chatgpt', 'codex'],
  ['fleet-cfo', 'Fleet CFO', 'Chief Financial Officer', 'cfo', 'chatgpt', 'codex'],
  ['fleet-cro', 'Fleet CRO', 'Chief Research Officer', 'cro', 'chatgpt', 'codex'],
  ['fleet-legal', 'Fleet Legal', 'Legal and Compliance Reviewer', 'legal', 'chatgpt', 'codex'],
  ['fleet-security', 'Fleet Security', 'Security Reviewer', 'security', 'chatgpt', 'codex'],
  [
    'fleet-reviewer',
    'Fleet Reviewer',
    'Independent Executive Reviewer',
    'reviewer',
    'chatgpt',
    'codex',
  ],
  [
    'fleet-project-manager',
    'Fleet Project Manager',
    'Executive Project Manager',
    'project-manager',
    'chatgpt',
    'codex',
  ],
];

function ensureRegistry(store, { model = process.env.EXECUTIVE_MODEL || null } = {}) {
  const existing = new Map(store.listAgents({ limit: 1000 }).map(agent => [agent.slug, agent]));
  const created = [];
  for (const [slug, name, title, role, provider, adapter] of DEFAULT_AGENTS) {
    if (existing.has(slug)) continue;
    created.push(
      store.createAgent({
        slug,
        name,
        title,
        role,
        provider,
        model,
        adapter,
        permissions:
          role === 'reviewer'
            ? ['read:intelligence', 'review:proposals']
            : ['read:intelligence', 'create:work'],
        heartbeat: { enabled: true, interval_minutes: role === 'project-manager' ? 15 : 60 },
        workspace: { mode: role === 'project-manager' ? 'control-plane' : 'isolated' },
      })
    );
  }
  return { agents: store.listAgents({ limit: 1000 }), created };
}

function requireAgent(store, agentId) {
  const agent = store.getAgent(agentId);
  if (!agent) throw new Error(`agent not found: ${agentId}`);
  if (agent.status !== 'active') throw new Error(`agent is ${agent.status}: ${agent.slug}`);
  return agent;
}

function beginRun(store, input = {}) {
  const agent = requireAgent(store, input.agent_id);
  const runId = input.run_id || crypto.randomUUID();
  const idempotencyKey = input.idempotency_key || `run:${agent.agent_id}:${runId}`;
  const existing = store.getAgentRunByIdempotency(idempotencyKey);
  if (existing) return { run: existing, reused: true };
  const reservations = Array.isArray(input.budget_scopes) ? input.budget_scopes.slice() : [];
  if (Number(input.reserve_usd || 0) > 0)
    reservations.push({
      scope_type: 'agent',
      scope_id: agent.agent_id,
      period: input.budget_period || 'month',
      amount_usd: input.reserve_usd,
    });
  if (reservations.length) {
    try {
      store.reserveBudgetBatch(reservations);
    } catch (error) {
      throw new Error(`agent budget reservation failed: ${error.message}`);
    }
  }
  const run = store.createAgentRun({
    ...input,
    run_id: runId,
    agent_id: agent.agent_id,
    idempotency_key: idempotencyKey,
    status: 'running',
  });
  store.createAgentDispatch({
    run_id: run.run_id,
    adapter: agent.adapter,
    payload: {
      agent_id: agent.agent_id,
      goal_id: input.goal_id || null,
      work_id: input.work_id || null,
    },
  });
  return { run, reused: false };
}

function heartbeat(store, runId, patch = {}) {
  const run = store.getAgentRun(runId);
  if (!run) throw new Error('agent run not found');
  if (['succeeded', 'failed', 'cancelled'].includes(run.status))
    throw new Error('cannot heartbeat a terminal run');
  return store.updateAgentRun(runId, {
    ...patch,
    status: 'running',
    heartbeat_at: new Date().toISOString(),
  });
}

function finish(
  store,
  runId,
  {
    status = 'succeeded',
    result = {},
    error = null,
    cost_usd = 0,
    input_tokens = 0,
    output_tokens = 0,
  } = {}
) {
  if (!['succeeded', 'failed', 'cancelled'].includes(status))
    throw new Error('finish status must be terminal');
  const current = store.getAgentRun(runId);
  if (!current) throw new Error('agent run not found');
  const finished = store.updateAgentRun(runId, {
    status,
    result,
    error,
    cost_usd,
    input_tokens,
    output_tokens,
    total_tokens: Number(input_tokens) + Number(output_tokens),
  });
  if (store.completeAgentDispatchForRun) store.completeAgentDispatchForRun(runId, status, error);
  // Every completed run gets a small, machine-generated outcome signal. Human
  // or model-quality evaluations can be added separately without making the
  // runtime depend on an evaluator being online.
  if (!store.listAgentEvals({ run_id: runId, dimension: 'completion', limit: 1 }).length) {
    store.createAgentEval({
      agent_id: current.agent_id,
      run_id: runId,
      evaluator: 'system',
      dimension: 'completion',
      score: status === 'succeeded' ? 100 : 0,
      feedback:
        status === 'succeeded'
          ? 'Run reached a terminal success state.'
          : error || `Run ${status}.`,
      evidence: { status, cost_usd: Number(cost_usd) || 0 },
    });
  }
  return finished;
}

function attachArtifact(store, run, artifact) {
  return store.createAgentArtifact({
    ...artifact,
    run_id: run.run_id,
    agent_id: run.agent_id,
    work_id: artifact.work_id || run.work_id,
  });
}

module.exports = {
  DEFAULT_AGENTS,
  ensureRegistry,
  requireAgent,
  beginRun,
  heartbeat,
  finish,
  attachArtifact,
};
