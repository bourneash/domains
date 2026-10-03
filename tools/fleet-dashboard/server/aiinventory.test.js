'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const aiinventory = require('./aiinventory');

test('fleet inventory shares concurrent scans and briefly caches the report', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiinventory-cache-'));
  const script = path.join(root, 'tools', 'ai-inventory', 'audit-ai.py');
  const counter = path.join(root, 'calls');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(
    script,
    [
      'from pathlib import Path',
      'import json',
      `p = Path(${JSON.stringify(counter)})`,
      'n = int(p.read_text()) if p.exists() else 0',
      'p.write_text(str(n + 1))',
      'print(json.dumps([{"provider":"Local","policy":"Local","status":"ENABLED","conditional":False}]))',
      '',
    ].join('\n')
  );
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    const [first, concurrent] = await Promise.all([
      aiinventory.fleet(root),
      aiinventory.fleet(root),
    ]);
    assert.deepEqual(concurrent, first);
    assert.equal(first.summary.services, 1);
    assert.equal(fs.readFileSync(counter, 'utf8'), '1');

    await aiinventory.fleet(root);
    assert.equal(fs.readFileSync(counter, 'utf8'), '1');

    now += 3001;
    await aiinventory.fleet(root);
    assert.equal(fs.readFileSync(counter, 'utf8'), '2');
  } finally {
    Date.now = originalNow;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const ROOT = path.resolve(__dirname, '..', '..', '..');

test('scriptPath resolves the fleet canonical classifier', () => {
  assert.equal(
    aiinventory.scriptPath(ROOT),
    path.join(ROOT, 'tools', 'ai-inventory', 'audit-ai.py')
  );
});

test('fleet returns dispatch-aware rows and summary counts', async () => {
  const data = await aiinventory.fleet(ROOT);
  assert.ok(data.summary.services > 0);
  assert.equal(data.summary.services, data.rows.length);
  assert.equal(data.summary.ai, data.rows.filter(r => r.provider !== 'None').length);
  const engineer = data.rows.find(r => r.domain === '0daynews.com' && r.service === 'engineer');
  assert.equal(engineer.model, 'claude-sonnet-4-6');
  assert.equal(engineer.conditional, true);
  const deployer = data.rows.find(r => r.domain === '0daynews.com' && r.service === 'deployer');
  assert.equal(deployer.provider, 'None');
});
