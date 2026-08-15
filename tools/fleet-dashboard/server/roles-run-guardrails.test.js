'use strict';

// Guardrail tests for the "fires a role" surfaces — roles.setEnabled() (pause/
// resume) and run.runRole() (run-now). Both must reject anything that isn't a
// scheduled run-worker.sh role BEFORE touching the filesystem flag / execing
// docker — a regression here means pause/run silently no-ops on the wrong
// thing, or a non-worker role (deployer/watchdog, which don't honour the
// disabled flag) gets falsely "paused".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const roles = require('./roles');
const run = require('./run');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeSite(root, slug, crontab) {
  const cwd = path.join(root, 'sites', slug, 'ops', 'docker');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'crontab.docker'), crontab);
}

const CRONTAB = [
  '*/6 * * * * cd /work && bash ops/scripts/run-worker.sh engineer',
  '0 7 * * * bash ops/scripts/run-deployer.sh', // scheduled but NOT a worker role
].join('\n');

/* ---- roles.setEnabled ---- */
test('setEnabled rejects an invalid role name before touching the filesystem', () => {
  const root = tmpdir('fd-roles-');
  try {
    makeSite(root, 'x.com', CRONTAB);
    assert.throws(
      () => roles.setEnabled(root, 'x.com', 'not a role!', false),
      e => e.httpStatus === 400
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setEnabled rejects a role that is not scheduled on this site (404)', () => {
  const root = tmpdir('fd-roles-');
  try {
    makeSite(root, 'x.com', CRONTAB);
    assert.throws(
      () => roles.setEnabled(root, 'x.com', 'planner', false),
      e => e.httpStatus === 404
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setEnabled rejects a scheduled non-worker role (deployer) with 400, and never creates the flag file', () => {
  const root = tmpdir('fd-roles-');
  try {
    makeSite(root, 'x.com', CRONTAB);
    assert.throws(
      () => roles.setEnabled(root, 'x.com', 'deployer', false),
      e => e.httpStatus === 400
    );
    assert.equal(
      fs.existsSync(path.join(root, 'sites', 'x.com', 'ops', '.deployer-disabled')),
      false
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setEnabled pauses a worker role by touching an EMPTY flag file, and resumes by removing it', () => {
  const root = tmpdir('fd-roles-');
  try {
    makeSite(root, 'x.com', CRONTAB);
    const flag = path.join(root, 'sites', 'x.com', 'ops', '.engineer-disabled');

    const paused = roles.setEnabled(root, 'x.com', 'engineer', false);
    assert.deepEqual(paused, { ok: true, role: 'engineer', enabled: false });
    assert.equal(fs.existsSync(flag), true);
    assert.equal(fs.readFileSync(flag, 'utf8'), ''); // conventionally empty — no spurious diff content

    const resumed = roles.setEnabled(root, 'x.com', 'engineer', true);
    assert.deepEqual(resumed, { ok: true, role: 'engineer', enabled: true });
    assert.equal(fs.existsSync(flag), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("setEnabled resume is a no-op (doesn't throw) when the flag is already absent", () => {
  const root = tmpdir('fd-roles-');
  try {
    makeSite(root, 'x.com', CRONTAB);
    assert.doesNotThrow(() => roles.setEnabled(root, 'x.com', 'engineer', true));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ---- run.runRole ---- */
test('runRole rejects an invalid role name before resolving a container', async () => {
  const root = tmpdir('fd-run-');
  try {
    makeSite(root, 'x.com', CRONTAB);
    await assert.rejects(
      () => run.runRole(root, 'x.com', 'rm -rf'),
      e => e.httpStatus === 400
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runRole rejects a role not scheduled on the site (404)', async () => {
  const root = tmpdir('fd-run-');
  try {
    makeSite(root, 'x.com', CRONTAB);
    await assert.rejects(
      () => run.runRole(root, 'x.com', 'planner'),
      e => e.httpStatus === 404
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runRole rejects a scheduled non-worker role (deployer) with 400, without shelling out to docker', async () => {
  const root = tmpdir('fd-run-');
  try {
    makeSite(root, 'x.com', CRONTAB);
    await assert.rejects(
      () => run.runRole(root, 'x.com', 'deployer'),
      e => e.httpStatus === 400
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
