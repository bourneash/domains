'use strict';

// Two owner-priority implementation slices, advanced by artifact rather than
// executive prose. A reviewer-passed, pushed branch is the milestone;
// production publication is separate.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const eventstore = require('../fleet-dashboard/server/eventstore');
const changequeue = require('../fleet-dashboard/server/changequeue');
const { config } = require('./overwatch-alert');

const WORK = Object.freeze([
  {
    site: 'howtofry.com',
    action_key: 'owner-delivery-lane:howtofry-recipe-search-v1',
    title: 'Add usable recipe search to HowToFry',
    body: [
      'Owner priority: produce a real, reviewable HowToFry improvement. The recipes page currently filters by cooking method but has no search.',
      'Implement an accessible client-side search on /recipes/ that matches recipe title and ingredients and composes with the existing method filter. Show a visible result count and useful empty state; preserve a working all-recipes reset. The page must remain usable when JavaScript is unavailable.',
      'Acceptance: add focused automated coverage for matching/filter behavior and empty state; run npm run ci:verify in site/; provide changed paths and test output in the reviewable branch. Keep existing recipes, safety copy, and category filters intact.',
      'This uses the queue pull_request mode to publish a reviewable branch, not production authorization. Do not push or deploy from the worker. No affiliate, analytics, or social credentials are available for this task.',
    ].join('\n\n'),
  },
  {
    site: 'magicescorts.com',
    action_key: 'owner-delivery-lane:magicescorts-coin-guide-v1',
    title: 'Deliver the promised coin trick guide on MagicEscorts',
    body: [
      'Owner priority: a real, reviewable MagicEscorts content feature. The homepage promises coin magic, but /tricks/ currently teaches only two card effects.',
      'Add one technically sound beginner coin trick guide, link it from the trick room and the relevant homepage coin card, and keep the established theatrical voice. Instructions must be performable with ordinary props and clear about practice, angles, and limitations. Do not imply supernatural powers or a real performer/service.',
      'Acceptance: relevant navigation works; tests or build checks cover the new route and links; run npm run ci:verify in site/; provide changed paths and test output in the reviewable branch. Keep the truthful coming-soon/no-booking disclosures.',
      'This uses the queue pull_request mode to publish a reviewable branch, not production authorization. Do not push or deploy from the worker. Do not add affiliate links, analytics, intake, or booking.',
    ].join('\n\n'),
  },
]);

const ACCEPTED = new Set(['committed', 'deployed', 'verified']);
const TERMINAL_PROBLEM = new Set([
  'failed',
  'blocked_owner',
  'blocked_infrastructure',
  'needs_human_review',
  'cancelled',
]);
const STALE_MS = 4 * 60 * 60 * 1000;

function siteHasOwner(root, site) {
  return fs.existsSync(path.join(root, 'sites', site, 'ops', 'roles', 'engineer.md'));
}

function getRequests(store, site) {
  return store.listChangeRequests({ site, limit: 'all' });
}

function reconcilePublishedBranch(store, root, request) {
  if (
    request?.status !== 'blocked_infrastructure' ||
    request.error !== 'cannot transition delivery_pending to committed' ||
    request.delivery_mode !== 'pull_request' ||
    !WORK.some(work => work.action_key === request.action_key && work.site === request.site)
  )
    return request;
  const run = request.run_id ? store.getImprovement(request.run_id) : null;
  const expected = path.join(root, 'tools', 'fleet-dashboard', 'data', 'improvement-worktrees');
  const workspace = run?.workspace_path;
  if (
    !run ||
    run.source_id !== request.request_id ||
    run.validation?.passed !== true ||
    run.agent?.phase !== 'reviewer' ||
    run.agent?.status !== 'completed' ||
    Number(run.agent?.exit_code) !== 0 ||
    !workspace ||
    !path.resolve(workspace).startsWith(`${expected}${path.sep}`) ||
    !/^improvement\/[a-f0-9]+$/.test(String(run.branch || ''))
  )
    return request;
  let commit;
  try {
    const log = fs.readFileSync(run.agent.log, 'utf8');
    if (!/FD_REVIEW_RESULT:\s*PASS\b/.test(log)) return request;
    const git = (...args) =>
      execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8', timeout: 10000 }).trim();
    if (git('status', '--porcelain') !== '') return request;
    if (git('branch', '--show-current') !== run.branch) return request;
    if (git('rev-parse', '--abbrev-ref', '@{upstream}') !== `origin/${run.branch}`) return request;
    commit = git('rev-parse', 'HEAD');
    if (git('rev-parse', '@{upstream}') !== commit) return request;
  } catch {
    return request;
  }
  const current = store.getChangeRequest(request.request_id);
  if (current.status !== request.status || current.error !== request.error) return current;
  // The dashboard pushed the branch before the old transition table rejected
  // its final status update. This exact-evidence recovery does not publish or
  // deploy anything; it only reconciles the already-pushed artifact.
  return store.transaction(() => {
    const updated = store.updateChangeRequest(request.request_id, {
      status: 'committed',
      error: null,
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
    });
    store.record({
      event_type: 'change-request.published-branch-reconciled',
      source: 'owner-delivery-lane',
      site_id: `site:${request.site}`,
      entity_type: 'change-request',
      entity_id: request.request_id,
      correlation_id: `change-request:${request.request_id}`,
      payload: { run_id: run.run_id, branch: run.branch, commit, reason: request.error },
    });
    return updated;
  });
}

function reconcile(store, root, now = Date.now()) {
  if (store.getChangeQueueSettings()?.enabled !== true)
    return { state: 'queue-disabled', freeze_planning: false };
  const rows = WORK.map(work => ({
    ...work,
    request: getRequests(store, work.site).find(row => row.action_key === work.action_key),
  }));
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row.request) row.request = reconcilePublishedBranch(store, root, row.request);
    if (index && !ACCEPTED.has(rows[index - 1].request?.status)) {
      return {
        state: 'waiting-on-first-artifact',
        site: row.site,
        prior_status: rows[index - 1].request?.status || null,
        freeze_planning: true,
      };
    }
    if (!row.request) {
      if (!siteHasOwner(root, row.site))
        return { state: 'missing-site-owner', site: row.site, freeze_planning: true };
      const request = changequeue.create(
        store,
        {
          site: row.site,
          title: row.title,
          body: row.body,
          category: 'engineering',
          priority: 'high',
          assigned_role: 'engineer',
          requested_by: 'owner-delivery-lane',
          delivery_mode: 'pull_request',
          action_key: row.action_key,
          auto_review: true,
          max_turns: 40,
        },
        site => site === row.site,
        () => ['engineer']
      );
      return {
        state: 'queued',
        site: row.site,
        request_id: request.request_id,
        freeze_planning: true,
      };
    }
    if (TERMINAL_PROBLEM.has(row.request.status))
      return {
        state: 'blocked',
        site: row.site,
        request_id: row.request.request_id,
        status: row.request.status,
        freeze_planning: true,
      };
    if (!ACCEPTED.has(row.request.status)) {
      // Heartbeats update updated_at, so age must be measured from original
      // queue admission or a live run could evade the no-artifact SLA forever.
      const age = now - (Date.parse(row.request.created_at || '') || now);
      return {
        state: age >= STALE_MS ? 'stalled' : 'working',
        site: row.site,
        request_id: row.request.request_id,
        status: row.request.status,
        age_minutes: Math.floor(age / 60000),
        freeze_planning: true,
      };
    }
  }
  return {
    state: 'two-reviewable-artifacts',
    freeze_planning: false,
    requests: rows.map(row => ({
      site: row.site,
      request_id: row.request.request_id,
      status: row.request.status,
    })),
  };
}

async function alert(store, root, state, { env = process.env, fetchImpl = fetch } = {}) {
  if (!['blocked', 'stalled', 'missing-site-owner'].includes(state.state))
    return { attempted: false };
  // Repeat a continuing blocker at most once per two hours, not every poll.
  const bucket = Math.floor(Date.now() / (2 * 60 * 60 * 1000));
  const dedupe_key = `owner-delivery-lane:${state.site}:${state.state}:${state.request_id || 'owner'}:${bucket}`;
  if (
    store
      .listExecutiveNotifications({ recipient: 'owner', limit: 1000 })
      .some(row => row.dedupe_key === dedupe_key)
  )
    return { attempted: false, reason: 'already-alerted' };
  const message = `🚨 Owner delivery lane ${state.state}: ${state.site}; request ${state.request_id || 'not queued'}; status ${state.status || 'n/a'}; age ${state.age_minutes ?? 'n/a'} min. Inspect the request and name a human owner for the blocker. No new speculative planning is needed.`;
  store.createExecutiveNotification({
    recipient: 'owner',
    notification_type: 'owner-delivery-lane',
    title: `Delivery lane ${state.state}: ${state.site}`,
    body: message,
    dedupe_key,
  });
  const { token, channel } = config(root, env);
  if (!token) return { attempted: true, sent: false, error: 'SLACK_BOT_TOKEN unavailable' };
  try {
    const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, text: message }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.json();
    return {
      attempted: true,
      sent: Boolean(response.ok && body?.ok),
      channel,
      error: body?.ok ? null : body?.error || `HTTP ${response.status}`,
    };
  } catch (error) {
    return { attempted: true, sent: false, channel, error: String(error.message || error) };
  }
}

if (require.main === module) {
  const root = process.env.FD_DOMAINS_ROOT || path.resolve(__dirname, '..', '..');
  const store = eventstore.open(root);
  const state = reconcile(store, root);
  alert(store, root, state)
    .then(notification => {
      process.stdout.write(`${JSON.stringify({ ...state, notification })}\n`);
    })
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => store.close());
}

module.exports = { WORK, reconcile, alert, siteHasOwner };
