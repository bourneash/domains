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
