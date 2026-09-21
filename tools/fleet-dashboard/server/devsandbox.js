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
const DEV_PORT_IN_CONTAINER = parseInt(
  process.env.FD_DEVSANDBOX_DEV_PORT_IN_CONTAINER || '4321',
  10
);
const PUBLIC_HOST = process.env.FD_DEVSANDBOX_PUBLIC_HOST || '127.0.0.1';
// Per-container resource caps — one runaway dev-server/build in a sandbox
// shouldn't be able to starve the host or every other running container.
const MEMORY_LIMIT = process.env.FD_DEVSANDBOX_MEMORY_LIMIT || '4g';
const CPUS_LIMIT = process.env.FD_DEVSANDBOX_CPUS_LIMIT || '2';
const PIDS_LIMIT = parseInt(process.env.FD_DEVSANDBOX_PIDS_LIMIT || '512', 10);

const STATE_FILE =
  process.env.FD_DEVSANDBOX_STATE_FILE ||
  path.join(__dirname, '..', 'data', 'devsandbox-state.json');

function httpErr(status, msg) {
  const e = new Error(msg);
  e.httpStatus = status;
  return e;
}

function sh(cmd, args, opts = {}) {
  return new Promise(resolve => {
    execFile(
      cmd,
      args,
      { timeout: 20000, maxBuffer: 16 * 1024 * 1024, ...opts },
      (err, stdout, stderr) =>
        resolve({
          code: err ? (err.code ?? 1) : 0,
          stdout: stdout || '',
          stderr: stderr || '',
          err,
        })
    );
  });
}
function docker(args, opts) {
  return sh('docker', args, opts);
}

const containerName = site => `dd-${site}`;

// listDdContainers() matches on `dd-*`, which also catches this panel's own
// container if it were ever named that way — future-proofing the same
// exclusion the standalone tool needed after a real incident where its
// orphan-cleanup nearly `docker rm -f`'d itself.
function excludeSelf(map) {
  delete map['panel'];
  delete map['fleet-dashboard'];
  return map;
}

async function dockerAvailable() {
  return (await docker(['version', '--format', '{{.Server.Version}}'])).code === 0;
}

async function listDdContainers() {
  const r = await docker([
    'ps',
    '-a',
    '--filter',
    'name=^dd-',
    '--format',
    '{{.Names}}\x01{{.State}}\x01{{.Ports}}',
  ]);
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
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { ports: {} };
  }
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
  if (!existing.ttyd) {
    let p = TTYD_PORT_BASE;
    while (usedTtyd.has(p)) p++;
    existing.ttyd = p;
  }
  if (!existing.dev) {
    let p = DEV_PORT_BASE;
    while (usedDev.has(p)) p++;
    existing.dev = p;
  }
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
    name,
    hasEnv,
    status,
    ttydPort,
    devPort,
    ttydUrl: ttydPort ? `http://${PUBLIC_HOST}:${ttydPort}/` : null,
    devUrl: devPort ? `http://${PUBLIC_HOST}:${devPort}/` : null,
    liveUrl: `https://${name}/`,
    repoUrl: `https://github.com/bourneash/${name}`,
  };
}

async function list(root, sites) {
  const [containerMap, avail] = await Promise.all([listDdContainers(), dockerAvailable()]);
  const statePorts = loadState().ports || {};
  const rows = await Promise.all(sites.map(n => siteRow(root, n, containerMap, statePorts)));
  return { dockerAvailable: avail, sites: rows };
}

async function inspectStatus(site) {
  const r = await docker(['inspect', '--format', '{{.State.Status}}', containerName(site)]);
  if (r.code !== 0) return { exists: false, status: 'absent' };
  return { exists: true, status: r.stdout.trim() };
}

async function start(root, site, options = {}) {
  const instance = options.instance || site;
  if (!/^[a-z0-9][a-z0-9.-]{0,119}$/.test(instance)) throw httpErr(400, 'invalid sandbox instance');
  const canonicalSiteDir = path.join(root, 'sites', site);
  const hostSiteDir = options.workspaceDir || canonicalSiteDir;
  if (!fs.existsSync(hostSiteDir)) throw httpErr(404, `site dir not found: ${hostSiteDir}`);

  const cur = await inspectStatus(instance);
  const ports = loadState().ports[instance] || allocPorts(instance);
  if (cur.status === 'running') return { started: false, ports };

  if (cur.exists) {
    const r = await docker(['start', containerName(instance)]);
    if (r.code !== 0) throw httpErr(500, `docker start failed: ${r.stderr}`);
    return { started: true, ports };
  }

  const { ttyd: ttydPort, dev: devPort } = allocPorts(instance);
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
  const claudeStateDir = path.join(stateRoot, instance, 'claude');
  const codexStateDir = path.join(stateRoot, instance, 'codex');
  const persistStateDir = path.join(stateRoot, instance, 'persist');
  fs.mkdirSync(claudeStateDir, { recursive: true });
  fs.mkdirSync(codexStateDir, { recursive: true });
  fs.mkdirSync(persistStateDir, { recursive: true });

  const claudeRoShares = ['plugins', 'commands', 'hooks', 'skills'];
  const claudeCopyIn = ['settings.json', '.credentials.json'];

  const args = [
    'run',
    '-d',
    '--name',
    containerName(instance),
    '--hostname',
    `dd-${instance}`,
    '--restart',
    'unless-stopped',
    '--stop-timeout',
    '30',
    '--memory',
    MEMORY_LIMIT,
    '--cpus',
    CPUS_LIMIT,
    '--pids-limit',
    String(PIDS_LIMIT),
    '--workdir',
    hostSiteDir,
    '-p',
    `127.0.0.1:${ttydPort}:7681`,
    '-p',
    `127.0.0.1:${devPort}:${DEV_PORT_IN_CONTAINER}`,
    '-v',
    `${hostSiteDir}:${hostSiteDir}`,
    // A git worktree's .git file points at the canonical site's admin
    // directory. Mount that directory too, otherwise commands inside an
    // improvement worker fail with "not a git repository" even though the
    // worktree itself is mounted.
    ...(hostSiteDir !== canonicalSiteDir && fs.existsSync(path.join(canonicalSiteDir, '.git'))
      ? ['-v', `${path.join(canonicalSiteDir, '.git')}:${path.join(canonicalSiteDir, '.git')}`]
      : []),
    '-v',
    `${claudeStateDir}:/home/dev/.claude`,
    '-v',
    `${codexStateDir}:/home/dev/.codex`,
    '-v',
    `${hostHome}/.claude.json:/host-claude-json-ro:ro`,
    '-v',
    `${hostProjectDir}:/home/dev/.claude/projects/${projectId}`,
    '-v',
    `${hostHome}/.ssh:/home/dev/.ssh:ro`,
    '-v',
    `${persistStateDir}:/home/dev/persist`,
    '-e',
    `SITE_NAME=${site}`,
    '-e',
    `SITE_DIR=${hostSiteDir}`,
    '-e',
    `HOST_HOME=${hostHome}`,
    '-e',
    'TTYD_PORT=7681',
  ];
  for (const name of claudeRoShares) {
    const src = path.join(hostHome, '.claude', name);
    if (fs.existsSync(src)) args.push('-v', `${src}:/home/dev/.claude/${name}:ro`);
  }
  for (const name of claudeCopyIn) {
    const src = path.join(hostHome, '.claude', name);
    if (fs.existsSync(src)) args.push('-v', `${src}:/host-claude-ro/${name}:ro`);
  }
  for (const name of ['auth.json', 'config.toml']) {
    const src = path.join(hostHome, '.codex', name);
    if (fs.existsSync(src)) args.push('-v', `${src}:/host-codex-ro/${name}:ro`);
  }
  if (fs.existsSync(hostSharedEnv))
    args.push('-v', `${hostSharedEnv}:${hostSiteDir}/.env.shared:ro`);
  const canonicalEnv = path.join(canonicalSiteDir, '.env');
  if (options.workspaceDir && fs.existsSync(canonicalEnv))
    args.push('-v', `${canonicalEnv}:${hostSiteDir}/.env:ro`);
  args.push(IMAGE);

  const r = await docker(args);
  if (r.code !== 0) throw httpErr(500, `docker run failed: ${r.stderr.trim()}`);
  return { started: true, ports: { ttyd: ttydPort, dev: devPort } };
}

function improvementInstance(runId) {
  const id = String(runId || '').toLowerCase();
  if (!/^[a-f0-9-]{8,36}$/.test(id)) throw httpErr(400, 'invalid improvement run id');
  return `imp-${id.replace(/-/g, '').slice(0, 12)}`;
}

async function startImprovement(root, site, runId, workspaceDir) {
  const instance = improvementInstance(runId);
  const result = await start(root, site, { instance, workspaceDir });
  return {
    ...result,
    instance,
    container: containerName(instance),
    ttydUrl: `http://${PUBLIC_HOST}:${result.ports.ttyd}/`,
    devUrl: `http://${PUBLIC_HOST}:${result.ports.dev}/`,
  };
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

async function devStatus(site) {
  const r = await devExec(site, 'status');
  return r.kv;
}
async function devStart(site) {
  const r = await devExec(site, 'start');
  if (r.code !== 0) throw httpErr(400, r.stdout || r.stderr || 'dev start failed');
  return r.kv;
}
async function devStop(site) {
  return (await devExec(site, 'stop')).kv;
}
async function devLogs(site, n) {
  return (await devExec(site, 'logs', String(n || 200))).stdout || '(no logs)';
}

// Run deterministic delivery gates inside the per-site sandbox. Commands are
// fixed here (never supplied by the browser), and docker receives each argument
// separately; the site's package scripts remain its source of truth.
async function validate(site) {
  const checks = [
    ['diff', 'git diff --check'],
    ['tests', 'if [ -f site/package.json ]; then cd site; fi; npm test --if-present'],
    ['build', 'if [ -f site/package.json ]; then cd site; fi; npm run build'],
  ];
  const results = {};
  for (const [name, command] of checks) {
    const started = Date.now();
    const r = await docker(['exec', containerName(site), 'sh', '-lc', command], {
      timeout: 10 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
    });
    results[name] = {
      status: r.code === 0 ? 'pass' : 'fail',
      duration_ms: Date.now() - started,
      excerpt: `${r.stdout}\n${r.stderr}`.trim().slice(-4000),
    };
    if (r.code !== 0) break;
  }
  return {
    passed:
      Object.keys(results).length === checks.length &&
      Object.values(results).every(x => x.status === 'pass'),
    recorded_at: new Date().toISOString(),
    checks: results,
  };
}

async function preview(instance, pathname = '/') {
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/.test(String(pathname || '')))
    throw httpErr(400, 'invalid preview path');
  const marker = '__FD_HTTP_STATUS__:';
  const r = await docker(
    [
      'exec',
      containerName(instance),
      'curl',
      '-sS',
      '-L',
      '--max-time',
      '15',
      '-w',
      `\n${marker}%{http_code}`,
      `http://127.0.0.1:${DEV_PORT_IN_CONTAINER}${pathname}`,
    ],
    { timeout: 20000 }
  );
  const at = r.stdout.lastIndexOf(`\n${marker}`);
  const body = at >= 0 ? r.stdout.slice(0, at) : r.stdout;
  const status = at >= 0 ? Number(r.stdout.slice(at + marker.length + 1)) : 0;
  return {
    ok: r.code === 0 && status >= 200 && status < 400,
    status,
    body,
    error: r.code === 0 ? null : r.stderr.trim() || 'preview request failed',
  };
}

async function browserAudit(root, instance, site) {
  const persistDir = path.join(root, 'tools', 'domain-developer', 'state', instance, 'persist');
  fs.mkdirSync(persistDir, { recursive: true });
  const shots = [
    ['production.png', `https://${site}/`],
    ['preview.png', `http://127.0.0.1:${DEV_PORT_IN_CONTAINER}/`],
  ];
  const screenshotResults = {};
  for (const [name, url] of shots) {
    const r = await docker(
      [
        'exec',
        containerName(instance),
        'chromium',
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--hide-scrollbars',
        '--ignore-certificate-errors',
        '--window-size=1440,1000',
        `--screenshot=/home/dev/persist/${name}`,
        url,
      ],
      { timeout: 60000 }
    );
    screenshotResults[name] = {
      status: r.code === 0 && fs.existsSync(path.join(persistDir, name)) ? 'pass' : 'fail',
      evidence: r.code === 0 ? '1440×1000 captured' : r.stderr.trim().slice(-500),
    };
  }
  const lighthouseFile = path.join(persistDir, 'lighthouse.json');
  const lh = await docker(
    [
      'exec',
      containerName(instance),
      'lighthouse',
      `http://127.0.0.1:${DEV_PORT_IN_CONTAINER}/`,
      '--quiet',
      '--output=json',
      '--output-path=/home/dev/persist/lighthouse.json',
      '--chrome-flags=--headless --no-sandbox --disable-gpu',
    ],
    { timeout: 3 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 }
  );
  let scores = {};
  try {
    const report = JSON.parse(fs.readFileSync(lighthouseFile, 'utf8'));
    for (const key of ['performance', 'accessibility', 'best-practices', 'seo'])
      scores[key] = Math.round(Number(report.categories?.[key]?.score || 0) * 100);
  } catch {
    /* reported below */
  }
  const thresholds = { performance: 50, accessibility: 90, 'best-practices': 85, seo: 90 };
  const lighthouseChecks = Object.fromEntries(
    Object.entries(thresholds).map(([key, minimum]) => [
      key,
      {
        status: scores[key] >= minimum ? 'pass' : 'fail',
        evidence: `${scores[key] ?? 0}/100; minimum ${minimum}`,
      },
    ])
  );
  const passed =
    lh.code === 0 &&
    Object.values(screenshotResults).every(x => x.status === 'pass') &&
    Object.values(lighthouseChecks).every(x => x.status === 'pass');
  return {
    passed,
    recorded_at: new Date().toISOString(),
    screenshots: screenshotResults,
    lighthouse: {
      status: lh.code === 0 ? 'complete' : 'failed',
      scores,
      checks: lighthouseChecks,
      error: lh.code === 0 ? null : lh.stderr.trim().slice(-1000),
    },
  };
}

function improvementArtifactPath(root, instance, name) {
  if (!['production.png', 'preview.png', 'lighthouse.json'].includes(name))
    throw httpErr(400, 'invalid artifact');
  if (!/^imp-[a-f0-9]{8,12}$/.test(instance)) throw httpErr(400, 'invalid improvement instance');
  return path.join(root, 'tools', 'domain-developer', 'state', instance, 'persist', name);
}

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
  const r = await docker([
    'stats',
    '--no-stream',
    '--format',
    '{{.Name}}\x01{{.CPUPerc}}\x01{{.MemUsage}}\x01{{.PIDs}}',
    ...names,
  ]);
  if (r.code !== 0) throw httpErr(500, r.stderr.trim() || 'docker stats failed');
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name, cpu, mem, pids] = line.split('\x01');
      return {
        site: (name || '').replace(/^dd-/, ''),
        cpu: cpu || '',
        mem: mem || '',
        pids: pids || '',
      };
    })
    .filter(c => c.site);
}

async function findOrphans(sites) {
  const known = new Set(sites);
  const state = loadState();
  // imp-* instances are owned by durable improvement runs, not site discovery.
  const stalePorts = Object.keys(state.ports || {}).filter(
    s => !known.has(s) && !s.startsWith('imp-')
  );
  const danglingContainers = Object.keys(await listDdContainers()).filter(
    s => !known.has(s) && !s.startsWith('imp-')
  );
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
  const running = Object.entries(await listDdContainers())
    .filter(([, c]) => c.state === 'running')
    .map(([s]) => s);
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
  const notRunning = Object.entries(await listDdContainers())
    .filter(([, c]) => c.state !== 'running')
    .map(([s]) => s);
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
  list,
  start,
  stop,
  remove,
  devStatus,
  devStart,
  devStop,
  devLogs,
  validate,
  preview,
  browserAudit,
  improvementArtifactPath,
  startImprovement,
  improvementInstance,
  stats,
  findOrphans,
  cleanupOrphans,
  stopAll,
  removeStopped,
};
