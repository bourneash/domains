'use strict';
// The submodule-pointer path is the highest-blast-radius code in this tool: a
// parent gitlink bumped to a commit that was never pushed makes that site's
// state unreachable from anywhere but one disk. It is exercised here against a
// real parent repo + real submodule + real bare remotes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Own lock file: node --test runs test files in parallel, and these tests each
// take the sweep lock.
process.env.FLEET_GIT_LOCK = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-git-ptrlock-')),
  'sweep.lock'
);

const { sweep } = require('../lib/sweep');
const { load: loadPolicy } = require('../lib/policy');

const policy = loadPolicy();
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);
const sh = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: CLEAN_ENV });

function initRepo(dir, remote) {
  execFileSync('git', ['init', '-b', 'main', dir], { env: CLEAN_ENV });
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'test');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  sh(dir, 'config', 'protocol.file.allow', 'always');
  if (remote) sh(dir, 'remote', 'add', 'origin', remote);
}

// A parent repo with one real submodule under sites/, both with bare remotes.
function makeFleet() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-git-ptr-'));
  const subRemote = path.join(base, 'sub.git');
  const parentRemote = path.join(base, 'parent.git');
  const subSeed = path.join(base, 'sub-seed');
  const parent = path.join(base, 'parent');
  execFileSync('git', ['init', '--bare', '-b', 'main', subRemote], { env: CLEAN_ENV });
  execFileSync('git', ['init', '--bare', '-b', 'main', parentRemote], { env: CLEAN_ENV });

  initRepo(subSeed, subRemote);
  fs.mkdirSync(path.join(subSeed, 'ops', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(subSeed, 'ops/tasks/seed.md'), 'seed\n');
  sh(subSeed, 'add', '-A');
  sh(subSeed, 'commit', '-m', 'init');
  sh(subSeed, 'push', '-u', 'origin', 'main');

  initRepo(parent, parentRemote);
  fs.writeFileSync(path.join(parent, 'README.md'), '# parent\n');
  sh(parent, 'add', '-A');
  sh(parent, 'commit', '-m', 'init');
  sh(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', subRemote, 'sites/a.com');
  sh(parent, 'commit', '-m', 'add submodule');
  sh(parent, 'push', '-u', 'origin', 'main');

  const sub = path.join(parent, 'sites/a.com');
  sh(sub, 'config', 'user.email', 'test@example.com');
  sh(sub, 'config', 'user.name', 'test');
  sh(sub, 'config', 'commit.gpgsign', 'false');
  return { base, parent, sub, subRemote, parentRemote };
}

const pointerSha = (parent, p) => sh(parent, 'ls-tree', 'HEAD', p).trim().split(/\s+/)[2];

test('a pointer is bumped only after the submodule commit is on its remote', async () => {
  const { parent, sub } = makeFleet();
  fs.writeFileSync(path.join(sub, 'ops/tasks/new.md'), 'work\n');

  const rep = await sweep(parent, { apply: true, push: true });
  assert.deepEqual(rep.errors, []);

  const subHead = sh(sub, 'rev-parse', 'HEAD').trim();
  const subRemoteHead = sh(sub, 'rev-parse', '@{u}').trim();
  assert.equal(subHead, subRemoteHead, 'the submodule work was pushed');
  assert.equal(pointerSha(parent, 'sites/a.com'), subHead, 'parent pointer matches the pushed SHA');
});

test('a pointer is HELD when the submodule commit exists only locally', async () => {
  const { parent, sub } = makeFleet();
  const before = pointerSha(parent, 'sites/a.com');

  // Commit in the submodule WITHOUT pushing — exactly the state a site's own
  // cron leaves behind when its push fails.
  fs.writeFileSync(path.join(sub, 'ops/tasks/local-only.md'), 'unpushed\n');
  sh(sub, 'add', '-A');
  sh(sub, 'commit', '-m', 'local only');

  const rep = await sweep(parent, { apply: true, push: true, only: ['domains'] });
  const parentResult = rep.results.find(r => r.slug === 'domains');
  const holds = parentResult.acts.filter(a => a.action === 'hold');

  assert.equal(holds.length, 1, 'the pointer is held');
  assert.match(holds[0].detail, /not the commit on its remote|unpushed/);
  assert.equal(pointerSha(parent, 'sites/a.com'), before, 'pointer did NOT move');
});

test('a pointer is HELD when the submodule branch has no upstream at all', async () => {
  const { parent, sub } = makeFleet();
  const before = pointerSha(parent, 'sites/a.com');

  fs.writeFileSync(path.join(sub, 'ops/tasks/x.md'), 'x\n');
  sh(sub, 'add', '-A');
  sh(sub, 'commit', '-m', 'work');
  // Strip the upstream: `ahead` now reports 0, which the old check accepted.
  sh(sub, 'branch', '--unset-upstream');

  const rep = await sweep(parent, { apply: true, push: true, only: ['domains'] });
  const parentResult = rep.results.find(r => r.slug === 'domains');
  const holds = parentResult.acts.filter(a => a.action === 'hold');

  assert.equal(holds.length, 1);
  assert.match(holds[0].detail, /no upstream/);
  assert.equal(pointerSha(parent, 'sites/a.com'), before, 'pointer did NOT move');
});
