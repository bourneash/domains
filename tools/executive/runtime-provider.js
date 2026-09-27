'use strict';

// Provider protocol for real sandbox/workspace backends. The control plane
// owns authorization and durable state; providers own the actual container,
// VM, worktree, or preview service.

async function providerRequest(provider, path, body, method = 'POST') {
  const endpoint = String(provider.config?.endpoint || '').trim();
  if (!endpoint) throw new Error(`runtime provider ${provider.slug} has no endpoint`);
  const response = await fetch(new URL(path, endpoint), {
    method,
    headers: { 'content-type': 'application/json', 'x-executive-provider': provider.slug },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  let result;
  try {
    result = text ? JSON.parse(text) : {};
  } catch {
    result = { output: text };
  }
  if (!response.ok)
    throw new Error(`provider HTTP ${response.status}: ${result.error || text.slice(0, 500)}`);
  return result;
}

async function provision(store, input = {}) {
  const provider = store.getRuntimeProviderConfig(input.provider_id);
  if (!provider || provider.status !== 'active')
    throw new Error('active runtime provider not found');
  const result = await providerRequest(provider, '/v1/workspaces', {
    agent_id: input.agent_id,
    run_id: input.run_id || null,
    site: input.site || null,
    mode: input.mode || 'isolated',
    request: input.request || {},
  });
  return store.createAgentWorkspace({
    ...input,
    path: result.path || result.workspace_path,
    preview_url: result.preview_url || null,
    provider_id: provider.provider_id,
    status: 'active',
  });
}

async function close(store, id) {
  const workspace = store.listAgentWorkspaces({ limit: 1000 }).find(row => row.workspace_id === id);
  if (!workspace) throw new Error('workspace not found');
  if (workspace.provider_id) {
    const provider = store.getRuntimeProviderConfig(workspace.provider_id);
    if (provider?.config?.endpoint)
      await providerRequest(provider, `/v1/workspaces/${encodeURIComponent(id)}/close`, {
        workspace_id: id,
      });
  }
  return store.closeAgentWorkspace(id);
}

module.exports = { providerRequest, provision, close };
