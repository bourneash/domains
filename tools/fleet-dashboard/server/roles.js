'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { siteDir } = require('./sites');
const gitMod = require('./git');
const deployhealth = require('./deployhealth');
const { parseCrontab, uncommentLine } = require('./cron/parse');
const { tailFile } = require('./cron/runinfo');
const execution = require('./execution');

function httpErr(status, msg) {
  const e = new Error(msg);
  e.httpStatus = status;
  return e;
}

const CRONTABS = ['ops/docker/crontab.docker', 'ops/docker/crontab'];
// Roles whose log files don't (always) start with the role name. Value is the
// list of accepted log prefixes — deployers are named `deployer-…` on most
// sites but `deploy-…` on americastrikes, so accept both.
const LOG_PREFIX = { deployer: ['deployer', 'deploy'] };
// Staleness thresholds (seconds) by inferred cadence — a cell goes amber past
// the threshold and red past 2×.
const THRESH = { frequent: 2 * 3600, daily: 26 * 3600, weekly: 8 * 86400 };
const FLEET_EXECUTIVE_ROLES = [
  {
    role: 'product-manager-fleet',
    scope: 'fleet',
    kind: 'executive',
    description: 'Product manager for Domain Fleet tooling and operator workflows',
  },
  {
    role: 'product-manager-sites',
    scope: 'fleet',
    kind: 'executive',
    description: 'Product manager for the managed websites portfolio',
  },
];

// Regex matching a role's `<prefix>-<date>…` log files. Accepts any of the
// role's configured prefixes (default: the role name itself).
function logRe(role) {
  const prefixes = LOG_PREFIX[role] || [role];
  const alt = prefixes.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp('^(?:' + alt + ')(?:-\\d)?');
}

function readFirst(cwd, rels) {
  for (const r of rels) {
    try {
      return fs.readFileSync(path.join(cwd, r), 'utf8');
    } catch {
      /* next */
    }
  }
  return '';
}

function readFirstFile(cwd, rels) {
  for (const r of rels) {
    try {
      const file = path.join(cwd, r);
      return { path: file, text: fs.readFileSync(file, 'utf8') };
    } catch {
      /* try the next format */
    }
  }
  return { path: path.join(cwd, rels[0]), text: '' };
}

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// Pull {role, schedule, worker} from each active (non-comment) role cron line.
// Role recognition is delegated to the shared parser in cron/parse.js so the
// roles matrix and the cron page can never disagree about what a line is.
// worker = invoked via run-worker.sh, which honours ops/.<role>-disabled, so
// it's safe to pause/resume by toggling that flag.
function parseRoles(crontab, { includeCommented = false } = {}) {
  return parseCrontab(crontab)
    .entries.filter(entry => includeCommented || !entry.commented)
    .map(entry => ({
      role: entry.role,
      schedule: entry.schedule,
      worker: entry.worker,
      commented: entry.commented,
      lineIndex: entry.lineIndex,
      rawLine: entry.rawLine,
    }))
    .filter(entry => entry.role);
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
    try {
      return fs.statSync(path.join(cwd, 'ops', '.locks', 'engineer-status.json')).mtimeMs;
    } catch {
      /* fall through */
    }
  }
  // principal-engineer only appends to ops/logs/principal-engineer-*.log when
  // it actually dispatches a worker — hours of legitimate quiet (no distinct
  // Slack error to react to) left the log-mtime fallback below reading as
  // "overdue". It writes a cheap pulse on every tick instead (see
  // run-principal-engineer.sh.tmpl); prefer that, same as engineer above.
  if (role === 'principal-engineer') {
    try {
      return fs.statSync(path.join(cwd, 'ops', '.locks', 'principal-engineer-status.json')).mtimeMs;
    } catch {
      /* fall through — sites not yet re-stamped with the pulse still judge by log mtime */
    }
  }
  const re = logRe(role);
  const dir = path.join(cwd, 'ops', 'logs');
  let newest = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!re.test(f)) continue;
      try {
        const mt = fs.statSync(path.join(dir, f)).mtimeMs;
        if (mt > newest) newest = mt;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no logs dir */
  }
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
async function matrix(root, slugs) {
  const now = Date.now();
  const freq = {};
  // Per-site git state (branch / ahead / dirty), computed once and reused for
  // the deployer cell. Cheap: reads the local origin/main tracking ref (no
  // fetch) — and it's the same clone the crons push from, so it's current.
  const gitBySlug = {};
  for (const g of await gitMod.summaries(root, slugs)) gitBySlug[g.slug] = g;
  const sites = slugs
    .map(slug => {
      const cwd = siteDir(root, slug);
      const parsed = parseRoles(readFirst(cwd, CRONTABS), { includeCommented: true });
      const cells = {};
      for (const { role, schedule, worker, commented } of parsed) {
        if (cells[role]) continue; // first schedule wins on dupes
        const enabled = !commented && !fs.existsSync(path.join(cwd, 'ops', `.${role}-disabled`));
        const last = enabled ? lastRun(cwd, role) : null;
        let { state, age } = commented
          ? { state: 'paused', age: null }
          : cellState(enabled, last, schedule, now);
        let deploy = null;
        // The deployer cell tracks DEPLOY HEALTH, not cron recency. Every site
        // ships via push-to-deploy (commit → `git push origin main` → CF rebuild),
        // so the local deployer cron is just a safety net — a site can be fully
        // live with a stale cron. Judge it by whether main is in sync with origin:
        // in sync → CF has it (fresh); commits ahead → unpushed, NOT live (red).
        // (last actual deploy time is kept in `age` for the tooltip.)
        if (role === 'deployer' && enabled) {
          const g = gitBySlug[slug] || {};
          const onMain = g.branch === 'main' || g.branch === 'master';
          const pushed = onMain && (g.ahead || 0) === 0;
          age = last ? (now - last) / 1000 : null;
          // Push state (cheap, every request) decides red/green first; the CF
          // build verdict (background poller) refines a pushed-but-not-yet-live
          // site — fresh push still building = amber, long-behind = red (failed).
          const bh = deployhealth.get(slug);
          let build = null;
          if (!g.isRepo) state = 'never';
          else if (g.ahead > 0)
            state = 'overdue'; // committed but unpushed → not deployed
          else if (!onMain)
            state = 'stale'; // feature branch checked out
          else if (bh && bh.ok && bh.live === false) {
            const pushedAgo = bh.headTime ? now / 1000 - bh.headTime : Infinity;
            state = pushedAgo <= 15 * 60 ? 'stale' : 'overdue'; // building vs failed/stuck
          } else state = 'fresh'; // in sync + (CF confirms live, or no CF data)
          if (bh)
            build = {
              ok: bh.ok,
              live: bh.live,
              version: bh.version,
              deployedAt: bh.deployedAt,
              error: bh.error,
            };
          deploy = {
            ahead: g.ahead || 0,
            dirty: g.dirty || 0,
            branch: g.branch || null,
            pushed,
            build,
          };
        }
        cells[role] = {
          scheduled: true,
          enabled,
          schedule,
          last,
          age: age ?? null,
          state,
          worker,
          commented,
          deploy,
        };
        freq[role] = (freq[role] || 0) + 1;
      }
      return { site: slug, cells };
    })
    .filter(s => Object.keys(s.cells).length);
  const roles = Object.keys(freq).sort((a, b) => freq[b] - freq[a] || a.localeCompare(b));
  // Keep the canonical discovery set alongside the sparse matrix. The matrix
  // intentionally omits sites with no scheduled roles, but agent pages need
  // the full set to distinguish "not enrolled" from "not discovered".
  return { roles, sites, allSites: [...slugs] };
}

// Tail of a role's newest log (for the cell drill-down).
function roleLog(root, slug, role, tail) {
  const cwd = siteDir(root, slug);
  const re = logRe(role);
  const dir = path.join(cwd, 'ops', 'logs');
  let best = null,
    bestMt = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!re.test(f)) continue;
      const mt = fs.statSync(path.join(dir, f)).mtimeMs;
      if (mt > bestMt) {
        bestMt = mt;
        best = f;
      }
    }
  } catch {
    /* none */
  }
  if (!best) return { file: null, log: '(no log files found for this role)' };
  const n = Math.max(1, Math.min(parseInt(tail, 10) || 200, 2000));
  // Bounded tail — never slurps the whole (potentially multi-MB) log into memory.
  return { file: best, mtime: bestMt, log: tailFile(path.join(dir, best), n) };
}

function promptHash(cwd, role) {
  try {
    return crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(cwd, 'ops', 'roles', `${role}.md`)))
      .digest('hex')
      .slice(0, 12);
  } catch {
    return null;
  }
}

function recentRunStats(cwd, role, since) {
  const dir = path.join(cwd, 'ops', 'logs');
  const re = logRe(role);
  const out = { observed: 0, succeeded: 0, failed: 0, unknown: 0, failures: [] };
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const file of files) {
    if (!re.test(file)) continue;
    const full = path.join(dir, file);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.mtimeMs < since) continue;
    out.observed++;
    let text = '';
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      out.unknown++;
      continue;
    }
    const exit = text.match(/exit=(\d+)/g)?.at(-1);
    if (exit && exit !== 'exit=0') {
      out.failed++;
      out.failures.push({
        file,
        mtime: stat.mtimeMs,
        summary: text.trim().split('\n').slice(-3).join(' ').slice(0, 300),
      });
    } else if (exit === 'exit=0' || /finished successfully|run complete|complete\./i.test(text))
      out.succeeded++;
    else if (/\b(?:FAIL|FAILED|ERROR|timed out)\b/i.test(text)) {
      out.failed++;
      out.failures.push({
        file,
        mtime: stat.mtimeMs,
        summary: text.trim().split('\n').slice(-3).join(' ').slice(0, 300),
      });
    } else out.unknown++;
  }
  out.failures.sort((a, b) => b.mtime - a.mtime);
  return out;
}

async function health(root, role, slugs, usage = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(role || ''))) throw httpErr(400, 'invalid role');
  const data = await matrix(root, slugs);
  const cutoff = Date.now() - 7 * 86400 * 1000;
  const spend = new Map(
    (usage.by_site_role || []).filter(row => row.role === role).map(row => [row.site, row])
  );
  const rows = [];
  const promptCounts = {};
  for (const site of data.sites) {
    const cell = site.cells[role];
    if (!cell) continue;
    const stats = recentRunStats(siteDir(root, site.site), role, cutoff);
    const history = execution.executionHistory(root, site.site, role, cell.schedule, {
      from: new Date(cutoff),
      enabled: cell.enabled,
    });
    const prompt = promptHash(siteDir(root, site.site), role);
    const runner = cell.worker ? 'run-worker.sh' : 'dedicated-script';
    const key = `${runner}:${prompt || 'missing'}`;
    promptCounts[key] = (promptCounts[key] || 0) + 1;
    rows.push({
      site: site.site,
      state: cell.state,
      enabled: cell.enabled,
      worker: cell.worker,
      schedule: cell.schedule,
      last: cell.last,
      observed: stats.observed,
      succeeded: stats.succeeded,
      failed: stats.failed,
      unknown: stats.unknown,
      failures: stats.failures.slice(0, 3),
      costUsd: spend.get(site.site)?.total_cost_usd || 0,
      calls: spend.get(site.site)?.calls || 0,
      promptHash: prompt,
      runner,
      driftKey: key,
      expected: history.expected,
      missed: history.missed,
      unknown: history.unknown,
      execution: history,
    });
  }
  const baseline = Object.entries(promptCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  rows.forEach(row => {
    row.drift = baseline !== null && row.driftKey !== baseline;
  });
  const summary = {
    enrolled: rows.length,
    expected: rows.reduce((n, row) => n + row.expected, 0),
    paused: rows.filter(row => !row.enabled).length,
    fresh: rows.filter(row => row.state === 'fresh').length,
    stale: rows.filter(row => row.state === 'stale').length,
    overdue: rows.filter(row => row.state === 'overdue').length,
    observed: rows.reduce((n, row) => n + row.observed, 0),
    succeeded: rows.reduce((n, row) => n + row.succeeded, 0),
    failed: rows.reduce((n, row) => n + row.failed, 0),
    missed: rows.reduce((n, row) => n + row.missed, 0),
    costUsd: rows.reduce((n, row) => n + row.costUsd, 0),
    drifted: rows.filter(row => row.drift).length,
  };
  return { role, windowDays: 7, summary, rows };
}

// The parsed crontab entry for a role on a site (or null), for validation.
function roleEntry(root, slug, role) {
  const r = String(role || '').toLowerCase();
  return parseRoles(readFirst(siteDir(root, slug), CRONTABS)).find(p => p.role === r) || null;
}

// Pause/resume a role by toggling ops/.<role>-disabled — the same flag run-worker.sh
// checks (and that matrix() reads). Only allowed for scheduled run-worker.sh roles,
// where the flag is actually honoured.
function setEnabled(root, slug, role, enabled) {
  const r = String(role || '').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(r)) throw httpErr(400, 'invalid role');
  const cwd = siteDir(root, slug);
  const crontab = readFirstFile(cwd, CRONTABS);
  const entry = parseRoles(crontab.text, { includeCommented: true }).find(p => p.role === r);
  if (!entry) throw httpErr(404, 'role is not scheduled on this site');
  if (!entry.worker)
    throw httpErr(400, 'role is not pause/resume-controllable (not a run-worker.sh role)');
  const flag = path.join(cwd, 'ops', `.${r}-disabled`);
  if (enabled) {
    if (entry.commented)
      atomicWrite(crontab.path, uncommentLine(crontab.text, entry.lineIndex, entry.rawLine));
    try {
      fs.unlinkSync(flag);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
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
    for (const { role } of parseRoles(readFirst(siteDir(root, slug), CRONTABS), {
      includeCommented: true,
    })) {
      if (!seen.has(role)) {
        seen.add(role);
        freq[role] = (freq[role] || 0) + 1;
      }
    }
  }
  const scheduled = Object.keys(freq)
    .filter(r => freq[r] >= 2)
    .sort(
      (a, b) =>
        (a === 'engineer' ? -1 : b === 'engineer' ? 1 : 0) ||
        freq[b] - freq[a] ||
        a.localeCompare(b)
    )
    .map(r => ({ role: r, sites: freq[r], scope: 'sites', kind: 'scheduled' }));
  return [...FLEET_EXECUTIVE_ROLES, ...scheduled];
}

module.exports = {
  matrix,
  health,
  roleLog,
  setEnabled,
  agents,
  roleEntry,
  parseRoles,
  cadenceClass,
  FLEET_EXECUTIVE_ROLES,
};
