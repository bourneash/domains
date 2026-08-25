'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// queue.js resolves its paths at require() time, so redirect the state dir
// BEFORE loading it. Without this the tests read and rewrite the LIVE
// state/queue.json, racing the hourly cron sweep and destroying real items.
process.env.FLEET_GIT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-git-queue-'));

function freshQueue() {
  delete require.cache[require.resolve('../lib/queue')];
  const q = require('../lib/queue');
  try {
    fs.unlinkSync(q.QUEUE_PATH);
  } catch {
    /* first run */
  }
  return q;
}

test('reconcile keeps first_seen across sweeps and auto-closes vanished items', () => {
  const q = freshQueue();
  const dir = path.dirname(q.QUEUE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  {
    q.reconcile(
      { 'a.com': [{ path: 'x.md', kind: 'untracked', reason: 'r' }] },
      {
        now: '2026-01-01T00:00:00Z',
        sweptSlugs: new Set(['a.com']),
      }
    );
    q.reconcile(
      { 'a.com': [{ path: 'x.md', kind: 'untracked', reason: 'r' }] },
      {
        now: '2026-01-02T00:00:00Z',
        sweptSlugs: new Set(['a.com']),
      }
    );
    let open = q.open().filter(i => i.slug === 'a.com');
    assert.equal(open.length, 1);
    assert.equal(
      open[0].first_seen,
      '2026-01-01T00:00:00Z',
      'age survives — the >24h nag depends on it'
    );
    assert.equal(open[0].last_seen, '2026-01-02T00:00:00Z');

    // path fixed by hand → gone from the board with no clicks
    q.reconcile({ 'a.com': [] }, { now: '2026-01-03T00:00:00Z', sweptSlugs: new Set(['a.com']) });
    assert.equal(q.open().filter(i => i.slug === 'a.com').length, 0);
  }
});

test("a SKIPPED repo's items are not wiped and do not get a reset first_seen", () => {
  const q = freshQueue();
  {
    q.reconcile(
      { 'b.com': [{ path: 'y.md', kind: 'untracked', reason: 'r' }] },
      {
        now: '2026-01-01T00:00:00Z',
        sweptSlugs: new Set(['b.com']),
      }
    );
    // Next sweep: b.com is behind upstream, so plan() returns early with an
    // empty review list and sweep.js must NOT mark it swept.
    q.reconcile({}, { now: '2026-01-05T00:00:00Z', sweptSlugs: new Set(['other.com']) });
    const open = q.open().filter(i => i.slug === 'b.com');
    assert.equal(open.length, 1, 'item survives a skipped sweep');
    assert.equal(open[0].first_seen, '2026-01-01T00:00:00Z', 'age is not reset');
  }
});

test('a corrupt queue file throws and is preserved — it is never silently emptied', () => {
  const q = freshQueue();
  const p = q.QUEUE_PATH;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{"items": {"a.com:x.md": {"slug": "a.com"'); // half-written
  assert.throws(() => q.open(), /not valid JSON/);
  const copies = fs.readdirSync(path.dirname(p)).filter(f => f.startsWith('queue.json.corrupt-'));
  assert.ok(copies.length >= 1, 'the corrupt file is copied aside, not discarded');
});
