'use strict';

// Bounded consumer for the operating-layer queue. The dashboard owns durable
// identity and leases; this worker owns only the allowlisted handoff into an
// existing host-side queue. It deliberately does not shell out from the
// dashboard process or claim that a site is complete before the host runner
// produces its result.

const fs = require('node:fs');
const path = require('node:path');
const eventstore = require('../fleet-dashboard/server/eventstore');
const dispatcher = require('./agent-dispatcher');
const domains = require('../fleet-dashboard/server/domains');

const DOMAIN_RE = /\b([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)\b/gi;
const IGNORED_DOMAINS = new Set(['github.com', 'example.com', 'localhost']);

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

async function runOnce(root, { workerId } = {}) {
  const store = eventstore.open(root);
  try {
    return await processSiteFactory(store, root, { workerId });
  } finally {
    store.close();
  }
}

if (require.main === module) {
  const root = process.env.FD_DOMAINS_ROOT || path.resolve(__dirname, '..', '..');
  runOnce(root)
    .then(result => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.processed ? (result.error ? 1 : 0) : 0;
    })
    .catch(error => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}

module.exports = { extractDomain, enqueueSiteFactory, processSiteFactory, runOnce };
