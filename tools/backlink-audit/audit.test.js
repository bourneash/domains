'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSnapshot, reportEvidence } = require('./audit');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backlink-audit-'));
  fs.mkdirSync(path.join(root, 'sites', 'missing.com', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sites', 'baseline.com', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sites', 'measured.com', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sites', 'baseline.com', 'ops', 'seo'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sites', 'measured.com', 'ops', 'seo'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'sites', 'baseline.com', 'ops', 'seo', 'backlinks-2026-09-01.md'),
    '# baseline\n\nNo numeric referring-domain count exists. MOZ_API_KEY is missing.'
  );
  fs.writeFileSync(
    path.join(root, 'sites', 'measured.com', 'ops', 'seo', 'backlinks-2026-09-10.md'),
    '# measured\n\nMoz API export: referring domains: 12; backlinks: 44.'
  );
  return root;
}

test('evidence classification distinguishes unavailable from measured sources', () => {
  assert.deepEqual(reportEvidence('No numeric referring-domain count; MOZ_API_KEY is missing.'), {
    sources: ['moz'],
    measured: false,
  });
  assert.deepEqual(reportEvidence('Moz API export: referring domains: 12; backlinks: 44.'), {
    sources: ['moz'],
    measured: true,
  });
});

test('snapshot exposes fleet coverage and per-site detail', () => {
  const root = fixture();
  const snapshot = buildSnapshot(root, new Date('2026-09-20T12:00:00Z'));
  assert.equal(snapshot.totals.sites, 3);
  assert.equal(snapshot.totals.missing, 1);
  assert.equal(snapshot.totals.baseline, 1);
  assert.equal(snapshot.totals.current, 1);
  assert.equal(snapshot.coverage, 67);
  assert.equal(snapshot.sites.find(row => row.site === 'missing.com').priority, 'high');
});
