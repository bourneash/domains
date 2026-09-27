'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const caseview = require('./caseview');

function store(overrides = {}) {
  const work = overrides.work || {
    work_id: 'w1',
    title: 'Improve the homepage',
    kind: 'implementation',
    status: 'in_progress',
    priority: 'high',
    owner: 'project-manager',
    source_type: 'executive-proposal',
    source_id: 'p1',
    site: 'example.com',
    summary: 'Make the homepage clearer.',
    next_action: 'Route the approved change.',
    waiting_on: 'worker',
    created_at: '2026-09-26T10:00:00.000Z',
    updated_at: '2026-09-26T11:00:00.000Z',
  };
  return {
    getExecutiveWorkItem: id => (id === work.work_id ? work : null),
    getExecutiveProposal: id => (id === 'p1' ? { proposal_id: 'p1', title: 'Homepage', linked_request_id: 'r1' } : null),
    listExecutiveMessages: ({ work_id }) => work_id === work.work_id ? [{ message_id: 'm1', actor: 'owner', body: 'Please proceed.', message_type: 'update', created_at: '2026-09-26T10:30:00.000Z' }] : [],
    listChangeRequests: () => overrides.requests || [{ request_id: 'r1', title: 'Implement homepage', site: 'example.com', status: 'running', updated_at: '2026-09-26T11:30:00.000Z', run_id: 'run1' }],
    listImprovements: () => overrides.runs || [{ run_id: 'run1', source_id: 'r1', correlation_id: 'change-request:r1', site: 'example.com', title: 'Implement homepage', state: 'building', updated_at: '2026-09-26T11:20:00.000Z' }],
    list: () => [{ event_id: 'e1', occurred_at: '2026-09-26T11:10:00.000Z', event_type: 'change-request.started', source: 'fleet-dashboard', payload: {} }],
  };
}

test('builds one case across work, request, run, messages, and events', () => {
  const item = caseview.getCase(store(), 'work:w1');
  assert.equal(item.case_id, 'work:w1');
  assert.equal(item.state.key, 'working');
  assert.equal(item.requests[0].request_id, 'r1');
  assert.equal(item.runs[0].run_id, 'run1');
  assert.equal(item.messages[0].message_id, 'm1');
  assert.ok(item.timeline.some(row => row.type === 'message'));
  assert.ok(item.timeline.some(row => row.type === 'event'));
  assert.equal(item.links.proposal_id, 'p1');
});

test('surfaces blocked queue state and measurement outcome state', () => {
  const blocked = caseview.getCase(store({
    requests: [{ request_id: 'r1', title: 'Implement homepage', site: 'example.com', status: 'queued', queue_block: { blocked: true, primary: { detail: 'Measurement window active' } }, updated_at: '2026-09-26T11:30:00.000Z' }],
    runs: [],
  }), 'work:w1');
  assert.equal(blocked.state.key, 'blocked');
  const measuring = caseview.getCase(store({
    requests: [{ request_id: 'r1', title: 'Implement homepage', site: 'example.com', status: 'queued', updated_at: '2026-09-26T11:30:00.000Z' }],
    runs: [{ run_id: 'run1', source_id: 'r1', correlation_id: 'change-request:r1', site: 'example.com', title: 'Implement homepage', state: 'measuring', measurement_due: '2026-10-10', updated_at: '2026-09-26T11:20:00.000Z' }],
  }), 'work:w1');
  assert.equal(measuring.state.key, 'measuring');
  assert.match(measuring.state.detail, /2026-10-10/);
});
