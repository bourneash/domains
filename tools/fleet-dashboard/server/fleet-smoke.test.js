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
