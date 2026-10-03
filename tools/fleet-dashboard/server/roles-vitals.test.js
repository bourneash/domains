'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const roles = require('./roles');

test('vitals summary preserves the full matrix fleet counts without returning cells', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-vitals-'));
  const ops = path.join(root, 'sites', 'example.test', 'ops');
  const logs = path.join(ops, 'logs');
  fs.mkdirSync(path.join(ops, 'docker'), { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(
    path.join(ops, 'docker', 'crontab'),
    [
      '0 7 * * * bash ops/scripts/run-worker.sh update',
      '0 */2 * * * bash ops/scripts/run-worker.sh planner',
      '30 */2 * * * bash ops/scripts/run-worker.sh planner',
      '# 0 4 * * * bash ops/scripts/run-worker.sh engineer',
    ].join('\n') + '\n'
  );
  fs.writeFileSync(path.join(ops, '.planner-disabled'), '');
  fs.writeFileSync(path.join(logs, 'update-20261003.log'), 'Published `/news/latest-story`\n');
  const now = Date.now();
  fs.utimesSync(path.join(logs, 'update-20261003.log'), now / 1000, now / 1000);
  try {
    const summary = await roles.vitals(root, ['example.test', 'empty.test']);
    const full = await roles.matrix(root, ['example.test', 'empty.test']);
    const expected = {
      siteCount: full.sites.length,
      roleCount: full.roles.length,
      total: 0,
      fresh: 0,
      stale: 0,
      overdue: 0,
      paused: 0,
    };
    for (const site of full.sites) {
      for (const cell of Object.values(site.cells)) {
        if (!cell.scheduled) continue;
        expected.total++;
        if (!cell.enabled) expected.paused++;
        else if (cell.state === 'fresh') expected.fresh++;
        else if (cell.state === 'stale') expected.stale++;
        else if (cell.state === 'overdue') expected.overdue++;
      }
    }
    assert.deepEqual(summary, expected);
    assert.equal('sites' in summary, false);
    assert.equal('cells' in summary, false);
  } finally {
    roles.invalidateMatrix(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
