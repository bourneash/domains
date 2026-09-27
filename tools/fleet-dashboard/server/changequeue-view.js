'use strict';

const fs = require('node:fs');
const path = require('node:path');
const fleetregistry = require('./fleetregistry');

const FAIRNESS_ESCALATION_MS = 30 * 60 * 1000;

// These requests inspect, reconcile, or route existing work. They do not
// change the measured production surface, so a site's experiment must not
// freeze them behind a measurement window.
const MEASUREMENT_SAFE_TEXT =
  /\b(?:measurement\s+coverage|attribution\s+reconciliation|attribution\s+assessment|orchestration\s+failure\s+diagnosis|mobile\s+performance\s+diagnosis|content\s+depth.*review|internal[- ]link(?:ing)?\s+review|capture\s+~?\d+\s+more\s+clicks?|reassign\s+task)\b/i;

function textOf(request = {}) {
  return `${request.title || ''}\n${request.body || ''}`;
}

function extractPaths(value = '') {
  return [...String(value).matchAll(/(?:https?:\/\/[^\s)]+)?(\/[-a-zA-Z0-9._~%!$&'()*+,;=:@\/]*)/g)]
    .map(match => (match[1] || match[0]).replace(/[.,;:)]+$/, '').toLowerCase())
    .filter(path => path.length > 1 && path !== '//');
}

function isMeasurementSafe(request = {}) {
  if (request.delivery_mode === 'report_only') return true;
  if (String(request.action_key || '').startsWith('task-routing:')) return true;
  return MEASUREMENT_SAFE_TEXT.test(textOf(request));
}

function measurementScope(value = {}) {
  const explicit = value.measurement_scope || value.baseline?.measurement_scope;
  const paths = Array.isArray(explicit?.paths)
    ? explicit.paths.map(String).map(path => path.toLowerCase())
    : [];
  return [...new Set([...paths, ...extractPaths(textOf(value))])];
}

// A measurement run blocks only a production request that could change the
// same measured surface. When either side has no reliable URL/path scope we
// stay conservative and hold it; diagnostics and control-plane work are
// explicitly exempt above.
function measurementConflict(request = {}, run = {}) {
  if (isMeasurementSafe(request)) return false;
  const requestPaths = measurementScope(request);
  const runPaths = measurementScope(run);
  if (requestPaths.length && runPaths.length)
    return requestPaths.some(requestPath =>
      runPaths.some(
        runPath =>
          requestPath === runPath ||
          requestPath.startsWith(`${runPath}/`) ||
          runPath.startsWith(`${requestPath}/`)
      )
    );
  return true;
}

function readSiteDescriptions(root) {
  const descriptions = {};
  const registry = fleetregistry.read(root);
  for (const row of registry.sites) {
    const description = row.description || row.smoke_string || row.tags?.join(' · ');
    if (description) descriptions[row.domain] = description;
  }
  try {
    const text = fs.readFileSync(path.join(root, 'DOMAINS_INDEX.md'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\|\s*([^|]+?)\s*\|[^|]*\|\s*([^|]+?)\s*\|\s*$/);
      if (match && match[2].trim() && !descriptions[match[1].trim()])
        descriptions[match[1].trim()] = match[2].trim();
    }
  } catch {
    // Site context is helpful metadata; a missing registry must not break the queue API.
  }
  return descriptions;
}

function siteContext(root, site, descriptions = readSiteDescriptions(root)) {
  const domain = String(site || 'fleet');
  return {
    domain,
    description:
      descriptions[domain] ||
      (domain === 'fleet'
        ? 'Fleet-wide control-plane operation'
        : 'Site description is not in the fleet registry'),
  };
}

function queueBlockers(
  request,
  {
    activeCount = 0,
    capacity = 1,
    busySites,
    measuringSites,
    measuringRuns = [],
    measurementWindows,
    now = Date.now(),
  } = {}
) {
  if (!request || request.status !== 'queued') return [];
  const blockers = [];
  const retryAt = request.next_attempt_at ? Date.parse(request.next_attempt_at) : NaN;
  if (Number.isFinite(retryAt) && retryAt > now) {
    blockers.push({
      code: 'retry_wait',
      label: 'Retry scheduled',
      detail: `Automatic retry at ${new Date(retryAt).toISOString()}`,
    });
  }
  if (activeCount >= capacity) {
    blockers.push({
      code: 'capacity',
      label: 'Waiting for worker capacity',
      detail: `All ${capacity} worker slot${capacity === 1 ? '' : 's'} are occupied`,
    });
  }
  if (busySites?.has(request.site) && request.delivery_mode !== 'report_only') {
    blockers.push({
      code: 'site_active',
      label: 'Site has active work',
      detail:
        'Another build or review is already running for this domain; read-only reporting can still proceed',
    });
  }
  const measurementDue = measurementWindows?.get?.(request.site) || null;
  const conflictsWithMeasurement = measuringRuns.length
    ? measuringRuns.some(run => run.site === request.site && measurementConflict(request, run))
    : measuringSites?.has(request.site) && !isMeasurementSafe(request);
  if (conflictsWithMeasurement && !request.measurement_override) {
    blockers.push({
      code: 'measurement_window',
      label: 'Measurement window active',
      detail: measurementDue
        ? `Held until ${measurementDue}`
        : 'Held until the current improvement measurement finishes',
    });
  }
  return blockers;
}

function queueMetrics(requests, now = Date.now()) {
  const queued = requests.filter(request => request.status === 'queued');
  const blocked = queued.filter(request => request.queue_block?.blocked);
  const byReason = {};
  for (const request of blocked) {
    for (const reason of request.queue_block.reasons || [])
      byReason[reason.code] = (byReason[reason.code] || 0) + 1;
  }
  const oldest = blocked
    .map(request => Date.parse(request.queue_block.blocked_since || request.created_at))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  return {
    queued: queued.length,
    blocked: blocked.length,
    eligible: queued.length - blocked.length,
    by_reason: byReason,
    oldest_blocked_at: oldest ? new Date(oldest).toISOString() : null,
    oldest_blocked_age_ms: oldest ? Math.max(0, now - oldest) : 0,
  };
}

function deliveryMetrics(requests, now = Date.now()) {
  const asOf = new Date(now);
  const monthStart = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1);
  const windows = [
    { key: '24h', label: '24h', start: now - 24 * 60 * 60 * 1000 },
    { key: '2d', label: '2d', start: now - 2 * 24 * 60 * 60 * 1000 },
    { key: '5d', label: '5d', start: now - 5 * 24 * 60 * 60 * 1000 },
    {
      key: 'month_to_date',
      label: `since ${new Date(monthStart).toISOString().slice(0, 10)}`,
      start: monthStart,
    },
  ];
  return {
    as_of: asOf.toISOString(),
    definition:
      'shipped means a change request reached deployed; verified is reported evidence and is not counted as shipped',
    windows: Object.fromEntries(
      windows.map(window => {
        const inWindow = requests.filter(request => {
          const updated = Date.parse(request.updated_at || '');
          return Number.isFinite(updated) && updated >= window.start;
        });
        const shipped = inWindow.filter(request => request.status === 'deployed').length;
        const verified = inWindow.filter(request => request.status === 'verified').length;
        const failed = inWindow.filter(request => request.status === 'failed').length;
        const attempts = shipped + verified + failed;
        return [
          window.key,
          {
            label: window.label,
            since: new Date(window.start).toISOString(),
            shipped,
            verified,
            failed,
            attempts,
            success_rate: attempts ? Math.round(((shipped + verified) / attempts) * 100) : null,
          },
        ];
      })
    ),
  };
}

function enrichChangeRequests(root, requests, settings, improvements, now = Date.now()) {
  const active = requests.filter(r =>
    ['claimed', 'running', 'reviewing'].includes(r.status)
  ).length;
  const capacity = Math.max(1, Number(settings?.max_concurrent || 1));
  const busySites = new Set(
    improvements.filter(r => ['building', 'review'].includes(r.state)).map(r => r.site)
  );
  const measuringSites = new Set(
    improvements.filter(r => r.state === 'measuring').map(r => r.site)
  );
  const measuringRuns = improvements.filter(r => r.state === 'measuring');
  const measurementWindows = new Map();
  for (const run of improvements.filter(r => r.state === 'measuring')) {
    if (!run.measurement_due) continue;
    const current = measurementWindows.get(run.site);
    if (!current || String(run.measurement_due) < current)
      measurementWindows.set(run.site, String(run.measurement_due));
  }
  const improvementsById = new Map(improvements.filter(r => r?.run_id).map(r => [r.run_id, r]));
  const descriptions = readSiteDescriptions(root);
  return requests.map(request => {
    const blockers = queueBlockers(request, {
      activeCount: active,
      capacity,
      busySites,
      measuringSites,
      measuringRuns,
      measurementWindows,
      now,
    });
    const blockedSince = request.queue_blocked_at || request.created_at;
    const blockedAgeMs = Math.max(0, now - (Date.parse(blockedSince) || now));
    const escalated = blockers.length > 0 && blockedAgeMs >= FAIRNESS_ESCALATION_MS;
    const nextRetry = request.next_attempt_at && Date.parse(request.next_attempt_at);
    const run = request.run_id ? improvementsById.get(request.run_id) || null : null;
    const isWorking = ['claimed', 'running', 'reviewing'].includes(request.status);
    const workingSince = request.claimed_at || run?.created_at || null;
    const heartbeatAt = request.heartbeat_at || run?.updated_at || null;
    return {
      ...request,
      measurement_window: measurementWindows.has(request.site)
        ? {
            active: true,
            due_at: measurementWindows.get(request.site),
            override: Boolean(request.measurement_override),
          }
        : null,
      work: {
        active: isWorking,
        state: isWorking ? request.status : run?.state || null,
        since: workingSince,
        heartbeat_at: heartbeatAt,
        worker: request.lease_owner || run?.agent?.provider || run?.source || null,
        run_id: request.run_id || run?.run_id || null,
        run_state: run?.state || null,
        title: run?.title || request.title,
      },
      site_context: siteContext(root, request.site, descriptions),
      queue_block: blockers.length
        ? {
            blocked: true,
            primary: blockers[0],
            reasons: blockers,
            blocked_since: blockedSince,
            blocked_age_ms: blockedAgeMs,
            escalated,
            next_check_at:
              Number.isFinite(nextRetry) && nextRetry > now
                ? new Date(nextRetry).toISOString()
                : null,
          }
        : request.status === 'queued'
          ? {
              blocked: false,
              primary: {
                code: 'eligible',
                label: 'Eligible for pickup',
                detail: 'Due for automatic dispatch',
              },
              reasons: [],
            }
          : null,
    };
  });
}

function buildQueueSnapshot(root, requests, settings, improvements, now = Date.now()) {
  const enriched = enrichChangeRequests(root, requests, settings, improvements, now);
  return {
    requests: enriched,
    queue_metrics: queueMetrics(enriched, now),
    delivery_metrics: deliveryMetrics(enriched, now),
  };
}

module.exports = {
  FAIRNESS_ESCALATION_MS,
  readSiteDescriptions,
  siteContext,
  queueBlockers,
  isMeasurementSafe,
  measurementScope,
  measurementConflict,
  queueMetrics,
  deliveryMetrics,
  enrichChangeRequests,
  buildQueueSnapshot,
};
