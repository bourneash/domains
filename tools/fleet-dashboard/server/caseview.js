'use strict';

const ACTIVE_REQUEST_STATES = new Set(['claimed', 'running', 'reviewing']);
const TERMINAL_WORK_STATES = new Set(['done', 'cancelled']);

function iso(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function relatedRequests(events, work, proposal, requestRows) {
  const requests = requestRows || events.listChangeRequests({ limit: 1000 });
  const proposalId = proposal?.proposal_id || (work.source_type === 'executive-proposal' ? work.source_id : null);
  return requests.filter(request => {
    if (proposal?.linked_request_id && request.request_id === proposal.linked_request_id) return true;
    if (proposalId && request.source_proposal_id === proposalId) return true;
    if (work.source_type === 'change-request' && request.request_id === work.source_id) return true;
    if (request.source_work_id && request.source_work_id === work.work_id) return true;
    return false;
  });
}

function relatedRuns(events, requests) {
  const requestIds = new Set(requests.map(request => request.request_id));
  return events
    .listImprovements({ limit: 1000 })
    .filter(run => run.source_id && requestIds.has(run.source_id));
}

function currentState(work, requests, runs) {
  const activeRequest = requests.find(request => ACTIVE_REQUEST_STATES.has(request.status));
  const activeRun = runs.find(run => ['building', 'review'].includes(run.state));
  const measuring = runs.find(run => run.state === 'measuring');
  const failed = requests.find(request => request.status === 'failed') || runs.find(run => run.state === 'failed');
  const queued = requests.find(request => request.status === 'queued');
  if (activeRequest || activeRun) return { key: 'working', label: 'Being worked', tone: 'blue', detail: activeRequest?.title || activeRun?.title };
  if (measuring) return { key: 'measuring', label: 'Measuring outcome', tone: 'purple', detail: measuring.measurement_due ? `Window ends ${measuring.measurement_due}` : 'Measurement window active' };
  if (failed) return { key: 'failed', label: 'Failed', tone: 'red', detail: failed.error || failed.outcome?.error || 'Review failure evidence' };
  if (queued) return { key: queued.queue_block?.blocked ? 'blocked' : 'queued', label: queued.queue_block?.blocked ? 'Blocked' : 'Queued', tone: queued.queue_block?.blocked ? 'yellow' : 'blue', detail: queued.queue_block?.primary?.detail || 'Waiting for pickup' };
  if (!TERMINAL_WORK_STATES.has(work.status) && ['waiting', 'submitted', 'acknowledged'].includes(work.lifecycle_state)) return { key: 'waiting', label: 'Waiting for response', tone: 'yellow', detail: work.waiting_on || 'Next owner or team response' };
  if (work.status === 'blocked') return { key: 'blocked', label: 'Blocked', tone: 'red', detail: work.waiting_on || work.next_action || 'Needs intervention' };
  if (TERMINAL_WORK_STATES.has(work.status)) return { key: 'completed', label: 'Completed', tone: 'green', detail: work.outcome || work.resolution_note || 'Case closed' };
  return { key: work.status || 'open', label: String(work.status || 'Open').replaceAll('_', ' '), tone: 'blue', detail: work.next_action || 'Open case' };
}

function timeline(events, work, proposal, requests, runs) {
  const rows = [];
  for (const message of events.listExecutiveMessages({ work_id: work.work_id, limit: 500 })) {
    rows.push({
      at: message.created_at,
      type: 'message',
      actor: message.actor,
      label: message.message_type || 'message',
      body: message.body,
      id: message.message_id,
    });
  }
  const correlations = new Set([
    `executive-work-item:${work.work_id}`,
    proposal ? `executive-proposal:${proposal.proposal_id}` : null,
    ...requests.map(request => `change-request:${request.request_id}`),
    ...runs.map(run => run.correlation_id),
  ].filter(Boolean));
  for (const correlation_id of correlations) {
    for (const event of events.list({ correlation_id, limit: 500 })) {
      rows.push({
        at: event.occurred_at,
        type: 'event',
        actor: event.source || 'system',
        label: event.event_type,
        body: event.payload?.error || event.payload?.detail || event.payload?.reason || '',
        id: event.event_id,
      });
    }
  }
  return rows
    .filter(row => row.at)
    .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
    .filter((row, index, all) => index === all.findIndex(other => other.id === row.id))
    .slice(-1000);
}

function buildCase(events, work, requestRows) {
  const proposal = work.source_type === 'executive-proposal' && work.source_id
    ? events.getExecutiveProposal(work.source_id)
    : null;
  const requests = relatedRequests(events, work, proposal, requestRows);
  const runs = relatedRuns(events, requests);
  const state = currentState(work, requests, runs);
  const messages = events.listExecutiveMessages({ work_id: work.work_id, limit: 500 }).sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0));
  const latest = [...messages].reverse().find(Boolean);
  const latestRequest = [...requests].sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0))[0] || null;
  const latestRun = [...runs].sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0))[0] || null;
  return {
    case_id: `work:${work.work_id}`,
    title: work.title,
    site: work.site || proposal?.implementation?.site || latestRequest?.site || null,
    owner: work.owner,
    priority: work.priority,
    state,
    created_at: work.created_at,
    updated_at: work.updated_at,
    due_at: work.due_at,
    waiting_on: work.waiting_on,
    next_action: work.next_action,
    work,
    proposal,
    requests,
    runs,
    messages,
    latest_message: latest || null,
    latest_request: latestRequest,
    latest_run: latestRun,
    timeline: timeline(events, work, proposal, requests, runs),
    outcome: work.outcome || work.resolution_note || latestRun?.outcome || latestRequest?.error || null,
    links: {
      work_id: work.work_id,
      proposal_id: proposal?.proposal_id || null,
      request_ids: requests.map(request => request.request_id),
      run_ids: runs.map(run => run.run_id),
    },
  };
}

function listCases(events, { limit = 300, state, owner, q, enrichRequests } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  const requestRows = typeof enrichRequests === 'function'
    ? enrichRequests(events.listChangeRequests({ limit: 1000 }))
    : null;
  return events
    .listExecutiveWorkItems({ owner, limit: Math.min(1000, Math.max(1, Number(limit) || 300)) })
    .map(work => buildCase(events, work, requestRows))
    .filter(item => !state || item.state.key === state)
    .filter(item => !needle || `${item.title} ${item.site || ''} ${item.owner} ${item.state.label} ${item.state.detail}`.toLowerCase().includes(needle))
    .sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0));
}

function getCase(events, id, { enrichRequests } = {}) {
  const value = String(id || '');
  const workId = value.startsWith('work:') ? value.slice(5) : value;
  const work = events.getExecutiveWorkItem(workId);
  const requestRows = work && typeof enrichRequests === 'function'
    ? enrichRequests(events.listChangeRequests({ limit: 1000 }))
    : null;
  return work ? buildCase(events, work, requestRows) : null;
}

module.exports = { buildCase, listCases, getCase, currentState, timeline };
