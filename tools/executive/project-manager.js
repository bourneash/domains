'use strict';

const changequeue = require('../fleet-dashboard/server/changequeue');
const workflowEngine = require('../fleet-dashboard/server/workflow-engine');

const IMPLEMENTATION_ROLES = ['engineer', 'principal-engineer'];
const PROPOSAL_WORK_PREFIX = 'executive-proposal:';
const LEGACY_PROPOSAL_WORK_PREFIX = 'approved-proposal:';

function proposalWorkId(proposal) {
  return `${PROPOSAL_WORK_PREFIX}${proposal.proposal_id}`;
}

function proposalWorkKind(proposal) {
  if (String(proposal.proposal_type || '').toLowerCase() === 'report-only') return 'research';
  if (String(proposal.created_by || '').toLowerCase() === 'security') return 'security';
  return 'decision';
}

function sameCaseFields(current, next) {
  return [
    'title', 'kind', 'status', 'priority', 'owner', 'source_type', 'source_id',
    'site', 'summary', 'next_action', 'waiting_on', 'due_at',
  ].every(key => String(current?.[key] ?? '') === String(next?.[key] ?? ''));
}

// A proposal is an approval record, but it also needs a durable case so the
// creator and owner have somewhere to continue the conversation. This is a
// migration-safe projection: existing proposals acquire a case on the next PM
// tick and repeated ticks never duplicate it.
function syncProposalCases(store, { limit = 200 } = {}) {
  const changed = [];
  for (const proposal of store
    .listExecutiveProposals({ limit })
    .filter(item => item.status !== 'declined')) {
    const workId = proposalWorkId(proposal);
    let existing = store.getExecutiveWorkItem(workId);
    const legacy = store.getExecutiveWorkItem(`${LEGACY_PROPOSAL_WORK_PREFIX}${proposal.proposal_id}`);
    if (!existing && legacy) {
      existing = store.createExecutiveWorkItem({
        ...legacy,
        work_id: workId,
        source_type: 'executive-proposal',
        source_id: proposal.proposal_id,
      });
    }
    if (legacy && legacy.work_id !== workId && legacy.status !== 'cancelled') {
      store.updateExecutiveWorkItem(legacy.work_id, {
        status: 'cancelled',
        waiting_on: null,
        resolution_note: `Migrated to canonical proposal case ${workId}; audit history retained.`,
      });
      if (store.createWorkflowLink) {
        store.createWorkflowLink({
          from_type: 'work-item', from_id: legacy.work_id,
          to_type: 'work-item', to_id: workId,
          relation: 'related_to', created_by: 'system',
        });
      }
    }
    // Approval is a handoff, not execution. Keep the case visibly waiting
    // until deterministic follow-through creates or links the actual work.
    const status = 'waiting';
    const waitingOn =
      proposal.status === 'approved'
        ? 'project-manager'
        : proposal.status === 'feedback'
          ? proposal.created_by || 'creator'
          : 'owner';
    const nextAction =
      proposal.status === 'approved'
        ? 'Project manager will route the approved work through the existing queue and report progress in this thread.'
        : proposal.status === 'feedback'
          ? 'The proposing role must review the owner reply, revise the proposal, and return it for approval.'
          : 'Owner decision required: approve, request changes, or decline. Continue discussion in this thread.';
    const payload = {
      work_id: workId,
      title: `Proposal thread: ${proposal.title}`,
      kind: proposalWorkKind(proposal),
      status,
      priority: 'normal',
      owner: 'project-manager',
      source_type: 'executive-proposal',
      source_id: proposal.proposal_id,
      site: proposal.implementation?.site || null,
      summary: proposal.summary,
      next_action: nextAction,
      waiting_on: waitingOn,
      due_at: proposal.updated_at
        ? new Date(Date.parse(proposal.updated_at) + (proposal.status === 'approved' ? 24 : 48) * 60 * 60 * 1000).toISOString()
        : new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      evidence: [
        {
          label: 'executive proposal',
          note: `${proposal.proposal_id}; created by ${proposal.created_by}; status=${proposal.status}`,
        },
      ],
      created_by: proposal.created_by || 'system',
    };
    const item = existing
      ? sameCaseFields(existing, payload)
        ? existing
        : store.updateExecutiveWorkItem(workId, payload)
      : store.createExecutiveWorkItem(payload);
    // Older owner replies were stored only on the proposal row. Backfill that
    // reply once so the new case thread starts with the actual conversation.
    if (
      proposal.decision_note &&
      store.createExecutiveMessage &&
      store.listExecutiveMessages({ work_id: workId, limit: 10 }).length === 0
    ) {
      store.createExecutiveMessage({
        actor: 'owner',
        body: proposal.decision_note,
        work_id: workId,
        message_type: proposal.status === 'feedback' ? 'question' : 'decision_request',
        metadata: { proposal_id: proposal.proposal_id, status: proposal.status, to: proposal.created_by },
        created_at: proposal.updated_at,
      });
    }
    changed.push(item);
    if (store.createWorkflowLink) {
      store.createWorkflowLink({
        from_type: 'proposal', from_id: proposal.proposal_id,
        to_type: 'work-item', to_id: workId,
        relation: 'related_to', created_by: 'system',
      });
    }
  }
  return changed;
}

function acceptanceCriteria(item) {
  const base = item.kind === 'implementation'
    ? `The requested change is implemented for ${item.site || 'the stated scope'}, deterministic tests pass, and the result is measurable with a rollback path.`
    : `The work produces a dated artifact or decision record, names its owner, and records the next measurable step.`;
  return /acceptance criteria/i.test(item.next_action || '')
    ? item.next_action
    : `${item.next_action || 'Complete the smallest useful next step.'}\nAcceptance criteria: ${base}`;
}

function ownerFor(item) {
  if (item.owner && item.owner !== 'owner' && item.owner !== 'ceo') return item.owner;
  if (item.kind === 'implementation' || item.kind === 'incident')
    return item.priority === 'urgent' ? 'principal-engineer' : 'engineer';
  if (item.kind === 'decision') return 'ceo';
  if (item.kind === 'security') return 'security';
  if (item.kind === 'legal') return 'legal';
  return 'domain-manager';
}

function alreadyQueued(store, item) {
  return store
    .listChangeRequests({ limit: 1000 })
    .some(request => request.requested_by === 'project-manager' && request.body.includes(`work_id: ${item.work_id}`));
}

function run(store, { knownSite = () => true, availableRolesForSite = () => [], limit = 20 } = {}) {
  const changed = [];
  const proposalCases = syncProposalCases(store, { limit: Math.max(20, Number(limit) || 20) });
  const workItems = store.listExecutiveWorkItems({ limit: 1000 });
  const boardItems = workItems.map(item => ({ ...item, source: 'work-item', id: item.work_id }));
  const workflow = workflowEngine.evaluate({ items: boardItems, links: store.listWorkflowLinks({ limit: 2000 }) });
  const dependencyChanges = [];
  for (const item of workItems.filter(row => ['open', 'blocked'].includes(row.status))) {
    const node = workflow.nodes[`work-item:${item.work_id}`];
    if (!node) continue;
    if (item.status === 'open' && !node.ready) {
      const waiting = node.blockers.join(', ');
      dependencyChanges.push(store.updateExecutiveWorkItem(item.work_id, {
        status: 'blocked', waiting_on: waiting,
        next_action: `Waiting for ${waiting} to complete before work can start. ${item.next_action || ''}`.trim(),
      }));
    } else if (item.status === 'blocked' && node.ready) {
      dependencyChanges.push(store.updateExecutiveWorkItem(item.work_id, {
        status: 'ready', waiting_on: null,
        next_action: `Dependency cleared. ${item.next_action || 'Ready for the next action.'}`,
      }));
    }
  }
  const candidates = store
    .listExecutiveWorkItems({ limit: 1000 })
    .filter(item => ['open', 'ready'].includes(item.status))
    .filter(item => workflow.nodes[`work-item:${item.work_id}`]?.ready)
    .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));

  for (const item of candidates) {
    const owner = ownerFor(item);
    const nextAction = acceptanceCriteria(item);
    const summary = item.summary || `Project-manager brief: ${item.title}. Scope: ${item.site || 'fleet-wide'}.`;
    const updated = store.updateExecutiveWorkItem(item.work_id, {
      owner,
      status: 'in_progress',
      summary,
      next_action: nextAction,
      created_by: item.created_by,
    });
    let request = null;
    if (
      item.kind === 'implementation' &&
      item.site &&
      knownSite(item.site) &&
      !alreadyQueued(store, item)
    ) {
      const roles = availableRolesForSite(item.site);
      const assignedRole = roles.includes(owner) ? owner : IMPLEMENTATION_ROLES.find(role => roles.includes(role));
      if (assignedRole) {
        request = changequeue.create(store, {
          site: item.site,
          title: item.title,
          body: `${summary}\n\n${nextAction}\n\nProject-manager work_id: ${item.work_id}`,
          category: 'engineering',
          priority: item.priority === 'urgent' ? 'high' : item.priority === 'low' ? 'low' : 'medium',
          assigned_role: assignedRole,
          provider: 'chatgpt',
          delivery_mode: 'direct',
          requested_by: 'project-manager',
          auto_review: true,
        }, knownSite, availableRolesForSite);
      }
    }
    changed.push({ work_item: updated, request });
  }
  return { inspected: candidates.length, proposal_cases: proposalCases, dependency_changes: dependencyChanges, alerts: workflow.alerts, critical_path: workflow.critical_path, changed };
}

module.exports = { acceptanceCriteria, ownerFor, proposalWorkId, syncProposalCases, run };
