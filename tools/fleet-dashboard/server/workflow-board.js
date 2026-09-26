'use strict';
const workflowEngine = require('./workflow-engine');

function syncWorkflowNotifications(store, workflow) {
  if (!store.createExecutiveNotification) return [];
  return (workflow.alerts || []).map(alert =>
    store.createExecutiveNotification({
      recipient: 'owner',
      notification_type: `workflow-${alert.kind}`,
      title:
        alert.kind === 'cycle'
          ? 'Workflow dependency cycle'
          : `${alert.kind === 'overdue' ? 'Overdue work' : 'Blocked work'}: ${alert.title}`,
      body: alert.message,
      work_id: alert.node?.startsWith('work-item:') ? alert.node.slice('work-item:'.length) : null,
      dedupe_key: alert.dedupe_key,
    })
  );
}
function snapshot(store, { limit = 500 } = {}) {
  const requests = store.listChangeRequests({ limit });
  const workItems = store.listExecutiveWorkItems({ limit });
  const proposals = store.listExecutiveProposals({ limit });
  const links = store.listWorkflowLinks({ limit });
  const boardItems = [
    ...workItems.map(item => ({ ...item, source: 'work-item', id: item.work_id })),
    ...requests.map(item => ({ ...item, source: 'request', id: item.request_id })),
    ...proposals.map(item => ({ ...item, source: 'proposal', id: item.proposal_id })),
  ];
  const workflow = workflowEngine.evaluate({ items: boardItems, links });
  const diagnostics = [
    ...workflow.alerts.map(alert => ({
      ...alert,
      waiting_on: alert.node || null,
      next_action: alert.message,
    })),
    ...workItems
      .filter(item => ['blocked', 'waiting'].includes(item.status) || item.waiting_on)
      .map(item => ({
        source: 'work-item',
        id: item.work_id,
        title: item.title,
        status: item.status,
        waiting_on: item.waiting_on || null,
        next_action: item.next_action || 'No next action recorded.',
      })),
    ...requests
      .filter(request => ['queued', 'review', 'reviewing', 'failed'].includes(request.status))
      .map(request => ({
        source: 'request',
        id: request.request_id,
        title: request.title,
        status: request.status,
        waiting_on: request.status === 'queued' ? request.assigned_role || 'worker' : 'reviewer',
        next_action:
          request.status === 'failed'
            ? request.error || 'Inspect the failed request.'
            : request.status === 'queued'
              ? 'Waiting for an available worker slot.'
              : 'Review the request result and decide the next gate.',
      })),
  ].slice(0, 100);
  return {
    generated_at: new Date().toISOString(),
    requests,
    work_items: workItems,
    proposals,
    actions: store.listExecutiveActions({ limit }),
    events: store.list({ limit }),
    links,
    workflow,
    diagnostics,
    settings: {
      change_queue: store.getChangeQueueSettings(),
      executive: store.getExecutiveSettings(),
    },
  };
}
module.exports = { snapshot, syncWorkflowNotifications };
