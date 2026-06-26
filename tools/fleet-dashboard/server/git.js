'use strict';

const { execFile } = require('node:child_process');
const { siteDir } = require('./sites');

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: stdout || '', err: stderr || (err && err.message) || '' }));
  });
}

// Parse `git status --porcelain=v1 --branch -z` into a structured summary.
// Porcelain v1 status codes: XY where X=staged, Y=worktree. We classify each
// path and also surface ahead/behind so the UI can show "needs push".
function parsePorcelain(out) {
  const parts = out.split('\0').filter(Boolean);
  let branch = null, ahead = 0, behind = 0, upstream = null;
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (line.startsWith('## ')) {
      // ## main...origin/main [ahead 1, behind 2]
      const body = line.slice(3);
      const m = body.match(/^([^.\s]+(?:\.[^.\s]+)*)(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?/);
      if (m) {
        branch = m[1];
        upstream = m[2] || null;
        if (m[3]) {
          const a = m[3].match(/ahead (\d+)/); if (a) ahead = parseInt(a[1], 10);
          const b = m[3].match(/behind (\d+)/); if (b) behind = parseInt(b[1], 10);
        }
      }
      continue;
    }
    const x = line[0], y = line[1], rest = line.slice(3);
    let pathName = rest, kind;
    if (x === '?' && y === '?') kind = 'untracked';
    else if (x === '!' && y === '!') kind = 'ignored';
    else if (x !== ' ' && y !== ' ') kind = 'staged+dirty';
    else if (x !== ' ') kind = 'staged';
    else kind = 'modified';
    // Renames/copies carry a second NUL-separated path (the original).
    if (x === 'R' || x === 'C') { i += 1; /* consume the from-path */ }
    files.push({ code: (x + y).trim() || (x + y), kind, path: pathName });
  }
  return { branch, upstream, ahead, behind, files };
}

// Full git snapshot for one site repo (submodule). Never throws.
async function status(root, slug) {
  const cwd = siteDir(root, slug);
  const r = await git(cwd, ['status', '--porcelain=v1', '--branch', '-z']);
  if (!r.ok && !r.out) {
    return { slug, isRepo: false, error: r.err.trim() || 'not a git repository', files: [],
      dirty: 0, ahead: 0, behind: 0, branch: null, upstream: null };
  }
  const parsed = parsePorcelain(r.out);
  const tracked = parsed.files.filter((f) => f.kind !== 'ignored');
  return {
    slug, isRepo: true,
    branch: parsed.branch, upstream: parsed.upstream,
    ahead: parsed.ahead, behind: parsed.behind,
    dirty: tracked.length,
    needsPush: parsed.ahead > 0,
    needsPull: parsed.behind > 0,
    files: tracked,
  };
}

// Cheap fleet-wide summary (one row per site) for the dashboard table.
async function summaries(root, slugs) {
  return Promise.all(slugs.map(async (slug) => {
    const s = await status(root, slug);
    return { slug: s.slug, isRepo: s.isRepo, branch: s.branch, dirty: s.dirty,
      ahead: s.ahead, behind: s.behind, needsPush: s.needsPush, needsPull: s.needsPull,
      error: s.error || null };
  }));
}

module.exports = { status, summaries, parsePorcelain };
