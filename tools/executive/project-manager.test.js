'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('../fleet-dashboard/server/eventstore');
const manager = require('./project-manager');

test('triages backlog work, writes acceptance criteria, and queues implementation safely', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-pm-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  store.createExecutiveWorkItem({ title: 'Fix checkout', kind: 'implementation', site: 'example.com', owner: 'owner', summary: 'Repair the checkout path.' });
  const result = manager.run(store, { knownSite: site => site === 'example.com', availableRolesForSite: () => ['engineer'] });
  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0].work_item.owner, 'engineer');
  assert.match(result.changed[0].work_item.next_action, /Acceptance criteria/);
  assert.equal(result.changed[0].request.requested_by, 'project-manager');
  assert.match(result.changed[0].request.body, /work_id:/);
  store.close();
});

test('backfills proposal cases so owner replies have a durable thread', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-pm-proposal-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  const proposal = store.createExecutiveProposal({
    title: 'Maintain private security gate for gated product',
    proposal_type: 'report-only',
    created_by: 'security',
    summary: 'Keep the private gate while the product remains gated.',
    requested_action: 'Confirm the gate evidence and follow-up checklist.',
  });
  const result = manager.run(store, { limit: 20 });
  assert.equal(result.proposal_cases.length, 1);
  const item = store.getExecutiveWorkItem(`executive-proposal:${proposal.proposal_id}`);
  assert.equal(item.status, 'waiting');
  assert.equal(item.owner, 'project-manager');
  assert.equal(item.source_id, proposal.proposal_id);
  const updatedAt = item.updated_at;
  manager.syncProposalCases(store, { limit: 20 });
  assert.equal(store.getExecutiveWorkItem(item.work_id).updated_at, updatedAt);
  store.close();
});

test('migrates the legacy approved case without deleting its audit record', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-pm-migrate-'));
  const store = eventstore.open(root, { file: path.join(root, 'events.sqlite') });
  const proposal = store.createExecutiveProposal({
    title: 'Legacy proposal',
    proposal_type: 'report-only',
    created_by: 'security',
    summary: 'A legacy case needs one canonical identity.',
    requested_action: 'Keep the evidence trail intact.',
    status: 'approved',
  });
  store.createExecutiveWorkItem({
    work_id: `approved-proposal:${proposal.proposal_id}`,
    title: 'Legacy follow through',
    kind: 'research',
    status: 'in_progress',
    owner: 'security',
    source_type: 'approved-proposal',
    source_id: proposal.proposal_id,
  });
  manager.syncProposalCases(store, { limit: 20 });
  assert.equal(store.getExecutiveWorkItem(`executive-proposal:${proposal.proposal_id}`).source_id, proposal.proposal_id);
  assert.equal(store.getExecutiveWorkItem(`approved-proposal:${proposal.proposal_id}`).status, 'cancelled');
  assert.equal(store.listWorkflowLinks({ entity_type: 'proposal', entity_id: proposal.proposal_id }).length, 1);
  store.close();
});
