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
  const managerDispatches = store
    .listAgentDispatches({ limit: 2000 })
    .filter(row => MANAGER_SLUGS.has(store.getAgent(row.agent_id)?.slug));
  const verifiedArtifacts = newArtifacts.filter(
    item => String(item.kind) === 'deployment' && item.metadata?.verified === true
  );
  const executableWorkItems = workItems.filter(isExecutableWork);
  const verifiedDeliveries = requests.filter(
    row =>
      DELIVERY_MODES.has(row.delivery_mode) &&
      (row.status === 'deployed' ||
        (row.status === 'committed' && row.delivery_mode === 'pull_request'))
  );
  const recentVerifiedDeliveries = store
    .listChangeRequests({ limit: 1000 })
    .filter(
      row =>
        parseDate(row.updated_at) >= windowStart &&
        DELIVERY_MODES.has(row.delivery_mode) &&
        ['deployed', 'verified'].includes(row.status)
    );
  const activeDirectRequests = requests.filter(
    row =>
      DELIVERY_MODES.has(row.delivery_mode) &&
      !['failed', 'blocked_infrastructure', 'blocked_owner', 'cancelled'].includes(row.status)
  );
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
    real_work: {
      new_work_items: workItems.length,
      new_executable_work_items: executableWorkItems.length,
      completed_work_items: workItems.filter(row => row.status === 'done').length,
      new_change_requests: requests.length,
      new_direct_change_requests: requests.filter(row => DELIVERY_MODES.has(row.delivery_mode))
        .length,
      new_active_direct_change_requests: activeDirectRequests.length,
      recent_verified_deliveries: recentVerifiedDeliveries.length,
      verified_artifacts: verifiedArtifacts.length,
      verified_deliveries: verifiedDeliveries.length,
      blocked_work_items: workItems.filter(row => row.status === 'blocked').length,
      actionable:
        requests.some(row => DELIVERY_MODES.has(row.delivery_mode)) ||
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
    after.real_work.new_direct_change_requests > 0 ||
    repairs.some(row => ['requeued_failed_handoff', 'requeued_stuck_manager'].includes(row.action));
  const recentExecutiveSuccess = before.cycles[0]?.status === 'completed';
  const activeDelivery =
    recentExecutiveSuccess &&
    (before.real_work.new_active_direct_change_requests > 0 ||
      before.real_work.recent_verified_deliveries > 0);
  if (sandboxCode !== 0 || modelStatus !== 'succeeded')
    return { status: 'failed', deliveryStatus: 'runner_failed', verified, queued };
  if (verified)
    return { status: 'succeeded', deliveryStatus: 'verified_delivery', verified, queued };
  if (queued) return { status: 'succeeded', deliveryStatus: 'handoff_pending', verified, queued };
  if (activeDelivery)
    return { status: 'succeeded', deliveryStatus: 'observing_active_delivery', verified, queued };
  return { status: 'failed', deliveryStatus: 'failed_to_deliver', verified, queued };
}

function hasExecutableHandoff(store, task) {
  const links = store.listWorkflowLinks({ entity_type: 'work-item', entity_id: task.work_id });
  if (links.some(link => link.to_type === 'request' || link.from_type === 'request')) return true;
  return store
    .listChangeRequests({ limit: 1000 })
    .some(request =>
      [request.source_work_id, request.source_work_item_id, request.work_id].includes(task.work_id)
    );
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
    store.completeAgentDispatch(dispatch.dispatch_id, {
      status: 'queued',
      error: `Exec Overwatch requeued failed ${agent.slug} handoff for supervised retry`,
      available_at: new Date(now + 60 * 1000).toISOString(),
    });
    repaired.push({
      dispatch_id: dispatch.dispatch_id,
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
    runtime.recordAccountabilityOutcome(store, completed, {
      delivered: verified,
      reason: report.delivery_error,
    });
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
      score: verified ? 100 : queued ? 20 : deliveryStatus === 'observing_active_delivery' ? 10 : 0,
      feedback: verified
        ? 'Verified a delivered request, completed work item, or implementation artifact in this run.'
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
  main,
};
