'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { siteDir } = require('./sites');

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: stdout || '', err: stderr || (err && err.message) || '' }));
  });
}

function httpErr(status, msg) { const e = new Error(msg); e.httpStatus = status; return e; }

// Reject anything that could escape the repo or smuggle options into a git
// command. Paths are always passed after `--`, but we still refuse absolute
// paths, parent traversal and NUL/control bytes.
function safeRel(p) {
  if (typeof p !== 'string') return null;
  p = p.trim();
  if (!p || p.startsWith('/') || p.startsWith('-') || p.includes('..') || /[\0\n\r]/.test(p)) return null;
  return p;
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
  // Last commit, for context in the detail panel.
  let lastCommit = null;
  const log = await git(cwd, ['log', '-1', '--format=%h%x1f%s%x1f%cr%x1f%an']);
  if (log.ok && log.out.trim()) {
    const [hash, subject, when, author] = log.out.trim().split('\x1f');
    lastCommit = { hash, subject, when, author };
  }
  return {
    slug, isRepo: true,
    branch: parsed.branch, upstream: parsed.upstream,
    ahead: parsed.ahead, behind: parsed.behind,
    dirty: tracked.length,
    needsPush: parsed.ahead > 0,
    needsPull: parsed.behind > 0,
    staged: tracked.filter((f) => f.kind === 'staged' || f.kind === 'staged+dirty').length,
    untracked: tracked.filter((f) => f.kind === 'untracked').length,
    lastCommit,
    files: tracked,
  };
}

// ---- safe write ops ---------------------------------------------------------

// Stage exactly the given paths and commit ONLY those (path-limited commit, so
// anything else staged in the index by another process is left untouched).
async function commit(root, slug, paths, message) {
  const cwd = siteDir(root, slug);
  const clean = (Array.isArray(paths) ? paths : []).map(safeRel).filter(Boolean);
  if (!clean.length) throw httpErr(400, 'no valid file paths to commit');
  const msg = (message || '').trim();
  if (!msg) throw httpErr(400, 'a commit message is required');
  const add = await git(cwd, ['add', '--', ...clean]);
  if (!add.ok) throw httpErr(500, add.err.trim() || 'git add failed');
  const c = await git(cwd, ['commit', '-m', msg, '--', ...clean]);
  if (!c.ok) throw httpErr(500, (c.err || c.out).trim() || 'git commit failed');
  return { ok: true, committed: clean.length, out: (c.out || '').trim() };
}

// Add a path to .gitignore (idempotent) and commit the .gitignore. If the path
// is currently tracked, also remove it from the index (git rm --cached) so the
// ignore actually takes effect, and include that in the same commit.
async function ignore(root, slug, p) {
  const cwd = siteDir(root, slug);
  const rel = safeRel(p);
  if (!rel) throw httpErr(400, 'invalid path');

  const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', rel]);
  const isTracked = tracked.ok;

  // Untracking a tracked path means committing an index state (a cache removal),
  // which a path-limited commit can't express — so guard against sweeping any
  // unrelated pre-staged work into that index commit.
  if (isTracked) {
    const pre = await git(cwd, ['diff', '--cached', '--name-only']);
    if (pre.ok && pre.out.trim()) {
      throw httpErr(409, 'repo has staged changes — commit or unstage them before ignoring a tracked file');
    }
  }

  const giPath = path.join(cwd, '.gitignore');
  let gi = '';
  try { gi = fs.readFileSync(giPath, 'utf8'); } catch { /* no .gitignore yet */ }
  const present = gi.split('\n').map((s) => s.trim()).includes(rel);
  if (!present) {
    const prefix = gi.length && !gi.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(giPath, `${prefix}${rel}\n`);
  }

  await git(cwd, ['add', '--', '.gitignore']);
  let c;
  if (isTracked) {
    // Remove from the index (file stays on disk) and commit the index as-is —
    // exactly .gitignore + the cache removal, since we verified nothing else
    // was staged.
    const rm = await git(cwd, ['rm', '--cached', '-r', '--', rel]);
    if (!rm.ok) throw httpErr(500, rm.err.trim() || 'git rm --cached failed');
    c = await git(cwd, ['commit', '-m', `chore: gitignore ${rel}`]);
  } else {
    // Untracked file: a path-limited commit of just .gitignore is correct and
    // leaves any other staged work untouched.
    c = await git(cwd, ['commit', '-m', `chore: gitignore ${rel}`, '--', '.gitignore']);
  }
  if (!c.ok) {
    if (/nothing to commit/i.test(c.out + c.err)) return { ok: true, tracked: isTracked, noop: true };
    throw httpErr(500, (c.err || c.out).trim() || 'git commit failed');
  }
  return { ok: true, tracked: isTracked, out: (c.out || '').trim() };
}

// Push the current branch. Sets upstream on first push if none is configured.
async function push(root, slug) {
  const cwd = siteDir(root, slug);
  const s = await status(root, slug);
  if (!s.isRepo) throw httpErr(400, 'not a git repository');
  const args = s.upstream ? ['push'] : ['push', '-u', 'origin', s.branch];
  const r = await git(cwd, args);
  if (!r.ok) throw httpErr(500, (r.err || r.out).trim() || 'git push failed');
  // git push writes its progress to stderr even on success.
  return { ok: true, out: (r.err || r.out || '').trim() };
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

module.exports = { status, summaries, parsePorcelain, commit, ignore, push };
