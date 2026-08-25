'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { git } = require('./gitexec');

// Build a commit in a SCRATCH INDEX, never the repo's live one.
//
// The untrack step is `git rm --cached` + a commit — an index change that a
// path-limited `git commit -- <paths>` cannot express (a path-limited commit
// re-reads the worktree for those paths and would simply re-add the file).
// Committing the live index instead means whatever another process staged in
// the meantime rides along: each site is a live submodule its OWN cron
// container stages, commits and pushes into, so `git add -A` over there lands
// inside our "untrack N generated paths" commit — including, in the worst case,
// a credential created after this sweep read status.
//
// A scratch index removes the race entirely: read HEAD's tree, apply exactly
// the entries we intend, write the tree, commit-tree, and fast-forward the ref
// only if it still points where we started. Nothing about the live index or
// worktree is touched, so a concurrent `git add` cannot leak in and we cannot
// clobber its staged work either.
//
// Trade-off, deliberate: a scratch-index commit runs no hooks. That is why this
// is used ONLY for mechanical .gitignore/untrack commits, never for content —
// content commits stay as path-limited `git commit` so the shared pre-commit
// content-guardrails hook still runs on them.
async function commitViaScratchIndex(
  cwd,
  { add = [], remove = [], gitlinks = [], message, trailer, ident = [] }
) {
  const idxFile = path.join(cwd, '.git', `fleet-git-index-${process.pid}-${Date.now()}`);
  const withIndex = args => git(cwd, args, { indexFile: idxFile });
  try {
    const head = await git(cwd, ['rev-parse', 'HEAD']);
    if (!head.ok) return { ok: false, err: 'cannot resolve HEAD' };
    const startSha = head.out.trim();

    const read = await withIndex(['read-tree', startSha]);
    if (!read.ok) return { ok: false, err: read.err.trim() || 'read-tree failed' };

    for (const rel of add) {
      const abs = path.join(cwd, rel);
      if (!fs.existsSync(abs)) continue;
      const a = await withIndex(['update-index', '--add', '--', rel]);
      if (!a.ok) return { ok: false, err: a.err.trim() || `update-index --add ${rel} failed` };
    }
    // A submodule pointer: mode 160000 with an explicitly chosen commit SHA.
    // This is the whole point of pinning — the SHA was verified reachable on the
    // submodule's remote at check time and cannot drift before it is written.
    for (const { path: rel, sha } of gitlinks) {
      if (!/^[0-9a-f]{40}$/.test(String(sha)))
        return { ok: false, err: `bad gitlink sha for ${rel}` };
      const g = await withIndex(['update-index', '--cacheinfo', `160000,${sha},${rel}`]);
      if (!g.ok) return { ok: false, err: g.err.trim() || `update-index gitlink ${rel} failed` };
    }
    for (const rel of remove) {
      const r = await withIndex(['update-index', '--force-remove', '--', rel]);
      if (!r.ok)
        return { ok: false, err: r.err.trim() || `update-index --force-remove ${rel} failed` };
    }

    const tree = await withIndex(['write-tree']);
    if (!tree.ok) return { ok: false, err: tree.err.trim() || 'write-tree failed' };
    const treeSha = tree.out.trim();

    const headTree = await git(cwd, ['rev-parse', `${startSha}^{tree}`]);
    if (headTree.ok && headTree.out.trim() === treeSha) return { ok: true, noop: true };

    const body = trailer ? `${message}\n\n${trailer}\n` : `${message}\n`;
    const cm = await git(cwd, [
      ...ident,
      'commit-tree',
      treeSha,
      '-p',
      startSha,
      '-m',
      body.trim(),
    ]);
    if (!cm.ok) return { ok: false, err: cm.err.trim() || 'commit-tree failed' };
    const newSha = cm.out.trim();

    // Compare-and-swap: refuse if HEAD moved while we were building the tree
    // (the site's own cron committing concurrently), rather than discarding it.
    const upd = await git(cwd, ['update-ref', '-m', message, 'HEAD', newSha, startSha]);
    if (!upd.ok)
      return { ok: false, err: `HEAD moved during commit (concurrent write) — ${upd.err.trim()}` };

    // HEAD moved but the LIVE index still holds the old entries for the paths
    // we changed — leaving e.g. a now-untracked file staged as an addition, so
    // the next sweep would re-add it. A PATH-LIMITED reset syncs exactly those
    // entries to the new HEAD and leaves every other staged path (another
    // process's in-flight work) exactly where it was.
    const touched = [...add, ...remove, ...gitlinks.map(g => g.path)];
    if (touched.length) await git(cwd, ['reset', '-q', 'HEAD', '--', ...touched]);
    return { ok: true, sha: newSha };
  } finally {
    try {
      fs.unlinkSync(idxFile);
    } catch {
      /* nothing to clean */
    }
  }
}

module.exports = { commitViaScratchIndex };
