'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const ACTIVE = new Map();

// The fleet worker image has a project-scoped Codex credential, while Claude
// intentionally has no shared OAuth credential in the dashboard container.
// Keep the worker default explicit and auditable; Claude can still be selected
// deliberately when a separately authenticated worker is configured.
const SUPPORTED_PROVIDERS = new Set(['claude', 'chatgpt', 'local']);

function defaultProvider() {
  const requested = String(process.env.FD_CHANGE_QUEUE_PROVIDER || 'chatgpt').trim();
  return SUPPORTED_PROVIDERS.has(requested) ? requested : 'chatgpt';
}

function defaultModel(provider = defaultProvider()) {
  if (provider === 'chatgpt')
    return String(process.env.FD_CHANGE_QUEUE_MODEL || 'gpt-5.6-luna').trim() || null;
  if (provider === 'local')
    return String(process.env.FD_CHANGE_QUEUE_LOCAL_MODEL || 'llama3.2').trim() || null;
  return null;
}

function resolveWorkerProvider({ provider, model } = {}) {
  const requested = String(provider || defaultProvider()).trim();
  if (!SUPPORTED_PROVIDERS.has(requested))
    return {
      provider: defaultProvider(),
      model: model || defaultModel(defaultProvider()),
      fallback: true,
    };
  // Do not send work to a Claude CLI which is present but cannot authenticate.
  // The dashboard deliberately does not mount the host Claude OAuth session.
  if (requested === 'claude' && process.env.FD_CHANGE_QUEUE_ALLOW_CLAUDE !== '1') {
    const fallbackProvider = defaultProvider() === 'claude' ? 'chatgpt' : defaultProvider();
    return {
      provider: fallbackProvider,
      model: defaultModel(fallbackProvider),
      fallback: true,
      reason: 'claude worker auth is disabled in the fleet dashboard',
    };
  }
  return { provider: requested, model: model || defaultModel(requested), fallback: false };
}

function logPath(root, runId) {
  return path.join(root, 'tools', 'fleet-dashboard', 'data', 'improvement-agents', `${runId}.log`);
}

function providerExecutable(provider) {
  if (provider === 'chatgpt')
    return (process.env.FD_CHANGE_QUEUE_CHATGPT_COMMAND || 'codex').trim().split(/\s+/)[0];
  if (provider === 'local')
    return (process.env.FD_CHANGE_QUEUE_LOCAL_COMMAND || 'ollama').trim().split(/\s+/)[0];
  return 'claude';
}

function preflight({ run, provider = 'claude', model = null }) {
  if (!run?.sandbox?.container && !run?.sandbox?.instance)
    throw httpErr(409, 'sandbox is required for provider preflight');
  const container = run.sandbox.container || `dd-${run.sandbox.instance}`;
  const executable = providerExecutable(provider);
  if (!/^[A-Za-z0-9._/-]+$/.test(executable))
    return Promise.reject(
      httpErr(400, 'provider command must be a single executable name or path')
    );
  return new Promise(resolve => {
    execFile(
      'docker',
      ['exec', container, 'sh', '-lc', `command -v ${executable}`],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          return resolve({
            ok: false,
            provider,
            executable,
            model: model || null,
            error: `provider executable "${executable}" is unavailable in ${container}: ${(stderr || error.message).trim()}`,
          });
        resolve({
          ok: true,
          provider,
          executable,
          model: model || null,
          path: String(stdout || '').trim(),
        });
      }
    );
  });
}

function reviewResult(text) {
  const matches = [...String(text || '').matchAll(/FD_REVIEW_RESULT\s*:\s*(PASS|FAIL)/gi)];
  const match = matches.at(-1);
  return {
    approved: Boolean(match && match[1].toUpperCase() === 'PASS'),
    marker: match ? match[1].toUpperCase() : null,
  };
}

function appendOutput(output, chunk) {
  if (!output || output.destroyed || output.writableEnded) return false;
  output.write(chunk);
  return true;
}

function launch({
  root,
  store,
  run,
  taskBody,
  provider = 'claude',
  model = null,
  maxTurns = 20,
  role = null,
  phase = 'implementation',
  onFinished = null,
}) {
  if (run.state !== 'building') throw httpErr(409, 'agent can only run while building');
  if (!run.workspace_path || !run.sandbox?.instance)
    throw httpErr(409, 'start the isolated sandbox first');
  if (ACTIVE.has(run.run_id)) throw httpErr(409, 'agent is already running');
  const file = logPath(root, run.run_id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const output = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
  // Providers can emit buffered output while the child is closing. Guard and
  // detach log listeners so shutdown/restart cannot crash the dashboard with
  // ERR_STREAM_WRITE_AFTER_END.
  output.on('error', () => {});
  const turns = Math.max(1, Math.min(Number(maxTurns) || 20, 200));
  const selectedRole = role || run.agent?.assigned_role || 'engineer';
  const prompt =
    phase === 'reviewer'
      ? `You are the automated release reviewer for a site improvement in an isolated git worktree.\n\n` +
        `Read and obey AGENTS.md and CLAUDE.md in the workspace. Review the requested change and the actual diff. ` +
        `If the worktree is dirty, inspect git diff; if it is clean, inspect the improvement commit with git diff HEAD^ HEAD. ` +
        `Run focused checks when useful. Do not edit files, commit, push, deploy, switch branches, or modify ops/tasks. ` +
        `Check that the request is actually satisfied, that site instructions are respected, and that the change is safe to ship. ` +
        `You must finish with exactly one marker: FD_REVIEW_RESULT: PASS or FD_REVIEW_RESULT: FAIL. ` +
        `If failing, briefly explain the blocking issue before the marker.\n\nRequest:\n${String(taskBody || run.title).slice(0, 30000)}`
      : `You are implementing one approved site improvement in an isolated git worktree.\n\n` +
        `Read and obey AGENTS.md and CLAUDE.md in the workspace before editing. Work only in the current workspace. ` +
        `Do not deploy, push, or switch branches. Do not modify files outside the workspace. Do not modify ops/tasks unless the request explicitly requires ` +
        `a task, assignment, or queue metadata change; when it does, edit the existing task in place and record rollback metadata. Implement the task, run focused checks, ` +
        `and leave all changes uncommitted for dashboard review. You are acting as the ${selectedRole} role.\n\nTask:\n${String(taskBody || run.title).slice(0, 30000)}`;
  const container = run.sandbox.container || `dd-${run.sandbox.instance}`;
  const selectedModel = model ? String(model) : '';
  let command;
  if (provider === 'chatgpt') {
    command = [
      process.env.FD_CHANGE_QUEUE_CHATGPT_COMMAND || 'codex',
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      ...(selectedModel ? ['--model', selectedModel] : []),
      prompt,
    ];
  } else if (provider === 'local') {
    command = [
      process.env.FD_CHANGE_QUEUE_LOCAL_COMMAND || 'ollama',
      'run',
      selectedModel || process.env.FD_CHANGE_QUEUE_LOCAL_MODEL || 'llama3.2',
      prompt,
    ];
  } else {
    command = [
      'claude',
      '--print',
      '--dangerously-skip-permissions',
      '--max-turns',
      String(turns),
      ...(selectedModel ? ['--model', selectedModel] : []),
      prompt,
    ];
  }
  const child = spawn('docker', ['exec', container, ...command], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const writeStdout = chunk => appendOutput(output, chunk);
  const writeStderr = chunk => appendOutput(output, chunk);
  child.stdout.on('data', writeStdout);
  child.stderr.on('data', writeStderr);
  const startedAt = new Date().toISOString();
  let timedOut = false;
  const timeout = setTimeout(
    () => {
      timedOut = true;
      child.kill('SIGTERM');
    },
    45 * 60 * 1000
  );
  if (timeout.unref) timeout.unref();
  store.updateImprovement(run.run_id, {
    agent: {
      status: 'running',
      phase,
      provider,
      model: selectedModel || null,
      max_turns: turns,
      assigned_role: selectedRole,
      started_at: startedAt,
      log: file,
    },
  });
  store.record({
    event_type: 'improvement.agent_started',
    source: 'improvement-workbench',
    site_id: `site:${run.site}`,
    entity_type: 'improvement',
    entity_id: run.run_id,
    correlation_id: run.correlation_id,
    payload: { instance: run.sandbox.instance },
  });
  ACTIVE.set(run.run_id, child);
  child.on('close', code => {
    clearTimeout(timeout);
    ACTIVE.delete(run.run_id);
    child.stdout.removeListener('data', writeStdout);
    child.stderr.removeListener('data', writeStderr);
    output.end();
    const finishedAt = new Date().toISOString();
    try {
      let result = null;
      try {
        result = phase === 'reviewer' ? reviewResult(fs.readFileSync(file, 'utf8')) : null;
      } catch {
        result = null;
      }
      store.updateImprovement(run.run_id, {
        agent: {
          status: timedOut ? 'timed-out' : code === 0 ? 'completed' : 'failed',
          phase,
          started_at: startedAt,
          finished_at: finishedAt,
          exit_code: code,
          log: file,
        },
      });
      // Dashboard-submitted requests become reviewable as soon as the agent
      // exits. The operator still has to inspect the diff and run validation;
      // this only removes the ambiguous "running" state from the queue.
      if (run.source === 'fleet-dashboard' && run.source_id) {
        const nextStatus = timedOut || code !== 0 ? 'failed' : 'review';
        const request = store.getChangeRequest(run.source_id);
        if (request && request.status === 'running') {
          store.updateChangeRequest(run.source_id, {
            status: nextStatus,
            error: nextStatus === 'failed' ? `agent exited with code ${code}` : null,
            lease_owner: null,
            lease_expires_at: null,
            heartbeat_at: null,
          });
          store.record({
            event_type: `change-request.${nextStatus}`,
            source: 'fleet-dashboard',
            site_id: `site:${run.site}`,
            entity_type: 'change-request',
            entity_id: run.source_id,
            correlation_id: `change-request:${run.source_id}`,
            payload: { run_id: run.run_id, exit_code: code },
          });
        }
      }
      store.record({
        event_type: 'improvement.agent_finished',
        source: 'improvement-workbench',
        site_id: `site:${run.site}`,
        entity_type: 'improvement',
        entity_id: run.run_id,
        correlation_id: run.correlation_id,
        payload: { exit_code: code },
      });
      if (typeof onFinished === 'function') onFinished({ code, timedOut, result, log: file });
    } catch {
      /* server shutdown or store unavailable */
    }
  });
  child.on('error', error => appendOutput(output, `\n${error.message}\n`));
  return { status: 'running', started_at: startedAt };
}

function start(options) {
  return launch(options);
}

function startReview(options) {
  return launch({ ...options, phase: 'reviewer', role: options.role || 'reviewer' });
}

function status(root, run) {
  let log = '';
  try {
    const text = fs.readFileSync(logPath(root, run.run_id), 'utf8');
    log = text.slice(-12000);
  } catch {
    /* no output yet */
  }
  const running = ACTIVE.has(run.run_id);
  const saved = run.agent || {};
  return {
    ...saved,
    status: saved.status === 'running' && !running ? 'interrupted' : saved.status,
    running,
    log_tail: log,
  };
}

function httpErr(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

module.exports = {
  start,
  startReview,
  status,
  logPath,
  preflight,
  providerExecutable,
  reviewResult,
  appendOutput,
  defaultProvider,
  defaultModel,
  resolveWorkerProvider,
};
