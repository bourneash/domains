'use strict';

// Docker interaction for the cron control plane: honest container health,
// post-rebuild verification, log/crontab reads, and the build+restart stream.
// Ported verbatim from tools/cron-manager (server/docker.js).

const { exec } = require('node:child_process');
const { promisify } = require('node:util');
const execP = promisify(exec);

function defaultRunner(cmd) {
  return execP(cmd, { timeout: 10000 });
}

// Guard against shell injection from untrusted container names. Discovery
// already sanitises via regex, but this makes each shell-facing function
// self-defending against any future path that skips discovery.
function assertContainerName(name) {
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`unsafe container name: ${String(name)}`);
  }
}

// Honest container health. Returns the REAL docker state, not a running/stopped
// binary — a container stuck in `created` (failed start) or crash-looping in
// `restarting` used to render identically to a deliberately stopped one.
//
// Returns: { state, raw, exitCode, ok, failed }
async function inspectContainer(container, runner = defaultRunner) {
  try {
    assertContainerName(container);
    const { stdout } = await runner(
      `docker ps -a --filter name=^/${container}$ --format "{{.State}}\t{{.Status}}"`
    );
    const line = stdout.trim();
    if (!line) return { state: 'never-built', raw: '', exitCode: null, ok: false, failed: false };
    const tab = line.indexOf('\t');
    const state = (tab === -1 ? line : line.slice(0, tab)).trim();
    const raw = (tab === -1 ? '' : line.slice(tab + 1)).trim();
    const m = raw.match(/\((\d+)\)/); // "Exited (127) ..." / "Restarting (1) ..."
    const exitCode = m ? parseInt(m[1], 10) : null;
    const ok = state === 'running';
    const failed =
      state === 'created' ||
      state === 'dead' ||
      state === 'restarting' ||
      (state === 'exited' && exitCode !== null && exitCode !== 0);
    return { state, raw, exitCode, ok, failed };
  } catch {
    return {
      state: 'unknown',
      raw: 'docker unreachable',
      exitCode: null,
      ok: false,
      failed: false,
    };
  }
}

// Post-rebuild verification. Poll the container until it is actually running,
// or until it lands in a terminal failed state, or until tries run out.
async function confirmHealthy(container, runner = defaultRunner, opts = {}) {
  const tries = opts.tries ?? 6;
  const delayMs = opts.delayMs ?? 1500;
  const sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  let last;
  for (let i = 0; i < tries; i++) {
    last = await inspectContainer(container, runner);
    if (last.ok) return { ...last, ok: true };
    if (last.failed) return { ...last, ok: false };
    if (i < tries - 1) await sleep(delayMs);
  }
  return { ...last, ok: false };
}

// When the running container was last (re)created. Used to detect a stale
// crontab: if crontab.docker on disk is newer than this, the baked-in copy is
// out of date and a rebuild is needed. Returns a Date or null.
async function containerCreatedAt(container, runner = defaultRunner) {
  try {
    assertContainerName(container);
    const { stdout } = await runner(`docker inspect -f "{{.Created}}" ${container}`);
    const t = stdout.trim();
    if (!t) return null;
    const d = new Date(t);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

// Tail a container's logs — merges stdout+stderr. Never throws.
async function containerLogs(container, runner = defaultRunner, tail = 200) {
  try {
    assertContainerName(container);
    const { stdout } = await runner(`docker logs --tail ${tail} ${container} 2>&1`);
    return stdout.trim() || '(no log output)';
  } catch (e) {
    return `error fetching logs: ${e.message}`;
  }
}

// Rebuild + restart a system's cron container. Streams output via onData.
// Resolves { ok, code }. Never rejects on non-zero exit. A 10-minute hard
// timeout prevents a stalled build from holding the HTTP response open.
//
// NOTE ON `docker compose build` — do not put it back.
// Site cron services now reference the SHARED image
// (`image: fleet-site-cron:latest`, tools/fleet-images) and carry no `build:`
// stanza. `docker compose build cron` against such a service is a NO-OP THAT
// EXITS 0, so the old command reported a successful rebuild while building
// nothing at all — the operator would click Rebuild, see green, and get the
// same image back.
//
// What "rebuild" means under shared images is: recreate this container from
// the CURRENT shared image. `up -d --force-recreate` does exactly that.
// `restart` would NOT — it reuses the container's creation-time image, which
// is the stale-image drift the shared-image migration exists to remove.
//
// To actually rebuild the shared image itself (all sites at once):
//     tools/fleet-images/bin/fleet-image-build cron --roll
function rebuildCron(cwd, onData, opts = {}) {
  const { spawn } = require('node:child_process');
  const timeoutMs = opts.timeoutMs ?? 600_000;
  return new Promise(resolve => {
    const child = spawn(
      'bash',
      [
        '-lc',
        'echo "[fleet] recreating cron from the current shared image (fleet-site-cron:latest)"; ' +
          'echo "[fleet] to rebuild the image itself: tools/fleet-images/bin/fleet-image-build cron --roll"; ' +
          'docker compose up -d --force-recreate cron',
      ],
      { cwd }
    );
    let settled = false;
    function settle(result) {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    }

    const timer = setTimeout(() => {
      onData('\n[timeout: build exceeded 10 minutes — killing]\n');
      child.kill('SIGTERM');
      settle({ ok: false, code: -2 });
    }, timeoutMs);

    child.stdout.on('data', d => onData(d.toString()));
    child.stderr.on('data', d => onData(d.toString()));
    child.on('close', code => {
      clearTimeout(timer);
      settle({ ok: code === 0, code });
    });
    child.on('error', e => {
      clearTimeout(timer);
      onData(`spawn error: ${e.message}\n`);
      settle({ ok: false, code: -1 });
    });
  });
}

// Read the crontab baked into the running container. Returns the text, or null
// if the container is not running or the exec fails. All containers in this
// portfolio bake the crontab at /etc/crontab.docker.
async function containerCrontab(container, runner = defaultRunner) {
  try {
    assertContainerName(container);
    const { stdout } = await runner(`docker exec ${container} cat /etc/crontab.docker`);
    return stdout;
  } catch {
    return null;
  }
}

module.exports = {
  inspectContainer,
  confirmHealthy,
  containerLogs,
  containerCreatedAt,
  containerCrontab,
  rebuildCron,
};
