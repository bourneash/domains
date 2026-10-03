'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const roles = require('./roles');

test('Control matrix omits unused editorial detail while the full matrix retains it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-control-matrix-'));
  const ops = path.join(root, 'sites', 'example.test', 'ops');
  fs.mkdirSync(path.join(ops, 'docker'), { recursive: true });
  fs.mkdirSync(path.join(ops, 'logs'), { recursive: true });
  fs.writeFileSync(
    path.join(ops, 'docker', 'crontab'),
    '0 7 * * * bash ops/scripts/run-worker.sh update\n'
  );
  try {
    const control = await roles.matrix(root, ['example.test'], null, { includeEditorial: false });
    const full = await roles.matrix(root, ['example.test']);
    assert.equal(control.sites[0].cells.update.editorial, null);
    assert.equal(full.sites[0].cells.update.editorial.cadence, 'daily');
    assert.equal(control.sites[0].cells.update.state, full.sites[0].cells.update.state);
  } finally {
    roles.invalidateMatrix(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
