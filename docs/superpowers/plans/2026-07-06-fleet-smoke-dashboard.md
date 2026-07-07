# Fleet Smoke Dashboard Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Fleet Smoke" tab to `tools/fleet-dashboard` giving per-site levers (checks enabled, Slack enabled, run now, add config) over the centralized `tools/fleet-smoke` health-check tool, backed by a small persistence fix in fleet-smoke itself so the dashboard can show the real ✅/🔧/🆘 status instead of a degraded 2-state approximation.

**Architecture:** New backend module `tools/fleet-dashboard/server/fleet-smoke.js` (reads `sites/*/ops/smoke.yaml` + `tools/fleet-smoke/state/*.json`, mutates via the already-existing `git.js` commit/push helpers), 5 new Express routes in `server.js`, and one new view + nav tab in the existing single-page `app.js`/`index.html`. A small upstream addition to `tools/fleet-smoke/lib/status.py` persists the `headline_word` ("healthy"/"recovered"/"attention") into each site's state JSON, which today only stores the fail count — without this, the dashboard cannot distinguish "recovered" from "healthy" on a plain read (that distinction requires comparing against the *previous* run, which the state file overwrites every tick).

**Tech Stack:** Node/Express (dashboard backend, `js-yaml` — already a dependency), vanilla JS (dashboard frontend, no framework), Python (the one-line fleet-smoke persistence fix), `node:test` for backend tests, `pytest` for the Python fix's test.

## Global Constraints

- No new npm dependency — `js-yaml` is already in `tools/fleet-dashboard/package.json`.
- No new Python dependency for the `lib/status.py` change.
- Every mutating dashboard route must validate `:slug` via the existing `isKnownSite`/`requireSite` gate before touching the filesystem or git — never trust a raw path parameter.
- Toggle/add-config actions push directly to a site's `main` branch (auto-deploys via CF Workers Builds) — every one needs a client-side confirm before the request fires.
- Reuse existing helpers, do not reimplement: `git.commit(root, slug, paths, message)` and `git.push(root, slug)` from `server/git.js`; `discoverSites(root)`/`isKnownSite(root, slug)`/`siteDir(root, slug)` from `server/sites.js`; `api()`/`toast()`/`esc()`/`gdBusy()` from `app.js`.
- Status icon is read verbatim from the state file's `headline_word` — this constraint was written before Task 1 (persisting `headline_word` directly) existed as a separate prerequisite; once that landed, a plain `GET /sites` CAN legitimately show `"recovered"` for one tick after a site self-heals, same as the Slack message would have said. That's correct and benign (self-heals to `"healthy"` next tick) — not a bug.

---

## File Structure

```
tools/fleet-smoke/
├── lib/status.py                      — MODIFY: save_state gains headline_word param
└── tests/test_status.py               — MODIFY: update the roundtrip test for the new field
└── run_fleet_smoke.py                 — MODIFY: pass headline_word to save_state

tools/fleet-dashboard/
├── server/
│   ├── fleet-smoke.js                 — NEW: listSites, toggle, addConfig, runNow
│   ├── fleet-smoke.test.js            — NEW
│   └── server.js                      — MODIFY: register 5 routes
└── server/public/
    ├── index.html                     — MODIFY: add nav tab button
    └── app.js                         — MODIFY: add TOP_VIEWS entry, parseHash case,
                                          render() branch, renderFleetSmoke() + handlers
```

---

## Task 1: Persist `headline_word` in fleet-smoke's state file

**Files:**
- Modify: `tools/fleet-smoke/lib/status.py`
- Modify: `tools/fleet-smoke/tests/test_status.py`
- Modify: `tools/fleet-smoke/run_fleet_smoke.py:54`

**Interfaces:**
- Produces: `save_state(state_dir, site_name, fail_count, headline_word)` — now REQUIRES a 4th positional arg (was 3). The state JSON on disk becomes `{"fail": <int>, "headline_word": <str>}`. This is what Task 2's dashboard reader consumes (it reads `headline_word` directly instead of re-deriving it from `fail` alone).

- [ ] **Step 1: Update the existing test to expect the new field**

Open `tools/fleet-smoke/tests/test_status.py` and replace the existing `test_save_then_load_state_roundtrips` test:

```python
def test_save_then_load_state_roundtrips(tmp_path):
    save_state(str(tmp_path), "example.com", 3, "attention")
    state = load_state(str(tmp_path), "example.com")
    assert state == {"fail": 3, "headline_word": "attention"}

    # written under a per-site filename, not clobbering other sites
    save_state(str(tmp_path), "other.com", 0, "healthy")
    assert load_state(str(tmp_path), "example.com") == {"fail": 3, "headline_word": "attention"}
    assert load_state(str(tmp_path), "other.com") == {"fail": 0, "headline_word": "healthy"}
```

- [ ] **Step 2: Run the test suite to verify this test now fails**

Run: `cd /home/jesse/projects/domains/tools/fleet-smoke && python3 -m pytest tests/test_status.py -v`
Expected: `test_save_then_load_state_roundtrips` FAILS with a `TypeError: save_state() missing 1 required positional argument: 'headline_word'` (the implementation hasn't changed yet — only the test has).

- [ ] **Step 3: Update `save_state` to accept and persist `headline_word`**

In `tools/fleet-smoke/lib/status.py`, replace the `save_state` function:

```python
def save_state(state_dir, site_name, fail_count, headline_word):
    os.makedirs(state_dir, exist_ok=True)
    path = _state_path(state_dir, site_name)
    with open(path, "w") as f:
        json.dump({"fail": fail_count, "headline_word": headline_word}, f)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/jesse/projects/domains/tools/fleet-smoke && python3 -m pytest tests/test_status.py -v`
Expected: 6 passed

- [ ] **Step 5: Update the one production call site**

In `tools/fleet-smoke/run_fleet_smoke.py`, `check_one_site` currently has (around line 51-54):

```python
    fail_count = sum(1 for r in results if not r["ok"])
    prev = load_state(state_dir, site_name)
    icon, color, headline_word = compute_status(fail_count, prev.get("fail", 0))
    save_state(state_dir, site_name, fail_count)
```

Change the last line to pass `headline_word` through (it's already computed on the line above):

```python
    fail_count = sum(1 for r in results if not r["ok"])
    prev = load_state(state_dir, site_name)
    icon, color, headline_word = compute_status(fail_count, prev.get("fail", 0))
    save_state(state_dir, site_name, fail_count, headline_word)
```

- [ ] **Step 6: Run the full fleet-smoke test suite**

Run: `cd /home/jesse/projects/domains/tools/fleet-smoke && python3 -m pytest -v`
Expected: 30 passed (no other test touches `save_state`'s call signature)

- [ ] **Step 7: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/fleet-smoke/lib/status.py tools/fleet-smoke/tests/test_status.py tools/fleet-smoke/run_fleet_smoke.py
git commit -m "fleet-smoke: persist headline_word in state so consumers don't have to re-derive it"
git push origin main
```

- [ ] **Step 8: Rebuild the running fleet-smoke container** (code changed — the "sinderella guard" applies here too)

```bash
cd /home/jesse/projects/domains/tools/fleet-smoke
docker compose build fleet-smoke-cron
docker compose up -d --force-recreate fleet-smoke-cron
sleep 3
docker inspect --format '{{.State.Status}}' fleet-smoke
```
Expected: `running`

---

## Task 2: Dashboard backend — read model (`listSites`) and the toggle mutation

**Files:**
- Create: `tools/fleet-dashboard/server/fleet-smoke.js`
- Create: `tools/fleet-dashboard/server/fleet-smoke.test.js`

**Interfaces:**
- Consumes: `discoverSites(root)` from `./sites.js`; `git.commit(root, slug, paths, message)` and `git.push(root, slug)` from `./git.js` (both already exist, both throw an `Error` with `.httpStatus` on failure — `git.commit` synchronously stages+commits `ops/smoke.yaml`, `git.push` pushes the current branch).
- Produces: `listSites(root) -> Array<Row>` where `Row` is `{slug, configured, enabled?, slackEnabled?, checksCount?, status}` (optional fields present only when `configured: true`), `status` is `null | {icon: "healthy"|"attention"|"recovered", pass: number, total: number}`. `toggleField(root, slug, field, value) -> Promise<{ok: true, pushed: boolean, pushError?: string, row: Row}>` where `field` is exactly `"enabled"` or `"slack.enabled"`.

- [ ] **Step 1: Write the failing tests**

```javascript
// tools/fleet-dashboard/server/fleet-smoke.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const fleetSmoke = require('./fleet-smoke');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-fleet-smoke-'));
  fs.mkdirSync(path.join(root, 'sites'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools', 'fleet-smoke', 'state'), { recursive: true });
  return root;
}

function writeConfig(root, slug, yamlText) {
  const opsDir = path.join(root, 'sites', slug, 'ops');
  fs.mkdirSync(opsDir, { recursive: true });
  fs.writeFileSync(path.join(opsDir, 'smoke.yaml'), yamlText);
}

function writeState(root, slug, obj) {
  fs.writeFileSync(path.join(root, 'tools', 'fleet-smoke', 'state', `${slug}.json`), JSON.stringify(obj));
}

test('listSites: an unconfigured site (no ops/smoke.yaml) reports configured:false and status:null', () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, 'sites', 'bare.com', 'ops'), { recursive: true });
  const rows = fleetSmoke.listSites(root, ['bare.com']);
  assert.deepEqual(rows, [{ slug: 'bare.com', configured: false, status: null }]);
});

test('listSites: a configured, never-run site reports status:null', () => {
  const root = makeRoot();
  writeConfig(root, 'never-run.com', 'apex: never-run.com\nenabled: true\nchecks:\n  - path: /\n    expect: 200\n    label: Homepage\n');
  const rows = fleetSmoke.listSites(root, ['never-run.com']);
  assert.equal(rows[0].configured, true);
  assert.equal(rows[0].enabled, true);
  assert.equal(rows[0].slackEnabled, true);
  assert.equal(rows[0].checksCount, 1);
  assert.equal(rows[0].status, null);
});

test('listSites: a configured site with state shows healthy status derived from headline_word', () => {
  const root = makeRoot();
  writeConfig(root, 'ok.com', 'apex: ok.com\nchecks:\n  - path: /\n    expect: 200\n    label: Homepage\n  - path: /a\n    expect: 200\n    label: A\n');
  writeState(root, 'ok.com', { fail: 0, headline_word: 'healthy' });
  const rows = fleetSmoke.listSites(root, ['ok.com']);
  assert.deepEqual(rows[0].status, { icon: 'healthy', pass: 2, total: 2 });
});

test('listSites: slack.enabled:false is reported correctly', () => {
  const root = makeRoot();
  writeConfig(root, 'quiet.com', 'apex: quiet.com\nslack:\n  enabled: false\nchecks:\n  - path: /\n    expect: 200\n    label: Homepage\n');
  const rows = fleetSmoke.listSites(root, ['quiet.com']);
  assert.equal(rows[0].slackEnabled, false);
});

test('listSites: an unparseable YAML file surfaces a clear error, does not throw', () => {
  const root = makeRoot();
  const opsDir = path.join(root, 'sites', 'broken.com', 'ops');
  fs.mkdirSync(opsDir, { recursive: true });
  fs.writeFileSync(path.join(opsDir, 'smoke.yaml'), 'apex: [this is not valid: yaml::::');
  const rows = fleetSmoke.listSites(root, ['broken.com']);
  assert.equal(rows[0].configured, true);
  assert.match(rows[0].error, /invalid YAML/);
});

test('toggleField: flips "enabled" to false, leaves other fields untouched, commits via git.js', async () => {
  const root = makeRoot();
  writeConfig(root, 'site.com', 'apex: site.com\nenabled: true\nslack:\n  enabled: true\nchecks:\n  - path: /\n    expect: 200\n    label: Homepage\n');
  const calls = [];
  const fakeGit = {
    commit: async (r, slug, paths, message) => { calls.push(['commit', slug, paths, message]); return { ok: true, committed: 1 }; },
    push: async (r, slug) => { calls.push(['push', slug]); return { ok: true, out: 'done' }; },
  };
  const result = await fleetSmoke.toggleField(root, 'site.com', 'enabled', false, { git: fakeGit });
  assert.equal(result.pushed, true);
  assert.equal(result.row.enabled, false);
  assert.equal(result.row.slackEnabled, true); // untouched
  assert.deepEqual(calls[0], ['commit', 'site.com', ['ops/smoke.yaml'], 'fleet-smoke: toggle enabled for site.com']);
  assert.deepEqual(calls[1], ['push', 'site.com']);
});

test('toggleField: flips "slack.enabled" specifically, not top-level "enabled"', async () => {
  const root = makeRoot();
  writeConfig(root, 'site2.com', 'apex: site2.com\nenabled: true\nslack:\n  enabled: true\nchecks: []\n');
  const fakeGit = { commit: async () => ({ ok: true }), push: async () => ({ ok: true, out: '' }) };
  const result = await fleetSmoke.toggleField(root, 'site2.com', 'slack.enabled', false, { git: fakeGit });
  assert.equal(result.row.enabled, true);       // untouched
  assert.equal(result.row.slackEnabled, false); // flipped
});

test('toggleField: reports pushed:false with the error when push fails, without throwing', async () => {
  const root = makeRoot();
  writeConfig(root, 'site3.com', 'apex: site3.com\nenabled: true\nchecks: []\n');
  const fakeGit = {
    commit: async () => ({ ok: true }),
    push: async () => { const e = new Error('no upstream'); e.httpStatus = 500; throw e; },
  };
  const result = await fleetSmoke.toggleField(root, 'site3.com', 'enabled', false, { git: fakeGit });
  assert.equal(result.pushed, false);
  assert.match(result.pushError, /no upstream/);
  assert.equal(result.row.enabled, false); // the toggle itself still succeeded
});

test('toggleField: 404s (via thrown httpStatus) when the site has no ops/smoke.yaml', async () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, 'sites', 'nope.com', 'ops'), { recursive: true });
  const fakeGit = { commit: async () => ({ ok: true }), push: async () => ({ ok: true, out: '' }) };
  await assert.rejects(
    () => fleetSmoke.toggleField(root, 'nope.com', 'enabled', false, { git: fakeGit }),
    (err) => err.httpStatus === 404,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/jesse/projects/domains/tools/fleet-dashboard && node --test server/fleet-smoke.test.js`
Expected: FAIL with `Cannot find module './fleet-smoke'`

- [ ] **Step 3: Implement `server/fleet-smoke.js`**

```javascript
// tools/fleet-dashboard/server/fleet-smoke.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const gitDefault = require('./git');

function httpErr(status, msg) { const e = new Error(msg); e.httpStatus = status; return e; }

function smokeYamlPath(root, slug) {
  return path.join(root, 'sites', slug, 'ops', 'smoke.yaml');
}

function statePath(root, slug) {
  return path.join(root, 'tools', 'fleet-smoke', 'state', `${slug}.json`);
}

// Returns null if unconfigured, {error} if present-but-unparseable, else the parsed object.
function readConfig(root, slug) {
  const p = smokeYamlPath(root, slug);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  try {
    return { data: yaml.load(raw) || {} };
  } catch (e) {
    return { error: `invalid YAML in ${slug}/ops/smoke.yaml: ${e.message}` };
  }
}

function readState(root, slug) {
  const p = statePath(root, slug);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// One row for a single site. `configured` mirrors readConfig's three outcomes:
// no file → configured:false; unparseable → configured:true + error; else the
// full row with toggles + status.
function rowFor(root, slug) {
  const cfg = readConfig(root, slug);
  if (cfg === null) return { slug, configured: false, status: null };
  if (cfg.error) return { slug, configured: true, error: cfg.error, status: null };

  const data = cfg.data;
  const enabled = data.enabled !== false;
  const slackEnabled = !!(data.slack && data.slack.enabled);
  const checksCount = Array.isArray(data.checks) ? data.checks.length : 0;

  const state = readState(root, slug);
  let status = null;
  if (state && typeof state.fail === 'number' && typeof state.headline_word === 'string') {
    status = { icon: state.headline_word, pass: checksCount - state.fail, total: checksCount };
  }

  return { slug, configured: true, enabled, slackEnabled, checksCount, status };
}

function listSites(root, slugs) {
  return slugs.map((slug) => rowFor(root, slug));
}

// field is exactly "enabled" or "slack.enabled" — the only two levers this
// panel exposes. Anything else is a caller bug, not a user-facing 400 (the
// route layer only ever calls this with one of the two literals).
function applyField(data, field, value) {
  if (field === 'enabled') { data.enabled = value; return; }
  if (field === 'slack.enabled') {
    data.slack = data.slack || {};
    data.slack.enabled = value;
    return;
  }
  throw httpErr(400, `unknown field: ${field}`);
}

async function toggleField(root, slug, field, value, deps = {}) {
  const git = deps.git || gitDefault;
  const p = smokeYamlPath(root, slug);
  if (!fs.existsSync(p)) throw httpErr(404, `${slug} has no ops/smoke.yaml`);

  const raw = fs.readFileSync(p, 'utf8');
  let data;
  try { data = yaml.load(raw) || {}; }
  catch (e) { throw httpErr(500, `invalid YAML in ${slug}/ops/smoke.yaml: ${e.message}`); }

  applyField(data, field, value);
  fs.writeFileSync(p, yaml.dump(data));

  await git.commit(root, slug, ['ops/smoke.yaml'], `fleet-smoke: toggle ${field} for ${slug}`);

  let pushed = true, pushError;
  try { await git.push(root, slug); }
  catch (e) { pushed = false; pushError = e.message; }

  const row = rowFor(root, slug);
  return pushed ? { ok: true, pushed, row } : { ok: true, pushed, pushError, row };
}

module.exports = { listSites, rowFor, toggleField, smokeYamlPath, statePath };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/jesse/projects/domains/tools/fleet-dashboard && node --test server/fleet-smoke.test.js`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/fleet-dashboard/server/fleet-smoke.js tools/fleet-dashboard/server/fleet-smoke.test.js
git commit -m "fleet-dashboard: fleet-smoke read model + toggle mutation"
```

---

## Task 3: Dashboard backend — add-config scaffold and run-now

**Files:**
- Modify: `tools/fleet-dashboard/server/fleet-smoke.js`
- Modify: `tools/fleet-dashboard/server/fleet-smoke.test.js`

**Interfaces:**
- Consumes: `smokeYamlPath`, `statePath`, `rowFor` from this file (Task 2); `git.commit`/`git.push` (same as Task 2, injectable the same way).
- Produces: `addConfig(root, slug, deps = {}) -> Promise<{ok: true, pushed: boolean, pushError?: string, row: Row}>` (throws `httpStatus: 409` if already configured); `runNow(root, slug, deps = {}) -> Promise<{ok: true, row: Row}>` (throws `httpStatus: 404` if unconfigured, `httpStatus: 409` if the container isn't running, `httpStatus: 500` with the exec's stdout/stderr tail on a non-zero exit or timeout). `deps.exec` is the injectable exec function for `runNow` (signature `(cmd, args, opts) -> Promise<{err, stdout, stderr}>`, matching `containers.js`'s `sh()` shape — this file defines its own local `sh()` default rather than importing `containers.js`'s, since that one isn't exported).

- [ ] **Step 1: Write the failing tests**

Append to `tools/fleet-dashboard/server/fleet-smoke.test.js`:

```javascript
test('addConfig: scaffolds a homepage-only config with auto-detected Slack channel', async () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, 'sites', 'newsite.com', 'ops'), { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'SLACK_CHANNEL_NEWSITE=domain-newsite-com\nOTHER_VAR=x\n');
  const fakeGit = { commit: async () => ({ ok: true }), push: async () => ({ ok: true, out: '' }) };
  const result = await fleetSmoke.addConfig(root, 'newsite.com', { git: fakeGit });
  assert.equal(result.row.enabled, true);
  assert.equal(result.row.slackEnabled, true);
  assert.equal(result.row.checksCount, 1);
  const written = fs.readFileSync(path.join(root, 'sites', 'newsite.com', 'ops', 'smoke.yaml'), 'utf8');
  assert.match(written, /channel_env: SLACK_CHANNEL_NEWSITE/);
});

test('addConfig: no matching or multiple matching channel vars → slack.enabled:false, no guessing', async () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, 'sites', 'unknown.com', 'ops'), { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'SLACK_CHANNEL_SOMETHINGELSE=x\n');
  const fakeGit = { commit: async () => ({ ok: true }), push: async () => ({ ok: true, out: '' }) };
  const result = await fleetSmoke.addConfig(root, 'unknown.com', { git: fakeGit });
  assert.equal(result.row.slackEnabled, false);
});

test('addConfig: 409s when ops/smoke.yaml already exists', async () => {
  const root = makeRoot();
  writeConfig(root, 'existing.com', 'apex: existing.com\nchecks: []\n');
  const fakeGit = { commit: async () => ({ ok: true }), push: async () => ({ ok: true, out: '' }) };
  await assert.rejects(
    () => fleetSmoke.addConfig(root, 'existing.com', { git: fakeGit }),
    (err) => err.httpStatus === 409,
  );
});

test('runNow: 409s when the fleet-smoke container is not running', async () => {
  const root = makeRoot();
  writeConfig(root, 'site.com', 'apex: site.com\nchecks:\n  - path: /\n    expect: 200\n    label: Homepage\n');
  const fakeExec = async () => ({ err: null, stdout: 'exited', stderr: '' }); // never called in this test
  const fakeIsRunning = async () => false;
  await assert.rejects(
    () => fleetSmoke.runNow(root, 'site.com', { exec: fakeExec, isContainerRunning: fakeIsRunning }),
    (err) => err.httpStatus === 409,
  );
});

test('runNow: execs into the container and returns the refreshed row on success', async () => {
  const root = makeRoot();
  writeConfig(root, 'site.com', 'apex: site.com\nchecks:\n  - path: /\n    expect: 200\n    label: Homepage\n');
  let calledArgs = null;
  const fakeExec = async (cmd, args) => { calledArgs = [cmd, ...args]; return { err: null, stdout: 'ok', stderr: '' }; };
  const fakeIsRunning = async () => true;
  // Simulate the exec having updated state as a side effect (a real exec would).
  writeState(root, 'site.com', { fail: 0, headline_word: 'healthy' });
  const result = await fleetSmoke.runNow(root, 'site.com', { exec: fakeExec, isContainerRunning: fakeIsRunning });
  assert.equal(result.row.status.icon, 'healthy');
  assert.deepEqual(calledArgs, ['docker', 'exec', 'fleet-smoke', 'python3', 'run_fleet_smoke.py', '--only', 'site.com', '--stagger-seconds', '0']);
});

test('runNow: surfaces the exec failure with stdout/stderr tail on non-zero exit', async () => {
  const root = makeRoot();
  writeConfig(root, 'site.com', 'apex: site.com\nchecks: []\n');
  const fakeExec = async () => ({ err: new Error('exit 1'), stdout: 'some output', stderr: 'boom' });
  const fakeIsRunning = async () => true;
  await assert.rejects(
    () => fleetSmoke.runNow(root, 'site.com', { exec: fakeExec, isContainerRunning: fakeIsRunning }),
    (err) => err.httpStatus === 500 && /boom/.test(err.message),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/jesse/projects/domains/tools/fleet-dashboard && node --test server/fleet-smoke.test.js`
Expected: FAIL — `fleetSmoke.addConfig is not a function` (and similarly for `runNow`)

- [ ] **Step 3: Implement `addConfig` and `runNow`**

Add to `tools/fleet-dashboard/server/fleet-smoke.js` (after `toggleField`, before `module.exports`):

```javascript
const { execFile } = require('node:child_process');

function defaultSh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' }));
  });
}

async function defaultIsContainerRunning(sh) {
  const r = await sh('docker', ['inspect', '--format', '{{.State.Status}}', 'fleet-smoke']);
  return !r.err && r.stdout.trim() === 'running';
}

// Fuzzy Slack-channel auto-detect. Real-world SLACK_CHANNEL_* names don't
// follow one mechanical transform of the domain (americastrikes.com →
// SLACK_CHANNEL_AMERICA_STRIKES inserts an underscore; rc-9.com →
// SLACK_CHANNEL_RC9 drops the dash with none). So: take the stem (segment
// before the first '.', dashes stripped), and match any SLACK_CHANNEL_* env
// var whose name, underscores stripped, contains that stem. Exactly one match
// wins; zero or multiple → don't guess.
function detectChannelVar(root, slug) {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return null;
  const stem = slug.split('.')[0].replace(/-/g, '').toUpperCase();
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  const matches = [];
  for (const line of lines) {
    const m = line.match(/^(SLACK_CHANNEL_[A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const nameNoUnderscores = m[1].replace(/_/g, '');
    if (nameNoUnderscores.includes(stem)) matches.push({ name: m[1], value: m[2] });
  }
  return matches.length === 1 ? matches[0] : null;
}

async function addConfig(root, slug, deps = {}) {
  const git = deps.git || gitDefault;
  const p = smokeYamlPath(root, slug);
  if (fs.existsSync(p)) throw httpErr(409, `${slug} already has ops/smoke.yaml`);

  const channel = detectChannelVar(root, slug);
  const data = {
    apex: slug,
    enabled: true,
    slack: channel
      ? { enabled: true, channel_env: channel.name, channel: channel.value }
      : { enabled: false },
    checks: [{ path: '/', expect: 200, label: 'Homepage' }],
  };

  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, yaml.dump(data));

  await git.commit(root, slug, ['ops/smoke.yaml'], 'ops: add fleet-smoke config (centralized health check)');

  let pushed = true, pushError;
  try { await git.push(root, slug); }
  catch (e) { pushed = false; pushError = e.message; }

  const row = rowFor(root, slug);
  return pushed ? { ok: true, pushed, row } : { ok: true, pushed, pushError, row };
}

async function runNow(root, slug, deps = {}) {
  const sh = deps.exec || defaultSh;
  const isRunning = deps.isContainerRunning
    ? deps.isContainerRunning()
    : defaultIsContainerRunning(sh);

  const p = smokeYamlPath(root, slug);
  if (!fs.existsSync(p)) throw httpErr(404, `${slug} has no ops/smoke.yaml`);

  if (!(await isRunning)) {
    throw httpErr(409, 'fleet-smoke container is not running — check the Cron tab');
  }

  const r = await sh('docker', ['exec', 'fleet-smoke', 'python3', 'run_fleet_smoke.py',
    '--only', slug, '--stagger-seconds', '0']);
  if (r.err) {
    const tail = (r.stdout + '\n' + r.stderr).trim().slice(-2000);
    throw httpErr(500, `run failed: ${tail}`);
  }

  return { ok: true, row: rowFor(root, slug) };
}
```

Update the `module.exports` line at the bottom of the file:

```javascript
module.exports = { listSites, rowFor, toggleField, addConfig, runNow, smokeYamlPath, statePath };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/jesse/projects/domains/tools/fleet-dashboard && node --test server/fleet-smoke.test.js`
Expected: 14 passed

- [ ] **Step 5: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/fleet-dashboard/server/fleet-smoke.js tools/fleet-dashboard/server/fleet-smoke.test.js
git commit -m "fleet-dashboard: fleet-smoke add-config scaffold + run-now"
```

---

## Task 4: Wire the routes into `server.js`

**Files:**
- Modify: `tools/fleet-dashboard/server/server.js`

**Interfaces:**
- Consumes: `listSites(root, slugs)`, `toggleField(root, slug, field, value)`, `addConfig(root, slug)`, `runNow(root, slug)` from Task 2/3's `./fleet-smoke.js`; `discoverSites(root)`, `isKnownSite`/`requireSite` (already in `server.js`).
- Produces: 4 HTTP routes other tasks' manual verification and the frontend (Task 5) call directly: `GET /api/fleet-smoke/sites`, `POST /api/fleet-smoke/:slug/toggle`, `POST /api/fleet-smoke/:slug/add-config`, `POST /api/fleet-smoke/:slug/run`.

- [ ] **Step 1: Add the require**

In `tools/fleet-dashboard/server/server.js`, find the existing require block (around line 8-18):

```javascript
const { discoverSites, isKnownSite } = require('./sites');
const audit = require('./audit');
const git = require('./git');
```

Add a new line right after the `git` require:

```javascript
const { discoverSites, isKnownSite } = require('./sites');
const audit = require('./audit');
const git = require('./git');
const fleetSmoke = require('./fleet-smoke');
```

- [ ] **Step 2: Add the routes**

Find the existing `/api/git/:slug/push` route (around line 268-271):

```javascript
  app.post('/api/git/:slug/push', requireSite, async (req, res) => {
    try { res.json(await git.push(root, req.params.slug)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });
```

Add the 4 fleet-smoke routes directly after it:

```javascript
  // Fleet Smoke — per-site levers over tools/fleet-smoke's health checks.
  app.get('/api/fleet-smoke/sites', (_req, res) => {
    try { res.json(fleetSmoke.listSites(root, discoverSites(root))); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/fleet-smoke/:slug/toggle', requireSite, async (req, res) => {
    const { field, value } = req.body || {};
    if (field !== 'enabled' && field !== 'slack.enabled') {
      return res.status(400).json({ error: 'field must be "enabled" or "slack.enabled"' });
    }
    if (typeof value !== 'boolean') return res.status(400).json({ error: 'value must be boolean' });
    try { res.json(await fleetSmoke.toggleField(root, req.params.slug, field, value)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.post('/api/fleet-smoke/:slug/add-config', requireSite, async (req, res) => {
    try { res.json(await fleetSmoke.addConfig(root, req.params.slug)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.post('/api/fleet-smoke/:slug/run', requireSite, async (req, res) => {
    try { res.json(await fleetSmoke.runNow(root, req.params.slug)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });
```

- [ ] **Step 3: Run the full backend test suite**

Run: `cd /home/jesse/projects/domains/tools/fleet-dashboard && node --test`
Expected: all tests pass (14 from `fleet-smoke.test.js` plus every pre-existing test file — no existing test touches `server.js`'s route table directly, so nothing else should change).

- [ ] **Step 4: Start the dashboard and manually hit each route once**

```bash
cd /home/jesse/projects/domains/tools/fleet-dashboard
node server/server.js &
sleep 1
curl -s http://localhost:4754/api/fleet-smoke/sites | python3 -m json.tool | head -20
kill %1
```
Expected: valid JSON array; `xxxtea.com` should show `configured: true, enabled: true, slackEnabled: true, checksCount: 14` and a `status` object (since it has real state from having run already).

- [ ] **Step 5: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/fleet-dashboard/server/server.js
git commit -m "fleet-dashboard: wire fleet-smoke routes"
```

---

## Task 5: Frontend — Fleet Smoke tab

**Files:**
- Modify: `tools/fleet-dashboard/server/public/index.html`
- Modify: `tools/fleet-dashboard/server/public/app.js`

**Interfaces:**
- Consumes: `GET /api/fleet-smoke/sites`, `POST /api/fleet-smoke/:slug/toggle`, `POST /api/fleet-smoke/:slug/add-config`, `POST /api/fleet-smoke/:slug/run` (Task 4); `GET /api/cron/systems` (pre-existing, for the container-status header); `api()`, `toast()`, `esc()`, `gdBusy()`, `$`, `$$` (pre-existing helpers, top of `app.js`).
- Produces: a working "Fleet Smoke" tab, no new interfaces for other tasks to consume (this is the last task).

- [ ] **Step 1: Add the nav tab button**

In `tools/fleet-dashboard/server/public/index.html`, find the existing tab bar (around line 15-26):

```html
      <button class="tab" data-view="datahubimages">Data Hub Images</button>
```

Add a new tab button right after it:

```html
      <button class="tab" data-view="datahubimages">Data Hub Images</button>
      <button class="tab" data-view="fleetsmoke">Fleet Smoke</button>
```

- [ ] **Step 2: Register the view in the router**

In `tools/fleet-dashboard/server/public/app.js`, find `TOP_VIEWS` (around line 1883):

```javascript
const TOP_VIEWS = ['control', 'cron', 'containers', 'git', 'tasks', 'datahub', 'datahubimages'];
```

Change to:

```javascript
const TOP_VIEWS = ['control', 'cron', 'containers', 'git', 'tasks', 'datahub', 'datahubimages', 'fleetsmoke'];
```

Find `render()`'s if/else chain (around line 1921-1930):

```javascript
  if (STATE.view === 'control') renderControl();
  else if (STATE.view === 'cron') renderCron();
  else if (STATE.view === 'agent') renderAgent(STATE.agent);
  else if (STATE.view === 'containers') renderContainers();
  else if (STATE.view === 'git') renderGit();
  else if (STATE.view === 'tasks') renderTasks();
  else if (STATE.view === 'datahub') renderDataHub();
  else if (STATE.view === 'datahubimages') renderDataHubImages();
```

Add one more branch:

```javascript
  if (STATE.view === 'control') renderControl();
  else if (STATE.view === 'cron') renderCron();
  else if (STATE.view === 'agent') renderAgent(STATE.agent);
  else if (STATE.view === 'containers') renderContainers();
  else if (STATE.view === 'git') renderGit();
  else if (STATE.view === 'tasks') renderTasks();
  else if (STATE.view === 'datahub') renderDataHub();
  else if (STATE.view === 'datahubimages') renderDataHubImages();
  else if (STATE.view === 'fleetsmoke') renderFleetSmoke();
```

- [ ] **Step 3: Write the view function**

Add this to the end of `tools/fleet-dashboard/server/public/app.js`:

```javascript
/* ===================== FLEET SMOKE ===================== */
const FS_ICON = { healthy: '✅', recovered: '🔧', attention: '🆘' };

async function renderFleetSmoke() {
  const app = $('#app');
  if (FRESH) app.innerHTML = '<div class="loading">Loading fleet-smoke sites…</div>';

  let rows, systems;
  try {
    [rows, systems] = await Promise.all([
      api('GET', '/api/fleet-smoke/sites'),
      api('GET', '/api/cron/systems'),
    ]);
  } catch (e) { app.innerHTML = `<div class="empty">Fleet Smoke load failed: ${esc(e.message)}</div>`; return; }

  const sys = systems.find((s) => s.slug === 'fleet-smoke');
  const containerBadge = sys
    ? `<span class="badge ${sys.status === 'running' ? 'b-green' : 'b-red'}">${esc(sys.status)}</span>`
    : '<span class="badge b-red">not found</span>';
  const schedule = sys && sys.entries && sys.entries[0] ? esc(sys.entries[0].human) : '—';

  const configured = rows.filter((r) => r.configured);
  const unconfigured = rows.filter((r) => !r.configured);

  const pill = (on, slug, field) =>
    `<button class="btn sm fs-toggle ${on ? 'b-green' : 'b-gray'}" data-slug="${esc(slug)}" data-field="${esc(field)}" data-value="${on ? 'false' : 'true'}">${on ? 'ON' : 'OFF'}</button>`;

  const statusCell = (r) => {
    if (r.error) return `<span class="badge b-red" title="${esc(r.error)}">config error</span>`;
    if (!r.status) return '<span class="muted">—</span>';
    return `${FS_ICON[r.status.icon] || '?'} ${r.status.pass}/${r.status.total}`;
  };

  const configuredRows = configured.map((r) => `
    <tr>
      <td class="mono">${siteLink(r.slug)}</td>
      <td>${pill(r.enabled, r.slug, 'enabled')}</td>
      <td>${pill(r.slackEnabled, r.slug, 'slack.enabled')}</td>
      <td>${statusCell(r)}</td>
      <td><button class="btn sm fs-run" data-slug="${esc(r.slug)}">▶ Run now</button></td>
    </tr>`).join('');

  const unconfiguredRows = unconfigured.map((r) => `
    <tr>
      <td class="mono">${siteLink(r.slug)}</td>
      <td class="muted">—</td>
      <td class="muted">—</td>
      <td class="muted">—</td>
      <td><button class="btn sm fs-add" data-slug="${esc(r.slug)}">+ Add config</button></td>
    </tr>`).join('');

  app.innerHTML = `
    <div class="page-head">
      <h2 class="page-title">Fleet Smoke</h2>
      <span class="muted">${configured.length} configured · ${unconfigured.length} not yet · container ${containerBadge} · schedule ${schedule}</span>
    </div>
    <div class="card"><table>
      <thead><tr><th>Site</th><th>Checks</th><th>Slack</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${configuredRows || ''}${unconfiguredRows}</tbody>
    </table></div>
    <p class="muted" style="margin-top:12px">Toggling Checks/Slack or adding a config pushes directly to that site's <b>main</b> branch (auto-deploys via CF Workers Builds) — you'll be asked to confirm. <b>Run now</b> execs a single-site check inside the <span class="mono">fleet-smoke</span> container immediately, outside the daily schedule.</p>`;

  wireFleetSmokeRows();
  if (!FRESH) applyUISnap();
  stamp();
}

function wireFleetSmokeRows() {
  $$('.fs-toggle').forEach((b) => b.addEventListener('click', () => fsToggle(b)));
  $$('.fs-run').forEach((b) => b.addEventListener('click', () => fsRun(b)));
  $$('.fs-add').forEach((b) => b.addEventListener('click', () => fsAddConfig(b)));
}

function reloadFleetSmoke() { FRESH = false; UISNAP = captureUI(); return renderFleetSmoke(); }

async function fsToggle(btn) {
  const { slug, field } = btn.dataset;
  const value = btn.dataset.value === 'true';
  if (!confirm(`This pushes to ${slug}'s main branch — continue?`)) return;
  gdBusy(btn, true);
  try {
    const r = await api('POST', `/api/fleet-smoke/${encodeURIComponent(slug)}/toggle`, { field, value });
    toast(r.pushed ? `${slug}: ${field} → ${value}` : `${slug}: toggled locally, push failed: ${r.pushError}`, r.pushed ? 'ok' : 'err');
    await reloadFleetSmoke();
  } catch (e) { toast(`toggle failed: ${e.message}`, 'err'); gdBusy(btn, false); }
}

async function fsRun(btn) {
  const { slug } = btn.dataset;
  gdBusy(btn, true);
  try {
    await api('POST', `/api/fleet-smoke/${encodeURIComponent(slug)}/run`);
    toast(`${slug}: check run complete`);
    await reloadFleetSmoke();
  } catch (e) { toast(`run failed: ${e.message}`, 'err'); gdBusy(btn, false); }
}

async function fsAddConfig(btn) {
  const { slug } = btn.dataset;
  if (!confirm(`This scaffolds ops/smoke.yaml for ${slug} and pushes to its main branch — continue?`)) return;
  gdBusy(btn, true);
  try {
    await api('POST', `/api/fleet-smoke/${encodeURIComponent(slug)}/add-config`);
    toast(`${slug}: config added`);
    await reloadFleetSmoke();
  } catch (e) { toast(`add-config failed: ${e.message}`, 'err'); gdBusy(btn, false); }
}
```

- [ ] **Step 4: Manual verification**

```bash
cd /home/jesse/projects/domains/tools/fleet-dashboard
node server/server.js &
sleep 1
curl -s http://localhost:4754/ -o /dev/null -w '%{http_code}\n'
kill %1
```
Expected: `200`. Then open `http://localhost:4754/` in a browser, click the "Fleet Smoke" tab, confirm:
- All 11 configured sites show their toggles and status; `xxxtea.com` shows `✅ 14/14`.
- Unconfigured sites show `— — —` and an "+ Add config" button.
- Clicking a toggle shows the confirm dialog; cancel it (do not actually push during this check unless you intend to).
- The container badge shows `running` and the schedule text is non-empty.

- [ ] **Step 5: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/fleet-dashboard/server/public/index.html tools/fleet-dashboard/server/public/app.js
git commit -m "fleet-dashboard: Fleet Smoke tab — per-site levers UI"
git push origin main
```

---

## Self-Review Notes

- **Spec coverage:** New tab placement → Task 5. Write+commit+push toggle behavior → Task 2/4. Status icon from state → Task 1 (the spec's original "read straight from what was last written" claim required this small upstream fix, since the state file previously only stored `fail`, not the icon — documented as a discovered gap and resolved here rather than silently shipping a degraded 2-state read). All-sites-with-add-config scope → Task 2 (`listSites` takes explicit `slugs`) + Task 5 (unconfigured rows render). Fuzzy Slack-channel auto-detect (no mechanical name transform) → Task 3, matching the spec's corrected wording. Run-now button → Task 3/5.
- **Type consistency:** `toggleField`/`addConfig`/`runNow` all return `{ok, row}` (plus `pushed`/`pushError` for the two mutating-and-pushing ones) — `row` is always the same shape `rowFor` produces, so the frontend's `reloadFleetSmoke()` re-fetch-and-rerender approach (rather than trusting each mutation's returned row directly) stays consistent and simple.
- **No placeholders:** every step ships complete, runnable code, including all test bodies and the full frontend view function.
