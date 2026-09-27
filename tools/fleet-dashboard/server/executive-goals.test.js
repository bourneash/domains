'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('./eventstore');

function store() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-goals-'));
  return eventstore.open(root);
}

test('stores goal and work ancestry and rejects cycles', () => {
  const db = store();
  const company = db.createExecutiveGoal({
    title: 'Grow the portfolio',
    statement: 'Create attributable, durable portfolio value.',
    owner: 'ceo',
  });
  const team = db.createExecutiveGoal({
    title: 'Improve execution',
    statement: 'Ship bounded improvements and measure outcomes.',
    owner: 'cto',
    parent_goal_id: company.goal_id,
  });
  const parent = db.createExecutiveWorkItem({
    title: 'Select the next improvement',
    kind: 'decision',
    goal_id: team.goal_id,
    owner: 'cto',
  });
  const child = db.createExecutiveWorkItem({
    title: 'Validate the candidate',
    kind: 'research',
    goal_id: team.goal_id,
    parent_work_id: parent.work_id,
    owner: 'engineer',
  });
  assert.equal(db.getExecutiveWorkItem(child.work_id).parent_work_id, parent.work_id);
  assert.equal(db.getExecutiveWorkItem(child.work_id).goal_id, team.goal_id);
  assert.equal(db.getExecutiveGoal(team.goal_id).parent_goal_id, company.goal_id);
  assert.throws(
    () => db.updateExecutiveGoal(company.goal_id, { parent_goal_id: team.goal_id }),
    /goal hierarchy would create a cycle/
  );
  assert.throws(
    () => db.updateExecutiveWorkItem(parent.work_id, { parent_work_id: child.work_id }),
    /work hierarchy would create a cycle/
  );
  assert.throws(
    () =>
      db.createExecutiveWorkItem({
        title: 'Wrong branch',
        goal_id: company.goal_id,
        parent_work_id: child.work_id,
      }),
    /different goal/
  );
  db.close();
});

test('normalizes legacy evidence and enforces typed work products', () => {
  const db = store();
  const legacy = db.createExecutiveWorkItem({
    title: 'Keep a legacy source readable',
    kind: 'evidence',
    owner: 'ceo',
    evidence: [{ label: 'old report', note: 'historical evidence' }],
  });
  assert.equal(legacy.evidence[0].type, 'source');
  assert.equal(legacy.evidence_contract, 'executive-evidence/v1');

  const typed = db.createExecutiveWorkItem({
    title: 'Record a measured result',
    kind: 'evidence',
    owner: 'cto',
    evidence: [{ type: 'measurement', label: 'conversion rate', detail: '2.1%' }],
  });
  assert.equal(typed.evidence[0].type, 'measurement');
  assert.throws(
    () =>
      db.createExecutiveWorkItem({
        title: 'Reject unknown evidence',
        kind: 'evidence',
        owner: 'cto',
        evidence: [{ type: 'guess', note: 'not inspectable' }],
      }),
    /invalid evidence type/
  );
  const done = db.updateExecutiveWorkItem(typed.work_id, {
    status: 'done',
    evidence: [{ type: 'test', label: 'unit test', note: 'passed' }],
  });
  assert.equal(done.status, 'done');
  assert.equal(done.evidence[0].type, 'test');
  db.close();
});
