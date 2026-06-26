'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { siteDir } = require('./sites');

function httpErr(status, msg) { const e = new Error(msg); e.httpStatus = status; return e; }

const CRONTABS = ['ops/docker/crontab.docker', 'ops/docker/crontab'];
// Roles whose log files don't start with the role name.
const LOG_PREFIX = { deployer: 'deploy' };
// Staleness thresholds (seconds) by inferred cadence — a cell goes amber past
// the threshold and red past 2×.
const THRESH = { frequent: 2 * 3600, daily: 26 * 3600, weekly: 8 * 86400 };

function readFirst(cwd, rels) {
  for (const r of rels) {
    try { return fs.readFileSync(path.join(cwd, r), 'utf8'); } catch { /* next */ }
  }
  return '';
}

// Pull {role, schedule} from each active (non-comment) role cron line.
function parseRoles(crontab) {
  const out = [];
  for (const raw of crontab.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^((?:\S+\s+){5})(.*)$/);
    if (!m) continue;
    const schedule = m[1].trim();
    const cmd = m[2];
    let role = null, worker = false, rm;
    if ((rm = cmd.match(/run-worker\.sh\s+([a-z0-9-]+)/i))) { role = rm[1]; worker = true; }
    else if ((rm = cmd.match(/run-([a-z0-9-]+)\.sh/i)) && !['worker', 'role'].includes(rm[1].toLowerCase())) role = rm[1];
    // worker = invoked via run-worker.sh, which honours ops/.<role>-disabled, so
    // it's safe to pause/resume by toggling that flag.
    if (role) out.push({ role: role.toLowerCase(), schedule, worker });
  }
  return out;
}

// Coarse cadence from the cron schedule: sub-daily / daily / weekly.
function cadenceClass(expr) {
  const f = expr.trim().split(/\s+/);
  if (f.length < 5) return 'daily';
  const [min, hr, , , dow] = f;
  if (dow !== '*' && !dow.includes('*')) return 'weekly';
  const frequent = /[*/]/.test(min) || min.includes(',') || /[*/-]/.test(hr) || hr.includes(',');
  return frequent ? 'frequent' : 'daily';
}

// Newest run signal for a role: the engineer pulse for engineers, else the
// newest ops/logs/<prefix>-<date>… file (the `-\d` boundary keeps news-writer
// from matching news-writer-local).
function lastRun(cwd, role) {
  if (role === 'engineer') {
    try { return fs.statSync(path.join(cwd, 'ops', '.locks', 'engineer-status.json')).mtimeMs; } catch { /* fall through */ }
  }
  const prefix = LOG_PREFIX[role] || role;
  const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-\\d');
  const dir = path.join(cwd, 'ops', 'logs');
  let newest = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!re.test(f)) continue;
      try { const mt = fs.statSync(path.join(dir, f)).mtimeMs; if (mt > newest) newest = mt; } catch { /* skip */ }
    }
  } catch { /* no logs dir */ }
  return newest || null;
}

function cellState(enabled, last, schedule, now) {
  if (!enabled) return { state: 'paused' };
  if (!last) return { state: 'never' };
  const age = (now - last) / 1000;
  const thr = THRESH[cadenceClass(schedule)];
  const state = age <= thr ? 'fresh' : age <= 2 * thr ? 'stale' : 'overdue';
  return { state, age };
}

// Build the site × role matrix from what's on disk: scheduled (crontab),
// enabled (no ops/.<role>-disabled flag), and last-run (logs / pulse).
function matrix(root, slugs) {
  const now = Date.now();
  const freq = {};
  const sites = slugs.map((slug) => {
    const cwd = siteDir(root, slug);
    const parsed = parseRoles(readFirst(cwd, CRONTABS));
    const cells = {};
    for (const { role, schedule, worker } of parsed) {
      if (cells[role]) continue;                       // first schedule wins on dupes
      const enabled = !fs.existsSync(path.join(cwd, 'ops', `.${role}-disabled`));
      const last = lastRun(cwd, role);
      const { state, age } = cellState(enabled, last, schedule, now);
      cells[role] = { scheduled: true, enabled, schedule, last, age: age ?? null, state, worker };
      freq[role] = (freq[role] || 0) + 1;
    }
    return { site: slug, cells };
  }).filter((s) => Object.keys(s.cells).length);
  const roles = Object.keys(freq).sort((a, b) => freq[b] - freq[a] || a.localeCompare(b));
  return { roles, sites };
}

// Tail of a role's newest log (for the cell drill-down).
function roleLog(root, slug, role, tail) {
  const cwd = siteDir(root, slug);
  const prefix = LOG_PREFIX[role] || role;
  const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-\\d');
  const dir = path.join(cwd, 'ops', 'logs');
  let best = null, bestMt = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!re.test(f)) continue;
      const mt = fs.statSync(path.join(dir, f)).mtimeMs;
      if (mt > bestMt) { bestMt = mt; best = f; }
    }
  } catch { /* none */ }
  if (!best) return { file: null, log: '(no log files found for this role)' };
  const n = Math.max(1, Math.min(parseInt(tail, 10) || 200, 2000));
  const lines = fs.readFileSync(path.join(dir, best), 'utf8').split('\n');
  return { file: best, mtime: bestMt, log: lines.slice(-n).join('\n') };
}

// The parsed crontab entry for a role on a site (or null), for validation.
function roleEntry(root, slug, role) {
  const r = String(role || '').toLowerCase();
  return parseRoles(readFirst(siteDir(root, slug), CRONTABS)).find((p) => p.role === r) || null;
}

// Pause/resume a role by toggling ops/.<role>-disabled — the same flag run-worker.sh
// checks (and that matrix() reads). Only allowed for scheduled run-worker.sh roles,
// where the flag is actually honoured.
function setEnabled(root, slug, role, enabled) {
  const r = String(role || '').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(r)) throw httpErr(400, 'invalid role');
  const cwd = siteDir(root, slug);
  const entry = parseRoles(readFirst(cwd, CRONTABS)).find((p) => p.role === r);
  if (!entry) throw httpErr(404, 'role is not scheduled on this site');
  if (!entry.worker) throw httpErr(400, 'role is not pause/resume-controllable (not a run-worker.sh role)');
  const flag = path.join(cwd, 'ops', `.${r}-disabled`);
  if (enabled) {
    try { fs.unlinkSync(flag); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  } else if (!fs.existsSync(flag)) {
    // These flags are tracked, conventionally-empty files — match `touch` so
    // pausing doesn't create spurious content diffs.
    fs.writeFileSync(flag, '');
  }
  return { ok: true, role: r, enabled };
}

// Lightweight agent list for the nav dropdown: roles scheduled on ≥2 sites,
// engineer first, then by frequency. Only parses crontabs (no log scans), so
// it's cheap to call on every nav render. New roles appear automatically.
function agents(root, slugs) {
  const freq = {};
  for (const slug of slugs) {
    const seen = new Set();
    for (const { role } of parseRoles(readFirst(siteDir(root, slug), CRONTABS))) {
      if (!seen.has(role)) { seen.add(role); freq[role] = (freq[role] || 0) + 1; }
    }
  }
  return Object.keys(freq)
    .filter((r) => freq[r] >= 2)
    .sort((a, b) => (a === 'engineer' ? -1 : b === 'engineer' ? 1 : 0) || freq[b] - freq[a] || a.localeCompare(b))
    .map((r) => ({ role: r, sites: freq[r] }));
}

module.exports = { matrix, roleLog, setEnabled, agents, roleEntry, parseRoles, cadenceClass };
