'use strict';

const ROLES = [
  'product-manager-fleet',
  'product-manager-sites',
  'delivery-lead',
  'design-director',
  'growth-director',
  'revenue-ops',
  'site-factory',
  'cro',
  'ceo',
  'cfo',
  'cto',
  'legal',
  'security',
  'reviewer',
];

const DEFAULT_ROLE_GOALS = Object.fromEntries(
  ROLES.map(role => [
    role,
    {
      durable_outputs: ['cfo', 'legal', 'security', 'reviewer'].includes(role) ? 1 : 2,
      verified_outcomes: 0,
      protected: false,
    },
  ])
);

const DEFAULT_CONTRACT = {
  enabled: true,
  window_ticks: 5,
  minimum_score: 60,
  recovery_after_windows: 1,
  restricted_after_windows: 2,
  escalation_after_windows: 3,
  weights: { output: 45, outcomes: 30, quality: 15, progress: 10 },
  roles: DEFAULT_ROLE_GOALS,
};

function number(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeWeights(input = {}) {
  const raw = {
    output: number(input.output, DEFAULT_CONTRACT.weights.output, 0, 100),
    outcomes: number(input.outcomes, DEFAULT_CONTRACT.weights.outcomes, 0, 100),
    quality: number(input.quality, DEFAULT_CONTRACT.weights.quality, 0, 100),
    progress: number(input.progress, DEFAULT_CONTRACT.weights.progress, 0, 100),
  };
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0) || 1;
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, Math.round((value / total) * 100)])
  );
}

function normalizeContract(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const roles = { ...DEFAULT_ROLE_GOALS };
  for (const role of ROLES) {
    const goal = source.roles?.[role] || {};
    roles[role] = {
      durable_outputs: number(goal.durable_outputs, roles[role].durable_outputs, 0, 20),
      verified_outcomes: number(goal.verified_outcomes, roles[role].verified_outcomes, 0, 20),
      protected: Boolean(goal.protected),
    };
  }
  return {
    enabled: source.enabled !== false,
    window_ticks: number(source.window_ticks, DEFAULT_CONTRACT.window_ticks, 1, 20),
    minimum_score: number(source.minimum_score, DEFAULT_CONTRACT.minimum_score, 0, 100),
    recovery_after_windows: number(
      source.recovery_after_windows,
      DEFAULT_CONTRACT.recovery_after_windows,
      1,
      10
    ),
    restricted_after_windows: number(
      source.restricted_after_windows,
      DEFAULT_CONTRACT.restricted_after_windows,
      1,
      20
    ),
    escalation_after_windows: number(
      source.escalation_after_windows,
      DEFAULT_CONTRACT.escalation_after_windows,
      1,
      30
    ),
    weights: normalizeWeights(source.weights),
    roles,
  };
}

function inWindow(row, cutoff) {
  return (
    Number.isFinite(Date.parse(row?.created_at || row?.started_at || '')) &&
    Date.parse(row.created_at || row.started_at) >= cutoff
  );
}

function ownerRole(row) {
  const candidates = [row?.created_by, row?.requested_by, row?.assigned_role, row?.owner];
  return candidates.find(value => ROLES.includes(String(value || ''))) || null;
}

function emptyMetrics(role) {
  return {
    role,
    durable_outputs: 0,
    proposals: 0,
    change_requests: 0,
    work_items: 0,
    owner_handoffs: 0,
    verified_outcomes: 0,
    failed_outputs: 0,
    stale_owned_work: 0,
    messages: 0,
    score: 0,
    status: 'needs-recovery',
    recovery: 'none',
    recovery_reason: null,
    recovery_windows: 0,
  };
}

function buildPerformance(store, { now = new Date(), windowTicks, contract: inputContract } = {}) {
  const settings = store.getExecutiveSettings?.() || {};
  const configured = Boolean(inputContract || settings.performance_contract);
  const contract = normalizeContract(inputContract || settings.performance_contract);
  const tickRows = (store.listExecutiveActions?.({ action_type: 'tick', limit: 1000 }) || [])
    .filter(row => row.status === 'completed')
    .sort((a, b) => (Date.parse(a.started_at || '') || 0) - (Date.parse(b.started_at || '') || 0));
  const selectedTicks = tickRows.slice(-number(windowTicks, contract.window_ticks, 1, 20));
  const cutoff = selectedTicks.length
    ? Date.parse(selectedTicks[0].started_at || '')
    : now.getTime() - contract.window_ticks * 15 * 60 * 1000;
  const proposals = (store.listExecutiveProposals?.({ limit: 2000 }) || []).filter(row =>
    inWindow(row, cutoff)
  );
  const changes = (store.listChangeRequests?.({ limit: 2000 }) || []).filter(row =>
    inWindow(row, cutoff)
  );
  const work = (store.listExecutiveWorkItems?.({ limit: 3000 }) || []).filter(row =>
    inWindow(row, cutoff)
  );
  const allChanges = store.listChangeRequests?.({ limit: 3000 }) || [];
  const activeDelivery = allChanges.filter(row =>
    ['queued', 'claimed', 'in_progress', 'building', 'review', 'committed'].includes(row.status)
  ).length;
  const metrics = Object.fromEntries(ROLES.map(role => [role, emptyMetrics(role)]));
  for (const proposal of proposals) {
    const role = ownerRole(proposal);
    if (role) metrics[role].proposals += 1;
  }
  for (const change of changes) {
    const role = ownerRole(change);
    if (!role) continue;
    metrics[role].change_requests += 1;
    if (['verified', 'deployed', 'committed'].includes(change.status))
      metrics[role].verified_outcomes += 1;
    if (['failed', 'cancelled'].includes(change.status)) metrics[role].failed_outputs += 1;
  }
  for (const item of work) {
    const role = ownerRole(item);
    if (!role) continue;
    if (item.source_type === 'owner-request-handoff') metrics[role].owner_handoffs += 1;
    else if (
      ![
        'existing-work',
        'executive-routine',
        'executive-performance-recovery',
        'executive-performance-escalation',
      ].includes(item.source_type)
    )
      metrics[role].work_items += 1;
  }
  for (const item of work.filter(row => !['done', 'cancelled'].includes(String(row.status)))) {
    const role = ownerRole(item);
    if (role) metrics[role].stale_owned_work += 1;
  }
  const messages = store.listExecutiveMessages?.({ limit: 3000 }) || [];
  for (const message of messages.filter(row => inWindow(row, cutoff))) {
    const role = ROLES.includes(String(message.actor || '')) ? message.actor : null;
    if (role) metrics[role].messages += 1;
  }
  const recoveryItems = work.filter(row => row.source_type === 'executive-performance-recovery');
  for (const role of ROLES) {
    const metric = metrics[role];
    const goal = contract.roles[role];
    metric.durable_outputs =
      metric.proposals + metric.change_requests + metric.work_items + metric.owner_handoffs;
    const outputRatio = goal.durable_outputs
      ? Math.min(1, metric.durable_outputs / goal.durable_outputs)
      : 1;
    const outcomeRatio = goal.verified_outcomes
      ? Math.min(1, metric.verified_outcomes / goal.verified_outcomes)
      : metric.durable_outputs > 0
        ? 1
        : 0;
    const qualityRatio = metric.durable_outputs
      ? Math.max(0, 1 - metric.failed_outputs / Math.max(1, metric.durable_outputs))
      : 0;
    const progressRatio =
      metric.stale_owned_work === 0 ? 1 : Math.max(0, 1 - metric.stale_owned_work / 10);
    const weights = contract.weights;
    metric.score = Math.round(
      outputRatio * weights.output +
        outcomeRatio * weights.outcomes +
        qualityRatio * weights.quality +
        progressRatio * weights.progress
    );
    const activeRecovery = recoveryItems.find(
      item => item.owner === role && !['done', 'cancelled'].includes(item.status)
    );
    metric.recovery_windows = activeRecovery
      ? tickRows.filter(
          tick =>
            (Date.parse(tick.started_at || '') || 0) >
            (Date.parse(activeRecovery.created_at || '') || 0)
        ).length
      : 0;
    if (goal.protected) {
      metric.status = 'protected';
      metric.recovery = 'protected';
      metric.recovery_reason =
        'Role is protected from volume penalties; it must record an evidence-backed disposition or unblocker.';
    } else if (!configured) {
      metric.score = null;
      metric.status = 'unarmed';
      metric.recovery = 'not-configured';
      metric.recovery_reason =
        'Performance contract is in preview; save the contract to arm recovery.';
    } else if (
      activeDelivery >= 10 &&
      ['delivery-lead', 'cto', 'site-factory'].includes(role) &&
      metric.durable_outputs === 0
    ) {
      metric.status = 'deferred';
      metric.recovery = 'capacity-blocked';
      metric.recovery_reason =
        'Global implementation capacity is saturated; record an unblocker or pipeline item rather than duplicate delivery work.';
    } else if (metric.score >= contract.minimum_score) {
      metric.status = 'on-track';
      metric.recovery = activeRecovery ? 'monitoring' : 'none';
    } else if (activeRecovery && metric.recovery_windows >= contract.escalation_after_windows) {
      metric.status = 'escalated';
      metric.recovery = 'escalated';
      metric.recovery_reason = `Recovery has remained below threshold for ${metric.recovery_windows} executable cycles; executive intervention is required.`;
    } else if (activeRecovery && metric.recovery_windows >= contract.restricted_after_windows) {
      metric.status = 'recovery';
      metric.recovery = 'restricted';
      metric.recovery_reason = `Recovery has remained below threshold for ${metric.recovery_windows} executable cycles; role is restricted until the assignment is completed.`;
    } else if (activeRecovery) {
      metric.status = 'recovery';
      metric.recovery = 'repair';
      metric.recovery_reason =
        'Recovery assignment is active; role must complete it before receiving broader autonomy.';
    } else {
      metric.status = 'needs-recovery';
      metric.recovery = 'repair';
      metric.recovery_reason = `Score ${metric.score} is below the configured threshold of ${contract.minimum_score}.`;
    }
  }
  return {
    schema: 'executive-performance/v1',
    generated_at: now.toISOString(),
    configured,
    contract,
    capacity: { active_delivery: activeDelivery, saturated: activeDelivery >= 10 },
    window: {
      ticks: selectedTicks.length,
      started_at: selectedTicks[0]?.started_at || null,
      ended_at: selectedTicks.at(-1)?.started_at || null,
    },
    summary: {
      roles: ROLES.length,
      on_track: Object.values(metrics).filter(
        row => row.status === 'on-track' || row.status === 'protected'
      ).length,
      needs_recovery: Object.values(metrics).filter(
        row =>
          row.status === 'needs-recovery' || row.status === 'recovery' || row.status === 'escalated'
      ).length,
      average_score: configured
        ? Math.round(Object.values(metrics).reduce((sum, row) => sum + row.score, 0) / ROLES.length)
        : null,
    },
    roles: Object.values(metrics),
  };
}

function applyPerformanceRecovery(store, { now = new Date() } = {}) {
  const performance = buildPerformance(store, { now });
  if (!performance.configured || !performance.contract.enabled) return { performance, created: [] };
  const created = [];
  for (const metric of performance.roles) {
    if (metric.status === 'escalated') {
      const escalationId = `executive-performance-escalation:${metric.role}`;
      const existingEscalation = store.getExecutiveWorkItem?.(escalationId);
      if (!existingEscalation || ['done', 'cancelled'].includes(existingEscalation.status)) {
        const item = store.createExecutiveWorkItem({
          work_id: escalationId,
          title: `Executive intervention required: ${metric.role}`,
          kind: 'incident',
          status: 'ready',
          priority: 'urgent',
          owner: 'ceo',
          source_type: 'executive-performance-escalation',
          source_id: metric.role,
          site: 'fleet',
          summary: `${metric.role} remained below the performance threshold through ${metric.recovery_windows} recovery cycles.`,
          next_action: `Review the ${metric.role} recovery case, remove the blocker or replace/reassign the responsibility, then record the decision and acceptance criteria.`,
          waiting_on: 'ceo',
          due_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
          created_by: 'executive-performance-controller',
          evidence: [
            {
              type: 'decision',
              label: 'performance escalation',
              note: `${metric.score}/${performance.contract.minimum_score}; recovery_cycles=${metric.recovery_windows}`,
            },
          ],
        });
        created.push(item);
      }
      continue;
    }
    if (!['needs-recovery', 'recovery'].includes(metric.status)) continue;
    const recoveryId = `executive-performance-recovery:${metric.role}`;
    const existing = store.getExecutiveWorkItem?.(recoveryId);
    if (existing && !['done', 'cancelled'].includes(existing.status)) continue;
    const item = store.createExecutiveWorkItem({
      work_id: recoveryId,
      title: `Performance recovery: ${metric.role}`,
      kind: 'incident',
      status: 'ready',
      priority: 'high',
      owner: metric.role,
      source_type: 'executive-performance-recovery',
      source_id: metric.role,
      site: 'fleet',
      summary: `The ${metric.role} role scored ${metric.score}/${performance.contract.minimum_score} in the last ${performance.window.ticks} executable executive cycles.`,
      next_action: `Complete a bounded recovery assignment: identify the highest-value eligible opportunity, create one evidence-backed durable output with owner, acceptance criteria, metric, and rollback, or document the exact blocker and dated unblocker. Generic status messages do not satisfy recovery.`,
      waiting_on: metric.role,
      due_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      created_by: 'executive-performance-controller',
      evidence: [
        {
          type: 'decision',
          label: 'performance score',
          note: `${metric.score}/${performance.contract.minimum_score}; outputs=${metric.durable_outputs}; verified=${metric.verified_outcomes}`,
        },
      ],
    });
    created.push(item);
  }
  return { performance, created };
}

module.exports = {
  ROLES,
  DEFAULT_CONTRACT,
  normalizeContract,
  buildPerformance,
  applyPerformanceRecovery,
};
