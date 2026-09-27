'use strict';

async function invokePlugin(store, job, workerId) {
  const plugin = store.getRuntimePlugin(job.plugin_id);
  const endpoint = plugin?.manifest?.worker_endpoint || plugin?.manifest?.endpoint;
  if (!endpoint) throw new Error(`plugin ${plugin?.slug || job.plugin_id} has no worker endpoint`);
  const response = await fetch(new URL('/v1/jobs', endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-plugin-worker': workerId },
    body: JSON.stringify({ protocol: 'executive-plugin/v1', job }),
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
    throw new Error(`plugin HTTP ${response.status}: ${result.error || text.slice(0, 500)}`);
  return result.result || result;
}

async function processOne(store, { workerId = `plugin-worker:${process.pid}` } = {}) {
  const job = store.claimRuntimePluginJob(workerId);
  if (!job) return { processed: false };
  try {
    const result = await invokePlugin(store, job, workerId);
    return {
      processed: true,
      job: store.completeRuntimePluginJob(job.job_id, { status: 'succeeded', result }),
      result,
    };
  } catch (error) {
    return {
      processed: true,
      job: store.completeRuntimePluginJob(job.job_id, { status: 'failed', error: error.message }),
      error: error.message,
    };
  }
}

module.exports = { invokePlugin, processOne };
