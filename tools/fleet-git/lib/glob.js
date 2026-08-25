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

module.exports = { toRegex, normPath, compile, matchesAny };
