'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readSiteDescriptions(root) {
  const descriptions = {};
  try {
    const text = fs.readFileSync(path.join(root, 'DOMAINS_INDEX.md'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\|\s*([^|]+?)\s*\|[^|]*\|\s*([^|]+?)\s*\|\s*$/);
      if (match && match[2].trim()) descriptions[match[1].trim()] = match[2].trim();
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
      (domain === 'fleet' ? 'Fleet-wide control-plane operation' : 'Site description is not in the fleet registry'),
  };
}

function queueBlockers(request, { activeCount = 0, capacity = 1, busySites, measuringSites, now = Date.now() } = {}) {
  if (!request || request.status !== 'queued') return [];
  const blockers = [];
  const retryAt = request.next_attempt_at ? Date.parse(request.next_attempt_at) : NaN;
  if (Number.isFinite(retryAt) && retryAt > now) {
    blockers.push({
      code: 'retry_wait',
      label: 'Retry scheduled',
      detail: `Automatic retry at ${new Date(retryAt).toLocaleString()}`,
    });
  }
  if (activeCount >= capacity) {
    blockers.push({
      code: 'capacity',
      label: 'Waiting for worker capacity',
      detail: `All ${capacity} worker slot${capacity === 1 ? '' : 's'} are occupied`,
    });
  }
  if (busySites?.has(request.site)) {
    blockers.push({
      code: 'site_active',
      label: 'Site has active work',
      detail: 'Another build or review is already running for this domain',
    });
  }
  if (measuringSites?.has(request.site) && request.delivery_mode !== 'report_only') {
    blockers.push({
      code: 'measurement_window',
      label: 'Measurement window active',
      detail: 'Held until the current improvement measurement finishes',
    });
  }
  return blockers;
}

function enrichChangeRequests(root, requests, settings, improvements, now = Date.now()) {
  const active = requests.filter(r => ['claimed', 'running', 'reviewing'].includes(r.status)).length;
  const capacity = Math.max(1, Number(settings?.max_concurrent || 1));
  const busySites = new Set(
    improvements.filter(r => ['building', 'review'].includes(r.state)).map(r => r.site)
  );
  const measuringSites = new Set(improvements.filter(r => r.state === 'measuring').map(r => r.site));
  const descriptions = readSiteDescriptions(root);
  return requests.map(request => {
    const blockers = queueBlockers(request, {
      activeCount: active,
      capacity,
      busySites,
      measuringSites,
      now,
    });
    return {
      ...request,
      site_context: siteContext(root, request.site, descriptions),
      queue_block: blockers.length
        ? { blocked: true, primary: blockers[0], reasons: blockers }
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

module.exports = { readSiteDescriptions, siteContext, queueBlockers, enrichChangeRequests };
