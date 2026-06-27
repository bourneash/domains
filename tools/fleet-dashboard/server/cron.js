'use strict';

// Cron control plane — the schedule-editing layer folded in from the
// standalone cron-manager tool (tools/cron-manager, retired 2026-06-27).
//
// Where Domain Control / the agent pages operate at the ROLE level (pause /
// resume / run a worker role), this module operates at the CRONTAB-LINE level:
// list every cron entry of every site + tool, edit a line's schedule,
// comment / uncomment / remove a line, diff the on-disk crontab against the
// version baked into the running container, revert to it, and rebuild +
// restart the cron container with post-start verification.
//
// The routes in server.js are thin wrappers over the functions here.

const fs = require('node:fs');
const path = require('node:path');
const cronstrue = require('cronstrue');

const { discoverSystems } = require('./cron/discovery');
const {
  inspectContainer, confirmHealthy, containerLogs, containerCreatedAt,
  containerCrontab, rebuildCron,
} = require('./cron/docker');
const { readLastRuns, resolveLogPath, tailFile } = require('./cron/runinfo');
const parse = require('./cron/parse');

// Last streamed rebuild output, per slug — so the log viewer can show it on
// demand instead of force-opening a panel during the rebuild.
const lastRebuildLog = new Map();

// Per-slug write lock for crontab edits. Prevents two concurrent edits from
// both passing the stale-line check and silently overwriting each other.
const crontabLocks = new Map();
function withCrontabLock(slug, fn) {
  const prev = crontabLocks.get(slug) ?? Promise.resolve();
  let release;
  const gate = new Promise((r) => { release = r; });
  crontabLocks.set(slug, gate);
  return prev.then(() => fn()).finally(release);
}

function httpErr(message, status) { const e = new Error(message); e.httpStatus = status; return e; }

function describeExpr(expr) {
  try { return cronstrue.toString(expr, { use24HourTimeFormat: false }); }
  catch { return expr; }
}

// Validate + translate a cron expression for the inline editor's live feedback.
function validateAndDescribe(expr) {
  const e = String(expr || '').trim();
  if (!parse.isValidCron(e)) {
    return { valid: false, human: '', error: 'Need 5 fields: minute hour day-of-month month day-of-week' };
  }
  try { return { valid: true, human: cronstrue.toString(e, { use24HourTimeFormat: false }), error: null }; }
  catch (err) { return { valid: false, human: '', error: err.message || 'invalid expression' }; }
}

function findSystem(root, slug) {
  return discoverSystems(root).find((s) => s.slug === slug) || null;
}
function requireSystem(root, slug) {
  const sys = findSystem(root, slug);
  if (!sys) throw httpErr('unknown system', 404);
  return sys;
}

function fileMtime(p) {
  try { return fs.statSync(p).mtime; } catch { return null; }
}

// List every cron system with honest container health, per-job last-run facts,
// needs-rebuild (dirty) detection, and available log sources.
async function systems(root) {
  const out = discoverSystems(root);
  for (const s of out) {
    const i = await inspectContainer(s.container);
    s.status = i.state;           // real docker state, badge driver
    s.statusText = i.raw;         // "Up 3 hours" / "Exited (127) 2 min ago"
    s.exitCode = i.exitCode;
    s.failed = i.failed;          // true → red badge, surfaces failed starts

    // Dirty detection: crontab edited after the container was last built/created.
    s.needsRebuild = false;
    if (i.state !== 'never-built') {
      const created = await containerCreatedAt(s.container);
      const mtime = fileMtime(s.crontabPath);
      if (created && mtime && mtime > created) s.needsRebuild = true;
    }

    const lr = readLastRuns(s.opsDir);
    const sources = [{ id: 'container', label: 'Container' }];
    if (lastRebuildLog.has(s.slug)) sources.push({ id: 'rebuild', label: 'Last rebuild' });
    s.entries = s.entries.map((e) => {
      const rec = e.role ? lr[e.role] : null;
      const hasLog = Boolean(rec && resolveLogPath(root, s.slug, rec.log));
      if (hasLog && !sources.some((x) => x.id === `role:${e.role}`)) {
        sources.push({ id: `role:${e.role}`, label: e.role });
      }
      return {
        ...e,
        human: describeExpr(e.schedule),
        lastRun: rec?.at || null,
        lastExit: rec && typeof rec.exit === 'number' ? rec.exit : null,
        hasLog,
      };
    });
    s.logSources = sources;
  }
  return out;
}

// Tail logs from a chosen source: container | rebuild | role:<role>.
async function logs(root, slug, source, tailN) {
  const sys = requireSystem(root, slug);
  const tail = Math.min(parseInt(tailN, 10) || 400, 2000);
  const src = String(source || 'container');
  if (src === 'container') return containerLogs(sys.container, undefined, tail);
  if (src === 'rebuild') return lastRebuildLog.get(sys.slug) || '(no rebuild has run in this session yet)';
  if (src.startsWith('role:')) {
    const role = src.slice(5);
    if (!/^[A-Za-z0-9._-]+$/.test(role)) throw httpErr('bad role', 400);
    const rec = readLastRuns(sys.opsDir)[role];
    const p = rec && resolveLogPath(root, sys.slug, rec.log);
    return p ? tailFile(p, tail) : '(no log file recorded for this role)';
  }
  throw httpErr('unknown log source', 400);
}

// Instant enable/disable for run-worker.sh roles (flag file).
function jobFlag(root, slug, role, action) {
  const sys = requireSystem(root, slug);
  if (!sys.opsDir) throw httpErr('tool jobs have no role flags; use crontab comment', 400);
  if (!/^[A-Za-z0-9._-]+$/.test(role)) throw httpErr('bad role', 400);
  const flag = path.join(sys.opsDir, `.${role}-disabled`);
  if (action === 'disable') fs.writeFileSync(flag, '');
  else if (action === 'enable') { if (fs.existsSync(flag)) fs.unlinkSync(flag); }
  else throw httpErr('bad action', 400);
  return { ok: true };
}

// Manually trigger a role job by exec-ing into the running container. Streams
// output to res; final line is @@RUN_EXIT <code>.
async function runJob(root, slug, role, res) {
  const sys = requireSystem(root, slug);
  if (!sys.opsDir) throw httpErr('tool systems do not support manual run', 400);
  if (!/^[A-Za-z0-9._-]+$/.test(role)) throw httpErr('bad role', 400);
  const health = await inspectContainer(sys.container);
  if (!health.ok) throw httpErr(`container is not running (${health.state})`, 409);

  const { spawn } = require('node:child_process');
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  // Mirror the crontab invocation: `bash ops/scripts/run-worker.sh <role>` from
  // /work. Passing args as an array avoids any shell injection.
  const child = spawn('docker', ['exec', '-w', '/work', sys.container, 'bash', 'ops/scripts/run-worker.sh', role]);
  child.stdout.on('data', (d) => res.write(d.toString()));
  child.stderr.on('data', (d) => res.write(d.toString()));
  child.on('close', (code) => { res.write(`\n@@RUN_EXIT ${code ?? -1}\n`); res.end(); });
  child.on('error', (e) => { res.write(`spawn error: ${e.message}\n@@RUN_EXIT -1\n`); res.end(); });
}

// File-mutating actions: comment/uncomment/edit/remove. Marks pending rebuild.
// Serialised per slug so concurrent edits can't both pass the stale-line check
// and silently overwrite each other.
async function crontabMutate(root, slug, body) {
  const sys = requireSystem(root, slug);
  const { action, lineIndex, newSchedule, expectedRawLine } = body || {};
  await withCrontabLock(sys.slug, async () => {
    const text = fs.readFileSync(sys.crontabPath, 'utf8');
    let out;
    if (action === 'comment') out = parse.commentLine(text, lineIndex, expectedRawLine);
    else if (action === 'uncomment') out = parse.uncommentLine(text, lineIndex, expectedRawLine);
    else if (action === 'edit') out = parse.editSchedule(text, lineIndex, newSchedule, expectedRawLine);
    else if (action === 'remove') out = parse.removeLine(text, lineIndex, expectedRawLine);
    else throw httpErr('bad action', 400);
    fs.writeFileSync(sys.crontabPath, out);
  }).catch((e) => {
    if (e.code === 'STALE') throw httpErr(e.message, 409);
    if (!e.httpStatus) e.httpStatus = 400;
    throw e;
  });
  return { ok: true, pendingRebuild: true };
}

// Return the disk crontab and the version baked into the running container so
// the client can diff them. `running` is null when the container is not up.
async function diff(root, slug) {
  const sys = requireSystem(root, slug);
  let disk;
  try { disk = fs.readFileSync(sys.crontabPath, 'utf8'); }
  catch (e) { throw httpErr(e.message, 500); }
  const running = await containerCrontab(sys.container);
  return { disk, running };
}

// Revert: overwrite the disk crontab with what's baked in the running
// container, then backdate the file mtime to just before the container was
// created so needsRebuild clears immediately on the next poll.
async function revert(root, slug) {
  const sys = requireSystem(root, slug);
  const running = await containerCrontab(sys.container);
  // Guard against null (exec failed) AND empty string (exec succeeded but
  // returned no content — both would wipe the disk file).
  if (running === null) throw httpErr('container is not running — cannot read baked crontab', 409);
  if (!running.trim()) throw httpErr('baked crontab is empty — refusing to overwrite disk file', 409);
  try {
    fs.writeFileSync(sys.crontabPath, running);
    const created = await containerCreatedAt(sys.container);
    if (created) {
      const t = (created.getTime() - 1000) / 1000;
      fs.utimesSync(sys.crontabPath, t, t);
    }
  } catch (e) { throw httpErr(e.message, 500); }
  return { ok: true };
}

// Rebuild + restart this system's cron container; stream output to res,
// capture it, and emit a machine-readable final verdict line.
async function rebuild(root, slug, res) {
  const sys = requireSystem(root, slug);
  const cwd = sys.kind === 'site' ? path.join(sys.opsDir, '..') : path.dirname(sys.crontabPath);
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  let buf = '';
  const emit = (d) => { buf += d; res.write(d); };
  const result = await rebuildCron(cwd, emit);
  emit(`\n[exit ${result.code}] compose ${result.ok ? 'OK' : 'FAILED'}\n`);
  emit(`Verifying ${sys.container} actually started…\n`);
  const health = await confirmHealthy(sys.container);
  if (health.ok) {
    emit(`OK — ${sys.container} is running (${health.raw}).\n`);
  } else {
    emit(`FAILED — ${sys.container} did NOT come up — state="${health.state}"`
      + `${health.exitCode != null ? ` exit=${health.exitCode}` : ''} (${health.raw || 'no status'}).\n`);
  }
  emit(`@@VERDICT ${health.ok ? 'ok' : 'fail'} ${sys.container}\n`);
  lastRebuildLog.set(sys.slug, buf);
  res.end();
}

module.exports = {
  validateAndDescribe, systems, logs, jobFlag, runJob,
  crontabMutate, diff, revert, rebuild, findSystem,
};
