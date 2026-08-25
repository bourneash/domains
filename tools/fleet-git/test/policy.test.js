'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { compilePolicy } = require('../lib/policy');
const { validatePattern, isUniversal } = require('../lib/glob');

const wrap = rules => () => compilePolicy({ version: 1, ignore_block: [], rules });

test('a universal glob is refused — it would untrack whole repositories', () => {
  for (const pat of ['**', '*', '**/*', '**/**', './**']) {
    assert.throws(
      wrap([{ id: 'x', action: 'ignore', scope: 'fleet', untrack: true, match: [pat] }]),
      /universal glob/,
      `${pat} must be refused`
    );
  }
});

test('unsupported glob syntax is refused at load time, not silently never-matched', () => {
  // Each of these compiles to a regex that can never match a normalised path.
  // For a `block` rule that means a credential quietly slips through.
  for (const pat of ['/secrets/**', '!keep', 'ops/[abc].md', 'ops\\win.md']) {
    assert.throws(
      wrap([{ id: 'x', action: 'block', scope: 'fleet', match: [pat] }]),
      /pattern/,
      `${pat} must be refused`
    );
  }
  assert.equal(validatePattern('ops/**'), null);
  assert.equal(isUniversal('ops/**'), false);
});

test('block rules are hoisted without changing which non-block rule wins', () => {
  const p = compilePolicy({
    version: 1,
    ignore_block: [],
    rules: [
      { id: 'first', action: 'commit', scope: 'fleet', group: 'a', match: ['ops/**'] },
      { id: 'second', action: 'commit', scope: 'fleet', group: 'b', match: ['ops/tasks/**'] },
      { id: 'sec', action: 'block', scope: 'fleet', match: ['**/*.pem'] },
    ],
  });
  assert.equal(p.rules[0].id, 'sec', 'block is evaluated first');
  assert.deepEqual(
    p.rules.slice(1).map(r => r.id),
    ['first', 'second'],
    'relative order of the rest is preserved, so first-match-wins is unchanged'
  );
});

test('the git environment is an allowlist: no repo-location vars, identity and transport kept', () => {
  const { GIT_ENV_ALLOW, CLEAN_GIT_ENV } = require('../lib/gitexec');
  for (const bad of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_NAMESPACE',
  ])
    assert.equal(GIT_ENV_ALLOW.includes(bad), false, `${bad} must never reach a git child`);
  for (const needed of ['PATH', 'HOME', 'GIT_SSH_COMMAND', 'GIT_AUTHOR_NAME'])
    assert.ok(GIT_ENV_ALLOW.includes(needed), `${needed} is required`);
  // The cron sources a .env full of live tokens into this process; none of it
  // may be handed to git (which honours per-repo core.sshCommand/aliases).
  for (const secret of ['SLACK_BOT_TOKEN', 'CLOUDFLARE_API_TOKEN', 'ANTHROPIC_API_KEY'])
    assert.equal(secret in CLEAN_GIT_ENV, false, `${secret} must not be in the git env`);
  assert.equal(
    CLEAN_GIT_ENV.GIT_TERMINAL_PROMPT,
    '0',
    'git must never block on a credential prompt'
  );
});
