'use strict';

// Guardrail tests for git.js's mutating operations — commit() and ignore().
// These exercise real `git` against a throwaway tmp repo laid out the way the
// dashboard expects (root/sites/<slug>/...), so we're testing the actual
// child_process behaviour, not a mock of it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const git = require('./git');

function sh(cwd, args) {
  execFileSync('git', args, { cwd });
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-git-'));
  const cwd = path.join(root, 'sites', 'example.com');
  fs.mkdirSync(cwd, { recursive: true });
  sh(cwd, ['init', '-q']);
  sh(cwd, ['config', 'user.email', 'test@example.com']);
  sh(cwd, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(cwd, 'README.md'), 'hello\n');
  sh(cwd, ['add', '--', 'README.md']);
  sh(cwd, ['commit', '-q', '-m', 'initial']);
  return { root, cwd };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/* ---- commit(): input validation before any git call ---- */
test('commit() rejects an empty/invalid path list without touching git', async () => {
  const { root, cwd } = makeRepo();
  try {
    await assert.rejects(
      () => git.commit(root, 'example.com', [], 'msg'),
      e => e.httpStatus === 400
    );
    await assert.rejects(
      () => git.commit(root, 'example.com', ['../escape'], 'msg'),
      e => e.httpStatus === 400
    );
    await assert.rejects(
      () => git.commit(root, 'example.com', [null, undefined, '/abs'], 'msg'),
      e => e.httpStatus === 400
    );
  } finally {
    cleanup(root);
  }
});

test('commit() requires a non-empty message', async () => {
  const { root, cwd } = makeRepo();
  try {
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'x');
    await assert.rejects(
      () => git.commit(root, 'example.com', ['a.txt'], ''),
      e => e.httpStatus === 400
    );
    await assert.rejects(
      () => git.commit(root, 'example.com', ['a.txt'], '   '),
      e => e.httpStatus === 400
    );
  } finally {
    cleanup(root);
  }
});

/* ---- commit(): path-limited — the core safety property (B3-adjacent) ---- */
test('commit() only stages/commits the given paths, leaving other dirty files untouched', async () => {
  const { root, cwd } = makeRepo();
  try {
    fs.writeFileSync(path.join(cwd, 'wanted.txt'), 'wanted\n');
    fs.writeFileSync(path.join(cwd, 'unrelated.txt'), 'unrelated\n');
    const r = await git.commit(root, 'example.com', ['wanted.txt'], 'add wanted.txt');
    assert.equal(r.ok, true);
    assert.equal(r.committed, 1);

    const status = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' });
    // unrelated.txt must still show as untracked; wanted.txt must NOT appear (committed clean).
    assert.match(status, /\?\? unrelated\.txt/);
    assert.doesNotMatch(status, /wanted\.txt/);

    const log = execFileSync('git', ['-C', cwd, 'log', '-1', '--name-only', '--format=%s'], {
      encoding: 'utf8',
    });
    assert.match(log, /add wanted\.txt/);
    assert.match(log, /^wanted\.txt$/m);
    assert.doesNotMatch(log, /unrelated\.txt/);
  } finally {
    cleanup(root);
  }
});

test('commit() surfaces a git error (nothing to commit) as a 500 rather than hanging', async () => {
  const { root, cwd } = makeRepo();
  try {
    // README.md is already committed and unchanged — nothing to stage/commit.
    await assert.rejects(
      () => git.commit(root, 'example.com', ['README.md'], 'no-op'),
      e => e.httpStatus === 500
    );
  } finally {
    cleanup(root);
  }
});

/* ---- ignore(): tracked-file path needs an index commit; guards pre-staged work ---- */
test('ignore() on an untracked path appends to .gitignore and commits just that', async () => {
  const { root, cwd } = makeRepo();
  try {
    const r = await git.ignore(root, 'example.com', 'secrets.env');
    assert.equal(r.ok, true);
    assert.equal(r.tracked, false);
    const gi = fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');
    assert.match(gi, /^secrets\.env$/m);
    const status = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.equal(status.trim(), '');
  } finally {
    cleanup(root);
  }
});

test('ignore() on a tracked path refuses when the repo has unrelated pre-staged changes (409)', async () => {
  const { root, cwd } = makeRepo();
  try {
    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'v1\n');
    sh(cwd, ['add', '--', 'tracked.txt']);
    sh(cwd, ['commit', '-q', '-m', 'add tracked.txt']);
    // Stage unrelated work first.
    fs.writeFileSync(path.join(cwd, 'other.txt'), 'x\n');
    sh(cwd, ['add', '--', 'other.txt']);

    await assert.rejects(
      () => git.ignore(root, 'example.com', 'tracked.txt'),
      e => e.httpStatus === 409
    );
  } finally {
    cleanup(root);
  }
});

test('ignore() on a tracked path with a clean index untracks it (git rm --cached) and commits', async () => {
  const { root, cwd } = makeRepo();
  try {
    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'v1\n');
    sh(cwd, ['add', '--', 'tracked.txt']);
    sh(cwd, ['commit', '-q', '-m', 'add tracked.txt']);

    const r = await git.ignore(root, 'example.com', 'tracked.txt');
    assert.equal(r.ok, true);
    assert.equal(r.tracked, true);
    // File still on disk...
    assert.equal(fs.existsSync(path.join(cwd, 'tracked.txt')), true);
    // ...but no longer tracked by git.
    const lsFiles = execFileSync('git', ['-C', cwd, 'ls-files', '--', 'tracked.txt'], {
      encoding: 'utf8',
    });
    assert.equal(lsFiles.trim(), '');
  } finally {
    cleanup(root);
  }
});

/* ---- safeRel guardrail is the gate every mutating path goes through ---- */
test('commit() rejects a path that tries to smuggle a git option flag', async () => {
  const { root } = makeRepo();
  try {
    await assert.rejects(
      () => git.commit(root, 'example.com', ['-oProxyCommand=evil'], 'msg'),
      e => e.httpStatus === 400
    );
  } finally {
    cleanup(root);
  }
});
