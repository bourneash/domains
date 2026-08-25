'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gi = require('../lib/gitignore');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-git-'));

test('sync creates, is idempotent, and never touches the repo own lines', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, '.gitignore'), 'site-specific/\n');
  assert.equal(gi.sync(d, ['a/', 'b/']).changed, true);
  const first = fs.readFileSync(path.join(d, '.gitignore'), 'utf8');
  assert.match(first, /site-specific\//);
  assert.equal(gi.sync(d, ['a/', 'b/']).changed, false, 'second sync is a no-op');

  assert.equal(gi.sync(d, ['a/', 'b/', 'c/']).changed, true);
  const second = fs.readFileSync(path.join(d, '.gitignore'), 'utf8');
  assert.match(second, /site-specific\//, 'own lines survive a block update');
  assert.match(second, /^c\/$/m);
  assert.equal(
    (second.match(new RegExp(gi.BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length,
    1
  );
});

test('requireExisting refuses to adopt a repo that has no managed block', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, '.gitignore'), 'node_modules/\n');
  const r = gi.sync(d, ['a/'], { requireExisting: true });
  assert.equal(r.changed, false);
  assert.equal(r.skipped, 'not adopted');
});

test('appendLocal writes outside the managed block and is idempotent', () => {
  const d = tmp();
  gi.sync(d, ['managed/']);
  gi.appendLocal(d, 'one-off.txt');
  assert.equal(gi.appendLocal(d, 'one-off.txt').changed, false);
  const text = fs.readFileSync(path.join(d, '.gitignore'), 'utf8');
  assert.ok(
    text.indexOf('one-off.txt') < text.indexOf(gi.BEGIN),
    'own line stays outside the block'
  );
});

test('dry-run writes nothing', () => {
  const d = tmp();
  gi.sync(d, ['a/'], { write: false });
  assert.equal(fs.existsSync(path.join(d, '.gitignore')), false);
});
