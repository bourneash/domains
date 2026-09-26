'use strict';

// Durable role-facing lifecycle updates. Human webhook notifications are
// optional; executive roles must still receive a message in the shared
// conversation so the next brief can close the loop.

const executive = require('./executive');

const REQUESTORS = new Set([
  'ceo',
  'cto',
  'cfo',
  'cro',
  'product-manager-fleet',
  'product-manager-sites',
  'domain-manager',
  'researcher',
]);

function notify(store, { event, request, run = null, details = '' } = {}) {
  const requestedBy = String(request?.requested_by || '').trim();
  if (!REQUESTORS.has(requestedBy) || !request?.request_id) return null;
  const messageId = `executive-followup:${request.request_id}:${event}`;
  const body = [
    `Request update for ${requestedBy}: ${request.title}`,
    `status=${request.status}; event=${event}`,
    run?.run_id ? `run=${run.run_id}` : '',
    run?.state ? `run_state=${run.state}` : '',
    details,
  ]
    .filter(Boolean)
    .join('\n');
  let message;
  try {
    message = executive.message(store, {
      message_id: messageId,
      actor: 'system',
      body,
      metadata: {
        kind: 'change-request-followup',
        requested_by: requestedBy,
        request_id: request.request_id,
        source_proposal_id: request.source_proposal_id || null,
        event,
        run_id: run?.run_id || null,
      },
    });
  } catch (error) {
    // Deterministic message IDs make retries idempotent. A duplicate means the
    // original follow-up was already delivered; other errors must surface.
    if (!String(error.message || error).includes('UNIQUE constraint failed')) throw error;
    return null;
  }
  store.record({
    event_type: 'executive.request-followup',
    source: 'fleet-dashboard',
    site_id: request.site ? `site:${request.site}` : null,
    entity_type: 'change-request',
    entity_id: request.request_id,
    correlation_id: `change-request:${request.request_id}`,
    payload: { event, requested_by: requestedBy, message_id: message.message_id },
  });
  return message;
}

module.exports = { REQUESTORS: [...REQUESTORS], notify };
