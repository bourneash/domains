'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('./eventstore');
const liveness = require('./executive-liveness');

function store() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-liveness-'));
  return eventstore.open(root);
}

test('treats an owner wait and a dependency wait as healthy paths', () => {
  const db = store();
  db.createExecutiveWorkItem({ title: 'Owner decision', status: 'waiting', waiting_on: 'owner' });
  const blocker = db.createExecutiveWorkItem({ title: 'Evidence' });
  const dependent = db.createExecutiveWorkItem({ title: 'Decision', status: 'blocked' });
  db.createWorkflowLink({
    from_type: 'work-item',
    from_id: blocker.work_id,
    to_type: 'work-item',
    to_id: dependent.work_id,
    relation: 'blocks',
  });
  assert.equal(liveness.audit(db).healthy, true);
  db.close();
});

test('detects an expired execution lease without mutating or requeueing it', () => {
  const db = store();
  const item = db.createExecutiveWorkItem({
    title: 'Stranded execution',
    status: 'in_progress',
    owner: 'cto',
    lease_owner: 'worker-1',
    lease_expires_at: '2026-09-27T11:59:00.000Z',
    updated_at: '2026-09-27T11:50:00.000Z',
  });
  const result = liveness.audit(db, { now: new Date('2026-09-27T12:00:00.000Z') });
  assert.equal(result.healthy, false);
  assert.deepEqual(
    { ...result.stranded[0], age_ms: 0 },
    {
      work_id: item.work_id,
      title: 'Stranded execution',
      owner: 'cto',
      status: 'in_progress',
      reason: 'lease_expired',
      attempts: 0,
      age_ms: 0,
      recovery_key: `executive-liveness:${item.work_id}:lease_expired`,
      next_action:
        'Name a durable owner, retry, blocker, or explicit recovery action before continuing.',
    }
  );
  assert.equal(db.getExecutiveWorkItem(item.work_id).status, 'in_progress');
  db.close();
});

test('detects waiting work with no durable waiting path', () => {
  const db = store();
  const item = db.createExecutiveWorkItem({ title: 'Unexplained wait', status: 'waiting' });
  const result = liveness.audit(db);
  assert.equal(result.stranded[0].work_id, item.work_id);
  assert.equal(result.stranded[0].reason, 'waiting_without_durable_path');
  db.close();
});
