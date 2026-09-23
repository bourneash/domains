#!/usr/bin/env bash
set -euo pipefail

# Build the shared read-only telemetry bundle before the next executive tick.
# This is intentionally deterministic at the orchestration layer: no model is
# needed to collect the data and no owner approval is required.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# Match the service-network route used by fleet-cron. An explicit value from
# the scheduler remains authoritative; this fallback prevents host/manual
# runs from silently selecting a container-only hostname.
if [[ -z "${DATAHUB_API:-}" ]]; then
  if [[ -f /.dockerenv ]]; then
    export DATAHUB_API="http://datahub-api:4760"
  else
    export DATAHUB_API="http://127.0.0.1:4760"
  fi
fi
node - "$ROOT" <<'NODE'
const root = process.argv[2];
const runner = require(`${root}/tools/executive/runner`);
const intel = require(`${root}/tools/fleet-dashboard/server/executive-intel`);
const snapshot = require(`${root}/tools/fleet-dashboard/server/executive-snapshot`);
const eventstore = require(`${root}/tools/fleet-dashboard/server/eventstore`);
const executive = require(`${root}/tools/fleet-dashboard/server/executive`);
const dataQualityWork = require(`${root}/tools/fleet-dashboard/server/executive-dataquality`);
const changequeue = require(`${root}/tools/fleet-dashboard/server/changequeue`);

(async () => {
  const sites = runner.executiveSites(root);
  const value = await intel.collect({ root, sites });
  const saved = snapshot.write(root, value);
  const store = eventstore.open(root);
  const qualityWork = dataQualityWork.sync(store, value.decision_support?.data_quality);
  const analyticsGaps = value.decision_support?.data_quality?.coverage?.analytics || {};
  const analyticsRequests = [];
  const analyticsSourceAvailable = value.sources?.analytics?.ok === true;
  for (const detail of analyticsSourceAvailable ? analyticsGaps.missing_details || [] : []) {
    const site = String(detail.site || '').trim().toLowerCase();
    if (!site || !sites.includes(site)) continue;
    const actionKey = `data-quality:analytics:${site}`;
    const existing = store
      .listChangeRequests({ limit: 1000 })
      .find(request => request.action_key === actionKey && request.status !== 'cancelled');
    if (existing) continue;
    analyticsRequests.push(
      changequeue.create(
        store,
        {
          site,
          title: `Produce analytics coverage diagnosis for ${site}`,
          body: [
            'Read-only analytics coverage diagnosis. Do not change credentials, property configuration, tracking code, schedules, deployment, or production data.',
            `Current deterministic health: configured=${detail.configured === true ? 'yes' : detail.configured === false ? 'no' : 'unknown'}, GA4=${detail.ga4_status}, GSC=${detail.gsc_status}.`,
            'Inspect the canonical analytics registry, the latest collector/source health, and the site repository only as needed. Identify the exact missing permission, property, fetch, or deployment dependency and write a concise evidence report with source timestamps and the smallest owner-approved repair.',
            'Acceptance: distinguish unavailable evidence from zero; include the exact registry entries and failed source/error details; make no production or credential changes.',
          ].join('\n'),
          category: 'engineering',
          priority: 'medium',
          assigned_role: 'engineer',
          provider: 'chatgpt',
          model: 'gpt-5.6-luna',
          max_turns: 8,
          auto_review: true,
          delivery_mode: 'report_only',
          requested_by: 'system',
          action_key: actionKey,
        },
        target => sites.includes(target)
      )
    );
  }
  const missingAnalyticsSites = new Set(analyticsGaps.missing_sites || []);
  for (const issue of analyticsSourceAvailable ? analyticsGaps.source_issues || [] : []) {
    const site = String(issue.site || '').trim().toLowerCase();
    const source = String(issue.source || 'analytics').trim().toLowerCase();
    if (!site || !sites.includes(site) || missingAnalyticsSites.has(site)) continue;
    const actionKey = `data-quality:analytics:${source}:${site}`;
    const existing = store
      .listChangeRequests({ limit: 1000 })
      .find(request => request.action_key === actionKey && request.status !== 'cancelled');
    if (existing) continue;
    const label = source === 'gsc' ? 'GSC' : source === 'ga4' ? 'GA4' : source;
    analyticsRequests.push(
      changequeue.create(
        store,
        {
          site,
          title: `Produce ${label} permission diagnosis for ${site}`,
          body: [
            `Read-only ${label} analytics source diagnosis. Do not change credentials, property configuration, tracking code, schedules, deployment, or production data.`,
            `Current deterministic health: source=${label}, status=${issue.status}, last_fetch_at=${issue.last_fetch_at || 'unavailable'}, error=${issue.error || 'none recorded'}.`,
            'Inspect the canonical analytics registry, latest collector/source health, and site repository only as needed. Identify the exact permission, property, fetch, or deployment dependency and write a concise evidence report with the smallest owner-approved repair.',
            'Acceptance: distinguish unavailable evidence from zero; include the exact registry entry and failed source/error details; make no production or credential changes.',
          ].join('\n'),
          category: 'engineering',
          priority: 'medium',
          assigned_role: 'engineer',
          provider: 'chatgpt',
          model: 'gpt-5.6-luna',
          max_turns: 8,
          auto_review: true,
          delivery_mode: 'report_only',
          requested_by: 'system',
          action_key: actionKey,
        },
        target => sites.includes(target)
      )
    );
  }
  const audit = executive.action(store, {
    actor: 'system',
    action_type: 'observe',
    summary: 'Scheduled executive intelligence snapshot generated',
    target_type: 'executive-intelligence-snapshot',
    target_id: saved.generated_at,
  });
  executive.finishAction(store, audit.action_id, {
    status: 'completed',
    result: {
      generated_at: saved.generated_at,
      file: saved.file,
      degraded: saved.degraded,
      latest_updated: saved.latest_updated,
      managed_sites: sites.length,
      source_count: Object.keys(value.sources || {}).length,
      data_quality_work: {
        created: qualityWork.created.length,
        updated: qualityWork.updated.length,
        resolved: qualityWork.resolved.length,
        analytics_requests: analyticsRequests.map(request => request.request_id),
      },
    },
  });
  store.close();
  process.stdout.write(
    JSON.stringify({
      generated_at: saved.generated_at,
      sites: sites.length,
      analytics_requests: analyticsRequests.length,
    }) + '\n'
  );
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
NODE
