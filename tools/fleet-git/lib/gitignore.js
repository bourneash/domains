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
  if (e === -1) return { before: text.slice(0, b), block: text.slice(b), after: '' };
  return {
    before: text.slice(0, b),
    block: text.slice(b, e + END.length),
    after: text.slice(e + END.length),
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

// Append a one-off path to the site's OWN section (outside the managed block).
// Used for a per-repo ignore decision that isn't a fleet policy line.
function appendLocal(dir, rel, { write = true } = {}) {
  const p = path.join(dir, '.gitignore');
  let text = '';
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    /* none yet */
  }
  const parts = split(text);
  const own = parts.before + parts.after;
  if (
    own
      .split('\n')
      .map(s => s.trim())
      .includes(rel)
  )
    return { changed: false, path: p };
  const prefix = parts.before.length && !parts.before.endsWith('\n') ? '\n' : '';
  const next = parts.before + prefix + rel + '\n' + (parts.block || '') + parts.after;
  if (write) fs.writeFileSync(p, next);
  return { changed: true, path: p };
}

module.exports = { sync, appendLocal, render, split, BEGIN, END };
