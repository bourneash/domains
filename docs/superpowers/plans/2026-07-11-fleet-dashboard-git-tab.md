# Fleet Dashboard Git Tab — SHA/Branches/Stashes/Pull Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the fleet-dashboard Git tab with color-coded local/remote SHA display, a branch list (local + remote-only, with merged/delete), a per-repo stash browsing page, and a pull action — closing the gaps identified against Jesse's ask (commit/push/diff/ignore already exist).

**Architecture:** All new logic lives in `tools/fleet-dashboard/server/git.js` (pure parsing helpers + git-shelling functions, following the existing `status`/`commit`/`push` pattern) with thin routes added to `server/server.js`, and new render functions in `server/public/app.js` following the existing `renderGit`/`renderGitDetail` conventions (FRESH/softRender/applyUISnap, `data-rk`/`data-rkh` for state preservation).

**Tech Stack:** Node.js (`node:child_process` execFile), Express, vanilla JS SPA, `node:test` for pure-logic unit tests (no framework, no build step).

## Global Constraints

- No `git fetch` is ever triggered by the dashboard — SHA/ahead/behind stay derived from whatever local refs already have (per spec Non-goals).
- No branch checkout/switch/rename from the UI.
- No stash apply/pop — view + drop only.
- No fleet-wide summary bar.
- Every new mutating git op (`deleteBranch`, `dropStash`, `pull`) runs under the existing `withRepoLock(slug, …)` serialization (`server/git.js:24`), matching `commit`/`ignore`/`push`.
- Every path/index value from an HTTP request is validated before it reaches `execFile` args (mirrors `safeRel`, `server/git.js:37`) — never interpolate unchecked request input into a git command.
- Follow the commit convention from `.claude/skills/fleet-dashboard-dev`: stage only `tools/fleet-dashboard/`, write commit messages to a file and use `git commit -F <file>` (a repo hook false-positives on some multi-line `-m` messages), end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`, avoid the literal token `--force` and `×` in messages, `rm -rf .playwright-mcp` before staging if Playwright was used.
- Server-side changes need `docker compose restart panel` (no rebuild) to take effect; static frontend changes are live on save (hard-refresh or cache-bust `/?v=N#git` when using Playwright).

---

### Task 1: Sync-state + SHA fields on `status()` and `summaries()`

**Files:**
- Modify: `tools/fleet-dashboard/server/git.js` (add `computeSyncState`, extend `status()`, extend `summaries()`)
- Test: `tools/fleet-dashboard/server/logic.test.js` (add tests)

**Interfaces:**
- Produces: `computeSyncState({ ahead, behind, upstream }) -> 'synced' | 'ahead' | 'diverged-behind' | 'no-upstream'` (exported from `git.js`).
- Produces: `status()` return object gains `localSha` (string|null), `remoteSha` (string|null), `syncState` (string).
- Produces: `summaries()` return objects gain the same three fields.

- [ ] **Step 1: Write the failing tests for `computeSyncState`**

Add to `tools/fleet-dashboard/server/logic.test.js` (after the existing `parsePorcelain` tests):

```javascript
/* ---- sync-state color classification ---- */
test('computeSyncState classifies upstream sync correctly', () => {
  assert.equal(git.computeSyncState({ ahead: 0, behind: 0, upstream: 'origin/main' }), 'synced');
  assert.equal(git.computeSyncState({ ahead: 3, behind: 0, upstream: 'origin/main' }), 'ahead');
  assert.equal(git.computeSyncState({ ahead: 0, behind: 2, upstream: 'origin/main' }), 'diverged-behind');
  assert.equal(git.computeSyncState({ ahead: 1, behind: 2, upstream: 'origin/main' }), 'diverged-behind');
  assert.equal(git.computeSyncState({ ahead: 0, behind: 0, upstream: null }), 'no-upstream');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/fleet-dashboard && node --test server/logic.test.js`
Expected: FAIL — `git.computeSyncState is not a function`

- [ ] **Step 3: Implement `computeSyncState` and export it**

In `tools/fleet-dashboard/server/git.js`, add near the top (after `parsePorcelain`, before `status`):

```javascript
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
```

Add `computeSyncState` to the `module.exports` object at the bottom of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/fleet-dashboard && node --test server/logic.test.js`
Expected: PASS

- [ ] **Step 5: Extend `status()` with localSha/remoteSha/syncState**

In `tools/fleet-dashboard/server/git.js`, modify the `status` function (currently ~L96-124). After the existing `lastCommit` block and before the `return`, add:

```javascript
  let localSha = null;
  const lsha = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  if (lsha.ok && lsha.out.trim()) localSha = lsha.out.trim();

  let remoteSha = null;
  if (parsed.upstream) {
    const rsha = await git(cwd, ['rev-parse', '--short', '@{u}']);
    if (rsha.ok && rsha.out.trim()) remoteSha = rsha.out.trim();
  }

  const syncState = computeSyncState({ ahead: parsed.ahead, behind: parsed.behind, upstream: parsed.upstream });
```

Then add `localSha, remoteSha, syncState,` to the returned object (alongside the existing `branch, upstream, detached,` line).

- [ ] **Step 6: Extend `summaries()` with the same fields**

In `tools/fleet-dashboard/server/git.js`, modify `summaries` (currently ~L260-267) to include the new fields in its per-slug returned object:

```javascript
async function summaries(root, slugs) {
  return Promise.all(slugs.map(async (slug) => {
    const s = await status(root, slug);
    return { slug: s.slug, isRepo: s.isRepo, branch: s.branch, dirty: s.dirty,
      ahead: s.ahead, behind: s.behind, needsPush: s.needsPush, needsPull: s.needsPull,
      localSha: s.localSha, remoteSha: s.remoteSha, syncState: s.syncState,
      error: s.error || null };
  }));
}
```

- [ ] **Step 7: Manually verify against a real site repo**

Run: `cd tools/fleet-dashboard && docker compose restart panel && sleep 2 && curl -s http://127.0.0.1:4754/api/git -H "Cookie: fd_token=$(grep '^FD_TOKEN=' ../../.env | cut -d= -f2)" | python3 -m json.tool | head -40`

(If not already authenticated in a way curl can reuse, use the token as documented in the fleet-dashboard-dev skill's Access Token section.)

Expected: each repo row now has `localSha`, `remoteSha` (or `null` if no upstream), and `syncState` matching its `ahead`/`behind` values.

- [ ] **Step 8: Commit**

```bash
cd /home/jesse/projects/domains
rm -rf tools/fleet-dashboard/.playwright-mcp
cat > /tmp/commit-msg-1.txt <<'EOF'
feat(fleet-dashboard): add local/remote SHA and sync-state to git status

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
git add tools/fleet-dashboard/server/git.js tools/fleet-dashboard/server/logic.test.js
git commit -F /tmp/commit-msg-1.txt
```

---

### Task 2: Branch listing (local + remote-only) with merged detection

**Files:**
- Modify: `tools/fleet-dashboard/server/git.js` (add `parseLocalBranches`, `parseMergedSet`, `parseRemoteOnlyBranches`, `branches()`, `deleteBranch()`)
- Test: `tools/fleet-dashboard/server/logic.test.js`

**Interfaces:**
- Consumes: `git(cwd, args)` (existing helper, `git.js:8`), `withRepoLock(slug, fn)` (existing, `git.js:24`), `httpErr(status, msg)` (existing, `git.js:15`), `siteDir(root, slug)` (from `./sites`).
- Produces (pure, exported for tests): `parseLocalBranches(out) -> [{ name, upstream, current }]` (from `for-each-ref` tab-separated output).
- Produces (pure, exported for tests): `parseMergedSet(out) -> Set<string>` (from `git branch --merged` output).
- Produces (pure, exported for tests): `parseRemoteOnlyBranches(remoteOut, localNames) -> [string]` (remote short names like `origin/foo` filtered to those with no matching local branch name `foo`, `origin/HEAD` always excluded).
- Produces: `async branches(root, slug) -> { defaultBranch, local: [{ name, upstream, current, ahead, behind, merged }], remoteOnly: [{ name }] }`.
- Produces: `async deleteBranch(root, slug, branch) -> { ok: true, out }` — throws 400 if not merged/is current/is default, via `httpErr`.

- [ ] **Step 1: Write the failing tests for the pure parsers**

Add to `tools/fleet-dashboard/server/logic.test.js`:

```javascript
/* ---- branch listing parsers ---- */
test('parseLocalBranches parses for-each-ref tab output', () => {
  const out = [
    'main\torigin/main\t*',
    'feature/foo\torigin/feature/foo\t ',
    'scratch\t\t ',
  ].join('\n');
  assert.deepEqual(git.parseLocalBranches(out), [
    { name: 'main', upstream: 'origin/main', current: true },
    { name: 'feature/foo', upstream: 'origin/feature/foo', current: false },
    { name: 'scratch', upstream: null, current: false },
  ]);
});

test('parseMergedSet parses `git branch --merged` output, stripping the current-branch marker', () => {
  const out = '* main\n  old/experiment\n  feature/done\n';
  const merged = git.parseMergedSet(out);
  assert.equal(merged.has('main'), true);
  assert.equal(merged.has('old/experiment'), true);
  assert.equal(merged.has('feature/done'), true);
  assert.equal(merged.has('nope'), false);
});

test('parseRemoteOnlyBranches excludes origin/HEAD and branches that exist locally', () => {
  const remoteOut = 'origin/HEAD\norigin/main\norigin/feature/foo\norigin/stray-remote-branch\n';
  const localNames = ['main', 'feature/foo'];
  assert.deepEqual(git.parseRemoteOnlyBranches(remoteOut, localNames), [{ name: 'origin/stray-remote-branch' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/fleet-dashboard && node --test server/logic.test.js`
Expected: FAIL — `git.parseLocalBranches is not a function` (and the other two)

- [ ] **Step 3: Implement the three pure parsers**

Add to `tools/fleet-dashboard/server/git.js`, after `parsePorcelain` and before `status`:

```javascript
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
    .filter((full) => full !== 'origin/HEAD')
    .filter((full) => !local.has(full.replace(/^origin\//, '')))
    .map((name) => ({ name }));
}
```

Add `parseLocalBranches, parseMergedSet, parseRemoteOnlyBranches` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/fleet-dashboard && node --test server/logic.test.js`
Expected: PASS

- [ ] **Step 5: Implement `branches()` and `deleteBranch()`**

Add to `tools/fleet-dashboard/server/git.js`, after `push()`:

```javascript
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
```

Add `branches, deleteBranch` to `module.exports`.

- [ ] **Step 6: Run the full test suite to confirm no regressions**

Run: `cd tools/fleet-dashboard && node --test server/logic.test.js`
Expected: PASS (all tests, including Task 1's)

- [ ] **Step 7: Manually verify `branches()` against a real site repo**

Run: `cd tools/fleet-dashboard && docker compose restart panel && sleep 2 && curl -s "http://127.0.0.1:4754/api/git/americastrikes.com/branches" | python3 -m json.tool`

Expected: `{ defaultBranch: "main", local: [{ name: "main", upstream: "origin/main", current: true, merged: true, ahead: 0, behind: 0 }], remoteOnly: [...] }` (exact ahead/behind/remoteOnly depend on the repo's actual state).

- [ ] **Step 8: Manually verify the merged/current/default guards on `deleteBranch`**

Run against a throwaway branch so nothing real is deleted:

```bash
cd sites/americastrikes.com
git branch scratch-delete-test
cd ../..
curl -s -X DELETE "http://127.0.0.1:4754/api/git/americastrikes.com/branches/scratch-delete-test"
git -C sites/americastrikes.com branch   # confirm scratch-delete-test is gone
```

Expected: the delete succeeds (branch was merged — it's an unmodified pointer at HEAD). Then confirm the guards: `curl -s -X DELETE ".../branches/main"` → 400 "refusing to delete the default branch".

- [ ] **Step 9: Commit**

```bash
cd /home/jesse/projects/domains
cat > /tmp/commit-msg-2.txt <<'EOF'
feat(fleet-dashboard): add branch listing + safe merged-branch delete

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
git add tools/fleet-dashboard/server/git.js tools/fleet-dashboard/server/logic.test.js
git commit -F /tmp/commit-msg-2.txt
```

---

### Task 3: Stash listing, diff, and drop

**Files:**
- Modify: `tools/fleet-dashboard/server/git.js` (add `parseStashList`, `stashes()`, `stashDiff()`, `dropStash()`, and a `stashCount` field on `summaries()`)
- Test: `tools/fleet-dashboard/server/logic.test.js`

**Interfaces:**
- Produces (pure, exported for tests): `parseStashList(out) -> [{ index, ref, message, when }]`.
- Produces: `async stashes(root, slug) -> [{ index, ref, message, when }]`.
- Produces: `async stashDiff(root, slug, index) -> { ref, diff }` — throws 400 on a malformed index.
- Produces: `async dropStash(root, slug, index) -> { ok: true, out }` — throws 400 on a malformed index.
- Produces: `summaries()` per-slug objects gain `stashCount` (number).

- [ ] **Step 1: Write the failing test for `parseStashList`**

Add to `tools/fleet-dashboard/server/logic.test.js`:

```javascript
/* ---- stash list parser ---- */
test('parseStashList parses `git stash list --format` unit-separated output', () => {
  const out = [
    'stash@{0}\x1fWIP: header tweak\x1f2 hours ago',
    'stash@{1}\x1fdebug logging\x1f1 day ago',
  ].join('\n');
  assert.deepEqual(git.parseStashList(out), [
    { index: 0, ref: 'stash@{0}', message: 'WIP: header tweak', when: '2 hours ago' },
    { index: 1, ref: 'stash@{1}', message: 'debug logging', when: '1 day ago' },
  ]);
});

test('parseStashList returns [] for no stashes', () => {
  assert.deepEqual(git.parseStashList(''), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/fleet-dashboard && node --test server/logic.test.js`
Expected: FAIL — `git.parseStashList is not a function`

- [ ] **Step 3: Implement `parseStashList`**

Add to `tools/fleet-dashboard/server/git.js`, after the branch parsers:

```javascript
// Parse `git stash list --format=%gd%x1f%s%x1f%cr` (ref, message, relative date).
function parseStashList(out) {
  return out.split('\n').filter(Boolean).map((line) => {
    const [ref, message, when] = line.split('\x1f');
    const m = ref.match(/\{(\d+)\}/);
    return { index: m ? parseInt(m[1], 10) : 0, ref, message: message || '', when: when || '' };
  });
}
```

Add `parseStashList` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/fleet-dashboard && node --test server/logic.test.js`
Expected: PASS

- [ ] **Step 5: Implement `stashes()`, `stashDiff()`, `dropStash()`, and wire `stashCount` into `summaries()`**

Add to `tools/fleet-dashboard/server/git.js`, after `deleteBranch`:

```javascript
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
```

Add `stashes, stashDiff, dropStash` to `module.exports`.

Then modify `summaries()` (touched again in this task) to add `stashCount`:

```javascript
async function summaries(root, slugs) {
  return Promise.all(slugs.map(async (slug) => {
    const s = await status(root, slug);
    const stashList = s.isRepo ? await stashes(root, slug) : [];
    return { slug: s.slug, isRepo: s.isRepo, branch: s.branch, dirty: s.dirty,
      ahead: s.ahead, behind: s.behind, needsPush: s.needsPush, needsPull: s.needsPull,
      localSha: s.localSha, remoteSha: s.remoteSha, syncState: s.syncState,
      stashCount: stashList.length, error: s.error || null };
  }));
}
```

- [ ] **Step 6: Run the full test suite to confirm no regressions**

Run: `cd tools/fleet-dashboard && node --test server/logic.test.js`
Expected: PASS

- [ ] **Step 7: Manually verify stash listing/diff/drop against a scratch stash**

Never touch a real stash — create and destroy your own test stash:

```bash
cd sites/americastrikes.com
echo "test change" >> README.md 2>/dev/null || echo "test change" > /tmp/scratch-stash-file.md
git stash push -m "fd-plan-test-stash" -- README.md   # adjust path if README.md doesn't exist; pick any tracked file
cd ../..
curl -s "http://127.0.0.1:4754/api/git/americastrikes.com/stashes" | python3 -m json.tool
curl -s "http://127.0.0.1:4754/api/git/americastrikes.com/stashes/0/diff" | python3 -m json.tool
curl -s -X DELETE "http://127.0.0.1:4754/api/git/americastrikes.com/stashes/0"
curl -s "http://127.0.0.1:4754/api/git/americastrikes.com/stashes" | python3 -m json.tool   # confirm empty again
```

Expected: the list shows the `fd-plan-test-stash` entry, the diff shows the appended line, and the drop empties the list back out.

- [ ] **Step 8: Commit**

```bash
cd /home/jesse/projects/domains
cat > /tmp/commit-msg-3.txt <<'EOF'
feat(fleet-dashboard): add stash listing, diff preview, and drop

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
git add tools/fleet-dashboard/server/git.js tools/fleet-dashboard/server/logic.test.js
git commit -F /tmp/commit-msg-3.txt
```

---

### Task 4: Pull

**Files:**
- Modify: `tools/fleet-dashboard/server/git.js` (add `pull()`)
- Test: manual only (mutates a real working tree — no meaningful pure-logic slice to unit test beyond the guards, which mirror `push()`'s already-tested shape)

**Interfaces:**
- Consumes: `status(root, slug)` (this file), `withRepoLock` (this file), `httpErr` (this file).
- Produces: `async pull(root, slug) -> { ok: true, out }` — throws 409 if dirty, 409 if no upstream/detached, 500 on a non-fast-forward or other git failure.

- [ ] **Step 1: Implement `pull()`**

Add to `tools/fleet-dashboard/server/git.js`, directly after `push()`:

```javascript
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
    return { ok: true, out: (r.out || r.err || '').trim() };
  });
}
```

Add `pull` to `module.exports`.

- [ ] **Step 2: Run `node --check` to confirm the file still parses**

Run: `cd tools/fleet-dashboard && node --check server/git.js`
Expected: no output (success)

- [ ] **Step 3: Run the full test suite to confirm no regressions**

Run: `cd tools/fleet-dashboard && node --test server/logic.test.js`
Expected: PASS

- [ ] **Step 4: Manually verify the dirty-tree guard and a real fast-forward pull**

```bash
cd tools/fleet-dashboard && docker compose restart panel && sleep 2

# Guard: dirty tree refuses
cd sites/americastrikes.com && echo "x" >> README.md 2>/dev/null; cd ../..
curl -s -X POST "http://127.0.0.1:4754/api/git/americastrikes.com/pull"
git -C sites/americastrikes.com checkout -- README.md   # clean up the scratch dirty state

# Real pull: only meaningful if a repo is actually behind. Pick a site whose
# `behind` is currently > 0 in `curl -s http://127.0.0.1:4754/api/git`, or skip
# this half if none are behind right now (the guard check above is the
# load-bearing verification).
```

Expected: the dirty-tree call returns a 409 with the "uncommitted changes" message; a pull against a behind-but-clean repo fast-forwards and its `behind` count in a follow-up `/api/git/<slug>` call drops to 0.

- [ ] **Step 5: Commit**

```bash
cd /home/jesse/projects/domains
cat > /tmp/commit-msg-4.txt <<'EOF'
feat(fleet-dashboard): add guarded pull action

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
git add tools/fleet-dashboard/server/git.js
git commit -F /tmp/commit-msg-4.txt
```

---

### Task 5: Wire the six new routes in `server.js`

**Files:**
- Modify: `tools/fleet-dashboard/server/server.js` (add routes after the existing git routes, ~L360)

**Interfaces:**
- Consumes: `git.branches`, `git.deleteBranch`, `git.stashes`, `git.stashDiff`, `git.dropStash`, `git.pull` (all from Tasks 1-4), `requireSite` (existing middleware, `server.js:108`).

- [ ] **Step 1: Add the routes**

In `tools/fleet-dashboard/server/server.js`, immediately after the existing `app.post('/api/git/:slug/push', ...)` block (~L357-360), add:

```javascript
  app.get('/api/git/:slug/branches', requireSite, async (req, res) => {
    try { res.json(await git.branches(root, req.params.slug)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.delete('/api/git/:slug/branches/:branch(*)', requireSite, async (req, res) => {
    try { res.json(await git.deleteBranch(root, req.params.slug, req.params.branch)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.get('/api/git/:slug/stashes', requireSite, async (req, res) => {
    try { res.json(await git.stashes(root, req.params.slug)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.get('/api/git/:slug/stashes/:index/diff', requireSite, async (req, res) => {
    try { res.json(await git.stashDiff(root, req.params.slug, req.params.index)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.delete('/api/git/:slug/stashes/:index', requireSite, async (req, res) => {
    try { res.json(await git.dropStash(root, req.params.slug, req.params.index)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.post('/api/git/:slug/pull', requireSite, async (req, res) => {
    try { res.json(await git.pull(root, req.params.slug)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });
```

Note: `:branch(*)` allows a branch name containing `/` (e.g. `feature/foo`) to be captured whole, matching how `feature/foo` is referenced as a single path segment on the frontend (URL-encoded as one component — see Task 7's `encodeURIComponent(name)`).

- [ ] **Step 2: Syntax check and restart**

Run: `cd tools/fleet-dashboard && node --check server/server.js && docker compose restart panel && sleep 2`
Expected: no syntax errors; container restarts cleanly (`docker logs --tail 20 fleet-dashboard` shows no crash).

- [ ] **Step 3: Smoke-test each new route**

```bash
curl -s http://127.0.0.1:4754/api/git/americastrikes.com/branches | python3 -m json.tool | head -20
curl -s http://127.0.0.1:4754/api/git/americastrikes.com/stashes | python3 -m json.tool
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4754/api/git/not-a-real-site/branches   # expect 404
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE http://127.0.0.1:4754/api/git/americastrikes.com/branches/main   # expect 400
```

Expected: 200s with well-formed JSON for the real site, 404 for the unknown-site guard, 400 for the default-branch delete guard.

- [ ] **Step 4: Commit**

```bash
cd /home/jesse/projects/domains
cat > /tmp/commit-msg-5.txt <<'EOF'
feat(fleet-dashboard): wire branches/stashes/pull routes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
git add tools/fleet-dashboard/server/server.js
git commit -F /tmp/commit-msg-5.txt
```

---

### Task 6: Frontend — SHA display, sync-state color, pull button on the Git tab row/detail

**Files:**
- Modify: `tools/fleet-dashboard/server/public/app.js` (`renderGit`, `renderGitDetail`, `wireGitOps`)
- Modify: `tools/fleet-dashboard/server/public/style.css` (reuse existing `.badge .b-*` classes — no new classes needed; verify during manual test)

**Interfaces:**
- Consumes: `syncState`, `localSha`, `remoteSha`, `stashCount` fields on the `/api/git` summary rows and the `/api/git/:slug` detail object (Tasks 1 & 3).
- Consumes: `POST /api/git/:slug/pull` (Task 5).
- Produces: no new exported JS functions — this is UI wiring only.

- [ ] **Step 1: Update the Git tab row rendering**

In `tools/fleet-dashboard/server/public/app.js`, in `renderGit` (~L228-242), replace the row's branch/sync cell construction. Current code:

```javascript
    const dirty = r.dirty > 0 ? `<span class="badge b-yellow">${r.dirty} uncommitted</span>` : '<span class="badge b-green">clean</span>';
    const sync = [];
    if (r.ahead) sync.push(`<span class="badge b-blue">↑${r.ahead}</span>`);
    if (r.behind) sync.push(`<span class="badge b-red">↓${r.behind}</span>`);
    if (!r.ahead && !r.behind) sync.push('<span class="muted">synced</span>');
    return `<tr class="git-row" data-slug="${esc(r.slug)}">
      <td class="site">${esc(r.slug)} <span class="muted">▸</span></td>
      <td class="mono">${esc(r.branch || '—')}</td>
      <td>${dirty}</td>
      <td>${sync.join(' ')}</td>
    </tr>
    <tr class="git-detail-row hidden" data-detail="${esc(r.slug)}" data-rk="git:${esc(r.slug)}"><td colspan="4"><div class="git-detail" id="gd-${esc(r.slug)}" data-rkh="git:${esc(r.slug)}"></div></td></tr>`;
```

Replace with:

```javascript
    const dirty = r.dirty > 0 ? `<span class="badge b-yellow">${r.dirty} uncommitted</span>` : '<span class="badge b-green">clean</span>';
    const sync = [];
    if (r.ahead) sync.push(`<span class="badge b-blue">↑${r.ahead}</span>`);
    if (r.behind) sync.push(`<span class="badge b-red">↓${r.behind}</span>`);
    if (!r.ahead && !r.behind) sync.push('<span class="muted">synced</span>');
    const shaCls = { synced: 'b-green', ahead: 'b-yellow', 'diverged-behind': 'b-red', 'no-upstream': 'b-blue' }[r.syncState] || 'b-blue';
    const shaLine = `<span class="badge ${shaCls}" title="local vs remote SHA">${esc(r.localSha || '—')} / ${esc(r.remoteSha || '—')}</span>`;
    const stashBadge = r.stashCount ? ` <a href="#git/${encodeURIComponent(r.slug)}/stashes" class="badge b-blue" title="${r.stashCount} stash(es)">📦 ${r.stashCount}</a>` : '';
    return `<tr class="git-row" data-slug="${esc(r.slug)}">
      <td class="site">${esc(r.slug)} <span class="muted">▸</span></td>
      <td class="mono">${esc(r.branch || '—')} ${shaLine}${stashBadge}</td>
      <td>${dirty}</td>
      <td>${sync.join(' ')}</td>
    </tr>
    <tr class="git-detail-row hidden" data-detail="${esc(r.slug)}" data-rk="git:${esc(r.slug)}"><td colspan="4"><div class="git-detail" id="gd-${esc(r.slug)}" data-rkh="git:${esc(r.slug)}"></div></td></tr>`;
```

Note: the stash badge is an `<a>` — the existing row-click handler in `renderGit` is bound to the whole `<tr>` (`toggleGitDetail`), so add a `stopPropagation` guard in Step 3 so clicking the stash badge navigates instead of toggling the detail row.

- [ ] **Step 2: Add the Pull button to the detail panel**

In `tools/fleet-dashboard/server/public/app.js`, in `renderGitDetail` (~L285-324), find the `pushBtn` line:

```javascript
  const pushBtn = `<button type="button" class="btn sm gd-push"${s.ahead ? '' : ' disabled title="nothing to push"'}>⇧ Push${s.ahead ? ` ${s.ahead}` : ''}</button>`;
```

Add directly below it:

```javascript
  const pullBtn = `<button type="button" class="btn sm gd-pull"${s.behind ? '' : ' disabled title="nothing to pull"'}>⇩ Pull${s.behind ? ` ${s.behind}` : ''}</button>`;
```

Then in both places `pushBtn` is interpolated into the returned HTML (the clean-tree branch and the dirty-tree branch, ~L294 and ~L320), add `${pullBtn}` next to it, e.g.:

```javascript
      <div class="gd-commit">${pushBtn} ${pullBtn}</div><div class="gd-result"></div>`;
```

and

```javascript
      ${pushBtn} ${pullBtn}
    </div>
    <div class="gd-result"></div>`;
```

- [ ] **Step 3: Wire the Pull button and the stash-badge click guard**

In `tools/fleet-dashboard/server/public/app.js`, in `wireGitOps` (~L326-332), add after the existing `pb` (push button) wiring:

```javascript
  const plb = $('.gd-pull', box); if (plb) plb.addEventListener('click', () => gitPull(slug, box, plb));
```

Add a new `gitPull` function directly after the existing `gitPush` function (`app.js:393-400`), matching its exact shape — `toast(msg, 'err')` on failure (the real signature is `toast(msg, kind = 'ok')`, not a boolean), and `gdBusy(btn, false)` only on the failure path (success re-renders the panel via `refreshGitAfterOp`, which replaces `btn` entirely):

```javascript
async function gitPull(slug, box, btn) {
  gdBusy(btn, true);
  try {
    await api('POST', `/api/git/${encodeURIComponent(slug)}/pull`);
    toast(`Pulled ${slug}`);
    await refreshGitAfterOp(slug, box);
  } catch (e) { toast(`pull failed: ${e.message}`, 'err'); gdBusy(btn, false); }
}
```

In `renderGit`'s row click wiring (~L255: `$$('.git-row').forEach((tr) => tr.addEventListener('click', () => toggleGitDetail(tr.dataset.slug)));`), the stash-badge `<a>` is inside the `<tr>`, so add a capture check: change the row listener to ignore clicks that originated on an `<a>`:

```javascript
  $$('.git-row').forEach((tr) => tr.addEventListener('click', (e) => { if (e.target.closest('a')) return; toggleGitDetail(tr.dataset.slug); }));
```

- [ ] **Step 4: Fix `refreshGitAfterOp` so a push/pull/commit/ignore doesn't blank the SHA badge**

`refreshGitAfterOp` (`app.js:353-367`) rewrites the row's branch cell (`tds[1]`) after every mutating op, currently with just the branch name — it would wipe out the SHA badge added in Step 1 the first time anyone commits, pushes, ignores, or pulls. Update the `tds[1]` line (~L359) to match the richer cell built in `renderGit`:

```javascript
  if (tds[1]) {
    const shaCls = { synced: 'b-green', ahead: 'b-yellow', 'diverged-behind': 'b-red', 'no-upstream': 'b-blue' }[s.syncState] || 'b-blue';
    const shaLine = `<span class="badge ${shaCls}" title="local vs remote SHA">${esc(s.localSha || '—')} / ${esc(s.remoteSha || '—')}</span>`;
    tds[1].innerHTML = `<span class="mono">${esc(s.branch || '—')}</span> ${shaLine}`;
  }
```

Note: `s` here comes from `GET /api/git/:slug` (`status()`, Task 1), which already carries `syncState`/`localSha`/`remoteSha` — no backend change needed. The stash badge is intentionally left out of this patch (it's sourced from `summaries()`'s `stashCount`, not `status()`); it goes stale for at most one auto-refresh tick, which already re-renders the full row via `renderGit`.

- [ ] **Step 5: Manual verification (Playwright)**

Navigate with a cache-bust and assert the new elements render:

```
browser_navigate to http://127.0.0.1:4754/?v=1#git
browser_snapshot  → confirm a repo row shows "<branch> <sha1> / <sha2>" with a colored badge, and a Pull button appears in an expanded detail panel (disabled if behind=0)
browser_click on a repo row with stashCount > 0's stash badge → confirm it navigates to #git/<slug>/stashes (page content itself lands in Task 8; for now confirm the hash changes and no JS error appears in browser_console_messages)
```

Trigger any existing mutating op (e.g. push, if a repo has `ahead > 0`, or ignore on a scratch untracked file) and confirm the SHA badge in the row is still present afterward, not blanked to just the branch name.

Expected: no console errors; SHA badges render with the right color per repo's real `ahead`/`behind` state; Pull button state (enabled/disabled) matches `behind`; SHA badge survives a row refresh after any git op.

- [ ] **Step 6: Commit**

```bash
cd /home/jesse/projects/domains
rm -rf tools/fleet-dashboard/.playwright-mcp
cat > /tmp/commit-msg-6.txt <<'EOF'
feat(fleet-dashboard): show colored local/remote SHA + pull button on Git tab

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
git add tools/fleet-dashboard/server/public/app.js
git commit -F /tmp/commit-msg-6.txt
```

---

### Task 7: Frontend — Branches sub-section in the detail panel

**Files:**
- Modify: `tools/fleet-dashboard/server/public/app.js` (`renderGitDetail`, `wireGitOps`)

**Interfaces:**
- Consumes: `GET /api/git/:slug/branches` (Task 5), `DELETE /api/git/:slug/branches/:branch` (Task 5).

- [ ] **Step 1: Add a lazily-loaded Branches sub-section container to `renderGitDetail`**

In `tools/fleet-dashboard/server/public/app.js`, in `renderGitDetail`, both the clean-tree and dirty-tree HTML strings currently end with `<div class="gd-result"></div>`. In both places, add a Branches sub-section directly after it:

```javascript
    <div class="gd-result"></div>
    <details class="gd-branches" data-rk="git-branches:${esc(slug)}">
      <summary>Branches</summary>
      <div class="gd-branches-body" data-rkh="git-branches-body:${esc(slug)}"><span class="muted">click to load…</span></div>
    </details>`;
```

(This replaces the bare `<div class="gd-result"></div>` line — append the `<details>` block right after it, keeping the div. Do this in both the clean-tree return (~L292-295) and the dirty-tree return (~L313-322).)

- [ ] **Step 2: Load branches on first expand, in `wireGitOps`**

In `tools/fleet-dashboard/server/public/app.js`, in `wireGitOps`, add:

```javascript
  const brDetails = $('.gd-branches', box);
  if (brDetails) brDetails.addEventListener('toggle', () => { if (brDetails.open) loadGitBranches(slug, brDetails); }, { once: false });
```

Guard against reloading every toggle by checking a loaded flag inside `loadGitBranches` itself (Step 3).

- [ ] **Step 3: Implement `loadGitBranches` and its delete handler**

Add near `fillGitDetail`/`renderGitDetail`:

```javascript
async function loadGitBranches(slug, detailsEl) {
  const body = $('.gd-branches-body', detailsEl);
  if (!body || body.dataset.loaded === '1') return;
  body.innerHTML = '<span class="muted">loading…</span>';
  let b;
  try { b = await api('GET', `/api/git/${encodeURIComponent(slug)}/branches`); }
  catch (e) { body.innerHTML = `<span class="flag">${esc(e.message)}</span>`; return; }
  body.dataset.loaded = '1';
  renderGitBranches(slug, body, b);
}

function renderGitBranches(slug, body, b) {
  const localRows = b.local.map((br) => {
    const tags = [br.current ? '<span class="badge b-blue">current</span>' : '', br.merged ? '<span class="badge b-green">merged</span>' : '<span class="badge b-yellow">unmerged</span>'].filter(Boolean).join(' ');
    const sync = (br.ahead || br.behind) ? `<span class="muted">${br.ahead ? `↑${br.ahead}` : ''}${br.behind ? ` ↓${br.behind}` : ''}</span>` : '';
    const canDelete = br.merged && !br.current && br.name !== b.defaultBranch;
    const delBtn = canDelete ? `<button type="button" class="btn sm gd-branch-del" data-branch="${esc(br.name)}">delete</button>` : '';
    return `<div class="gd-branch-row"><span class="mono">${esc(br.name)}</span> ${tags} <span class="muted">${esc(br.upstream || 'no upstream')}</span> ${sync} ${delBtn}</div>`;
  }).join('') || '<div class="muted">no local branches</div>';
  const remoteRows = b.remoteOnly.map((r) => `<div class="gd-branch-row"><span class="mono">${esc(r.name)}</span> <span class="muted">remote-only</span></div>`).join('');
  body.innerHTML = `<div class="gd-branch-list">${localRows}</div>${remoteRows ? `<div class="section-title" style="margin:8px 0 4px">Remote-only</div><div class="gd-branch-list">${remoteRows}</div>` : ''}`;
  $$('.gd-branch-del', body).forEach((btn) => btn.addEventListener('click', () => deleteGitBranch(slug, body, btn)));
}

async function deleteGitBranch(slug, body, btn) {
  const branch = btn.dataset.branch;
  if (!confirm(`Delete merged branch "${branch}" on ${slug}?`)) return;
  gdBusy(btn, true);
  try {
    await api('DELETE', `/api/git/${encodeURIComponent(slug)}/branches/${encodeURIComponent(branch)}`);
    toast(`Deleted branch ${branch}`);
    body.dataset.loaded = '0';
    const r = await api('GET', `/api/git/${encodeURIComponent(slug)}/branches`);
    body.dataset.loaded = '1';
    renderGitBranches(slug, body, r);
  } catch (e) { toast(`delete failed: ${e.message}`, 'err'); gdBusy(btn, false); }
}
```

- [ ] **Step 4: Add minimal CSS for the new rows (reuse existing patterns)**

In `tools/fleet-dashboard/server/public/style.css`, check whether `.gd-branch-row` needs any rule beyond what generic `.muted`/`.badge`/`.mono` already provide. If the rows look cramped in the manual test (Step 5), add:

```css
.gd-branch-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; flex-wrap: wrap; }
```

- [ ] **Step 5: Manual verification (Playwright)**

```
browser_navigate to http://127.0.0.1:4754/?v=2#git
browser_click a repo row to expand its detail
browser_click the "Branches" <details> summary
browser_snapshot → confirm local branches list (current/merged tags), remote-only section if applicable
```

If a merged, non-current, non-default branch exists (create a scratch one first: `git -C sites/<site> branch scratch-ui-test`), click its `delete` button, confirm the browser `confirm()` dialog (via `browser_handle_dialog`), and verify the row disappears and `git -C sites/<site> branch` no longer lists it.

Expected: no console errors; delete guard is enforced (no delete button rendered for unmerged/current/default branches).

- [ ] **Step 6: Commit**

```bash
cd /home/jesse/projects/domains
rm -rf tools/fleet-dashboard/.playwright-mcp
cat > /tmp/commit-msg-7.txt <<'EOF'
feat(fleet-dashboard): add branches sub-section with safe merged-branch delete

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
git add tools/fleet-dashboard/server/public/app.js tools/fleet-dashboard/server/public/style.css
git commit -F /tmp/commit-msg-7.txt
```

---

### Task 8: Frontend — dedicated stash page (`#git/<slug>/stashes`)

**Files:**
- Modify: `tools/fleet-dashboard/server/public/app.js` (`parseHash`, `render`, new `renderGitStashes`)

**Interfaces:**
- Consumes: `GET /api/git/:slug/stashes`, `GET /api/git/:slug/stashes/:index/diff`, `DELETE /api/git/:slug/stashes/:index` (Task 5).
- Consumes/extends: `STATE` global (add `STATE.gitSlug`), `parseHash()`, `render()`, `FRESH`/`applyUISnap` conventions (existing, see `renderGit` for the pattern).

- [ ] **Step 1: Extend `STATE` and `parseHash` for the stash route**

In `tools/fleet-dashboard/server/public/app.js`, change the `STATE` declaration (~L7):

```javascript
let STATE = { view: 'control', agent: null, sites: [], agents: [], taskSite: null, gitSlug: null };
```

Replace `parseHash` (~L1936-1945):

```javascript
function parseHash() {
  const h = (location.hash || '').replace(/^#/, '');
  if (!h) return { view: 'control', agent: null };
  const parts = h.split('/');
  const [a, b, c] = parts;
  if (a === 'agents' && b) return { view: 'agent', agent: decodeURIComponent(b) };
  if (a === 'fleet') return { view: 'agent', agent: 'engineer' };
  if (a === 'roles') return { view: 'control', agent: null };
  if (a === 'git' && b && c === 'stashes') return { view: 'gitstashes', agent: null, gitSlug: decodeURIComponent(b) };
  if (TOP_VIEWS.includes(a)) return { view: a, agent: null };
  return { view: 'control', agent: null };
}
```

Find where `parseHash()`'s result is applied to `STATE` (grep showed `STATE.view = r.view; STATE.agent = r.agent;` around L2129 and inside the hashchange handler near L2150) and add `STATE.gitSlug = r.gitSlug || null;` next to each of those two assignments.

- [ ] **Step 2: Add the route dispatch**

In `render()` (~L1974-1987), add a case:

```javascript
  else if (STATE.view === 'gitstashes') renderGitStashes(STATE.gitSlug);
```

(insert it next to the existing `else if (STATE.view === 'git') renderGit();` line)

- [ ] **Step 3: Implement `renderGitStashes`**

Add near `renderGit` (after the git section, before `/* ===================== SHELL ===================== */` or in a new `/* ===== GIT STASHES ===== */` block right after the existing git functions):

```javascript
/* ===================== GIT STASHES ===================== */
async function renderGitStashes(slug) {
  const app = $('#app');
  if (FRESH) app.innerHTML = '<div class="loading">Loading stashes…</div>';
  if (!slug) { app.innerHTML = '<div class="empty">No site specified.</div>'; return; }
  let list;
  try { list = await api('GET', `/api/git/${encodeURIComponent(slug)}/stashes`); }
  catch (e) { app.innerHTML = `<div class="empty">Failed to load stashes: ${esc(e.message)}</div>`; return; }

  const rows = list.map((s) => `
    <div class="card" style="margin-bottom:10px" data-rk="stash:${esc(s.ref)}">
      <div class="gd-head">
        <span class="mono">${esc(s.ref)}</span>
        <span>${esc(s.message)}</span>
        <span class="muted">${esc(s.when)}</span>
        <button type="button" class="btn sm gs-diff" data-index="${s.index}">view diff</button>
        <button type="button" class="btn sm gs-drop" data-index="${s.index}">drop</button>
      </div>
      <pre class="gd-diff-out hidden" data-stash-diff="${s.index}"></pre>
    </div>`).join('') || '<div class="empty">No stashes for this repo.</div>';

  app.innerHTML = `
    <div class="task-toolbar">
      <a href="#git">← back to Git</a>
      <strong style="margin-left:12px">${esc(slug)} — ${list.length} stash(es)</strong>
    </div>
    ${rows}`;

  $$('.gs-diff', app).forEach((b) => b.addEventListener('click', () => toggleStashDiff(slug, b.dataset.index)));
  $$('.gs-drop', app).forEach((b) => b.addEventListener('click', () => dropStashUI(slug, b.dataset.index)));
  if (!FRESH) applyUISnap();
  stamp();
}

async function toggleStashDiff(slug, index) {
  const pre = $(`.gd-diff-out[data-stash-diff="${index}"]`);
  if (!pre) return;
  if (!pre.classList.contains('hidden')) { pre.classList.add('hidden'); return; }
  pre.classList.remove('hidden');
  pre.textContent = 'loading diff…';
  try {
    const r = await api('GET', `/api/git/${encodeURIComponent(slug)}/stashes/${index}/diff`);
    pre.textContent = r.diff || '(empty diff)';
  } catch (e) { pre.textContent = `diff failed: ${e.message}`; }
}

async function dropStashUI(slug, index) {
  if (!confirm('Drop this stash? This cannot be undone.')) return;
  try {
    await api('DELETE', `/api/git/${encodeURIComponent(slug)}/stashes/${index}`);
    toast('Stash dropped');
    FRESH = true;
    await renderGitStashes(slug);
  } catch (e) { toast(`drop failed: ${e.message}`, 'err'); }
}
```

- [ ] **Step 4: Manual verification (Playwright)**

```bash
# Set up a real scratch stash to view/drop through the UI
cd sites/americastrikes.com && echo "x" >> README.md 2>/dev/null && git stash push -m "fd-ui-test-stash" -- README.md; cd ../..
```

```
browser_navigate to http://127.0.0.1:4754/?v=3#git/americastrikes.com/stashes
browser_snapshot → confirm the "fd-ui-test-stash" entry renders with ref/message/when
browser_click "view diff" → confirm the diff pane expands with the appended line
browser_click "drop" → browser_handle_dialog to accept confirm() → confirm the list re-renders empty (or without that entry)
```

Expected: no console errors; `git -C sites/americastrikes.com stash list` is empty afterward (confirms the drop landed for real, not just in the UI).

- [ ] **Step 5: Commit**

```bash
cd /home/jesse/projects/domains
rm -rf tools/fleet-dashboard/.playwright-mcp
cat > /tmp/commit-msg-8.txt <<'EOF'
feat(fleet-dashboard): add dedicated stash browsing page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
git add tools/fleet-dashboard/server/public/app.js
git commit -F /tmp/commit-msg-8.txt
```

---

### Task 9: Full regression pass and final commit sweep

**Files:** none new — verification only.

- [ ] **Step 1: Run the full unit test suite**

Run: `cd tools/fleet-dashboard && npm test`
Expected: PASS (all files, including `logic.test.js`, `actionlog.test.js`, `datahub-images.test.js`, `datahub-images-routes.test.js`)

- [ ] **Step 2: Full Playwright pass over the Git tab end-to-end**

```
browser_navigate to http://127.0.0.1:4754/?v=4#git
browser_snapshot → confirm: SHA badges + colors, stash badges where applicable, existing commit/push/diff/ignore UI still works (click a dirty repo's row, verify file checkboxes/diff/ignore/commit-message box/push button all still present and functional from earlier work)
browser_console_messages → confirm no errors across the whole pass
```

- [ ] **Step 3: Confirm the guardrail tests from the spec's Testing section still hold**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4754/api/git/not-a-real-site/branches        # expect 404
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE http://127.0.0.1:4754/api/git/americastrikes.com/branches/main   # expect 400
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4754/api/git/americastrikes.com/stashes/not-a-number/diff   # expect 400
```

Expected: 404, 400, 400.

- [ ] **Step 4: Confirm no test artifacts or scratch state leaked into the working tree**

```bash
git -C /home/jesse/projects/domains status
git -C /home/jesse/projects/domains/sites/americastrikes.com status   # must be clean of scratch branches/stashes/dirty README changes from manual testing
rm -rf /home/jesse/projects/domains/tools/fleet-dashboard/.playwright-mcp
```

If any scratch branch/stash/dirty file from the manual-verification steps is still present, clean it up now (delete the scratch branch, drop the scratch stash, `git checkout --` any scratch dirty file) — these are fleet cron repos and must be left exactly as found.

- [ ] **Step 5: Final commit if anything is uncommitted**

```bash
cd /home/jesse/projects/domains
git status  # tools/fleet-dashboard/ should already be fully committed from Tasks 1-8
```

No commit expected here if Tasks 1-8 each committed cleanly — this step is a safety net, not a scheduled deliverable.

---

## Self-Review Notes (for the plan author, already applied above)

- Spec coverage: SHA+color (Task 1, 6), branches list+diagnostics (Task 2, 7), stash view+drop own-page (Task 3, 8), pull (Task 4, 6), routes (Task 5). All four spec goals have a task pair (backend + frontend). Non-goals (no fetch, no checkout, no apply/pop, no summary bar) are respected — no task introduces any of them.
- Type/name consistency checked: `computeSyncState`, `parseLocalBranches`, `parseMergedSet`, `parseRemoteOnlyBranches`, `parseStashList`, `branches`, `deleteBranch`, `stashes`, `stashDiff`, `dropStash`, `pull` are used with the same names/signatures across Tasks 1-5 and referenced consistently in Tasks 6-8's frontend calls.
- Flagged uncertainty: Task 6/7/8 note where the exact existing `gitPush`/`toast` function signatures should be confirmed by `grep` before writing new code that mirrors them, since this plan was written without pasting every line of `app.js` — the pattern (return shape, error surfacing) is already established by `gitCommit`/`gitPush`/`gitIgnore`, so matching it is mechanical, not a design decision.
