'use strict';

// Shared by the queue and file board. Clearance records evidence; release is
// a separate operator decision. Neither elapsed time nor a diagnosis releases work.
const FIELDS = [
  'hold_condition',
  'gate_not_before',
  'gate_cleared_by',
  'gate_cleared_at',
  'gate_clearance_evidence',
  'gate_released_by',
  'gate_released_at',
  'gate_revision',
  'gate_clearance_revision',
];
const CLEARANCE_FIELDS = FIELDS.slice(2).filter(field => field !== 'gate_revision');
const IMPLEMENTATION_MODES = new Set(['direct', 'pull_request']);

function legacyReason(input = {}) {
  const text = `${input.title || ''}\n${input.body || ''}`;
  if (/\bretain as unclaimed\b/i.test(text))
    return 'request says to remain unclaimed but this queue dispatches automatically';
  if (
    /\b(?:do not|must not)\s+(?:execute|start|dispatch|pick up)\s+until\b|\b(?:execution\s+)?gate\s*:\s*wait for\b|\bhold until\b|\brequires? owner confirmation before\b/i.test(
      text
    )
  )
    return 'request has an unresolved execution prerequisite';
  return null;
}

function hasGate(input = {}) {
  return Boolean(input.hold_condition || input.gate_not_before);
}

function legacyNotBefore(input = {}) {
  if (!legacyReason(input)) return null;
  const match = String(input.body || '').match(
    /\b(?:by|until|not before)\s+(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d))/i
  );
  return match && Number.isFinite(Date.parse(match[1])) ? match[1] : null;
}

function validate(input = {}) {
  for (const field of FIELDS) {
    if (input[field] != null && (typeof input[field] !== 'string' || !input[field].trim()))
      throw error(400, `${field} must be a nonempty string or null`);
    if (String(input[field] || '').length > (field === 'gate_clearance_evidence' ? 8000 : 2000))
      throw error(400, `${field} is too long`);
  }
  for (const field of ['gate_not_before', 'gate_cleared_at', 'gate_released_at']) {
    if (
      input[field] &&
      (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(input[field]) ||
        !Number.isFinite(Date.parse(input[field])))
    )
      throw error(400, `${field} must be an ISO timestamp with a timezone`);
  }
  if (input.gate_not_before && !input.hold_condition)
    throw error(400, 'gate_not_before requires hold_condition');
  if (CLEARANCE_FIELDS.some(field => input[field]) && !input.hold_condition)
    throw error(400, 'gate evidence requires hold_condition');
}

function clearanceReason(input, now = Date.now()) {
  if (!hasGate(input)) return null;
  if (!input.hold_condition) return 'execution gate has no recorded condition';
  if (!input.gate_cleared_by || !input.gate_clearance_evidence || !input.gate_cleared_at)
    return 'execution gate requires clearance owner, timestamp, and evidence';
  if (!input.gate_revision || input.gate_clearance_revision !== input.gate_revision)
    return 'execution gate clearance belongs to a stale request revision';
  const cleared = Date.parse(input.gate_cleared_at);
  if (!Number.isFinite(cleared) || cleared > now)
    return 'execution gate clearance timestamp is invalid or in the future';
  if (input.gate_not_before) {
    const time = Date.parse(input.gate_not_before);
    if (!Number.isFinite(time) || time > now) return 'execution gate time has not cleared';
  }
  return null;
}

function reason(input = {}, { now = Date.now() } = {}) {
  if (hasGate(input)) {
    const blocked = clearanceReason(input, now);
    if (blocked) return blocked;
    if (!input.gate_released_by || !input.gate_released_at)
      return 'execution gate is cleared but awaits explicit release';
    const released = Date.parse(input.gate_released_at);
    if (
      !Number.isFinite(released) ||
      released > now ||
      released < Date.parse(input.gate_cleared_at) ||
      (input.gate_not_before && released < Date.parse(input.gate_not_before))
    )
      return 'execution gate release timestamp is invalid';
    return null;
  }
  return IMPLEMENTATION_MODES.has(input.delivery_mode || 'direct') ? legacyReason(input) : null;
}

function assertReady(input, options) {
  const blocked = reason(input, options);
  if (blocked) throw error(409, blocked);
}

function metadata(input) {
  return Object.fromEntries(FIELDS.map(field => [field, input[field] || null]));
}

function error(httpStatus, message) {
  return Object.assign(new Error(message), { httpStatus });
}

module.exports = {
  FIELDS,
  CLEARANCE_FIELDS,
  hasGate,
  validate,
  legacyReason,
  legacyNotBefore,
  clearanceReason,
  reason,
  assertReady,
  metadata,
};
