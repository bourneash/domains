'use strict';

// Reports are useful evidence, but they are not an executable delivery handoff.
// Keep the scheduler's outcome gate aligned with Exec Overwatch and the
// dashboard's implementation-slot accounting.
function executableRequests(requests = []) {
  return requests.filter(request =>
    ['direct', 'pull_request'].includes(String(request.delivery_mode || 'direct'))
  );
}

function executableWorkItems(store, items = [], windowStart = 0) {
  const executableKinds = new Set(['implementation', 'content', 'design', 'engineering', 'seo']);
  return items.filter(item => {
    if (
      !executableKinds.has(String(item.kind)) ||
      !item.site ||
      ['blocked', 'waiting', 'cancelled', 'done'].includes(String(item.status))
    )
      return false;
    // A planning or escalation workbench row is not a worker handoff. Only a
    // dispatch-backed run can make an executable work item count as delivery.
    return store
      .listAgentRuns({ work_id: item.work_id, limit: 10 })
      .some(
        run =>
          (Date.parse(run.started_at || '') || 0) >= windowStart &&
          !['failed', 'cancelled'].includes(String(run.status)) &&
          Boolean(store.getAgentDispatch(run.run_id))
      );
  });
}

function failedToDeliver({ exitCode, tickStatus, requests = [], workItems = [] } = {}) {
  return (
    exitCode === 0 &&
    tickStatus === 'completed' &&
    executableRequests(requests).length === 0 &&
    workItems.length === 0
  );
}

module.exports = { executableRequests, executableWorkItems, failedToDeliver };
