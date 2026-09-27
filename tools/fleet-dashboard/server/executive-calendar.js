'use strict';

// File-backed calendar control plane. The file is human-readable and checked
// in, but all mutations go through a short process lock.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE = root => path.join(root, 'ops', 'executive', 'calendar.json');
const LOCK = root => path.join(root, 'tools', 'executive', 'data', 'calendar.lockdir');
const STATES = new Set(['scheduled', 'picked_up', 'completed', 'overdue', 'failed', 'cancelled']);
const ACTIONS = new Set(['executive-run', 'job', 'reminder']);
const JOBS = Object.freeze({
  'executive-run': { script: 'tools/executive/run-scheduled.sh', args: [] },
  'intelligence-snapshot': { script: 'tools/executive/run-intelligence-snapshot.sh', args: [] },
  'project-manager': { script: 'tools/executive/run-project-manager.sh', args: [] },
  'approved-work': { script: 'tools/executive/run-approved-work.sh', args: [] },
});
const TRANSITIONS = Object.freeze({
  scheduled: new Set(['picked_up', 'cancelled', 'overdue']),
  overdue: new Set(['picked_up', 'cancelled']),
  picked_up: new Set(['completed', 'failed', 'cancelled']),
  failed: new Set(['scheduled', 'cancelled']),
  completed: new Set(), cancelled: new Set(),
});
const MAX_EVENTS = 2000;
const MAX_LOCK_MS = 120000;
function now() { return new Date().toISOString(); }
function error(message, status = 400) { return Object.assign(new Error(message), { status }); }
function sleep(ms) { const end = Date.now() + ms; while (Date.now() < end) {} }
function withLock(root, fn) {
  const lock = LOCK(root); fs.mkdirSync(path.dirname(lock), { recursive: true });
  const started = Date.now(); let acquired = false;
  while (!acquired) {
    try { fs.mkdirSync(lock); acquired = true; fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}\n`); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > MAX_LOCK_MS) fs.rmSync(lock, { recursive: true, force: true }); } catch {}
      if (Date.now() - started >= MAX_LOCK_MS) throw error('calendar is busy; retry shortly', 409);
      sleep(20);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
function read(root) {
  try {
    const data = JSON.parse(fs.readFileSync(FILE(root), 'utf8'));
    if (!data || !Array.isArray(data.events)) throw error('calendar file has invalid schema', 500);
    return { schema: 'executive-calendar/v1', timezone: data.timezone || 'America/New_York', events: data.events };
  } catch (e) { if (e.code !== 'ENOENT') throw e; return { schema: 'executive-calendar/v1', timezone: 'America/New_York', events: [] }; }
}
function writeUnlocked(root, data) {
  const file = FILE(root); fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o640 }); fs.renameSync(tmp, file); return data;
}
function write(root, data) { return withLock(root, () => writeUnlocked(root, data)); }
function validateAction(action) {
  if (!action || typeof action !== 'object' || !ACTIONS.has(action.type)) throw error('unsupported calendar action');
  if (action.type === 'job' && (typeof action.key !== 'string' || !JOBS[action.key])) throw error('job action is not allowlisted');
  return action.type === 'job' ? { type: 'job', key: action.key } : { type: action.type };
}
function nextOccurrence(e) {
  if (e.recurrence?.kind !== 'interval') return null;
  const m = String(e.recurrence.value).trim().match(/^(\d+)\s+(minute|minutes|hour|hours|day|days|week|weeks)$/);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 365) return null;
  return new Date(Date.parse(e.at) + Number(m[1]) * ({ minute: 60000, minutes: 60000, hour: 3600000, hours: 3600000, day: 86400000, days: 86400000, week: 604800000, weeks: 604800000 }[m[2]])).toISOString();
}
function normalize(input, existing = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('calendar event must be an object');
  const title = String(input.title ?? existing.title ?? '').trim().slice(0, 240); if (!title) throw error('title is required');
  const at = String(input.at ?? existing.at ?? '').trim();
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(at) || !Number.isFinite(Date.parse(at))) throw error('at must be an ISO date/time with timezone');
  const recurrence = input.recurrence !== undefined ? input.recurrence : (existing.recurrence || null);
  if (recurrence && (typeof recurrence !== 'object' || recurrence.kind !== 'interval' || !nextOccurrence({ at, recurrence }))) throw error('only valid interval recurrence is supported');
  const action = validateAction(input.action ?? existing.action ?? { type: 'reminder' });
  const owner = String(input.owner ?? existing.owner ?? 'ceo').trim(); if (!/^[a-z][a-z0-9-]{1,79}$/.test(owner)) throw error('invalid owner');
  const site = String(input.site ?? existing.site ?? '').trim(); if (site && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,119}$/.test(site)) throw error('invalid site');
  return { ...existing, id: existing.id || `cal_${crypto.randomUUID()}`, title, description: String(input.description ?? existing.description ?? '').trim().slice(0, 4000), owner, site, at, recurrence, action, state: existing.state || 'scheduled', picked_up_at: existing.picked_up_at || null, picked_up_by: existing.picked_up_by || null, claim_id: existing.claim_id || null, claim_expires_at: existing.claim_expires_at || null, dispatched_at: existing.dispatched_at || null, completed_at: existing.completed_at || null, result: existing.result || null, occurrences: Array.isArray(existing.occurrences) ? existing.occurrences : [], followup_required: existing.followup_required !== false, followup_status: existing.followup_status || null, followup_note: existing.followup_note || null, audit: Array.isArray(existing.audit) ? existing.audit : [], created_at: existing.created_at || now(), updated_at: now() };
}
function list(root, query = {}) { return read(root).events.filter(e => !query.state || e.state === query.state).filter(e => !query.from || Date.parse(e.at) >= Date.parse(query.from)).filter(e => !query.to || Date.parse(e.at) <= Date.parse(query.to)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)); }
function audit(e, actor, from, to, reason) { e.audit = [...(e.audit || []), { at: now(), actor, from, to, reason: String(reason || '').slice(0, 500) }].slice(-100); }
function create(root, input, actor = 'owner') { return withLock(root, () => { const data = read(root); if (data.events.length >= MAX_EVENTS) throw error('calendar event limit reached', 413); const event = normalize(input); audit(event, actor, null, 'scheduled', 'created'); data.events.push(event); return writeUnlocked(root, data).events.at(-1); }); }
function update(root, id, input, actor = 'owner') { return withLock(root, () => { const data = read(root); const i = data.events.findIndex(e => e.id === id); if (i < 0) throw error('calendar event not found', 404); if (!['scheduled', 'overdue', 'failed'].includes(data.events[i].state)) throw error('only pending or failed events can be edited', 409); const state = data.events[i].state; data.events[i] = normalize(input, data.events[i]); audit(data.events[i], actor, state, state, 'updated'); writeUnlocked(root, data); return data.events[i]; }); }
function transition(root, id, state, patch = {}, actor = 'owner') { return withLock(root, () => { const data = read(root); const e = data.events.find(x => x.id === id); if (!e) throw error('calendar event not found', 404); if (!STATES.has(state) || !TRANSITIONS[e.state]?.has(state)) throw error(`cannot transition ${e.state} to ${state}`, 409); const from = e.state; if (state === 'completed' && e.followup_required) { if (!['written', 'none'].includes(patch.followup_status)) throw error('completion requires followup_status=written or none', 422); if (patch.followup_status === 'written' && String(patch.followup_note || '').trim().length < 10) throw error('written follow-up requires a note', 422); } e.state = state; e.updated_at = now(); if (state === 'picked_up') { e.picked_up_at = e.picked_up_at || e.updated_at; e.picked_up_by = actor; } if (state === 'completed') { e.completed_at = e.updated_at; e.followup_status = patch.followup_status; e.followup_note = patch.followup_note || null; e.occurrences = [...(e.occurrences || []), { at: e.at, completed_at: e.completed_at, completed_by: actor, result: patch.result || null, followup_status: e.followup_status }].slice(-50); const next = nextOccurrence(e); if (next) { e.at = next; e.state = 'scheduled'; e.picked_up_at = null; e.picked_up_by = null; e.claim_id = null; e.claim_expires_at = null; e.dispatched_at = null; e.completed_at = null; } } if (state === 'failed') e.result = patch.result || e.result; audit(e, actor, from, e.state, patch.reason || 'state transition'); writeUnlocked(root, data); return e; }); }
function completeClaim(root, id, claimId, result, actor = 'system') { return withLock(root, () => { const data = read(root); const e = data.events.find(x => x.id === id); if (!e || e.state !== 'picked_up' || e.claim_id !== claimId) throw error('calendar claim is no longer valid', 409); const from = e.state; e.state = result.exit_code === 0 ? 'completed' : 'failed'; e.updated_at = now(); e.result = result; if (e.state === 'completed') { e.completed_at = e.updated_at; e.followup_status = 'written'; e.followup_note = 'Review this run and write any investigation follow-up into the executive work queue.'; e.occurrences = [...(e.occurrences || []), { at: e.at, completed_at: e.completed_at, completed_by: actor, result, followup_status: e.followup_status }].slice(-50); const next = nextOccurrence(e); if (next) { e.at = next; e.state = 'scheduled'; e.picked_up_at = null; e.picked_up_by = null; e.claim_id = null; e.claim_expires_at = null; e.dispatched_at = null; e.completed_at = null; } } audit(e, actor, from, e.state, 'allowlisted action completed'); writeUnlocked(root, data); return e; }); }
function reconcile(root, at = Date.now(), actor = 'system') { return withLock(root, () => { const data = read(root); let changed = false; for (const e of data.events) { if (e.state === 'scheduled' && Date.parse(e.at) < at) { audit(e, actor, e.state, 'overdue', 'past due'); e.state = 'overdue'; e.updated_at = now(); changed = true; } if (e.state === 'picked_up' && e.claim_expires_at && Date.parse(e.claim_expires_at) < at && !e.dispatched_at) { audit(e, actor, e.state, 'overdue', 'pickup claim expired'); e.state = 'overdue'; e.claim_id = null; e.claim_expires_at = null; e.updated_at = now(); changed = true; } } if (changed) writeUnlocked(root, data); return data.events.filter(e => e.state === 'overdue' || (e.state === 'scheduled' && Date.parse(e.at) <= at)); }); }
function claimDue(root, at = Date.now(), actor = 'system') { return withLock(root, () => { const data = read(root); const claimed = []; for (const e of data.events) { if (!['scheduled', 'overdue'].includes(e.state) || e.action?.type === 'reminder' || Date.parse(e.at) > at) continue; const id = crypto.randomUUID(); const from = e.state; e.state = 'picked_up'; e.claim_id = id; e.claim_expires_at = new Date(at + 15 * 60 * 1000).toISOString(); e.picked_up_at = now(); e.picked_up_by = actor; e.updated_at = e.picked_up_at; audit(e, actor, from, 'picked_up', 'dispatcher claim'); claimed.push({ ...e }); } if (claimed.length) writeUnlocked(root, data); return claimed; }); }
function markDispatched(root, id, claimId, result, actor = 'system') { return withLock(root, () => { const data = read(root); const e = data.events.find(x => x.id === id); if (!e || e.state !== 'picked_up' || e.claim_id !== claimId) throw error('calendar claim is no longer valid', 409); e.dispatched_at = now(); e.result = result; e.updated_at = e.dispatched_at; audit(e, actor, 'picked_up', 'picked_up', 'action dispatched'); writeUnlocked(root, data); return e; }); }
function due(root, at = Date.now()) { return list(root).filter(e => ['scheduled', 'overdue'].includes(e.state) && Date.parse(e.at) <= at); }
module.exports = { FILE, LOCK, JOBS, withLock, read, write, list, create, update, transition, completeClaim, reconcile, claimDue, markDispatched, due, nextOccurrence, STATES, ACTIONS };
