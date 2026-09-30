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

function iso(value) {
  return new Date(value).toISOString();
}

function parseDate(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function collectEvidence(store) {
  const now = Date.now();
  const fourWindowsAgo = now - 60 * 60 * 1000;
  const ticks = store
    .listExecutiveActions({ action_type: 'tick', limit: 40 })
    .filter(row => parseDate(row.started_at) >= fourWindowsAgo)
    .slice(0, 4);
  const since = ticks.length
    ? Math.min(...ticks.map(row => parseDate(row.started_at)).filter(Boolean))
    : fourWindowsAgo;
  const workItems = store
    .listExecutiveWorkItems({ limit: 2000, quiet: 0 })
    .filter(row => parseDate(row.created_at) >= since);
  const requests = store
    .listChangeRequests({ limit: 2000 })
    .filter(row => parseDate(row.created_at) >= since);
  const managerDispatches = store
    .listAgentDispatches({ limit: 2000 })
    .filter(row => MANAGER_SLUGS.has(store.getAgent(row.agent_id)?.slug));
  const completedWork = workItems.filter(row =>
    ['done', 'completed', 'verified', 'deployed', 'committed'].includes(String(row.status))
  );
  const realRequests = requests.filter(row =>
    ['queued', 'in_progress', 'committed', 'deployed', 'verified', 'completed'].includes(
      String(row.status)
    )
  );
  return {
    window_start: iso(since),
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
      completed_work_items: completedWork.length,
      new_change_requests: realRequests.length,
      blocked_work_items: workItems.filter(row => row.status === 'blocked').length,
      actionable: completedWork.length > 0 || realRequests.length > 0,
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

function repairHandoffs(store) {
  const repaired = [];
  const now = Date.now();
  for (const dispatch of store.listAgentDispatches({ status: 'failed', limit: 2000 })) {
    const agent = store.getAgent(dispatch.agent_id);
    if (!agent || !MANAGER_SLUGS.has(agent.slug) || Number(dispatch.attempts || 0) >= 5) continue;
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
  const started = runtime.beginRun(store, {
    agent_id: agent.agent_id,
    work_id: `exec-overwatch-cycle:${runId}`,
    idempotency_key: `exec-overwatch:${new Date().toISOString().slice(0, 13)}`,
    provider: agent.provider,
    model: agent.model,
  });
  const evidence = collectEvidence(store);
  const repairs = repairHandoffs(store);
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
  const finalEvidence = collectEvidence(store);
  const report = {
    generated_at: new Date().toISOString(),
    agent: AGENT_SLUG,
    run_id: started.run.run_id,
    sandbox_status: sandbox.code,
    repairs,
    before: evidence,
    after: finalEvidence,
    real_work_delta: {
      new_work_items: finalEvidence.real_work.new_work_items - evidence.real_work.new_work_items,
      new_change_requests:
        finalEvidence.real_work.new_change_requests - evidence.real_work.new_change_requests,
    },
    output: sandbox.output,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  const completed = store.getAgentRun(started.run.run_id);
  if (completed) {
    store.updateAgentRun(started.run.run_id, {
      result: { ...(completed.result || {}), overwatch_report: reportPath, repairs },
    });
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
      },
    });
    store.createAgentEval({
      agent_id: agent.agent_id,
      run_id: started.run.run_id,
      evaluator: 'exec-overwatch-deterministic',
      dimension: 'real-work-output',
      score: finalEvidence.real_work.actionable ? 100 : repairs.length ? 60 : 0,
      feedback: finalEvidence.real_work.actionable
        ? 'Verified new downstream work or completed work in the audit window.'
        : repairs.length
          ? 'No verified new work yet; repaired at least one failed handoff.'
          : 'No verified work product and no repair was available.',
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

module.exports = { collectEvidence, repairHandoffs, main };
