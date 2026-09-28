'use strict';

// Small, explicit tool gateway for runtime agents. Tool grants are checked
// before dispatch and the allowlist makes arbitrary shell/secret access
// impossible through this interface.
const heartbeat = require('./agent-heartbeat');

const TOOLS = {
  'agents.list': (store, args) => ({
    agents: store.listAgents({ limit: Math.min(Number(args.limit) || 100, 100) }),
  }),
  'runs.list': (store, args) => ({
    runs: store.listAgentRuns({
      agent_id: args.agent_id,
      status: args.status,
      limit: Math.min(Number(args.limit) || 100, 100),
    }),
  }),
  'artifacts.list': (store, args) => ({
    artifacts: store.listAgentArtifacts({
      run_id: args.run_id,
      work_id: args.work_id,
      agent_id: args.agent_id,
      limit: Math.min(Number(args.limit) || 100, 100),
    }),
  }),
  'workspaces.list': (store, args) => ({
    workspaces: store.listAgentWorkspaces({
      agent_id: args.agent_id,
      status: args.status,
      limit: Math.min(Number(args.limit) || 100, 100),
    }),
  }),
  'heartbeat.tick': (store, args) =>
    heartbeat.tick(store, { dueLimit: Math.min(Number(args.due_limit) || 100, 100) }),
};

function invoke(
  store,
  { agent_id: agentId, tool_name: toolName, args = {}, site, approved = false } = {}
) {
  if (!TOOLS[toolName]) throw new Error(`tool is not available: ${toolName}`);
  const decision = store.canAgentUseTool(agentId, toolName, { site, approved });
  if (!decision.allowed) {
    const error = new Error(
      decision.requires_approval
        ? 'tool requires operator approval'
        : 'tool is not authorized for this agent'
    );
    error.httpStatus = decision.requires_approval ? 403 : 403;
    throw error;
  }
  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const result = TOOLS[toolName](store, safeArgs);
  store.record({
    event_type: 'agent.tool.invoke',
    source: 'agent-tool-gateway',
    entity_type: 'agent',
    entity_id: agentId,
    payload: {
      tool_name: toolName,
      site: site || null,
      approved: Boolean(approved),
      args: safeArgs,
    },
  });
  return { tool_name: toolName, result };
}

module.exports = { TOOLS, invoke };
