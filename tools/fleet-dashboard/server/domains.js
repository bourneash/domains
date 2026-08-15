'use strict';

// Domain onboarding / offboarding — the dashboard's spool side.
//
// THE ONE RULE HERE: this module contains no domain logic. Every step of
// standing a domain up (scaffold, GitHub repo, submodule, CF zone/email,
// worker deploy, apex+www bind) and tearing it down (archive repo, detach
// custom domains, delete worker, drop email rules, remove submodule) already
// lives in tools/scripts/*.sh, orchestrated by domain-manager-cli.sh. All this
// module does is validate a request and drop a job file where the host runner
// (tools/scripts/domain-job-runner.sh) will find it.
//
// Why a spool instead of child_process here: the panel runs as root in a
// container with no `gh`, no host nvm node, and no business writing to the
// parent repo's .git — a root-run `git submodule add` is exactly the
// root-owned-objects corruption the fleet has been bitten by. The runner runs
// on the host as uid 1000 and shells out to the real CLI.

const fs = require('node:fs');
const path = require('node:path');

const RUNNER_REL = path.join('tools', 'scripts', 'domain-job-runner.sh');

// Mirror of the runner's allowlist. Both sides validate: the spool is a
// file-backed queue, so neither end trusts the other's filtering.
const COMMANDS = {
  add: {
    label: 'Onboard',
    flags: ['--full', '--bootstrap-only', '--no-deploy', '--no-bind', '--no-email'],
    destructive: false,
  },
  remove: {
    label: 'Offboard',
    // NOTE: remove-domain.sh also accepts --delete-repo. It is deliberately NOT
    // exposed here. Fleet policy: repos are archived, never deleted — an
    // offboarded domain's history stays recoverable. Deleting one is a manual,
    // deliberate act on the CLI, not something reachable by a click.
    flags: ['--no-github', '--no-cloudflare', '--no-local'],
    destructive: true,
  },
  status: { label: 'Status', flags: [], destructive: false },
  repair: {
    label: 'Repair',
    flags: ['--plan', '--no-email', '--no-deploy', '--no-bind'],
    destructive: false,
  },
  deploy: { label: 'Deploy', flags: [], destructive: false },
  bind: { label: 'Bind', flags: [], destructive: false },
  email: { label: 'Email routing', flags: [], destructive: false },
  bootstrap: { label: 'Bootstrap only', flags: ['--no-email'], destructive: false },
};

// Hostname, not a URL and not a bare label — the scripts derive the worker
// name, repo name and submodule path straight from this string.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// A job is "live" (blocks a second job on the same domain) until it terminates.
const LIVE = new Set(['queued', 'running']);

// The runner touches .heartbeat every poll; cron relaunches it every minute.
// Past this the UI says the runner is down rather than letting jobs sit in
// "queued" forever with no explanation.
const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

const MAX_JOBS = 60;
const LOG_TAIL_BYTES = 256 * 1024;

function httpErr(status, msg) {
  const e = new Error(msg);
  e.httpStatus = status;
  return e;
}

function spoolDir(root) {
  return path.join(root, 'tools', 'fleet-dashboard', 'data', 'domain-jobs');
}

function jobPath(root, id) {
  return path.join(spoolDir(root), `${id}.json`);
}

function logPath(root, id) {
  return path.join(spoolDir(root), `${id}.log`);
}

// Ids are timestamp-prefixed on purpose: the runner picks the next queued job
// by lexical glob order, so the id IS the queue position.
function newId() {
  const t = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `${t}-${Math.random().toString(36).slice(2, 8)}`;
}

function isJobId(id) {
  return typeof id === 'string' && /^[0-9]{8}-[0-9]{6}-[a-z0-9]{6}$/.test(id);
}

function readJob(root, id) {
  try {
    const job = JSON.parse(fs.readFileSync(jobPath(root, id), 'utf8'));
    return job && job.id === id ? job : null;
  } catch {
    return null;
  }
}

function listJobs(root) {
  let names = [];
  try {
    names = fs.readdirSync(spoolDir(root));
  } catch {
    // No job has ever been queued on this host — a real state, not an error.
    return [];
  }
  const jobs = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!isJobId(id)) continue;
    const job = readJob(root, id);
    if (job) jobs.push(job);
  }
  // Newest first — id order is time order.
  jobs.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return jobs.slice(0, MAX_JOBS);
}

// Tail of the job's combined stdout+stderr. Read from the end so a long
// bootstrap (npm install + astro build + wrangler deploy) doesn't blow up the
// response as it grows.
function jobLog(root, id) {
  if (!isJobId(id)) throw httpErr(400, 'invalid job id');
  const job = readJob(root, id);
  if (!job) throw httpErr(404, 'unknown job');
  let text = '';
  let truncated = false;
  try {
    const fd = fs.openSync(logPath(root, id), 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - LOG_TAIL_BYTES);
      truncated = start > 0;
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // The runner creates the log when it picks the job up; a still-queued job
    // legitimately has none yet.
  }
  return { job, log: text, truncated };
}

// Is the host runner alive? Without it, queued jobs never move — the UI needs
// to say so out loud rather than showing a silently stuck queue.
function runner(root) {
  const installed = fs.existsSync(path.join(root, RUNNER_REL));
  let lastTick = null;
  try {
    lastTick = fs.statSync(path.join(spoolDir(root), '.heartbeat')).mtime.toISOString();
  } catch {
    /* never ticked */
  }
  const ageMs = lastTick ? Date.now() - new Date(lastTick).getTime() : null;
  return {
    installed,
    lastTick,
    ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
    alive: ageMs !== null && ageMs < HEARTBEAT_STALE_MS,
    command: `${RUNNER_REL}`,
  };
}

function commands() {
  return Object.entries(COMMANDS).map(([name, c]) => ({
    name,
    label: c.label,
    flags: c.flags,
    destructive: c.destructive,
  }));
}

function validate(root, { command, domain, flags }) {
  const spec = COMMANDS[command];
  if (!spec) throw httpErr(400, `unsupported command: ${command}`);

  const host = String(domain || '')
    .trim()
    .toLowerCase();
  if (!host || host.length > 253 || !DOMAIN_RE.test(host)) {
    throw httpErr(400, 'domain must be a bare hostname, e.g. example.com');
  }

  const list = Array.isArray(flags) ? flags : [];
  const seen = new Set();
  for (const flag of list) {
    if (!spec.flags.includes(flag)) throw httpErr(400, `unsupported flag for ${command}: ${flag}`);
    if (seen.has(flag)) throw httpErr(400, `duplicate flag: ${flag}`);
    seen.add(flag);
  }

  // Onboard is the only command that must NOT already have a checkout; every
  // other command operates on an existing one. bootstrap-domain.sh enforces
  // this too (exits 2 and points at repair), but failing here means the
  // operator finds out immediately instead of a minute later in a job log.
  const exists = fs.existsSync(path.join(root, 'sites', host));
  if (command === 'add' && exists) {
    throw httpErr(409, `sites/${host} already exists — use Repair or Status instead`);
  }
  if (command !== 'add' && command !== 'status' && command !== 'bootstrap' && !exists) {
    throw httpErr(404, `sites/${host} does not exist — use Onboard first`);
  }

  return { command, domain: host, flags: [...seen] };
}

function enqueue(root, req) {
  const { command, domain, flags } = validate(root, req);

  // One job per domain at a time. Two concurrent runs against the same zone
  // (a repair racing a remove, say) is the one way this queue could do real
  // damage, and it costs nothing to refuse.
  const live = listJobs(root).find(j => j.domain === domain && LIVE.has(j.status));
  if (live) throw httpErr(409, `a ${live.command} job for ${domain} is already ${live.status}`);

  const dir = spoolDir(root);
  fs.mkdirSync(dir, { recursive: true });

  const job = {
    id: newId(),
    command,
    domain,
    flags,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
  };

  // Write-then-rename: the runner polls this directory continuously and must
  // never observe a half-written record.
  const tmp = path.join(dir, `.new-${job.id}`);
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, jobPath(root, job.id));
  return job;
}

// Cancel is queued-only by design: once the CLI is mid-flight, killing it
// would leave the domain half-built with no record of where it stopped.
// Recover from that with Status/Repair, not by nuking the process.
function cancel(root, id) {
  if (!isJobId(id)) throw httpErr(400, 'invalid job id');
  const job = readJob(root, id);
  if (!job) throw httpErr(404, 'unknown job');
  if (job.status !== 'queued') {
    throw httpErr(409, `job is ${job.status} — only queued jobs can be cancelled`);
  }
  const next = {
    ...job,
    status: 'cancelled',
    finishedAt: new Date().toISOString(),
    error: 'cancelled from the dashboard',
  };
  const tmp = path.join(spoolDir(root), `.cancel-${id}`);
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, jobPath(root, id));
  return next;
}

// Everything the Domains tab needs in one round-trip: what's checked out
// locally, what's in flight, and whether the runner is actually running.
function overview(root, sites) {
  return {
    sites: sites.map(slug => ({ slug, onboarded: true })),
    jobs: listJobs(root),
    runner: runner(root),
    commands: commands(),
  };
}

module.exports = {
  COMMANDS,
  DOMAIN_RE,
  overview,
  listJobs,
  jobLog,
  enqueue,
  cancel,
  runner,
  commands,
  validate,
  spoolDir,
  isJobId,
};
