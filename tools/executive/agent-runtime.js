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
  [
    'fleet-delivery-lead',
    'Fleet Delivery Lead',
    'Head of Portfolio Delivery',
    'delivery-lead',
    'chatgpt',
    'codex',
  ],
  [
    'fleet-design-director',
    'Fleet Design Director',
    'Design and Conversion Lead',
    'design-director',
    'chatgpt',
    'codex',
  ],
  [
    'fleet-growth-director',
    'Fleet Growth Director',
    'SEO and Growth Lead',
    'growth-director',
    'chatgpt',
    'codex',
  ],
  [
    'fleet-revenue-ops',
    'Fleet Revenue Operations',
    'Affiliate and Attribution Lead',
    'revenue-ops',
    'chatgpt',
    'codex',
  ],
  [
    'fleet-site-factory',
    'Fleet Site Factory',
    'New Site Launch Lead',
    'site-factory',
    'chatgpt',
    'codex',
  ],
  [
    'fleet-exec-overwatch',
    'Exec Overwatch',
    'Independent Executive Improvement Controller',
    'exec-overwatch',
    'chatgpt',
    'codex',
  ],
];

const ACCOUNTABILITY_ROLES = new Set([
  'operations-manager',
  'engineering-manager',
  'growth-manager',
  'design-manager',
  'site-factory-manager',
]);
const DELIVERY_FAILURE_PAUSE_THRESHOLD = 2;
const DELIVERY_REPROVISION_THRESHOLD = 4;

function accountabilityPolicy(store) {
  const configured = store.getExecutiveSettings?.().performance_contract?.accountability || {};
  const integer = (value, fallback, min, max) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
  };
  return {
    pause_after_failures: integer(
      configured.pause_after_failures,
      DELIVERY_FAILURE_PAUSE_THRESHOLD,
      1,
      20
    ),
    reprovision_after_failures: integer(
      configured.reprovision_after_failures,
      DELIVERY_REPROVISION_THRESHOLD,
      2,
      50
    ),
    recovery_cooldown_minutes: integer(configured.recovery_cooldown_minutes, 60, 5, 1440),
  };
}

function accountabilityState(agent) {
  return agent?.workspace?.accountability && typeof agent.workspace.accountability === 'object'
    ? agent.workspace.accountability
    : {};
}

function recordAccountabilityOutcome(store, run, { delivered, reason = null } = {}) {
  const agent = store.getAgent(run.agent_id);
  if (!agent || !ACCOUNTABILITY_ROLES.has(agent.role)) return agent;
  const current = accountabilityState(agent);
  const policy = accountabilityPolicy(store);
  const now = new Date();
  const consecutiveFailures = delivered ? 0 : Number(current.consecutive_failures || 0) + 1;
  const totalFailures = Number(current.total_failures || 0) + (delivered ? 0 : 1);
  const shouldPause = !delivered && consecutiveFailures >= policy.pause_after_failures;
  const nextAccountability = {
    ...current,
    consecutive_failures: consecutiveFailures,
    total_failures: totalFailures,
    total_deliveries: Number(current.total_deliveries || 0) + (delivered ? 1 : 0),
    last_outcome: delivered ? 'delivered' : 'failed_to_deliver',
    last_failure_reason: delivered ? current.last_failure_reason || null : reason,
    last_outcome_at: now.toISOString(),
    suspended_until: shouldPause
      ? new Date(now.getTime() + policy.recovery_cooldown_minutes * 60 * 1000).toISOString()
      : current.suspended_until || null,
    reprovision_required:
      totalFailures >= policy.reprovision_after_failures || current.reprovision_required === true,
    reprovision_count: Number(current.reprovision_count || 0),
  };
  const patch = {
    workspace: { ...(agent.workspace || {}), accountability: nextAccountability },
  };
  if (shouldPause && agent.status === 'active') {
    patch.status = 'paused';
    patch.pause_reason = `Automatic performance pause: ${consecutiveFailures} consecutive failed-to-deliver runs. Recovery requires concrete executable output or operator unpause.`;
  }
  return store.updateAgent(agent.agent_id, patch);
}

function recoverExpiredAgent(store, agent) {
  if (!agent || !ACCOUNTABILITY_ROLES.has(agent.role) || agent.status !== 'paused') return agent;
  const until = Date.parse(agent.workspace?.accountability?.suspended_until || '');
  if (!Number.isFinite(until) || until > Date.now()) return agent;
  const state = accountabilityState(agent);
  const next = {
    ...state,
    consecutive_failures: 0,
    last_outcome: 'reprovisioned_recovery_window',
    last_outcome_at: new Date().toISOString(),
    reprovision_count: Number(state.reprovision_count || 0) + (state.reprovision_required ? 1 : 0),
    reprovision_required: false,
    execution_generation: Number(state.execution_generation || 0) + 1,
    suspended_until: null,
  };
  return store.updateAgent(agent.agent_id, {
    status: 'active',
    pause_reason: null,
    workspace: { ...(agent.workspace || {}), accountability: next },
  });
}

function accountabilityScore(agent) {
  const state = accountabilityState(agent);
  const deliveries = Number(state.total_deliveries || 0);
  const failures = Number(state.total_failures || 0);
  if (!deliveries && !failures) return 50;
  return Math.max(0, Math.min(100, Math.round((deliveries / (deliveries + failures)) * 100)));
}

const OVERWATCH_WORKSPACE = {
  mode: 'control-plane',
  overwatch: {
    enabled: true,
    interval_minutes: 60,
    lookback_runs: 4,
    aggression: 'aggressive',
    prompt:
      'You are Exec Overwatch. Inspect the last four executive cycles and the downstream manager/worker output. Determine whether real work shipped or only discussion occurred. Repair stuck or failed handoffs, then create the smallest high-confidence changes that improve execution throughput, prompt quality, routing, measurement, or strategic growth. Every turn must either make a concrete repair/improvement or record an evidence-backed blocker with an owner and next action. Never count acknowledgements, unchanged checkpoints, reports, or updates to old work as new output. Preserve legal, security, spend, credential, and deployment gates.',
    goals: [
      'Increase verified implementation work and completed downstream handoffs.',
      'Reduce stuck, failed, duplicate, and pass-through-only executive work.',
      'Improve executive, manager, and worker prompts/processes using measured evidence.',
      'Maintain strategic growth coverage across design, development, SEO, sites, and revenue.',
    ],
  },
};

function ensureRegistry(store, { model = process.env.EXECUTIVE_MODEL || null } = {}) {
  const existing = new Map(store.listAgents({ limit: 1000 }).map(agent => [agent.slug, agent]));
  const created = [];
  for (const [slug, name, title, role, provider, adapter] of DEFAULT_AGENTS) {
    if (existing.has(slug)) continue;
    const workspace =
      slug === 'fleet-exec-overwatch'
        ? OVERWATCH_WORKSPACE
        : {
            mode: ['project-manager', 'delivery-lead'].includes(role)
              ? 'control-plane'
              : 'isolated',
          };
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
        heartbeat: {
          enabled: true,
          interval_minutes: ['project-manager', 'delivery-lead'].includes(role) ? 15 : 60,
        },
        workspace,
      })
    );
  }
  const overwatch =
    existing.get('fleet-exec-overwatch') || created.find(a => a.slug === 'fleet-exec-overwatch');
  if (overwatch && store.createAgentRoutine) {
    store.createAgentRoutine({
      routine_id: 'routine:exec-overwatch-hourly',
      agent_id: overwatch.agent_id,
      name: 'Hourly execution audit and improvement cycle',
      trigger_type: 'cron',
      schedule: '0 * * * *',
      status: overwatch.status === 'active' ? 'active' : 'paused',
      coalesce: 1,
      catch_up: 0,
      max_concurrency: 1,
      next_due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
  }
  return { agents: store.listAgents({ limit: 1000 }), created };
}

function requireAgent(store, agentId) {
  const agent = recoverExpiredAgent(store, store.getAgent(agentId));
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
  const hasDeliverySignal =
    status !== 'succeeded' || Object.prototype.hasOwnProperty.call(result || {}, 'delivery_status');
  const isDeferred = result?.delivery_status === 'deferred';
  if (hasDeliverySignal && !isDeferred) {
    recordAccountabilityOutcome(store, current, {
      delivered: status === 'succeeded' && result?.delivery_status !== 'failed_to_deliver',
      reason: error || result?.delivery_error || (status === 'failed' ? `Run ${status}.` : null),
    });
  }
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
  accountabilityState,
  accountabilityPolicy,
  accountabilityScore,
  recoverExpiredAgent,
  recordAccountabilityOutcome,
  beginRun,
  heartbeat,
  finish,
  attachArtifact,
};
