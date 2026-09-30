'use strict';

// Bounded consumer for the operating-layer queue. The dashboard owns durable
// identity and leases; this worker owns only the allowlisted handoff into an
// existing host-side queue. It deliberately does not shell out from the
// dashboard process or claim that a site is complete before the host runner
// produces its result.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const eventstore = require('../fleet-dashboard/server/eventstore');
const dispatcher = require('./agent-dispatcher');
const domains = require('../fleet-dashboard/server/domains');
const executive = require('../fleet-dashboard/server/executive');

const DOMAIN_RE = /\b([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)\b/gi;
const IGNORED_DOMAINS = new Set(['github.com', 'example.com', 'localhost']);
const MANAGER_ROLES = [
  { owner: 'site-factory-manager', slug: 'fleet-site-factory-manager', promptRole: 'site-factory' },
  { owner: 'operations-manager', slug: 'fleet-operations-manager', promptRole: 'delivery-lead' },
  { owner: 'engineering-manager', slug: 'fleet-engineering-manager', promptRole: 'cto' },
  { owner: 'growth-manager', slug: 'fleet-growth-manager', promptRole: 'growth-director' },
  { owner: 'design-manager', slug: 'fleet-design-manager', promptRole: 'design-director' },
];
const MANAGER_BY_AGENT = new Map(MANAGER_ROLES.map(role => [role.slug, role]));
const EXECUTABLE_WORK_KINDS = new Set([
  'implementation',
  'content',
  'design',
  'engineering',
  'seo',
]);

function isExecutableWork(item) {
  return (
    EXECUTABLE_WORK_KINDS.has(String(item.kind)) &&
    Boolean(item.site) &&
    !['blocked', 'waiting', 'cancelled', 'done'].includes(String(item.status)) &&
    !['blocker', 'report-only', 'tracking'].includes(String(item.actionability || ''))
  );
}

function extractDomain(summary = '') {
  for (const match of String(summary).matchAll(DOMAIN_RE)) {
    const domain = match[1].toLowerCase();
    if (!IGNORED_DOMAINS.has(domain)) return domain;
  }
  return null;
}

function isSiteFactory(run, task) {
  return run?.agent_id === 'fleet-site-factory-manager' || task?.owner === 'site-factory-manager';
}

function runSandbox(root, role, task) {
  const taskFile = path.join(
    root,
    'tools',
    'executive',
    'data',
    `.operating-task-${process.pid}.json`
  );
  fs.writeFileSync(
    taskFile,
    JSON.stringify({
      work_id: task.work_id,
      title: task.title,
      summary: task.summary,
      site: task.site || null,
      next_action: task.next_action,
      owner: task.owner,
      attempts: task.attempts || 0,
      labels: task.labels || [],
      last_error: task.last_error || null,
    }),
    { mode: 0o600 }
  );
  return new Promise(resolve => {
    const child = spawn('bash', [path.join(root, 'tools', 'executive', 'run-sandbox.sh')], {
      cwd: root,
      env: {
        ...process.env,
        EXECUTIVE_PASSES: role.promptRole,
        EXECUTIVE_ALLOW_QUEUE: '1',
        EXECUTIVE_SCOPE: 'operating-manager',
        EXECUTIVE_OPERATING_TASK_FILE: taskFile,
        EXECUTIVE_RUN_ID: `operating-${task.work_id}-${Date.now()}`,
        EXECUTIVE_CONTAINER_NAME: `executive-operating-${process.pid}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
    });
    child.stderr.on('data', chunk => {
      output += chunk;
    });
    child.on('close', code => {
      try {
        fs.unlinkSync(taskFile);
      } catch {}
      resolve({ code: code ?? 1, output: output.slice(-12000) });
    });
    child.on('error', error => {
      try {
        fs.unlinkSync(taskFile);
      } catch {}
      resolve({ code: 1, output: error.message });
    });
  });
}

function enqueueSiteFactory(root, task) {
  const domain = task.site || extractDomain(task.summary);
  if (!domain) throw new Error('site-factory task has no valid target domain');
  const exists = fs.existsSync(path.join(root, 'sites', domain));
  const existing = domains
    .listJobs(root)
    .find(job => job.domain === domain && ['queued', 'running'].includes(job.status));
  if (existing) {
    return {
      lane: 'site-factory',
      domain,
      job_id: existing.id,
      command: existing.command,
      spool_path: domains.spoolDir(root),
      status: existing.status,
      reused: true,
    };
  }
  const job = domains.enqueue(root, {
    command: exists ? 'repair' : 'add',
    domain,
    flags: exists ? ['--plan', '--no-deploy', '--no-bind'] : ['--full'],
  });
  return {
    lane: 'site-factory',
    domain,
    job_id: job.id,
    command: job.command,
    spool_path: domains.spoolDir(root),
    status: job.status,
  };
}

function reconcileSiteFactory(store, root) {
  const results = [];
  const tasks = store
    .listExecutiveWorkItems({ source_type: 'operating-task', limit: 1000 })
    .filter(
      task =>
        task.owner === 'site-factory-manager' && ['in_progress', 'blocked'].includes(task.status)
    );
  for (const task of tasks) {
    const domain = task.site || extractDomain(task.summary);
    if (!domain) continue;
    const job = domains
      .listJobs(root)
      .filter(item => item.domain === domain && ['done', 'failed'].includes(item.status))
      .sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''))[0];
    if (!job) continue;
    const evidence = [
      ...(Array.isArray(task.evidence) ? task.evidence : []),
      {
        type: 'artifact',
        label: `Domain onboarding job ${job.id} ${job.status}`,
        uri: path.join(domains.spoolDir(root), `${job.id}.json`),
        note: `The host-side domain-job-runner recorded ${job.status} for ${job.command} ${domain}.`,
      },
    ];
    if (job.status === 'done') {
      const updated = store.updateExecutiveWorkItem(task.work_id, {
        status: 'done',
        waiting_on: null,
        next_action: `Verify the live ${domain} site and continue the requested content, design, SEO, and role setup work.`,
        outcome: `Host onboarding completed successfully for ${domain}; job ${job.id} passed its smoke test.`,
        evidence,
      });
      let parent = null;
      if (task.parent_work_id) {
        try {
          parent = executive.transitionOwnerRequest(store, task.parent_work_id, 'closed', {
            outcome: `Site Factory completed onboarding for ${domain}; job ${job.id} passed its smoke test.`,
          });
        } catch (error) {
          parent = { error: error.message };
        }
      }
      results.push({
        work_id: task.work_id,
        domain,
        job_id: job.id,
        status: 'done',
        updated,
        parent,
      });
    } else {
      const updated = store.updateExecutiveWorkItem(task.work_id, {
        status: 'blocked',
        waiting_on: 'domain-job-runner',
        next_action: `Repair the failed host onboarding job ${job.id} for ${domain}, then rerun the Site Factory handoff.`,
        last_error: job.error || `domain onboarding job ${job.id} failed`,
        evidence,
      });
      results.push({ work_id: task.work_id, domain, job_id: job.id, status: 'failed', updated });
    }
  }
  return results;
}

async function processSiteFactory(
  store,
  root,
  { workerId = `operating-worker:${process.pid}` } = {}
) {
  const agent = store.getAgent('fleet-site-factory-manager');
  if (!agent) throw new Error('site-factory operating agent is not provisioned');
  return dispatcher.processOne(store, {
    workerId,
    claimOptions: { agent_id: agent.agent_id, adapter: 'codex' },
    adapters: {
      codex: async ({ store: currentStore, run, dispatch }) => {
        const task = currentStore.getExecutiveWorkItem(run.work_id);
        if (!isSiteFactory(run, task))
          throw new Error(
            `no execution adapter is configured for operating role ${task?.owner || 'unknown'}`
          );
        const result = enqueueSiteFactory(root, task);
        currentStore.createAgentArtifact({
          run_id: run.run_id,
          work_id: task.work_id,
          agent_id: run.agent_id,
          kind: 'report',
          label: `Site Factory job queued for ${result.domain}`,
          uri: path.join(result.spool_path, `${result.job_id}.json`),
          metadata: result,
        });
        currentStore.updateExecutiveWorkItem(task.work_id, {
          status: 'in_progress',
          next_action: `Host domain-job-runner must complete ${result.command} for ${result.domain}; then attach preview/build evidence.`,
          waiting_on: 'domain-job-runner',
          evidence: [
            {
              type: 'artifact',
              label: `Domain onboarding job ${result.job_id}`,
              uri: path.join(result.spool_path, `${result.job_id}.json`),
              note: `The request entered the existing host-side ${result.command} queue.`,
            },
          ],
        });
        return result;
      },
    },
  });
}

async function processOperatingManager(
  store,
  root,
  role,
  { workerId = `operating-worker:${process.pid}` } = {}
) {
  const agent = store.getAgent(role.slug);
  if (!agent) throw new Error(`${role.slug} operating agent is not provisioned`);
  return dispatcher.processOne(store, {
    workerId,
    claimOptions: { agent_id: agent.agent_id, adapter: 'codex' },
    adapters: {
      codex: async ({ store: currentStore, run }) => {
        const task = currentStore.getExecutiveWorkItem(run.work_id);
        if (!task || task.owner !== role.owner)
          throw new Error(`dispatch task is not owned by ${role.owner}`);
        const beforeChangeRequests = new Set(
          currentStore.listChangeRequests({ limit: 2000 }).map(item => item.request_id)
        );
        const beforeWorkItems = new Set(
          currentStore.listExecutiveWorkItems({ limit: 2000 }).map(item => item.work_id)
        );
        const sandbox = await runSandbox(root, role, task);
        if (sandbox.code === 75) {
          const error = new Error('executive sandbox is busy; manager dispatch deferred');
          error.defer = true;
          throw error;
        }
        const changeRequests = currentStore
          .listChangeRequests({ limit: 2000 })
          .filter(item => !beforeChangeRequests.has(item.request_id));
        const workItems = currentStore
          .listExecutiveWorkItems({ limit: 2000 })
          .filter(item => !beforeWorkItems.has(item.work_id) && item.work_id !== task.work_id);
        const executableWorkItems = workItems.filter(isExecutableWork);
        const actionable =
          sandbox.code === 0 && (changeRequests.length > 0 || executableWorkItems.length > 0);
        const result = {
          lane: role.owner,
          task_id: task.work_id,
          sandbox_status: sandbox.code,
          change_requests: changeRequests.length,
          work_items: workItems.length,
          executable_work_items: executableWorkItems.length,
          created_work_item_ids: workItems.map(item => item.work_id),
          change_request_ids: changeRequests.map(item => item.request_id),
          actionable,
          delivery_status: actionable ? 'delivered_to_downstream' : 'failed_to_deliver',
          delivery_error: actionable
            ? null
            : `${role.owner} completed a sandbox run without an executable change request or work item`,
        };
        const reportPath = path.join(
          root,
          'tools',
          'executive',
          'data',
          'reports',
          `${task.work_id.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`
        );
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(
          reportPath,
          JSON.stringify(
            { generated_at: new Date().toISOString(), result, output: sandbox.output },
            null,
            2
          )
        );
        currentStore.createAgentArtifact({
          run_id: run.run_id,
          work_id: task.work_id,
          agent_id: run.agent_id,
          kind: 'report',
          label: `${role.owner} execution result`,
          uri: reportPath,
          metadata: result,
        });
        currentStore.updateExecutiveWorkItem(task.work_id, {
          status: actionable ? 'in_progress' : 'blocked',
          waiting_on: actionable ? 'downstream-queue' : role.owner,
          next_action: actionable
            ? `Downstream queue must execute and evidence the ${role.owner} work products before this task closes.`
            : `${role.owner} must repair this no-op plan; the manager produced no executable work product.`,
          last_error: actionable ? null : 'manager plan produced no executable work product',
          evidence: [
            ...(Array.isArray(task.evidence) ? task.evidence : []),
            {
              type: 'artifact',
              label: `${role.owner} execution report`,
              uri: reportPath,
              note: actionable
                ? 'Bounded downstream work was created.'
                : 'No executable downstream work was created.',
            },
          ],
        });
        return result;
      },
    },
  });
}

function queuedManagerCandidate(store) {
  const agents = MANAGER_ROLES.map(role => ({
    role,
    agent: runtime.recoverExpiredAgent(store, store.getAgent(role.slug)),
  })).filter(item => item.agent && item.agent.status === 'active');
  const queued = agents.flatMap(({ role, agent }) =>
    store
      .listAgentDispatches({
        agent_id: agent.agent_id,
        adapter: 'codex',
        status: 'queued',
        limit: 1000,
      })
      .map(dispatch => ({ role, agent, dispatch }))
  );
  return (
    queued.sort(
      (a, b) =>
        runtime.accountabilityScore(b.agent) - runtime.accountabilityScore(a.agent) ||
        Date.parse(a.dispatch.created_at || '') - Date.parse(b.dispatch.created_at || '')
    )[0] || null
  );
}

async function runOnce(root, { workerId } = {}) {
  const store = eventstore.open(root);
  try {
    const reconciled = reconcileSiteFactory(store, root);
    const candidate = queuedManagerCandidate(store);
    const processed = candidate
      ? candidate.role.owner === 'site-factory-manager'
        ? await processSiteFactory(store, root, { workerId })
        : await processOperatingManager(store, root, candidate.role, { workerId })
      : { processed: false };
    return { ...processed, reconciled, lane: candidate?.role.owner || null };
  } finally {
    store.close();
  }
}

if (require.main === module) {
  const root = process.env.FD_DOMAINS_ROOT || path.resolve(__dirname, '..', '..');
  runOnce(root)
    .then(result => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.processed && result.error && !result.deferred ? 1 : 0;
    })
    .catch(error => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}

module.exports = {
  extractDomain,
  enqueueSiteFactory,
  processOperatingManager,
  queuedManagerCandidate,
  reconcileSiteFactory,
  processSiteFactory,
  runOnce,
};
