'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
);
test('handoff check-in preserves unrelated staging, includes hook recovery snapshot, and releases lock before push', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'executive-checkin-'));
  const git = args =>
    execFileSync('git', args, { cwd: root, env: cleanEnv, encoding: 'utf8' }).trim();
  try {
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.com']);
    fs.mkdirSync(path.join(root, 'tools/executive'), { recursive: true });
    fs.mkdirSync(path.join(root, 'ops/executive/handoffs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ops/executive/handoffs/case.json'), '{}');
    fs.writeFileSync(path.join(root, 'recovery.snapshot'), 'initial');
    fs.writeFileSync(path.join(root, 'unrelated.txt'), 'original');
    git(['add', 'ops', 'recovery.snapshot', 'unrelated.txt']);
    git(['commit', '-qm', 'base']);
    fs.copyFileSync(
      path.join(__dirname, 'checkin.sh'),
      path.join(root, 'tools/executive/checkin.sh')
    );
    fs.writeFileSync(
      path.join(root, '.git/hooks/pre-commit'),
      '#!/bin/sh\nprintf updated > recovery.snapshot\ngit add recovery.snapshot\n',
      { mode: 0o755 }
    );
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(
      path.join(bin, 'git'),
      `#!/bin/sh\nif [ "$1" = push ]; then\n flock -n "${root}/tools/.git-mutation.lock" true || exit 71\n echo "$3" > "${root}/pushed-ref"\n exit 0\nfi\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 }
    );
    fs.writeFileSync(path.join(root, 'unrelated.txt'), 'staged unrelated');
    git(['add', 'unrelated.txt']);
    fs.writeFileSync(path.join(root, 'ops/executive/handoffs/case.json'), '{"changed":true}');
    const result = spawnSync('bash', [path.join(root, 'tools/executive/checkin.sh')], {
      cwd: root,
      env: { ...cleanEnv, PATH: `${bin}:${process.env.PATH}`, EXECUTIVE_HANDOFF_PUSH: '1' },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(
      git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n'),
      ['ops/executive/handoffs/case.json', 'recovery.snapshot']
    );
    assert.equal(git(['show', ':unrelated.txt']), 'staged unrelated');
    assert.equal(git(['show', 'HEAD:unrelated.txt']), 'original');
    assert.equal(git(['show', 'HEAD:recovery.snapshot']), 'updated');
    assert.equal(
      fs.readFileSync(path.join(root, 'pushed-ref'), 'utf8').trim(),
      `${git(['rev-parse', 'HEAD'])}:refs/heads/main`
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
