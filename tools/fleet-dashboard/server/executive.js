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
  'product-manager-fleet',
  'product-manager-sites',
  'cfo',
  'legal',
  'security',
  'domain-manager',
  'researcher',
  'reviewer',
  'system',
  'project-manager',
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
  let workId = input.work_id || null;
  if (!workId && input.reply_to && store.listExecutiveMessages) {
    const parent = store
      .listExecutiveMessages({ conversation_id: input.conversation_id || 'executive', limit: 1000 })
      .find(item => item.message_id === String(input.reply_to));
    workId = parent?.work_id || null;
  }
  const created = store.createExecutiveMessage({ ...input, actor: String(input.actor), work_id: workId });
  if (created.work_id && created.actor !== 'owner' && store.getExecutiveWorkItem) {
    const workItem = store.getExecutiveWorkItem(created.work_id);
    if (workItem?.source_type === 'owner-request') {
      if (workItem.status === 'waiting') {
        store.updateExecutiveWorkItem(workItem.work_id, {
          status: 'in_progress',
          waiting_on: 'owner',
          next_action: 'Owner review or follow-up is available in the linked thread.',
        });
      }
      const notification = store.createExecutiveNotification?.({
        recipient: 'owner',
        notification_type: 'executive-response',
        title: 'Executive team replied',
        body: created.body,
        work_id: workItem.work_id,
        message_id: created.message_id,
        dedupe_key: `executive-response:${created.message_id}`,
      });
      if (notification) {
        try {
          void require('./executive-notify').notify({ notification, workItem });
        } catch {
          // External notification is optional and must never block the reply.
        }
      }
    }
  }
  return created;
}

function ownerRequest(store, input = {}) {
  const body = String(input.body || '').trim();
  if (!body) throw httpErr(400, 'owner request body is required');
  const messageId = input.message_id || require('node:crypto').randomUUID();
  const workItem = store.createExecutiveWorkItem({
    title: `Owner request: ${body.slice(0, 80)}${body.length > 80 ? '…' : ''}`,
    kind: 'decision',
    status: 'waiting',
    priority: input.priority || 'normal',
    owner: 'ceo',
    source_type: 'owner-request',
    source_id: messageId,
    summary: body,
    next_action: 'Executive team to review the request and reply in the linked thread.',
    waiting_on: 'executive-team',
    due_at: input.due_at || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    created_by: 'owner',
  });
  const ownerMessage = message(store, {
    ...input,
    message_id: messageId,
    actor: 'owner',
    work_id: workItem.work_id,
    message_type: 'decision_request',
  });
  return { message: ownerMessage, work_item: workItem };
}

function ensureOwnerRequests(store) {
  const legacy = store
    .listExecutiveMessages({ conversation_id: 'executive', limit: 1000 })
    .filter(item => item.actor === 'owner' && !item.work_id);
  return legacy.map(item => {
    const workItem = store.createExecutiveWorkItem({
      title: `Owner request: ${item.body.slice(0, 80)}${item.body.length > 80 ? '…' : ''}`,
      kind: 'decision',
      status: 'waiting',
      priority: 'normal',
      owner: 'ceo',
      source_type: 'owner-request',
      source_id: item.message_id,
      summary: item.body,
      next_action: 'Executive team to review the request and reply in the linked thread.',
      waiting_on: 'executive-team',
      due_at: new Date(Date.parse(item.created_at) + 24 * 60 * 60 * 1000).toISOString(),
      created_at: item.created_at,
      created_by: 'owner',
    });
    store.updateExecutiveMessage(item.message_id, {
      work_id: workItem.work_id,
      message_type: item.message_type === 'update' ? 'decision_request' : item.message_type,
    });
    return workItem;
  });
}

function proposal(store, input = {}) {
  if (!PROPOSAL_TYPES.has(String(input.proposal_type || 'business')))
    throw httpErr(400, 'invalid proposal_type');
  if (
    ![
      'ceo',
      'cto',
      'cro',
      'product-manager-fleet',
      'product-manager-sites',
      'cfo',
      'legal',
      'security',
      'domain-manager',
      'researcher',
    ].includes(
      String(input.created_by || 'ceo')
    )
  )
    throw httpErr(400, 'proposals must be created by an executive role or researcher');
  const created = store.createExecutiveProposal({ ...input, created_by: String(input.created_by || 'ceo') });
  // Give every proposal a durable conversation anchor immediately. The PM
  // migration also backfills older proposals created before this behavior.
  const workId = `executive-proposal:${created.proposal_id}`;
  if (store.getExecutiveWorkItem && !store.getExecutiveWorkItem(workId)) {
    store.createExecutiveWorkItem({
      work_id: workId,
      title: `Proposal thread: ${created.title}`,
      kind: created.proposal_type === 'report-only' ? 'research' : created.created_by === 'security' ? 'security' : 'decision',
      status: 'waiting',
      priority: 'normal',
      owner: 'project-manager',
      source_type: 'executive-proposal',
      source_id: created.proposal_id,
      site: created.implementation?.site || null,
      summary: created.summary,
      next_action: 'Owner decision required: approve, request changes, or decline. Continue discussion in this thread.',
      waiting_on: 'owner',
      created_by: created.created_by,
    });
  }
  return created;
}

function decision(store, id, input = {}, { knownSite, availableRolesForSite } = {}) {
  if (String(input.decided_by || 'owner') !== 'owner')
    throw httpErr(403, 'only the owner can decide executive proposals');
  const current = store.getExecutiveProposal(id);
  if (!current) throw httpErr(404, 'executive proposal not found');
  const launchGate = String(current.implementation?.launch_gate || '').toLowerCase();
  if (input.status === 'approved' && launchGate === 'go_live') {
    const legalReview = current.implementation?.legal_review;
    if (legalReview?.status !== 'approved' || legalReview.reviewed_by !== 'legal')
      throw httpErr(409, 'go-live approval requires an approved Legal review');
    const securityReview = current.implementation?.security_review;
    if (securityReview?.status !== 'approved' || securityReview.reviewed_by !== 'security')
      throw httpErr(409, 'go-live approval requires an approved Security review');
  }
  if (
    input.status === 'approved' &&
    String(current.implementation?.security_gate || '').toLowerCase() === 'required'
  ) {
    const securityReview = current.implementation?.security_review;
    if (securityReview?.status !== 'approved' || securityReview.reviewed_by !== 'security')
      throw httpErr(409, 'security-sensitive approval requires an approved Security review');
  }
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
      {
        ...current.implementation,
        source: 'executive-approval',
        requested_by: current.created_by,
        source_proposal_id: current.proposal_id,
      },
      knownSite,
      availableRolesForSite
    );
    linkedRequestId = request.request_id;
  }
  const proposal = store.decideExecutiveProposal(id, {
    ...input,
    linked_request_id: linkedRequestId,
  });
  const workId = `executive-proposal:${proposal.proposal_id}`;
  if (store.getExecutiveWorkItem?.(workId)) {
    store.updateExecutiveWorkItem(workId, {
      status: proposal.status === 'approved' ? 'in_progress' : 'waiting',
      waiting_on: proposal.status === 'approved' ? 'project-manager' : proposal.created_by,
      next_action:
        proposal.status === 'approved'
          ? 'Project manager will route the approved work through the existing queue and report progress in this thread.'
          : proposal.status === 'feedback'
            ? 'The proposing role must review the owner reply, revise the proposal, and return it for approval.'
            : 'Proposal declined; preserve the thread as the decision record.',
    });
  }
  if (store.createExecutiveMessage) {
    store.createExecutiveMessage({
      actor: 'owner',
      body: input.decision_note || `Owner marked this proposal ${proposal.status}.`,
      work_id: workId,
      message_type: proposal.status === 'feedback' ? 'question' : 'decision_request',
      metadata: { proposal_id: proposal.proposal_id, status: proposal.status, to: proposal.created_by },
    });
  }
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

function review(store, id, input = {}) {
  const proposal = store.reviewExecutiveProposal(id, {
    status: input.status || 'reviewed',
    decision_note: input.decision_note || '',
    reviewed_by: input.reviewed_by || 'ceo',
  });
  const actionType = proposal.status === 'declined' ? 'decline' : 'feedback';
  const audit = action(store, {
    actor: input.reviewed_by || 'ceo',
    action_type: actionType,
    summary: `${actionType} CRO handoff: ${proposal.title}`,
    proposal_id: proposal.proposal_id,
  });
  finishAction(store, audit.action_id, {
    status: 'completed',
    result: { proposal_id: proposal.proposal_id, review: proposal.status },
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
  ownerRequest,
  ensureOwnerRequests,
  proposal,
  decision,
  review,
  action,
  finishAction,
};
