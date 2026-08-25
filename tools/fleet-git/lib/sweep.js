'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { git, status, identityArgs } = require('./gitexec');
const { discover } = require('./repos');
const { load: loadPolicy } = require('./policy');
const { plan, isClean } = require('./classify');
const gitignore = require('./gitignore');
const { commitViaScratchIndex } = require('./scratchindex');
const queue = require('./queue');

const HYGIENE_TRAILER = 'fleet-git: automated hygiene sweep';

// One sweep at a time across ALL callers — cron, the CLI, and the dashboard's
// "Sweep now" button (which lives in a different container). A per-process
// flag cannot do that, and the cron's `flock` on /tmp is not shared with the
// dashboard container. The lock file lives in the repo, which every caller has
// bind-mounted at the same path, so it is the one place they all agree on.
// Overridable so tests (and a second fleet root, should one ever exist) get
// their own lock instead of contending for this checkout's.
const LOCK_PATH = process.env.FLEET_GIT_LOCK || path.join(__dirname, '..', 'state', 'sweep.lock');
const LOCK_STALE_MS = 45 * 60 * 1000;

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  try {
    fs.writeFileSync(LOCK_PATH, payload, { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  // A holder killed mid-sweep would otherwise wedge the fleet forever. Steal a
  // lock that is older than any plausible sweep.
  let age = Infinity;
  try {
    age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs;
  } catch {
    /* vanished between calls — treat as stale */
  }
  if (age > LOCK_STALE_MS) {
    fs.writeFileSync(LOCK_PATH, payload);
    return true;
  }
  return false;
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    /* already gone */
  }
}

// Execute one repo's plan. `apply=false` is a full dry run: every decision is
// computed and reported, nothing is written.
async function executeRepo(repo, p, policy, { apply, push }) {
  const acts = [];
  const errors = [];
  const cwd = repo.dir;
  // Empty for every repo that has its own committer identity (all of them, in
  // practice); only a repo with none gets a fallback injected.
  const ident = apply ? await identityArgs(cwd) : [];
  const note = (action, detail, extra = {}) => acts.push({ action, detail, ...extra });

  if (p.blocked.length) {
    for (const b of p.blocked) note('blocked', `${b.path} — ${b.reason}`);
    return { acts, errors };
  }
  if (p.skip) return { acts, errors };

  // --- 1. commit groups (path-limited, so nothing else in the index rides along)
  for (const g of p.commit) {
    // Oversize guard: a single huge file in an otherwise routine group is far
    // more likely to be a mistake (a stray video, a dumped DB) than content.
    const oversize = g.paths.filter(rel => {
      try {
        return fs.statSync(path.join(cwd, rel)).size > policy.limits.max_file_bytes;
      } catch {
        return false; // deleted paths have no size
      }
    });
    if (oversize.length) {
      for (const o of oversize)
        p.review.push({ path: o, kind: 'oversize', reason: `exceeds max_file_bytes` });
      g.paths = g.paths.filter(x => !oversize.includes(x));
      if (!g.paths.length) continue;
    }
    note('commit', `${g.message} (${g.paths.length} file(s))`, { group: g.group, paths: g.paths });
    if (!apply) continue;
    const add = await git(cwd, ['add', '--', ...g.paths]);
    if (!add.ok) {
      errors.push(`git add failed in ${repo.slug}: ${add.err.trim()}`);
      continue;
    }
    const c = await git(cwd, [
      ...ident,
      'commit',
      '-m',
      g.message,
      '-m',
      HYGIENE_TRAILER,
      '--',
      ...g.paths,
    ]);
    if (!c.ok && !/nothing to commit/i.test(c.out + c.err))
      errors.push(`git commit failed in ${repo.slug}: ${(c.err || c.out).trim()}`);
  }

  // --- 2. gitignore: managed block + any path policy says to ignore that git
  //        does not already ignore.
  const sync = gitignore.sync(cwd, policy.ignoreBlock, { write: apply, requireExisting: true });
  let ignoreTouched = sync.changed;
  if (sync.changed)
    note('gitignore-block', `${sync.created ? 'created' : 'updated'} managed block`);

  const untrack = [];
  for (const item of p.ignore) {
    if (item.tracked && item.untrack) untrack.push(item.path);
    // check-ignore reflects the on-disk .gitignore, which in dry-run mode has
    // NOT been updated — so in dry-run we can only report intent.
    if (apply) {
      const ci = await git(cwd, ['check-ignore', '-q', '--', item.path]);
      if (!ci.ok) {
        // Write the rule's PATTERN, not the literal path — otherwise every
        // new .pyc adds another line to the repo's .gitignore forever.
        const line = gitignore.anchorPattern(item.pattern || item.path);
        gitignore.appendLocal(cwd, line, { write: true });
        ignoreTouched = true;
        note('gitignore-local', `${line} (rule ${item.ruleId})`);
      }
    } else {
      note('gitignore-check', `${item.path} (rule ${item.ruleId})`);
    }
  }

  if (ignoreTouched || untrack.length) {
    const msg = untrack.length
      ? `chore(git-hygiene): untrack ${untrack.length} generated path(s)`
      : 'chore(git-hygiene): sync managed .gitignore';
    note('commit', `${msg}${untrack.length ? ` [${untrack.join(', ')}]` : ''}`, {
      group: 'git-hygiene',
      paths: ['.gitignore', ...untrack],
    });
    if (apply) {
      // Both shapes go through a SCRATCH index (see lib/scratchindex.js). The
      // old code committed the live index after checking that nothing else was
      // staged — a check that is not atomic against the site's own cron
      // container running `git add -A` in the same repo. A scratch index makes
      // the race unreachable instead of merely unlikely, and its compare-and-
      // swap on HEAD refuses rather than clobbers if that cron commits midway.
      const res = await commitViaScratchIndex(cwd, {
        add: ['.gitignore'],
        remove: untrack,
        message: msg,
        trailer: HYGIENE_TRAILER,
        ident,
      });
      if (!res.ok) errors.push(`git-hygiene commit failed in ${repo.slug}: ${res.err}`);
    }
  }

  // --- 3. push
  if (push) {
    const after = apply ? await status(cwd) : null;
    const ahead = apply ? after.ahead : p.ahead + acts.filter(a => a.action === 'commit').length;
    if (ahead > 0) {
      note('push', `${repo.slug}: ${ahead} commit(s)`);
      if (apply) {
        const args = after.upstream ? ['push'] : ['push', '-u', 'origin', after.branch];
        const r = await git(cwd, args, { timeout: 180000 });
        if (!r.ok) errors.push(`git push failed in ${repo.slug}: ${(r.err || r.out).trim()}`);
      }
    }
  }

  return { acts, errors };
}

// Full fleet sweep. Submodules first, then the parent — so the parent's
// gitlink pointers are only bumped for sites that are already clean AND pushed
// (a pointer commit referencing an unpushed submodule commit is exactly the
// "silently stale site" failure this tool exists to end).
async function sweep(root, opts = {}) {
  const {
    apply = false,
    push = true,
    only = null,
    policy = loadPolicy(),
    now = new Date().toISOString(),
  } = opts;

  if (apply && !acquireLock())
    throw Object.assign(new Error('another fleet-git sweep is already running'), {
      httpStatus: 409,
    });
  try {
    return await runSweep(root, { apply, push, only, policy, now });
  } finally {
    if (apply) releaseLock();
  }
}

async function runSweep(root, { apply, push, only, policy, now }) {
  const { repos, unregistered: allUnregistered } = await discover(root);
  // A directory under sites/ that is not a submodule resolves its git commands
  // against the PARENT repo — which is how "site X is dirty" can silently be
  // the monorepo's own status. Report the unexplained ones only.
  const unregistered = allUnregistered.filter(p => !policy.unregisteredOk[p]);
  const submodulePaths = new Set(repos.filter(r => r.subPath).map(r => r.subPath));

  const subs = repos.filter(r => !r.parent).filter(r => !only || only.includes(r.slug));
  const parent = repos.find(r => r.parent);

  const results = [];
  const reviewsBySlug = {};
  const sweptSlugs = new Set();
  const errors = [];

  for (const repo of subs) {
    // `behind` in porcelain output compares against the LOCAL origin/* ref. With
    // no fetch, a repo someone pushed to from elsewhere reports behind: 0, gets
    // committed, and the push is rejected non-fast-forward. Refresh the ref
    // first; a fetch failure is non-fatal (offline is not a reason to stop) but
    // is surfaced so "behind is enforced" is not a claim made on stale data.
    if (apply) {
      const f = await git(repo.dir, ['fetch', '--quiet', '--no-tags'], { timeout: 60000 });
      if (!f.ok)
        errors.push(`fetch failed in ${repo.slug} (ref state may be stale): ${f.err.trim()}`);
    }
    const st = await status(repo.dir);
    const p = plan(st, { slug: repo.slug, policy });
    const { acts, errors: e } = await executeRepo(repo, p, policy, { apply, push });
    errors.push(...e);
    reviewsBySlug[repo.slug] = p.review;
    // A skipped repo produced NO review list (plan() returns early), so marking
    // it swept would make reconcile() delete all of its open items as "operator
    // fixed it", then re-add them with a fresh first_seen next time — the >24h
    // nag could never fire on an intermittently-skipped repo.
    if (!p.skip) sweptSlugs.add(repo.slug);
    const post = apply ? await status(repo.dir) : null;
    results.push({
      slug: repo.slug,
      subPath: repo.subPath,
      plan: p,
      acts,
      errors: e,
      clean: post ? post.files.length === 0 && post.ahead === 0 && !post.detached : isClean(p),
    });
  }

  // --- parent repo: own files, then submodule pointer bumps.
  if (parent && (!only || only.includes('domains'))) {
    if (apply) {
      const f = await git(parent.dir, ['fetch', '--quiet', '--no-tags'], { timeout: 60000 });
      if (!f.ok) errors.push(`fetch failed in domains (ref state may be stale): ${f.err.trim()}`);
    }
    const st = await status(parent.dir);
    const p = plan(st, { slug: 'domains', policy, submodulePaths, isParent: true });
    const { acts, errors: e } = await executeRepo(parent, p, policy, { apply, push: false });
    errors.push(...e);

    // Only bump a pointer whose submodule is clean AND whose HEAD actually
    // exists on its remote. `ahead === 0` is NOT that test: a branch with no
    // upstream also reports ahead 0, so the old check could write a gitlink
    // pointing at a commit that exists on exactly one disk — the "permanently
    // unreachable site state" this tool exists to prevent.
    //
    // The SHA is captured HERE and applied via `update-index --cacheinfo`
    // rather than `git add <gitlink>`: `git add` records whatever the submodule
    // HEAD is at add-time, and ~49 sequential status calls leave a wide window
    // for that site's own cron to commit-without-pushing in between.
    const bump = [];
    const held = [];
    for (const ptr of p.pointers) {
      const subDir = path.join(root, ptr.path);
      const s2 = await status(subDir);
      if (!s2.isRepo) {
        held.push({ path: ptr.path, why: `submodule status unavailable: ${s2.error}` });
        continue;
      }
      if (s2.files.length) {
        held.push({ path: ptr.path, why: `submodule has ${s2.files.length} uncommitted file(s)` });
        continue;
      }
      if (!s2.upstream) {
        held.push({
          path: ptr.path,
          why: 'submodule branch has no upstream — its HEAD exists on one disk only',
        });
        continue;
      }
      const local = await git(subDir, ['rev-parse', 'HEAD']);
      const remote = await git(subDir, ['rev-parse', '@{u}']);
      if (!local.ok || !remote.ok) {
        held.push({ path: ptr.path, why: 'cannot resolve submodule HEAD vs upstream' });
        continue;
      }
      if (local.out.trim() !== remote.out.trim()) {
        held.push({ path: ptr.path, why: 'submodule HEAD is not the commit on its remote' });
        continue;
      }
      bump.push({ path: ptr.path, sha: local.out.trim() });
    }
    const bumpPaths = bump.map(b => b.path);
    if (bump.length) {
      const msg = `chore: bump ${bump.length} site pointer(s)`;
      acts.push({
        action: 'commit',
        detail: `${msg} [${bumpPaths.join(', ')}]`,
        group: 'pointers',
        paths: bumpPaths,
      });
      if (apply) {
        const pident = await identityArgs(parent.dir);
        // Each gitlink is written from the SHA verified above, in a scratch
        // index, so a submodule that moves mid-sweep cannot substitute an
        // unpushed commit into this pointer commit.
        const res = await commitViaScratchIndex(parent.dir, {
          gitlinks: bump,
          message: msg,
          trailer: HYGIENE_TRAILER,
          ident: pident,
        });
        if (!res.ok) errors.push(`parent pointer commit failed: ${res.err}`);
      }
    }
    for (const h of held) acts.push({ action: 'hold', detail: `${h.path} — ${h.why}` });

    if (push) {
      const after = apply ? await status(parent.dir) : null;
      const ahead = apply ? after.ahead : p.ahead + p.commit.length + (bump.length ? 1 : 0);
      if (ahead > 0) {
        acts.push({ action: 'push', detail: `domains: ${ahead} commit(s)` });
        if (apply) {
          const args = after.upstream ? ['push'] : ['push', '-u', 'origin', after.branch];
          const r = await git(parent.dir, args, { timeout: 180000 });
          if (!r.ok) errors.push(`parent push failed: ${(r.err || r.out).trim()}`);
        }
      }
    }

    reviewsBySlug.domains = p.review;
    if (!p.skip) sweptSlugs.add('domains');
    const post = apply ? await status(parent.dir) : null;
    results.push({
      slug: 'domains',
      plan: p,
      acts,
      errors: [],
      held,
      clean: post ? post.files.length === 0 && post.ahead === 0 : isClean(p),
    });
  }

  const report = {
    at: now,
    apply,
    root,
    repos: results.length,
    unregistered,
    dirty: results.filter(r => !r.clean).map(r => r.slug),
    blocked: results.flatMap(r => r.plan.blocked.map(b => ({ slug: r.slug, ...b }))),
    skipped: results.filter(r => r.plan.skip).map(r => ({ slug: r.slug, why: r.plan.skip })),
    reviewCount: Object.values(reviewsBySlug).reduce((n, a) => n + a.length, 0),
    errors,
    results,
  };
  if (apply) {
    queue.reconcile(reviewsBySlug, { now, sweptSlugs });
    queue.saveSweep({ ...report, results: undefined, summary: results.map(summarize) });
  }
  report.queue = apply
    ? queue.open()
    : Object.entries(reviewsBySlug).flatMap(([slug, rs]) => rs.map(r => ({ slug, ...r })));
  return report;
}

function summarize(r) {
  return {
    slug: r.slug,
    clean: r.clean,
    skip: r.plan.skip,
    commits: r.acts.filter(a => a.action === 'commit').length,
    pushed: r.acts.some(a => a.action === 'push'),
    review: r.plan.review.length,
    blocked: r.plan.blocked.length,
    errors: r.errors?.length || 0,
  };
}

module.exports = { sweep, executeRepo, summarize };
