'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const launchReadiness = require('./launch-readiness');

test('reads the active SearchWoot checklist and open evidence tasks', () => {
  const root = path.resolve(__dirname, '..', '..');
  const rows = launchReadiness.read(root, 'searchwoot.com');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tracking.status, 'active');
  assert.equal(rows[0].tracking.portfolio_owner, 'ceo');
  assert.equal(rows[0].tasks.filter(task => task.status === 'open').length, 4);
  assert.equal(rows[0].data_use_review.length, 4);
  assert.equal(rows[0].evidence_summary.source_rights.status, 'blocked');
  assert.match(rows[0].evidence_summary.source_rights.missing[0], /agreement|permission/);
  assert.match(rows[0].evidence_summary.source_rights.next_action, /written request/i);
  assert.equal(rows[0].evidence_summary.public_terms.status, 'draft_only');
});
