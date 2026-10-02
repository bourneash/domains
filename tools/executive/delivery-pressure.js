'use strict';

const path = require('node:path');
const eventstore = require('../fleet-dashboard/server/eventstore');
const readiness = require('./delivery-readiness');
const { config } = require('./overwatch-alert');

const ALERT_INTERVAL_MS = 2 * 60 * 60 * 1000;
const STALE_PICKUP_MS = 30 * 60 * 1000;
const NO_DELIVERY_MS = 60 * 60 * 1000;

function assess(store, root, now = Date.now()) {
  const queue = readiness.snapshot(store, root, now);
  if (!queue.settings.enabled)
    return {
      reason: null,
      eligible: queue.eligibleQueued.length,
      working: queue.working.length,
      blocked: queue.blockedQueued.length,
      stale_eligible: 0,
      latest_delivery_at: null,
    };
  const staleEligible = queue.eligibleQueued.filter(
    row => now - (Date.parse(row.created_at || '') || now) >= STALE_PICKUP_MS
  );
  const latestDeliveryAt = Math.max(
    0,
    ...queue.delivered.map(row => Date.parse(row.updated_at || '') || 0)
  );
  const recentTick = store
    .listExecutiveActions({ action_type: 'tick', limit: 5 })
    .some(
      row =>
        ['completed', 'completed_with_warning'].includes(row.status) &&
        now - (Date.parse(row.finished_at || row.started_at || '') || 0) <= NO_DELIVERY_MS
    );
  const emptyPipeline =
    recentTick &&
    queue.eligibleQueued.length === 0 &&
    queue.working.length === 0 &&
    latestDeliveryAt < now - NO_DELIVERY_MS;
  const reason = staleEligible.length
    ? 'eligible queue has unclaimed work older than 30 minutes'
    : emptyPipeline
      ? 'no eligible or active delivery work and no verified delivery in the last hour'
      : null;
  return {
    reason,
    eligible: queue.eligibleQueued.length,
    working: queue.working.length,
    blocked: queue.blockedQueued.length,
    stale_eligible: staleEligible.length,
    latest_delivery_at: latestDeliveryAt ? new Date(latestDeliveryAt).toISOString() : null,
  };
}

async function alert(store, root, { now = Date.now(), env = process.env, fetchImpl = fetch } = {}) {
  const state = assess(store, root, now);
  if (!state.reason) return { attempted: false, ...state };
  const key = `executive-delivery-pressure:${Math.floor(now / ALERT_INTERVAL_MS)}`;
  if (
    store
      .listExecutiveNotifications({ recipient: 'owner', limit: 500 })
      .some(row => row.dedupe_key === key)
  )
    return { ...state, attempted: false, skipped: 'already-alerted' };
  const text = `🚨 Executive delivery stalled: ${state.reason}. Eligible ${state.eligible}; working ${state.working}; blocked ${state.blocked}. Exec must advance a queue-ready site or name the blocker, owner, and deadline. Latest verified delivery: ${state.latest_delivery_at || 'none recorded'}.`;
  store.createExecutiveNotification({
    recipient: 'owner',
    notification_type: 'executive-delivery-pressure',
    title: 'Executive delivery has stalled',
    body: text,
    dedupe_key: key,
  });
  const { token, channel } = config(root, env);
  if (!token)
    return { ...state, attempted: true, sent: false, error: 'SLACK_BOT_TOKEN unavailable' };
  try {
    const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, text }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.json();
    return {
      ...state,
      attempted: true,
      sent: Boolean(response.ok && body?.ok),
      channel,
      error: body?.ok ? null : body?.error || `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ...state,
      attempted: true,
      sent: false,
      channel,
      error: String(error.message || error),
    };
  }
}

if (require.main === module) {
  const root = process.env.FD_DOMAINS_ROOT || path.resolve(__dirname, '..', '..');
  const store = eventstore.open(root);
  alert(store, root)
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(`[delivery-pressure] ${error.message || error}`);
      process.exitCode = 1;
    })
    .finally(() => store.close());
}

module.exports = { assess, alert };
