'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  workerCompletionPath,
  interruptedWorkerRecoveryPath,
  shouldRetryQueueFailure,
  shouldAutoRevalidateInfrastructureReview,
  shouldValidateBeforeDelivery,
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

test('versioned validation fixes reopen each preserved infrastructure review at most once', () => {
  const request = { status: 'review' };
  const run = {
    state: 'review',
    outcome: { infrastructure_blocked: true },
  };
  assert.equal(shouldAutoRevalidateInfrastructureReview(request, run, 'ipv4-preview-v1'), true);
  assert.equal(
    shouldAutoRevalidateInfrastructureReview(
      request,
      {
        ...run,
        outcome: { ...run.outcome, infrastructure_revalidation_version: 'ipv4-preview-v1' },
      },
      'ipv4-preview-v1'
    ),
    false
  );
  assert.equal(
    shouldAutoRevalidateInfrastructureReview(
      request,
      { ...run, state: 'failed' },
      'ipv4-preview-v1'
    ),
    false
  );
  assert.equal(
    shouldAutoRevalidateInfrastructureReview(
      request,
      {
        ...run,
        state: 'building',
        agent: { phase: 'reviewer', status: 'completed', exit_code: 0 },
      },
      'ipv4-preview-v1'
    ),
    true
  );
});

test('a passing review is delivered idempotently without running validation a second time', () => {
  assert.equal(shouldValidateBeforeDelivery({ state: 'building', validation: null }), true);
  assert.equal(
    shouldValidateBeforeDelivery({ state: 'review', validation: { passed: false } }),
    true
  );
  assert.equal(
    shouldValidateBeforeDelivery({ state: 'review', validation: { passed: true } }),
    false
  );
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

test('preview infrastructure failures remain a review block, not a code failure', () => {
  const validation = applyQualityPolicy('/tmp/does-not-exist', 'example.com', {
    checks: { diff: { status: 'pass' }, tests: { status: 'pass' }, build: { status: 'pass' } },
    preview: {
      passed: false,
      error: 'curl: (7) Failed to connect to 127.0.0.1 port 4321',
    },
    browser: {
      passed: false,
      infrastructure_warning: false,
      lighthouse: { error: 'Chrome prevented page load with an interstitial' },
    },
  });
  assert.equal(validation.passed, false);
  assert.equal(validation.policy.status.preview, 'fail');
  assert.equal(validation.policy.status.browser, 'fail');
});
