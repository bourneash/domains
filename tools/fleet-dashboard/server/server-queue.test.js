'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  workerCompletionPath,
  interruptedWorkerRecoveryPath,
  shouldRetryQueueFailure,
  applyQualityPolicy,
} = require('./server');

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

test('interrupted report-only workers bypass the reviewer recovery path', () => {
  assert.equal(interruptedWorkerRecoveryPath({ delivery_mode: 'report_only' }), 'report-only');
  assert.equal(interruptedWorkerRecoveryPath({ delivery_mode: 'direct' }), 'review');
});

test('does not retry reviewer rejections or deterministic quality-gate failures', () => {
  assert.equal(shouldRetryQueueFailure('automatic reviewer rejected the change'), false);
  assert.equal(shouldRetryQueueFailure('quality gates did not pass', { passed: false }), false);
  assert.equal(
    shouldRetryQueueFailure('automatic reviewer handoff was interrupted; retry required'),
    true
  );
  assert.equal(shouldRetryQueueFailure('implementation agent ended failed'), true);
});

test('browser runtime warnings do not reject otherwise passing delivery gates', () => {
  const validation = applyQualityPolicy('/tmp/does-not-exist', 'example.com', {
    checks: { diff: { status: 'pass' }, tests: { status: 'pass' }, build: { status: 'pass' } },
    preview: { passed: true },
    browser: {
      passed: false,
      infrastructure_warning: true,
      lighthouse: { error: 'browser tab has unexpectedly crashed' },
    },
  });
  assert.equal(validation.passed, true);
  assert.equal(validation.policy.status.browser, 'warn');
});
