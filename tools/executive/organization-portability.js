'use strict';

// Portable, secret-scrubbed organization bundles. Values from agent_secrets
// are intentionally never selected or serialized.
function exportOrganization(store, organizationId) {
  const organization = store.getOrganization(organizationId);
  if (!organization) throw new Error('organization not found');
  const agents = store
    .listAgents({ organization_id: organization.organization_id, limit: 1000 })
    .map(agent => ({
      source_agent_id: agent.agent_id,
      slug: agent.slug,
      name: agent.name,
      title: agent.title,
      role: agent.role,
      provider: agent.provider,
      model: agent.model,
      adapter: agent.adapter,
      permissions: agent.permissions,
      budget: agent.budget,
      heartbeat: agent.heartbeat,
      workspace: agent.workspace,
      status: agent.status,
    }));
  return {
    // Keep the established bundle identifier for backwards compatibility;
    // v1 consumers ignore the additive entity collections below.
    schema: 'executive-organization/v1',
    exported_at: new Date().toISOString(),
    organization: { slug: organization.slug, name: organization.name, status: organization.status },
    members: store
      .listOrganizationMembers({ organization_id: organization.organization_id })
      .map(member => ({ actor_id: member.actor_id, role: member.role, status: member.status })),
    agents,
    skills: store.listAgentSkills({ limit: 1000 }).map(skill => ({
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      status: skill.status,
    })),
    plugins: store
      .listRuntimePlugins({ limit: 1000 })
      .map(plugin => ({ slug: plugin.slug, manifest: plugin.manifest, status: plugin.status })),
    connectors: store.listRuntimeConnectors({ limit: 1000 }).map(connector => ({
      slug: connector.slug,
      kind: connector.kind,
      capabilities: connector.capabilities,
      status: connector.status,
    })),
    projects: store
      .listExecutiveProjects({ limit: 1000 })
      .filter(
        project =>
          !project.organization_id || project.organization_id === organization.organization_id
      ),
    goals: store
      .listExecutiveGoals({ limit: 1000 })
      .filter(
        goal => !goal.organization_id || goal.organization_id === organization.organization_id
      ),
    plans: store
      .listExecutivePlans({ limit: 1000 })
      .filter(
        plan => !plan.organization_id || plan.organization_id === organization.organization_id
      ),
    issues: store.listAgentIssues({ organization_id: organization.organization_id, limit: 1000 }),
    work_items: store.listExecutiveWorkItems({
      organization_id: organization.organization_id,
      limit: 1000,
    }),
    routines: store
      .listAgentRoutines({ limit: 1000 })
      .filter(
        routine =>
          !routine.organization_id || routine.organization_id === organization.organization_id
      ),
    policies: store.listExecutionPolicies({
      organization_id: organization.organization_id,
      limit: 1000,
    }),
    eval_suites: store.listEvalSuites({
      organization_id: organization.organization_id,
      limit: 1000,
    }),
    memories: agents.flatMap(agent =>
      store.listAgentMemories({ agent_id: agent.agent_id, limit: 1000 })
    ),
    secrets: { omitted: true, reason: 'secret values are never portable' },
  };
}

function importOrganization(store, bundle) {
  if (
    !bundle ||
    !['executive-organization/v1', 'executive-organization/v2'].includes(bundle.schema) ||
    !bundle.organization
  )
    throw new Error('invalid organization bundle');
  const base = String(bundle.organization.slug || '').trim();
  if (!base) throw new Error('organization slug is required');
  let slug = base;
  let suffix = 1;
  while (store.getOrganization(slug)) slug = `${base}-import-${suffix++}`;
  const organization = store.createOrganization({ slug, name: bundle.organization.name || slug });
  for (const member of Array.isArray(bundle.members) ? bundle.members : [])
    store.upsertOrganizationMember({
      organization_id: organization.organization_id,
      actor_id: member.actor_id,
      role: member.role,
      status: member.status,
    });
  const agents = [];
  const agentIdMap = new Map();
  for (const agent of Array.isArray(bundle.agents) ? bundle.agents : []) {
    let agentSlug = String(agent.slug || 'agent');
    let n = 1;
    while (store.getAgent(agentSlug)) agentSlug = `${agent.slug}-import-${n++}`;
    const createdAgent = store.createAgent({
      ...agent,
      agent_id: undefined,
      slug: agentSlug,
      organization_id: organization.organization_id,
      status: agent.status === 'disabled' ? 'disabled' : 'active',
    });
    agents.push(createdAgent);
    if (agent.source_agent_id) agentIdMap.set(agent.source_agent_id, createdAgent.agent_id);
  }
  const goalIdMap = new Map();
  for (const goal of Array.isArray(bundle.goals) ? bundle.goals : []) {
    const createdGoal = store.createExecutiveGoal({
      ...goal,
      goal_id: undefined,
      organization_id: organization.organization_id,
      parent_goal_id: goalIdMap.get(goal.parent_goal_id) || null,
      created_by: 'import',
    });
    goalIdMap.set(goal.goal_id, createdGoal.goal_id);
  }
  const projectIdMap = new Map();
  for (const project of Array.isArray(bundle.projects) ? bundle.projects : []) {
    const createdProject = store.createExecutiveProject({
      ...project,
      project_id: undefined,
      organization_id: organization.organization_id,
      goal_id: goalIdMap.get(project.goal_id) || null,
      created_by: 'import',
    });
    projectIdMap.set(project.project_id, createdProject.project_id);
  }
  for (const plan of Array.isArray(bundle.plans) ? bundle.plans : [])
    store.createExecutivePlan({
      ...plan,
      plan_id: undefined,
      organization_id: organization.organization_id,
      goal_id: goalIdMap.get(plan.goal_id) || null,
      created_by: 'import',
    });
  const issues = [];
  for (const issue of Array.isArray(bundle.issues) ? bundle.issues : []) {
    issues.push(
      store.createAgentIssue({
        ...issue,
        issue_id: undefined,
        organization_id: organization.organization_id,
        assignee_agent_id: agentIdMap.get(issue.assignee_agent_id) || null,
        created_by: issue.created_by || 'import',
        checkout_owner: undefined,
        checkout_expires_at: undefined,
      })
    );
  }
  const workItems = [];
  for (const work of Array.isArray(bundle.work_items) ? bundle.work_items : []) {
    workItems.push(
      store.createExecutiveWorkItem({
        ...work,
        work_id: undefined,
        organization_id: organization.organization_id,
        goal_id: goalIdMap.get(work.goal_id) || null,
        project_id: projectIdMap.get(work.project_id) || null,
        parent_work_id: null,
        created_by: 'import',
      })
    );
  }
  const policies = [];
  for (const policy of Array.isArray(bundle.policies) ? bundle.policies : [])
    policies.push(
      store.upsertExecutionPolicy({
        ...policy,
        policy_id: undefined,
        organization_id: organization.organization_id,
        created_by: 'import',
      })
    );
  const evalSuites = [];
  for (const suite of Array.isArray(bundle.eval_suites) ? bundle.eval_suites : [])
    evalSuites.push(
      store.createEvalSuite({
        ...suite,
        suite_id: undefined,
        organization_id: organization.organization_id,
        created_by: 'import',
      })
    );
  return {
    organization,
    agents,
    goals: [...goalIdMap.values()],
    projects: [...projectIdMap.values()],
    work_items: workItems,
    issues,
    policies,
    eval_suites: evalSuites,
    secrets: { imported: false, omitted: true },
  };
}

module.exports = { exportOrganization, importOrganization };
