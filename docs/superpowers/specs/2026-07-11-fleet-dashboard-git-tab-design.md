# Fleet Dashboard — Git Tab: SHA display, branches, stashes, pull

Date: 2026-07-11
Status: Approved

## Context

`tools/fleet-dashboard` Git tab (`server/git.js` + the git section of
`server/public/app.js`) already supports: per-repo status (branch, ahead/behind,
dirty file list), per-file diff, per-file `.gitignore`, path-limited commit of
selected files, push, and push-all. Jesse asked for a fuller git management
surface. Several of his asks were already implemented (per-file commit/push,
seeing what's being committed). This spec covers the genuine gaps: SHA
visibility with color-coded sync state, branch listing, stash browsing, and a
pull action.

## Goals

1. Show the local branch's short SHA and the tracked remote's short SHA side by
   side, color-coded so a mismatch is visible at a glance.
2. Show other local branches (not just the current one) and remote-only
   branches, flagging which are safely mergeable/deletable.
3. Browse stashes per repo with diff preview and the ability to drop one.
4. Add a pull action so a SHA mismatch (behind) is actually fixable from the UI,
   not just visible.

## Non-goals

- No `git fetch` triggered by the dashboard (SHA/ahead-behind stays derived
  from whatever local refs already have — matches the existing ahead/behind
  computation, zero new network calls, no added latency on page load/refresh).
- No branch checkout/switch from the UI. No branch rename.
- No stash apply/pop — view + drop only.
- No fleet-wide "needs attention" summary bar.

## Backend changes (`server/git.js`)

### 1. SHA + sync state on `status()`

Add to the returned object:
- `localSha`: `git rev-parse --short HEAD` (null if no commits yet).
- `remoteSha`: `git rev-parse --short @{u}` when an upstream is configured,
  else `null`.
- `syncState`: one of
  - `'synced'` — upstream exists, `ahead === 0 && behind === 0` → green
  - `'ahead'` — upstream exists, `behind === 0 && ahead > 0` → yellow
  - `'diverged-behind'` — upstream exists, `behind > 0` (regardless of ahead)
    → red
  - `'no-upstream'` — no upstream configured → gray/muted

`ahead === 0 && behind === 0` against a configured upstream implies the same
commit, so `localSha === remoteSha` is guaranteed in the `synced` case — no
extra plumbing needed to prove the match.

### 2. Branches — new `branches(root, slug)`

Returns:
```
{
  defaultBranch: 'main',
  local: [ { name, current, upstream, ahead, behind, merged } ],
  remoteOnly: [ { name } ]   // refs/remotes/origin/* with no matching local branch
}
```
Implementation: `git for-each-ref` over `refs/heads` and `refs/remotes/origin`
to enumerate; per local branch, `ahead`/`behind` vs its own upstream (if any,
via `rev-list --left-right --count`); `merged` computed via
`git branch --merged <defaultBranch>` membership.

`deleteBranch(root, slug, branch)`:
- 400 if `branch` is not in the current `merged` set (re-checked live, not
  trusted from a stale client payload).
- 400 if `branch` is the current branch or the default branch.
- Runs under `withRepoLock(slug, …)` like the existing mutations.
- `git branch -d <branch>` (safe delete, not `-D`).

### 3. Stashes — new functions

- `stashes(root, slug)` → `git stash list --format=%gd%x1f%s%x1f%cr` parsed into
  `[{ index, ref, message, when }]` (ref = `stash@{0}` etc).
- `stashDiff(root, slug, index)` → `git stash show -p stash@{<index>}`,
  returned like `fileDiff` (`{ diff }`).
- `dropStash(root, slug, index)` → `withRepoLock(slug, () => git(cwd,
  ['stash', 'drop', 'stash@{<index>}']))`.

Index is validated as a non-negative integer before interpolation (mirrors
`safeRel`'s validate-before-shell-out discipline — no raw user string reaches
`execFile` args unchecked).

### 4. Pull — new `pull(root, slug)`

- Re-reads `status()` first; 409 if `dirty > 0` ("commit or stash your changes
  before pulling") — this repo class (cron-managed submodules) should never
  attempt a merge against a dirty tree from the dashboard.
- 409 if no upstream / detached HEAD (same guard shape as `push`).
- Runs under `withRepoLock(slug, …)`.
- `git pull` (fast-forward expected; if it's not a clean fast-forward, surface
  git's stderr as the error — no auto-merge-conflict handling).

## API routes (`server/server.js`)

- `GET  /api/git/:slug/branches`
- `DELETE /api/git/:slug/branches/:branch`
- `GET  /api/git/:slug/stashes`
- `GET  /api/git/:slug/stashes/:index/diff`
- `DELETE /api/git/:slug/stashes/:index`
- `POST /api/git/:slug/pull`

All gated by the existing `requireSite` middleware.

## Frontend changes (`server/public/app.js`)

### Git tab row
- Branch column becomes two mono spans: `main a1b2c3d` (local) and
  `origin/main a1b2c3d` (remote), wrapped in a span colored by `syncState`
  (green/yellow/red/gray CSS class, following the existing `badge b-*`
  convention).
- A **Pull** button sits next to the existing per-repo detail's Push button
  (rendered in the detail panel, not the row, to match how Push already
  works) — enabled only when `behind > 0`.
- A stash badge (`📦 N`) appears in the row when `stashes > 0` (from a new
  cheap `stashCount` field on the summary endpoint), linking to
  `#git/<slug>/stashes`.

### Detail panel (existing expando)
- New collapsible "Branches" sub-section below the file list: table of local
  branches (name, upstream, ahead/behind, a "merged" tag) and a "remote-only"
  list. Each merged, non-current local branch gets a **Delete** button.

### New stash page (`#git/<slug>/stashes`)
- New router case in `render()`, new `renderStashes(slug)` function following
  the existing `FRESH`/`applyUISnap` soft-refresh pattern used elsewhere.
- Lists stashes: ref, message, relative date, **view diff** (expands inline
  `<pre>`, same pattern as `toggleGitFileDiff`), **drop** (confirm via native
  `confirm()`, then repo-locked delete, re-render list).
- Breadcrumb back to the Git tab.

## Testing

Follow the skill's safe-mutation rules: no real fleet-affecting bounces. For
pull/branch-delete/stash-drop, exercise against a scratch repo or a site repo
in a state where the action is a genuine no-op-equivalent (e.g. dropping a
stash you just created for the test, deleting a branch you just created and
merged for the test) — never touch fleet cron state.
