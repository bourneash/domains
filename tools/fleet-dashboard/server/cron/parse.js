'use strict';

// Crontab line parsing + safe line mutations. Ported verbatim from
// tools/cron-manager (server/crontab.js) when the cron control plane was
// folded into the fleet dashboard.

// Matches an optional leading comment marker, then 5 whitespace-separated
// schedule fields, then the command (rest of line).
const CRON_RE = /^(#\s*)?((?:\S+\s+){4}\S+)\s+(.+)$/;

// A cron schedule field uses only these characters across our crontabs.
const FIELD_RE = /^[\d*,/-]+$/;

function isValidCron(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f) => FIELD_RE.test(f));
}

// Single source of truth for turning a crontab command into a role. Two shapes:
//   run-worker.sh <role>   → a worker role (honours ops/.<role>-disabled → pausable)
//   run-<role>.sh          → a dedicated-script role (not a worker, not pausable)
// Returns { role, worker } with role lowercased, or { role: null, worker: false }.
// Both roles.js and the cron control plane consume this so recognition can never
// drift between the roles matrix and the cron page.
function roleFromCommand(command) {
  const cmd = String(command || '');
  let m;
  if ((m = cmd.match(/run-worker\.sh\s+([A-Za-z0-9._-]+)/i))) {
    return { role: m[1].toLowerCase(), worker: true };
  }
  if ((m = cmd.match(/run-([A-Za-z0-9-]+)\.sh/i)) && !['worker', 'role'].includes(m[1].toLowerCase())) {
    return { role: m[1].toLowerCase(), worker: false };
  }
  return { role: null, worker: false };
}

// Back-compat thin wrapper: just the role name (or null).
function extractRole(command) {
  return roleFromCommand(command).role;
}

function parseCrontab(text) {
  const lines = text.split('\n');
  const entries = [];
  lines.forEach((line, lineIndex) => {
    const m = line.match(CRON_RE);
    if (!m) return;
    const schedule = m[2].trim();
    if (!isValidCron(schedule)) return;          // rejects prose comments
    const command = m[3].trim();
    const { role, worker } = roleFromCommand(command);
    entries.push({
      lineIndex,
      rawLine: line,
      schedule,
      command,
      role,
      worker,
      commented: Boolean(m[1]),
    });
  });
  return { lines, entries };
}

function assertLine(lines, lineIndex, expectedRawLine) {
  if (lineIndex < 0 || lineIndex >= lines.length || lines[lineIndex] !== expectedRawLine) {
    const err = new Error('file changed since read — reload and retry');
    err.code = 'STALE';
    throw err;
  }
}

function commentLine(text, lineIndex, expectedRawLine) {
  const lines = text.split('\n');
  assertLine(lines, lineIndex, expectedRawLine);
  if (!lines[lineIndex].startsWith('#')) lines[lineIndex] = `# ${lines[lineIndex]}`;
  return lines.join('\n');
}

function uncommentLine(text, lineIndex, expectedRawLine) {
  const lines = text.split('\n');
  assertLine(lines, lineIndex, expectedRawLine);
  lines[lineIndex] = lines[lineIndex].replace(/^#\s?/, '');
  return lines.join('\n');
}

function editSchedule(text, lineIndex, newSchedule, expectedRawLine) {
  if (!isValidCron(newSchedule)) {
    throw new Error(`invalid cron expression: ${newSchedule}`);
  }
  const lines = text.split('\n');
  assertLine(lines, lineIndex, expectedRawLine);
  const m = lines[lineIndex].match(CRON_RE);
  if (!m) throw new Error('target line is not a cron entry');
  const prefix = m[1] || '';
  const command = m[3];
  lines[lineIndex] = `${prefix}${newSchedule.trim()}  ${command}`;
  return lines.join('\n');
}

function removeLine(text, lineIndex, expectedRawLine) {
  const lines = text.split('\n');
  assertLine(lines, lineIndex, expectedRawLine);
  lines.splice(lineIndex, 1);
  return lines.join('\n');
}

// Append a new cron line (F28 — "add cron job" UI). No lineIndex/expectedRawLine
// stale check is needed since this only appends; the caller (cron.js
// crontabMutate) still runs it inside the per-slug crontab lock so a concurrent
// add/edit/remove on the same file can't interleave.
function addLine(text, schedule, command) {
  if (!isValidCron(schedule)) {
    throw new Error(`invalid cron expression: ${schedule}`);
  }
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('command is required');
  const lines = text.split('\n');
  // Insert before any trailing blank line(s) so the file keeps a clean single
  // trailing newline instead of accumulating blank lines at the end.
  let insertAt = lines.length;
  while (insertAt > 0 && lines[insertAt - 1] === '') insertAt--;
  lines.splice(insertAt, 0, `${schedule.trim()}  ${cmd}`);
  return lines.join('\n');
}

module.exports = { parseCrontab, isValidCron, extractRole, roleFromCommand, CRON_RE,
  commentLine, uncommentLine, editSchedule, removeLine, addLine };
