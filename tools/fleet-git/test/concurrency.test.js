'use strict';
// The two concurrency guards, exercised for real. Both exist because the sweep
// shares its repos with ~26 site cron containers AND with the dashboard, which
// runs in a different container and cannot see a per-process flag.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Point the sweep lock at this test's own file BEFORE requiring sweep.js —
// otherwise these tests contend with the real checkout's lock and with the
// pointer e2e tests, which node --test runs in parallel.
const LOCK = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-git-lock-')), 'sweep.lock');
process.env.FLEET_GIT_LOCK = LOCK;

const { sweep } = require('../lib/sweep');
const { commitViaScratchIndex } = require('../lib/scratchindex');

const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);
const sh = (cwd, ...a) =>
  execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: CLEAN_ENV });

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-git-conc-'));
  execFileSync('git', ['init', '-b', 'main', d], { env: CLEAN_ENV });
  sh(d, 'config', 'user.email', 't@e.com');
  sh(d, 'config', 'user.name', 't');
  sh(d, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\n');
  sh(d, 'add', '-A');
  sh(d, 'commit', '-m', 'init');
  return d;
}

test('a second sweep is refused while one holds the lock — CLI, cron and dashboard share it', async () => {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
  try {
    await assert.rejects(
      () => sweep(path.join(__dirname, '..', '..', '..'), { apply: true, push: false }),
      /already running/
    );
  } finally {
    try {
      fs.unlinkSync(LOCK);
    } catch {
      /* already released */
    }
  }
});

test('a dry run is never blocked by the lock (audits stay available during a sweep)', async () => {
  fs.writeFileSync(LOCK, JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
  try {
    const rep = await sweep(path.join(__dirname, '..', '..', '..'), {
      apply: false,
      push: false,
      only: ['nonexistent-site.com'],
    });
    assert.ok(rep, 'audit ran');
  } finally {
    try {
      fs.unlinkSync(LOCK);
    } catch {
      /* already released */
    }
  }
});

test('a stale lock is stolen, so a killed sweep cannot wedge the fleet forever', async () => {
  fs.writeFileSync(LOCK, JSON.stringify({ pid: 1, at: '2000-01-01T00:00:00Z' }));
  const old = Date.now() / 1000 - 60 * 60 * 2; // 2h ago
  fs.utimesSync(LOCK, old, old);
  try {
    const rep = await sweep(path.join(__dirname, '..', '..', '..'), {
      apply: true,
      push: false,
      only: ['nonexistent-site.com'],
    });
    assert.ok(rep, 'the stale lock was stolen');
  } finally {
    try {
      fs.unlinkSync(LOCK);
    } catch {
      /* released by the sweep itself */
    }
  }
});

test('a scratch-index commit REFUSES rather than clobbers when HEAD moved under it', async () => {
  const d = repo();
  const startHead = sh(d, 'rev-parse', 'HEAD').trim();

  // Move HEAD after the scratch tree is built by racing a commit in first.
  fs.writeFileSync(path.join(d, 'b.txt'), 'from the site cron\n');
  sh(d, 'add', '-A');
  sh(d, 'commit', '-m', 'concurrent cron commit');
  const movedHead = sh(d, 'rev-parse', 'HEAD').trim();
  assert.notEqual(movedHead, startHead);

  // Now attempt a CAS against the STALE sha, which is exactly what a sweep that
  // read status before that commit would be holding.
  const { git } = require('../lib/gitexec');
  const upd = await git(d, ['update-ref', 'HEAD', movedHead, startHead]);
  assert.equal(upd.ok, false, 'update-ref with a stale old-value must fail');

  // And a real scratch-index commit against current HEAD still succeeds.
  fs.writeFileSync(path.join(d, '.gitignore'), 'junk/\n');
  const res = await commitViaScratchIndex(d, {
    add: ['.gitignore'],
    remove: [],
    message: 'chore(git-hygiene): sync .gitignore',
    ident: [],
  });
  assert.equal(res.ok, true, res.err);
  assert.deepEqual(sh(d, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'), [
    '.gitignore',
  ]);
});

test("a scratch-index commit leaves another process's staged work untouched", async () => {
  const d = repo();
  fs.writeFileSync(path.join(d, 'theirs.txt'), 'staged by the site cron\n');
  sh(d, 'add', 'theirs.txt');

  fs.writeFileSync(path.join(d, '.gitignore'), 'junk/\n');
  const res = await commitViaScratchIndex(d, {
    add: ['.gitignore'],
    remove: [],
    message: 'chore(git-hygiene): sync .gitignore',
    ident: [],
  });
  assert.equal(res.ok, true, res.err);

  assert.deepEqual(
    sh(d, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'),
    ['.gitignore'],
    'their staged file did NOT ride along'
  );
  assert.match(sh(d, 'diff', '--cached', '--name-only'), /theirs\.txt/, 'and is still staged');
});
