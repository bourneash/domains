'use strict';

// The operating layer is the execution boundary between executive discussion
// and specialist delivery. Executives may decide what matters; this module
// creates the durable manager-owned case and the actual runtime dispatch that
// makes the work observable and recoverable.

const runtime = require('./agent-runtime');
const fs = require('node:fs');
const path = require('node:path');
const changequeue = require('../fleet-dashboard/server/changequeue');
const { briefHash } = require('../fleet-dashboard/server/site-build-contract');
const intake = require('./work-intake');

const OPERATING_ROLES = Object.freeze([
  {
    role: 'operations-manager',
    slug: 'fleet-operations-manager',
    name: 'Fleet Operations Manager',
    title: 'VP of Operations and Execution',
    description: 'Turns owner and executive decisions into owned, dispatched work.',
    queue: 'all',
    keywords: [],
  },
  {
    role: 'site-factory-manager',
    slug: 'fleet-site-factory-manager',
    name: 'Fleet Site Factory Manager',
    title: 'Director of Site Delivery',
    description: 'Owns new-site onboarding, build completion, previews, and launch gates.',
    queue: 'site-factory',
    keywords: ['site', 'website', 'domain', 'onboard', 'launch', 'build'],
  },
  {
    role: 'engineering-manager',
    slug: 'fleet-engineering-manager',
    name: 'Fleet Engineering Manager',
    title: 'Director of Engineering Delivery',
    description: 'Owns implementation, defects, platform work, tests, and release readiness.',
    queue: 'engineering',
    keywords: ['code', 'develop', 'development', 'bug', 'feature', 'api', 'technical', 'fix'],
  },
  {
    role: 'growth-manager',
    slug: 'fleet-growth-manager',
    name: 'Fleet Growth Manager',
    title: 'Director of SEO and Growth',
    description: 'Owns SEO, content, acquisition, and measurable growth improvements.',
    queue: 'growth',
    keywords: ['seo', 'search', 'traffic', 'content', 'growth', 'backlink', 'ranking'],
  },
  {
    role: 'design-manager',
    slug: 'fleet-design-manager',
    name: 'Fleet Design Manager',
    title: 'Director of Design and Conversion',
    description: 'Owns design quality, accessibility, UX, CRO, and visual improvements.',
    queue: 'design',
    keywords: ['design', 'redesign', 'ux', 'ui', 'conversion', 'cro', 'accessibility'],
  },
]);

const ROLE_BY_SLUG = new Map(OPERATING_ROLES.map(item => [item.slug, item]));

function roleForRequest(summary = '') {
  const text = String(summary).toLowerCase();
  if (
    /\b(site|website|domain|onboard|launch|new site|build a site)\b/.test(text) ||
    /\bbuild\b[^\n]{0,120}\b[a-z0-9-]+\.[a-z]{2,}\b/.test(text)
  )
    return OPERATING_ROLES.find(item => item.queue === 'site-factory');
  if (/\b(seo|search|traffic|content|growth|ranking|backlink)\b/.test(text))
    return OPERATING_ROLES.find(item => item.queue === 'growth');
  if (/\b(design|redesign|ux|ui|conversion|cro|accessib)/.test(text))
    return OPERATING_ROLES.find(item => item.queue === 'design');
  if (/\b(code|develop|bug|feature|api|technical|fix|implement)/.test(text))
    return OPERATING_ROLES.find(item => item.queue === 'engineering');
  return OPERATING_ROLES[0];
}

function ensureOperatingTeam(store) {
  const existing = new Map(store.listAgents({ limit: 2000 }).map(agent => [agent.slug, agent]));
  const created = [];
  for (const spec of OPERATING_ROLES) {
    if (existing.has(spec.slug)) continue;
    created.push(
      store.createAgent({
        slug: spec.slug,
        name: spec.name,
        title: spec.title,
        role: spec.role,
        provider: 'chatgpt',
        adapter: 'codex',
        permissions: [
          'read:intelligence',
          'read:work',
          'create:work',
          'dispatch:work',
          'write:artifact',
        ],
        heartbeat: { enabled: true, interval_minutes: 10 },
        workspace: { mode: 'control-plane', queue: spec.queue },
      })
    );
  }
  return { roles: OPERATING_ROLES, created, agents: store.listAgents({ limit: 2000 }) };
}

function findExistingTask(store, sourceWorkId) {
  return store
    .listExecutiveWorkItems({ parent_work_id: sourceWorkId, quiet: '0', limit: 100 })
    .find(item => item.source_type === 'operating-task');
}

function reconcileIntake(store, source, task) {
  const classification = intake.classify(source.summary);
  if (
    classification.intent === 'implementation' ||
    ['done', 'cancelled'].includes(task.status) ||
    (task.labels || []).includes(`intent:${classification.intent}`)
  )
    return task;
  const runs = store.listAgentRuns({ work_id: task.work_id, limit: 1000 });
  if (
    runs.some(
      run => run.status === 'running' && store.getAgentDispatch(run.run_id)?.status === 'leased'
    )
  )
    return task;
  // Reclassify only undispatched/terminal historical manager work. Never
  // interrupt a live worker or clear the original release policy.
  for (const run of runs) {
    const dispatch = store.getAgentDispatch(run.run_id);
    if (dispatch?.status === 'queued') {
      store.completeAgentDispatch(dispatch.dispatch_id, {
        status: 'cancelled',
        error: 'Owner intent reclassified; replacement implementation is not authorized.',
      });
      store.updateAgentRun(run.run_id, {
        status: 'cancelled',
        error: 'Owner intent reclassified; queued execution was cancelled.',
      });
    }
  }
  const updated = store.updateExecutiveWorkItem(task.work_id, {
    kind: classification.kind,
    status: 'blocked',
    waiting_on:
      classification.intent === 'research'
        ? task.owner
        : classification.intent === 'revalidation'
          ? 'validation-recovery'
          : 'owner-decision-application',
    next_action: classification.next_action,
    labels: [
      ...(task.labels || []).filter(label => !label.startsWith('intent:')),
      `intent:${classification.intent}`,
    ],
  });
  store.record({
    event_type: 'executive.intake.reclassified',
    source: 'operating-layer',
    entity_type: 'work-item',
    entity_id: task.work_id,
    correlation_id: `executive-work-item:${source.work_id}`,
    payload: {
      intent: classification.intent,
      previous_kind: task.kind,
      release_hold_preserved: true,
    },
  });
  return updated;
}

function enqueueOwnerRequest(store, source) {
  if (!source || source.source_type !== 'owner-request') return null;
  const found = findExistingTask(store, source.work_id);
  const existing = found ? reconcileIntake(store, source, found) : null;
  if (existing) {
    const run = existing.run_id ? store.getAgentRun(existing.run_id) : null;
    const dispatch = run ? store.getAgentDispatch(run.run_id) : null;
    return { task: existing, run, dispatch, reused: true };
  }

  ensureOperatingTeam(store);
  const classification = intake.classify(source.summary);
  const spec =
    classification.intent === 'revalidation'
      ? OPERATING_ROLES.find(item => item.queue === 'engineering')
      : classification.intent === 'implementation'
        ? roleForRequest(source.summary)
        : OPERATING_ROLES[0];
  const agent = store.getAgent(spec.slug);
  if (!agent) throw new Error(`operating manager unavailable: ${spec.slug}`);
  const taskId = `operating-task:${source.work_id}`;
  const task = store.createExecutiveWorkItem({
    work_id: taskId,
    title: `${classification.intent === 'implementation' ? 'Execute' : classification.intent} owner request: ${source.summary.slice(0, 90)}`,
    kind: classification.kind,
    status: classification.dispatch ? 'ready' : 'waiting',
    priority: source.priority === 'normal' ? 'high' : source.priority,
    owner: spec.role,
    source_type: 'operating-task',
    source_id: source.work_id,
    parent_work_id: source.work_id,
    site: source.site || null,
    summary: source.summary,
    next_action: classification.next_action,
    waiting_on: classification.dispatch ? spec.role : 'owner-decision-application',
    due_at: source.due_at,
    created_by: 'operating-layer',
    labels: ['operating-layer', spec.queue, 'owner-request', `intent:${classification.intent}`],
  });

  if (!classification.dispatch) return { task, run: null, dispatch: null, reused: false };

  let started;
  try {
    started = runtime.beginRun(store, {
      agent_id: agent.agent_id,
      work_id: task.work_id,
      idempotency_key: `operating-run:${source.work_id}`,
      reserve_usd: 0,
    });
  } catch (error) {
    store.updateExecutiveWorkItem(task.work_id, {
      status: 'blocked',
      waiting_on: 'system',
      next_action: `Repair operating manager dispatch: ${error.message}`,
      last_error: error.message,
    });
    throw error;
  }
  const run = started.run;
  const dispatch = store.getAgentDispatch(run.run_id);
  if (!dispatch) throw new Error(`operating manager run ${run.run_id} has no dispatch`);
  store.updateExecutiveWorkItem(task.work_id, {
    status: 'in_progress',
    next_action: `${classification.next_action} Dispatch ${dispatch.dispatch_id} is queued for ${spec.name}.`,
    waiting_on: spec.role,
    evidence: [
      {
        type: 'artifact',
        label: `Operating manager dispatch ${dispatch.dispatch_id}`,
        note: `Run ${run.run_id} is durably queued for ${spec.name}.`,
      },
    ],
  });
  return { task: store.getExecutiveWorkItem(task.work_id), run, dispatch, reused: false };
}

// Onboarding is a prerequisite, not the requested deliverable. Create one
// recoverable build request after the host job succeeds, with the owner brief
// copied verbatim into the worker payload. A pull request cannot publish the
// site; the separate preview/launch gate remains with the owner.
function ensureSiteBuildRequest(store, task, { root, site, conceptApproved = false } = {}) {
  if (task?.source_type !== 'operating-task' || task.owner !== 'site-factory-manager')
    throw new Error('site build continuation requires a site-factory operating task');
  if ((task.labels || []).includes('site-build-merged'))
    throw new Error('site build continuation is merged into a newer owner request');
  if ((task.labels || []).includes('site-build-deferred'))
    throw new Error('site build continuation is deferred to an existing builder');
  const parent = task.parent_work_id ? store.getExecutiveWorkItem(task.parent_work_id) : null;
  if (!parent || parent.source_type !== 'owner-request')
    throw new Error('site build continuation requires the linked owner request');
  const domain = String(site || task.site || '')
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(domain))
    throw new Error('site build continuation requires a valid domain');
  if (domain === 'magicescorts.com' && !conceptApproved)
    return {
      request: null,
      blocked: true,
      reason:
        'Owner disposition is required for the deceptive booking concept before any publicly reachable preview or build request.',
    };
  const actionKey = `site-build:${parent.work_id}`;
  const existing = store
    .listChangeRequests({ site: domain, limit: 1000 })
    .find(request => request.action_key === actionKey && request.status !== 'cancelled');
  if (existing) return { request: existing, reused: true, blocked: false };
  if (!root) throw new Error('site build continuation requires the fleet root');
  const siteDir = path.join(root, 'sites', domain);
  if (!fs.existsSync(siteDir)) throw new Error(`site checkout is unavailable: ${domain}`);
  const request = changequeue.create(
    store,
    {
      site: domain,
      title: `Build ${domain} from the owner brief; prepare a private review`,
      body: [
        `Owner request ${parent.request_ref || parent.work_id}; full brief (verbatim):`,
        parent.summary,
        '',
        `FIRST: replace the scaffold's "positioning TBD / wait for Jesse's brief" instructions in CLAUDE.md. Record "Owner brief SHA256: ${briefHash(parent.summary)}" and the site's actual type, audience, design, content, feature toggles, and launch constraints from the verbatim brief. Create ops/AGENT_BUILD_PROMPT.md containing the full verbatim owner brief and concrete build acceptance. Do this before page implementation so every worker receives the same contract.`,
        'Acceptance: implement the requested site content and design, with real pages beyond the Coming Soon scaffold; run the site build and tests; report the exact commit and page paths; supply a reviewable private preview and record its validation.',
        'This is a pull-request delivery. No production publication or public preview is authorized by this request. Keep the parent owner request open through the private preview milestone; public-site completion additionally requires the connected GitHub-to-Cloudflare Workers Builds release and verified live URL after the launch gate is resolved.',
      ].join('\n'),
      category: 'design',
      priority: 'high',
      assigned_role: 'engineer',
      requested_by: 'site-factory',
      delivery_mode: 'pull_request',
      action_key: actionKey,
      auto_review: true,
      max_turns: 40,
    },
    candidate => candidate === domain && fs.existsSync(siteDir),
    () => ['engineer']
  );
  store.updateExecutiveWorkItem(task.work_id, {
    site: domain,
    status: 'in_progress',
    waiting_on: 'site-build-worker',
    next_action: `Build request ${request.request_id} is queued for a pull request and private review. Full owner brief hash: ${briefHash(parent.summary)}. Do not close this task on onboarding alone.`,
  });
  return { request, reused: false, blocked: false };
}

// Repair only the historic false-complete case where a host onboarding job
// closed both records despite no accepted site build. Do not provide a generic
// way to reopen accepted or unrelated owner work.
function reopenOnboardingOnlySiteBuild(
  store,
  parentWorkId,
  { site, supersededBy, deferBuildDispatch = false } = {}
) {
  const parent = store.getExecutiveWorkItem(parentWorkId);
  if (!parent || parent.source_type !== 'owner-request')
    throw new Error('site build recovery requires an owner request');
  const task = findExistingTask(store, parent.work_id);
  if (!task || task.owner !== 'site-factory-manager')
    throw new Error('site build recovery requires a site-factory operating task');
  if ((task.evidence || []).some(item => item.contract === 'site-build/v1'))
    throw new Error('accepted site-build evidence exists; recovery is not applicable');
  if (task.status !== 'done' || parent.status !== 'done' || parent.lifecycle_state !== 'closed')
    throw new Error('site build recovery applies only to an onboarding-only closed request');
  const domain = String(site || task.site || '')
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(domain))
    throw new Error('site build recovery requires an explicit valid site');
  let canonical = null;
  if (supersededBy) {
    canonical = store.getExecutiveWorkItem(supersededBy);
    if (
      !canonical ||
      canonical.source_type !== 'owner-request' ||
      canonical.work_id === parent.work_id
    )
      throw new Error('site build recovery requires a different canonical owner request');
    const canonicalTask = findExistingTask(store, canonical.work_id);
    if (!canonicalTask || canonicalTask.owner !== 'site-factory-manager')
      throw new Error('canonical owner request must have a site-factory task');
    if (canonicalTask.site && canonicalTask.site !== domain)
      throw new Error('canonical owner request targets a different site');
  }
  const updatedTask = store.updateExecutiveWorkItem(task.work_id, {
    site: domain,
    status: canonical || deferBuildDispatch ? 'waiting' : 'in_progress',
    waiting_on: canonical
      ? `owner-request:${canonical.work_id}`
      : deferBuildDispatch
        ? 'existing-site-builder'
        : 'site-factory-manager',
    next_action: canonical
      ? `This older onboarding-only case is merged into owner request ${canonical.request_ref || canonical.work_id}; that newer brief owns delivery for ${domain}. Do not enqueue a duplicate build.`
      : deferBuildDispatch
        ? `An existing builder is already implementing ${domain}; do not enqueue a duplicate build. Attach its validated artifact and preview to this case when ready.`
        : `Host onboarding is a completed milestone, not site delivery. Continue the full owner brief for ${domain}, build the requested pages, validate the build, and attach private-preview acceptance evidence.`,
    labels: canonical
      ? [...new Set([...(task.labels || []), 'site-build-merged'])]
      : deferBuildDispatch
        ? [...new Set([...(task.labels || []), 'site-build-deferred'])]
        : task.labels,
    outcome: null,
    resolution_note: null,
  });
  const updatedParent = store.updateExecutiveWorkItem(parent.work_id, {
    status: 'in_progress',
    lifecycle_state: 'actioned',
    waiting_on: canonical
      ? `owner-request:${canonical.work_id}`
      : deferBuildDispatch
        ? 'existing-site-builder'
        : 'site-factory-manager',
    next_action: canonical
      ? `Merged into owner request ${canonical.request_ref || canonical.work_id}; that newer brief owns site delivery for ${domain}. This request was not completed by onboarding.`
      : deferBuildDispatch
        ? `An existing builder owns delivery for ${domain}. The original brief remains open until site-build/v1 acceptance; do not dispatch duplicate work.`
        : `Site Factory is continuing the original owner brief for ${domain}; onboarding alone did not complete this request.`,
    closed_at: null,
    outcome: null,
    resolution_note: null,
  });
  store.record({
    event_type: 'executive.owner-request.site-build-reopened',
    source: 'operating-layer',
    entity_type: 'executive-work-item',
    entity_id: parent.work_id,
    correlation_id: `executive-work-item:${parent.work_id}`,
    payload: {
      operating_task_id: task.work_id,
      site: domain,
      reason: 'onboarding-only completion lacked site-build/v1 acceptance evidence',
      superseded_by: canonical?.work_id || null,
      deferred_to_existing_builder: Boolean(deferBuildDispatch && !canonical),
    },
  });
  return { parent: updatedParent, task: updatedTask };
}

function operatingTeamStatus(store) {
  const team = ensureOperatingTeam(store);
  const agents = team.agents.filter(agent => ROLE_BY_SLUG.has(agent.slug));
  return {
    roles: OPERATING_ROLES,
    agents: agents.map(agent => ({
      ...agent,
      queued_dispatches: store.listAgentDispatches({
        agent_id: agent.agent_id,
        status: 'queued',
        limit: 1000,
      }).length,
      active_runs: store.listAgentRuns({ agent_id: agent.agent_id, status: 'running', limit: 1000 })
        .length,
    })),
  };
}

function reconcileOwnerRequests(store) {
  const results = [];
  for (const item of store.listExecutiveWorkItems({
    source_type: 'owner-request',
    quiet: '0',
    limit: 1000,
  })) {
    if (['closed', 'done', 'cancelled'].includes(item.lifecycle_state)) continue;
    const existing = findExistingTask(store, item.work_id);
    const task = existing ? reconcileIntake(store, item, existing) : null;
    if (task && !['closed', 'done', 'cancelled'].includes(item.lifecycle_state)) {
      const run = store.listAgentRuns({ work_id: task.work_id, limit: 1 })[0];
      const dispatch = run ? store.getAgentDispatch(run.run_id) : null;
      const expectedWaitingOn = task.waiting_on || task.owner;
      const expectedAction = task.next_action
        ? task.next_action
        : `Operating manager dispatch ${dispatch?.dispatch_id || 'pending'} is ${dispatch?.status || 'unknown'}; wait for an artifact or explicit blocker.`;
      const expectedStatus = ['blocked', 'waiting', 'done', 'cancelled'].includes(task.status)
        ? task.status
        : 'in_progress';
      if (
        (dispatch ||
          (task.labels || []).some(label =>
            ['intent:decision', 'intent:rejection', 'intent:revalidation'].includes(label)
          )) &&
        (item.lifecycle_state !== 'actioned' ||
          item.waiting_on !== expectedWaitingOn ||
          item.next_action !== expectedAction ||
          item.status !== expectedStatus)
      ) {
        const updated = store.updateExecutiveWorkItem(item.work_id, {
          status: expectedStatus,
          lifecycle_state: 'actioned',
          waiting_on: expectedWaitingOn,
          next_action: expectedAction,
        });
        results.push({ task, run, dispatch, repaired: true, parent: updated });
        continue;
      }
    }
    if (!task && ['acknowledged', 'answered', 'actioned'].includes(item.lifecycle_state)) {
      try {
        const execution = enqueueOwnerRequest(store, item);
        const current = store.getExecutiveWorkItem(item.work_id);
        if (current && !['closed', 'done', 'cancelled'].includes(current.lifecycle_state)) {
          store.updateExecutiveWorkItem(item.work_id, {
            status: execution.dispatch ? 'in_progress' : 'waiting',
            lifecycle_state: 'actioned',
            waiting_on: execution.task.waiting_on || execution.task.owner,
            next_action: execution.task.next_action,
          });
        }
        results.push({ ...execution, repaired: true });
      } catch (error) {
        results.push({ source_work_id: item.work_id, error: error.message });
      }
    }
  }
  return results;
}

module.exports = {
  OPERATING_ROLES,
  roleForRequest,
  ensureOperatingTeam,
  enqueueOwnerRequest,
  reconcileIntake,
  ensureSiteBuildRequest,
  reopenOnboardingOnlySiteBuild,
  reconcileOwnerRequests,
  operatingTeamStatus,
};
