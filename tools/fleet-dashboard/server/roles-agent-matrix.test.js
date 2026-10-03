'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const roles = require('./roles');

test('agent role matrix keeps full site coverage while omitting unrelated roles', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-agent-matrix-'));
  const ops = path.join(root, 'sites', 'example.test', 'ops');
  fs.mkdirSync(path.join(ops, 'docker'), { recursive: true });
  fs.writeFileSync(
    path.join(ops, 'docker', 'crontab'),
    '0 */2 * * * bash ops/scripts/run-worker.sh engineer\n0 4 * * * bash ops/scripts/run-worker.sh planner\n'
  );
  try {
    const matrix = await roles.agentMatrix(root, ['example.test', 'empty.test'], 'engineer');
    assert.deepEqual(matrix.allSites, ['example.test', 'empty.test']);
    assert.deepEqual(matrix.roles, ['engineer']);
    assert.deepEqual(Object.keys(matrix.sites[0].cells), ['engineer']);
  } finally {
    roles.invalidateMatrix(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('editorial Agent matrix includes each installed family profile', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-editorial-matrix-'));
  const ops = path.join(root, 'sites', 'example.test', 'ops');
  fs.mkdirSync(path.join(ops, 'docker'), { recursive: true });
  fs.writeFileSync(
    path.join(ops, 'docker', 'crontab'),
    '0 7 * * * bash ops/scripts/run-worker.sh update\n0 8 * * * bash ops/scripts/run-worker.sh news-writer\n'
  );
  try {
    const matrix = await roles.agentMatrix(root, ['example.test'], 'update');
    assert.deepEqual(matrix.profiles, roles.ROLE_FAMILIES.update.roles);
    assert.deepEqual(matrix.secondaryRoles, roles.ROLE_FAMILIES.update.secondaryRoles);
    assert.deepEqual(matrix.roles, ['news-writer', 'update']);
    assert.deepEqual(Object.keys(matrix.sites[0].cells).sort(), ['news-writer', 'update']);
  } finally {
    roles.invalidateMatrix(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Agent health reuses editorial telemetry already computed by its scoped matrix', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-agent-health-telemetry-'));
  const ops = path.join(root, 'sites', 'example.test', 'ops');
  const logs = path.join(ops, 'logs');
  fs.mkdirSync(path.join(ops, 'docker'), { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(
    path.join(ops, 'docker', 'crontab'),
    '0 7 * * * bash ops/scripts/run-worker.sh update\n'
  );
  fs.writeFileSync(
    path.join(logs, 'update-2026-10-03.log'),
    'started at 2026-10-03T07:00:00Z\nfinished at 2026-10-03T07:01:00Z (exit=0)\nPublished /news/current-story\n'
  );
  const deployLog = path.join(logs, 'deployer-2026-10-03.log');
  fs.writeFileSync(deployLog, 'deploy SUCCESS\n');
  const originalReadFileSync = fs.readFileSync;
  try {
    const matrix = await roles.agentMatrix(root, ['example.test'], 'update');
    assert.equal(matrix.sites[0].cells.update.editorial.deploy.state, 'success');
    const healthLogReads = [];
    fs.readFileSync = function (file, ...args) {
      if (String(file) === deployLog) healthLogReads.push(String(file));
      return originalReadFileSync.call(this, file, ...args);
    };
    const health = await roles.health(root, 'update', ['example.test'], {}, false, matrix);
    assert.ok(health.rows[0].editorial.deploy);
    assert.deepEqual(healthLogReads, []);
  } finally {
    fs.readFileSync = originalReadFileSync;
    roles.invalidateMatrix(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
