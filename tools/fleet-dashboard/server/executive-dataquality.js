'use strict';

// Turns recurring source gaps into one durable work item per gap. This keeps
// the executive roles from repeatedly asking for the same telemetry and gives
// the owner a visible, auditable queue without manufacturing data.

function desiredItems(quality = {}) {
  const items = [];
  for (const site of quality.coverage?.analytics?.missing_sites || []) {
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
      summary:
        'The site is in the managed analytics scope but no successful GA4 or GSC source was observed.',
      next_action:
        'Verify the property IDs, permissions, and latest fetch result; record the exact missing dependency.',
      evidence: [
        {
          label: 'Executive data-quality contract',
          note: 'Missing telemetry is unavailable evidence, not zero traffic.',
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
  const desired = desiredItems(quality);
  const byId = new Map(desired.map(item => [item.work_id, item]));
  const existing = store
    .listExecutiveWorkItems({ limit: 1000 })
    .filter(item => item.source_type === 'data-quality');
  const created = [];
  const updated = [];
  const resolved = [];
  for (const item of desired) {
    const current = existing.find(row => row.work_id === item.work_id);
    if (current) {
      updated.push(store.updateExecutiveWorkItem(current.work_id, item));
    } else {
      created.push(store.createExecutiveWorkItem(item));
    }
  }
  for (const current of existing) {
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
