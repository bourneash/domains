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

test('turns an owner request into a tracked executive work item and thread', () => {
  const db = store();
  const tracked = executive.ownerRequest(db, {
    actor: 'owner',
    body: 'Please investigate the decline and report back with a recommendation.',
  });
  assert.equal(tracked.message.work_id, tracked.work_item.work_id);
  assert.equal(tracked.message.message_type, 'decision_request');
  assert.equal(tracked.work_item.source_type, 'owner-request');
  assert.equal(tracked.work_item.status, 'waiting');
  assert.equal(db.listExecutiveMessages({ work_id: tracked.work_item.work_id }).length, 1);
  db.close();
});

test('backfills legacy owner messages into tracked requests', () => {
  const db = store();
  const legacy = db.createExecutiveMessage({ actor: 'owner', body: 'Where is the launch plan?' });
  const created = executive.ensureOwnerRequests(db);
  assert.equal(created.length, 1);
  assert.equal(db.listExecutiveMessages({ work_id: created[0].work_id })[0].message_id, legacy.message_id);
  assert.equal(db.listExecutiveWorkItems({ source_type: 'owner-request' })[0].summary, legacy.body);
  assert.deepEqual(executive.ensureOwnerRequests(db), []);
  db.close();
});

test('links replies by reply_to, advances the request, and creates an unread notification', () => {
  const db = store();
  const request = executive.ownerRequest(db, { actor: 'owner', body: 'Please bring back the launch decision.' });
  const reply = executive.message(db, {
    actor: 'ceo',
    body: 'Recommendation: keep the launch gated until the legal checklist is complete.',
    reply_to: request.message.message_id,
    message_type: 'decision_request',
  });
  assert.equal(reply.work_id, request.work_item.work_id);
  assert.equal(db.getExecutiveWorkItem(request.work_item.work_id).status, 'in_progress');
  const notification = db.listExecutiveNotifications({ unread: true })[0];
  assert.equal(notification.work_id, request.work_item.work_id);
  assert.equal(notification.message_id, reply.message_id);
  db.markExecutiveNotificationRead(notification.notification_id);
  assert.equal(db.listExecutiveNotifications({ unread: true }).length, 0);
  db.close();
});

test('acknowledges owner requests when downstream work is handed off', () => {
  const db = store();
  const request = executive.ownerRequest(db, {
    actor: 'owner',
    body: 'Please add our Bluesky links to the sites.',
  });
  const first = executive.acknowledgeOwnerRequestHandoff(db, request.work_item.work_id, {
    downstream_type: 'change-request',
    downstream_id: 'change-123',
    title: 'Add social profile links',
    site: 'example.com',
  });
  assert.match(first.body, /queued agents/);
  assert.equal(first.work_id, request.work_item.work_id);
  assert.equal(first.reply_to, request.message.message_id);
  assert.equal(db.getExecutiveWorkItem(request.work_item.work_id).lifecycle_state, 'actioned');
  assert.equal(db.getExecutiveWorkItem(request.work_item.work_id).waiting_on, 'worker');
  assert.equal(db.listExecutiveMessages({ work_id: request.work_item.work_id }).length, 2);
  const retry = executive.acknowledgeOwnerRequestHandoff(db, request.work_item.work_id, {
    downstream_type: 'change-request',
    downstream_id: 'change-123',
    title: 'Add social profile links',
    site: 'example.com',
  });
  assert.equal(retry.message_id, first.message_id);
  assert.equal(db.listExecutiveMessages({ work_id: request.work_item.work_id }).length, 2);
  db.close();
});

test('enforces owner-request lifecycle transitions and requires a close outcome', () => {
  const db = store();
  const request = executive.ownerRequest(db, { actor: 'owner', body: 'Track the release decision.' });
  assert.throws(
    () => executive.transitionOwnerRequest(db, request.work_item.work_id, 'closed'),
    /requires an outcome/
  );
  const acknowledged = executive.transitionOwnerRequest(db, request.work_item.work_id, 'acknowledged');
  assert.equal(acknowledged.lifecycle_state, 'acknowledged');
  const closed = executive.transitionOwnerRequest(db, request.work_item.work_id, 'closed', { outcome: 'Decision recorded in the release plan.' });
  assert.equal(closed.lifecycle_state, 'closed');
  assert.equal(closed.status, 'done');
  assert.equal(closed.outcome, 'Decision recorded in the release plan.');
  assert.throws(
    () => executive.transitionOwnerRequest(db, request.work_item.work_id, 'answered'),
    /cannot move owner request from closed/
  );
  db.close();
});

test('persists notification delivery attempts for retryable external delivery', () => {
  const db = store();
  const notification = db.createExecutiveNotification({
    title: 'Executive reply',
    body: 'A response is ready.',
    dedupe_key: 'test-notification-1',
  });
  assert.equal(notification.delivery_status, 'pending');
  const retry = db.updateExecutiveNotificationDelivery(notification.notification_id, {
    delivery_status: 'pending',
    delivery_attempts: 2,
    last_error: 'webhook unavailable',
  });
  assert.equal(retry.delivery_attempts, 2);
  assert.equal(retry.last_error, 'webhook unavailable');
  const duplicate = db.createExecutiveNotification({
    title: 'Duplicate', body: 'ignored', dedupe_key: 'test-notification-1',
  });
  assert.equal(duplicate.notification_id, notification.notification_id);
  db.close();
});

test('leases executive work atomically and reports scheduler health', () => {
  const db = store();
  const item = db.createExecutiveWorkItem({ title: 'Lease me', kind: 'research', status: 'ready', owner: 'project-manager' });
  const claimed = db.claimExecutiveWorkItem(item.work_id, 'project-manager', 60);
  assert.equal(claimed.lease_owner, 'project-manager');
  assert.equal(claimed.attempts, 1);
  assert.equal(db.claimExecutiveWorkItem(item.work_id, 'another-worker', 60), null);
  assert.ok(db.heartbeatExecutiveWorkItem(item.work_id, 'project-manager', 60));
  assert.equal(db.releaseExecutiveWorkItem(item.work_id, 'another-worker'), null);
  assert.equal(db.releaseExecutiveWorkItem(item.work_id, 'project-manager').lease_owner, null);
  const status = executive.health(db);
  assert.equal(status.scheduler.status, 'never-run');
  assert.equal(status.ok, false);
  db.close();
});

test('escalates overdue work once per SLA level', () => {
  const db = store();
  const item = db.createExecutiveWorkItem({
    title: 'Overdue evidence', kind: 'research', owner: 'security', created_by: 'owner',
    status: 'waiting', due_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });
  assert.equal(executive.escalateOverdueWorkItems(db).length, 1);
  assert.equal(executive.escalateOverdueWorkItems(db).length, 0);
  assert.equal(db.listExecutiveNotifications({ work_id: item.work_id }).length, 1);
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
  const workId = `executive-proposal:${proposal.proposal_id}`;
  assert.equal(db.getExecutiveWorkItem(workId).status, 'waiting');
  assert.equal(db.listExecutiveMessages({ work_id: workId })[0].actor, 'owner');
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

test('persists and updates assistive executive workbench cases', () => {
  const db = store();
  const item = db.createExecutiveWorkItem({
    title: 'Confirm affiliate disclosure requirements',
    kind: 'legal',
    owner: 'legal',
    priority: 'high',
    summary: 'The launch checklist needs a source-backed disclosure decision.',
    next_action: 'Review the current site facts and record the smallest evidence gap.',
    evidence: [{ label: 'site facts', url: '/api/sitefacts', note: 'current baseline' }],
    created_by: 'system',
  });
  assert.equal(db.listExecutiveWorkItems({ owner: 'legal' })[0].work_id, item.work_id);
  const updated = db.updateExecutiveWorkItem(item.work_id, {
    status: 'blocked',
    next_action: 'Escalate the unresolved jurisdiction question to counsel.',
  });
  assert.equal(updated.status, 'blocked');
  assert.equal(updated.evidence[0].label, 'site facts');
  assert.throws(
    () => db.updateExecutiveWorkItem(item.work_id, { owner: 'not-a-role' }),
    /invalid work item owner/
  );
  db.close();
});

test('curates knowledge with provenance and a role learning queue', () => {
  const db = store();
  const source = db.createExecutiveKnowledge({
    title: 'FTC Endorsement Guides',
    resource_type: 'official',
    audience: 'legal',
    status: 'queued',
    url: 'https://www.ftc.gov/business-guidance/advertising-marketing/endorsements-influencers-reviews',
    publisher: 'Federal Trade Commission',
    jurisdiction: 'US',
    license: 'official government guidance',
    summary: 'Primary source for disclosure triage.',
    tags: ['disclosure', 'affiliate'],
  });
  assert.equal(
    db.listExecutiveKnowledge({ audience: 'legal' })[0].knowledge_id,
    source.knowledge_id
  );
  const complete = db.updateExecutiveKnowledge(source.knowledge_id, {
    status: 'complete',
    takeaway: 'Disclosures must be clear and conspicuous.',
    applied_to: 'Affiliate launch checklist',
    reviewed_by: 'legal',
  });
  assert.equal(complete.status, 'complete');
  assert.equal(complete.takeaway, 'Disclosures must be clear and conspicuous.');
  assert.equal(complete.applied_to, 'Affiliate launch checklist');
  assert.throws(
    () => db.createExecutiveKnowledge({ title: 'Unsafe', url: 'javascript:alert(1)' }),
    /http/
  );
  db.close();
});

test('threads role handoffs to a durable workbench case', () => {
  const db = store();
  const item = db.createExecutiveWorkItem({
    title: 'Review security baseline',
    kind: 'security',
    owner: 'security',
  });
  const message = db.createExecutiveMessage({
    actor: 'security',
    body: 'Baseline reviewed; one evidence gap remains.',
    work_id: item.work_id,
    message_type: 'handoff',
    metadata: { to: 'cto' },
  });
  const thread = db.listExecutiveMessages({ work_id: item.work_id });
  assert.equal(thread[0].message_id, message.message_id);
  assert.equal(thread[0].message_type, 'handoff');
  assert.equal(thread[0].metadata.to, 'cto');
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

test('allows both product managers to present executive work', () => {
  const db = store();
  executive.message(db, {
    actor: 'product-manager-fleet',
    body: 'Fleet tooling recommendation.',
  });
  const proposal = executive.proposal(db, {
    title: 'Fleet product improvement',
    proposal_type: 'product',
    created_by: 'product-manager-sites',
    summary: 'Improve a measurable site product outcome.',
    requested_action: 'CEO and CTO review the bounded recommendation.',
  });
  assert.equal(proposal.created_by, 'product-manager-sites');
  assert.equal(db.listExecutiveMessages()[0].actor, 'product-manager-fleet');
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
