'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const deployhealth = require('./deployhealth');
const cloudflarebuilds = require('./cloudflarebuilds');

function git(cwd, ...args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deployhealth-'));
  const cwd = path.join(root, 'sites', 'example.com');
  fs.mkdirSync(path.join(cwd, 'site'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'ops'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'site', 'index.html'), 'live\n');
  fs.writeFileSync(path.join(cwd, 'site', 'wrangler.jsonc'), '{"name":"example-com"}\n');
  fs.writeFileSync(path.join(cwd, 'ops', 'state.txt'), 'initial\n');
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'site: initial');
  return { root, cwd };
}

test('deploy health ignores ops-only commits when judging production live state', async () => {
  const { root, cwd } = fixture();
  git(cwd, 'rev-parse', '--is-inside-work-tree');
  fs.writeFileSync(path.join(cwd, 'ops', 'state.txt'), 'ops-only\n');
  git(cwd, 'add', 'ops/state.txt');
  git(cwd, 'commit', '-qm', 'ops: refresh state');

  const oldFetch = global.fetch;
  const oldBuilds = cloudflarebuilds._state().builds;
  cloudflarebuilds._state().builds = [];
  global.fetch = async () => ({
    status: 200,
    json: async () => ({
      success: true,
      result: { items: [{ number: 7, metadata: { created_on: new Date(Date.now() + 1000).toISOString() } }] },
    }),
  });
  try {
    const result = await deployhealth._checkOne(root, 'example.com', {
      accountId: 'account',
      token: 'token',
    });
    assert.equal(result.live, true);
    assert.equal(result.status, 'ops-only');
    assert.equal(result.opsOnly, true);
    assert.match(result.reason, /production is unaffected/);
  } finally {
    global.fetch = oldFetch;
    cloudflarebuilds._state().builds = oldBuilds;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
