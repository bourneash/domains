'use strict';

const runtime = require('./agent-runtime');

function nextDue(routine, now) {
  if (routine.trigger_type !== 'interval') return routine.next_due_at;
  const seconds = Number(routine.schedule);
  if (!Number.isFinite(seconds) || seconds < 1) return null;
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

function tick(store, { now = new Date(), dueLimit = 100 } = {}) {
  runtime.ensureRegistry(store);
  const watchdogs = store.auditAgentWatchdogs({ now });
  const due = store.listAgentRoutines({
    status: 'active',
    due_before: now.toISOString(),
    limit: dueLimit,
  });
  const dispatches = [];
  for (const routine of due) {
    const agent = store.getAgent(routine.agent_id);
    if (!agent || agent.status !== 'active') continue;
    const scheduledAt = now.toISOString();
    const idempotencyKey = `routine:${routine.routine_id}:${scheduledAt}`;
    const started = runtime.beginRun(store, {
      agent_id: agent.agent_id,
      goal_id: routine.routine_id,
      idempotency_key: idempotencyKey,
      result: { trigger: 'heartbeat', routine_id: routine.routine_id, routine: routine.name },
    });
    // A routine run is not allowed to disappear silently. The watchdog is
    // armed before dispatch is reported to the caller.
    if (!started.reused) {
      store.createAgentWatchdog({
        run_id: started.run.run_id,
        expected_outcome: `routine ${routine.name} reaches a terminal state`,
        timeout_seconds: 900,
        recovery_action: 'escalate',
      });
    }
    store.touchAgentRoutine(routine.routine_id, {
      last_run_at: scheduledAt,
      next_due_at: nextDue(routine, now),
    });
    dispatches.push({
      routine,
      agent,
      run: started.run,
      reused: started.reused,
      trigger: 'heartbeat',
      scheduled_at: scheduledAt,
    });
  }
  store.record({
    event_type: 'agent.heartbeat.tick',
    source: 'agent-heartbeat',
    entity_type: 'agent-heartbeat',
    entity_id: now.toISOString(),
    payload: { checked_routines: due.length, dispatched: dispatches.length, watchdogs },
  });
  return { dispatched: dispatches, watchdogs };
}

function triggerEvent(
  store,
  { event_type, event_id, payload = {}, now = new Date(), dueLimit = 100 } = {}
) {
  if (!event_type) throw new Error('event_type is required');
  runtime.ensureRegistry(store);
  const routines = store
    .listAgentRoutines({ status: 'active', limit: 1000 })
    .filter(
      routine =>
        routine.trigger_type === 'event' &&
        (routine.schedule === event_type || routine.schedule === '*')
    )
    .slice(0, dueLimit);
  const dispatches = [];
  const digest = require('node:crypto')
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 32);
  for (const routine of routines) {
    const agent = store.getAgent(routine.agent_id);
    if (!agent || agent.status !== 'active') continue;
    const started = runtime.beginRun(store, {
      agent_id: agent.agent_id,
      goal_id: routine.routine_id,
      idempotency_key: `event:${routine.routine_id}:${event_id || digest}`,
      result: { trigger: 'event', event_type, event_id: event_id || null, payload },
    });
    if (!started.reused)
      store.createAgentWatchdog({
        run_id: started.run.run_id,
        expected_outcome: `event routine ${routine.name} reaches a terminal state`,
        timeout_seconds: 900,
        recovery_action: 'escalate',
      });
    store.touchAgentRoutine(routine.routine_id, {
      last_run_at: now.toISOString(),
      next_due_at: null,
    });
    dispatches.push({
      routine,
      agent,
      run: started.run,
      reused: started.reused,
      trigger: 'event',
      event_type,
      event_id: event_id || null,
    });
  }
  store.record({
    event_type: 'agent.event.trigger',
    source: 'agent-heartbeat',
    entity_type: 'agent-event',
    entity_id: event_id || now.toISOString(),
    payload: { event_type, dispatched: dispatches.length },
  });
  return { dispatched: dispatches };
}

module.exports = { tick, triggerEvent, nextDue };
