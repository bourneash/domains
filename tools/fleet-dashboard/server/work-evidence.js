'use strict';

// Workflow state is a claim. Delivery credit requires durable worker and
// release evidence; a report, pushed branch, or retry is a separate stage.
const crypto = require('node:crypto');
const CONTRACT = 'work-evidence/v1';

function delivery(request = {}, run = {}) {
  const reportOnly = request.delivery_mode === 'report_only';
  const live =
    ['direct', 'pull_request'].includes(request.delivery_mode) &&
    !['failed', 'cancelled'].includes(request.status);
  const validation = run.validation || {};
  const approval = run.approval || {};
  const validated = live && !reportOnly && validation.passed === true && Boolean(validation.commit);
  const accepted = validated && Boolean(approval.approved_at || approval.review_gate === 'passed');
  const committed =
    validated && Boolean(approval.pull_request?.pushed || approval.pull_request?.url);
  const release = approval.release || {};
  const deployed =
    accepted &&
    release.status === 'verified' &&
    release.commit === run.deployment_id &&
    Boolean(release.build_id) &&
    Boolean(run.deployment_id && run.outcome?.deployment_verified_at);
  const measured =
    deployed &&
    run.outcome?.measurement_contract === 'measurement-evidence/v2' &&
    ['proven', 'regressed', 'inconclusive'].includes(run.state);
  return {
    contract: CONTRACT,
    stage: reportOnly
      ? run.state === 'reported'
        ? 'reported'
        : 'report_pending'
      : measured
        ? 'measured'
        : deployed
          ? 'deployed'
          : accepted
            ? 'accepted'
            : committed
              ? 'committed'
              : validated
                ? 'validated'
                : 'pending',
    report_only: reportOnly,
    validated,
    accepted,
    committed,
    deployed,
    measured,
    verified_outcome: deployed,
    business_result:
      measured && run.state === 'proven' && run.outcome?.causal_attribution === 'verified',
  };
}

function linkedRequests(store, task) {
  const links =
    store.listWorkflowLinks?.({ entity_type: 'work-item', entity_id: task.work_id, limit: 2000 }) ||
    [];
  const ids = new Set(
    links
      .filter(link => link.relation === 'related_to')
      .flatMap(link =>
        link.from_type === 'request'
          ? [link.from_id]
          : link.to_type === 'request'
            ? [link.to_id]
            : []
      )
  );
  for (const run of store.listAgentRuns?.({ work_id: task.work_id, limit: 1000 }) || [])
    for (const id of run.result?.change_request_ids || []) ids.add(id);
  return [...ids].map(id => store.getChangeRequest(id)).filter(Boolean);
}

function fingerprint(store, task) {
  const requests = linkedRequests(store, task)
    .map(request => {
      const run = request.run_id ? store.getImprovement(request.run_id) : null;
      return [
        request.request_id,
        request.status,
        request.error,
        run?.validation?.commit,
        run?.validation?.passed,
        run?.deployment_id,
      ];
    })
    .sort((a, b) => a[0].localeCompare(b[0]));
  // Retry labels, heartbeat/update times, and rewritten next actions are our
  // own bookkeeping. They must not make unchanged work eligible again.
  const evidence = (task.evidence || []).filter(
    row => !/dispatch|execution report|recovery/i.test(row.label || '')
  );
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([task.work_id, task.summary, task.site, task.owner, evidence, requests]))
    .digest('hex');
}

function linkRequest(store, taskId, requestId) {
  return store.createWorkflowLink({
    from_type: 'work-item',
    from_id: taskId,
    to_type: 'request',
    to_id: requestId,
    relation: 'related_to',
    created_by: 'operating-worker',
  });
}

function recordConnectedReleases(
  store,
  {
    health = require('./deployhealth').get,
    builds = require('./cloudflarebuilds')._state().builds,
    now = Date.now(),
  } = {}
) {
  const verified = [];
  for (const run of store.listImprovements({ limit: 1000 })) {
    if (
      !run.deployment_id ||
      !['deployed', 'measuring', 'proven', 'regressed', 'inconclusive'].includes(run.state) ||
      run.approval?.release?.status === 'verified'
    )
      continue;
    const live = health(run.site);
    if (
      !live ||
      live.live !== true ||
      !live.version ||
      !Number.isFinite(live.checkedAt) ||
      !Number.isFinite(live.deployedAt) ||
      now - live.checkedAt > 10 * 60000 ||
      live.checkedAt > now
    )
      continue;
    const matching = builds.filter(
      row =>
        row.worker === live.worker &&
        ['main', 'master'].includes(row.branch) &&
        (row.commitHash === run.deployment_id ||
          (/^[a-f0-9]{7,39}$/i.test(run.deployment_id) &&
            /^[a-f0-9]{40}$/i.test(row.commitHash) &&
            row.commitHash.startsWith(run.deployment_id.toLowerCase())))
    );
    // Git stores abbreviated deployment SHAs in older runs. Resolve only a
    // unique full hash; an ambiguous prefix is not release evidence.
    if (new Set(matching.map(row => row.commitHash)).size !== 1) continue;
    const build = matching.find(
      row =>
        row.uuid &&
        row.outcome === 'success' &&
        row.stoppedOn &&
        Date.parse(row.stoppedOn) <= live.deployedAt * 1000 + 120000
    );
    if (!build) continue;
    const request = run.source_id && store.getChangeRequest(run.source_id);
    if (
      request?.delivery_mode === 'direct' &&
      (run.approval?.production_checks?.gate !== 'passed' ||
        run.approval.production_checks.commit !== build.commitHash)
    )
      continue;
    if (
      !delivery(request || {}, {
        ...run,
        deployment_id: build.commitHash,
        approval: {
          ...run.approval,
          release: { status: 'verified', build_id: build.uuid, commit: build.commitHash },
        },
        outcome: { ...run.outcome, deployment_verified_at: build.stoppedOn },
      }).deployed
    )
      continue;
    store.updateImprovement(run.run_id, {
      deployment_id: build.commitHash,
      approval: {
        ...run.approval,
        release: {
          status: 'verified',
          build_id: build.uuid,
          commit: build.commitHash,
          worker: build.worker,
          worker_version: live.version,
          verified_at: new Date(now).toISOString(),
          source: 'cloudflare-workers-builds',
        },
      },
      outcome: { ...run.outcome, deployment_verified_at: build.stoppedOn },
    });
    verified.push(run.run_id);
  }
  return verified;
}

module.exports = {
  CONTRACT,
  delivery,
  linkedRequests,
  fingerprint,
  linkRequest,
  recordConnectedReleases,
};
