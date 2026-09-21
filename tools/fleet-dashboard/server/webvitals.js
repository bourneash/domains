'use strict';

const fs = require('node:fs');
const path = require('node:path');
const scheduler = require('./scheduler');

const FACTORS = ['mobile', 'desktop'];
const MAX_HISTORY = 30;

function reportPath(root, factor) {
  return path.join(root, 'tools', 'web-vitals', 'reports', `latest-${factor}.json`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readLatest(root, factor) {
  return (
    readJson(reportPath(root, factor)) ||
    (factor === 'mobile'
      ? readJson(path.join(root, 'tools', 'web-vitals', 'reports', 'latest.json'))
      : null)
  );
}

function readHistory(root) {
  const file = path.join(root, 'tools', 'web-vitals', 'reports', 'history.jsonl');
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-2000)
      .map(line => JSON.parse(line))
      .filter(row => FACTORS.includes(row.form_factor));
  } catch {
    return [];
  }
}

function ageSeconds(at, now = Date.now()) {
  const time = Date.parse(at || '');
  return Number.isFinite(time) ? Math.max(0, Math.round((now - time) / 1000)) : null;
}

function trend(history, site, factor) {
  return history
    .filter(row => row.site === site && row.form_factor === factor)
    .slice(-MAX_HISTORY)
    .map(row => ({
      at: row.at,
      performance: row.performance,
      lcp_ms: row.lcp_ms,
      cls: row.cls,
      tbt_ms: row.tbt_ms,
    }));
}

function snapshot(root, now = Date.now()) {
  const reports = Object.fromEntries(FACTORS.map(factor => [factor, readLatest(root, factor)]));
  const history = readHistory(root);
  const sites = [
    ...new Set(FACTORS.flatMap(factor => (reports[factor]?.sites || []).map(row => row.site))),
  ].sort();
  const rows = sites.map(site => {
    const factors = {};
    for (const factor of FACTORS) {
      const report = reports[factor];
      const row = report?.sites?.find(item => item.site === site) || null;
      factors[factor] = row
        ? {
            ...row,
            age_seconds: ageSeconds(report.at, now),
            trend: trend(history, site, factor),
          }
        : null;
    }
    return { site, mobile: factors.mobile, desktop: factors.desktop };
  });
  return {
    generated_at: new Date(now).toISOString(),
    factors: Object.fromEntries(
      FACTORS.map(factor => [
        factor,
        reports[factor]
          ? {
              at: reports[factor].at,
              age_seconds: ageSeconds(reports[factor].at, now),
              form_factor: factor,
              totals: reports[factor].totals || {},
              budgets: reports[factor].budgets || {},
            }
          : null,
      ])
    ),
    sites: rows,
  };
}

async function run(root, factor, call = scheduler.makeFleetClient()) {
  if (!FACTORS.includes(factor)) throw new Error('invalid form factor');
  if (!fs.existsSync(path.join(root, 'tools', 'scripts', 'vitals-sweep-cron.sh'))) {
    throw new Error('vitals sweep runner is missing');
  }
  const jobName = factor === 'mobile' ? 'vitals-sweep-cron' : 'vitals-sweep-cron-2';
  const listed = await call('GET', 'jobs', { site: 'fleet' }, undefined, 'fleet-dashboard');
  if (listed.status !== 200) {
    const e = new Error(listed.data?.error || `fleet scheduler returned ${listed.status}`);
    e.httpStatus = listed.status === 503 ? 503 : 502;
    throw e;
  }
  const job = (Array.isArray(listed.data) ? listed.data : []).find(row => row.name === jobName);
  if (!job) {
    const e = new Error(`fleet scheduler job "${jobName}" is not imported`);
    e.httpStatus = 503;
    throw e;
  }
  const queued = await call('POST', `jobs/${job.id}/run`, {}, {}, 'fleet-dashboard');
  if (queued.status !== 200) {
    const e = new Error(queued.data?.error || `fleet scheduler returned ${queued.status}`);
    e.httpStatus = queued.status === 409 ? 409 : 502;
    throw e;
  }
  return {
    ok: true,
    factor,
    run_id: queued.data?.run_id,
    message: `${factor} web-vitals sweep queued`,
  };
}

module.exports = { FACTORS, snapshot, run, readHistory };
