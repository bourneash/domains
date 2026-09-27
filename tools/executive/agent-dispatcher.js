'use strict';

// Durable adapter boundary. The queue owns leases and retries; adapter
// implementations are deliberately injected by the worker so this module
// cannot execute arbitrary shell commands from an HTTP request.
const runtime = require('./agent-runtime');

function claim(store, workerId, options) {
  return store.claimAgentDispatch(workerId, options);
}

async function processOne(store, { workerId, adapters = {} } = {}) {
  const dispatch = claim(store, workerId);
  if (!dispatch) return { processed: false };
  const handler = adapters[dispatch.adapter];
  if (typeof handler !== 'function') {
    const error = `no adapter registered for ${dispatch.adapter}`;
    store.completeAgentDispatch(dispatch.dispatch_id, { status: 'failed', error });
    runtime.finish(store, dispatch.run_id, { status: 'failed', error });
    return { processed: true, dispatch, error };
  }
  try {
    const result = await handler({ store, dispatch, run: store.getAgentRun(dispatch.run_id) });
    runtime.finish(store, dispatch.run_id, { status: 'succeeded', result: result || {} });
    return { processed: true, dispatch, result: result || {} };
  } catch (error) {
    runtime.finish(store, dispatch.run_id, { status: 'failed', error: error.message });
    return { processed: true, dispatch, error: error.message };
  }
}

module.exports = { claim, processOne };
