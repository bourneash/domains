'use strict';

// Durable adapter boundary. The queue owns leases and retries; adapter
// implementations are deliberately injected by the worker so this module
// cannot execute arbitrary shell commands from an HTTP request.
const runtime = require('./agent-runtime');
const crypto = require('node:crypto');

function runToken(run, expiresInSeconds = 900) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: run.agent_id,
      run_id: run.run_id,
      organization_id: run.organization_id,
      scope: ['agent:run', 'agent:heartbeat', 'artifact:write'],
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    })
  ).toString('base64url');
  const body = `${header}.${payload}`;
  const secret =
    process.env.EXECUTIVE_SECRET_KEY ||
    process.env.FD_SECRET_KEY ||
    'development-only-agent-runtime-key';
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
}

async function invokeExternalAdapter(store, adapter, dispatch, run, context) {
  if (!adapter?.endpoint)
    throw new Error(`no handler or endpoint registered for ${dispatch.adapter}`);
  const endpoint = new URL(adapter.endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runToken(run)}`,
        'content-type': 'application/json',
        'x-paperclip-run-id': run.run_id,
      },
      body: JSON.stringify({
        protocol: 'executive-agent/v1',
        run,
        dispatch,
        context,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { output: text };
    }
    if (!response.ok)
      throw new Error(`adapter HTTP ${response.status}: ${body.error || text.slice(0, 500)}`);
    return body.result || body;
  } finally {
    clearTimeout(timer);
  }
}

function claim(store, workerId, options) {
  return store.claimAgentDispatch(workerId, options);
}

async function processOne(store, { workerId, adapters = {}, claimOptions = {} } = {}) {
  const dispatch = claim(store, workerId, claimOptions);
  if (!dispatch) return { processed: false };
  try {
    const run = store.getAgentRun(dispatch.run_id);
    const context = {
      skills: store.resolveAgentSkills ? store.resolveAgentSkills(run.agent_id) : [],
      memories: store.listAgentMemories
        ? store.listAgentMemories({ agent_id: run.agent_id, limit: 20 })
        : [],
    };
    if (store.createAgentSession && !store.getAgentSession?.(run.session_id))
      store.createAgentSession({
        agent_id: run.agent_id,
        run_id: run.run_id,
        session_id: run.session_id,
        context,
      });
    const handler = adapters[dispatch.adapter];
    const result =
      typeof handler === 'function'
        ? await handler({ store, dispatch, run, context })
        : await invokeExternalAdapter(
            store,
            store.getRuntimeAdapter?.(dispatch.adapter),
            dispatch,
            run,
            context
          );
    runtime.finish(store, dispatch.run_id, {
      status: 'succeeded',
      result: result || {},
      cost_usd: Number(result?.cost_usd || 0),
      input_tokens: Number(result?.input_tokens || 0),
      output_tokens: Number(result?.output_tokens || 0),
    });
    return { processed: true, dispatch, result: result || {} };
  } catch (error) {
    runtime.finish(store, dispatch.run_id, { status: 'failed', error: error.message });
    return { processed: true, dispatch, error: error.message };
  }
}

module.exports = { claim, processOne, runToken, invokeExternalAdapter };
