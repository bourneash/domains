# cron-manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `tools/cron-manager`, a loopback web panel that dynamically discovers every cron system across the domains portfolio (sites + tools), shows what each runs and its state, and lets the operator enable/disable/edit/remove jobs.

**Architecture:** Node + Express server, loopback-bound, filesystem-as-source-of-truth (every read re-scans disk). Pure library modules (`crontab.js`, `discovery.js`, `docker.js`) are unit-tested in isolation; `server.js` wires them to HTTP routes. Role-flag enable/disable is instant; crontab-file edits are gated behind an explicit rebuild button.

**Tech Stack:** Node (CommonJS, Node 20+), Express, cronstrue (cron→English), `node:test` + `node:assert` for tests, Docker CLI via `child_process` for status/rebuild.

---

## File Structure

```
tools/cron-manager/
├── package.json              # deps: express, cronstrue; scripts: start, test
├── server/
│   ├── server.js             # Express app, routes, wiring, listen()
│   ├── crontab.js            # PURE: parse + line-preserving rewrites
│   ├── discovery.js          # glob systems, assemble model (+ enabled state)
│   └── docker.js             # container status + rebuild (exec injected)
│   └── public/
│       ├── index.html        # panel shell
│       ├── app.js            # fetch + render + action buttons
│       └── style.css         # dark portfolio styling
├── test/
│   ├── crontab.test.js
│   ├── discovery.test.js
│   └── docker.test.js
├── docker-compose.yml        # loopback launch
├── Dockerfile
└── README.md
```

### Data model (used across all modules)

```js
// Entry — one parsed cron line
{
  lineIndex: 17,                                   // 0-based index into file lines
  rawLine: "0 6 * * 1     bash ops/scripts/run-worker.sh planner",
  schedule: "0 6 * * 1",                           // the 5 cron fields
  command: "bash ops/scripts/run-worker.sh planner",
  role: "planner",                                 // or null when not a run-worker.sh call
  commented: false                                 // line begins with '#'
}

// System — one discovered cron container
{
  kind: "site",                                    // "site" | "tool"
  slug: "americastrikes.com",
  crontabPath: "/abs/.../crontab.docker",
  opsDir: "/abs/.../ops",                          // null for tools
  project: "americastrikes-ops",
  container: "americastrikes-cron",
  status: "running",                               // "running"|"stopped"|"never-built" (added by docker layer)
  entries: [ /* Entry, each with computed `enabled: bool` */ ]
}
```

---

## Task 1: Project scaffold

**Files:**
- Create: `tools/cron-manager/package.json`
- Create: `tools/cron-manager/test/crontab.test.js` (temporary smoke)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "cron-manager",
  "version": "1.0.0",
  "private": true,
  "description": "Portfolio cron control panel for the domains repo",
  "main": "server/server.js",
  "scripts": {
    "start": "node server/server.js",
    "test": "node --test"
  },
  "dependencies": {
    "express": "^4.19.2",
    "cronstrue": "^2.50.0"
  }
}
```

- [ ] **Step 2: Install deps**

Run: `cd tools/cron-manager && npm install`
Expected: `node_modules/` created, `express` and `cronstrue` present, exit 0.

- [ ] **Step 3: Add a smoke test proving the runner works**

Create `tools/cron-manager/test/crontab.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');

test('test runner works', () => {
  assert.strictEqual(1 + 1, 2);
});
```

- [ ] **Step 4: Run the test**

Run: `cd tools/cron-manager && npm test`
Expected: PASS, 1 test passing.

- [ ] **Step 5: Commit**

```bash
git add tools/cron-manager/package.json tools/cron-manager/package-lock.json tools/cron-manager/test/crontab.test.js
git commit -m "feat(cron-manager): scaffold project + test runner"
```

---

## Task 2: crontab.js — parsing

**Files:**
- Create: `tools/cron-manager/server/crontab.js`
- Modify: `tools/cron-manager/test/crontab.test.js`

- [ ] **Step 1: Write failing tests for parsing**

Replace the contents of `test/crontab.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseCrontab, isValidCron } = require('../server/crontab');

const SAMPLE = [
  '# header prose, not a cron line',
  'COMPOSE_PROJECT_NAME=americastrikes-ops',
  '',
  '0 6,8,10,12,14,16,18,20,22 * * *  bash ops/scripts/run-worker.sh update',
  '0 6 * * 1     bash ops/scripts/run-worker.sh planner',
  '# 0 7 * * *     bash ops/scripts/run-worker.sh newsletter-editor',
  '*/15 * * * *  bash ops/scripts/run-scraper.sh',
  "*/5 * * * *   bash -c '[ -f .deploy-needed ] || exit 0; bash ops/scripts/run-worker.sh deployer'",
  '0 4 * * 0   find ops/logs -type f -mtime +14 -delete',
].join('\n');

test('isValidCron accepts 5-field expressions and rejects prose', () => {
  assert.ok(isValidCron('0 6 * * 1'));
  assert.ok(isValidCron('*/15 * * * *'));
  assert.ok(isValidCron('0 6,8,10,12,14,16,18,20,22 * * *'));
  assert.ok(!isValidCron('Each cron line invokes docker'));
  assert.ok(!isValidCron('0 6 * *'));            // only 4 fields
});

test('parseCrontab skips prose, blanks, and env lines', () => {
  const { entries } = parseCrontab(SAMPLE);
  // 4 active cron lines + 1 commented cron line = 5 entries
  assert.strictEqual(entries.length, 5);
});

test('parseCrontab extracts schedule, command, role', () => {
  const { entries } = parseCrontab(SAMPLE);
  const planner = entries.find(e => e.role === 'planner');
  assert.strictEqual(planner.schedule, '0 6 * * 1');
  assert.strictEqual(planner.command, 'bash ops/scripts/run-worker.sh planner');
  assert.strictEqual(planner.commented, false);
});

test('parseCrontab surfaces commented-out cron lines with commented=true', () => {
  const { entries } = parseCrontab(SAMPLE);
  const news = entries.find(e => e.role === 'newsletter-editor');
  assert.strictEqual(news.commented, true);
});

test('parseCrontab extracts role from a bash -c wrapped run-worker call', () => {
  const { entries } = parseCrontab(SAMPLE);
  const dep = entries.find(e => e.role === 'deployer');
  assert.ok(dep, 'deployer role found inside bash -c wrapper');
  assert.strictEqual(dep.schedule, '*/5 * * * *');
});

test('parseCrontab sets role=null for non run-worker commands', () => {
  const { entries } = parseCrontab(SAMPLE);
  const scraper = entries.find(e => e.command.includes('run-scraper.sh'));
  assert.strictEqual(scraper.role, null);
  const prune = entries.find(e => e.command.startsWith('find '));
  assert.strictEqual(prune.role, null);
});

test('parseCrontab records lineIndex pointing at the source rawLine', () => {
  const { entries, lines } = parseCrontab(SAMPLE);
  for (const e of entries) {
    assert.strictEqual(lines[e.lineIndex], e.rawLine);   // index resolves to its own line
    assert.ok(e.rawLine.includes(e.command));            // command came from that line
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/cron-manager && npm test`
Expected: FAIL — `Cannot find module '../server/crontab'`.

- [ ] **Step 3: Implement crontab.js parsing**

Create `tools/cron-manager/server/crontab.js`:

```js
'use strict';

// Matches an optional leading comment marker, then 5 whitespace-separated
// schedule fields, then the command (rest of line).
const CRON_RE = /^(#\s*)?((?:\S+\s+){4}\S+)\s+(.+)$/;

// A cron schedule field uses only these characters across our crontabs.
const FIELD_RE = /^[\d*,/-]+$/;

function isValidCron(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f) => FIELD_RE.test(f));
}

function extractRole(command) {
  const m = command.match(/run-worker\.sh\s+([A-Za-z0-9._-]+)/);
  return m ? m[1] : null;
}

function parseCrontab(text) {
  const lines = text.split('\n');
  const entries = [];
  lines.forEach((line, lineIndex) => {
    const m = line.match(CRON_RE);
    if (!m) return;
    const schedule = m[2].trim();
    if (!isValidCron(schedule)) return;          // rejects prose comments
    const command = m[3].trim();
    entries.push({
      lineIndex,
      rawLine: line,
      schedule,
      command,
      role: extractRole(command),
      commented: Boolean(m[1]),
    });
  });
  return { lines, entries };
}

module.exports = { parseCrontab, isValidCron, extractRole, CRON_RE };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/cron-manager && npm test`
Expected: PASS — all parsing tests green.

- [ ] **Step 5: Commit**

```bash
git add tools/cron-manager/server/crontab.js tools/cron-manager/test/crontab.test.js
git commit -m "feat(cron-manager): crontab parser (schedule/command/role/comment)"
```

---

## Task 3: crontab.js — line-preserving rewrites

**Files:**
- Modify: `tools/cron-manager/server/crontab.js`
- Modify: `tools/cron-manager/test/crontab.test.js`

- [ ] **Step 1: Write failing tests for rewrites**

Append to `test/crontab.test.js`:

```js
const { commentLine, uncommentLine, editSchedule, removeLine } = require('../server/crontab');

const TWO = [
  '# header',
  '0 6 * * 1     bash ops/scripts/run-worker.sh planner',
  '*/15 * * * *  bash ops/scripts/run-scraper.sh',
].join('\n');

test('commentLine prefixes the target line and preserves all others', () => {
  const out = commentLine(TWO, 1, '0 6 * * 1     bash ops/scripts/run-worker.sh planner');
  const lines = out.split('\n');
  assert.strictEqual(lines[0], '# header');                                  // untouched
  assert.strictEqual(lines[1], '# 0 6 * * 1     bash ops/scripts/run-worker.sh planner');
  assert.strictEqual(lines[2], '*/15 * * * *  bash ops/scripts/run-scraper.sh'); // untouched
});

test('uncommentLine reverses commentLine exactly', () => {
  const commented = commentLine(TWO, 1, '0 6 * * 1     bash ops/scripts/run-worker.sh planner');
  const back = uncommentLine(commented, 1, '# 0 6 * * 1     bash ops/scripts/run-worker.sh planner');
  assert.strictEqual(back, TWO);
});

test('editSchedule replaces only the schedule, keeps the command', () => {
  const out = editSchedule(TWO, 1, '0 7 * * 2', '0 6 * * 1     bash ops/scripts/run-worker.sh planner');
  const lines = out.split('\n');
  assert.strictEqual(lines[1], '0 7 * * 2  bash ops/scripts/run-worker.sh planner');
  assert.strictEqual(lines[2], '*/15 * * * *  bash ops/scripts/run-scraper.sh'); // untouched
});

test('editSchedule rejects an invalid cron expression', () => {
  assert.throws(() => editSchedule(TWO, 1, 'not a cron', '0 6 * * 1     bash ops/scripts/run-worker.sh planner'),
    /invalid cron/i);
});

test('rewrites reject when expected line does not match (concurrent edit guard)', () => {
  assert.throws(() => commentLine(TWO, 1, 'STALE LINE'), /changed/i);
  assert.throws(() => editSchedule(TWO, 1, '0 7 * * 2', 'STALE LINE'), /changed/i);
  assert.throws(() => removeLine(TWO, 1, 'STALE LINE'), /changed/i);
});

test('removeLine deletes the target line only', () => {
  const out = removeLine(TWO, 2, '*/15 * * * *  bash ops/scripts/run-scraper.sh');
  assert.strictEqual(out, ['# header', '0 6 * * 1     bash ops/scripts/run-worker.sh planner'].join('\n'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/cron-manager && npm test`
Expected: FAIL — `commentLine is not a function`.

- [ ] **Step 3: Implement the rewrite functions**

Add to `tools/cron-manager/server/crontab.js` before `module.exports`:

```js
function assertLine(lines, lineIndex, expectedRawLine) {
  if (lineIndex < 0 || lineIndex >= lines.length || lines[lineIndex] !== expectedRawLine) {
    const err = new Error('file changed since read — reload and retry');
    err.code = 'STALE';
    throw err;
  }
}

function commentLine(text, lineIndex, expectedRawLine) {
  const lines = text.split('\n');
  assertLine(lines, lineIndex, expectedRawLine);
  if (!lines[lineIndex].startsWith('#')) lines[lineIndex] = `# ${lines[lineIndex]}`;
  return lines.join('\n');
}

function uncommentLine(text, lineIndex, expectedRawLine) {
  const lines = text.split('\n');
  assertLine(lines, lineIndex, expectedRawLine);
  lines[lineIndex] = lines[lineIndex].replace(/^#\s?/, '');
  return lines.join('\n');
}

function editSchedule(text, lineIndex, newSchedule, expectedRawLine) {
  if (!isValidCron(newSchedule)) {
    throw new Error(`invalid cron expression: ${newSchedule}`);
  }
  const lines = text.split('\n');
  assertLine(lines, lineIndex, expectedRawLine);
  const m = lines[lineIndex].match(CRON_RE);
  if (!m) throw new Error('target line is not a cron entry');
  const prefix = m[1] || '';
  const command = m[3];
  lines[lineIndex] = `${prefix}${newSchedule.trim()}  ${command}`;
  return lines.join('\n');
}

function removeLine(text, lineIndex, expectedRawLine) {
  const lines = text.split('\n');
  assertLine(lines, lineIndex, expectedRawLine);
  lines.splice(lineIndex, 1);
  return lines.join('\n');
}
```

Update the `module.exports` line to:

```js
module.exports = { parseCrontab, isValidCron, extractRole, CRON_RE,
  commentLine, uncommentLine, editSchedule, removeLine };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/cron-manager && npm test`
Expected: PASS — all parse + rewrite tests green.

- [ ] **Step 5: Commit**

```bash
git add tools/cron-manager/server/crontab.js tools/cron-manager/test/crontab.test.js
git commit -m "feat(cron-manager): line-preserving crontab rewrites with stale-edit guard"
```

---

## Task 4: discovery.js — dynamic system discovery + enabled state

**Files:**
- Create: `tools/cron-manager/server/discovery.js`
- Create: `tools/cron-manager/test/discovery.test.js`

- [ ] **Step 1: Write failing tests using a temp repo fixture**

Create `tools/cron-manager/test/discovery.test.js`:

```js
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverSystems } = require('../server/discovery');

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-'));
  // site with a crontab + a disabled flag
  const ops = path.join(root, 'sites', 'americastrikes.com', 'ops');
  fs.mkdirSync(path.join(ops, 'docker'), { recursive: true });
  fs.writeFileSync(path.join(ops, 'docker', 'crontab.docker'),
    ['COMPOSE_PROJECT_NAME=americastrikes-ops',
     '0 6 * * 1  bash ops/scripts/run-worker.sh planner',
     '0 */4 * * *  bash ops/scripts/run-worker.sh engineer'].join('\n'));
  fs.writeFileSync(path.join(ops, '.engineer-disabled'), '');   // engineer paused
  // a tool with an inline-command crontab
  const tool = path.join(root, 'tools', 'site-tracker');
  fs.mkdirSync(tool, { recursive: true });
  fs.writeFileSync(path.join(tool, 'crontab.docker'),
    '*/15 * * * * cd /work/tools/site-tracker && site-tracker collect filesystem');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('discovers both site and tool cron systems', () => {
  const sys = discoverSystems(root);
  const slugs = sys.map(s => s.slug).sort();
  assert.deepStrictEqual(slugs, ['americastrikes.com', 'site-tracker']);
});

test('derives site project/container names (dot stripped)', () => {
  const site = discoverSystems(root).find(s => s.slug === 'americastrikes.com');
  assert.strictEqual(site.kind, 'site');
  assert.strictEqual(site.project, 'americastrikes-ops');
  assert.strictEqual(site.container, 'americastrikes-cron');
});

test('computes enabled state from the .<role>-disabled flag', () => {
  const site = discoverSystems(root).find(s => s.slug === 'americastrikes.com');
  const planner = site.entries.find(e => e.role === 'planner');
  const engineer = site.entries.find(e => e.role === 'engineer');
  assert.strictEqual(planner.enabled, true);
  assert.strictEqual(engineer.enabled, false);     // flag file present
});

test('tool entries (no role) are enabled when not commented out', () => {
  const tool = discoverSystems(root).find(s => s.slug === 'site-tracker');
  assert.strictEqual(tool.kind, 'tool');
  assert.strictEqual(tool.opsDir, null);
  assert.strictEqual(tool.entries[0].role, null);
  assert.strictEqual(tool.entries[0].enabled, true);
});

test('a newly-added site appears on re-scan (dynamic discovery)', () => {
  const ops = path.join(root, 'sites', 'newsite.com', 'ops', 'docker');
  fs.mkdirSync(ops, { recursive: true });
  fs.writeFileSync(path.join(ops, 'crontab.docker'), '0 9 1 * *  bash ops/scripts/run-worker.sh monthly-update');
  const slugs = discoverSystems(root).map(s => s.slug);
  assert.ok(slugs.includes('newsite.com'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/cron-manager && node --test test/discovery.test.js`
Expected: FAIL — `Cannot find module '../server/discovery'`.

- [ ] **Step 3: Implement discovery.js**

Create `tools/cron-manager/server/discovery.js`:

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseCrontab } = require('./crontab');

// site slug → compose name stem. The ops compose files name the project
// `<firstSegment>-ops` and the cron container `<firstSegment>-cron`
// (americastrikes.com → americastrikes). Verified against real `docker ps`
// in this task's Step 5.
function stem(slug) {
  return slug.split('.')[0];
}

function readDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

function withEnabled(entries, opsDir) {
  return entries.map((e) => {
    let enabled;
    if (e.role && opsDir) {
      enabled = !fs.existsSync(path.join(opsDir, `.${e.role}-disabled`));
    } else {
      enabled = !e.commented;
    }
    return { ...e, enabled };
  });
}

function buildSite(root, slug) {
  const crontabPath = path.join(root, 'sites', slug, 'ops', 'docker', 'crontab.docker');
  if (!fs.existsSync(crontabPath)) return null;
  const opsDir = path.join(root, 'sites', slug, 'ops');
  const { entries } = parseCrontab(fs.readFileSync(crontabPath, 'utf8'));
  const name = stem(slug);
  return {
    kind: 'site', slug, crontabPath, opsDir,
    project: `${name}-ops`, container: `${name}-cron`,
    entries: withEnabled(entries, opsDir),
  };
}

function buildTool(root, slug) {
  const crontabPath = path.join(root, 'tools', slug, 'crontab.docker');
  if (!fs.existsSync(crontabPath)) return null;
  const { entries } = parseCrontab(fs.readFileSync(crontabPath, 'utf8'));
  return {
    kind: 'tool', slug, crontabPath, opsDir: null,
    project: slug, container: slug,
    entries: withEnabled(entries, null),
  };
}

function discoverSystems(root) {
  const out = [];
  for (const slug of readDirs(path.join(root, 'sites'))) {
    const s = buildSite(root, slug);
    if (s) out.push(s);
  }
  for (const slug of readDirs(path.join(root, 'tools'))) {
    const t = buildTool(root, slug);
    if (t) out.push(t);
  }
  return out;
}

module.exports = { discoverSystems, stem };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/cron-manager && node --test test/discovery.test.js`
Expected: PASS — all discovery tests green.

Note: the `stem()` suffix-stripping yields `americastrikes` from `americastrikes.com`. Verify against the real repo in Step 5; the survey confirms container `americastrikes-cron`, project `americastrikes-ops`.

- [ ] **Step 5: Verify against the real repo**

Run: `cd tools/cron-manager && node -e "const {discoverSystems}=require('./server/discovery'); const s=discoverSystems(require('path').resolve('../..')); console.log(s.map(x=>({slug:x.slug,kind:x.kind,container:x.container,n:x.entries.length})))"`
Expected: lists the 8 sites + site-tracker/cf-stats/gh-stats with sensible container names and entry counts > 0. If any site container name mismatches its real `<name>-cron` (check `docker ps -a --format '{{.Names}}' | grep cron`), adjust `stem()`.

- [ ] **Step 6: Commit**

```bash
git add tools/cron-manager/server/discovery.js tools/cron-manager/test/discovery.test.js
git commit -m "feat(cron-manager): dynamic site+tool discovery with enabled-state computation"
```

---

## Task 5: docker.js — container status + rebuild

**Files:**
- Create: `tools/cron-manager/server/docker.js`
- Create: `tools/cron-manager/test/docker.test.js`

- [ ] **Step 1: Write failing tests with an injected exec**

Create `tools/cron-manager/test/docker.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { containerStatus } = require('../server/docker');

function fakeExec(output) {
  return async () => ({ stdout: output, stderr: '' });
}

test('running container → running', async () => {
  const st = await containerStatus('americastrikes-cron', fakeExec('Up 3 hours\n'));
  assert.strictEqual(st, 'running');
});

test('exited container → stopped', async () => {
  const st = await containerStatus('americastrikes-cron', fakeExec('Exited (0) 2 days ago\n'));
  assert.strictEqual(st, 'stopped');
});

test('no such container → never-built', async () => {
  const st = await containerStatus('nope-cron', fakeExec('\n'));
  assert.strictEqual(st, 'never-built');
});

test('docker error → never-built (degrades, never throws)', async () => {
  const throwingExec = async () => { throw new Error('docker daemon unreachable'); };
  const st = await containerStatus('x-cron', throwingExec);
  assert.strictEqual(st, 'never-built');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/cron-manager && node --test test/docker.test.js`
Expected: FAIL — `Cannot find module '../server/docker'`.

- [ ] **Step 3: Implement docker.js**

Create `tools/cron-manager/server/docker.js`:

```js
'use strict';

const { exec } = require('node:child_process');
const { promisify } = require('node:util');
const execP = promisify(exec);

// Returns "running" | "stopped" | "never-built".
// `runner` is injectable for tests; defaults to the real docker CLI.
async function containerStatus(container, runner = defaultRunner) {
  try {
    const { stdout } = await runner(
      `docker ps -a --filter name=^/${container}$ --format "{{.Status}}"`
    );
    const status = stdout.trim();
    if (!status) return 'never-built';
    return /^Up\b/.test(status) ? 'running' : 'stopped';
  } catch {
    return 'never-built';
  }
}

function defaultRunner(cmd) {
  return execP(cmd, { timeout: 10000 });
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

module.exports = { containerStatus, rebuildCron };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/cron-manager && node --test test/docker.test.js`
Expected: PASS — all 4 status tests green.

- [ ] **Step 5: Commit**

```bash
git add tools/cron-manager/server/docker.js tools/cron-manager/test/docker.test.js
git commit -m "feat(cron-manager): docker container status + cron rebuild helper"
```

---

## Task 6: server.js — routes wiring

**Files:**
- Create: `tools/cron-manager/server/server.js`

This task wires the libraries to HTTP. The pure logic is already tested; here we add one integration test that boots the server against a temp repo and exercises the read + toggle endpoints over HTTP.

- [ ] **Step 1: Write a failing integration test**

Create `tools/cron-manager/test/server.test.js`:

```js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/server');

let root, server, base;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-srv-'));
  const ops = path.join(root, 'sites', 'demo.com', 'ops', 'docker');
  fs.mkdirSync(ops, { recursive: true });
  fs.writeFileSync(path.join(ops, 'crontab.docker'),
    '0 6 * * 1  bash ops/scripts/run-worker.sh planner');
  // status runner stubbed so the test never shells out to docker
  const app = createApp({ root, statusRunner: async () => ({ stdout: '', stderr: '' }) });
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('GET /api/systems lists discovered systems', async () => {
  const r = await fetch(`${base}/api/systems`);
  const body = await r.json();
  assert.strictEqual(r.status, 200);
  const demo = body.find((s) => s.slug === 'demo.com');
  assert.ok(demo);
  assert.strictEqual(demo.entries[0].role, 'planner');
  assert.strictEqual(demo.entries[0].enabled, true);
});

test('POST disable creates the flag; enable removes it', async () => {
  const flag = path.join(root, 'sites', 'demo.com', 'ops', '.planner-disabled');
  let r = await fetch(`${base}/api/systems/demo.com/jobs/planner/disable`, { method: 'POST' });
  assert.strictEqual(r.status, 200);
  assert.ok(fs.existsSync(flag), 'flag created');
  r = await fetch(`${base}/api/systems/demo.com/jobs/planner/enable`, { method: 'POST' });
  assert.strictEqual(r.status, 200);
  assert.ok(!fs.existsSync(flag), 'flag removed');
});

test('POST crontab edit rewrites the schedule on disk', async () => {
  const r = await fetch(`${base}/api/systems/demo.com/crontab`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'edit', lineIndex: 0, newSchedule: '0 7 * * 2',
      expectedRawLine: '0 6 * * 1  bash ops/scripts/run-worker.sh planner',
    }),
  });
  assert.strictEqual(r.status, 200);
  const text = fs.readFileSync(path.join(root, 'sites', 'demo.com', 'ops', 'docker', 'crontab.docker'), 'utf8');
  assert.ok(text.startsWith('0 7 * * 2  bash ops/scripts/run-worker.sh planner'));
});

test('rejects an unknown system slug', async () => {
  const r = await fetch(`${base}/api/systems/does-not-exist/jobs/x/disable`, { method: 'POST' });
  assert.strictEqual(r.status, 404);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/cron-manager && node --test test/server.test.js`
Expected: FAIL — `Cannot find module '../server/server'`.

- [ ] **Step 3: Implement server.js**

Create `tools/cron-manager/server/server.js`:

```js
'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const cronstrue = require('cronstrue');

const { discoverSystems } = require('./discovery');
const { containerStatus, rebuildCron } = require('./docker');
const crontab = require('./crontab');

const DEFAULT_ROOT = process.env.CM_DOMAINS_ROOT
  || path.resolve(__dirname, '..', '..', '..');     // tools/cron-manager/server → repo root
const PORT = parseInt(process.env.CM_PORT || '4753', 10);
const HOST = process.env.CM_HOST || '127.0.0.1';

function describe(expr) {
  try { return cronstrue.toString(expr, { use24HourTimeFormat: false }); }
  catch { return expr; }
}

function findSystem(root, slug) {
  return discoverSystems(root).find((s) => s.slug === slug) || null;
}

function createApp({ root = DEFAULT_ROOT, statusRunner } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // List all systems, with container status + human schedules.
  app.get('/api/systems', async (_req, res) => {
    const systems = discoverSystems(root);
    for (const s of systems) {
      s.status = await containerStatus(s.container, statusRunner);
      s.entries = s.entries.map((e) => ({ ...e, human: describe(e.schedule) }));
    }
    res.json(systems);
  });

  // Instant enable/disable for run-worker.sh roles (flag file).
  app.post('/api/systems/:slug/jobs/:role/:action', (req, res) => {
    const { slug, role, action } = req.params;
    const sys = findSystem(root, slug);
    if (!sys) return res.status(404).json({ error: 'unknown system' });
    if (!sys.opsDir) return res.status(400).json({ error: 'tool jobs have no role flags; use crontab comment' });
    if (!/^[A-Za-z0-9._-]+$/.test(role)) return res.status(400).json({ error: 'bad role' });
    const flag = path.join(sys.opsDir, `.${role}-disabled`);
    try {
      if (action === 'disable') fs.writeFileSync(flag, '');
      else if (action === 'enable') { if (fs.existsSync(flag)) fs.unlinkSync(flag); }
      else return res.status(400).json({ error: 'bad action' });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // File-mutating actions: comment/uncomment/edit/remove. Marks pending rebuild.
  app.post('/api/systems/:slug/crontab', (req, res) => {
    const sys = findSystem(root, req.params.slug);
    if (!sys) return res.status(404).json({ error: 'unknown system' });
    const { action, lineIndex, newSchedule, expectedRawLine } = req.body || {};
    let text;
    try { text = fs.readFileSync(sys.crontabPath, 'utf8'); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    let out;
    try {
      if (action === 'comment') out = crontab.commentLine(text, lineIndex, expectedRawLine);
      else if (action === 'uncomment') out = crontab.uncommentLine(text, lineIndex, expectedRawLine);
      else if (action === 'edit') out = crontab.editSchedule(text, lineIndex, newSchedule, expectedRawLine);
      else if (action === 'remove') out = crontab.removeLine(text, lineIndex, expectedRawLine);
      else return res.status(400).json({ error: 'bad action' });
    } catch (e) {
      const code = e.code === 'STALE' ? 409 : 400;
      return res.status(code).json({ error: e.message });
    }
    try { fs.writeFileSync(sys.crontabPath, out); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    return res.json({ ok: true, pendingRebuild: true });
  });

  // Rebuild + restart this system's cron container; stream output.
  app.post('/api/systems/:slug/rebuild', async (req, res) => {
    const sys = findSystem(root, req.params.slug);
    if (!sys) return res.status(404).json({ error: 'unknown system' });
    const cwd = path.dirname(sys.kind === 'site' ? path.join(sys.opsDir, '..') : sys.crontabPath);
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    const result = await rebuildCron(cwd, (d) => res.write(d));
    res.write(`\n[exit ${result.code}] ${result.ok ? 'OK' : 'FAILED'}\n`);
    res.end();
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(PORT, HOST, () => console.log(`cron-manager on http://${HOST}:${PORT}`));
}

module.exports = { createApp, describe };
```

Note: for a `site`, the compose project root is the site dir (`sites/<slug>`), where `docker-compose.yml` lives — that is `path.join(sys.opsDir, '..')`. For a `tool`, it is `tools/<slug>` = `path.dirname(crontabPath)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/cron-manager && node --test test/server.test.js`
Expected: PASS — all 4 server integration tests green.

- [ ] **Step 5: Run the full suite**

Run: `cd tools/cron-manager && npm test`
Expected: PASS — crontab, discovery, docker, server suites all green.

- [ ] **Step 6: Commit**

```bash
git add tools/cron-manager/server/server.js tools/cron-manager/test/server.test.js
git commit -m "feat(cron-manager): express routes — list, toggle, crontab edit, rebuild"
```

---

## Task 7: Frontend panel

**Files:**
- Create: `tools/cron-manager/server/public/index.html`
- Create: `tools/cron-manager/server/public/app.js`
- Create: `tools/cron-manager/server/public/style.css`

No unit test (static assets); verified by the manual smoke in Task 9.

- [ ] **Step 1: Create index.html**

Create `tools/cron-manager/server/public/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cron Manager — Domains Portfolio</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <header>
    <h1>Cron Manager</h1>
    <p class="sub">Every cron system across the portfolio. Pause a role instantly; edits need a rebuild.</p>
    <button id="refresh">Refresh</button>
  </header>
  <main id="systems">Loading…</main>
  <div id="logModal" class="modal hidden">
    <div class="modal-body"><h3>Rebuild output</h3><pre id="logOut"></pre><button id="logClose">Close</button></div>
  </div>
  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create app.js**

Create `tools/cron-manager/server/public/app.js`:

```js
const $ = (sel, el = document) => el.querySelector(sel);

async function load() {
  const main = $('#systems');
  main.textContent = 'Loading…';
  const systems = await (await fetch('/api/systems')).json();
  main.innerHTML = '';
  for (const sys of systems) main.appendChild(renderSystem(sys));
}

function renderSystem(sys) {
  const card = document.createElement('section');
  card.className = 'card';
  const badge = `<span class="status ${sys.status}">${sys.status}</span>`;
  card.innerHTML = `<h2>${sys.slug} <span class="kind">${sys.kind}</span> ${badge}
    <span class="container">${sys.container}</span></h2>`;
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>State</th><th>Schedule</th><th>Runs</th><th>Actions</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const e of sys.entries) tbody.appendChild(renderRow(sys, e));
  table.appendChild(tbody);
  card.appendChild(table);
  const rebuild = document.createElement('button');
  rebuild.textContent = 'Rebuild & restart cron';
  rebuild.className = 'rebuild';
  rebuild.onclick = () => doRebuild(sys.slug);
  card.appendChild(rebuild);
  return card;
}

function renderRow(sys, e) {
  const tr = document.createElement('tr');
  if (!e.enabled) tr.classList.add('paused');
  const label = e.role ? `<code>${e.role}</code>` : `<span class="cmd">${escapeHtml(e.command)}</span>`;
  tr.innerHTML = `
    <td>${e.enabled ? '🟢 on' : '⏸ paused'}</td>
    <td title="${escapeHtml(e.schedule)}">${escapeHtml(e.human || e.schedule)}</td>
    <td>${label}</td>`;
  const actions = document.createElement('td');

  const toggle = document.createElement('button');
  toggle.textContent = e.enabled ? 'Pause' : 'Resume';
  toggle.onclick = () => toggleJob(sys, e);
  actions.appendChild(toggle);

  const edit = document.createElement('button');
  edit.textContent = 'Edit';
  edit.onclick = () => editJob(sys, e);
  actions.appendChild(edit);

  const remove = document.createElement('button');
  remove.textContent = 'Remove';
  remove.className = 'danger';
  remove.onclick = () => removeJob(sys, e);
  actions.appendChild(remove);

  tr.appendChild(actions);
  return tr;
}

async function toggleJob(sys, e) {
  if (e.role && sys.kind === 'site') {
    const action = e.enabled ? 'disable' : 'enable';
    await post(`/api/systems/${sys.slug}/jobs/${e.role}/${action}`);
  } else {
    const action = e.enabled ? 'comment' : 'uncomment';
    await postCrontab(sys, { action, lineIndex: e.lineIndex, expectedRawLine: e.rawLine });
  }
  load();
}

async function editJob(sys, e) {
  const newSchedule = prompt(`New cron schedule for "${e.role || e.command}":`, e.schedule);
  if (!newSchedule) return;
  await postCrontab(sys, { action: 'edit', lineIndex: e.lineIndex, newSchedule, expectedRawLine: e.rawLine });
  load();
}

async function removeJob(sys, e) {
  if (!confirm(`Remove this line from ${sys.slug}'s crontab?\n\n${e.rawLine}`)) return;
  await postCrontab(sys, { action: 'remove', lineIndex: e.lineIndex, expectedRawLine: e.rawLine });
  load();
}

async function postCrontab(sys, payload) {
  const r = await fetch(`/api/systems/${sys.slug}/crontab`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!r.ok) alert((await r.json()).error || 'failed');
  else alert('Saved. This change needs a rebuild to go live — click "Rebuild & restart cron".');
}

async function post(url) {
  const r = await fetch(url, { method: 'POST' });
  if (!r.ok) alert((await r.json()).error || 'failed');
}

async function doRebuild(slug) {
  const modal = $('#logModal'); const out = $('#logOut');
  out.textContent = ''; modal.classList.remove('hidden');
  const r = await fetch(`/api/systems/${slug}/rebuild`, { method: 'POST' });
  const reader = r.body.getReader(); const dec = new TextDecoder();
  for (;;) { const { done, value } = await reader.read(); if (done) break; out.textContent += dec.decode(value); }
  load();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

$('#refresh').onclick = load;
$('#logClose').onclick = () => $('#logModal').classList.add('hidden');
load();
```

- [ ] **Step 3: Create style.css**

Create `tools/cron-manager/server/public/style.css`:

```css
:root { --bg:#0f1115; --card:#181b22; --line:#2a2f3a; --fg:#e6e9ef; --muted:#8b93a7; --accent:#6ea8fe; }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.5 system-ui, sans-serif; background:var(--bg); color:var(--fg); }
header { padding:16px 24px; border-bottom:1px solid var(--line); }
header h1 { margin:0; font-size:20px; }
header .sub { margin:4px 0 8px; color:var(--muted); }
main { padding:24px; display:grid; gap:20px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; }
.card h2 { margin:0 0 12px; font-size:16px; display:flex; gap:10px; align-items:center; }
.kind { font-size:11px; color:var(--muted); border:1px solid var(--line); padding:1px 6px; border-radius:6px; }
.container { margin-left:auto; font-family:monospace; color:var(--muted); font-size:12px; }
.status { font-size:11px; padding:1px 8px; border-radius:6px; }
.status.running { background:#10391f; color:#7ee2a8; }
.status.stopped { background:#3a2417; color:#f0a878; }
.status.never-built { background:#2a2f3a; color:var(--muted); }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:6px 8px; border-top:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; font-size:12px; }
tr.paused { opacity:.55; }
td .cmd { font-family:monospace; font-size:12px; color:var(--muted); }
button { background:#222632; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:4px 10px; margin-right:6px; cursor:pointer; }
button:hover { border-color:var(--accent); }
button.danger:hover { border-color:#f0786e; color:#f0786e; }
button.rebuild { margin-top:12px; }
.modal { position:fixed; inset:0; background:rgba(0,0,0,.6); display:flex; align-items:center; justify-content:center; }
.modal.hidden { display:none; }
.modal-body { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:20px; width:min(800px,90vw); max-height:80vh; overflow:auto; }
.modal-body pre { background:#0b0d11; padding:12px; border-radius:6px; overflow:auto; max-height:55vh; }
```

- [ ] **Step 4: Commit**

```bash
git add tools/cron-manager/server/public/
git commit -m "feat(cron-manager): web panel (list, toggle, edit, remove, rebuild)"
```

---

## Task 8: Containerization + docs

**Files:**
- Create: `tools/cron-manager/Dockerfile`
- Create: `tools/cron-manager/docker-compose.yml`
- Create: `tools/cron-manager/README.md`

- [ ] **Step 1: Create Dockerfile**

Create `tools/cron-manager/Dockerfile`:

```dockerfile
# cron-manager panel. Needs the docker CLI (status + rebuild) and the repo
# bind-mounted at the SAME absolute path as the host so `docker compose`
# invocations resolve volume sources correctly.
FROM node:22-alpine

RUN apk add --no-cache docker-cli docker-cli-compose bash

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server ./server

ENV CM_HOST=0.0.0.0
EXPOSE 4753
CMD ["node", "server/server.js"]
```

- [ ] **Step 2: Create docker-compose.yml**

Create `tools/cron-manager/docker-compose.yml`:

```yaml
name: cron-manager

services:
  panel:
    build: .
    image: cron-manager:latest
    container_name: cron-manager
    restart: unless-stopped
    # Loopback-only publish — same posture as domain-developer.
    ports:
      - "127.0.0.1:4753:4753"
    environment:
      # The repo root, bind-mounted at the SAME path inside the container so
      # `docker compose build/up` for a site resolves its volume sources.
      CM_DOMAINS_ROOT: ${PWD:-/home/jesse/projects/domains}/../..
      CM_HOST: 0.0.0.0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${HOME:-/home/jesse}/projects/domains:${HOME:-/home/jesse}/projects/domains
      - ${HOME:-/home/jesse}/.docker:${HOME:-/home/jesse}/.docker
    working_dir: ${HOME:-/home/jesse}/projects/domains/tools/cron-manager
```

Note: set `CM_DOMAINS_ROOT` to the absolute repo root inside the container. Because the repo is bind-mounted at its host path, use that exact path. Step 4 verifies this resolves correctly; if `${PWD}/../..` is awkward in compose, hardcode `CM_DOMAINS_ROOT: /home/jesse/projects/domains`.

- [ ] **Step 3: Create README.md**

Create `tools/cron-manager/README.md`:

```markdown
# cron-manager

Portfolio cron control panel. Discovers every cron system across the domains
repo — each `sites/*/ops/docker/crontab.docker` and `tools/*/crontab.docker` —
and lets you see what runs, pause/resume jobs, edit schedules, and remove jobs.

Dynamic: any new site that follows the standard `ops/` layout appears
automatically. No registry to maintain.

## Run

Local (host Node):

    npm install
    npm start            # http://127.0.0.1:4753

Containerized:

    docker compose up -d --build
    # panel at http://127.0.0.1:4753

## How actions apply

- **Pause / Resume a role** (lines that call `run-worker.sh <role>`):
  toggles `ops/.<role>-disabled`. **Instant** — the next scheduled fire is
  skipped by `run-worker.sh`. No rebuild, no container bounce. This is the
  everyday "pause the content writer" path.
- **Edit schedule / Remove / Pause a non-role line** (tool commands, pruning,
  `run-deployer.sh`, etc.): rewrites `crontab.docker`. Because that file is
  baked into the cron image (`COPY` in `Dockerfile.cron`), the change is **not
  live** until you click **Rebuild & restart cron** for that system.

## New roles

This tool manages existing jobs. To add a *new* autonomous role to a site, use
the `domains-agent-cron-role-engineer` skill, which scaffolds the role file,
crontab line, and supporting scripts.

## Test

    npm test
```

- [ ] **Step 4: Verify the container build + discovery path**

Run: `cd tools/cron-manager && docker compose up -d --build && sleep 3 && curl -s http://127.0.0.1:4753/api/systems | head -c 400; echo`
Expected: JSON array including `americastrikes.com`, other sites, and the tools. If empty, fix `CM_DOMAINS_ROOT` to the absolute repo root (`/home/jesse/projects/domains`) and `docker compose up -d` again.

- [ ] **Step 5: Commit**

```bash
git add tools/cron-manager/Dockerfile tools/cron-manager/docker-compose.yml tools/cron-manager/README.md
git commit -m "feat(cron-manager): containerization + README"
```

---

## Task 9: End-to-end smoke + .gitignore

**Files:**
- Create: `tools/cron-manager/.gitignore`

- [ ] **Step 1: Add .gitignore**

Create `tools/cron-manager/.gitignore`:

```
node_modules/
```

- [ ] **Step 2: Full test suite**

Run: `cd tools/cron-manager && npm test`
Expected: PASS — all suites (crontab, discovery, docker, server).

- [ ] **Step 3: Manual smoke against the real repo (host)**

Run: `cd tools/cron-manager && CM_PORT=4753 node server/server.js &` then `sleep 1 && curl -s http://127.0.0.1:4753/api/systems | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.map(s=>s.slug+':'+s.entries.length+' jobs ('+s.status+')').join('\n'))})"`
Expected: prints all 8 sites + 3 tools with job counts and a status each. Then `kill %1`.

- [ ] **Step 4: Verify a non-destructive toggle round-trips on a real site**

Pick a paused-safe role (e.g. on a site where pausing one cron run is harmless). Run:
`touch /tmp/marker; curl -s -X POST http://127.0.0.1:4753/api/systems/xxxtea.com/jobs/seo-analyst/disable` (server must be running)
Expected: `{"ok":true}` and `sites/xxxtea.com/ops/.seo-analyst-disabled` now exists.
Then re-enable: `curl -s -X POST http://127.0.0.1:4753/api/systems/xxxtea.com/jobs/seo-analyst/enable`
Expected: `{"ok":true}` and the flag file is gone (`git status` shows clean — no stray flag committed).

- [ ] **Step 5: Confirm no stray files left**

Run: `cd /home/jesse/projects/domains && git status --porcelain sites/`
Expected: no `.‑disabled` flag files lingering from the smoke test.

- [ ] **Step 6: Commit**

```bash
git add tools/cron-manager/.gitignore
git commit -m "chore(cron-manager): gitignore node_modules"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** discovery (Task 4), parse/state (Tasks 2,4), four verbs (Tasks 3,6), instant role-disable vs rebuild-gated edits (Tasks 5,6,7), tools included with comment-out disable (Tasks 2,4,6,7), loopback bind + Docker socket + same-path mount (Task 8), path confinement via discovered-system lookup before any write (Task 6), concurrent-edit guard (Task 3), testing (every task). All covered.
- **Type consistency:** `Entry`/`System` shapes used identically across `crontab.js` → `discovery.js` → `server.js` → `app.js`. Function names (`parseCrontab`, `commentLine`, `uncommentLine`, `editSchedule`, `removeLine`, `discoverSystems`, `containerStatus`, `rebuildCron`, `createApp`) match across tasks.
- **Open verification point:** `stem()` site→container naming is checked against real `docker ps` names in Task 4 Step 5; the only likely adjustment in the whole plan.
```
