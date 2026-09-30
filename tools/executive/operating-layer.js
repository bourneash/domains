'use strict';

// The operating layer is the execution boundary between executive discussion
// and specialist delivery. Executives may decide what matters; this module
// creates the durable manager-owned case and the actual runtime dispatch that
// makes the work observable and recoverable.

const runtime = require('./agent-runtime');

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
  if (/\b(site|website|domain|onboard|launch|new site|build a site)\b/.test(text))
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

function enqueueOwnerRequest(store, source) {
  if (!source || source.source_type !== 'owner-request') return null;
  const existing = findExistingTask(store, source.work_id);
  if (existing) {
    const run = existing.run_id ? store.getAgentRun(existing.run_id) : null;
    const dispatch = run ? store.getAgentDispatch(run.run_id) : null;
    return { task: existing, run, dispatch, reused: true };
  }

  ensureOperatingTeam(store);
  const spec = roleForRequest(source.summary);
  const agent = store.getAgent(spec.slug);
  if (!agent) throw new Error(`operating manager unavailable: ${spec.slug}`);
  const taskId = `operating-task:${source.work_id}`;
  const task = store.createExecutiveWorkItem({
    work_id: taskId,
    title: `Execute owner request: ${source.summary.slice(0, 90)}`,
    kind: 'implementation',
    status: 'ready',
    priority: source.priority === 'normal' ? 'high' : source.priority,
    owner: spec.role,
    source_type: 'operating-task',
    source_id: source.work_id,
    parent_work_id: source.work_id,
    site: source.site || null,
    summary: source.summary,
    next_action: `Manager must claim this task, decompose it if needed, and dispatch the smallest executable specialist work with an artifact requirement.`,
    waiting_on: spec.role,
    due_at: source.due_at,
    created_by: 'operating-layer',
    labels: ['operating-layer', spec.queue, 'owner-request'],
  });

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
    next_action: `Dispatch ${dispatch.dispatch_id} is queued for ${spec.name}. The manager must produce an artifact or an explicit blocker.`,
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
    const task = findExistingTask(store, item.work_id);
    if (task && !['closed', 'done', 'cancelled'].includes(item.lifecycle_state)) {
      const run = store.listAgentRuns({ work_id: task.work_id, limit: 1 })[0];
      const dispatch = run ? store.getAgentDispatch(run.run_id) : null;
      if (dispatch && (item.lifecycle_state !== 'actioned' || item.waiting_on !== task.owner)) {
        const updated = store.updateExecutiveWorkItem(item.work_id, {
          status: 'in_progress',
          lifecycle_state: 'actioned',
          waiting_on: task.owner,
          next_action: `Operating manager dispatch ${dispatch.dispatch_id} is ${dispatch.status}; wait for an artifact or explicit blocker.`,
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
            status: 'in_progress',
            lifecycle_state: 'actioned',
            waiting_on: execution.task.owner,
            next_action: `Operating manager dispatch ${execution.dispatch.dispatch_id} is queued; wait for an artifact or explicit blocker.`,
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
  reconcileOwnerRequests,
  operatingTeamStatus,
};
