'use strict';

// Portable, secret-scrubbed organization bundles. Values from agent_secrets
// are intentionally never selected or serialized.
function exportOrganization(store, organizationId) {
  const organization = store.getOrganization(organizationId);
  if (!organization) throw new Error('organization not found');
  const agents = store
    .listAgents({ organization_id: organization.organization_id, limit: 1000 })
    .map(agent => ({
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
    schema: 'executive-organization/v1',
    exported_at: new Date().toISOString(),
    organization: { slug: organization.slug, name: organization.name, status: organization.status },
    members: store
      .listOrganizationMembers({ organization_id: organization.organization_id })
      .map(member => ({ actor_id: member.actor_id, role: member.role, status: member.status })),
    agents,
    skills: store
      .listAgentSkills({ limit: 1000 })
      .map(skill => ({
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        status: skill.status,
      })),
    plugins: store
      .listRuntimePlugins({ limit: 1000 })
      .map(plugin => ({ slug: plugin.slug, manifest: plugin.manifest, status: plugin.status })),
    connectors: store
      .listRuntimeConnectors({ limit: 1000 })
      .map(connector => ({
        slug: connector.slug,
        kind: connector.kind,
        capabilities: connector.capabilities,
        status: connector.status,
      })),
    secrets: { omitted: true, reason: 'secret values are never portable' },
  };
}

function importOrganization(store, bundle) {
  if (!bundle || bundle.schema !== 'executive-organization/v1' || !bundle.organization)
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
  for (const agent of Array.isArray(bundle.agents) ? bundle.agents : []) {
    let agentSlug = String(agent.slug || 'agent');
    let n = 1;
    while (store.getAgent(agentSlug)) agentSlug = `${agent.slug}-import-${n++}`;
    agents.push(
      store.createAgent({
        ...agent,
        slug: agentSlug,
        organization_id: organization.organization_id,
        status: agent.status === 'disabled' ? 'disabled' : 'active',
      })
    );
  }
  return { organization, agents, secrets: { imported: false, omitted: true } };
}

module.exports = { exportOrganization, importOrganization };
