'use strict';

const crypto = require('node:crypto');
const improvements = require('../fleet-dashboard/server/improvements');
const executionGates = require('../fleet-dashboard/server/execution-gates');

function conflict(message) {
  const error = new Error(message);
  error.httpStatus = 409;
  return error;
}

// A published delivery remains the original request. The recovery case owns
// a bounded continuation lease; it never requeues or replaces the published PR.
function begin(
  store,
  { requestId, headSha, baseSha, observationSha = '', leaseOwner = crypto.randomUUID() }
) {
  const request = store.getChangeRequest(requestId);
  const run = request?.run_id && store.getImprovement(request.run_id);
  const workId = `delivery-recovery:${requestId}`;
  const item = store.getExecutiveWorkItem(workId);
  const pr = run?.approval?.pull_request;
  if (
    !request ||
    request.status !== 'committed' ||
    !run ||
    run.state !== 'review' ||
    !run.workspace_path ||
    !run.branch ||
    !pr?.url ||
    pr.state === 'merged' ||
    pr.head_sha !== headSha ||
    !/^[a-f0-9]{40}$/i.test(baseSha || '') ||
    !item ||
    item.source_id !== requestId ||
    item.site !== request.site
  )
    throw conflict(
      'published repair requires the original open PR, reviewed workspace, current head, and linked recovery case'
    );
  executionGates.assertReady(request);
  if (observationSha && !/^[a-f0-9]{64}$/i.test(observationSha))
    throw conflict('repair observation must be a persisted evidence digest');
  const fingerprint = `${headSha}:${baseSha}${observationSha ? ':' + observationSha : ''}`;
  if ((item.labels || []).includes(`repair-observation:${fingerprint}`))
    throw conflict('unchanged delivery evidence has already received a bounded repair');
  if (Number(item.attempts || 0) >= 3)
    throw conflict('published delivery exhausted its bounded recovery attempts');
  const claimed = store.claimExecutiveWorkItem(workId, leaseOwner, 1800);
  if (!claimed) throw conflict('delivery recovery is owned by another run');
  try {
    const updated = store.updateExecutiveWorkItem(workId, {
      labels: [...new Set([...(claimed.labels || []), `repair-observation:${fingerprint}`])],
      next_action:
        'Repair the original isolated branch, run canonical CI, review the diff, and update the same PR. Production release remains gated.',
    });
    const repairRun = improvements.transition(store, run.run_id, {
      state: 'building',
      validation: {
        passed: false,
        invalidated_by: 'published-repair',
        reason: 'Branch content and CI must be validated again after repair',
      },
      outcome: {
        ...run.outcome,
        published_repair: {
          work_id: workId,
          lease_owner: leaseOwner,
          head_sha: headSha,
          base_sha: baseSha,
          observation_sha: observationSha || null,
          started_at: new Date().toISOString(),
        },
      },
    });
    store.record({
      event_type: 'delivery.repair_started',
      source: 'published-repair',
      entity_type: 'change-request',
      entity_id: requestId,
      site_id: `site:${request.site}`,
      payload: {
        run_id: run.run_id,
        work_id: workId,
        head_sha: headSha,
        base_sha: baseSha,
        observation_sha: observationSha || null,
        lease_owner: leaseOwner,
      },
    });
    return { request, run: repairRun, item: updated, leaseOwner };
  } catch (error) {
    store.releaseExecutiveWorkItem(workId, leaseOwner, { last_error: error.message });
    throw error;
  }
}

function finish(store, { requestId, leaseOwner, passed, evidence }) {
  const workId = `delivery-recovery:${requestId}`;
  const item = store.getExecutiveWorkItem(workId);
  const request = store.getChangeRequest(requestId);
  const run = request?.run_id && store.getImprovement(request.run_id);
  if (
    !item ||
    item.lease_owner !== leaseOwner ||
    !run ||
    run.outcome?.published_repair?.lease_owner !== leaseOwner
  )
    throw conflict('stale repair callback cannot modify delivery ownership');
  if (
    !evidence ||
    (passed &&
      (!evidence.canonical_ci_passed ||
        evidence.validation?.passed !== true ||
        evidence.validation?.checks?.ci?.status !== 'pass'))
  )
    throw conflict('repair completion requires actual canonical CI evidence');
  if (passed && run.state === 'building')
    improvements.transition(store, run.run_id, {
      state: 'review',
      validation: evidence.validation,
      outcome: {
        ...run.outcome,
        published_repair: {
          ...run.outcome.published_repair,
          finished_at: new Date().toISOString(),
          passed: !!passed,
          evidence,
        },
      },
    });
  if (!passed)
    store.updateImprovement(run.run_id, {
      outcome: {
        ...run.outcome,
        published_repair: {
          ...run.outcome.published_repair,
          finished_at: new Date().toISOString(),
          passed: false,
          evidence,
        },
      },
    });
  store.record({
    event_type: 'delivery.repair_finished',
    source: 'published-repair',
    entity_type: 'change-request',
    entity_id: requestId,
    site_id: `site:${request.site}`,
    payload: { run_id: run.run_id, work_id: workId, passed: !!passed, evidence },
  });
  return store.releaseExecutiveWorkItem(workId, leaseOwner, {
    status: passed ? 'waiting' : 'blocked',
    last_error: passed ? null : String(evidence.error || 'published branch repair failed'),
    next_action: passed
      ? 'Review and update the original PR; verify GitHub checks and the connected production build before closing recovery.'
      : 'Inspect the failed repair evidence; do not repeat unchanged work.',
  });
}

module.exports = { begin, finish };
