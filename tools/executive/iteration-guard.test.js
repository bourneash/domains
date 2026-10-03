'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test('schedule pause yields while explicit controlled runs retain access', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-iteration-'));
  try {
    fs.mkdirSync(path.join(root, 'tools/executive/data'), { recursive: true });
    const guard = path.join(__dirname, 'iteration-guard.sh');
    const run = override =>
      spawnSync('bash', ['-c', 'source "$1"; echo continued', 'guard', guard], {
        env: { ...process.env, ROOT: root, TEAM_ITERATION_RUN: override },
        encoding: 'utf8',
      });
    assert.match(run('0').stdout, /continued/);
    fs.writeFileSync(
      path.join(root, 'tools/executive/data/.iteration-paused'),
      'controlled iteration'
    );
    const paused = run('0');
    assert.equal(paused.status, 0);
    assert.match(paused.stdout, /paused/);
    assert.doesNotMatch(paused.stdout, /continued/);
    assert.match(run('1').stdout, /continued/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
