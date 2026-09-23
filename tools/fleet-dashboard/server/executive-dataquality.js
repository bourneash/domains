'use strict';

// Turns recurring source gaps into one durable work item per gap. This keeps
// the executive roles from repeatedly asking for the same telemetry and gives
// the owner a visible, auditable queue without manufacturing data.

function analyticsSourceAvailable(quality = {}) {
  const contract = (quality.contracts || []).find(row => row.source === 'analytics');
  return contract ? contract.ok !== false : true;
}

function desiredItems(quality = {}) {
  const items = [];
  const analyticsAvailable = analyticsSourceAvailable(quality);
  const missingDetails = new Map(
    (quality.coverage?.analytics?.missing_details || []).map(detail => [detail.site, detail])
  );
  for (const site of analyticsAvailable ? quality.coverage?.analytics?.missing_sites || [] : []) {
    const detail = missingDetails.get(site) || {
      site,
      configured: null,
      ga4_status: 'not_observed',
      gsc_status: 'not_observed',
    };
    items.push({
      work_id: `data-quality:analytics:${site}`,
      title: `Restore analytics coverage for ${site}`,
      kind: 'evidence',
      status: 'open',
      priority: 'normal',
      owner: 'cto',
      source_type: 'data-quality',
      source_id: `analytics:${site}`,
      site,
      summary: `The site is in the managed analytics scope but no successful GA4 or GSC source was observed (configured=${detail.configured === true ? 'yes' : detail.configured === false ? 'no' : 'unknown'}, GA4=${detail.ga4_status}, GSC=${detail.gsc_status}).`,
      next_action:
        'Verify the registry property IDs, service-account permissions, and latest fetch result; record the exact missing dependency and rerun the deterministic collector.',
      evidence: [
        {
          label: 'Executive data-quality contract',
          note: 'Missing telemetry is unavailable evidence, not zero traffic.',
        },
        {
          label: 'Latest analytics health',
          detail,
        },
      ],
      created_by: 'system',
    });
  }
  for (const trackingId of quality.coverage?.revenue_attribution?.unmapped_tracking_ids || []) {
    items.push({
      work_id: `data-quality:revenue-attribution:${trackingId.toLowerCase()}`,
      title: `Resolve revenue attribution for ${trackingId}`,
      kind: 'evidence',
      status: 'open',
      priority: 'normal',
      owner: 'cfo',
      source_type: 'data-quality',
      source_id: `revenue-attribution:${trackingId}`,
      site: 'fleet',
      summary:
        'Affiliate earnings include a tracking ID that cannot be assigned uniquely to a managed site.',
      next_action:
        'Map the tracking ID from the source configuration before assigning revenue or ROI.',
      evidence: [
        {
          label: 'Executive revenue-attribution contract',
          note: 'Do not assign unmatched revenue to a site.',
        },
      ],
      created_by: 'system',
    });
  }
  return items;
}

function sync(store, quality = {}) {
  if (!store) throw new Error('data-quality work sync requires an event store');
  // Source snapshots can contain duplicate rows after a collector retry. The
  // workbench key is intentionally idempotent, so collapse those rows before
  // touching SQLite rather than allowing a duplicate INSERT to abort the
  // entire intelligence snapshot.
  const desired = [...new Map(desiredItems(quality).map(item => [item.work_id, item])).values()];
  const analyticsAvailable = analyticsSourceAvailable(quality);
  const byId = new Map(desired.map(item => [item.work_id, item]));
  const existing = store.listExecutiveWorkItems({ source_type: 'data-quality', limit: 1000 });
  const created = [];
  const updated = [];
  const resolved = [];
  for (const item of desired) {
    // Work IDs are globally unique, but older executive ticks may have
    // created the same durable case under a different source_type. Query by
    // the authoritative key instead of assuming the filtered source list
    // contains every historical row.
    const current = store.getExecutiveWorkItem(item.work_id);
    if (current) {
      // A gap can disappear from one snapshot and return in a later one. Do
      // not carry a historical cancellation/resolution note onto reopened
      // work: that makes a currently observed gap look already handled to the
      // executive UI and to the next role prompt.
      updated.push(
        store.updateExecutiveWorkItem(current.work_id, {
          ...item,
          resolved_at: null,
          resolution_note: null,
        })
      );
    } else {
      created.push(store.createExecutiveWorkItem(item));
    }
  }
  for (const current of existing) {
    if (!analyticsAvailable && current.work_id.startsWith('data-quality:analytics:')) continue;
    if (byId.has(current.work_id) || ['done', 'cancelled'].includes(current.status)) continue;
    resolved.push(
      store.updateExecutiveWorkItem(current.work_id, {
        status: 'done',
        resolution_note: 'The latest deterministic snapshot no longer reports this gap.',
      })
    );
  }
  return { created, updated, resolved };
}

module.exports = { desiredItems, sync };
