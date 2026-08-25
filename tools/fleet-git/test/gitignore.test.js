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

test('appendLocal writes BELOW the managed block (gitignore is last-match-wins)', () => {
  const d = tmp();
  gi.sync(d, ['managed/']);
  gi.appendLocal(d, 'one-off.txt');
  assert.equal(gi.appendLocal(d, 'one-off.txt').changed, false, 'idempotent');
  const text = fs.readFileSync(path.join(d, '.gitignore'), 'utf8');
  assert.ok(
    text.indexOf('one-off.txt') > text.indexOf(gi.END),
    'a line above the block would lose to it — an operator !negation could never win'
  );
});

test('a .gitignore with BEGIN but no END is refused, not silently truncated', () => {
  const d = tmp();
  const p = path.join(d, '.gitignore');
  fs.writeFileSync(p, `keep-me\n${gi.BEGIN}\nold/\n\nIMPORTANT-LOCAL-RULE\n`);
  const before = fs.readFileSync(p, 'utf8');
  const r = gi.sync(d, ['a/', 'b/']);
  assert.equal(r.changed, false);
  assert.match(r.skipped, /malformed/);
  assert.equal(fs.readFileSync(p, 'utf8'), before, 'file is untouched');
});

test('a duplicated managed block is refused rather than half-maintained', () => {
  const d = tmp();
  const p = path.join(d, '.gitignore');
  const block = `${gi.BEGIN}\nold/\n${gi.END}`;
  fs.writeFileSync(p, `${block}\nlocal\n${block}\n`);
  const before = fs.readFileSync(p, 'utf8');
  const r = gi.sync(d, ['a/']);
  assert.equal(r.changed, false);
  assert.match(r.skipped, /duplicate/);
  assert.equal(fs.readFileSync(p, 'utf8'), before);
});

test('anchorPattern keeps policy and gitignore semantics in agreement', () => {
  // A slash-less policy glob is root-anchored; a slash-less gitignore line
  // matches at ANY depth. Writing the policy form verbatim would hide every
  // matching file repo-wide.
  assert.equal(gi.anchorPattern('*.png'), '/*.png');
  assert.equal(gi.anchorPattern('Findings-*.md'), '/Findings-*.md');
  assert.equal(gi.anchorPattern('**/__pycache__/'), '**/__pycache__/');
  assert.equal(gi.anchorPattern('ops/logs/'), 'ops/logs/');
  assert.equal(gi.anchorPattern('/already'), '/already');
});

test('dry-run writes nothing', () => {
  const d = tmp();
  gi.sync(d, ['a/'], { write: false });
  assert.equal(fs.existsSync(path.join(d, '.gitignore')), false);
});
