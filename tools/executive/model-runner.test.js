'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergePassPlans } = require('./model-runner');
const runner = require('./runner');

test('review passes cannot erase earlier queue work by returning empty arrays', () => {
  const previous = {
    messages: [{ actor: 'ceo', body: 'Recommendation: ship the bounded test.' }],
    proposals: [{ title: 'proposal' }],
    change_requests: [{ site: 'example.com', title: 'bounded test' }],
    research_requests: [{ url: 'https://example.com', question: 'check' }],
    work_items: [{ title: 'follow up' }],
    knowledge: [{ title: 'reference' }],
    data_requests: [{ requested_by: 'cto', question: 'check' }],
    proposal_reviews: [{ proposal_id: 'p1', status: 'accepted_research' }],
  };
  const next = {
    messages: [{ actor: 'cto', body: 'Technically bounded.' }],
    proposals: [],
    change_requests: [],
    research_requests: [],
    work_items: [],
    knowledge: [],
    data_requests: [],
    proposal_reviews: [],
  };
  const merged = mergePassPlans(previous, next);
  assert.deepEqual(merged.change_requests, previous.change_requests);
  assert.deepEqual(merged.proposals, previous.proposals);
  assert.equal(merged.messages.length, 2);
});

test('a review pass with an explicit replacement list can revise queue work', () => {
  const merged = mergePassPlans(
    { messages: [], change_requests: [{ site: 'old.example', title: 'old' }] },
    { messages: [], change_requests: [{ site: 'new.example', title: 'new' }] }
  );
  assert.deepEqual(merged.change_requests, [{ site: 'new.example', title: 'new' }]);
});

test('provider plan sanitization drops only excluded items and preserves safe work', () => {
  const sanitized = runner.sanitizeExcludedPlanItems({
    messages: [
      { actor: 'ceo', body: 'Safe recommendation.' },
      { actor: 'ceo', body: 'Do not mention 3boobs.com.' },
    ],
    change_requests: [
      { site: 'safe.example', title: 'Safe bounded task' },
      { site: '3boobs.com', title: 'Out of scope task' },
    ],
    proposals: [],
  });
  assert.deepEqual(sanitized.messages, [{ actor: 'ceo', body: 'Safe recommendation.' }]);
  assert.deepEqual(sanitized.change_requests, [
    { site: 'safe.example', title: 'Safe bounded task' },
  ]);
});

test('initial and repair prompts retain exact original recovery context and aliases', () => {
  const { buildModelPrompt } = require('./model-runner');
  const brief = {
    generated_at: '2026-10-03',
    sites: ['example.com'],
    intelligence: {},
    task_queue: {},
    improvements: [],
    work_items: [],
    overwatch_directive: {
      delivery_recovery_cases: [
        {
          case_ref: 'RECOVERY_1',
          work_id: 'queued-delivery:original',
          site: 'example.com',
          original_request: { request_id: 'original', body: 'Exact reviewed three-link repair' },
        },
      ],
    },
  };
  for (const role of ['reviewer', 'ceo']) {
    const prompt = buildModelPrompt(brief, role, {});
    assert.match(prompt, /EXEC OVERWATCH DIRECTIVE/);
    assert.match(prompt, /RECOVERY_1/);
    assert.match(prompt, /queued-delivery:original/);
    assert.match(prompt, /Exact reviewed three-link repair/);
  }
});

test('scoped repair preserves exact source and actual delivery enum without fleet expansion', () => {
  const { buildModelPrompt, buildRepairDirective } = require('./model-runner');
  const sha = 'd'.repeat(40);
  const brief = {
    intelligence: {},
    sites: ['example.com'],
    task_queue: {},
    improvements: [],
    work_items: [],
    domain_manager: {
      site: 'example.com',
      source_revision: { status: 'fresh-remote-source', commit: sha },
      source_documents: [{ path: 'site/src/pages/index.astro' }],
    },
  };
  const prompt = buildModelPrompt(brief, 'ceo', {});
  assert.ok(prompt.includes('Copy this full commit unchanged into change_request.body: ' + sha));
  assert.match(prompt, /site_change is invalid/);
  assert.match(prompt, /persistent underline is a non-color distinction/);
  const directive = buildRepairDirective(brief);
  assert.match(directive, /at most one/);
  assert.doesNotMatch(directive, /six|three eligible/);
  const recovery = buildRepairDirective({
    ...brief,
    overwatch_directive: { delivery_recovery_cases: [{ case_ref: 'RECOVERY_1' }] },
  });
  assert.match(recovery, /original recovery cases/);
  assert.match(recovery, /Do not create a duplicate/);
  assert.doesNotMatch(recovery, /one source-backed engineer implementation/);
});
