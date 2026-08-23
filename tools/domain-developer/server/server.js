#!/usr/bin/env node
/**
 * domain-developer panel
 *
 * Lists every site under /home/jesse/projects/domains/sites/* and exposes
 * controls to start/stop a per-site Docker container that runs ttyd → bash
 * with claude + the dev toolchain. Each container bind-mounts ONLY that
 * site's directory at /work so the host filesystem stays protected.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

// When the panel runs in its own container, the docker daemon (on host)
// resolves -v source paths against the host filesystem — so we need to
// pass HOST paths, even when our own process sees them at a different
// or read-only location. DD_HOST_HOME / DD_HOST_DOMAINS_ROOT override
// for containerized deploys; defaults work for host-process mode.
const HOST_DOMAINS_ROOT =
  process.env.DD_HOST_DOMAINS_ROOT || path.resolve(__dirname, '..', '..', '..'); // /home/jesse/projects/domains
const HOST_HOME = process.env.DD_HOST_HOME || os.homedir();

// Where THIS process reads from. In container mode the sites dir is
// bind-mounted at the same path as the host, so both equal HOST_DOMAINS_ROOT.
const ROOT = HOST_DOMAINS_ROOT;
const SITES_DIR = path.join(ROOT, 'sites');
const STATE_FILE = process.env.DD_STATE_FILE || path.join(__dirname, '..', 'state.json');
const IMAGE = 'domain-developer:latest';
// Per-site Claude state lives on HOST BIND MOUNTS under here (not named
// volumes) → visible, backup-able, survives `docker volume prune` and
// container recreation. Layout: <STATE_ROOT>/<site>/{claude,persist}.
const STATE_ROOT =
  process.env.DD_STATE_DIR || path.join(HOST_DOMAINS_ROOT, 'tools', 'domain-developer', 'state');
const PANEL_PORT = parseInt(process.env.DD_PANEL_PORT || '7777', 10);
const TTYD_PORT_BASE = parseInt(process.env.DD_PORT_BASE || '7800', 10);
const DEV_PORT_BASE = parseInt(process.env.DD_DEV_PORT_BASE || '7900', 10);
const DEV_PORT_IN_CONTAINER = parseInt(process.env.DD_DEV_PORT_IN_CONTAINER || '4321', 10);
const PANEL_HOST = process.env.DD_PANEL_HOST || '127.0.0.1';
// PANEL_PUBLIC_HOST is what we tell the BROWSER to connect to — always
// host loopback, even when the panel binds 0.0.0.0 inside its container.
const PANEL_PUBLIC_HOST = process.env.DD_PANEL_PUBLIC_HOST || '127.0.0.1';
// Per-container resource caps — one runaway dev-server/build in a sandbox
// shouldn't be able to starve the host or every other running container.
const DD_MEMORY_LIMIT = process.env.DD_MEMORY_LIMIT || '4g';
const DD_CPUS_LIMIT = process.env.DD_CPUS_LIMIT || '2';
const DD_PIDS_LIMIT = parseInt(process.env.DD_PIDS_LIMIT || '512', 10);

// ───────────────────────── helpers ─────────────────────────

function safeSiteName(s) {
  if (typeof s !== 'string' || s === '' || s === '.' || s === '..') return false;
  if (!/^[a-zA-Z0-9._-]+$/.test(s)) return false;
  // Defense-in-depth: even a regex-legal name must resolve inside SITES_DIR.
  const resolved = path.resolve(SITES_DIR, s);
  return resolved === path.join(SITES_DIR, s) && resolved.startsWith(SITES_DIR + path.sep);
}
const containerName = site => `dd-${site}`;

function loadState() {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    s = { ports: {} };
  }
  // Migrate legacy format `{site: <number>}` → `{site: {ttyd, dev}}`.
  let mutated = false;
  for (const [site, val] of Object.entries(s.ports || {})) {
    if (typeof val === 'number') {
      s.ports[site] = { ttyd: val };
      mutated = true;
    }
  }
  if (mutated) saveState(s);
  return s;
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// Port allocations and dd-* containers for sites whose directory no longer
// exists accumulate forever with no cleanup path otherwise.
// listDdContainers() matches on `dd-*`, which also catches the panel's own
// container (`dd-panel`, per docker-compose.yml's container_name) — exclude
// it everywhere bulk/orphan logic iterates "every dd-* container", so the
// panel can never target itself for stop/remove.
function listSiteContainers() {
  const map = listDdContainers();
  delete map['panel'];
  return map;
}

function findOrphans() {
  const sites = new Set(listSites());
  const state = loadState();
  const stalePorts = Object.keys(state.ports || {}).filter(s => !sites.has(s));
  const danglingContainers = Object.keys(listSiteContainers()).filter(s => !sites.has(s));
  return { stalePorts, danglingContainers };
}

function pruneStaleState() {
  const { stalePorts } = findOrphans();
  if (!stalePorts.length) return stalePorts;
  const state = loadState();
  for (const s of stalePorts) delete state.ports[s];
  saveState(state);
  return stalePorts;
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

function docker(args, opts = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', ...opts });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Distinguishes "Docker daemon unreachable" from "container doesn't exist" so
// callers don't misread a dead daemon as every site being absent.
function dockerAvailable() {
  return docker(['version', '--format', '{{.Server.Version}}']).code === 0;
}

function listSites() {
  if (!fs.existsSync(SITES_DIR)) return [];
  return fs
    .readdirSync(SITES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name)
    .sort();
}

function inspectContainer(site) {
  const name = containerName(site);
  const r = docker(['inspect', '--format', '{{.State.Status}}', name]);
  if (r.code !== 0) return { exists: false, status: 'absent' };
  return { exists: true, status: r.stdout.trim() };
}

// Single bulk call: lists EVERY dd-* container's state + port bindings in one
// shot. Lets siteRow avoid N sequential `docker inspect` calls — a big perf
// win for /api/sites when there are dozens of sites.
function listDdContainers() {
  // \x01 separator; safer than tab if ports column contains whitespace
  const r = docker([
    'ps',
    '-a',
    '--filter',
    'name=^dd-',
    '--format',
    '{{.Names}}\x01{{.State}}\x01{{.Ports}}\x01{{.Image}}',
  ]);
  if (r.code !== 0) return {};
  const map = {};
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [name, state, ports, image] = line.split('\x01');
    if (!name || !name.startsWith('dd-')) continue;
    map[name.slice(3)] = { state: state || 'absent', ports: ports || '', image: image || '' };
  }
  return map;
}

// Parse "127.0.0.1:7800->7681/tcp, 127.0.0.1:7900->4321/tcp" → { 7681: 7800, 4321: 7900 }
function parsePortsString(portsStr) {
  const out = {};
  if (!portsStr) return out;
  const re = /(?:\d+\.\d+\.\d+\.\d+|::):(\d+)->(\d+)\/tcp/g;
  let m;
  while ((m = re.exec(portsStr)) !== null) {
    out[parseInt(m[2], 10)] = parseInt(m[1], 10);
  }
  return out;
}

// Read actual host port bindings off a running container. Falls back to
// state.json's allocation. Returns null if container has no mapping for
// that internal port (e.g., CLI-spawned containers have no -p flags).
function containerPort(siteName, internalPort) {
  const r = docker([
    'inspect',
    '--format',
    `{{(index (index .NetworkSettings.Ports "${internalPort}/tcp") 0).HostPort}}`,
    containerName(siteName),
  ]);
  if (r.code !== 0) return null;
  const p = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(p) ? p : null;
}

function siteRow(name, containerMap, statePorts) {
  const dir = path.join(SITES_DIR, name);
  const hasEnv = fs.existsSync(path.join(dir, '.env'));
  const c = containerMap[name];
  const status = c ? c.state : 'absent';
  const livePorts = c ? parsePortsString(c.ports) : {};
  const sp = (statePorts || {})[name] || {};
  const ttydPort = livePorts[7681] || sp.ttyd || null;
  const devPort = livePorts[DEV_PORT_IN_CONTAINER] || sp.dev || null;
  return {
    name,
    dir,
    hasEnv,
    // Fleet-wide kill-switch convention (see tools/site-tracker etc.) —
    // this panel doesn't enforce it, but it shouldn't be silent about it
    // either: starting a sandbox for a deliberately-disabled site should
    // require a conscious click, not look identical to any other site.
    disabled: name.startsWith('DISABLED-'),
    status,
    // Docker prints the image TAG here only while the container's image is
    // still the current `domain-developer:latest`; once that tag has moved
    // (a dd-build) it falls back to the pinned image ID. So "this column
    // isn't the tag" is a free, zero-extra-docker-call staleness signal —
    // and it is exactly how the pre-cattle drift was first spotted in
    // `docker ps` (dd-americastrikes.com showing a bare image hash).
    imageStale: !!(c && c.image && c.image !== IMAGE),
    ttydPort,
    devPort,
    ttydUrl: ttydPort ? `http://${PANEL_PUBLIC_HOST}:${ttydPort}/` : null,
    devUrl: devPort ? `http://${PANEL_PUBLIC_HOST}:${devPort}/` : null,
    liveUrl: `https://${name}/`,
    repoUrl: `https://github.com/bourneash/${name}`,
    fleetDashboardUrl: `http://localhost:4754/#control`,
    siteTrackerUrl: `http://localhost:4742/site/${encodeURIComponent(name)}`,
  };
}

function imageExists() {
  const r = docker(['image', 'inspect', IMAGE]);
  return r.code === 0;
}

function startContainer(site) {
  if (!safeSiteName(site)) throw new Error('invalid site name');
  const dir = path.join(SITES_DIR, site);
  if (!fs.existsSync(dir)) throw new Error(`site dir not found: ${dir}`);

  const cur = inspectContainer(site);
  const ports = loadState().ports[site] || allocPorts(site);
  if (cur.status === 'running') return { started: false, ports };

  // ── Cattle, not pets ──────────────────────────────────────────────────
  // A worker that exists but isn't running is destroyed, never resurrected.
  // `docker start` would reuse the image the container object was created
  // from, so a dd-build that landed while this worker sat stopped would
  // silently never reach it — the exact drift cattle is meant to prevent.
  // Recreating costs a couple of seconds and loses nothing: all durable
  // state is on host binds (REDESIGN.md) and the entrypoint re-copies the
  // host's current OAuth credential on every boot.
  if (cur.exists) {
    docker(['rm', '-f', containerName(site)]);
  }

  // Fresh run. All -v source paths must be HOST paths (the docker
  // daemon resolves them; it doesn't see our container's view).
  const { ttyd: ttydPort, dev: devPort } = allocPorts(site);
  const hostSiteDir = path.join(HOST_DOMAINS_ROOT, 'sites', site);
  const hostSharedEnv = path.join(HOST_DOMAINS_ROOT, '.env');

  // Per-site claude project dir (Option A architecture):
  //   - Site is bind-mounted at the SAME host path inside the container so
  //     cwd matches host → claude encodes the project ID identically.
  //   - That encoded dir is bind-mounted RW from host's ~/.claude/projects/
  //     so per-site memory + transcripts traverse up to the host.
  const projectId = hostSiteDir.replace(/\//g, '-');
  const hostProjectDir = path.join(HOST_HOME, '.claude', 'projects', projectId);
  fs.mkdirSync(hostProjectDir, { recursive: true });

  // Per-site Claude state + scratch on host binds (see STATE_ROOT). Created
  // here so the dirs exist before `docker run`; the worker entrypoint chowns
  // them to its dev user on boot (it has passwordless sudo).
  const claudeStateDir = path.join(STATE_ROOT, site, 'claude');
  const persistStateDir = path.join(STATE_ROOT, site, 'persist');
  fs.mkdirSync(claudeStateDir, { recursive: true });
  fs.mkdirSync(persistStateDir, { recursive: true });

  // Host ~/.claude bits shared into the container, split by whether Claude
  // WRITES the file at runtime:
  //   - claudeRoShares: dirs Claude only reads → bind RO straight at dest.
  //     plugins/commands/hooks (shared, usable not editable) + skills (personal).
  //   - claudeCopyIn: files Claude REWRITES (settings.json on config changes,
  //     .credentials.json on every OAuth refresh). Binding these RO broke the
  //     writes → periodic auth failure. Stage them RO under /host-claude-ro/
  //     and let the entrypoint copy them in writable.
  const claudeRoShares = ['plugins', 'commands', 'hooks', 'skills'];
  const claudeCopyIn = ['settings.json', '.credentials.json'];

  const args = [
    'run',
    '-d',
    '--name',
    containerName(site),
    '--hostname',
    `dd-${site}`,
    '--label',
    'dd.role=worker',
    '--label',
    `dd.site=${site}`,
    // No restart policy: a worker never comes back on its own. The fleet
    // should never contain a dd-* container nobody deliberately created.
    '--restart',
    'no',
    '--stop-timeout',
    '30',
    '--memory',
    DD_MEMORY_LIMIT,
    '--cpus',
    DD_CPUS_LIMIT,
    '--pids-limit',
    String(DD_PIDS_LIMIT),
    '--workdir',
    hostSiteDir,
    '-p',
    `127.0.0.1:${ttydPort}:7681`,
    // Dev-server port (Astro default 4321) → host-allocated port,
    // so the panel can iframe the running dev server when user
    // starts `npm run dev` in one of their terminal tabs.
    '-p',
    `127.0.0.1:${devPort}:${DEV_PORT_IN_CONTAINER}`,
    // Site code bind-mounted at SAME path as host (NOT /work) so
    // claude's cwd-based project encoding matches host's view.
    '-v',
    `${hostSiteDir}:${hostSiteDir}`,
    // Per-site writable claude state (host bind, not a named volume).
    '-v',
    `${claudeStateDir}:/home/dev/.claude`,
    // .claude.json is COPIED into the volume on first boot by the
    // entrypoint — bind path here is read-once-at-startup only.
    '-v',
    `${HOST_HOME}/.claude.json:/host-claude-json-ro:ro`,
    // Per-site project dir lives on host, shared with this container.
    '-v',
    `${hostProjectDir}:/home/dev/.claude/projects/${projectId}`,
    '-v',
    `${HOST_HOME}/.ssh:/home/dev/.ssh:ro`,
    '-v',
    `${persistStateDir}:/home/dev/persist`,
    '-e',
    `SITE_NAME=${site}`,
    '-e',
    `SITE_DIR=${hostSiteDir}`,
    // Host home so the entrypoint can bridge absolute host paths baked
    // into mounted ~/.claude config (marketplace installLocations).
    '-e',
    `HOST_HOME=${HOST_HOME}`,
    '-e',
    'TTYD_PORT=7681',
  ];

  // RO shares from host ~/.claude/ for plugins/commands/hooks/skills.
  for (const name of claudeRoShares) {
    const src = path.join(HOST_HOME, '.claude', name);
    if (fs.existsSync(src)) {
      args.push('-v', `${src}:/home/dev/.claude/${name}:ro`);
    }
  }
  // Files Claude rewrites: stage RO; the entrypoint copies them in writable.
  for (const name of claudeCopyIn) {
    const src = path.join(HOST_HOME, '.claude', name);
    if (fs.existsSync(src)) {
      args.push('-v', `${src}:/host-claude-ro/${name}:ro`);
    }
  }
  if (fs.existsSync(hostSharedEnv)) {
    args.push('-v', `${hostSharedEnv}:${hostSiteDir}/.env.shared:ro`);
  }
  args.push(IMAGE);

  const r = docker(args);
  if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr.trim()}`);
  return { started: true, ports: { ttyd: ttydPort, dev: devPort } };
}

// Stop == destroy. A stopped-but-present worker is precisely the pet this
// tool refuses to keep: it pins an image, accumulates forever, and is
// invisible in `docker ps`. Nothing durable lives in the container, so the
// only thing `rm` costs is the couple of seconds to recreate it on next use.
function stopContainer(site) {
  if (!safeSiteName(site)) throw new Error('invalid site name');
  const r = docker(['stop', containerName(site)]);
  if (r.code !== 0) return { code: r.code, stderr: r.stderr };
  const rm = docker(['rm', containerName(site)]);
  return { code: rm.code, stderr: rm.stderr };
}

function removeContainer(site) {
  if (!safeSiteName(site)) throw new Error('invalid site name');
  docker(['stop', containerName(site)]);
  const r = docker(['rm', containerName(site)]);
  return { code: r.code, stderr: r.stderr };
}

// ───────────────────────── http ─────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    dockerAvailable: dockerAvailable(),
    imageBuilt: imageExists(),
    sitesDir: SITES_DIR,
    hostHome: HOST_HOME,
    hostDomainsRoot: HOST_DOMAINS_ROOT,
    panelHost: PANEL_HOST,
    publicHost: PANEL_PUBLIC_HOST,
    ttydPortBase: TTYD_PORT_BASE,
    devPortBase: DEV_PORT_BASE,
    containerized: !!process.env.DD_HOST_DOMAINS_ROOT,
  });
});

app.get('/api/sites', (req, res) => {
  // Pull container state and state.json ports ONCE, then map. Avoids the
  // O(N) docker-inspect storm that made site-switching feel slow.
  const containerMap = listDdContainers();
  const statePorts = loadState().ports || {};
  const sites = listSites().map(n => siteRow(n, containerMap, statePorts));
  res.json({ sites });
});

app.post('/api/sites/:site/start', (req, res) => {
  try {
    const r = startContainer(req.params.site);
    const ttydPort = r.ports.ttyd;
    const devPort = r.ports.dev;
    res.json({
      ok: true,
      started: r.started,
      ports: r.ports,
      ttydUrl: `http://${PANEL_PUBLIC_HOST}:${ttydPort}/`,
      devUrl: `http://${PANEL_PUBLIC_HOST}:${devPort}/`,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/sites/:site/stop', (req, res) => {
  try {
    const r = stopContainer(req.params.site);
    res.json({ ok: r.code === 0, error: r.code !== 0 ? r.stderr : undefined });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Parse "key=value\nkey=value" output from dd-dev into an object.
function parseKV(stdout) {
  const out = {};
  for (const line of stdout.split('\n')) {
    const m = line.match(/^([a-zA-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function devExec(site, ...args) {
  if (!safeSiteName(site)) throw new Error('invalid site name');
  const r = docker(['exec', containerName(site), 'dd-dev', ...args]);
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, kv: parseKV(r.stdout) };
}

app.get('/api/sites/:site/dev', (req, res) => {
  try {
    const r = devExec(req.params.site, 'status');
    res.json({ ok: true, ...r.kv });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/sites/:site/dev/start', (req, res) => {
  try {
    const r = devExec(req.params.site, 'start');
    if (r.code !== 0) {
      return res.status(400).json({ ok: false, ...r.kv, raw: r.stdout || r.stderr });
    }
    res.json({ ok: true, ...r.kv });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/sites/:site/dev/stop', (req, res) => {
  try {
    const r = devExec(req.params.site, 'stop');
    res.json({ ok: true, ...r.kv });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/sites/:site/dev/logs', (req, res) => {
  try {
    const n = parseInt(String(req.query.n || '200'), 10);
    const r = devExec(req.params.site, 'logs', String(n));
    res.type('text/plain').send(r.stdout || '(no logs)');
  } catch (e) {
    res.status(400).type('text/plain').send(e.message);
  }
});

// Destroy + rebuild from the CURRENT image. This is the cattle primitive the
// whole design leans on: because startContainer() already destroys anything
// that isn't running, "recreate" is just remove-then-start, and it is always
// safe — durable state is on host binds (REDESIGN.md), never in the container.
app.post('/api/sites/:site/recreate', (req, res) => {
  try {
    removeContainer(req.params.site);
    const r = startContainer(req.params.site);
    res.json({
      ok: true,
      recreated: true,
      ports: r.ports,
      ttydUrl: `http://${PANEL_PUBLIC_HOST}:${r.ports.ttyd}/`,
      devUrl: `http://${PANEL_PUBLIC_HOST}:${r.ports.dev}/`,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/sites/:site/remove', (req, res) => {
  try {
    const r = removeContainer(req.params.site);
    res.json({ ok: r.code === 0, error: r.code !== 0 ? r.stderr : undefined });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Live CPU/mem per running dd-* container, for the resource dashboard (F2).
// docker stats --no-stream blocks ~1s per call; fine for on-demand polling,
// not for the main 5s /api/sites tick.
app.get('/api/stats', (req, res) => {
  const r = docker([
    'stats',
    '--no-stream',
    '--format',
    '{{.Name}}\x01{{.CPUPerc}}\x01{{.MemUsage}}\x01{{.PIDs}}',
  ]);
  if (r.code !== 0)
    return res.json({ ok: false, error: r.stderr.trim() || 'docker stats failed', containers: [] });
  const containers = r.stdout
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
  res.json({ ok: true, containers });
});

app.post('/api/sites/stop-all', (req, res) => {
  const running = Object.entries(listSiteContainers())
    .filter(([, c]) => c.state === 'running')
    .map(([s]) => s);
  const stopped = [];
  const errors = [];
  for (const site of running) {
    const r = stopContainer(site);
    if (r.code === 0) stopped.push(site);
    else errors.push({ site, error: r.stderr.trim() });
  }
  res.json({ ok: errors.length === 0, stopped, errors });
});

app.post('/api/sites/remove-stopped', (req, res) => {
  const notRunning = Object.entries(listSiteContainers())
    .filter(([, c]) => c.state !== 'running')
    .map(([s]) => s);
  const removed = [];
  const errors = [];
  for (const site of notRunning) {
    const r = removeContainer(site);
    if (r.code === 0) removed.push(site);
    else errors.push({ site, error: r.stderr.trim() });
  }
  res.json({ ok: errors.length === 0, removed, errors });
});

app.get('/api/orphans', (req, res) => {
  res.json(findOrphans());
});

app.post('/api/orphans/cleanup', (req, res) => {
  const { stalePorts, danglingContainers } = findOrphans();
  const removed = [];
  const errors = [];
  for (const site of danglingContainers) {
    const r = docker(['rm', '-f', containerName(site)]);
    if (r.code === 0) removed.push(site);
    else errors.push({ site, error: r.stderr.trim() });
  }
  const prunedPorts = pruneStaleState();
  res.json({ ok: errors.length === 0, removedContainers: removed, prunedPorts, errors });
});

pruneStaleState();

app.listen(PANEL_PORT, PANEL_HOST, () => {
  console.log(`domain-developer panel:  http://${PANEL_HOST}:${PANEL_PORT}/`);
  console.log(`sites dir:               ${SITES_DIR}`);
  if (!imageExists()) {
    console.log(`\n[!] image ${IMAGE} not built yet. Run:`);
    console.log(`    tools/domain-developer/bin/dd-build`);
  }
});
