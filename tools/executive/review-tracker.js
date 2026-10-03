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

async function reconcile(store, root, { api = githubPr.github, cache } = {}) {
  const builds =
    cache ||
    JSON.parse(
      fs.readFileSync(path.join(root, 'tools/fleet-dashboard/data/cloudflare-builds.json'), 'utf8')
    );
  const results = [];
  for (const work of lane.WORK) {
    const request = store
      .listChangeRequests({ site: work.site, limit: 'all' })
      .find(row => row.action_key === work.action_key);
    if (!request?.run_id || !['committed', 'deployed', 'verified'].includes(request.status))
      continue;
    const run = store.getImprovement(request.run_id);
    const number = run?.approval?.pull_request?.number;
    if (!Number.isInteger(number)) continue;
    const repo = `bourneash/${work.site}`;
    const pr = await api(root, repo, `/pulls/${number}`);
    const checks = await api(root, repo, `/commits/${pr.head.sha}/check-runs?per_page=100`);
    const workerCheck = (checks.check_runs || []).find(
      row => row.name === `Workers Builds: ${work.site.replace(/\./g, '-')}`
    );
    const verification = (checks.check_runs || []).find(row => row.name === 'verify');
    const mergeSha = pr.merged_at ? pr.merge_commit_sha : null;
    const build = buildFor(builds, work.site, mergeSha);
    const gate =
      workerCheck?.conclusion === 'failure'
        ? 'failed'
        : verification?.conclusion === 'failure'
          ? 'failed'
          : verification?.conclusion === 'success'
            ? 'passed'
            : 'pending';
    const release =
      build?.outcome === 'success'
        ? 'verified'
        : build?.outcome === 'fail'
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
      release: { status: release, build_id: build?.uuid || null, merge_sha: mergeSha },
    };
    if (JSON.stringify(next) !== JSON.stringify(run.approval))
      store.updateImprovement(run.run_id, { approval: next });
    if (release === 'verified' && request.status === 'committed')
      store.updateChangeRequest(request.request_id, { status: 'deployed' });
    if (gate === 'failed' || release === 'failed')
      await lane.alert(store, root, {
        state: 'blocked',
        site: work.site,
        request_id: request.request_id,
        status: gate === 'failed' ? 'GitHub review check failed' : 'connected build failed',
        detail_url: workerCheck?.details_url || pr.html_url,
      });
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

module.exports = { buildFor, reconcile };
