'use strict';

// Reports are useful evidence, but they are not an executable delivery handoff.
// Keep the scheduler's outcome gate aligned with Exec Overwatch and the
// dashboard's implementation-slot accounting.
function executableRequests(requests = []) {
  return requests.filter(request =>
    ['direct', 'pull_request'].includes(String(request.delivery_mode || 'direct'))
  );
}

function failedToDeliver({ exitCode, tickStatus, requests = [], workItems = [] } = {}) {
  return (
    exitCode === 0 &&
    tickStatus === 'completed' &&
    executableRequests(requests).length === 0 &&
    workItems.length === 0
  );
}

module.exports = { executableRequests, failedToDeliver };
