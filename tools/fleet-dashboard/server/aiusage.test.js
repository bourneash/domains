'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const aiusage = require('./aiusage');

const ROOT = path.resolve(__dirname, '..', '..', '..');

test('scriptPath resolves the fleet canonical aggregator', () => {
  assert.equal(aiusage.scriptPath(ROOT), path.join(ROOT, 'tools', 'ai-usage', 'aggregate.py'));
});

test('fleet returns a summary with fleet site counts', async () => {
  const data = await aiusage.fleet(ROOT);
  assert.ok(data.summary.sites_total > 0);
  assert.ok(Array.isArray(data.summary.sites_uninstrumented));
  assert.ok(Array.isArray(data.by_site));
  assert.ok(Array.isArray(data.by_site_role));
  assert.ok(Array.isArray(data.by_day));
  assert.ok(Array.isArray(data.by_hour));
  assert.ok(Array.isArray(data.by_hour_site_role));
  assert.ok(Array.isArray(data.coverage));
  assert.equal(data.coverage.length, data.summary.sites_total);
  assert.ok(data.generated_at);
});

test('fleet accepts an inclusive UTC date range for dashboard time-frame controls', async () => {
  const data = await aiusage.fleet(ROOT, { from: '2026-07-01', to: '2026-07-30' });
  assert.deepEqual(data.filters, { from: '2026-07-01', to: '2026-07-30' });
  assert.ok(Array.isArray(data.by_day_site_role));
});

test('fleet report cache covers two dashboard refreshes and expires after thirty seconds', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiusage-cache-'));
  const script = path.join(root, 'tools', 'ai-usage', 'aggregate.py');
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
      'print(json.dumps({"by_site_role": []}))',
      '',
    ].join('\n')
  );
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const first = await aiusage.fleet(root);
    now += 20000;
    const cached = await aiusage.fleet(root);
    assert.equal(cached, first);
    assert.equal(fs.readFileSync(counter, 'utf8'), '1');

    now += 10001;
    const refreshed = await aiusage.fleet(root);
    assert.notEqual(refreshed, first);
    assert.equal(fs.readFileSync(counter, 'utf8'), '2');
  } finally {
    Date.now = originalNow;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
