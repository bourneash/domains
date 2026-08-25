'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ai = require('./aioptimizer');

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-'));
  for (const s of ai.STATUSES)
    fs.mkdirSync(path.join(root, 'tools', 'ai-optimizer', 'queue', s), { recursive: true });
  return root;
}

// Written the way the Python side writes them, so this doubles as a
// cross-language format check.
function writeTicket(root, status, file, over = {}) {
  const meta = {
    ticket_id: 't1',
    status,
    title: 'news-writer max-turns waste',
    created: '2026-08-25',
    finding_class: 'max-turns-waste',
    dedupe_key: 'abc123',
    scope: 'site',
    sites: ['0daynews.com'],
    role: 'news-writer',
    window_from: '2026-08-18',
    window_to: '2026-08-25',
    measured_cost_usd: 8.64,
    estimated_savings_usd_per_day: 1.2,
    risk: 'low',
    verified_current_code: true,
    verified_git_check: 'git log -3 run-news-writer.sh — clean',
    evidence_files: ['sites/0daynews.com/ops/scripts/run-news-writer.sh:45'],
    ...over,
  };
  fs.writeFileSync(
    path.join(root, 'tools', 'ai-optimizer', 'queue', status, file),
    ai.serializeTicket(meta, '## Problem\n\nBurns the budget.')
  );
}

test('lists tickets across columns, richest first', () => {
  const root = tmpRoot();
  writeTicket(root, 'proposed', 'a.md', { measured_cost_usd: 2 });
  writeTicket(root, 'proposed', 'b.md', { measured_cost_usd: 20 });
  writeTicket(root, 'approved', 'c.md');
  const out = ai.list(root);
  assert.equal(out.proposed.length, 2);
  assert.equal(out.proposed[0].file, 'b.md', 'highest measured cost sorts first');
  assert.equal(out.approved.length, 1);
  assert.equal(out.rejected.length, 0);
});

test('parses the Python-side frontmatter faithfully', () => {
  const root = tmpRoot();
  writeTicket(root, 'proposed', 'a.md');
  const card = ai.list(root).proposed[0];
  assert.equal(card.role, 'news-writer');
  assert.deepEqual(card.sites, ['0daynews.com']);
  assert.deepEqual(card.evidence_files, ['sites/0daynews.com/ops/scripts/run-news-writer.sh:45']);
  assert.equal(card.measured_cost_usd, 8.64);
  assert.equal(card.window_from, '2026-08-18');
});

test('approve moves proposed -> approved and records the decision', () => {
  const root = tmpRoot();
  writeTicket(root, 'proposed', 'a.md');
  const res = ai.move(root, 'proposed', 'a.md', 'approved', { note: 'do it', by: 'jesse' });
  assert.equal(res.to, 'approved');
  const out = ai.list(root);
  assert.equal(out.proposed.length, 0);
  assert.equal(out.approved[0].decision_note, 'do it');
  assert.ok(out.approved[0].decided, 'stamps a decided date');
});

test('rejects transitions that are not allowed', () => {
  const root = tmpRoot();
  writeTicket(root, 'applied', 'a.md');
  assert.throws(() => ai.move(root, 'applied', 'a.md', 'proposed'), /cannot move/);
  writeTicket(root, 'proposed', 'b.md');
  // Nothing may jump straight to applied without being approved first.
  assert.throws(() => ai.move(root, 'proposed', 'b.md', 'applied'), /cannot move/);
});

test('refuses path traversal and bad filenames', () => {
  const root = tmpRoot();
  assert.throws(
    () => ai.move(root, 'proposed', '../../x.md', 'approved'),
    /bad status or filename/
  );
  assert.throws(() => ai.get(root, 'proposed', '../../etc/passwd'), /bad status or filename/);
  assert.throws(() => ai.get(root, 'nope', 'a.md'), /bad status or filename/);
});

test('summary totals only count the right columns', () => {
  const root = tmpRoot();
  writeTicket(root, 'proposed', 'a.md', { estimated_savings_usd_per_day: 1.5 });
  writeTicket(root, 'approved', 'b.md', { estimated_savings_usd_per_day: 2.5 });
  writeTicket(root, 'rejected', 'c.md', { estimated_savings_usd_per_day: 99 });
  const s = ai.summary(root);
  assert.equal(s.counts.proposed, 1);
  assert.equal(s.open_savings_usd_per_day, 1.5);
  assert.equal(s.approved_savings_usd_per_day, 2.5);
  assert.equal(s.applied_savings_usd_per_day, 0, 'rejected savings never count');
});

test('get returns body plus the moves the UI may offer', () => {
  const root = tmpRoot();
  writeTicket(root, 'proposed', 'a.md');
  const t = ai.get(root, 'proposed', 'a.md');
  assert.match(t.body, /Burns the budget/);
  assert.deepEqual(t.allowed_moves, ['approved', 'rejected', 'deferred']);
});
