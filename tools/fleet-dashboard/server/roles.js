'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { siteDir } = require('./sites');
const gitMod = require('./git');
const deployhealth = require('./deployhealth');
const { parseCrontab, uncommentLine } = require('./cron/parse');
const { readLastRuns, tailFile } = require('./cron/runinfo');
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
// Match the browser's matrix cache window; role and automation mutations
// invalidate this snapshot immediately.
const MATRIX_CACHE_TTL_MS = 30000;
const LOG_FILENAME_GRACE_MS = 2 * 86400000;
// Agent health rereads thousands of append-written logs per report. Reuse
// small unchanged contents across reports, while checking file metadata first.
const LOG_CONTENT_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const LOG_CONTENT_CACHE_MAX_ENTRY_BYTES = 256 * 1024;
const LOG_CONTENT_CACHE_MAX_ENTRIES = 20000;
const matrixCache = new Map();
const matrixPending = new Map();
const vitalsCache = new Map();
const vitalsPending = new Map();
const matrixEpoch = new Map();
const logContentCache = new Map();
let logContentCacheBytes = 0;

function removeCachedLog(key) {
  const cached = logContentCache.get(key);
  if (!cached) return;
  logContentCache.delete(key);
  logContentCacheBytes -= cached.bytes;
}

function invalidateMatrix(root) {
  const prefix = `${root}\0`;
  matrixEpoch.set(root, (matrixEpoch.get(root) || 0) + 1);
  for (const key of matrixCache.keys()) {
    if (key.startsWith(prefix)) matrixCache.delete(key);
  }
  for (const key of matrixPending.keys()) {
    if (key.startsWith(prefix)) matrixPending.delete(key);
  }
  for (const key of vitalsCache.keys()) {
    if (key.startsWith(prefix)) vitalsCache.delete(key);
  }
  for (const key of vitalsPending.keys()) {
    if (key.startsWith(prefix)) vitalsPending.delete(key);
  }
}
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
  {
    role: 'delivery-lead',
    scope: 'fleet',
    kind: 'executive',
    description:
      'Head of Portfolio Delivery responsible for turning approved intent into shipped work',
  },
  {
    role: 'design-director',
    scope: 'fleet',
    kind: 'executive',
    description: 'Design and conversion quality owner for the website portfolio',
  },
  {
    role: 'growth-director',
    scope: 'fleet',
    kind: 'executive',
    description: 'SEO and measurable growth owner for the website portfolio',
  },
  {
    role: 'revenue-ops',
    scope: 'fleet',
    kind: 'executive',
    description: 'Affiliate, attribution, and revenue operations owner',
  },
  {
    role: 'site-factory',
    scope: 'fleet',
    kind: 'executive',
    description: 'Repeatable new-site validation and launch readiness owner',
  },
];

// Keep exact cron role names for execution, but expose the shared editorial
// runner family as /agents/update in the dashboard.
const ROLE_FAMILIES = {
  update: {
    label: 'Editorial updates',
    description: 'Content freshness, reporting, and source-backed publishing across the fleet',
    roles: [
      'update',
      'content-writer',
      'news-writer',
      'news-writer-local',
      'breaking-news',
      'weekly-editorial',
    ],
    primaryRoles: ['update', 'content-writer', 'news-writer'],
    secondaryRoles: ['news-writer-local', 'breaking-news', 'weekly-editorial'],
  },
};

function roleFamily(role) {
  const r = String(role || '').toLowerCase();
  return Object.entries(ROLE_FAMILIES).find(([, family]) => family.roles.includes(r))?.[0] || null;
}

function familyForRole(role) {
  const key = roleFamily(role);
  return key ? { key, ...ROLE_FAMILIES[key] } : null;
}

// Regex matching a role's `<prefix>-<date>…` log files. Accepts any of the
// role's configured prefixes (default: the role name itself).
function logRe(role) {
  const prefixes = LOG_PREFIX[role] || [role];
  const alt = prefixes.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp('^(?:' + alt + ')(?:-\\d)?(?=-20\\d{2}|$)');
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

// Enrollment-only lookups power Agent pages that need role controls but not
// the full site × role health matrix. Avoid scanning unrelated role logs,
// editorial telemetry, and deployer Git state for these controls.
function enrollment(root, slugs, role) {
  const target = String(role || '');
  const sites = [];
  for (const slug of slugs) {
    const cwd = siteDir(root, slug);
    const entry = parseRoles(readFirst(cwd, CRONTABS), { includeCommented: true }).find(
      item => item.role === target
    );
    if (!entry) continue;
    sites.push({
      site: slug,
      cells: {
        [target]: {
          scheduled: true,
          enabled: !entry.commented && !fs.existsSync(path.join(cwd, 'ops', `.${target}-disabled`)),
          worker: entry.worker,
        },
      },
    });
  }
  return { sites, allSites: [...slugs] };
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

function createLogIndex(cwd) {
  const dir = path.join(cwd, 'ops', 'logs');
  let names;
  const stats = new Map();
  const contents = new Map();
  function listNames() {
    if (names) return names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    return names;
  }
  function stat(name) {
    if (stats.has(name)) return stats.get(name);
    let entry = null;
    try {
      const value = fs.statSync(path.join(dir, name));
      if (value.isFile())
        entry = { name, mtime: value.mtimeMs, ctime: value.ctimeMs, size: value.size };
    } catch {
      /* log may have rotated since the directory was listed */
    }
    stats.set(name, entry);
    return entry;
  }
  return {
    latestFromRecord(role, record) {
      if (!record || typeof record.log !== 'string') return null;
      const recordedName = path.basename(record.log);
      const matching = listNames().filter(name => logRe(role).test(name));
      if (!matching.includes(recordedName)) return null;
      const recordedAt = execution.filenameTimestamp(recordedName);
      if (recordedAt === null) return null;
      // last-run.json is written by the runner after each execution. When it
      // points at the newest dated log, stat only that log; otherwise retain
      // the full mtime scan (older records are common on partially migrated sites).
      const newestAt = Math.max(
        ...matching.map(name => execution.filenameTimestamp(name) ?? -Infinity)
      );
      if (recordedAt < newestAt) return null;
      return stat(recordedName);
    },
    matching(predicate, sinceMs = null) {
      return listNames()
        .filter(name => predicate(name))
        .filter(name => {
          if (sinceMs === null) return true;
          // Run-log names encode their start date; keep a two-day margin for
          // daily logs and timezone skew before spending an fs.stat call.
          const namedAt = execution.filenameTimestamp(name);
          return namedAt === null || namedAt + LOG_FILENAME_GRACE_MS >= sinceMs;
        })
        .map(stat)
        .filter(entry => entry && (sinceMs === null || entry.mtime >= sinceMs))
        .sort((a, b) => b.mtime - a.mtime);
    },
    read(name) {
      if (contents.has(name)) return contents.get(name);
      const filename = path.join(dir, name);
      const metadata = stat(name);
      const cached = logContentCache.get(filename);
      if (
        cached &&
        metadata &&
        cached.mtime === metadata.mtime &&
        cached.ctime === metadata.ctime &&
        cached.size === metadata.size
      ) {
        logContentCache.delete(filename);
        logContentCache.set(filename, cached);
        contents.set(name, cached.text);
        return cached.text;
      }
      if (cached) removeCachedLog(filename);
      let text = null;
      try {
        text = fs.readFileSync(filename, 'utf8');
      } catch {
        /* log may have rotated since it was statted */
      }
      if (text !== null && metadata) {
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes <= LOG_CONTENT_CACHE_MAX_ENTRY_BYTES) {
          logContentCache.set(filename, {
            mtime: metadata.mtime,
            ctime: metadata.ctime,
            size: metadata.size,
            text,
            bytes,
          });
          logContentCacheBytes += bytes;
          while (
            logContentCache.size > LOG_CONTENT_CACHE_MAX_ENTRIES ||
            logContentCacheBytes > LOG_CONTENT_CACHE_MAX_BYTES
          )
            removeCachedLog(logContentCache.keys().next().value);
        }
      }
      contents.set(name, text);
      return text;
    },
  };
}

// Newest run signal for a role: the engineer pulse for engineers, else the
// newest ops/logs/<prefix>-<date>… file (the `-\d` boundary keeps news-writer
// from matching news-writer-local).
function lastRun(cwd, role, logIndex = createLogIndex(cwd), lastRuns = null) {
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
  const latest = logIndex.latestFromRecord(
    role,
    (lastRuns || readLastRuns(path.join(cwd, 'ops')))[role]
  );
  return (latest || logIndex.matching(name => logRe(role).test(name))[0])?.mtime || null;
}

// Publishing evidence is deliberately derived from the site's existing logs
// and deploy markers. It gives operators a useful editorial signal without
// inventing a second state store that could drift from the site runner.
function editorialTelemetry(cwd, role, logIndex = createLogIndex(cwd), schedule = null) {
  if (!familyForRole(role)) return null;
  const log = logRe(role);
  let latest = null;
  let publication = null;
  let deploy = null;
  let entries = [];
  try {
    entries = logIndex.matching(name => log.test(name) || /^deployer-/.test(name));
    const roleEntries = entries.filter(entry => log.test(entry.name));
    for (const entry of roleEntries) {
      const text = logIndex.read(entry.name);
      if (text === null) continue;
      if (!latest) latest = { file: entry.name, mtime: entry.mtime, text };
      const matches = [
        ...text.matchAll(/Published\s+[`']?\/(?:news|articles)\/([a-z0-9-]+)/gi),
        ...text.matchAll(/claude wrote:\s*article=([a-z0-9-]+)/gi),
      ];
      if (matches.length) {
        publication = { slug: matches.at(-1)[1], at: entry.mtime, file: entry.name };
        break;
      }
    }
  } catch {
    /* site may not have logs yet */
  }
  const newestDeploy = entries.find(entry => /^deployer-/.test(entry.name));
  if (newestDeploy) {
    const text = logIndex.read(newestDeploy.name);
    if (text !== null) {
      deploy = {
        at: newestDeploy.mtime,
        file: newestDeploy.name,
        state: /deploy SUCCESS/.test(text)
          ? 'success'
          : /deploy (?:FAIL|ERROR)|exit=[1-9]/i.test(text)
            ? 'failed'
            : 'unknown',
      };
    }
  }
  const deployNeeded = fs.existsSync(path.join(cwd, '.deploy-needed'));
  const deployFailed = fs.existsSync(path.join(cwd, '.deploy-needed.failed'));
  const latestText = latest?.text || '';
  const source = /cache:\s*OK|source[s]?\s+(?:ok|ready|fresh)/i.test(latestText)
    ? { state: 'ok', detail: 'source/cache reported healthy' }
    : /cache|source/i.test(latestText) && /(?:MISS|STALE|FAIL|ERROR|UNAVAILABLE)/i.test(latestText)
      ? { state: 'degraded', detail: 'source/cache reported an issue' }
      : { state: 'unknown', detail: 'no source/cache verdict in latest log' };
  const cadence = cadenceClass(
    schedule ||
      parseRoles(readFirst(cwd, CRONTABS), { includeCommented: true }).find(
        entry => entry.role === role
      )?.schedule ||
      '* * * * *'
  );
  const publicationAge = publication ? (Date.now() - publication.at) / 1000 : Infinity;
  const publicationLimit = THRESH[cadence] || THRESH.daily;
  const alerts = [];
  if (outcomeIsFailure(latestText))
    alerts.push({ type: 'run-failed', message: 'latest editorial run failed' });
  if (source.state === 'degraded') alerts.push({ type: 'source-degraded', message: source.detail });
  if (deployNeeded || deployFailed)
    alerts.push({
      type: 'deploy-pending',
      message: deployFailed ? 'deployment is parked after failure' : 'deployment is waiting',
    });
  if (publicationAge > publicationLimit)
    alerts.push({
      type: 'publication-overdue',
      message: `no publication within the ${cadence} cadence window`,
    });
  return {
    attemptedAt: latest?.mtime || null,
    attemptedFile: latest?.file || null,
    outcome: latest
      ? /exit=0/.test(latestText)
        ? 'success'
        : /exit=[1-9]/.test(latestText)
          ? 'failed'
          : 'unknown'
      : 'never',
    noOp: /NO-OP|no content change|nothing published|near-duplicate|no-op/i.test(latestText),
    cadence,
    source,
    alerts,
    publication,
    deploy: deploy
      ? { ...deploy, pending: deployNeeded, failedMarker: deployFailed }
      : { pending: deployNeeded, failedMarker: deployFailed },
  };
}

function outcomeIsFailure(text) {
  return /exit=[1-9]|\b(?:FAIL|FAILED|ERROR|timed out)\b/i.test(text || '');
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
async function matrix(root, slugs, onlyRoles = null, { includeEditorial = true } = {}) {
  const roleFilter = onlyRoles ? [...new Set(onlyRoles.map(String))].sort() : null;
  const key = `${root}\0${slugs.join('\0')}\0${roleFilter ? roleFilter.join('\0') : '*'}\0${includeEditorial ? 'editorial' : 'status'}`;
  const cached = matrixCache.get(key);
  if (cached && Date.now() - cached.at < MATRIX_CACHE_TTL_MS) return cached.data;
  const pending = matrixPending.get(key);
  if (pending) return pending;

  const epoch = matrixEpoch.get(root) || 0;
  const refresh = buildMatrix(root, slugs, roleFilter, includeEditorial)
    .then(data => {
      if ((matrixEpoch.get(root) || 0) === epoch) matrixCache.set(key, { at: Date.now(), data });
      return data;
    })
    .finally(() => {
      if (matrixPending.get(key) === refresh) matrixPending.delete(key);
    });
  matrixPending.set(key, refresh);
  return refresh;
}

function summarizeMatrix(data) {
  const summary = {
    siteCount: data.sites.length,
    roleCount: data.roles.length,
    total: 0,
    fresh: 0,
    stale: 0,
    overdue: 0,
    paused: 0,
  };
  for (const site of data.sites) {
    for (const cell of Object.values(site.cells)) {
      if (!cell?.scheduled) continue;
      summary.total++;
      if (cell.enabled === false) summary.paused++;
      else if (cell.state === 'fresh') summary.fresh++;
      else if (cell.state === 'stale') summary.stale++;
      else if (cell.state === 'overdue') summary.overdue++;
    }
  }
  return summary;
}

async function vitals(root, slugs) {
  const key = `${root}\0${slugs.join('\0')}`;
  const fullKeys = [
    `${root}\0${slugs.join('\0')}\0*\0status`,
    `${root}\0${slugs.join('\0')}\0*\0editorial`,
  ];
  for (const fullKey of fullKeys) {
    const full = matrixCache.get(fullKey);
    if (full && Date.now() - full.at < MATRIX_CACHE_TTL_MS) return summarizeMatrix(full.data);
  }
  for (const fullKey of fullKeys) {
    const pendingMatrix = matrixPending.get(fullKey);
    if (pendingMatrix) return pendingMatrix.then(summarizeMatrix);
  }
  const cached = vitalsCache.get(key);
  if (cached && Date.now() - cached.at < MATRIX_CACHE_TTL_MS) return cached.data;
  const existing = vitalsPending.get(key);
  if (existing) return existing;
  const epoch = matrixEpoch.get(root) || 0;
  const refresh = buildMatrix(root, slugs, null, false, true)
    .then(summary => {
      if ((matrixEpoch.get(root) || 0) === epoch)
        vitalsCache.set(key, { at: Date.now(), data: summary });
      return summary;
    })
    .finally(() => {
      if (vitalsPending.get(key) === refresh) vitalsPending.delete(key);
    });
  vitalsPending.set(key, refresh);
  return refresh;
}

async function buildMatrix(
  root,
  slugs,
  onlyRoles = null,
  includeEditorial = true,
  summaryOnly = false
) {
  const now = Date.now();
  const freq = {};
  const summary = {
    siteCount: 0,
    roleCount: 0,
    total: 0,
    fresh: 0,
    stale: 0,
    overdue: 0,
    paused: 0,
  };
  const parsedBySlug = new Map();
  const deployerSlugs = [];
  const selected = onlyRoles ? new Set(onlyRoles) : null;
  for (const slug of slugs) {
    const cwd = siteDir(root, slug);
    const parsed = parseRoles(readFirst(cwd, CRONTABS), { includeCommented: true });
    parsedBySlug.set(slug, parsed);
    const deployer = parsed.find(entry => entry.role === 'deployer');
    if (
      deployer &&
      (!selected || selected.has('deployer')) &&
      !deployer.commented &&
      !fs.existsSync(path.join(cwd, 'ops', '.deployer-disabled'))
    ) {
      deployerSlugs.push(slug);
    }
  }
  // The role matrix only needs three git fields for active deployer roles.
  // Avoid the full Git-page summary (commit metadata, remotes, and stash scans)
  // and avoid touching repositories with no active deployer.
  const gitBySlug = {};
  const gitRows = await Promise.all(deployerSlugs.map(slug => gitMod.roleStatus(root, slug)));
  for (const g of gitRows) gitBySlug[g.slug] = g;
  const sites = slugs
    .map(slug => {
      const cwd = siteDir(root, slug);
      const parsed = parsedBySlug.get(slug) || [];
      const logIndex = createLogIndex(cwd);
      const lastRuns = readLastRuns(path.join(cwd, 'ops'));
      const cells = {};
      const seenRoles = new Set();
      let hasRows = false;
      for (const { role, schedule, worker, commented } of parsed) {
        if (selected && !selected.has(role)) continue;
        if (seenRoles.has(role)) continue; // first schedule wins on dupes
        seenRoles.add(role);
        const enabled = !commented && !fs.existsSync(path.join(cwd, 'ops', `.${role}-disabled`));
        const last =
          enabled && !(summaryOnly && role === 'deployer')
            ? lastRun(cwd, role, logIndex, lastRuns)
            : null;
        let { state, age } = commented
          ? { state: 'paused', age: null }
          : cellState(enabled, last, schedule, now);
        let deploy = null;
        // The deployer cell tracks production deploy health, not cron recency.
        // The deployhealth poller compares Cloudflare with the latest
        // deployable site commit; ops-only commits are explicitly harmless.
        // (last actual deploy time is kept in `age` for the tooltip.)
        if (role === 'deployer' && enabled) {
          const g = gitBySlug[slug] || {};
          const onMain = g.branch === 'main' || g.branch === 'master';
          const pushed = onMain && (g.ahead || 0) === 0;
          age = last ? (now - last) / 1000 : null;
          // Push state is cheap and immediate; the CF verdict supplies the
          // production meaning. Only a confirmed build failure is red.
          const bh = deployhealth.get(slug);
          let build = null;
          if (!g.isRepo) state = 'never';
          else if (g.ahead > 0)
            state = 'stale'; // committed but unpushed → pending, not confirmed failure
          else if (!onMain)
            state = 'stale'; // feature branch checked out
          else if (bh && bh.status === 'failed') {
            state = 'overdue'; // confirmed Cloudflare build failure
          } else if (bh && ['deploying', 'behind'].includes(bh.status)) {
            state = 'stale'; // pending/behind is attention, not confirmed failure
          } else state = 'fresh'; // in sync + (CF confirms live, or no CF data)
          if (bh && !summaryOnly)
            build = {
              ok: bh.ok,
              live: bh.live,
              status: bh.status,
              reason: bh.reason,
              deployableHash: bh.deployableHash,
              deployableTime: bh.deployableTime,
              headHash: bh.headHash,
              opsOnly: bh.opsOnly,
              version: bh.version,
              deployedAt: bh.deployedAt,
              error: bh.error,
            };
          if (!summaryOnly)
            deploy = {
              ahead: g.ahead || 0,
              dirty: g.dirty || 0,
              branch: g.branch || null,
              pushed,
              build,
            };
        }
        if (summaryOnly) {
          hasRows = true;
          summary.total++;
          if (!enabled) summary.paused++;
          else if (state === 'fresh') summary.fresh++;
          else if (state === 'stale') summary.stale++;
          else if (state === 'overdue') summary.overdue++;
          freq[role] = (freq[role] || 0) + 1;
          continue;
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
          cadence: cadenceClass(schedule),
          editorial: includeEditorial ? editorialTelemetry(cwd, role, logIndex, schedule) : null,
        };
        freq[role] = (freq[role] || 0) + 1;
      }
      return summaryOnly ? { site: slug, cells, hasRows } : { site: slug, cells };
    })
    .filter(s => (summaryOnly ? s.hasRows : Object.keys(s.cells).length));
  if (summaryOnly) {
    summary.siteCount = sites.length;
    summary.roleCount = Object.keys(freq).length;
    return summary;
  }
  const roles = Object.keys(freq).sort((a, b) => freq[b] - freq[a] || a.localeCompare(b));
  // Keep the canonical discovery set alongside the sparse matrix. The matrix
  // intentionally omits sites with no scheduled roles, but agent pages need
  // the full set to distinguish "not enrolled" from "not discovered".
  return { roles, sites, allSites: [...slugs] };
}

function agentMatrix(root, slugs, role) {
  const family = ROLE_FAMILIES[role];
  const profiles = family?.roles || [role];
  return matrix(root, slugs, profiles, { includeEditorial: true }).then(data => ({
    ...data,
    profiles,
    secondaryRoles: family?.secondaryRoles || [],
  }));
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

function recentRunStats(cwd, role, since, logIndex = createLogIndex(cwd)) {
  const re = logRe(role);
  const out = { observed: 0, succeeded: 0, failed: 0, unknown: 0, failures: [] };
  for (const entry of logIndex.matching(file => re.test(file), since)) {
    const { name: file, mtime } = entry;
    out.observed++;
    const text = logIndex.read(file);
    if (text === null) {
      out.unknown++;
      continue;
    }
    const exit = text.match(/exit=(\d+)/g)?.at(-1);
    if (exit && exit !== 'exit=0') {
      out.failed++;
      out.failures.push({
        file,
        mtime,
        summary: text.trim().split('\n').slice(-3).join(' ').slice(0, 300),
      });
    } else if (exit === 'exit=0' || /finished successfully|run complete|complete\./i.test(text))
      out.succeeded++;
    else if (/\b(?:FAIL|FAILED|ERROR|timed out)\b/i.test(text)) {
      out.failed++;
      out.failures.push({
        file,
        mtime,
        summary: text.trim().split('\n').slice(-3).join(' ').slice(0, 300),
      });
    } else out.unknown++;
  }
  out.failures.sort((a, b) => b.mtime - a.mtime);
  return out;
}

async function health(
  root,
  role,
  slugs,
  usage = {},
  skipFamily = false,
  matrixData = null,
  siteContexts = new Map()
) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(role || ''))) throw httpErr(400, 'invalid role');
  const data = matrixData || (await matrix(root, slugs));
  const family = ROLE_FAMILIES[role];
  if (family && !skipFamily) {
    const parts = await Promise.all(
      family.roles.map(profile => health(root, profile, slugs, usage, true, data, siteContexts))
    );
    const rows = parts.flatMap(part => part.rows);
    return {
      role,
      family: { role, ...family, profiles: family.roles },
      windowDays: 7,
      summary: {
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
      },
      alerts: rows.flatMap(row =>
        (row.editorial?.alerts || []).map(alert => ({ site: row.site, role: row.role, ...alert }))
      ),
      rows,
    };
  }
  const cutoff = Date.now() - 7 * 86400 * 1000;
  const spend = new Map(
    (usage.by_site_role || []).filter(row => row.role === role).map(row => [row.site, row])
  );
  const rows = [];
  const promptCounts = {};
  for (const site of data.sites) {
    const cell = site.cells[role];
    if (!cell) continue;
    const cwd = siteDir(root, site.site);
    let context = siteContexts.get(site.site);
    if (!context) {
      context = {
        logIndex: createLogIndex(cwd),
        lastRuns: readLastRuns(path.join(cwd, 'ops')),
      };
      siteContexts.set(site.site, context);
    }
    const stats = recentRunStats(cwd, role, cutoff, context.logIndex);
    const history = execution.executionHistory(root, site.site, role, cell.schedule, {
      from: new Date(cutoff),
      enabled: cell.enabled,
      logIndex: context.logIndex,
      lastRuns: context.lastRuns,
    });
    const prompt = promptHash(cwd, role);
    const runner = cell.worker ? 'run-worker.sh' : 'dedicated-script';
    const key = `${runner}:${prompt || 'missing'}`;
    promptCounts[key] = (promptCounts[key] || 0) + 1;
    rows.push({
      site: site.site,
      role,
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
      editorial: Object.hasOwn(cell, 'editorial')
        ? cell.editorial
        : editorialTelemetry(cwd, role, context.logIndex, cell.schedule),
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
  return {
    role,
    windowDays: 7,
    summary,
    alerts: rows.flatMap(row =>
      (row.editorial?.alerts || []).map(alert => ({ site: row.site, role, ...alert }))
    ),
    rows,
  };
}

// The dashboard's expandable history renders only the most recent twelve
// slots per site. Keep the full health() result available to other callers,
// while allowing the UI to avoid transferring and parsing older detail rows.
function compactHealth(data) {
  return {
    ...data,
    rows: (data.rows || []).map(row =>
      row.execution
        ? {
            ...row,
            execution: {
              slots: Array.isArray(row.execution.slots)
                ? row.execution.slots.slice(-12).map(({ at, status, observedAt }) => ({
                    at,
                    status,
                    ...(observedAt === undefined ? {} : { observedAt }),
                  }))
                : [],
            },
          }
        : row
    ),
  };
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
  invalidateMatrix(root);
  return { ok: true, role: r, enabled };
}

// Lightweight agent list for the nav dropdown: roles scheduled on ≥2 sites,
// engineer first, then by frequency. Only parses crontabs (no log scans), so
// it's cheap to call on every nav render. New roles appear automatically.
function agents(root, slugs) {
  const freq = {};
  const rolesBySite = new Map();
  for (const slug of slugs) {
    const seen = new Set();
    for (const { role } of parseRoles(readFirst(siteDir(root, slug), CRONTABS), {
      includeCommented: true,
    })) {
      seen.add(role);
    }
    rolesBySite.set(slug, seen);
    for (const role of seen) {
      freq[role] = (freq[role] || 0) + 1;
    }
  }
  const editorialProfiles = ROLE_FAMILIES.update.roles.filter(role => freq[role]);
  const editorialSites = new Set();
  for (const slug of slugs) {
    const siteRoles = rolesBySite.get(slug) || new Set();
    if (editorialProfiles.some(role => siteRoles.has(role))) editorialSites.add(slug);
  }
  const scheduled = Object.keys(freq)
    .filter(r => !ROLE_FAMILIES.update.roles.includes(r))
    .filter(r => freq[r] >= 2)
    .sort(
      (a, b) =>
        (a === 'engineer' ? -1 : b === 'engineer' ? 1 : 0) ||
        freq[b] - freq[a] ||
        a.localeCompare(b)
    )
    .map(r => ({ role: r, sites: freq[r], scope: 'sites', kind: 'scheduled' }));
  return [
    ...FLEET_EXECUTIVE_ROLES,
    ...(editorialSites.size
      ? [
          {
            role: 'update',
            sites: editorialSites.size,
            scope: 'sites',
            kind: 'family',
            profiles: editorialProfiles,
            label: ROLE_FAMILIES.update.label,
            description: ROLE_FAMILIES.update.description,
          },
        ]
      : []),
    ...scheduled,
  ];
}

module.exports = {
  matrix,
  vitals,
  agentMatrix,
  invalidateMatrix,
  health,
  compactHealth,
  roleLog,
  setEnabled,
  agents,
  roleEntry,
  parseRoles,
  enrollment,
  cadenceClass,
  FLEET_EXECUTIVE_ROLES,
  ROLE_FAMILIES,
  roleFamily,
};
