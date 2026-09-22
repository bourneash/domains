'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('./eventstore');
const executive = require('./executive');

function store() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-executive-'));
  fs.mkdirSync(path.join(root, 'sites', 'example.com'), { recursive: true });
  const db = eventstore.open(root);
  db.root = root;
  return db;
}

test('persists owner/CEO conversation messages', () => {
  const db = store();
  executive.message(db, {
    actor: 'ceo',
    body: 'Organic revenue is down on two sites.',
    metadata: { signal: 'analytics' },
  });
  executive.message(db, { actor: 'owner', body: 'Investigate and bring me a proposal.' });
  const messages = db.listExecutiveMessages();
  assert.equal(messages.length, 2);
  assert.equal(messages[1].metadata.signal, 'analytics');
  db.close();
});

test('requires owner decision and preserves feedback loop', () => {
  const db = store();
  const proposal = executive.proposal(db, {
    title: 'Refresh declining landing pages',
    proposal_type: 'growth',
    summary: 'Refresh five pages with measurable conversion targets.',
    requested_action: 'Approve research and implementation proposal.',
  });
  assert.throws(
    () => executive.decision(db, proposal.proposal_id, { status: 'approved', decided_by: 'cto' }),
    /only the owner/
  );
  const feedback = executive.decision(db, proposal.proposal_id, {
    status: 'feedback',
    decision_note: 'Bring a lower-cost test first.',
  });
  assert.equal(feedback.status, 'feedback');
  const approved = executive.decision(db, proposal.proposal_id, {
    status: 'approved',
    decision_note: 'Proceed with the test.',
  });
  assert.equal(approved.status, 'approved');
  db.close();
});

test('records and completes an auditable executive action', () => {
  const db = store();
  const action = executive.action(db, {
    actor: 'cto',
    action_type: 'research',
    summary: 'Inspect build failures',
  });
  assert.equal(db.listExecutiveActions({ actor: 'cto' })[0].status, 'started');
  const done = executive.finishAction(db, action.action_id, {
    status: 'completed',
    result: { findings: 3 },
  });
  assert.equal(done.status, 'completed');
  assert.equal(done.result.findings, 3);
  db.close();
});

test('allows the research officer to submit an executive proposal', () => {
  const db = store();
  const proposal = executive.proposal(db, {
    title: 'CRO GitHub trend digest',
    proposal_type: 'product',
    created_by: 'researcher',
    summary: 'Evidence-backed repository candidates.',
    requested_action: 'CEO and CTO review the candidates.',
  });
  assert.equal(proposal.created_by, 'researcher');
  db.close();
});

test('allows CFO and domain-manager messages and proposals', () => {
  const db = store();
  executive.message(db, { actor: 'cfo', body: 'Margin confidence is low.' });
  executive.message(db, {
    actor: 'domain-manager',
    body: 'The site needs a measured content test.',
  });
  const proposal = executive.proposal(db, {
    title: 'Site economics report',
    proposal_type: 'business',
    created_by: 'cfo',
    summary: 'Reconcile site revenue and costs.',
    requested_action: 'Approve a report-only review.',
  });
  assert.equal(proposal.created_by, 'cfo');
  assert.equal(db.listExecutiveMessages().length, 2);
  db.close();
});

test('allows Legal messages and proposals', () => {
  const db = store();
  executive.message(db, {
    actor: 'legal',
    body: 'Searchwoot needs a launch and compliance review.',
  });
  const proposal = executive.proposal(db, {
    title: 'Searchwoot launch-readiness review',
    proposal_type: 'business',
    created_by: 'legal',
    summary: 'Resolve the private-preview launch, disclosure, and compliance questions.',
    requested_action: 'Review the launch checklist with the owner.',
  });
  assert.equal(proposal.created_by, 'legal');
  assert.equal(db.listExecutiveMessages({ actor: 'legal' }).length, 1);
  db.close();
});

test('allows Security messages and proposals', () => {
  const db = store();
  executive.message(db, {
    actor: 'security',
    body: 'The launch needs a release and isolation review.',
  });
  const proposal = executive.proposal(db, {
    title: 'SearchWoot security launch review',
    proposal_type: 'report-only',
    created_by: 'security',
    summary: 'Review release, access, TLS, and supply-chain evidence before launch.',
    requested_action: 'Complete the bounded Security checklist.',
  });
  assert.equal(proposal.created_by, 'security');
  assert.equal(db.listExecutiveMessages({ actor: 'security' }).length, 1);
  db.close();
});

test('CEO can close a CRO handoff without granting owner approval', () => {
  const db = store();
  const proposal = executive.proposal(db, {
    title: 'CRO repository lead',
    proposal_type: 'product',
    created_by: 'researcher',
    summary: 'A candidate worth bounded validation.',
    requested_action: 'Validate fit and license.',
  });
  const reviewed = executive.review(db, proposal.proposal_id, {
    status: 'reviewed',
    reviewed_by: 'ceo',
    decision_note: 'Accepted for bounded research only.',
  });
  assert.equal(reviewed.status, 'reviewed');
  assert.equal(db.listExecutiveProposals({ status: 'proposed' }).length, 0);
  assert.equal(db.listExecutiveActions({ actor: 'ceo' })[0].action_type, 'feedback');
  db.close();
});

test('owner approval turns a bounded implementation into a linked change request', () => {
  const db = store();
  const proposal = executive.proposal(db, {
    title: 'Fix title metadata',
    proposal_type: 'growth',
    summary: 'Improve a reversible metadata issue.',
    requested_action: 'Approve the bounded task.',
    implementation: {
      site: 'example.com',
      title: 'Fix title metadata',
      body: 'Update the title tag only.',
      category: 'seo',
      priority: 'low',
      assigned_role: 'principal-engineer',
      provider: 'claude',
      max_turns: 4,
      auto_review: true,
    },
  });
  const approved = executive.decision(
    db,
    proposal.proposal_id,
    { status: 'approved' },
    { knownSite: site => site === 'example.com' }
  );
  assert.equal(approved.status, 'approved');
  assert.ok(approved.linked_request_id);
  assert.equal(db.getChangeRequest(approved.linked_request_id).site, 'example.com');
  assert.equal(db.getChangeRequest(approved.linked_request_id).assigned_role, 'seo-analyst');
  assert.equal(db.list({ event_type: 'executive.proposal.task-routed' }).length, 1);
  db.close();
});

test('requires Legal approval before a go-live proposal can route work', () => {
  const db = store();
  const proposal = executive.proposal(db, {
    title: 'Launch example.com',
    proposal_type: 'growth',
    summary: 'Remove the private preview gate after a documented launch review.',
    requested_action: 'Approve production launch after Legal review.',
    implementation: {
      site: 'example.com',
      launch_gate: 'go_live',
      title: 'Launch example.com',
      body: 'Publish the reviewed launch change.',
      category: 'engineering',
      priority: 'medium',
      assigned_role: 'engineer',
    },
  });
  assert.throws(
    () =>
      executive.decision(
        db,
        proposal.proposal_id,
        { status: 'approved' },
        { knownSite: site => site === 'example.com' }
      ),
    /approved Legal review/
  );
  const reviewed = executive.proposal(db, {
    title: 'Launch example.com with Legal review',
    proposal_type: 'growth',
    summary: 'Launch after the Legal pass approved the checklist.',
    requested_action: 'Approve production launch.',
    implementation: {
      site: 'example.com',
      launch_gate: 'go_live',
      legal_review: {
        status: 'approved',
        reviewed_by: 'legal',
        decision_note: 'Checklist passed.',
      },
      security_review: {
        status: 'approved',
        reviewed_by: 'security',
        decision_note: 'Release boundary passed.',
      },
      title: 'Launch example.com',
      body: 'Publish the reviewed launch change.',
      category: 'engineering',
      priority: 'medium',
      assigned_role: 'engineer',
    },
  });
  const approved = executive.decision(
    db,
    reviewed.proposal_id,
    { status: 'approved' },
    { knownSite: site => site === 'example.com' }
  );
  assert.equal(approved.status, 'approved');
  db.close();
});

test('owner approval can route the allowlisted fleet operation', () => {
  const db = store();
  const proposal = executive.proposal(db, {
    title: 'Publish the fleet operating baseline',
    proposal_type: 'report-only',
    summary: 'Create a factual baseline for portfolio prioritization.',
    requested_action: 'Run the allowlisted fleet baseline operation.',
    implementation: {
      site: 'fleet',
      action_key: 'publish-fleet-operating-baseline',
      delivery_mode: 'fleet_report',
      title: 'Publish fleet operating baseline',
      body: 'Write the current factual fleet operating baseline.',
      category: 'engineering',
      priority: 'low',
      assigned_role: 'engineer',
      provider: 'local',
      auto_review: true,
    },
  });
  const approved = executive.decision(
    db,
    proposal.proposal_id,
    { status: 'approved' },
    { knownSite: target => target === 'fleet' || target === 'example.com' }
  );
  assert.ok(approved.linked_request_id);
  assert.equal(db.getChangeRequest(approved.linked_request_id).site, 'fleet');
  assert.equal(
    db.getChangeRequest(approved.linked_request_id).action_key,
    'publish-fleet-operating-baseline'
  );
  db.close();
});
