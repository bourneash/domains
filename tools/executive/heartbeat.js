'use strict';

const eventstore = require('../fleet-dashboard/server/eventstore');
const executive = require('../fleet-dashboard/server/executive');
const scorecard = require('../fleet-dashboard/server/executive-scorecard');
const liveness = require('../fleet-dashboard/server/executive-liveness');

function summary(score, live = { stranded_count: 0, stranded: [] }) {
  return [
    `Hourly executive heartbeat: ${score.status}.`,
    `${score.outcomes.proven} proven, ${score.outcomes.pending_measurement} awaiting measurement, ${score.execution.delivered_requests} delivered request(s).`,
    live.stranded_count
      ? `Liveness: ${live.stranded_count} stranded work item(s) require explicit recovery.`
      : 'Liveness: no stranded executive work detected.',
    score.attention.length
      ? `Attention: ${score.attention.join('; ')}.`
      : 'No blocked delivery signals.',
    `Next: ${score.next_step}`,
  ].join(' ');
}

function run({ root, now = new Date(), windowDays = 30 } = {}) {
  if (!root) throw new Error('executive heartbeat requires root');
  const store = eventstore.open(root);
  const audit = executive.action(store, {
    actor: 'system',
    action_type: 'observe',
    summary: 'Hourly executive actionability heartbeat',
    target_type: 'executive-scorecard',
    target_id: 'fleet',
  });
  try {
    const current = scorecard.buildScorecard(store, { now, windowDays });
    const live = liveness.audit(store, { now });
    const heartbeat = { ...current, liveness: live };
    const prior = store.list({ event_type: 'executive.heartbeat', limit: 1 })[0];
    const priorStatus = prior?.payload?.status || null;
    const event = store.record({
      event_type: 'executive.heartbeat',
      source: 'executive-heartbeat',
      entity_type: 'executive-scorecard',
      entity_id: 'fleet',
      payload: heartbeat,
    });
    // Only message on a state change or when there is a new attention signal;
    // the durable scorecard/event remains available every hour without inbox spam.
    const attentionSignature = `${current.attention.join('|')}|${(live.stranded || []).map(item => item.recovery_key).join('|')}`;
    const priorAttention = `${prior?.payload?.attention?.join('|') || ''}|${(prior?.payload?.liveness?.stranded || []).map(item => item.recovery_key).join('|')}`;
    let message = null;
    if (!prior || priorStatus !== current.status || attentionSignature !== priorAttention) {
      message = executive.message(store, {
        actor: 'system',
        body: summary(current, live),
        metadata: { kind: 'executive-heartbeat', scorecard: current, liveness: live },
      });
    }
    executive.finishAction(store, audit.action_id, {
      status: 'completed',
      result: {
        event_id: event.event_id,
        scorecard: current,
        liveness: live,
        message_id: message?.message_id || null,
      },
    });
    return { scorecard: current, liveness: live, message, event };
  } catch (error) {
    executive.finishAction(store, audit.action_id, { status: 'failed', error: error.message });
    throw error;
  } finally {
    store.close();
  }
}

module.exports = { run, summary };
