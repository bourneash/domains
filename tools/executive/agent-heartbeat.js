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
    store.touchAgentRoutine(routine.routine_id, {
      last_run_at: now.toISOString(),
      next_due_at: nextDue(routine, now),
    });
    dispatches.push({ routine, agent, trigger: 'heartbeat', scheduled_at: now.toISOString() });
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

module.exports = { tick, nextDue };
