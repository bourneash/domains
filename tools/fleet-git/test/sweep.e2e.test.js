'use strict';
// End-to-end against a real git repo + bare remote in a temp dir. This is the
// part that mutates history, so it is exercised for real rather than mocked.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { executeRepo } = require('../lib/sweep');
const { plan } = require('../lib/classify');
const { load: loadPolicy } = require('../lib/policy');
const { status } = require('../lib/gitexec');
const gitignore = require('../lib/gitignore');

const policy = loadPolicy();

// These tests are also run by the shared pre-commit hook, whose environment
// carries GIT_DIR / GIT_INDEX_FILE for the repo being committed — and those
// take precedence over `-C <cwd>` in real git. Without stripping them, every
// helper call below would silently operate on the MONOREPO's index instead of
// the temp repo. (The library under test strips them for the same reason; the
// test harness has to do it too.)
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);

function sh(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: CLEAN_ENV });
}

function write(dir, rel, body) {
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
}

function makeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-git-e2e-'));
  const remote = path.join(base, 'remote.git');
  const work = path.join(base, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { env: CLEAN_ENV });
  execFileSync('git', ['init', '-b', 'main', work], { env: CLEAN_ENV });
  sh(work, 'config', 'user.email', 'test@example.com');
  sh(work, 'config', 'user.name', 'test');
  sh(work, 'config', 'commit.gpgsign', 'false');
  sh(work, 'remote', 'add', 'origin', remote);
  write(work, 'README.md', '# test\n');
  sh(work, 'add', '-A');
  sh(work, 'commit', '-m', 'init');
  sh(work, 'push', '-u', 'origin', 'main');
  return { base, work, remote };
}

const run = async (work, opts = {}) => {
  const st = await status(work);
  const p = plan(st, { slug: 'test.com', policy });
  const res = await executeRepo({ slug: 'test.com', dir: work }, p, policy, {
    apply: true,
    push: true,
    ...opts,
  });
  return { p, ...res };
};

test('sweep commits policy-known churn, ignores generated files, pushes, and leaves the tree clean', async () => {
  const { work } = makeRepo();
  // adopt the managed .gitignore block (the deliberate step a sweep won't do)
  gitignore.sync(work, policy.ignoreBlock);
  sh(work, 'add', '-A');
  sh(work, 'commit', '-m', 'adopt gitignore');

  write(work, 'ops/tasks/backlog/a.md', 'task\n');
  write(work, 'ops/guide-queue/ideas/b.md', 'idea\n');
  write(work, 'ops/scripts/__pycache__/x.pyc', 'junk\n');

  const { errors } = await run(work);
  assert.deepEqual(errors, []);

  const after = await status(work);
  assert.deepEqual(after.files, [], 'working tree is clean');
  assert.equal(after.ahead, 0, 'everything is pushed');

  const log = sh(work, 'log', '--format=%s', 'origin/main');
  assert.match(log, /sync task board/);
  assert.match(log, /sync guide queue/);
  // the pyc was ignored, never committed
  assert.equal(sh(work, 'ls-files').includes('.pyc'), false);
});

test('sweep untracks a generated file that was already committed', async () => {
  const { work } = makeRepo();
  gitignore.sync(work, policy.ignoreBlock);
  write(work, 'ops/board/last-run.json', '{"a":1}\n');
  // -f: the managed block already ignores it, but this repo committed it
  // before the block existed — that is exactly the drift being repaired.
  sh(work, 'add', '-A');
  sh(work, 'add', '-f', 'ops/board/last-run.json');
  sh(work, 'commit', '-m', 'seed');
  sh(work, 'push');

  write(work, 'ops/board/last-run.json', '{"a":2}\n');
  const { errors } = await run(work);
  assert.deepEqual(errors, []);

  assert.equal(
    sh(work, 'ls-files').includes('ops/board/last-run.json'),
    false,
    'untracked from the index'
  );
  assert.ok(fs.existsSync(path.join(work, 'ops/board/last-run.json')), 'file still on disk');
  assert.deepEqual((await status(work)).files, []);
});

test('a credential in the tree halts the repo — nothing is committed or pushed', async () => {
  const { work } = makeRepo();
  write(work, 'ops/tasks/a.md', 'task\n');
  write(work, 'secrets.pem', 'KEY\n');
  sh(work, 'add', 'secrets.pem');

  const { p, acts } = await run(work);
  assert.equal(p.blocked.length, 1);
  assert.ok(acts.some(a => a.action === 'blocked'));
  assert.equal(sh(work, 'log', '--format=%s', 'origin/main').trim(), 'init', 'nothing was pushed');
});

test('untracking is skipped (not forced) when the repo has unrelated staged work', async () => {
  const { work } = makeRepo();
  gitignore.sync(work, policy.ignoreBlock);
  write(work, 'ops/board/last-run.json', '{}\n');
  write(work, 'keep.md', 'x\n');
  sh(work, 'add', '-A');
  sh(work, 'add', '-f', 'ops/board/last-run.json');
  sh(work, 'commit', '-m', 'seed');
  write(work, 'ops/board/last-run.json', '{"b":2}\n');

  // simulate the site's own cron staging something mid-sweep
  const st = await status(work);
  const p = plan(st, { slug: 'test.com', policy });
  write(work, 'keep.md', 'changed\n');
  sh(work, 'add', 'keep.md');

  const { errors } = await executeRepo({ slug: 'test.com', dir: work }, p, policy, {
    apply: true,
    push: false,
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unrelated staged changes/);
  assert.ok(sh(work, 'ls-files').includes('ops/board/last-run.json'), 'still tracked — not forced');
});
