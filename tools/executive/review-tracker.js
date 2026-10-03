'use strict';

// Reconcile actual GitHub PR and connected Cloudflare build evidence. A merged
// PR is not a release, and a pushed branch is not a PR.
const fs = require('node:fs');
const path = require('node:path');
const eventstore = require('../fleet-dashboard/server/eventstore');
const githubPr = require('../fleet-dashboard/server/github-pr');
const lane = require('./delivery-lane');

function buildFor(cache, site, sha) {
  if (!sha) return null;
  return (
    (cache.builds || []).find(
      row => row.repo === site && row.branch === 'main' && row.commitHash === sha
    ) || null
  );
}

function latestCheck(checkRuns, name) {
  return (
    (checkRuns || [])
      .filter(row => row.name === name)
      .sort((a, b) => {
        const timestamp = row =>
          Date.parse(row.started_at || row.created_at || row.completed_at || '') || 0;
        return timestamp(b) - timestamp(a);
      })[0] || null
  );
}

async function reconcile(store, root, { api = githubPr.github, cache, alert = lane.alert } = {}) {
  const builds =
    cache ||
    JSON.parse(
      fs.readFileSync(path.join(root, 'tools/fleet-dashboard/data/cloudflare-builds.json'), 'utf8')
    );
  const workerBySite = new Map(
    require('../fleet-dashboard/server/fleetregistry')
      .read(root)
      .sites.filter(row => row.worker)
      .map(row => [row.domain, row.worker])
  );
  const results = [];
  // Every published delivery must be monitored, including ordinary backlog
  // work. A fixed showcase list left all other PRs permanently occupying slots.
  for (const request of store.listChangeRequests({ limit: 'all' })) {
    if (
      !request.run_id ||
      request.delivery_mode !== 'pull_request' ||
      !['committed', 'deployed', 'verified'].includes(request.status)
    )
      continue;
    const run = store.getImprovement(request.run_id);
    const number = run?.approval?.pull_request?.number;
    const url = run?.approval?.pull_request?.url;
    const match = String(url || '').match(
      /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/
    );
    if (!Number.isInteger(number) || !match || Number(match[2]) !== number) continue;
    const repo = match[1];
    const work = { site: request.site };
    const pr = await api(root, repo, `/pulls/${number}`);
    const checks = await api(root, repo, `/commits/${pr.head.sha}/check-runs?per_page=100`);
    // A commit may have multiple attempts with the same check name after a
    // rerun. Judge the newest attempt so an old failure cannot keep a fixed PR
    // blocked (or make a newer pending attempt look failed).
    const workerCheck = latestCheck(
      checks.check_runs,
      `Workers Builds: ${workerBySite.get(work.site) || work.site.replace(/\./g, '-')}`
    );
    const verification = latestCheck(checks.check_runs, 'verify');
    const mergeSha = pr.merged_at ? pr.merge_commit_sha : null;
    const productionChecks = mergeSha
      ? await api(root, repo, `/commits/${mergeSha}/check-runs?per_page=100`)
      : null;
    const productionVerification = latestCheck(productionChecks?.check_runs, 'verify');
    const productionGate = !mergeSha
      ? 'not-merged'
      : productionVerification?.conclusion === 'failure'
        ? 'failed'
        : productionVerification?.conclusion === 'success'
          ? 'passed'
          : 'pending';
    const build = buildFor(builds, work.site, mergeSha);
    const gate =
      pr.mergeable === false && pr.mergeable_state === 'dirty'
        ? 'failed'
        : workerCheck?.conclusion === 'failure'
          ? 'failed'
          : verification?.conclusion === 'failure'
            ? 'failed'
            : verification?.conclusion === 'success'
              ? 'passed'
              : 'pending';
    const release =
      build?.outcome === 'success' &&
      gate === 'passed' &&
      productionGate === 'passed' &&
      run.validation?.passed === true
        ? 'verified'
        : productionGate === 'failed' || build?.outcome === 'fail'
          ? 'failed'
          : pr.merged_at
            ? 'awaiting-connected-build'
            : 'not-merged';
    const next = {
      ...run.approval,
      pull_request: {
        ...run.approval.pull_request,
        state: pr.state,
        merged_at: pr.merged_at || null,
        merge_sha: mergeSha,
        head_sha: pr.head.sha,
        url: pr.html_url,
      },
      review_gate: gate,
      review_checks: {
        verify: verification?.conclusion || null,
        workers_builds: workerCheck?.conclusion || null,
        worker_build_url: workerCheck?.details_url || null,
      },
      production_checks: {
        verify: productionVerification?.conclusion || null,
        gate: productionGate,
        commit: mergeSha,
      },
      release: {
        status: release,
        build_id: build?.uuid || null,
        commit: mergeSha,
        merge_sha: mergeSha,
      },
    };
    const approvalChanged = JSON.stringify(next) !== JSON.stringify(run.approval);
    // A successful connected production build completes the review run as
    // well as its request. Leaving the run in `review` keeps the site busy in
    // the queue scheduler and strands the next approved implementation.
    if (approvalChanged || (release === 'verified' && run.state === 'review'))
      store.updateImprovement(run.run_id, {
        ...(approvalChanged ? { approval: next } : {}),
        ...(release === 'verified' && run.state === 'review'
          ? {
              state: 'deployed',
              deployment_id: mergeSha,
              outcome: { ...run.outcome, deployment_verified_at: build.stoppedOn || null },
            }
          : {}),
      });
    if (release === 'verified' && request.status === 'committed')
      store.updateChangeRequest(request.request_id, { status: 'deployed' });
    const workId = `delivery-recovery:${request.request_id}`;
    const existing = store.getExecutiveWorkItem?.(workId);
    // Close the original incident only on verified production evidence and
    // after its repair owner has released the lease.
    if (
      release === 'verified' &&
      existing &&
      existing.status !== 'done' &&
      !(existing.lease_owner && Date.parse(existing.lease_expires_at || '') > Date.now())
    ) {
      store.updateExecutiveWorkItem?.(workId, {
        status: 'done',
        expected_updated_at: existing.updated_at,
        resolution_note: `Original PR ${number} shipped as ${mergeSha}; connected build ${build.uuid} succeeded.`,
        next_action: 'Resolved; retain the original request and production build evidence.',
        evidence: [
          ...(existing.evidence || []),
          {
            type: 'source',
            label: 'Verified original production release',
            url,
            commit: mergeSha,
            build_id: build.uuid,
            verified_at: build.stoppedOn || null,
          },
        ],
      });
    }

    if ((gate === 'failed' || release === 'failed') && (approvalChanged || !existing)) {
      const patch = {
        title: `Repair delivery verification: ${request.title}`,
        kind: 'incident',
        status: 'ready',
        priority: 'high',
        owner: 'engineering-manager',
        site: request.site,
        source_type: 'change-request',
        source_id: request.request_id,
        summary: `Original PR ${number} at ${pr.head.sha} failed ${gate === 'failed' ? 'GitHub verification' : productionGate === 'failed' ? 'production GitHub verification' : 'the connected production build'}. Preserve its request, run, branch and workspace.`,
        next_action:
          'Inspect the failed check logs; repair the original isolated PR workspace and run the exact CI checks. Do not duplicate the implementation, disable checks, or merge a failed head.',
        due_at: new Date(Date.now() + 3600000).toISOString(),
        evidence: [{ type: 'source', label: 'Original delivery pull request', url }],
      };
      if (existing) store.updateExecutiveWorkItem?.(workId, patch);
      else
        store.createExecutiveWorkItem?.({
          ...patch,
          work_id: workId,
          created_by: 'review-tracker',
        });
      if (approvalChanged)
        await alert(store, root, {
          state: 'blocked',
          site: work.site,
          request_id: request.request_id,
          status:
            gate === 'failed'
              ? 'GitHub review check failed'
              : productionGate === 'failed'
                ? 'production GitHub verification failed'
                : 'connected build failed',
          detail_url: workerCheck?.details_url || pr.html_url,
        });
    }
    results.push({ site: work.site, request_id: request.request_id, pr: number, gate, release });
  }
  return results;
}

if (require.main === module) {
  const root = process.env.FD_DOMAINS_ROOT || path.resolve(__dirname, '..', '..');
  const store = eventstore.open(root);
  reconcile(store, root)
    .then(rows => process.stdout.write(`${JSON.stringify(rows)}\n`))
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(() => store.close());
}

module.exports = { buildFor, latestCheck, reconcile };
