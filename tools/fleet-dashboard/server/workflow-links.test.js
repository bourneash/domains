'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const storeApi = require('./eventstore');

test('workflow links reject cycles and persist valid dependencies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-links-'));
  const store = storeApi.open(root, { file: path.join(root, 'events.sqlite') });
  const a = store.createExecutiveWorkItem({ title: 'A' });
  const b = store.createExecutiveWorkItem({ title: 'B' });
  store.createWorkflowLink({ from_type: 'work-item', from_id: a.work_id, to_type: 'work-item', to_id: b.work_id, relation: 'blocks' });
  assert.throws(() => store.createWorkflowLink({ from_type: 'work-item', from_id: b.work_id, to_type: 'work-item', to_id: a.work_id, relation: 'blocks' }), /circular dependency/);
  assert.equal(store.listWorkflowLinks({ entity_type: 'work-item', entity_id: b.work_id }).length, 1);
  store.close();
});
