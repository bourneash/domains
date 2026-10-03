'use strict';

// Exec Overwatch is deliberately separate from the executive tick. It audits
// the last four leadership windows, repairs queue mechanics, and then gives an
// isolated improvement pass the measured evidence. It may improve prompts,
// routing, or create bounded implementation work, but it cannot bypass the
// existing legal, security, spend, credential, or deployment gates.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const eventstore = require('../fleet-dashboard/server/eventstore');
const runtime = require('./agent-runtime');
const { alertConsecutiveFailures } = require('./overwatch-alert');
const workEvidence = require('../fleet-dashboard/server/work-evidence');
const deliveryReadiness = require('./delivery-readiness');
const deliveryRecovery = require('./overwatch-delivery-recovery');

const ROOT = process.env.FD_DOMAINS_ROOT || path.resolve(__dirname, '..', '..');
const AGENT_SLUG = 'fleet-exec-overwatch';
const ROLE = 'exec-overwatch';
const MANAGER_SLUGS = new Set([
  'fleet-operations-manager',
  'fleet-engineering-manager',
  'fleet-growth-manager',
  'fleet-design-manager',
  'fleet-site-factory-manager',
]);
const MANAGER_AGENT_BY_OWNER = new Map(
  [...MANAGER_SLUGS].map(slug => [slug.replace(/^fleet-/, ''), slug])
);
const EXECUTABLE_WORK_KINDS = new Set([
  'implementation',
  'content',
  'design',
  'engineering',
  'seo',
]);
const DELIVERY_MODES = new Set(['direct', 'pull_request']);

function iso(value) {
  return new Date(value).toISOString();
}

function parseDate(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function captureSnapshot(store) {
  return {
    work: new Map(
      store.listExecutiveWorkItems({ limit: 1000, quiet: 0 }).map(item => [item.work_id, item])
    ),
    requests: new Map(
      store.listChangeRequests({ limit: 1000 }).map(item => [item.request_id, item])
    ),
    artifacts: new Set(store.listAgentArtifacts({ limit: 1000 }).map(item => item.artifact_id)),
  };
}

function isExecutableWork(item) {
  return (
    EXECUTABLE_WORK_KINDS.has(String(item.kind)) &&
    Boolean(item.site) &&
    !['blocked', 'waiting', 'cancelled', 'done'].includes(String(item.status)) &&
    !['blocker', 'report-only', 'tracking'].includes(String(item.actionability || ''))
  );
}

function collectEvidence(store, { baseline = null, since = null } = {}) {
  const now = Date.now();
  const fourWindowsAgo = now - 60 * 60 * 1000;
  const windowStart = since || fourWindowsAgo;
  const ticks = store
    .listExecutiveActions({ action_type: 'tick', limit: 40 })
    .filter(row => parseDate(row.started_at) >= windowStart)
    .slice(0, 4);
  const snapshot = captureSnapshot(store);
  const readiness = deliveryReadiness.snapshot(store, ROOT, now);
  const eligibleQueuedIds = new Set(readiness.eligibleQueued.map(row => row.request_id));
  const workItems = baseline
    ? [...snapshot.work.values()].filter(item => !baseline.work.has(item.work_id))
    : [...snapshot.work.values()].filter(item => parseDate(item.created_at) >= windowStart);
  const requests = baseline
    ? [...snapshot.requests.values()].filter(item => !baseline.requests.has(item.request_id))
    : [...snapshot.requests.values()].filter(item => parseDate(item.created_at) >= windowStart);
  const newArtifacts = baseline
    ? store
        .listAgentArtifacts({ limit: 1000 })
        .filter(item => !baseline.artifacts.has(item.artifact_id))
    : [];
  const managerDispatches = store.listAgentDispatches({ limit: 2000 }).filter(row => {
    const agent = store.getAgent(row.agent_id);
    return MANAGER_SLUGS.has(agent?.slug) && agent.status === 'active';
  });
  const deliveryFor = request =>
    workEvidence.delivery(
      request,
      request.run_id ? store.getImprovement(request.run_id) || {} : {}
    );
  const verifiedArtifacts = newArtifacts.filter(item => {
    const request = item.metadata?.request_id && store.getChangeRequest(item.metadata.request_id);
    return request && deliveryFor(request).deployed;
  });
  const executableWorkItems = workItems.filter(isExecutableWork);
  const verifiedDeliveries = [...snapshot.requests.values()].filter(row => {
    const prior = baseline?.requests.get(row.request_id);
    return (
      deliveryFor(row).deployed &&
      (baseline ? !prior || prior.status !== row.status : parseDate(row.updated_at) >= windowStart)
    );
  });
  const recentVerifiedDeliveries = store
    .listChangeRequests({ limit: 1000 })
    .filter(
      row =>
        parseDate(row.updated_at) >= windowStart &&
        DELIVERY_MODES.has(row.delivery_mode) &&
        deliveryFor(row).deployed
    );
  const activeDirectRequests = requests.filter(
    row =>
      DELIVERY_MODES.has(row.delivery_mode) &&
      (eligibleQueuedIds.has(row.request_id) ||
        ['claimed', 'running', 'reviewing', 'review', 'delivery_pending'].includes(row.status))
  );
  const reviewRuns = store.listImprovements({ limit: 1000 });
  const deliveryFunnel = {
    review_branches: reviewRuns.filter(run => Boolean(run.approval?.pull_request?.pushed)).length,
    open_prs: reviewRuns.filter(
      run =>
        Number.isInteger(run.approval?.pull_request?.number) &&
        run.approval.pull_request.state === 'open'
    ).length,
    merged_prs: reviewRuns.filter(run => Boolean(run.approval?.pull_request?.merged_at)).length,
    connected_live_releases: reviewRuns.filter(run => run.approval?.release?.status === 'verified')
      .length,
  };
  return {
    window_start: iso(windowStart),
    window_end: iso(now),
    cycles_observed: ticks.length,
    cycles: ticks.map(row => ({
      action_id: row.action_id,
      status: row.status,
      started_at: row.started_at,
      finished_at: row.finished_at,
      error: row.error || null,
      result: row.result || {},
    })),
    delivery_funnel: deliveryFunnel,
    real_work: {
      new_work_items: workItems.length,
      new_executable_work_items: executableWorkItems.length,
      completed_work_items: workItems.filter(row => row.status === 'done').length,
      new_change_requests: requests.length,
      new_direct_change_requests: requests.filter(row => DELIVERY_MODES.has(row.delivery_mode))
        .length,
      new_eligible_direct_change_requests: activeDirectRequests.length,
      new_active_direct_change_requests: activeDirectRequests.length,
      live_direct_change_requests: [...snapshot.requests.values()].filter(
        row =>
          DELIVERY_MODES.has(row.delivery_mode) &&
          ['claimed', 'running', 'reviewing', 'delivery_pending'].includes(row.status)
      ).length,
      eligible_queued_direct_requests: readiness.eligibleQueued.length,
      blocked_queued_direct_requests: readiness.blockedQueued.length,
      stale_eligible_direct_requests: readiness.eligibleQueued.filter(
        row => now - parseDate(row.created_at) >= 30 * 60 * 1000
      ).length,
      recent_verified_deliveries: recentVerifiedDeliveries.length,
      verified_artifacts: verifiedArtifacts.length,
      verified_deliveries: verifiedDeliveries.length,
      blocked_work_items: workItems.filter(row => row.status === 'blocked').length,
      actionable:
        activeDirectRequests.length > 0 ||
        verifiedDeliveries.length > 0 ||
        verifiedArtifacts.length > 0,
    },
    manager_queue: {
      queued: managerDispatches.filter(row => row.status === 'queued').length,
      leased: managerDispatches.filter(row => row.status === 'leased').length,
      failed: managerDispatches.filter(row => row.status === 'failed').length,
      succeeded: managerDispatches.filter(row => row.status === 'succeeded').length,
      oldest_queued_at:
        managerDispatches
          .filter(row => row.status === 'queued')
          .sort((a, b) => parseDate(a.created_at) - parseDate(b.created_at))[0]?.created_at || null,
    },
  };
}

function classifyOutcome({ sandboxCode, modelStatus, before, after, repairs = [] }) {
  const verified =
    after.real_work.verified_deliveries > 0 || after.real_work.verified_artifacts > 0;
  const queued =
    after.real_work.new_eligible_direct_change_requests > 0 ||
    repairs.some(row =>
      [
        'requeued_failed_handoff',
        'requeued_stuck_manager',
        'started_recovery_worker',
        'queued_recovery_handoff',
      ].includes(row.action)
    );
  const recentExecutiveSuccess = before.cycles[0]?.status === 'completed';
  const activeDelivery =
    recentExecutiveSuccess &&
    (before.real_work.new_active_direct_change_requests > 0 ||
      before.real_work.recent_verified_deliveries > 0);
  if (repairs.some(row => row.action === 'recovery_pickup_failed'))
    return { status: 'failed', deliveryStatus: 'recovery_handoff_failed', verified, queued };
  if (sandboxCode !== 0 || modelStatus !== 'succeeded')
    return { status: 'failed', deliveryStatus: 'runner_failed', verified, queued };
  if (verified)
    return { status: 'succeeded', deliveryStatus: 'verified_delivery', verified, queued };
  if (before.real_work.stale_eligible_direct_requests > 0)
    return { status: 'failed', deliveryStatus: 'eligible_queue_stalled', verified, queued };
  if (queued) return { status: 'succeeded', deliveryStatus: 'handoff_pending', verified, queued };
  if (activeDelivery)
    return { status: 'succeeded', deliveryStatus: 'observing_active_delivery', verified, queued };
  return { status: 'failed', deliveryStatus: 'failed_to_deliver', verified, queued };
}

function hasExecutableHandoff(store, task) {
  return workEvidence
    .linkedRequests(store, task)
    .some(request => !['failed', 'cancelled'].includes(request.status));
}

function admitRecovery(store, agent, workId) {
  const task = store.getExecutiveWorkItem(workId) || { work_id: workId, summary: '' };
  const fingerprint = workEvidence.fingerprint(store, task);
  const current = store.getAgent(agent.agent_id);
  const history = current.workspace?.overwatch_recovery || {};
  if (history[workId]?.fingerprint === fingerprint) return false;
  store.updateAgent(agent.agent_id, {
    workspace: {
      ...current.workspace,
      overwatch_recovery: {
        ...history,
        [workId]: { fingerprint, attempted_at: new Date().toISOString(), status: 'attempted' },
      },
    },
  });
  return true;
}

function reconcileRecoveryResults(store) {
  const recovered = [];
  for (const agent of store
    .listAgents({ limit: 1000 })
    .filter(row => MANAGER_SLUGS.has(row.slug) || row.slug === AGENT_SLUG)) {
    const history = { ...(agent.workspace?.overwatch_recovery || {}) };
    let changed = false;
    for (const [workId, entry] of Object.entries(history)) {
      if (entry.status === 'verified') continue;
      const task = store.getExecutiveWorkItem(workId);
      if (!task) continue;
      const requests = workEvidence.linkedRequests(store, task).filter(request => {
        const run = request.run_id && store.getImprovement(request.run_id);
        return (
          run &&
          (!entry.request_ids || entry.request_ids.includes(request.request_id)) &&
          workEvidence.delivery(request, run).deployed &&
          parseDate(run.outcome.deployment_verified_at) >= parseDate(entry.attempted_at)
        );
      });
      if (!requests.length) continue;
      history[workId] = {
        ...entry,
        status: 'verified',
        verified_at: new Date().toISOString(),
        request_ids: requests.map(row => row.request_id),
      };
      if (workId.startsWith('queued-delivery:'))
        store.updateExecutiveWorkItem(workId, {
          status: 'done',
          waiting_on: null,
          next_action:
            'Original reviewed backlog reached verified connected release; retain request and initiating run receipts.',
        });
      recovered.push({
        work_id: workId,
        request_ids: history[workId].request_ids,
        initiating_run_id: entry.initiating_run_id || null,
      });
      changed = true;
    }
    if (changed)
      store.updateAgent(agent.agent_id, {
        workspace: { ...agent.workspace, overwatch_recovery: history },
      });
  }
  return recovered;
}

// Reconcile a verified successor without rewriting the original failed attempt.
// This receipt is supervision work, not credit for initiating the recovery.
function reconcileDeliveryRecoveries(store) {
  const reconciled = [];
  for (const task of store.listExecutiveWorkItems({ limit: 1000 })) {
    if (
      !task.work_id.startsWith('delivery-recovery:') ||
      ['done', 'cancelled'].includes(task.status)
    )
      continue;
    const originalId = task.source_id || task.work_id.slice('delivery-recovery:'.length);
    const original = store.getChangeRequest(originalId);
    if (!original || original.status !== 'failed') continue;
    const successor = workEvidence.linkedRequests(store, task).find(request => {
      if (request.request_id === originalId || request.site !== original.site) return false;
      const run = request.run_id && store.getImprovement(request.run_id);
      return (
        run &&
        workEvidence.delivery(request, run).deployed &&
        parseDate(run.outcome.deployment_verified_at) >= parseDate(task.created_at)
      );
    });
    if (!successor) continue;
    const run = store.getImprovement(successor.run_id);
    const receipt = {
      work_id: task.work_id,
      original_request_id: originalId,
      successor_request_id: successor.request_id,
      commit: run.approval.release.merge_sha || run.validation.commit,
      build_id: run.approval.release.build_id,
      initiated_by: successor.requested_by || null,
    };
    store.updateExecutiveWorkItem(task.work_id, {
      status: 'done',
      waiting_on: null,
      next_action:
        'Verified linked successor repaired delivery; original failed attempt remains recorded.',
      evidence: [
        ...(task.evidence || []),
        {
          type: 'test',
          label: 'Verified linked successor release',
          detail: JSON.stringify(receipt),
        },
      ],
    });
    store.record({
      event_type: 'overwatch.delivery_recovery_reconciled',
      source: 'exec-overwatch',
      entity_type: 'executive-work-item',
      entity_id: task.work_id,
      payload: receipt,
    });
    reconciled.push(receipt);
  }
  return reconciled;
}

function stoppedFingerprint(store) {
  const tasks = store
    .listExecutiveWorkItems({ quiet: 0, limit: 1000 })
    .filter(
      task =>
        (task.source_type === 'operating-task' ||
          task.work_id.startsWith('delivery-recovery:') ||
          task.work_id.startsWith('queued-delivery:')) &&
        !['done', 'cancelled'].includes(task.status)
    );
  const requests = store
    .listChangeRequests({ limit: 1000 })
    .filter(row =>
      ['failed', 'blocked_infrastructure', 'blocked_owner', 'needs_human_review'].includes(
        row.status
      )
    );
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        recovery_policy_revision: deliveryRecovery.policyRevision,
        tasks: tasks.map(task => [task.work_id, workEvidence.fingerprint(store, task)]).sort(),
        requests: requests
          .map(row => [row.request_id, row.status, row.error, row.gate_clearance_revision])
          .sort(),
      })
    )
    .digest('hex');
}

function repairStuckManagerTasks(store, { max = 2, staleMs = 30 * 60 * 1000 } = {}) {
  const repaired = [];
  const cutoff = Date.now() - staleMs;
  const tasks = store
    .listExecutiveWorkItems({ source_type: 'operating-task', limit: 1000, quiet: 0 })
    .filter(
      task =>
        task.status === 'in_progress' &&
        (task.waiting_on === 'downstream-queue' ||
          /no executable work product/i.test(task.last_error || '')) &&
        parseDate(task.updated_at) <= cutoff &&
        !hasExecutableHandoff(store, task)
    )
    .sort((a, b) => parseDate(a.updated_at) - parseDate(b.updated_at));
  for (const task of tasks.slice(0, max)) {
    const agentSlug = MANAGER_AGENT_BY_OWNER.get(task.owner);
    const agent = agentSlug ? store.getAgent(agentSlug) : null;
    if (!agent || agent.status !== 'active') continue;
    if (!admitRecovery(store, agent, task.work_id)) continue;
    const retryCount = (task.labels || []).filter(label =>
      String(label).startsWith('overwatch-retry-')
    ).length;
    if (retryCount >= 2) {
      store.updateExecutiveWorkItem(task.work_id, {
        status: 'blocked',
        waiting_on: task.owner,
        last_error:
          'Manager produced no executable downstream handoff after two Overwatch repairs.',
        next_action: `Escalate ${task.owner} performance; produce a concrete change request or explain the evidence-backed blocker with an owner and deadline.`,
        labels: [...(task.labels || []), 'overwatch-escalated'],
      });
      repaired.push({ work_id: task.work_id, action: 'escalated_after_retries' });
      continue;
    }
    const attempt = retryCount + 1;
    try {
      const started = runtime.beginRun(store, {
        agent_id: agent.agent_id,
        work_id: task.work_id,
        idempotency_key: `overwatch-repair:${task.work_id}:${attempt}`,
      });
      const dispatch = store.getAgentDispatch(started.run.run_id);
      store.updateExecutiveWorkItem(task.work_id, {
        status: 'in_progress',
        waiting_on: task.owner,
        attempts: Number(task.attempts || 0) + 1,
        last_error: null,
        next_action: `Overwatch repair ${attempt}/2 queued dispatch ${dispatch.dispatch_id}; manager must create an executable change request or explicit blocker.`,
        labels: [...(task.labels || []), `overwatch-retry-${attempt}`],
      });
      repaired.push({
        work_id: task.work_id,
        action: 'requeued_stuck_manager',
        attempt,
        dispatch_id: dispatch.dispatch_id,
      });
    } catch (error) {
      store.updateExecutiveWorkItem(task.work_id, {
        status: 'blocked',
        waiting_on: 'system',
        last_error: error.message,
        next_action: `Repair failed manager redispatch for ${task.owner}, then retry this task.`,
      });
      repaired.push({ work_id: task.work_id, action: 'repair_failed', error: error.message });
    }
  }
  return repaired;
}

function repairHandoffs(store) {
  const repaired = [];
  const now = Date.now();
  for (const dispatch of store.listAgentDispatches({ status: 'failed', limit: 2000 })) {
    const agent = store.getAgent(dispatch.agent_id);
    if (
      !agent ||
      agent.status !== 'active' ||
      !MANAGER_SLUGS.has(agent.slug) ||
      Number(dispatch.attempts || 0) >= 5
    )
      continue;
    if (
      !admitRecovery(store, agent, store.getAgentRun(dispatch.run_id)?.work_id || dispatch.run_id)
    )
      continue;
    store.completeAgentDispatch(dispatch.dispatch_id, {
      status: 'queued',
      error: `Exec Overwatch requeued failed ${agent.slug} handoff for supervised retry`,
      available_at: new Date(now + 60 * 1000).toISOString(),
    });
    repaired.push({
      dispatch_id: dispatch.dispatch_id,
      work_id: store.getAgentRun(dispatch.run_id)?.work_id || null,
      agent: agent.slug,
      action: 'requeued_failed_handoff',
      attempts: dispatch.attempts,
    });
  }
  return repaired;
}

function runSandbox(taskFile, runId) {
  return new Promise(resolve => {
    const env = {
      ...process.env,
      FD_DOMAINS_ROOT: ROOT,
      EXECUTIVE_SCOPE: 'overwatch',
      EXECUTIVE_ALLOW_QUEUE: '1',
      EXECUTIVE_PASSES: 'reviewer',
      EXECUTIVE_LOCK_FILE: path.join(ROOT, 'tools', 'executive', 'data', 'overwatch.lock'),
      EXECUTIVE_RUNTIME_RUN_ID: runId,
      EXECUTIVE_RUNTIME_AGENT_SLUG: AGENT_SLUG,
      EXECUTIVE_RUN_ID: `overwatch:${runId}`,
      EXECUTIVE_CONTAINER_NAME: `exec-overwatch-${process.pid}`,
      EXECUTIVE_OVERWATCH_TASK_FILE: taskFile,
    };
    const child = spawn('bash', [path.join(ROOT, 'tools', 'executive', 'run-sandbox.sh')], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(String(chunk)));
    child.stderr.on('data', chunk => chunks.push(String(chunk)));
    child.on('close', code => resolve({ code: code ?? 1, output: chunks.join('').slice(-20000) }));
    child.on('error', error => resolve({ code: 1, output: error.message }));
  });
}

async function main() {
  const store = eventstore.open(ROOT);
  runtime.ensureRegistry(store);
  const agent = store.getAgent(AGENT_SLUG);
  const routine = store
    .listAgentRoutines({ agent_id: agent.agent_id, limit: 20 })
    .find(row => row.routine_id === 'routine:exec-overwatch-hourly');
  if (agent.status !== 'active' || routine?.status !== 'active') {
    store.close();
    return { skipped: true, reason: 'overwatch is paused or disabled' };
  }
  const reconciledDeliveries = reconcileDeliveryRecoveries(store);
  const recovered = reconcileRecoveryResults(store);
  deliveryRecovery.ensureQueuedCases(store, { site: process.env.EXECUTIVE_DOMAIN || null });
  const stopFingerprint = stoppedFingerprint(store);
  const preflight = collectEvidence(store);
  const recoveryCases = deliveryRecovery.readyCases(store, {
    site: process.env.EXECUTIVE_DOMAIN || null,
    agent,
  });
  const live =
    preflight.real_work.live_direct_change_requests > 0 ||
    preflight.manager_queue.queued > 0 ||
    preflight.manager_queue.leased > 0;
  const stoppedTask = store
    .listExecutiveWorkItems({ source_type: 'operating-task', quiet: 0, limit: 1000 })
    .some(
      task =>
        !['done', 'cancelled'].includes(task.status) &&
        !hasExecutableHandoff(store, task) &&
        (task.status === 'blocked' ||
          /no executable work product/i.test(task.last_error || '') ||
          task.waiting_on === 'downstream-queue')
    );
  if (
    (live && !stoppedTask && !recoveryCases.length) ||
    agent.workspace?.overwatch_last_fingerprint === stopFingerprint
  ) {
    if (recovered.length)
      store.createAgentEval({
        agent_id: agent.agent_id,
        evaluator: 'exec-overwatch-deterministic',
        dimension: 'verified-recovery',
        score: 100,
        feedback: 'Previously repaired tasks reached a confirmed release.',
        evidence: recovered,
      });
    if (routine)
      store.touchAgentRoutine(routine.routine_id, {
        last_run_at: new Date().toISOString(),
        next_due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    store.close();
    return {
      skipped: true,
      reason: live ? 'execution already has a live path' : 'stopped work is unchanged',
      delivery_recovery_cases: recoveryCases,
      verified_recoveries: recovered,
      reconciled_delivery_cases: reconciledDeliveries,
    };
  }
  const runId = crypto.randomUUID();
  const auditStartedAt = Date.now();
  const started = runtime.beginRun(store, {
    agent_id: agent.agent_id,
    work_id: `exec-overwatch-cycle:${runId}`,
    idempotency_key: `exec-overwatch:${runId}`,
    provider: agent.provider,
    model: agent.model,
  });
  const baseline = captureSnapshot(store);
  const evidence = collectEvidence(store, { since: auditStartedAt - 60 * 60 * 1000 });
  const repairs = [...repairHandoffs(store), ...repairStuckManagerTasks(store)];
  const taskFile = path.join(ROOT, 'tools', 'executive', 'data', `.overwatch-task-${runId}.json`);
  const reportPath = path.join(
    ROOT,
    'tools',
    'executive',
    'data',
    'reports',
    'overwatch',
    `${runId}.json`
  );
  const task = {
    agent: AGENT_SLUG,
    role: ROLE,
    run_id: started.run.run_id,
    directive: agent.workspace?.overwatch || {},
    evidence,
    repairs,
    stop_fingerprint: stopFingerprint,
    delivery_recovery_cases: recoveryCases,
    verified_recoveries: recovered,
    reconciled_delivery_cases: reconciledDeliveries,
    required_output: [
      'Repair evidence-backed stuck or failed handoffs.',
      'Create or materially advance at least one bounded improvement when safe evidence supports it.',
      'If blocked, name the exact blocker, owner, and next action; never call an unchanged update progress.',
    ],
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), { mode: 0o600 });
  let sandbox;
  try {
    sandbox = await runSandbox(taskFile, started.run.run_id);
  } finally {
    try {
      fs.unlinkSync(taskFile);
    } catch {}
  }
  repairs.push(
    ...(await deliveryRecovery.trackHandoffs(store, agent, baseline, {
      root: ROOT,
      cases: recoveryCases,
      initiatingRunId: started.run.run_id,
    }))
  );
  const finalEvidence = collectEvidence(store, { baseline, since: auditStartedAt });
  const completed = store.getAgentRun(started.run.run_id);
  const outcome = classifyOutcome({
    sandboxCode: sandbox.code,
    modelStatus: completed?.status,
    before: evidence,
    after: finalEvidence,
    repairs,
  });
  const { verified, queued, deliveryStatus } = outcome;
  const deliveryError =
    deliveryStatus === 'runner_failed'
      ? `Overwatch isolated model failed with status ${sandbox.code}.`
      : deliveryStatus === 'failed_to_deliver'
        ? 'Overwatch found no recent executable delivery, active handoff, or repair.'
        : null;
  const report = {
    generated_at: new Date().toISOString(),
    agent: AGENT_SLUG,
    run_id: started.run.run_id,
    sandbox_status: sandbox.code,
    monitor_status: outcome.status,
    delivery_status: deliveryStatus,
    delivery_error: deliveryError,
    repairs,
    delivery_recovery_cases: recoveryCases,
    verified_recoveries: recovered,
    reconciled_delivery_cases: reconciledDeliveries,
    stop_fingerprint: stopFingerprint,
    before: evidence,
    after: finalEvidence,
    real_work_delta: finalEvidence.real_work,
    output: sandbox.output,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  if (completed) {
    store.updateAgentRun(started.run.run_id, {
      status: outcome.status,
      error: deliveryError,
      result: { ...(completed.result || {}), overwatch_report: reportPath, repairs },
    });
    if (recovered.length > 0 || outcome.status === 'failed') {
      runtime.recordAccountabilityOutcome(store, completed, {
        delivered: recovered.length > 0,
        reason: report.delivery_error,
      });
    }
    if (outcome.status === 'failed') {
      store.completeAgentDispatchForRun(started.run.run_id, 'failed', deliveryError);
    }
    store.createAgentArtifact({
      run_id: started.run.run_id,
      agent_id: agent.agent_id,
      kind: 'report',
      label: `Exec Overwatch hourly synopsis (${repairs.length} repairs)`,
      uri: reportPath,
      metadata: {
        sandbox_status: sandbox.code,
        repairs: repairs.length,
        real_work_delta: report.real_work_delta,
        actionable: finalEvidence.real_work.actionable,
        verified,
        queued,
        monitor_status: outcome.status,
        delivery_status: deliveryStatus,
      },
    });
    store.createAgentEval({
      agent_id: agent.agent_id,
      run_id: started.run.run_id,
      evaluator: 'exec-overwatch-deterministic',
      dimension: 'real-work-output',
      score: recovered.length ? 100 : 0,
      feedback: recovered.length
        ? 'Previously repaired original tasks reached a confirmed release.'
        : queued
          ? 'Created a downstream handoff; no verified delivery yet.'
          : deliveryStatus === 'observing_active_delivery'
            ? 'Monitor completed while recent executive delivery or active direct handoff was observed; no new Overwatch delivery claimed.'
            : 'Run failed to observe executable work or repair stuck handoffs.',
      evidence: report.real_work_delta,
    });
  }
  if (routine) {
    store.touchAgentRoutine(routine.routine_id, {
      status: 'active',
      last_run_at: new Date().toISOString(),
      next_due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
  }
  const currentAgent = store.getAgent(agent.agent_id);
  store.updateAgent(agent.agent_id, {
    workspace: { ...currentAgent.workspace, overwatch_last_fingerprint: stopFingerprint },
  });
  report.alert = await alertConsecutiveFailures(store, {
    agent,
    runId: started.run.run_id,
    root: ROOT,
    report,
  });
  const executiveAgent = store.getAgent('fleet-ceo');
  const latestExecutiveRun = executiveAgent
    ? store.listAgentRuns({ agent_id: executiveAgent.agent_id, limit: 1 })[0]
    : null;
  report.executive_alert = latestExecutiveRun
    ? await alertConsecutiveFailures(store, {
        agent: executiveAgent,
        runId: latestExecutiveRun.run_id,
        root: ROOT,
        report: { delivery_error: latestExecutiveRun.error },
        label: 'Executive team',
        resultKey: 'executive_failure_alert',
        notificationType: 'executive-run-failure',
      })
    : { attempted: false, reason: 'executive agent unavailable' };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  store.close();
  return report;
}

if (require.main === module) {
  main()
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}

module.exports = {
  captureSnapshot,
  collectEvidence,
  classifyOutcome,
  repairHandoffs,
  repairStuckManagerTasks,
  stoppedFingerprint,
  admitRecovery,
  reconcileRecoveryResults,
  reconcileDeliveryRecoveries,
  main,
};
