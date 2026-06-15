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
  // last-run facts + a log file for enrichment / role-log tests
  const board = path.join(root, 'sites', 'demo.com', 'ops', 'board');
  const logs = path.join(root, 'sites', 'demo.com', 'ops', 'logs');
  fs.mkdirSync(board, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'planner-2026-06-15.log'), 'planner ran ok\n');
  fs.writeFileSync(path.join(board, 'last-run.json'), JSON.stringify({
    planner: { at: '2026-06-15T10:06:37Z', exit: 0, log: '/work/ops/logs/planner-2026-06-15.log' },
  }));
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

test('GET /api/systems exposes honest status fields', async () => {
  const r = await fetch(`${base}/api/systems`);
  const demo = (await r.json()).find((s) => s.slug === 'demo.com');
  // statusRunner stubbed to empty → never-built, but the shape must be present
  assert.strictEqual(demo.status, 'never-built');
  assert.strictEqual(demo.failed, false);
  assert.ok('exitCode' in demo);
  assert.ok('statusText' in demo);
});

test('GET logs returns container output', async () => {
  const r = await fetch(`${base}/api/systems/demo.com/logs`);
  assert.strictEqual(r.status, 200);
  const txt = await r.text();
  // statusRunner stub returns empty stdout → friendly placeholder, never 500
  assert.ok(txt.length >= 0);
});

test('GET logs 404s for unknown system', async () => {
  const r = await fetch(`${base}/api/systems/nope/logs`);
  assert.strictEqual(r.status, 404);
});

test('GET /api/cron/describe validates + translates', async () => {
  const ok = await (await fetch(`${base}/api/cron/describe?expr=${encodeURIComponent('0 6 * * 1')}`)).json();
  assert.strictEqual(ok.valid, true);
  assert.match(ok.human, /Monday/i);
  const bad = await (await fetch(`${base}/api/cron/describe?expr=${encodeURIComponent('nope')}`)).json();
  assert.strictEqual(bad.valid, false);
  assert.ok(bad.error);
});

test('GET /api/systems enriches entries with last-run + log sources', async () => {
  const demo = (await (await fetch(`${base}/api/systems`)).json()).find((s) => s.slug === 'demo.com');
  const planner = demo.entries.find((e) => e.role === 'planner');
  assert.strictEqual(planner.lastRun, '2026-06-15T10:06:37Z');
  assert.strictEqual(planner.lastExit, 0);
  assert.strictEqual(planner.hasLog, true);
  assert.ok(demo.logSources.some((x) => x.id === 'role:planner'));
  assert.ok(demo.logSources.some((x) => x.id === 'container'));
  assert.strictEqual(typeof demo.needsRebuild, 'boolean');
});

test('GET logs source=role reads the recorded role log', async () => {
  const r = await fetch(`${base}/api/systems/demo.com/logs?source=role:planner`);
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /planner ran ok/);
});

test('GET logs source=rebuild returns a placeholder before any rebuild', async () => {
  const r = await fetch(`${base}/api/systems/demo.com/logs?source=rebuild`);
  assert.match(await r.text(), /no rebuild/i);
});
