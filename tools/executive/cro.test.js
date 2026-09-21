'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cro = require('./cro');

function response(items) {
  return { ok: true, json: async () => ({ items }) };
}
function repo(name, stars) {
  return {
    full_name: name,
    html_url: `https://github.com/${name}`,
    description: 'A conversion experimentation and analytics toolkit',
    language: 'TypeScript',
    topics: ['conversion', 'analytics'],
    stargazers_count: stars,
    forks_count: 2,
    open_issues_count: 1,
    pushed_at: '2026-09-20T00:00:00Z',
    created_at: '2026-09-01T00:00:00Z',
  };
}

test('builds daily, weekly, and monthly GitHub queries', () => {
  const now = new Date('2026-09-20T12:00:00Z');
  assert.match(cro.searchUrl('daily', now), /pushed%3A%3E%3D2026-09-19/);
  assert.match(cro.searchUrl('weekly', now), /pushed%3A%3E%3D2026-09-13/);
  assert.match(cro.searchUrl('monthly', now), /pushed%3A%3E%3D2026-08-21/);
});

test('deduplicates candidates and creates purpose-scoped proposals', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cro-'));
  fs.mkdirSync(path.join(root, 'sites', 'example.com'), { recursive: true });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response([repo('acme/tool', 100), repo('other/tool', 50)]);
  };
  const now = new Date('2026-09-20T12:00:00Z');
  const first = await cro.run({ root, now, fetchImpl });
  const second = await cro.run({ root, now, fetchImpl });
  assert.equal(calls, 4);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.proposal.created_by, 'researcher');
  assert.match(first.proposal.rationale, /acme\/tool/);
  assert.equal(first.proposals.length, 2);
  assert.match(first.proposals[0].title, /CRO purpose opportunity/);
  assert.match(first.proposals[0].requested_action, /bounded follow-up research/);
  assert.ok(fs.existsSync(path.join(root, 'tools', 'executive', 'data', 'cro', '2026-09-20.json')));
  const { open } = require('../fleet-dashboard/server/eventstore');
  const store = open(root);
  const audit = store.listExecutiveActions({
    actor: 'researcher',
    action_type: 'research',
    limit: 10,
  });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].status, 'completed');
  store.close();
});
