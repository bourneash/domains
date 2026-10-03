'use strict';
const githubPr = require('./github-pr');
const inFlight = new WeakSet();
const checked = new Map();
function latestVerify(rows) {
  return (
    (rows || [])
      .filter(row => row.name === 'verify')
      .sort(
        (a, b) =>
          Date.parse(b.started_at || b.created_at || b.completed_at || 0) -
          Date.parse(a.started_at || a.created_at || a.completed_at || 0)
      )[0] || null
  );
}
async function reconcile(
  store,
  root,
  { api = githubPr.github, now = Date.now(), limit = 2, repositoryForSite } = {}
) {
  if (inFlight.has(store)) return [];
  inFlight.add(store);
  const receipts = [];
  try {
    const registry = repositoryForSite
      ? null
      : new Map(
          require('./fleetregistry')
            .read(root)
            .sites.map(row => [row.domain, row.repo])
        );
    const candidates = store
      .listChangeRequests({ limit: 'all' })
      .filter(
        row =>
          row.delivery_mode === 'direct' &&
          row.run_id &&
          ['deployed', 'verified'].includes(row.status)
      )
      .map(request => ({ request, run: store.getImprovement(request.run_id) }))
      .filter(
        ({ run }) =>
          run &&
          /^[a-f0-9]{40}$/i.test(run.deployment_id || '') &&
          !(
            run.approval?.production_checks?.gate === 'passed' &&
            run.approval.production_checks.commit === run.deployment_id
          )
      )
      .sort((a, b) =>
        String(b.run.updated_at || b.run.created_at || '').localeCompare(
          String(a.run.updated_at || a.run.created_at || '')
        )
      );
    for (const { request, run } of candidates) {
      const key = `${root}:${run.run_id}:${run.deployment_id}`;
      if (checked.has(key) && now - checked.get(key) < 60000) continue;
      const repo = repositoryForSite ? repositoryForSite(run.site) : registry.get(run.site);
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) continue;
      checked.set(key, now);
      const result = await api(root, repo, `/commits/${run.deployment_id}/check-runs?per_page=100`);
      const check = latestVerify(result.check_runs);
      const gate =
        check?.status === 'completed'
          ? check.conclusion === 'success'
            ? 'passed'
            : 'failed'
          : 'waiting';
      let evidence = null;
      if (gate === 'failed' && check.id) {
        const annotations = await api(
          root,
          repo,
          `/check-runs/${check.id}/annotations?per_page=100`
        );
        evidence =
          (Array.isArray(annotations) ? annotations : [])
            .map(row => row.message || '')
            .filter(Boolean)
            .join('\n')
            .slice(0, 2000) || `Required verify concluded ${check.conclusion}`;
      }
      const receipt = {
        gate,
        verify: check?.conclusion || null,
        commit: run.deployment_id,
        check_url: check?.details_url || null,
        failure_evidence: evidence,
        checked_at: new Date(now).toISOString(),
      };
      const current = store.getImprovement(run.run_id);
      if (current?.deployment_id !== run.deployment_id) continue;
      store.updateImprovement(run.run_id, {
        approval: { ...current.approval, production_checks: receipt },
      });
      if (gate === 'failed') {
        const error = `Production GitHub verification failed for exact direct-delivery commit ${run.deployment_id}. ${evidence}`;
        store.updateImprovement(run.run_id, {
          state: 'failed',
          outcome: {
            ...current.outcome,
            phase: 'production-verification',
            error,
            failed_at: new Date(now).toISOString(),
          },
        });
        store.updateChangeRequest(request.request_id, {
          status: 'failed',
          error,
          lease_owner: null,
          lease_expires_at: null,
          heartbeat_at: null,
        });
        const workId = `delivery-recovery:${request.request_id}`;
        const existing = store.getExecutiveWorkItem(workId);
        const patch = {
          title: `Repair production verification: ${request.title}`,
          kind: 'incident',
          status: 'ready',
          priority: 'high',
          owner: 'engineering-manager',
          site: run.site,
          source_type: 'change-request',
          source_id: request.request_id,
          summary: error,
          next_action:
            'Inspect the exact failed production check; preserve shipped source and failed evidence, then repair only the verified prerequisite.',
          evidence: [
            {
              type: 'test',
              label: 'Failed required production verify',
              url: receipt.check_url,
              detail: evidence,
            },
          ],
        };
        if (existing) store.updateExecutiveWorkItem(workId, patch);
        else
          store.createExecutiveWorkItem({
            ...patch,
            work_id: workId,
            created_by: 'production-verification',
          });
        store.record({
          event_type: 'delivery.production_verification_failed',
          source: 'production-verification',
          entity_type: 'change-request',
          entity_id: request.request_id,
          payload: receipt,
        });
      }
      receipts.push({ run_id: run.run_id, ...receipt });
      if (receipts.length >= limit) break;
    }
    return receipts;
  } finally {
    inFlight.delete(store);
  }
}
module.exports = { latestVerify, reconcile };
