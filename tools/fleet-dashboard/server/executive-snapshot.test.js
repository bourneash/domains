'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const snapshot = require('./executive-snapshot');

test('writes and reads a scoped executive intelligence snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'executive-snapshot-'));
  const intelligence = {
    generated_at: new Date().toISOString(),
    scope: { managed_sites: ['example.com'], excluded_sites: ['3boobs.com'] },
    sources: { analytics: { ok: true } },
    decision_support: { analytics: { configured_sites: 1 } },
  };
  const saved = snapshot.write(root, intelligence);
  assert.equal(fs.existsSync(saved.file), true);
  assert.deepEqual(
    snapshot.readLatest(root, { sites: ['example.com'] }).intelligence,
    intelligence
  );
  assert.equal(snapshot.readLatest(root, { sites: ['other.example'] }), null);
});

test('rejects stale executive intelligence snapshots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'executive-snapshot-stale-'));
  snapshot.write(
    root,
    { scope: { managed_sites: ['example.com'] }, sources: {}, decision_support: {} },
    { now: new Date(Date.now() - 8 * 60 * 60 * 1000) }
  );
  assert.equal(snapshot.readLatest(root, { sites: ['example.com'] }), null);
});

test('keeps a degraded analytics snapshot out of the latest usable bundle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'executive-snapshot-degraded-'));
  const good = snapshot.write(root, {
    scope: { managed_sites: ['example.com'] },
    sources: { analytics: { ok: true, sessions: 4 } },
    decision_support: {},
  });
  const degraded = snapshot.write(root, {
    scope: { managed_sites: ['example.com'] },
    sources: { analytics: { ok: false, error: 'fetch failed' } },
    decision_support: {},
  });
  assert.equal(good.latest_updated, true);
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.latest_updated, false);
  assert.equal(
    snapshot.readLatest(root, { sites: ['example.com'] }).intelligence.sources.analytics.sessions,
    4
  );
  assert.match(degraded.file, /\.degraded\.json$/);
});
