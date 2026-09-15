'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ACTIVE = new Map();

function logPath(root, runId) {
  return path.join(root, 'tools', 'fleet-dashboard', 'data', 'improvement-agents', `${runId}.log`);
}

function start({ root, store, run, taskBody }) {
  if (run.state !== 'building') throw httpErr(409, 'agent can only run while building');
  if (!run.workspace_path || !run.sandbox?.instance) throw httpErr(409, 'start the isolated sandbox first');
  if (ACTIVE.has(run.run_id)) throw httpErr(409, 'agent is already running');
  const file = logPath(root, run.run_id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const output = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
  const prompt = `You are implementing one approved site improvement in an isolated git worktree.\n\n` +
    `Read and obey AGENTS.md and CLAUDE.md in the workspace before editing. Work only in the current workspace. ` +
    `Do not deploy, push, switch branches, modify ops/tasks, or modify files outside it. Implement the task, run focused checks, ` +
    `and leave all changes uncommitted for dashboard review.\n\nTask:\n${String(taskBody || run.title).slice(0, 30000)}`;
  const child = spawn('docker', ['exec', run.sandbox.container || `dd-${run.sandbox.instance}`,
    'claude', '--print', '--dangerously-skip-permissions', prompt],
  { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(output); child.stderr.pipe(output);
  const startedAt = new Date().toISOString();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 45 * 60 * 1000);
  if (timeout.unref) timeout.unref();
  store.updateImprovement(run.run_id, { agent: { status: 'running', started_at: startedAt, log: file } });
  store.record({ event_type: 'improvement.agent_started', source: 'improvement-workbench',
    site_id: `site:${run.site}`, entity_type: 'improvement', entity_id: run.run_id,
    correlation_id: run.correlation_id, payload: { instance: run.sandbox.instance } });
  ACTIVE.set(run.run_id, child);
  child.on('close', code => {
    clearTimeout(timeout);
    ACTIVE.delete(run.run_id); output.end();
    const finishedAt = new Date().toISOString();
    try {
      store.updateImprovement(run.run_id, { agent: { status: timedOut ? 'timed-out' : code === 0 ? 'completed' : 'failed',
        started_at: startedAt, finished_at: finishedAt, exit_code: code, log: file } });
      store.record({ event_type: 'improvement.agent_finished', source: 'improvement-workbench',
        site_id: `site:${run.site}`, entity_type: 'improvement', entity_id: run.run_id,
        correlation_id: run.correlation_id, payload: { exit_code: code } });
    } catch { /* server shutdown or store unavailable */ }
  });
  child.on('error', error => output.write(`\n${error.message}\n`));
  return { status: 'running', started_at: startedAt };
}

function status(root, run) {
  let log = '';
  try {
    const text = fs.readFileSync(logPath(root, run.run_id), 'utf8');
    log = text.slice(-12000);
  } catch { /* no output yet */ }
  const running = ACTIVE.has(run.run_id);
  const saved = run.agent || {};
  return { ...saved, status: saved.status === 'running' && !running ? 'interrupted' : saved.status,
    running, log_tail: log };
}

function httpErr(status, message) { const e = new Error(message); e.httpStatus = status; return e; }

module.exports = { start, status, logPath };
