'use strict';

// Optional external delivery for owner inbox notifications. The durable
// notification row is always written first; webhook failure must never block
// executive work or the dashboard request.
async function notify({ notification, workItem } = {}) {
  const url = String(process.env.FD_EXECUTIVE_WEBHOOK_URL || '').trim();
  if (!url || !notification) return { sent: false, reason: 'not-configured' };
  const text = [
    `Executive inbox: ${notification.title}`,
    notification.body,
    workItem?.work_id ? `request=${workItem.work_id}` : '',
    workItem?.due_at ? `due=${workItem.due_at}` : '',
  ].filter(Boolean).join('\n');
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    });
    return response.ok ? { sent: true } : { sent: false, reason: `webhook HTTP ${response.status}` };
  } catch (error) {
    return { sent: false, reason: error.message };
  }
}

async function drain(store, { limit = 20 } = {}) {
  const url = String(process.env.FD_EXECUTIVE_WEBHOOK_URL || '').trim();
  if (!url || !store?.listExecutiveNotifications) return { attempted: 0, sent: 0 };
  const now = new Date().toISOString();
  const pending = store.listExecutiveNotifications({ recipient: 'owner', limit: Math.min(Number(limit) || 20, 50) })
    .filter(item => item.delivery_status === 'pending' && (!item.next_attempt_at || item.next_attempt_at <= now));
  let sent = 0;
  for (const notification of pending) {
    const workItem = notification.work_id && store.getExecutiveWorkItem
      ? store.getExecutiveWorkItem(notification.work_id)
      : null;
    const attempts = Number(notification.delivery_attempts || 0) + 1;
    try {
      const result = await notify({ notification, workItem });
      if (result.sent) {
        store.updateExecutiveNotificationDelivery(notification.notification_id, {
          delivery_status: 'sent', delivery_attempts: attempts, last_error: null,
          delivered_at: new Date().toISOString(), next_attempt_at: null,
        });
        sent += 1;
      } else {
        const exhausted = attempts >= 5;
        store.updateExecutiveNotificationDelivery(notification.notification_id, {
          delivery_status: exhausted ? 'failed' : 'pending', delivery_attempts: attempts,
          last_error: result.reason || 'webhook delivery failed',
          next_attempt_at: exhausted ? null : new Date(Date.now() + Math.min(60, 2 ** attempts) * 60 * 1000).toISOString(),
        });
      }
    } catch (error) {
      store.updateExecutiveNotificationDelivery(notification.notification_id, {
        delivery_status: attempts >= 5 ? 'failed' : 'pending', delivery_attempts: attempts,
        last_error: error.message, next_attempt_at: attempts >= 5 ? null : new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      });
    }
  }
  return { attempted: pending.length, sent };
}

module.exports = { notify, drain };
