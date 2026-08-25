'use strict';

// Minimal, dependency-free gitignore-flavoured glob → RegExp.
//
// Supported: `*` (one segment), `**` (any depth), `?` (one char), a trailing
// `/` (directory prefix). `X/**` is normalised to `X/` so a pattern written
// either way matches BOTH the directory itself and everything under it —
// `git status --porcelain` reports an untracked directory as a single
// `path/` entry but a tracked change inside it as `path/file`, and a policy
// rule must not care which shape it is looking at.
function toRegex(pattern) {
  let p = String(pattern);
  // `X/**` ≡ `X/` (dir prefix). Applied repeatedly for `X/**/**`.
  while (p.endsWith('/**')) p = p.slice(0, -2);
  const dirPrefix = p.endsWith('/');
  if (dirPrefix) p = p.slice(0, -1);

  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          // `**/` — zero or more leading segments, so `**/x` matches `x` too.
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + out + (dirPrefix ? '(?:/.*)?' : '') + '$');
}

// Normalise a git-reported path for matching: strip the trailing slash git
// puts on untracked directories, and any `./` prefix.
function normPath(p) {
  let s = String(p).replace(/^\.\//, '');
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

function compile(patterns) {
  return (patterns || []).map(toRegex);
}

function matchesAny(regexes, p) {
  const s = normPath(p);
  return regexes.some(re => re.test(s));
}

// The supported subset is deliberately small. Anything outside it (a leading
// `/`, a `!` negation, a `[...]` class) compiles to a regex that can never
// match a normalised path — i.e. a rule written that way fails OPEN and
// silently. For a `block` rule that means a credential slips through. Reject
// at load time instead.
function validatePattern(pattern) {
  const pat = String(pattern);
  if (!pat.trim()) return 'empty pattern';
  if (pat.startsWith('/'))
    return 'leading "/" is not supported (paths are repo-relative, unrooted)';
  if (pat.startsWith('!')) return '"!" negation is not supported in rules (use an `except` list)';
  if (/[[\]]/.test(pat)) return '"[...]" character classes are not supported';
  if (pat.includes('\\')) return 'backslashes are not supported (use "/" separators)';
  return null;
}

// A glob that matches essentially everything. Such a rule is never a real
// policy decision — as an `ignore` + `untrack` rule it would `git rm --cached`
// entire repositories on the next unattended sweep.
const UNIVERSAL = new Set(['**', '*', '**/*', '**/**', '.', './**', '*/**']);
function isUniversal(pattern) {
  return UNIVERSAL.has(String(pattern).trim().replace(/\/+$/, ''));
}

module.exports = { toRegex, normPath, compile, matchesAny, validatePattern, isUniversal };
