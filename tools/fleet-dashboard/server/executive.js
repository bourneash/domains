'use strict';

// Executive control-plane policy. The agent may think, research, message, and
// prepare proposals autonomously. This module deliberately does not grant it
// deployment, credential, or arbitrary host access; approved work enters the
// existing change queue and improvement workbench.

const ACTORS = new Set([
  'owner',
  'ceo',
  'cto',
  'cro',
  'cfo',
  'domain-manager',
  'researcher',
  'reviewer',
  'system',
]);
const PROPOSAL_TYPES = new Set([
  'business',
  'growth',
  'product',
  'engineering',
  'site-redesign',
  'hiring',
  'spend',
  'report-only',
]);
const ACTION_TYPES = new Set([
  'observe',
  'research',
  'message',
  'propose',
  'queue-work',
  'delegate',
  'approve',
  'decline',
  'feedback',
  'tick',
  'other',
]);
const changequeue = require('./changequeue');

function message(store, input = {}) {
  if (!ACTORS.has(String(input.actor)))
    throw httpErr(400, `unknown executive actor: ${input.actor}`);
  return store.createExecutiveMessage({ ...input, actor: String(input.actor) });
}

function proposal(store, input = {}) {
  if (!PROPOSAL_TYPES.has(String(input.proposal_type || 'business')))
    throw httpErr(400, 'invalid proposal_type');
  if (
    !['ceo', 'cto', 'cro', 'cfo', 'domain-manager', 'researcher'].includes(
      String(input.created_by || 'ceo')
    )
  )
    throw httpErr(400, 'proposals must be created by an executive role or researcher');
  return store.createExecutiveProposal({ ...input, created_by: String(input.created_by || 'ceo') });
}

function decision(store, id, input = {}, { knownSite } = {}) {
  if (String(input.decided_by || 'owner') !== 'owner')
    throw httpErr(403, 'only the owner can decide executive proposals');
  const current = store.getExecutiveProposal(id);
  if (!current) throw httpErr(404, 'executive proposal not found');
  let linkedRequestId = input.linked_request_id;
  if (
    input.status === 'approved' &&
    !linkedRequestId &&
    current.implementation?.site &&
    current.implementation?.title &&
    current.implementation?.body
  ) {
    if (typeof knownSite !== 'function') throw httpErr(500, 'approval executor is not configured');
    const request = changequeue.create(
      store,
      { ...current.implementation, source: 'executive-approval' },
      knownSite
    );
    linkedRequestId = request.request_id;
  }
  const proposal = store.decideExecutiveProposal(id, {
    ...input,
    linked_request_id: linkedRequestId,
  });
  if (linkedRequestId) {
    store.record({
      event_type: 'executive.proposal.task-routed',
      source: 'executive-control-plane',
      site_id: `site:${current.implementation.site}`,
      entity_type: 'executive-proposal',
      entity_id: current.proposal_id,
      correlation_id: `change-request:${linkedRequestId}`,
      payload: {
        request_id: linkedRequestId,
        assigned_role: current.implementation.assigned_role || 'engineer',
        priority: current.implementation.priority || 'medium',
      },
    });
  }
  const actionType =
    input.status === 'approved' ? 'approve' : input.status === 'declined' ? 'decline' : 'feedback';
  const audit = action(store, {
    actor: 'owner',
    action_type: actionType,
    summary: `${actionType} proposal: ${proposal.title}`,
    proposal_id: proposal.proposal_id,
  });
  finishAction(store, audit.action_id, {
    status: 'completed',
    result: {
      proposal_id: proposal.proposal_id,
      decision: proposal.status,
      request_id: linkedRequestId || null,
    },
  });
  return proposal;
}

function action(store, input = {}) {
  if (!ACTORS.has(String(input.actor)))
    throw httpErr(400, `unknown executive actor: ${input.actor}`);
  if (!ACTION_TYPES.has(String(input.action_type)))
    throw httpErr(400, `unknown executive action type: ${input.action_type}`);
  return store.createExecutiveAction({
    ...input,
    actor: String(input.actor),
    action_type: String(input.action_type),
  });
}

function finishAction(store, id, input = {}) {
  return store.finishExecutiveAction(id, input);
}

function httpErr(status, message) {
  const error = new Error(message);
  error.httpStatus = status;
  return error;
}

module.exports = {
  ACTORS: [...ACTORS],
  PROPOSAL_TYPES: [...PROPOSAL_TYPES],
  ACTION_TYPES: [...ACTION_TYPES],
  message,
  proposal,
  decision,
  action,
  finishAction,
};
