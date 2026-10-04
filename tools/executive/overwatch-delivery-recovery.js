'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const evidence = require('../fleet-dashboard/server/work-evidence');
function failedStartup(q) {
  return (
    q?.status === 'failed' &&
    /failed to bind host port[^\n]*address already in use/i.test(q.error || '')
  );
}
function ensureQueuedCases(
  store,
  { site = null, controlled = process.env.TEAM_ITERATION_RUN === '1' } = {}
) {
  if (!controlled || !site) return [];
  const gates = require('../fleet-dashboard/server/execution-gates');
  const cases = [];
  for (const q of store
    .listChangeRequests({ limit: 'all' })
    .filter(
      q =>
        q.site === site &&
        (q.status === 'queued' || failedStartup(q)) &&
        ['direct', 'pull_request'].includes(q.delivery_mode) &&
        !gates.reason(q)
    )
    .slice(0, 1)) {
    const id = 'queued-delivery:' + q.request_id;
    if (!store.getExecutiveWorkItem(id))
      store.createExecutiveWorkItem({
        work_id: id,
        title: 'Resume original queued implementation: ' + q.title,
        kind: 'implementation',
        status: 'ready',
        priority: 'high',
        owner: 'engineering-manager',
        site: q.site,
        source_type: 'change-request',
        source_id: q.request_id,
        created_by: 'exec-overwatch',
        summary:
          'Authorized controlled iteration has automatic pickup paused. This original executable request needs an explicit reviewed handoff; it is queued, not a failed worker attempt.',
        next_action:
          'Review the original scope and evidence, record a substantive in_progress tracking update on this exact case if safe, then use ordinary worker pickup. Do not duplicate the request or claim delivery before its verified release.',
        evidence: [
          { type: 'source', label: 'Original queued change request', detail: q.request_id },
        ],
      });
    store.createWorkflowLink({
      from_type: 'work-item',
      from_id: id,
      to_type: 'request',
      to_id: q.request_id,
      relation: 'related_to',
      created_by: 'exec-overwatch',
    });
    cases.push(id);
  }
  return cases;
}
function readyCases(store, { site = null, agent = null } = {}) {
  return store
    .listExecutiveWorkItems({ limit: 1000 })
    .filter(task => {
      const queued = task.work_id.startsWith('queued-delivery:');
      if (
        (!queued && !task.work_id.startsWith('delivery-recovery:')) ||
        !['ready', 'open', 'waiting'].includes(task.status) ||
        (site && task.site !== site)
      )
        return false;
      const original = store.getChangeRequest(
        task.source_id || task.work_id.slice('delivery-recovery:'.length)
      );
      const run = original?.run_id && store.getImprovement(original.run_id);
      if (task.status === 'waiting' && !failedStartup(original)) return false;
      if (queued) {
        if (
          (original?.status !== 'queued' && !failedStartup(original)) ||
          require('../fleet-dashboard/server/execution-gates').reason(original)
        )
          return false;
      } else if (
        original?.status !== 'failed' ||
        run?.approval?.production_checks?.gate !== 'failed'
      )
        return false;
      if (Number(agent?.workspace?.overwatch_recovery?.[task.work_id]?.attempt_count || 0) >= 2)
        return false;
      return (
        queued ||
        !evidence.linkedRequests(store, task).some(q => !['failed', 'cancelled'].includes(q.status))
      );
    })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 3)
    .map((task, index) => ({
      case_ref: 'RECOVERY_' + (index + 1),
      work_id: task.work_id,
      site: task.site,
      owner: task.owner,
      source_id: task.source_id,
      summary: task.summary,
      next_action: task.next_action,
      evidence: task.evidence,
      source_work_id: task.work_id,
      recovery_type: task.work_id.startsWith('queued-delivery:')
        ? failedStartup(store.getChangeRequest(task.source_id))
          ? 'failed-startup'
          : 'queued-backlog'
        : 'production-failure',
      original_request: task.work_id.startsWith('queued-delivery:')
        ? store.getChangeRequest(task.source_id)
        : undefined,
      instruction_prefix:
        'Use this supplied case_ref as tracking_updates.work_id or change_requests.source_work_id. The host resolves only exact supplied aliases; never recopy or invent UUIDs.',
      instruction: task.work_id.startsWith('queued-delivery:')
        ? 'Inspect the existing original request and fresh evidence. If its bounded scope is valid, record tracking_updates for this exact work_id with status in_progress, a substantive review summary, acceptance/testing disposition, and next_action ordinary worker pickup. Do not create another request. If this original request has the supplied verified failed-startup status, approve retry of the same request through ordinary pickup after the infrastructure correction; do not create a successor or erase the original failure. This resumes authorized original backlog while automatic pickup is paused; it is not a fabricated execution failure. No completed work credit until its actual release.'
        : 'Repair this original failed production prerequisite; use this exact source_work_id for the successor. Preserve already shipped implementation and all failed receipts. Distinguish warning annotations from the actual failing step: Node runtime deprecation and future runner migration warnings are not quota errors. Inspect the pinned workflow source and consumers. If archives have no required consumer, use the established fleet pattern: optional archive job, default disabled, requested failures visible; preserve every required install/audit/build/content check, command and version pin. Do not upgrade dependencies to silence unrelated warnings, waive checks, delete archives, change billing or redeploy the old SHA.',
    }));
}
async function pickup(root, request) {
  let token = process.env.FD_TOKEN;
  if (!token) {
    const text = fs.readFileSync(
      path.join(root, 'tools/env-broker/rendered/tool-fleet-dashboard.env'),
      'utf8'
    );
    token = text.match(/^FD_TOKEN=(.*)$/m)?.[1];
  }
  token = String(token || '')
    .replace(/^['"]|['"]$/g, '')
    .split(',')[0];
  if (!token) throw Error('Dashboard pickup credential unavailable');
  const base = process.env.FD_DASHBOARD_URL || 'http://127.0.0.1:4754';
  const r = await fetch(`${base}/api/change-requests/${request.request_id}/pickup`, {
    method: 'POST',
    headers: { 'x-fd-token': token, 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(30000),
  });
  const data = await r.json();
  if (r.status !== 202) throw Error(data.error || `Pickup rejected HTTP${r.status}`);
  return { run_id: data.run?.run_id || data.request?.run_id || null };
}
async function trackHandoffs(
  store,
  agent,
  baseline,
  {
    root,
    cases = [],
    controlled = process.env.TEAM_ITERATION_RUN === '1',
    pickupImpl = pickup,
    initiatingRunId = null,
  } = {}
) {
  const tracked = [];
  for (const candidate of cases) {
    const task = store.getExecutiveWorkItem(candidate.work_id);
    if (!task) continue;
    const queued = ['queued-backlog', 'failed-startup'].includes(candidate.recovery_type);
    const before = baseline.work?.get(task.work_id);
    const review =
      queued &&
      baseline.tracking_actions instanceof Set &&
      (store.listExecutiveActions?.({ action_type: 'track', limit: 1000 }) || []).find(
        row =>
          !baseline.tracking_actions.has(row.action_id) &&
          row.status === 'completed' &&
          row.target_id === task.work_id &&
          row.result?.source === 'executive-plan' &&
          row.result.status === 'in_progress' &&
          row.result.next_action &&
          row.result.next_action !== before?.next_action &&
          row.summary &&
          row.summary !== before?.summary &&
          row.result.evidence?.length
      );
    const approved = Boolean(review);
    const requests = (
      queued && approved
        ? [store.getChangeRequest(task.source_id)]
        : queued
          ? []
          : evidence.linkedRequests(store, task)
    )
      .filter(
        q =>
          q &&
          (!queued ? !baseline.requests.has(q.request_id) : true) &&
          (q.status === 'queued' || (queued && failedStartup(q))) &&
          ['direct', 'pull_request'].includes(q.delivery_mode) &&
          q.site === task.site
      )
      .slice(0, 1);
    if (!requests.length) continue;
    const current = store.getAgent(agent.agent_id),
      history = current.workspace?.overwatch_recovery || {},
      prior = history[task.work_id] || {};
    const fingerprint = evidence.fingerprint(store, task);
    if (prior.fingerprint === fingerprint || Number(prior.attempt_count || 0) >= 2) continue;
    const entry = {
      fingerprint,
      attempt_count: Number(prior.attempt_count || 0) + 1,
      attempted_at: new Date().toISOString(),
      status: 'attempted',
      request_ids: requests.map(q => q.request_id),
      initiating_run_id: initiatingRunId,
      review_action_id: review?.action_id || null,
    };
    store.updateAgent(agent.agent_id, {
      workspace: {
        ...current.workspace,
        overwatch_recovery: { ...history, [task.work_id]: entry },
      },
    });
    store.updateExecutiveWorkItem(task.work_id, {
      status: 'waiting',
      waiting_on: 'request:' + requests[0].request_id,
      next_action:
        'Overwatch initiated the linked bounded prerequisite repair; verify its exact source, required CI, connected build and live outcome.',
    });
    for (const request of requests.slice(0, 1)) {
      const receipt = {
        work_id: task.work_id,
        request_id: request.request_id,
        initiating_run_id: initiatingRunId,
        review_action_id: review?.action_id || null,
        action: 'queued_recovery_handoff',
      };
      if (controlled) {
        try {
          Object.assign(receipt, await pickupImpl(root, request), {
            action: 'started_recovery_worker',
          });
        } catch (error) {
          Object.assign(receipt, { action: 'recovery_pickup_failed', error: error.message });
        }
      }
      store.record({
        event_type: 'overwatch.recovery_handoff',
        source: 'exec-overwatch',
        entity_type: 'executive-work-item',
        entity_id: task.work_id,
        payload: receipt,
      });
      tracked.push(receipt);
    }
  }
  return tracked;
}
module.exports = {
  readyCases,
  trackHandoffs,
  policyRevision: 'delivery-recovery/v6',
  ensureQueuedCases,
};
