'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { git, status } = require('./gitexec');
const { discover } = require('./repos');
const { load: loadPolicy } = require('./policy');
const { plan, isClean } = require('./classify');
const gitignore = require('./gitignore');
const queue = require('./queue');

const HYGIENE_TRAILER = 'fleet-git: automated hygiene sweep';

// Execute one repo's plan. `apply=false` is a full dry run: every decision is
// computed and reported, nothing is written.
async function executeRepo(repo, p, policy, { apply, push }) {
  const acts = [];
  const errors = [];
  const cwd = repo.dir;
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
    const c = await git(cwd, ['commit', '-m', g.message, '-m', HYGIENE_TRAILER, '--', ...g.paths]);
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
        gitignore.appendLocal(cwd, item.pattern || item.path, { write: true });
        ignoreTouched = true;
        note('gitignore-local', `${item.pattern || item.path} (rule ${item.ruleId})`);
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
      if (untrack.length) {
        // `git rm --cached` is an INDEX change; a path-limited commit can't
        // express it, so this has to be a plain index commit — which is only
        // safe if nothing else is staged. Re-check right before, because the
        // site's own cron may have staged something since the sweep started.
        const pre = await git(cwd, ['diff', '--cached', '--name-only']);
        if (pre.ok && pre.out.trim()) {
          errors.push(
            `${repo.slug}: skipped untracking (${untrack.join(', ')}) — repo has unrelated staged changes`
          );
        } else {
          await git(cwd, ['add', '--', '.gitignore']);
          const rm = await git(cwd, ['rm', '--cached', '-r', '--quiet', '--', ...untrack]);
          if (!rm.ok) errors.push(`git rm --cached failed in ${repo.slug}: ${rm.err.trim()}`);
          const c = await git(cwd, ['commit', '-m', msg, '-m', HYGIENE_TRAILER]);
          if (!c.ok && !/nothing to commit/i.test(c.out + c.err))
            errors.push(`git commit failed in ${repo.slug}: ${(c.err || c.out).trim()}`);
        }
      } else {
        const c = await git(cwd, ['commit', '-m', msg, '-m', HYGIENE_TRAILER, '--', '.gitignore']);
        if (!c.ok && !/nothing to commit/i.test(c.out + c.err))
          errors.push(`git commit failed in ${repo.slug}: ${(c.err || c.out).trim()}`);
      }
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

  const { repos, unregistered } = await discover(root);
  const submodulePaths = new Set(repos.filter(r => r.subPath).map(r => r.subPath));

  const subs = repos.filter(r => !r.parent).filter(r => !only || only.includes(r.slug));
  const parent = repos.find(r => r.parent);

  const results = [];
  const reviewsBySlug = {};
  const sweptSlugs = new Set();
  const errors = [];

  for (const repo of subs) {
    const st = await status(repo.dir);
    const p = plan(st, { slug: repo.slug, policy });
    const { acts, errors: e } = await executeRepo(repo, p, policy, { apply, push });
    errors.push(...e);
    reviewsBySlug[repo.slug] = p.review;
    sweptSlugs.add(repo.slug);
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
    const st = await status(parent.dir);
    const p = plan(st, { slug: 'domains', policy, submodulePaths, isParent: true });
    const { acts, errors: e } = await executeRepo(parent, p, policy, { apply, push: false });
    errors.push(...e);

    // Only bump a pointer whose submodule this sweep left clean and pushed.
    const cleanSubs = new Map(results.map(r => [r.subPath, r]));
    const bump = [];
    const held = [];
    for (const ptr of p.pointers) {
      const sub = cleanSubs.get(ptr.path);
      if (!only && !sub) {
        held.push({ path: ptr.path, why: 'submodule not swept' });
        continue;
      }
      if (sub && !sub.clean) {
        held.push({ path: ptr.path, why: 'submodule still dirty/unpushed' });
        continue;
      }
      if (sub) {
        const s = await status(sub_dir(root, ptr.path));
        if (s.ahead > 0) {
          held.push({ path: ptr.path, why: 'submodule has unpushed commits' });
          continue;
        }
      }
      bump.push(ptr.path);
    }
    if (bump.length) {
      const msg = `chore: bump ${bump.length} site pointer(s)`;
      acts.push({
        action: 'commit',
        detail: `${msg} [${bump.join(', ')}]`,
        group: 'pointers',
        paths: bump,
      });
      if (apply) {
        const add = await git(parent.dir, ['add', '--', ...bump]);
        if (!add.ok) errors.push(`parent git add failed: ${add.err.trim()}`);
        const c = await git(parent.dir, [
          'commit',
          '-m',
          msg,
          '-m',
          HYGIENE_TRAILER,
          '--',
          ...bump,
        ]);
        if (!c.ok && !/nothing to commit/i.test(c.out + c.err))
          errors.push(`parent commit failed: ${(c.err || c.out).trim()}`);
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
    sweptSlugs.add('domains');
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

function sub_dir(root, subPath) {
  return path.join(root, subPath);
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
