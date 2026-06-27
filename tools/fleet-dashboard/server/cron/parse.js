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

function extractRole(command) {
  const m = command.match(/run-worker\.sh\s+([A-Za-z0-9._-]+)/);
  return m ? m[1] : null;
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
    entries.push({
      lineIndex,
      rawLine: line,
      schedule,
      command,
      role: extractRole(command),
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

module.exports = { parseCrontab, isValidCron, extractRole, CRON_RE,
  commentLine, uncommentLine, editSchedule, removeLine };
