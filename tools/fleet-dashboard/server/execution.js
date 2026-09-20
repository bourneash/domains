'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { siteDir } = require('./sites');
const { readLastRuns } = require('./cron/runinfo');

const DAY = 86400000;
const MINUTE = 60000;

function values(field, min, max) {
  const out = new Set();
  for (const part of String(field).split(',')) {
    const [base, stepText] = part.split('/');
    const step = Math.max(1, parseInt(stepText || '1', 10) || 1);
    let start = base === '*' ? min : parseInt(base.split('-')[0], 10);
    let end = base === '*' ? max : parseInt(base.split('-').at(-1), 10);
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    start = Math.max(min, start);
    end = Math.min(max, end);
    for (let n = start; n <= end; n += step) out.add(n);
  }
  return out;
}

function cronMatches(date, schedule) {
  const fields = String(schedule || '')
    .trim()
    .split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dom, month, dow] = fields;
  if (!values(minute, 0, 59).has(date.getMinutes())) return false;
  if (!values(hour, 0, 23).has(date.getHours())) return false;
  if (!values(month, 1, 12).has(date.getMonth() + 1)) return false;
  const dayOfMonth = values(dom, 1, 31).has(date.getDate());
  const dayOfWeek = values(dow, 0, 6).has(date.getDay());
  const domRestricted = dom !== '*';
  const dowRestricted = dow !== '*';
  if (domRestricted && dowRestricted) return dayOfMonth || dayOfWeek;
  return dayOfMonth && dayOfWeek;
}

function expectedRuns(schedule, from, to) {
  const out = [];
  const start = new Date(Math.ceil(from.getTime() / MINUTE) * MINUTE);
  for (let t = start.getTime(); t <= to.getTime(); t += MINUTE) {
    const date = new Date(t);
    if (cronMatches(date, schedule)) out.push(t);
  }
  return out;
}

function rolePrefixes(role) {
  return role === 'deployer' ? ['deployer', 'deploy'] : [role];
}

function isRunLog(role, file) {
  return rolePrefixes(role).some(prefix =>
    new RegExp(`^${prefix.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}-\\d{4}`).test(file)
  );
}

function timestamp(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : null;
}

function filenameTimestamp(file) {
  const match = file.match(
    /(?:^|-)(20\d{2}-?\d{2}-?\d{2})(?:[T-](\d{2})[:\-]?(\d{2})(?::?(\d{2}))?)?/
  );
  if (!match) return null;
  const date = match[1].replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  const time = `${match[2] || '00'}:${match[3] || '00'}:${match[4] || '00'}`;
  const t = Date.parse(`${date}T${time}`);
  return Number.isFinite(t) ? t : null;
}

function recordsFromText(text, fallback, file) {
  const starts = [...String(text || '').matchAll(/started at ([^\s=]+(?:[+-]\d\d:\d\d|Z))/g)];
  const finishes = [
    ...String(text || '').matchAll(/finished at ([^\s=]+(?:[+-]\d\d:\d\d|Z)) \(exit=(\d+)\)/g),
  ];
  if (!starts.length && !finishes.length && fallback)
    return [{ at: fallback, status: 'unknown', file }];
  return starts
    .map((match, index) => {
      const at = timestamp(match[1]) || fallback;
      const finish = finishes[index];
      return { at, status: finish ? (finish[2] === '0' ? 'ok' : 'failed') : 'unknown', file };
    })
    .filter(row => row.at);
}

function collectObservedRuns(root, slug, role, from, to) {
  const cwd = siteDir(root, slug);
  const dir = path.join(cwd, 'ops', 'logs');
  const records = [];
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    files = [];
  }
  for (const file of files) {
    if (!isRunLog(role, file)) continue;
    const full = path.join(dir, file);
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    records.push(...recordsFromText(text, filenameTimestamp(file), file));
  }
  const lastRuns = readLastRuns(path.join(cwd, 'ops'));
  const latest = lastRuns[role];
  const latestAt = timestamp(latest?.at);
  if (latestAt)
    records.push({
      at: latestAt,
      status: latest.exit === 0 ? 'ok' : 'failed',
      file: latest.log || 'last-run.json',
    });
  return records
    .filter(row => row.at >= from.getTime() && row.at <= to.getTime())
    .sort((a, b) => a.at - b.at)
    .filter(
      (row, index, all) =>
        index === 0 || row.at !== all[index - 1].at || row.status !== all[index - 1].status
    );
}

function executionHistory(root, slug, role, schedule, { from, to, enabled = true } = {}) {
  const end = to || new Date();
  const start = from || new Date(end.getTime() - 7 * DAY);
  const observed = collectObservedRuns(root, slug, role, start, end);
  const expected = enabled ? expectedRuns(schedule, start, end) : [];
  const slots = [];
  const used = new Set();
  const tolerance = Math.max(
    5 * MINUTE,
    expected.length > 1 ? Math.min(30 * MINUTE, (expected[1] - expected[0]) * 0.45) : 15 * MINUTE
  );
  for (const at of expected) {
    let best = -1;
    let distance = Infinity;
    observed.forEach((row, index) => {
      if (used.has(index)) return;
      const d = Math.abs(row.at - at);
      if (d <= tolerance && d < distance) {
        best = index;
        distance = d;
      }
    });
    if (best === -1) slots.push({ at, status: 'missed' });
    else {
      used.add(best);
      slots.push({
        at,
        status: observed[best].status,
        observedAt: observed[best].at,
        file: observed[best].file,
      });
    }
  }
  const extras = observed
    .filter((_row, index) => !used.has(index))
    .map(row => ({ ...row, extra: true }));
  const counts = slots.reduce((out, row) => {
    out[row.status] = (out[row.status] || 0) + 1;
    return out;
  }, {});
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    expected: expected.length,
    observed: observed.length,
    succeeded: counts.ok || 0,
    failed: counts.failed || 0,
    missed: counts.missed || 0,
    unknown: counts.unknown || 0,
    slots: slots.slice(-100),
    extras: extras.slice(-20),
  };
}

module.exports = { cronMatches, expectedRuns, collectObservedRuns, executionHistory };
