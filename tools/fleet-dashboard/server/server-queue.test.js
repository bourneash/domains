'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  workerCompletionPath,
  interruptedWorkerRecoveryPath,
  isInfrastructureEvidence,
  reviewerProcessInfrastructureFailure,
  isSubstantiveReviewerRejection,
  validationInfrastructureBlock,
  shouldRetryQueueFailure,
  shouldPropagateCancelledRun,
  queueProjectionPath,
  shouldAutoRevalidateInfrastructureReview,
  shouldPreserveCompletedReviewerHandoff,
  infrastructureReviewProjectionPatch,
  shouldRecoverStaleDeliveryClaim,
  shouldResumePendingDelivery,
  shouldRecoverReviewerDeliveryClaim,
  shouldValidateBeforeDelivery,
  requiresInstalledSiteOwner,
  applyQualityPolicy,
} = require('./server');

test('a validated reviewer rejection does not inherit stale infrastructure evidence', () => {
  assert.equal(
    isSubstantiveReviewerRejection(new Error('automatic reviewer rejected the change'), {
      passed: true,
      preview: { passed: true },
    }),
    true
  );
  assert.equal(
    isSubstantiveReviewerRejection(new Error('OCI runtime exec failed during reviewer handoff'), {
      passed: true,
    }),
    false
  );
  const killedRun = { agent: { phase: 'reviewer', exit_code: 137 } };
  assert.equal(reviewerProcessInfrastructureFailure(killedRun), true);
  assert.equal(
    isSubstantiveReviewerRejection(
      new Error('automatic reviewer rejected the change'),
      { passed: true },
      killedRun
    ),
    false
  );
});

test('report-only requests do not require a site cron role', () => {
  assert.equal(requiresInstalledSiteOwner({ delivery_mode: 'report_only' }), false);
  assert.equal(requiresInstalledSiteOwner({ delivery_mode: 'direct' }), true);
});

test('a cancelled old run cannot tombstone a requeued or scheduled-retry request', () => {
  assert.equal(shouldPropagateCancelledRun({ status: 'queued' }), false);
  assert.equal(
    shouldPropagateCancelledRun({ status: 'failed', next_attempt_at: '2026-10-01T17:00:00Z' }),
    false
  );
  assert.equal(shouldPropagateCancelledRun({ status: 'running' }), true);
  assert.equal(shouldPropagateCancelledRun({ status: 'failed', next_attempt_at: null }), false);
});

test('verified deployment advances delivery-pending requests without an invalid committed step', () => {
  assert.deepEqual(queueProjectionPath('delivery_pending', 'deployed'), ['deployed']);
  assert.deepEqual(queueProjectionPath('delivery_pending', 'verified'), ['deployed', 'verified']);
  assert.deepEqual(queueProjectionPath('delivery_pending', 'review'), []);
});

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

test('classifies Docker worker disappearance as infrastructure evidence', () => {
  assert.equal(
    isInfrastructureEvidence('Error response from daemon: No such container: dd-imp-abc123'),
    true
  );
  assert.equal(
    isInfrastructureEvidence('OCI runtime exec failed: Resource temporarily unavailable'),
    true
  );
  assert.equal(isInfrastructureEvidence('reviewer rejected the requested content change'), false);
  assert.equal(
    shouldRetryQueueFailure('Error response from daemon: No such container: dd-imp-abc123'),
    true
  );
});

test('classifies delivery checkout conflicts as infrastructure evidence', () => {
  assert.equal(isInfrastructureEvidence('improvement worktree is on an unexpected branch'), true);
  assert.equal(isInfrastructureEvidence('Could not apply abc123 during rebase'), true);
  assert.equal(isInfrastructureEvidence('quality gates did not pass'), false);
});

test('classifies process exhaustion during validation as infrastructure evidence', () => {
  const validation = {
    passed: false,
    checks: {
      tests: {
        status: 'fail',
        excerpt: 'Error: spawn /usr/bin/node EAGAIN',
      },
    },
    preview: {
      passed: false,
      startup_error: 'HTTP no response; dev-server log: Local: http://localhost:4173/',
    },
  };
  assert.equal(isInfrastructureEvidence('Error: spawn /usr/bin/node EAGAIN'), true);
  assert.equal(validationInfrastructureBlock(validation), true);
});

test('keeps deterministic preview defects on the automatic repair path', () => {
  assert.equal(
    validationInfrastructureBlock({
      preview: {
        passed: false,
        checks: { internal_links: { status: 'fail', evidence: '/vessels/ (404)' } },
      },
      browser: {
        passed: true,
        screenshots: { preview: { status: 'warn', evidence: 'screenshot timed out' } },
      },
    }),
    false
  );
  assert.equal(
    validationInfrastructureBlock({
      preview: {
        passed: false,
        checks: { http: { status: 'fail', evidence: 'connection refused' } },
      },
    }),
    true
  );
});

test('site test failures are not infrastructure blocks because a screenshot timed out', () => {
  assert.equal(
    validationInfrastructureBlock({
      passed: false,
      checks: { tests: { status: 'fail', excerpt: 'AssertionError: expected valid content' } },
      browser: {
        passed: true,
        screenshots: { preview: { status: 'warn', evidence: 'screenshot timed out' } },
      },
    }),
    false
  );
});

test('measured Lighthouse quality failures are not infrastructure blocks', () => {
  assert.equal(
    validationInfrastructureBlock({
      passed: false,
      browser: {
        passed: false,
        infrastructure_warning: false,
        screenshots: { preview: { status: 'warn', evidence: 'screenshot timed out' } },
        lighthouse: { checks: { seo: { status: 'fail', evidence: '54/100; minimum 90' } } },
      },
    }),
    false
  );
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

test('preserved infrastructure reviews do not re-submit the same lifecycle status', () => {
  const patch = infrastructureReviewProjectionPatch(
    { status: 'blocked_infrastructure' },
    'implementation preserved; validation infrastructure blocked revalidation'
  );
  assert.equal(Object.hasOwn(patch, 'status'), false);
  assert.equal(patch.error.includes('preserved'), true);
  assert.equal(patch.next_attempt_at, null);

  assert.equal(
    infrastructureReviewProjectionPatch({ status: 'reviewing' }, 'blocked').status,
    'blocked_infrastructure'
  );
});

test('completed reviewer handoffs survive an expired queue lease', () => {
  assert.equal(
    shouldPreserveCompletedReviewerHandoff(
      { status: 'reviewing' },
      { state: 'building', agent: { phase: 'reviewer', status: 'completed' } }
    ),
    true
  );
  assert.equal(
    shouldPreserveCompletedReviewerHandoff(
      { status: 'reviewing' },
      { state: 'building', agent: { phase: 'implementation', status: 'completed' } }
    ),
    false
  );
});

test('stale delivery claims recover only after a validated reviewer handoff', () => {
  const now = Date.parse('2026-09-23T15:00:00.000Z');
  const run = {
    state: 'review',
    validation: { passed: true },
    outcome: {
      delivery_claimed: true,
      delivery_claimed_at: '2026-09-23T14:40:00.000Z',
    },
    agent: { phase: 'reviewer', status: 'completed' },
  };
  assert.equal(
    shouldRecoverStaleDeliveryClaim({ status: 'reviewing' }, run, now, 15 * 60 * 1000),
    true
  );
  assert.equal(
    shouldRecoverStaleDeliveryClaim({ status: 'reviewing' }, { ...run, state: 'building' }, now),
    false
  );
  assert.equal(
    shouldRecoverStaleDeliveryClaim(
      { status: 'reviewing' },
      { ...run, validation: { passed: false } },
      now
    ),
    false
  );
  assert.equal(
    shouldRecoverStaleDeliveryClaim(
      { status: 'reviewing' },
      { ...run, outcome: { ...run.outcome, delivery_claimed_at: '2026-09-23T14:50:00.000Z' } },
      now,
      15 * 60 * 1000
    ),
    false
  );
});

test('a pending delivery resumes only after a foreign claim is stale and review completed', () => {
  const now = Date.parse('2026-10-01T17:00:00.000Z');
  const run = {
    state: 'building',
    outcome: {
      delivery_claimed: true,
      delivery_claimed_at: '2026-10-01T16:40:00.000Z',
      delivery_claimed_by: 'old-dashboard',
    },
    agent: { phase: 'reviewer', status: 'completed', exit_code: 0 },
  };
  const pending = { status: 'delivery_pending' };
  assert.equal(shouldResumePendingDelivery(pending, run, 'new-dashboard', now), true);
  assert.equal(shouldResumePendingDelivery(pending, run, 'old-dashboard', now), false);
  assert.equal(
    shouldResumePendingDelivery(
      pending,
      { ...run, outcome: { ...run.outcome, delivery_claimed_at: '2026-10-01T16:50:00.000Z' } },
      'new-dashboard',
      now
    ),
    false
  );
  assert.equal(
    shouldResumePendingDelivery(
      pending,
      { ...run, agent: { ...run.agent, status: 'running' } },
      'new-dashboard',
      now
    ),
    false
  );
  assert.equal(
    shouldResumePendingDelivery({ status: 'reviewing' }, run, 'new-dashboard', now),
    false
  );
  assert.equal(
    shouldResumePendingDelivery(
      pending,
      { ...run, outcome: { ...run.outcome, delivery_blocked: true } },
      'new-dashboard',
      now
    ),
    false
  );
});

test('a completed reviewer can replace a prior worker claim during recovery', () => {
  const run = {
    state: 'building',
    outcome: { delivery_claimed: true, delivery_claimed_by: 'old-worker' },
    agent: { phase: 'reviewer', status: 'completed', exit_code: 0 },
  };
  assert.equal(
    shouldRecoverReviewerDeliveryClaim(
      { status: 'reviewing', lease_owner: 'current-worker' },
      run,
      'current-worker'
    ),
    true
  );
  assert.equal(
    shouldRecoverReviewerDeliveryClaim(
      { status: 'reviewing', lease_owner: 'other-worker' },
      run,
      'current-worker'
    ),
    true
  );
  assert.equal(
    shouldRecoverReviewerDeliveryClaim(
      { status: 'reviewing', lease_owner: 'current-worker' },
      { ...run, outcome: { ...run.outcome, delivery_claimed_by: 'current-worker' } },
      'current-worker'
    ),
    false
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

test('private noindex policy preserves browser gate for all other audit failures', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-private-quality-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ops = path.join(root, 'sites', 'private.example', 'ops');
  fs.mkdirSync(ops, { recursive: true });
  fs.writeFileSync(
    path.join(ops, 'change-queue-quality.json'),
    JSON.stringify({
      required: ['diff', 'tests', 'build', 'preview', 'browser'],
      allow_private_noindex: true,
    })
  );
  const input = {
    checks: { diff: { status: 'pass' }, tests: { status: 'pass' }, build: { status: 'pass' } },
    preview: { passed: true },
    browser: {
      passed: false,
      infrastructure_warning: false,
      screenshots: { preview: { status: 'warn' }, production: { status: 'pass' } },
      lighthouse: { seo_private_preview: true },
    },
  };
  const allowed = applyQualityPolicy(root, 'private.example', input);
  assert.equal(allowed.passed, true);
  assert.equal(allowed.policy.status.browser, 'pass');
  const otherFailure = applyQualityPolicy(root, 'private.example', {
    ...input,
    browser: { ...input.browser, lighthouse: { seo_private_preview: false } },
  });
  assert.equal(otherFailure.passed, false);
  const screenshotFailure = applyQualityPolicy(root, 'private.example', {
    ...input,
    browser: {
      ...input.browser,
      screenshots: { preview: { status: 'fail' } },
    },
  });
  assert.equal(screenshotFailure.passed, false);
  const publicSite = applyQualityPolicy(root, 'public.example', input);
  assert.equal(publicSite.passed, false);
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
