'use strict';

// Paperclip-inspired liveness contract for Fleet Executive work. A lease or a
// status label is not, by itself, evidence that work has a live path. This
// module is deliberately diagnostic: it never requeues work or changes an
// owner's decision. Recovery remains an explicit, auditable action.

const TERMINAL = new Set(['done', 'cancelled']);
const ACTIVE = new Set(['in_progress']);

function ageMs(value, now) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? Math.max(0, now.getTime() - timestamp) : null;
}

function audit(store, { now = new Date(), leaseGraceMs = 0 } = {}) {
  if (!store || typeof store.listExecutiveWorkItems !== 'function')
    throw new Error('executive liveness requires an event store');

  const items = store.listExecutiveWorkItems({ limit: 1000 });
  const links =
    typeof store.listWorkflowLinks === 'function' ? store.listWorkflowLinks({ limit: 2000 }) : [];
  const linkedBlockers = new Map();
  for (const link of links) {
    if (link.relation !== 'blocks') continue;
    const key = `${link.to_type}:${link.to_id}`;
    linkedBlockers.set(key, (linkedBlockers.get(key) || 0) + 1);
  }

  const stranded = [];
  for (const item of items) {
    if (TERMINAL.has(String(item.status))) continue;
    const id = String(item.work_id);
    const key = `work-item:${id}`;
    const leaseExpired =
      item.lease_expires_at &&
      Date.parse(item.lease_expires_at) <= now.getTime() - Number(leaseGraceMs || 0);
    const activeWithoutPath =
      ACTIVE.has(String(item.status)) &&
      !item.lease_owner &&
      !item.retry_at &&
      !item.waiting_on &&
      !linkedBlockers.has(key);
    const expiredActiveLease = Boolean(
      leaseExpired && item.lease_owner && String(item.status) === 'in_progress'
    );
    const blockedWithoutReason =
      ['blocked', 'waiting'].includes(String(item.status)) &&
      !item.waiting_on &&
      !linkedBlockers.has(key) &&
      !item.retry_at;
    if (!expiredActiveLease && !activeWithoutPath && !blockedWithoutReason) continue;

    const reason = expiredActiveLease
      ? 'lease_expired'
      : blockedWithoutReason
        ? 'waiting_without_durable_path'
        : 'active_without_durable_path';
    stranded.push({
      work_id: id,
      title: item.title,
      owner: item.owner,
      status: item.status,
      reason,
      attempts: Number(item.attempts || 0),
      age_ms: ageMs(item.updated_at || item.created_at, now),
      recovery_key: `executive-liveness:${id}:${reason}`,
      next_action:
        item.next_action ||
        'Name a durable owner, retry, blocker, or explicit recovery action before continuing.',
    });
  }

  return {
    schema: 'executive-liveness/v1',
    generated_at: now.toISOString(),
    healthy: stranded.length === 0,
    total_work_items: items.length,
    stranded_count: stranded.length,
    stranded,
  };
}

module.exports = { audit };
