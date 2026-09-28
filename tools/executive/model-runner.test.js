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
  assert.deepEqual(sanitized.change_requests, [{ site: 'safe.example', title: 'Safe bounded task' }]);
});
