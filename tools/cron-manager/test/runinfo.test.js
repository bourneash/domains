const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLastRuns, resolveLogPath, tailFile } = require('../server/runinfo');

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ri-'));
  const ops = path.join(root, 'sites', 'demo.com', 'ops');
  fs.mkdirSync(path.join(ops, 'board'), { recursive: true });
  fs.mkdirSync(path.join(ops, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(ops, 'board', 'last-run.json'), JSON.stringify({
    planner: { at: '2026-06-15T10:06:37Z', exit: 0, log: '/work/ops/logs/planner-2026-06-15.log' },
    deployer: { at: '2026-06-15T11:00:00Z', exit: 1, log: '/work/ops/logs/deployer-2026-06-15.log' },
  }));
  fs.writeFileSync(path.join(ops, 'logs', 'planner-2026-06-15.log'), 'line A\nline B\nline C\n');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('readLastRuns parses role → {at, exit, log}', () => {
  const lr = readLastRuns(path.join(root, 'sites', 'demo.com', 'ops'));
  assert.strictEqual(lr.planner.exit, 0);
  assert.strictEqual(lr.deployer.exit, 1);
  assert.strictEqual(lr.planner.at, '2026-06-15T10:06:37Z');
});

test('readLastRuns returns {} when file missing/garbage', () => {
  assert.deepStrictEqual(readLastRuns(path.join(root, 'nope')), {});
});

test('resolveLogPath maps /work/ to the host logs dir', () => {
  const p = resolveLogPath(root, 'demo.com', '/work/ops/logs/planner-2026-06-15.log');
  assert.strictEqual(p, path.join(root, 'sites', 'demo.com', 'ops', 'logs', 'planner-2026-06-15.log'));
});

test('resolveLogPath refuses traversal outside ops/logs', () => {
  assert.strictEqual(resolveLogPath(root, 'demo.com', '/work/ops/logs/../../../../etc/passwd'), null);
  assert.strictEqual(resolveLogPath(root, 'demo.com', '/etc/passwd'), null);
  assert.strictEqual(resolveLogPath(root, 'demo.com', null), null);
});

test('tailFile returns last N lines', () => {
  const f = path.join(root, 'sites', 'demo.com', 'ops', 'logs', 'planner-2026-06-15.log');
  assert.match(tailFile(f, 2), /line B\nline C/);
});

test('tailFile never throws on missing file', () => {
  assert.match(tailFile('/no/such/file'), /error reading log/);
});
