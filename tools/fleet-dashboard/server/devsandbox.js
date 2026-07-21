'use strict';

// Per-site sandboxed Claude dev containers — folded in from the standalone
// domain-developer tool (tools/domain-developer). A worker container runs
// ttyd → bash with claude + the dev toolchain, bind-mounting ONLY that
// site's directory at the same host path so the rest of the fleet stays
// protected. Spawned containers are SIBLINGS of this panel (created next to
// it via the shared docker.sock, not inside it).
//
// This module owns lifecycle only (start/stop/remove/stats/orphans). Auth,
// site-name validation against a known-good list, and the docker socket
// itself are already provided by the surrounding app (auth.apiGuard +
// discoverSites), so — unlike the standalone tool it replaces — there is no
// separate no-auth threat model to reason about here.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const IMAGE = 'domain-developer:latest';
const TTYD_PORT_BASE = parseInt(process.env.FD_DEVSANDBOX_PORT_BASE || '7800', 10);
const DEV_PORT_BASE = parseInt(process.env.FD_DEVSANDBOX_DEV_PORT_BASE || '7900', 10);
const DEV_PORT_IN_CONTAINER = parseInt(process.env.FD_DEVSANDBOX_DEV_PORT_IN_CONTAINER || '4321', 10);
const PUBLIC_HOST = process.env.FD_DEVSANDBOX_PUBLIC_HOST || '127.0.0.1';
// Per-container resource caps — one runaway dev-server/build in a sandbox
// shouldn't be able to starve the host or every other running container.
const MEMORY_LIMIT = process.env.FD_DEVSANDBOX_MEMORY_LIMIT || '4g';
const CPUS_LIMIT = process.env.FD_DEVSANDBOX_CPUS_LIMIT || '2';
const PIDS_LIMIT = parseInt(process.env.FD_DEVSANDBOX_PIDS_LIMIT || '512', 10);

const STATE_FILE = process.env.FD_DEVSANDBOX_STATE_FILE
  || path.join(__dirname, '..', 'data', 'devsandbox-state.json');

function httpErr(status, msg) { const e = new Error(msg); e.httpStatus = status; return e; }

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000, maxBuffer: 16 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '', err }));
  });
}
function docker(args, opts) { return sh('docker', args, opts); }

const containerName = (site) => `dd-${site}`;

// listDdContainers() matches on `dd-*`, which also catches this panel's own
// container if it were ever named that way — future-proofing the same
// exclusion the standalone tool needed after a real incident where its
// orphan-cleanup nearly `docker rm -f`'d itself.
function excludeSelf(map) { delete map['panel']; delete map['fleet-dashboard']; return map; }

async function dockerAvailable() {
  return (await docker(['version', '--format', '{{.Server.Version}}'])).code === 0;
}

async function listDdContainers() {
  const r = await docker(['ps', '-a', '--filter', 'name=^dd-', '--format', '{{.Names}}\x01{{.State}}\x01{{.Ports}}']);
  if (r.code !== 0) return {};
  const map = {};
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [name, state, ports] = line.split('\x01');
    if (!name || !name.startsWith('dd-')) continue;
    map[name.slice(3)] = { state: state || 'absent', ports: ports || '' };
  }
  return excludeSelf(map);
}

function parsePortsString(portsStr) {
  const out = {};
  if (!portsStr) return out;
  const re = /(?:\d+\.\d+\.\d+\.\d+|::):(\d+)->(\d+)\/tcp/g;
  let m;
  while ((m = re.exec(portsStr)) !== null) out[parseInt(m[2], 10)] = parseInt(m[1], 10);
  return out;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { ports: {} }; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function allocPorts(site) {
  const state = loadState();
  const existing = state.ports[site] || {};
  const usedTtyd = new Set();
  const usedDev = new Set();
  for (const p of Object.values(state.ports)) {
    if (p.ttyd) usedTtyd.add(p.ttyd);
    if (p.dev) usedDev.add(p.dev);
  }
  if (!existing.ttyd) { let p = TTYD_PORT_BASE; while (usedTtyd.has(p)) p++; existing.ttyd = p; }
  if (!existing.dev) { let p = DEV_PORT_BASE; while (usedDev.has(p)) p++; existing.dev = p; }
  state.ports[site] = existing;
  saveState(state);
  return existing;
}

async function siteRow(root, name, containerMap, statePorts) {
  const dir = path.join(root, 'sites', name);
  const hasEnv = fs.existsSync(path.join(dir, '.env'));
  const c = containerMap[name];
  const status = c ? c.state : 'absent';
  const livePorts = c ? parsePortsString(c.ports) : {};
  const sp = (statePorts || {})[name] || {};
  const ttydPort = livePorts[7681] || sp.ttyd || null;
  const devPort = livePorts[DEV_PORT_IN_CONTAINER] || sp.dev || null;
  return {
    name, hasEnv, status, ttydPort, devPort,
    ttydUrl: ttydPort ? `http://${PUBLIC_HOST}:${ttydPort}/` : null,
    devUrl: devPort ? `http://${PUBLIC_HOST}:${devPort}/` : null,
    liveUrl: `https://${name}/`,
    repoUrl: `https://github.com/bourneash/${name}`,
  };
}

async function list(root, sites) {
  const [containerMap, avail] = await Promise.all([listDdContainers(), dockerAvailable()]);
  const statePorts = loadState().ports || {};
  const rows = await Promise.all(sites.map((n) => siteRow(root, n, containerMap, statePorts)));
  return { dockerAvailable: avail, sites: rows };
}

async function inspectStatus(site) {
  const r = await docker(['inspect', '--format', '{{.State.Status}}', containerName(site)]);
  if (r.code !== 0) return { exists: false, status: 'absent' };
  return { exists: true, status: r.stdout.trim() };
}

async function start(root, site) {
  const hostSiteDir = path.join(root, 'sites', site);
  if (!fs.existsSync(hostSiteDir)) throw httpErr(404, `site dir not found: ${hostSiteDir}`);

  const cur = await inspectStatus(site);
  const ports = loadState().ports[site] || allocPorts(site);
  if (cur.status === 'running') return { started: false, ports };

  if (cur.exists) {
    const r = await docker(['start', containerName(site)]);
    if (r.code !== 0) throw httpErr(500, `docker start failed: ${r.stderr}`);
    return { started: true, ports };
  }

  const { ttyd: ttydPort, dev: devPort } = allocPorts(site);
  const hostHome = process.env.HOME || '/root';
  const hostSharedEnv = path.join(root, '.env');

  // Per-site claude project dir (same scheme the standalone tool used): the
  // site is bind-mounted at the SAME host path inside the worker so cwd
  // matches host → claude encodes the project ID identically, and that
  // encoded dir is bind-mounted RW from the host's ~/.claude/projects/ so
  // per-site memory + transcripts traverse up to the host.
  const projectId = hostSiteDir.replace(/\//g, '-');
  const hostProjectDir = path.join(hostHome, '.claude', 'projects', projectId);
  fs.mkdirSync(hostProjectDir, { recursive: true });

  const stateRoot = path.join(root, 'tools', 'domain-developer', 'state');
  const claudeStateDir = path.join(stateRoot, site, 'claude');
  const persistStateDir = path.join(stateRoot, site, 'persist');
  fs.mkdirSync(claudeStateDir, { recursive: true });
  fs.mkdirSync(persistStateDir, { recursive: true });

  const claudeRoShares = ['plugins', 'commands', 'hooks', 'skills'];
  const claudeCopyIn = ['settings.json', '.credentials.json'];

  const args = [
    'run', '-d',
    '--name', containerName(site),
    '--hostname', `dd-${site}`,
    '--restart', 'unless-stopped',
    '--stop-timeout', '30',
    '--memory', MEMORY_LIMIT,
    '--cpus', CPUS_LIMIT,
    '--pids-limit', String(PIDS_LIMIT),
    '--workdir', hostSiteDir,
    '-p', `127.0.0.1:${ttydPort}:7681`,
    '-p', `127.0.0.1:${devPort}:${DEV_PORT_IN_CONTAINER}`,
    '-v', `${hostSiteDir}:${hostSiteDir}`,
    '-v', `${claudeStateDir}:/home/dev/.claude`,
    '-v', `${hostHome}/.claude.json:/host-claude-json-ro:ro`,
    '-v', `${hostProjectDir}:/home/dev/.claude/projects/${projectId}`,
    '-v', `${hostHome}/.ssh:/home/dev/.ssh:ro`,
    '-v', `${persistStateDir}:/home/dev/persist`,
    '-e', `SITE_NAME=${site}`,
    '-e', `SITE_DIR=${hostSiteDir}`,
    '-e', `HOST_HOME=${hostHome}`,
    '-e', 'TTYD_PORT=7681',
  ];
  for (const name of claudeRoShares) {
    const src = path.join(hostHome, '.claude', name);
    if (fs.existsSync(src)) args.push('-v', `${src}:/home/dev/.claude/${name}:ro`);
  }
  for (const name of claudeCopyIn) {
    const src = path.join(hostHome, '.claude', name);
    if (fs.existsSync(src)) args.push('-v', `${src}:/host-claude-ro/${name}:ro`);
  }
  if (fs.existsSync(hostSharedEnv)) args.push('-v', `${hostSharedEnv}:${hostSiteDir}/.env.shared:ro`);
  args.push(IMAGE);

  const r = await docker(args);
  if (r.code !== 0) throw httpErr(500, `docker run failed: ${r.stderr.trim()}`);
  return { started: true, ports: { ttyd: ttydPort, dev: devPort } };
}

async function stop(site) {
  const r = await docker(['stop', containerName(site)]);
  if (r.code !== 0) throw httpErr(500, r.stderr.trim());
  return { ok: true };
}

async function remove(site) {
  await docker(['stop', containerName(site)]);
  const r = await docker(['rm', containerName(site)]);
  if (r.code !== 0) throw httpErr(500, r.stderr.trim());
  return { ok: true };
}

function parseKV(stdout) {
  const out = {};
  for (const line of stdout.split('\n')) {
    const m = line.match(/^([a-zA-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
async function devExec(site, ...args) {
  const r = await docker(['exec', containerName(site), 'dd-dev', ...args]);
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, kv: parseKV(r.stdout) };
}

async function devStatus(site) { const r = await devExec(site, 'status'); return r.kv; }
async function devStart(site) {
  const r = await devExec(site, 'start');
  if (r.code !== 0) throw httpErr(400, r.stdout || r.stderr || 'dev start failed');
  return r.kv;
}
async function devStop(site) { return (await devExec(site, 'stop')).kv; }
async function devLogs(site, n) { return (await devExec(site, 'logs', String(n || 200))).stdout || '(no logs)'; }

async function stats() {
  // `docker stats` has no --filter flag (unlike `docker ps`) — with no
  // positional args it dumps EVERY container on the host. This matters a lot
  // more in this shared panel than it did in the standalone tool: this
  // container's docker.sock sees every container on the host (~150+ across
  // unrelated projects), not just a couple of stray non-dd- ones. So resolve
  // the dd-* container names via `docker ps` first, then pass them
  // explicitly as positional args to `docker stats`.
  const names = Object.keys(await listDdContainers()).map(containerName);
  if (!names.length) return [];
  const r = await docker(['stats', '--no-stream',
    '--format', '{{.Name}}\x01{{.CPUPerc}}\x01{{.MemUsage}}\x01{{.PIDs}}', ...names]);
  if (r.code !== 0) throw httpErr(500, r.stderr.trim() || 'docker stats failed');
  return r.stdout.split('\n').filter(Boolean).map((line) => {
    const [name, cpu, mem, pids] = line.split('\x01');
    return { site: (name || '').replace(/^dd-/, ''), cpu: cpu || '', mem: mem || '', pids: pids || '' };
  }).filter((c) => c.site);
}

async function findOrphans(sites) {
  const known = new Set(sites);
  const state = loadState();
  const stalePorts = Object.keys(state.ports || {}).filter((s) => !known.has(s));
  const danglingContainers = Object.keys(await listDdContainers()).filter((s) => !known.has(s));
  return { stalePorts, danglingContainers };
}

function pruneStalePorts(stalePorts) {
  if (!stalePorts.length) return;
  const state = loadState();
  for (const s of stalePorts) delete state.ports[s];
  saveState(state);
}

async function cleanupOrphans(sites) {
  const { stalePorts, danglingContainers } = await findOrphans(sites);
  const removed = [];
  const errors = [];
  for (const site of danglingContainers) {
    const r = await docker(['rm', '-f', containerName(site)]);
    if (r.code === 0) removed.push(site);
    else errors.push({ site, error: r.stderr.trim() });
  }
  pruneStalePorts(stalePorts);
  return { ok: errors.length === 0, removedContainers: removed, prunedPorts: stalePorts, errors };
}

async function stopAll() {
  const running = Object.entries(await listDdContainers()).filter(([, c]) => c.state === 'running').map(([s]) => s);
  const stopped = [];
  const errors = [];
  for (const site of running) {
    const r = await docker(['stop', containerName(site)]);
    if (r.code === 0) stopped.push(site);
    else errors.push({ site, error: r.stderr.trim() });
  }
  return { ok: errors.length === 0, stopped, errors };
}

async function removeStopped() {
  const notRunning = Object.entries(await listDdContainers()).filter(([, c]) => c.state !== 'running').map(([s]) => s);
  const removed = [];
  const errors = [];
  for (const site of notRunning) {
    await docker(['stop', containerName(site)]);
    const r = await docker(['rm', containerName(site)]);
    if (r.code === 0) removed.push(site);
    else errors.push({ site, error: r.stderr.trim() });
  }
  return { ok: errors.length === 0, removed, errors };
}

module.exports = {
  list, start, stop, remove,
  devStatus, devStart, devStop, devLogs,
  stats, findOrphans, cleanupOrphans, stopAll, removeStopped,
};
