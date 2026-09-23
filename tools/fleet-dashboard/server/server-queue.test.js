'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { workerCompletionPath } = require('./server');

test('successful report-only workers finalize evidence without a second model reviewer', () => {
  assert.equal(
    workerCompletionPath(
      { delivery_mode: 'report_only', auto_review: 1 },
      { code: 0, timedOut: false },
      { auto_review_enabled: true }
    ),
    'report-only'
  );
});

test('successful direct workers retain the independent reviewer gate', () => {
  assert.equal(
    workerCompletionPath(
      { delivery_mode: 'direct', auto_review: 1 },
      { code: 0, timedOut: false },
      { auto_review_enabled: true }
    ),
    'review'
  );
});

test('failed or timed-out workers never finalize automatically', () => {
  assert.equal(
    workerCompletionPath(
      { delivery_mode: 'report_only', auto_review: 1 },
      { code: 1, timedOut: false },
      { auto_review_enabled: true }
    ),
    'none'
  );
  assert.equal(
    workerCompletionPath(
      { delivery_mode: 'direct', auto_review: 1 },
      { code: 0, timedOut: true },
      { auto_review_enabled: true }
    ),
    'none'
  );
});
