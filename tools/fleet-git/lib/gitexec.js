'use strict';

const { execFile } = require('node:child_process');

// GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE in the ambient env take precedence
// over `-C <cwd>` in real git — if this ever runs from inside a git hook, every
// call below would be silently redirected at the WRONG repo. Strip them so
// `-C` is the sole source of truth. GIT_SSH_COMMAND is kept: it carries the
// deploy identity the fleet pushes with. (Same guard as fleet-dashboard/server/git.js.)
const CLEAN_GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') || k === 'GIT_SSH_COMMAND')
);

function git(cwd, args, { timeout = 120000 } = {}) {
  return new Promise(resolve => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout, maxBuffer: 16 * 1024 * 1024, env: CLEAN_GIT_ENV },
      (err, stdout, stderr) =>
        resolve({
          ok: !err,
          out: stdout || '',
          err: stderr || (err && err.message) || '',
          code: err ? (err.code ?? 1) : 0,
        })
    );
  });
}

// Parse `git status --porcelain=v1 --branch -z`.
function parsePorcelain(out) {
  const parts = out.split('\0').filter(Boolean);
  let branch = null,
    upstream = null,
    ahead = 0,
    behind = 0,
    detached = false;
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (line.startsWith('## ')) {
      const body = line.slice(3);
      if (body.startsWith('No commits yet on ')) {
        branch = body.slice('No commits yet on '.length).trim() || null;
        continue;
      }
      if (body.startsWith('HEAD (no branch)')) {
        detached = true;
        continue;
      }
      const m = body.match(/^([^.\s]+(?:\.[^.\s]+)*)(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?/);
      if (m) {
        branch = m[1];
        upstream = m[2] || null;
        if (m[3]) {
          const a = m[3].match(/ahead (\d+)/);
          if (a) ahead = parseInt(a[1], 10);
          const b = m[3].match(/behind (\d+)/);
          if (b) behind = parseInt(b[1], 10);
        }
      }
      continue;
    }
    const x = line[0],
      y = line[1];
    const p = line.slice(3);
    let kind;
    if (x === '?' && y === '?') kind = 'untracked';
    else if (x === '!' && y === '!') kind = 'ignored';
    else if (x === 'D' || y === 'D') kind = 'deleted';
    else if (x !== ' ') kind = 'staged';
    else kind = 'modified';
    if (x === 'R' || x === 'C') i += 1; // rename/copy carries a second path
    if (kind !== 'ignored')
      files.push({ code: x + y, kind, path: p, staged: x !== ' ' && x !== '?' });
  }
  return { branch, upstream, ahead, behind, detached, files };
}

async function status(cwd) {
  const r = await git(cwd, ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '-z']);
  if (!r.ok && !r.out)
    return { isRepo: false, error: r.err.trim() || 'not a git repository', files: [] };
  return { isRepo: true, ...parsePorcelain(r.out) };
}

module.exports = { git, status, parsePorcelain };
