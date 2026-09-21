'use strict';

// Persisted, rate-limited dispatcher for on-demand domain managers. Reports
// identify candidates; this module decides when specialists may run.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const reports = require('./domain-reports');
const eventstore = require('./eventstore');
const executive = require('./executive');

const MAX_ATTEMPTS = 3;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const BUSY_RETRY_MS = 60 * 1000;
const EXCLUDED_SITES = new Set(['3boobs.com']);

function statePath(root) {
  return path.join(root, 'tools', 'executive', 'data', 'domain-manager-dispatch.json');
}

function readState(root) {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(root), 'utf8'));
    return {
      updated_at: value.updated_at || null,
      jobs: Array.isArray(value.jobs) ? value.jobs : [],
    };
  } catch {
    return { updated_at: null, jobs: [] };
  }
}

function writeState(root, state) {
  const file = statePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(
    temp,
    JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2),
    { mode: 0o600 }
  );
  fs.renameSync(temp, file);
}

function fingerprint(candidate) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        site: candidate.site,
        reasons: candidate.reasons || [],
      })
    )
    .digest('hex');
}

function enqueueLatest(root, { now = new Date(), cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  const latest = reports.recent(root, 50).find(row => row.cadence === 'six_hour');
  if (!latest) return { added: [], state: readState(root) };
  const full = reports.get(root, latest.report_id);
  if (!full) return { added: [], state: readState(root) };
  const state = readState(root);
  const added = [];
  for (const candidate of full.deep_dive_candidates || []) {
    if (!candidate.site || String(candidate.site).toLowerCase() === '3boobs.com') continue;
    const fp = fingerprint(candidate);
    const existing = state.jobs.find(job => job.fingerprint === fp && job.site === candidate.site);
    const recentlyCompleted =
      existing &&
      existing.status === 'completed' &&
      now.getTime() - Date.parse(existing.completed_at || 0) < cooldownMs;
    if (existing && (['queued', 'running'].includes(existing.status) || recentlyCompleted))
      continue;
    const job = {
      job_id: crypto.randomUUID(),
      fingerprint: fp,
      site: candidate.site,
      reasons: candidate.reasons || [],
      report_id: full.report_id,
      status: 'queued',
      attempts: 0,
      requested_at: now.toISOString(),
      next_attempt_at: now.toISOString(),
      lease_until: null,
      last_error: null,
    };
    state.jobs.push(job);
    added.push(job);
  }
  writeState(root, state);
  return { added, state };
}

function priority(job) {
  return job.site === 'greatamericanlakes.com' ? 0 : 1;
}

function claimNext(
  root,
  { now = new Date(), leaseMs = 30 * 60 * 1000, maxConcurrent = DEFAULT_MAX_CONCURRENT } = {}
) {
  const state = readState(root);
  const expired = state.jobs.filter(
    job =>
      job.status === 'running' && job.lease_until && Date.parse(job.lease_until) <= now.getTime()
  );
  for (const job of expired) {
    job.status = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
    job.next_attempt_at = now.toISOString();
    job.lease_until = null;
    job.last_error = 'dispatcher lease expired';
  }
  if (state.jobs.filter(job => job.status === 'running').length >= maxConcurrent) {
    writeState(root, state);
    return null;
  }
  const job = state.jobs
    .filter(
      row =>
        row.site &&
        !EXCLUDED_SITES.has(String(row.site).toLowerCase()) &&
        row.status === 'queued' &&
        (!row.next_attempt_at || Date.parse(row.next_attempt_at) <= now.getTime())
    )
    .sort(
      (a, b) => priority(a) - priority(b) || Date.parse(a.requested_at) - Date.parse(b.requested_at)
    )[0];
  if (!job) {
    writeState(root, state);
    return null;
  }
  job.status = 'running';
  job.attempts += 1;
  job.claimed_at = now.toISOString();
  job.lease_until = new Date(now.getTime() + leaseMs).toISOString();
  writeState(root, state);
  return job;
}

function finish(root, jobId, { ok, busy = false, error = null, now = new Date() } = {}) {
  const state = readState(root);
  const job = state.jobs.find(row => row.job_id === jobId);
  if (!job) throw new Error('domain-manager job not found');
  job.lease_until = null;
  job.last_error = error;
  if (busy) {
    // A global executive run (for example the scheduled CEO tick) may still
    // occupy the provider. This is not a failed manager attempt and must not
    // consume an attempt or defer a site for six hours.
    job.status = 'queued';
    job.attempts = Math.max(0, job.attempts - 1);
    job.next_attempt_at = new Date(now.getTime() + BUSY_RETRY_MS).toISOString();
    job.last_error = error || 'executive runner busy; retry scheduled';
  } else if (ok) {
    job.status = 'completed';
    job.completed_at = now.toISOString();
  } else if (job.attempts >= MAX_ATTEMPTS) {
    job.status = 'failed';
    job.failed_at = now.toISOString();
  } else {
    job.status = 'queued';
    job.next_attempt_at = new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString();
  }
  writeState(root, state);
  return job;
}

function summary(root) {
  const jobs = readState(root).jobs;
  return {
    total: jobs.length,
    queued: jobs.filter(job => job.status === 'queued').length,
    running: jobs.filter(job => job.status === 'running').length,
    completed: jobs.filter(job => job.status === 'completed').length,
    failed: jobs.filter(job => job.status === 'failed').length,
    next:
      jobs.filter(job => job.status === 'queued').sort((a, b) => priority(a) - priority(b))[0] ||
      null,
  };
}

async function runOne(
  root,
  {
    now = new Date(),
    command = path.join(root, 'tools/executive/run-domain-manager.sh'),
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
  } = {}
) {
  const job = claimNext(root, { now, maxConcurrent });
  if (!job) return { job: null, summary: summary(root) };
  const store = eventstore.open(root);
  const audit = executive.action(store, {
    actor: 'system',
    action_type: 'delegate',
    summary: `Dispatch domain manager for ${job.site}`,
    target_type: 'domain-manager-job',
    target_id: job.job_id,
  });
  store.close();
  const result = await new Promise(resolve => {
    const child = spawn(command, [job.site], {
      cwd: root,
      env: { ...process.env, EXECUTIVE_ALLOW_QUEUE: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('close', code =>
      resolve({ code: code == null ? 1 : code, stderr: stderr.slice(-2000) })
    );
    child.on('error', error => resolve({ code: 1, stderr: error.message }));
  });
  const completed = finish(root, job.job_id, {
    ok: result.code === 0,
    busy: result.code === 75 && /executive tick already running/i.test(result.stderr),
    error: result.code === 0 ? null : result.stderr,
    now: new Date(),
  });
  const finalStore = eventstore.open(root);
  executive.finishAction(finalStore, audit.action_id, {
    status:
      result.code === 0
        ? 'completed'
        : completed.status === 'queued' && completed.attempts < job.attempts
          ? 'skipped'
          : 'failed',
    error: result.code === 0 ? null : result.stderr,
    result: {
      job_id: job.job_id,
      site: job.site,
      attempts: completed.attempts,
      busy: completed.status === 'queued' && completed.attempts < job.attempts,
    },
  });
  finalStore.close();
  return { job: completed, result, summary: summary(root) };
}

module.exports = {
  MAX_ATTEMPTS,
  DEFAULT_MAX_CONCURRENT,
  BUSY_RETRY_MS,
  statePath,
  readState,
  writeState,
  fingerprint,
  enqueueLatest,
  claimNext,
  finish,
  summary,
  runOne,
};
