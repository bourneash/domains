'use strict';

const { exec } = require('node:child_process');
const { promisify } = require('node:util');
const execP = promisify(exec);

function defaultRunner(cmd) {
  return execP(cmd, { timeout: 10000 });
}

// Honest container health (A1). Returns the REAL docker state, not a
// running/stopped binary — a container stuck in `created` (failed start) or
// crash-looping in `restarting` used to render identically to a deliberately
// stopped one, which is how 5 failed rebuilds stayed invisible.
//
// Returns: { state, raw, exitCode, ok, failed }
//   state    'running'|'created'|'exited'|'restarting'|'paused'|'dead'
//            |'never-built'|'unknown'
//   raw      the human ".Status" string ("Up 3 hours", "Exited (127) ...")
//   exitCode parsed exit code when present, else null
//   ok       true only when actually running
//   failed   true for states that should NOT persist (start failed, crash
//            loop, dead, or non-zero exit) — these get a red badge in the UI
async function inspectContainer(container, runner = defaultRunner) {
  try {
    const { stdout } = await runner(
      `docker ps -a --filter name=^/${container}$ --format "{{.State}}\t{{.Status}}"`
    );
    const line = stdout.trim();
    if (!line) return { state: 'never-built', raw: '', exitCode: null, ok: false, failed: false };
    const tab = line.indexOf('\t');
    const state = (tab === -1 ? line : line.slice(0, tab)).trim();
    const raw = (tab === -1 ? '' : line.slice(tab + 1)).trim();
    const m = raw.match(/\((\d+)\)/);                  // "Exited (127) ..." / "Restarting (1) ..."
    const exitCode = m ? parseInt(m[1], 10) : null;
    const ok = state === 'running';
    const failed = state === 'created' || state === 'dead' || state === 'restarting'
      || (state === 'exited' && exitCode !== null && exitCode !== 0);
    return { state, raw, exitCode, ok, failed };
  } catch {
    return { state: 'unknown', raw: 'docker unreachable', exitCode: null, ok: false, failed: false };
  }
}

// Back-compat string view. Kept so any caller expecting the old tri-state
// keeps working; new code should use inspectContainer.
// Returns "running" | "stopped" | "never-built".
async function containerStatus(container, runner = defaultRunner) {
  const i = await inspectContainer(container, runner);
  if (i.state === 'never-built' || i.state === 'unknown') return 'never-built';
  return i.state === 'running' ? 'running' : 'stopped';
}

// Post-rebuild verification (A2). Poll the container until it is actually
// running, or until it lands in a terminal failed state, or until tries run
// out. `up -d` exiting 0 does NOT mean the container survived init — this is
// what confirms it did. Resolves the final inspect result plus { ok }.
async function confirmHealthy(container, runner = defaultRunner, opts = {}) {
  const tries = opts.tries ?? 6;
  const delayMs = opts.delayMs ?? 1500;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last;
  for (let i = 0; i < tries; i++) {
    last = await inspectContainer(container, runner);
    if (last.ok) return { ...last, ok: true };
    if (last.failed) return { ...last, ok: false };
    if (i < tries - 1) await sleep(delayMs);
  }
  return { ...last, ok: false };
}

// Tail a container's logs (A4) — merges stdout+stderr (docker logs writes to
// both). Never throws; returns a readable message on error.
async function containerLogs(container, runner = defaultRunner, tail = 200) {
  try {
    const { stdout, stderr } = await runner(`docker logs --tail ${tail} ${container} 2>&1`);
    return (stdout || stderr || '').trim() || '(no log output)';
  } catch (e) {
    return `error fetching logs: ${e.message}`;
  }
}

// Rebuild + restart a system's cron container. Streams output via onData.
// Resolves { ok, code }. Never rejects on non-zero exit.
function rebuildCron(cwd, onData) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', 'docker compose build cron && docker compose up -d cron'],
      { cwd });
    child.stdout.on('data', (d) => onData(d.toString()));
    child.stderr.on('data', (d) => onData(d.toString()));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
    child.on('error', (e) => { onData(`spawn error: ${e.message}\n`); resolve({ ok: false, code: -1 }); });
  });
}

module.exports = { containerStatus, inspectContainer, confirmHealthy, containerLogs, rebuildCron };
