'use strict';

// Optional, non-blocking lifecycle notifications. The queue remains usable
// when no webhook is configured or when Slack is unavailable.
async function notify({ event, request, run = null, details = '' } = {}) {
  const url = String(process.env.FD_CHANGE_QUEUE_WEBHOOK_URL || '').trim();
  if (!url) return { sent: false, reason: 'not-configured' };
  const text = [
    `Change Queue: ${event}`,
    `${request?.site || 'unknown site'} — ${request?.title || request?.request_id || 'request'}`,
    request?.status ? `status=${request.status}` : '',
    run?.run_id ? `run=${run.run_id.slice(0, 8)}` : '',
    details,
  ]
    .filter(Boolean)
    .join('\n');
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return { sent: false, reason: `webhook HTTP ${response.status}` };
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error.message };
  }
}

module.exports = { notify };
