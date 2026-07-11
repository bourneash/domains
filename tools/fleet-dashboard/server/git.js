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

// Convert a git remote URL into a browsable web URL, for a repo-link in the
// Git tab. Handles the two shapes this fleet's remotes actually use — SSH
// scp-syntax through an ssh-config host alias (git@github-bourneash:owner/repo.git)
// and ssh:// URLs — plus already-web http(s) URLs. The host segment of an
// scp-syntax/ssh:// remote may be an ssh-config alias (not a real hostname,
// e.g. "github-bourneash"), so a literal alias can't be used as a web host;
// treat any alias/hostname containing "github" as github.com (true for every
// remote in this fleet) and pass through any other host as-is. Returns null
// if the URL doesn't match a recognized shape rather than guessing wrong.
function remoteToWebUrl(url) {
  if (!url) return null;
  url = url.trim();
  const toWeb = (host, repoPath) => {
    const webHost = /github/i.test(host) ? 'github.com' : host;
    return `https://${webHost}/${repoPath.replace(/\.git$/, '')}`;
  };
  let m = url.match(/^[\w.-]+@([\w.-]+):(.+)$/);
  if (m) return toWeb(m[1], m[2]);
  m = url.match(/^ssh:\/\/[\w.-]+@([\w.-]+)(?::\d+)?\/(.+)$/);
  if (m) return toWeb(m[1], m[2]);
  // An http(s) remote may carry embedded credentials (e.g. a GitHub
  // x-access-token deploy token: https://x-access-token:TOKEN@github.com/...)
  // for a repo whose committer cron uses HTTPS auth instead of SSH. Strip any
  // userinfo before the host — this becomes a clickable link, so leaking the
  // live token into rendered HTML would be a real credential exposure.
  if (/^https?:\/\//.test(url)) return url.replace(/^(https?:\/\/)[^@/]*@/, '$1').replace(/\.git$/, '');
  return null;
}

// Per-repo serialization lock (B3). Each site is a live submodule clone that its
// OWN engineer/committer cron also stages, commits and pushes to. Two dashboard
// git mutations on the same slug (or a commit racing a push) must not interleave
// their `git add`/`commit -- `/`push` and commit an unexpected index state. A tail
// of promises per slug: each caller waits for the previous to settle. (Mirrors the
// withCrontabLock pattern in cron.js — reads/status are NOT locked.)
const _repoChains = new Map();
function withRepoLock(slug, fn) {
  const prev = _repoChains.get(slug) ?? Promise.resolve();
  let release;
  const gate = new Promise((r) => { release = r; });
  // Keep the chain moving even if fn rejects; swallow here so the tail never
  // rejects (callers still see fn's own rejection via the returned promise).
  _repoChains.set(slug, prev.then(() => gate).catch(() => {}));
  return prev.then(() => fn()).finally(release);
}

// Reject anything that could escape the repo or smuggle options into a git
// command. Paths are always passed after `--`, but we still refuse absolute
// paths, parent traversal and NUL/control bytes.
function safeRel(p) {
  if (typeof p !== 'string') return null;
  p = p.trim();
  if (!p || p.startsWith('/') || p.startsWith('-') || /[\0\n\r]/.test(p)) return null;
  // Reject a `..` path COMPONENT (real traversal) but allow `..` inside a name
  // (e.g. "notes..draft.md"), which the old substring check wrongly refused (B9).
  if (p.split(/[\\/]/).includes('..')) return null;
  return p;
}

// Parse `git status --porcelain=v1 --branch -z` into a structured summary.
// Porcelain v1 status codes: XY where X=staged, Y=worktree. We classify each
// path and also surface ahead/behind so the UI can show "needs push".
function parsePorcelain(out) {
  const parts = out.split('\0').filter(Boolean);
  let branch = null, ahead = 0, behind = 0, upstream = null, detached = false;
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (line.startsWith('## ')) {
      const body = line.slice(3);
      // Two special header forms have no branch name to parse (B10):
      //   "## No commits yet on main"   → fresh repo, branch = main
      //   "## HEAD (no branch)"          → detached HEAD, no branch to push to
      if (body.startsWith('No commits yet on ')) {
        branch = body.slice('No commits yet on '.length).trim() || null;
        continue;
      }
      if (body.startsWith('HEAD (no branch)')) {
        branch = null; detached = true;
        continue;
      }
      // ## main...origin/main [ahead 1, behind 2]
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
  return { branch, upstream, ahead, behind, files, detached };
}

// Parse `git for-each-ref --format='%(refname:short)%09%(upstream:short)%09%(HEAD)' refs/heads`.
function parseLocalBranches(out) {
  return out.split('\n').filter(Boolean).map((line) => {
    const [name, upstream, head] = line.split('\t');
    return { name, upstream: upstream || null, current: head === '*' };
  });
}

// Parse `git branch --merged <default>` output into a Set of branch names
// (strips the leading `* ` current-branch marker and surrounding whitespace).
function parseMergedSet(out) {
  const set = new Set();
  for (const raw of out.split('\n')) {
    const name = raw.replace(/^\*?\s+/, '').trim();
    if (name) set.add(name);
  }
  return set;
}

// Parse `git for-each-ref --format='%(refname:short)' refs/remotes/origin` output,
// excluding the symbolic origin/HEAD ref and any remote branch that already has
// a same-named local branch.
function parseRemoteOnlyBranches(remoteOut, localNames) {
  const local = new Set(localNames);
  return remoteOut.split('\n').filter(Boolean)
    .filter((full) => full !== 'origin/HEAD' && full !== 'origin')
    .filter((full) => !local.has(full.replace(/^origin\//, '')))
    .map((name) => ({ name }));
}

// Parse `git stash list --format=%gd%x1f%s%x1f%cr` (ref, message, relative date).
function parseStashList(out) {
  return out.split('\n').filter(Boolean).map((line) => {
    const [ref, message, when] = line.split('\x1f');
    const m = ref.match(/\{(\d+)\}/);
    return { index: m ? parseInt(m[1], 10) : 0, ref, message: message || '', when: when || '' };
  });
}

// Classify a repo's sync status against its upstream for the Git tab's
// color-coded SHA display. `ahead === 0 && behind === 0` against a real
// upstream implies the same commit (localSha === remoteSha) with no extra
// plumbing needed to prove it.
function computeSyncState({ ahead, behind, upstream }) {
  if (!upstream) return 'no-upstream';
  if (behind > 0) return 'diverged-behind';
  if (ahead > 0) return 'ahead';
  return 'synced';
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

  let localSha = null;
  const lsha = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  if (lsha.ok && lsha.out.trim()) localSha = lsha.out.trim();

  let remoteSha = null;
  if (parsed.upstream) {
    const rsha = await git(cwd, ['rev-parse', '--short', '@{u}']);
    if (rsha.ok && rsha.out.trim()) remoteSha = rsha.out.trim();
  }

  const syncState = computeSyncState({ ahead: parsed.ahead, behind: parsed.behind, upstream: parsed.upstream });

  let remoteWebUrl = null;
  const originUrl = await git(cwd, ['remote', 'get-url', 'origin']);
  if (originUrl.ok && originUrl.out.trim()) remoteWebUrl = remoteToWebUrl(originUrl.out.trim());

  return {
    slug, isRepo: true,
    branch: parsed.branch, upstream: parsed.upstream, detached: parsed.detached,
    ahead: parsed.ahead, behind: parsed.behind,
    dirty: tracked.length,
    needsPush: parsed.ahead > 0,
    needsPull: parsed.behind > 0,
    staged: tracked.filter((f) => f.kind === 'staged' || f.kind === 'staged+dirty').length,
    untracked: tracked.filter((f) => f.kind === 'untracked').length,
    lastCommit,
    localSha, remoteSha, syncState, remoteWebUrl,
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
  // Serialize against any other dashboard git mutation on this repo (B3).
  return withRepoLock(slug, async () => {
    const add = await git(cwd, ['add', '--', ...clean]);
    if (!add.ok) throw httpErr(500, add.err.trim() || 'git add failed');
    const c = await git(cwd, ['commit', '-m', msg, '--', ...clean]);
    if (!c.ok) throw httpErr(500, (c.err || c.out).trim() || 'git commit failed');
    return { ok: true, committed: clean.length, out: (c.out || '').trim() };
  });
}

// Add a path to .gitignore (idempotent) and commit the .gitignore. If the path
// is currently tracked, also remove it from the index (git rm --cached) so the
// ignore actually takes effect, and include that in the same commit.
async function ignore(root, slug, p) {
  const cwd = siteDir(root, slug);
  const rel = safeRel(p);
  if (!rel) throw httpErr(400, 'invalid path');
  // Serialize against any other dashboard git mutation on this repo (B3).
  return withRepoLock(slug, () => _ignore(cwd, rel));
}

async function _ignore(cwd, rel) {
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
  // Serialize against any other dashboard git mutation on this repo (B3). Safe
  // for pushAll(), which calls this sequentially and holds no lock of its own.
  return withRepoLock(slug, async () => {
    const s = await status(root, slug);
    if (!s.isRepo) throw httpErr(400, 'not a git repository');
    // A detached HEAD (or a no-commits repo) has no branch to set upstream on;
    // `git push -u origin HEAD` would push to a wrongly-named ref (B10).
    if (!s.branch) throw httpErr(409, s.detached ? 'detached HEAD — checkout a branch before pushing' : 'no branch to push');
    const args = s.upstream ? ['push'] : ['push', '-u', 'origin', s.branch];
    const r = await git(cwd, args);
    if (!r.ok) throw httpErr(500, (r.err || r.out).trim() || 'git push failed');
    // git push writes its progress to stderr even on success.
    return { ok: true, out: (r.err || r.out || '').trim() };
  });
}

// Pull the current branch. Refuses if the working tree has uncommitted
// tracked changes (this repo class is cron-managed — never attempt a merge
// against a dirty tree from the dashboard) or if there's no upstream/branch
// to pull from (same guard shape as push()).
async function pull(root, slug) {
  const cwd = siteDir(root, slug);
  return withRepoLock(slug, async () => {
    const s = await status(root, slug);
    if (!s.isRepo) throw httpErr(400, 'not a git repository');
    if (s.dirty > 0) throw httpErr(409, 'working tree has uncommitted changes — commit or stash before pulling');
    if (!s.branch) throw httpErr(409, s.detached ? 'detached HEAD — checkout a branch before pulling' : 'no branch to pull');
    if (!s.upstream) throw httpErr(409, 'no upstream configured for this branch');
    const r = await git(cwd, ['pull']);
    if (!r.ok) throw httpErr(500, (r.err || r.out).trim() || 'git pull failed');
    // Unlike push(), a fast-forward `git pull` writes its summary to stdout.
    return { ok: true, out: (r.out || r.err || '').trim() };
  });
}

// Unified diff for one path: working tree vs HEAD (covers staged + unstaged).
// For an untracked file (not in HEAD) that diff is empty, so fall back to a
// diff against the empty tree so the new file's contents still show as additions.
async function fileDiff(root, slug, p) {
  const cwd = siteDir(root, slug);
  const rel = safeRel(p);
  if (!rel) throw httpErr(400, 'invalid path');
  let d = await git(cwd, ['diff', 'HEAD', '--', rel]);
  let untracked = false;
  if (d.ok && !d.out.trim()) {
    const ls = await git(cwd, ['ls-files', '--error-unmatch', '--', rel]);
    if (!ls.ok) {                                    // not tracked → show as new file
      untracked = true;
      // empty-tree hash; diff against it renders the whole file as `+` lines.
      d = await git(cwd, ['diff', '--no-index', '--', '/dev/null', path.join(cwd, rel)]);
    }
  }
  return { path: rel, untracked, diff: (d.out || '').replace(/\s+$/, '') };
}

// Resolve the default branch: prefer origin/HEAD's target, else 'main', else
// 'master', else the current branch (best-effort — never throws).
async function defaultBranch(cwd) {
  const sym = await git(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (sym.ok && sym.out.trim()) {
    const m = sym.out.trim().match(/refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  }
  const branchesOut = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const names = branchesOut.ok ? branchesOut.out.split('\n').filter(Boolean) : [];
  if (names.includes('main')) return 'main';
  if (names.includes('master')) return 'master';
  const cur = await git(cwd, ['branch', '--show-current']);
  return (cur.ok && cur.out.trim()) || names[0] || 'main';
}

// Local branches (with upstream/ahead/behind/merged) + remote-only branches
// (in refs/remotes/origin but with no matching local branch), for the Git
// tab's "Branches" sub-section. Never throws — an unreadable repo yields
// empty lists.
async function branches(root, slug) {
  const cwd = siteDir(root, slug);
  const def = await defaultBranch(cwd);

  const localOut = await git(cwd, ['for-each-ref', '--format=%(refname:short)%09%(upstream:short)%09%(HEAD)', 'refs/heads']);
  const local = localOut.ok ? parseLocalBranches(localOut.out) : [];

  const mergedOut = await git(cwd, ['branch', '--merged', def]);
  const merged = mergedOut.ok ? parseMergedSet(mergedOut.out) : new Set();

  for (const b of local) {
    b.merged = merged.has(b.name);
    b.ahead = 0; b.behind = 0;
    if (b.upstream) {
      const rl = await git(cwd, ['rev-list', '--left-right', '--count', `${b.name}...${b.upstream}`]);
      if (rl.ok) {
        const [a, bh] = rl.out.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
        b.ahead = a; b.behind = bh;
      }
    }
  }

  const remoteOut = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']);
  const remoteOnly = remoteOut.ok ? parseRemoteOnlyBranches(remoteOut.out, local.map((b) => b.name)) : [];

  return { defaultBranch: def, local, remoteOnly };
}

// Delete a local branch, but only if it's already merged into the default
// branch (a safe `git branch -d`, never `-D`), isn't the current branch, and
// isn't the default branch itself. Re-checks "merged" live rather than
// trusting a client-supplied flag.
async function deleteBranch(root, slug, branch) {
  const rel = safeRel(branch);
  if (!rel) throw httpErr(400, 'invalid branch name');
  const cwd = siteDir(root, slug);
  return withRepoLock(slug, async () => {
    const b = await branches(root, slug);
    if (rel === b.defaultBranch) throw httpErr(400, 'refusing to delete the default branch');
    const entry = b.local.find((x) => x.name === rel);
    if (!entry) throw httpErr(404, 'branch not found');
    if (entry.current) throw httpErr(400, 'refusing to delete the current branch');
    if (!entry.merged) throw httpErr(400, 'branch is not merged into the default branch');
    const r = await git(cwd, ['branch', '-d', rel]);
    if (!r.ok) throw httpErr(500, (r.err || r.out).trim() || 'git branch -d failed');
    return { ok: true, out: (r.out || '').trim() };
  });
}

function stashIndex(i) {
  const n = parseInt(i, 10);
  if (!Number.isInteger(n) || n < 0 || String(n) !== String(i).trim()) return null;
  return n;
}

async function stashes(root, slug) {
  const cwd = siteDir(root, slug);
  const r = await git(cwd, ['stash', 'list', '--format=%gd\x1f%s\x1f%cr']);
  return r.ok ? parseStashList(r.out) : [];
}

async function stashDiff(root, slug, index) {
  const n = stashIndex(index);
  if (n === null) throw httpErr(400, 'invalid stash index');
  const cwd = siteDir(root, slug);
  const r = await git(cwd, ['stash', 'show', '-p', `stash@{${n}}`]);
  if (!r.ok) throw httpErr(404, (r.err || r.out).trim() || 'stash not found');
  return { ref: `stash@{${n}}`, diff: (r.out || '').replace(/\s+$/, '') };
}

async function dropStash(root, slug, index) {
  const n = stashIndex(index);
  if (n === null) throw httpErr(400, 'invalid stash index');
  const cwd = siteDir(root, slug);
  return withRepoLock(slug, async () => {
    const r = await git(cwd, ['stash', 'drop', `stash@{${n}}`]);
    if (!r.ok) throw httpErr(500, (r.err || r.out).trim() || 'git stash drop failed');
    return { ok: true, out: (r.out || '').trim() };
  });
}

// Push every site that is ahead of origin. Sequential (like restartCrons) to
// avoid a burst of concurrent pushes. Skips repos with nothing to push, no
// branch (detached), or that aren't repos.
async function pushAll(root, slugs) {
  const results = [];
  for (const slug of slugs) {
    const s = await status(root, slug);
    if (!s.isRepo || !(s.ahead > 0)) continue;
    if (!s.branch) { results.push({ slug, ok: false, error: 'detached HEAD — no branch to push' }); continue; }
    try {
      const r = await push(root, slug);
      results.push({ slug, ok: true, out: r.out });
    } catch (e) {
      results.push({ slug, ok: false, error: e.message });
    }
  }
  return { ok: true, pushed: results.filter((r) => r.ok).length, total: results.length, results };
}

// Cheap fleet-wide summary (one row per site) for the dashboard table.
async function summaries(root, slugs) {
  return Promise.all(slugs.map(async (slug) => {
    const s = await status(root, slug);
    const stashList = s.isRepo ? await stashes(root, slug) : [];
    return { slug: s.slug, isRepo: s.isRepo, branch: s.branch, dirty: s.dirty,
      ahead: s.ahead, behind: s.behind, needsPush: s.needsPush, needsPull: s.needsPull,
      localSha: s.localSha, remoteSha: s.remoteSha, syncState: s.syncState,
      stashCount: stashList.length, remoteWebUrl: s.remoteWebUrl, error: s.error || null };
  }));
}

module.exports = { status, summaries, parsePorcelain, computeSyncState, remoteToWebUrl, parseLocalBranches, parseMergedSet, parseRemoteOnlyBranches, parseStashList, branches, deleteBranch, commit, ignore, push, pull, fileDiff, pushAll, stashes, stashDiff, dropStash, stashIndex, safeRel };
