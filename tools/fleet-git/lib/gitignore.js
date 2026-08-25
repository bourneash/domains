'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BEGIN = '# >>> fleet-git managed block — edit tools/fleet-git/policy.json, not here >>>';
const END = '# <<< fleet-git managed block <<<';

// Render the managed block. Everything between the markers is owned by
// policy.json; anything outside is the site's own and is never touched.
function render(lines) {
  return [BEGIN, ...lines, END].join('\n');
}

function split(text) {
  const b = text.indexOf(BEGIN);
  if (b === -1) return { before: text, block: null, after: '' };
  const e = text.indexOf(END, b);
  // An orphaned BEGIN with no END — a merge resolution that dropped the END
  // line, a truncated write, a hand-edit. Returning `after: ''` here would make
  // sync() write `before + want` and SILENTLY DELETE every line below the
  // marker. Refuse to touch the file instead.
  if (e === -1) return { before: text, block: null, after: '', malformed: 'BEGIN without END' };
  const tail = text.slice(e + END.length);
  // A second BEGIN after this block's END is a duplicated block (bad merge).
  // Only the first would ever be maintained, leaving stale patterns live
  // forever with no self-heal path — refuse that too.
  if (tail.includes(BEGIN))
    return { before: text, block: null, after: '', malformed: 'duplicate managed block' };
  return {
    before: text.slice(0, b),
    block: text.slice(b, e + END.length),
    after: tail,
  };
}

// Idempotently sync the managed block into <dir>/.gitignore.
// Returns { changed, created, path }.
// `requireExisting` is the guard that keeps the unattended sweep from doing a
// silent fleet-wide rollout: it only maintains the managed block in repos that
// have ALREADY adopted it. Adoption itself is the deliberate, reviewable step
// (`fleet-git ignore-sync --apply`).
function sync(dir, lines, { write = true, requireExisting = false } = {}) {
  const p = path.join(dir, '.gitignore');
  let text = '';
  let created = false;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    created = true;
  }
  const want = render(lines);
  const parts = split(text);
  // Never rewrite a malformed file — rewriting is exactly how content below a
  // half-present marker gets destroyed.
  if (parts.malformed)
    return { changed: false, created: false, path: p, skipped: `malformed: ${parts.malformed}` };
  if (requireExisting && parts.block === null)
    return { changed: false, created: false, path: p, skipped: 'not adopted' };
  if (parts.block === want) return { changed: false, created: false, path: p };
  let next;
  if (parts.block === null) {
    const sep = text.length && !text.endsWith('\n') ? '\n\n' : text.length ? '\n' : '';
    next = text + sep + want + '\n';
  } else {
    next = parts.before + want + parts.after;
  }
  if (write) fs.writeFileSync(p, next);
  return { changed: true, created, path: p };
}

// Append a one-off pattern to the site's OWN section, BELOW the managed block.
// Below, not above: gitignore is last-match-wins, so a line written above the
// block loses to it — an operator's `!keep-me` could never take effect.
function appendLocal(dir, rel, { write = true } = {}) {
  const p = path.join(dir, '.gitignore');
  let text = '';
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    /* none yet */
  }
  const parts = split(text);
  if (parts.malformed) return { changed: false, path: p, skipped: `malformed: ${parts.malformed}` };
  const already = text
    .split('\n')
    .map(x => x.trim())
    .includes(rel);
  if (already) return { changed: false, path: p };
  const head = parts.before + (parts.block || '') + parts.after;
  const prefix = head.length && !head.endsWith('\n') ? '\n' : '';
  const next = head + prefix + rel + '\n';
  if (write) fs.writeFileSync(p, next);
  return { changed: true, path: p };
}

// A gitignore pattern with no slash matches at ANY depth; a fleet-git policy
// glob with no slash is root-anchored (`toRegex('*.png')` -> `^[^/]*\.png$`).
// Writing the policy form verbatim would silently ignore every matching file
// anywhere in the repo — `*.png` in the monorepo root would hide a new
// dashboard asset from `git add`. Anchor it so the two agree.
function anchorPattern(pattern) {
  const pat = String(pattern);
  if (pat.startsWith('/') || pat.startsWith('!')) return pat;
  // `**/x` and `a/b` already carry gitignore's any-depth / path semantics.
  const body = pat.endsWith('/') ? pat.slice(0, -1) : pat;
  if (body.includes('/')) return pat;
  return '/' + pat;
}

module.exports = { sync, appendLocal, anchorPattern, render, split, BEGIN, END };
