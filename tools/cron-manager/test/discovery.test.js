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
