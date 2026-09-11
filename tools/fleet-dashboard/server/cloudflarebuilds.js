'use strict';

// Read-only Cloudflare Workers Builds telemetry. A background poller keeps a
// small, sanitized on-disk cache so the SPA can refresh freely without turning
// every browser poll into 100+ Cloudflare API requests. The first sweep
// backfills available history; later sweeps page only until they meet a build
// already in the cache.

const fs = require('node:fs');
const path = require('node:path');

const POLL_MS = 5 * 60 * 1000;
const TRIGGER_POLL_MS = 60 * 60 * 1000;
const RETAIN_DAYS = 180;
const PER_PAGE = 200;
const MAX_PAGES = 50;
// Cloudflare's Builds edge intermittently resets bursts of parallel requests.
// Two workers at a time keeps the first backfill moving without triggering a
// wave of transport-level failures.
const CONCURRENCY = 2;
const INCLUDED_MINUTES = 6000;
const OVERAGE_PER_MINUTE_USD = 0.005;
const TARGET_PATHS = ['site/*', '.deploy-probe'];
const EXCLUDED_PATHS = ['ops/*'];
const CACHE_VERSION = 1;

let STATE = {
  builds: [],
  triggers: [],
  lastSweep: 0,
  lastTriggerSweep: 0,
  refreshing: false,
  error: null,
  errors: [],
};
let activeRoot = null;

function cacheFile(root) {
  return path.join(root, 'tools', 'fleet-dashboard', 'data', 'cloudflare-builds.json');
}

function pickEnv(text, key) {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*["']?([^\\s"'#]+)`, 'm'));
  return match ? match[1] : null;
}

function loadCreds(root) {
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) {
    return {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
    };
  }
  try {
    const text = fs.readFileSync(path.join(root, '.env'), 'utf8');
    const accountId = pickEnv(text, 'CLOUDFLARE_ACCOUNT_ID');
    const token = pickEnv(text, 'CLOUDFLARE_API_TOKEN');
    return accountId && token ? { accountId, token } : null;
  } catch {
    return null;
  }
}

function load(root) {
  activeRoot = root;
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(root), 'utf8'));
    if (Array.isArray(parsed.builds) && Array.isArray(parsed.triggers)) {
      STATE = {
        builds: parsed.builds,
        triggers: parsed.triggers,
        lastSweep: Number(parsed.lastSweep) || 0,
        // A cache written before versioning may contain a timestamp from a
        // partial trigger sweep. Keep its useful build history, but force one
        // complete trigger inventory before trusting the cadence marker.
        lastTriggerSweep:
          Number(parsed.cacheVersion) === CACHE_VERSION
            ? Number(parsed.lastTriggerSweep) || 0
            : 0,
        refreshing: false,
        error: parsed.error || null,
        errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      };
    }
  } catch {
    /* first run or corrupt cache: the live sweep will replace it */
  }
}

function save(root) {
  const file = cacheFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({
      cacheVersion: CACHE_VERSION,
      builds: STATE.builds,
      triggers: STATE.triggers,
      lastSweep: STATE.lastSweep,
      lastTriggerSweep: STATE.lastTriggerSweep,
      error: STATE.error,
      errors: STATE.errors,
    }),
    'utf8'
  );
  fs.renameSync(tmp, file);
}

async function cf(creds, apiPath) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`https://api.cloudflare.com/client/v4${apiPath}`, {
        headers: { Authorization: `Bearer ${creds.token}` },
        signal: AbortSignal.timeout(20000),
      });
      const data = await response.json();
      if (response.ok && data && data.success === true) return data;
      const message = data && data.errors && data.errors[0] && data.errors[0].message;
      lastError = new Error(message || `Cloudflare HTTP ${response.status}`);
      if (response.status !== 429 && response.status < 500) throw lastError;
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
    }
    await new Promise(resolve => setTimeout(resolve, 300 * 2 ** attempt));
  }
  const cause = lastError && lastError.cause && lastError.cause.code;
  throw new Error(`${lastError && lastError.message ? lastError.message : 'Cloudflare request failed'}${cause ? ` (${cause})` : ''}`);
}

async function mapLimit(items, limit, fn) {
  const queue = items.slice();
  const out = [];
  async function worker() {
    for (let item = queue.shift(); item; item = queue.shift()) out.push(await fn(item));
  }
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
  return out;
}

function durationSeconds(build) {
  const start = Date.parse(build.running_on || build.initializing_on || build.created_on || '');
  const stop = Date.parse(build.stopped_on || '');
  return Number.isFinite(start) && Number.isFinite(stop) && stop >= start
    ? Math.round((stop - start) / 1000)
    : null;
}

function sanitizeTrigger(trigger, workerName) {
  return {
    uuid: trigger.trigger_uuid,
    worker: workerName,
    externalScriptId: trigger.external_script_id,
    name: trigger.trigger_name || '',
    repo: (trigger.repo_connection && trigger.repo_connection.repo_name) || '',
    providerAccount: (trigger.repo_connection && trigger.repo_connection.provider_account_name) || '',
    provider: (trigger.repo_connection && trigger.repo_connection.provider_type) || '',
    root: trigger.root_directory || '',
    branchIncludes: trigger.branch_includes || [],
    branchExcludes: trigger.branch_excludes || [],
    pathIncludes: trigger.path_includes || [],
    pathExcludes: trigger.path_excludes || [],
    caching: trigger.build_caching_enabled === true,
    modifiedOn: trigger.modified_on || null,
  };
}

function sanitizeBuild(build, workerName) {
  const metadata = build.build_trigger_metadata || {};
  const trigger = build.trigger || {};
  const connection = trigger.repo_connection || {};
  return {
    uuid: build.build_uuid,
    worker: workerName,
    repo: metadata.repo_name || connection.repo_name || '',
    providerAccount: metadata.provider_account_name || connection.provider_account_name || '',
    triggerName: trigger.trigger_name || '',
    branch: metadata.branch || '',
    commitHash: metadata.commit_hash || '',
    commitMessage: String(metadata.commit_message || '').slice(0, 1000),
    author: String(metadata.author || '').slice(0, 200),
    source: metadata.build_trigger_source || '',
    outcome: build.build_outcome || '',
    status: build.status || '',
    createdOn: build.created_on || null,
    stoppedOn: build.stopped_on || null,
    durationSeconds: durationSeconds(build),
  };
}

async function fetchWorker(creds, accountId, script, knownIds, refreshTriggers) {
  const base = `/accounts/${accountId}/builds/workers/${script.tag}`;
  const triggerData = refreshTriggers ? await cf(creds, `${base}/triggers`) : null;
  const firstPage = await cf(creds, `${base}/builds?per_page=${PER_PAGE}&page=1`);
  const rawBuilds = [...(firstPage.result || [])];
  const totalPages = Math.min(Number(firstPage.result_info && firstPage.result_info.total_pages) || 1, MAX_PAGES);
  let metKnown = rawBuilds.some(build => knownIds.has(build.build_uuid));
  for (let page = 2; page <= totalPages && !metKnown; page += 1) {
    const pageData = await cf(creds, `${base}/builds?per_page=${PER_PAGE}&page=${page}`);
    const rows = pageData.result || [];
    rawBuilds.push(...rows);
    metKnown = rows.some(build => knownIds.has(build.build_uuid));
  }
  return {
    worker: script.id,
    externalScriptId: script.tag,
    triggers: triggerData
      ? (triggerData.result || []).map(row => sanitizeTrigger(row, script.id))
      : null,
    builds: rawBuilds.map(row => sanitizeBuild(row, script.id)),
  };
}

async function refresh(root = activeRoot) {
  if (!root || STATE.refreshing) return;
  const creds = loadCreds(root);
  if (!creds) {
    STATE.error = 'Cloudflare credentials unavailable';
    return;
  }
  STATE.refreshing = true;
  const errors = [];
  try {
    const scriptsData = await cf(creds, `/accounts/${creds.accountId}/workers/scripts?per_page=100`);
    const scripts = (scriptsData.result || []).filter(row => row.tag && row.id);
    const refreshTriggers =
      !STATE.lastTriggerSweep ||
      STATE.errors.length > 0 ||
      Date.now() - STATE.lastTriggerSweep >= TRIGGER_POLL_MS;
    const knownByWorker = new Map();
    for (const build of STATE.builds) {
      if (!knownByWorker.has(build.worker)) knownByWorker.set(build.worker, new Set());
      knownByWorker.get(build.worker).add(build.uuid);
    }
    const fetched = await mapLimit(scripts, CONCURRENCY, async script => {
      try {
        return await fetchWorker(
          creds,
          creds.accountId,
          script,
          knownByWorker.get(script.id) || new Set(),
          refreshTriggers
        );
      } catch (error) {
        errors.push({ worker: script.id, error: String(error.message || error) });
        return null;
      }
    });
    const successful = fetched.filter(Boolean);
    const successfulTriggerWorkers = new Set(
      successful.filter(row => row.triggers !== null).map(row => row.worker)
    );
    const buildMap = new Map(STATE.builds.map(build => [build.uuid, build]));
    for (const row of successful) for (const build of row.builds) buildMap.set(build.uuid, build);
    const cutoff = Date.now() - RETAIN_DAYS * 86400000;
    STATE.builds = [...buildMap.values()]
      .filter(build => Date.parse(build.createdOn || '') >= cutoff)
      .sort((a, b) => String(b.createdOn).localeCompare(String(a.createdOn)));
    STATE.triggers = [
      ...STATE.triggers.filter(trigger => !successfulTriggerWorkers.has(trigger.worker)),
      ...successful.flatMap(row => row.triggers || []),
    ].sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));
    STATE.lastSweep = Date.now();
    if (refreshTriggers && errors.length === 0) STATE.lastTriggerSweep = STATE.lastSweep;
    STATE.errors = errors.slice(0, 20);
    STATE.error = errors.length === scripts.length ? 'Every Cloudflare worker refresh failed' : null;
    save(root);
  } catch (error) {
    STATE.error = String(error.message || error);
    STATE.errors = [{ worker: null, error: STATE.error }];
  } finally {
    STATE.refreshing = false;
  }
}

function sameArray(a, b) {
  return Array.isArray(a) && a.length === b.length && a.every((value, i) => value === b[i]);
}

function triggerCompliant(trigger) {
  return (
    trigger.root === 'site' &&
    sameArray(trigger.pathIncludes, TARGET_PATHS) &&
    sameArray(trigger.pathExcludes, EXCLUDED_PATHS) &&
    trigger.caching === true
  );
}

function summarize(state = STATE, { days = 30, limit = 300, now = Date.now() } = {}) {
  const safeDays = Math.max(1, Math.min(Number(days) || 30, RETAIN_DAYS));
  const safeLimit = Math.max(10, Math.min(Number(limit) || 300, 1000));
  const cutoff = now - safeDays * 86400000;
  const builds = state.builds.filter(build => Date.parse(build.createdOn || '') >= cutoff);
  const minuteTotal = rows =>
    rows.reduce((sum, build) => sum + (Number(build.durationSeconds) || 0) / 60, 0);
  const byRepo = new Map();
  for (const trigger of state.triggers) {
    const key = trigger.repo || trigger.worker;
    if (!byRepo.has(key)) {
      byRepo.set(key, {
        repo: trigger.repo,
        providerAccount: trigger.providerAccount,
        workers: new Set(),
        triggers: 0,
        production: 0,
        preview: 0,
        compliant: 0,
        caching: 0,
        pathIncludes: trigger.pathIncludes,
      });
    }
    const row = byRepo.get(key);
    row.workers.add(trigger.worker);
    row.triggers += 1;
    if (trigger.branchIncludes.includes('main')) row.production += 1;
    else row.preview += 1;
    if (triggerCompliant(trigger)) row.compliant += 1;
    if (trigger.caching) row.caching += 1;
  }
  for (const build of builds) {
    const key = build.repo || build.worker;
    if (!byRepo.has(key)) {
      byRepo.set(key, {
        repo: build.repo,
        providerAccount: build.providerAccount,
        workers: new Set([build.worker]),
        triggers: 0,
        production: 0,
        preview: 0,
        compliant: 0,
        caching: 0,
        pathIncludes: [],
      });
    }
    const row = byRepo.get(key);
    row.builds = (row.builds || 0) + 1;
    row.minutes = (row.minutes || 0) + (Number(build.durationSeconds) || 0) / 60;
    if (build.outcome === 'success') row.successes = (row.successes || 0) + 1;
    if (!row.latestOn || build.createdOn > row.latestOn) {
      row.latestOn = build.createdOn;
      row.latestHash = build.commitHash;
      row.latestMessage = build.commitMessage;
    }
  }
  const repoRows = [...byRepo.values()]
    .map(row => ({
      ...row,
      workers: [...row.workers],
      builds: row.builds || 0,
      minutes: row.minutes || 0,
      successes: row.successes || 0,
      successRate: row.builds ? (row.successes || 0) / row.builds : null,
      averageSeconds: row.builds ? ((row.minutes || 0) * 60) / row.builds : null,
      policyOk: row.triggers > 0 && row.compliant === row.triggers,
      cacheOk: row.triggers > 0 && row.caching === row.triggers,
    }))
    .sort((a, b) => b.minutes - a.minutes || b.builds - a.builds || a.repo.localeCompare(b.repo));

  const dayMap = new Map();
  for (const build of builds) {
    const day = String(build.createdOn || '').slice(0, 10);
    if (!dayMap.has(day)) dayMap.set(day, { day, builds: 0, minutes: 0, failed: 0 });
    const row = dayMap.get(day);
    row.builds += 1;
    row.minutes += (Number(build.durationSeconds) || 0) / 60;
    if (build.outcome !== 'success') row.failed += 1;
  }
  const byDay = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));

  const nowDate = new Date(now);
  const monthStart = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1);
  const nextMonth = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 1);
  const monthBuilds = state.builds.filter(build => Date.parse(build.createdOn || '') >= monthStart);
  const monthMinutes = minuteTotal(monthBuilds);
  const elapsed = Math.max(1, now - monthStart);
  const projectedMinutes = monthMinutes * ((nextMonth - monthStart) / elapsed);
  const failed = builds.filter(build => build.outcome !== 'success').length;
  const triggerCount = state.triggers.length;
  const compliantTriggers = state.triggers.filter(triggerCompliant).length;

  return {
    generatedAt: new Date(now).toISOString(),
    lastSweep: state.lastSweep || 0,
    lastTriggerSweep: state.lastTriggerSweep || 0,
    refreshing: Boolean(state.refreshing),
    error: state.error || null,
    errors: state.errors || [],
    filters: { days: safeDays, limit: safeLimit },
    pricing: {
      includedMinutes: INCLUDED_MINUTES,
      overagePerMinuteUsd: OVERAGE_PER_MINUTE_USD,
    },
    summary: {
      builds: builds.length,
      minutes: minuteTotal(builds),
      failed,
      successRate: builds.length ? (builds.length - failed) / builds.length : null,
      averageSeconds: builds.length ? (minuteTotal(builds) * 60) / builds.length : null,
      connectedRepos: new Set(state.triggers.map(trigger => trigger.repo).filter(Boolean)).size,
      activeRepos: new Set(builds.map(build => build.repo).filter(Boolean)).size,
      triggers: triggerCount,
      productionTriggers: state.triggers.filter(trigger => trigger.branchIncludes.includes('main')).length,
      previewTriggers: state.triggers.filter(trigger => !trigger.branchIncludes.includes('main')).length,
      compliantTriggers,
      cachingTriggers: state.triggers.filter(trigger => trigger.caching).length,
      monthBuilds: monthBuilds.length,
      monthMinutes,
      monthOverageUsd: Math.max(0, monthMinutes - INCLUDED_MINUTES) * OVERAGE_PER_MINUTE_USD,
      projectedMinutes,
      projectedOverageUsd:
        Math.max(0, projectedMinutes - INCLUDED_MINUTES) * OVERAGE_PER_MINUTE_USD,
    },
    byDay,
    byRepo: repoRows,
    triggers: state.triggers,
    builds: builds.slice(0, safeLimit),
  };
}

function start(root) {
  load(root);
  refresh(root).catch(() => {});
  const timer = setInterval(() => refresh(root).catch(() => {}), POLL_MS);
  if (timer.unref) timer.unref();
}

module.exports = {
  start,
  refresh,
  summarize,
  _sanitizeBuild: sanitizeBuild,
  _sanitizeTrigger: sanitizeTrigger,
  _triggerCompliant: triggerCompliant,
  _load: load,
  _state: () => STATE,
};
