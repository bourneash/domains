'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const followup = require('./executive-failure-followup');

function request(overrides = {}) {
  return {
    request_id: 'req-1',
    site: 'example.com',
    title: 'Improve the example page',
    status: 'failed',
    attempts: 3,
    review_attempts: 2,
    delivery_mode: 'direct',
    error: 'automatic reviewer rejected the change',
    ...overrides,
  };
}

test('classifies reviewer rejection as CTO-owned corrective work', () => {
  const out = followup.buildFollowup(request(), null);
  assert.equal(out.work_id, 'failed-change-request:req-1');
  assert.equal(out.owner, 'cto');
  assert.equal(out.kind, 'implementation');
  assert.match(out.next_action, /requeue/i);
});

test('classifies infrastructure failure as principal-engineer incident work', () => {
  const out = followup.classifyFailure(
    request({ error: 'automatic reviewer handoff was interrupted; retry required' }),
    null
  );
  assert.equal(out.owner, 'principal-engineer');
  assert.equal(out.kind, 'incident');
  assert.equal(out.priority, 'high');
});

test('does not reopen a completed repair case', () => {
  const existing = followup.buildFollowup(request(), null);
  const calls = { create: 0, update: 0 };
  const store = {
    getExecutiveWorkItem: () => ({ ...existing, status: 'done' }),
    createExecutiveWorkItem: () => {
      calls.create += 1;
    },
    updateExecutiveWorkItem: () => {
      calls.update += 1;
    },
  };
  const out = followup.upsert(store, request(), null);
  assert.equal(out.changed, false);
  assert.deepEqual(calls, { create: 0, update: 0 });
});

test('creates one durable repair case for a failed report request', () => {
  let created = null;
  const store = {
    getExecutiveWorkItem: () => null,
    createExecutiveWorkItem: payload => {
      created = payload;
      return payload;
    },
  };
  const out = followup.upsert(
    store,
    request({ delivery_mode: 'report_only', error: 'implementation agent ended failed' }),
    null
  );
  assert.equal(out.changed, true);
  assert.equal(out.created, true);
  assert.equal(created.kind, 'evidence');
  assert.equal(created.owner, 'cto');
});

test('exhausted review preserves exact failing audit in a security-owned case', () => {
  const q = request({ status: 'needs_human_review', error: 'quality gates did not pass' });
  const run = {
    run_id: 'original',
    state: 'failed',
    validation: {
      checks: {
        ci: {
          status: 'fail',
          excerpt:
            'npm audit --audit-level=high: http-cache-semantics high severity; no patched version',
        },
        build: { status: 'pass', excerpt: 'unrelated successful build' },
      },
    },
  };
  let saved;
  const out = followup.upsert(
    { getExecutiveWorkItem: () => null, createExecutiveWorkItem: p => (saved = p) },
    q,
    run
  );
  assert.equal(out.created, true);
  assert.equal(saved.owner, 'security');
  assert.equal(saved.kind, 'security');
  assert.match(saved.summary, /http-cache-semantics/);
  assert.doesNotMatch(saved.summary, /unrelated successful build/);
  assert.match(saved.next_action, /do not repeat unchanged/);
});
