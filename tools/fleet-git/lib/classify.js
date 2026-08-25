'use strict';

const { ruleFor, matchedPattern } = require('./policy');
const { normPath } = require('./glob');

// Pure: (repo status + policy) → a plan of what a sweep would do.
// No filesystem, no git, no clock — everything here is unit-testable.
//
// plan = {
//   slug, branch, upstream, ahead, behind, detached,
//   skip:      null | 'reason'         // repo is not safe to auto-act on
//   blocked:   [{path, ruleId, reason}]// credential-shaped paths — halt the repo
//   ignore:    [{path, ruleId, tracked, untrack}]
//   commit:    [{group, message, paths:[...], ruleIds:[...]}]
//   review:    [{path, kind, reason}]  // needs an operator decision
//   pointers:  [{path}]                // parent repo only: submodule gitlink bumps
//   push:      bool
// }
function plan(status, { slug, policy, submodulePaths = new Set(), isParent = false }) {
  const out = {
    slug,
    branch: status.branch || null,
    upstream: status.upstream || null,
    ahead: status.ahead || 0,
    behind: status.behind || 0,
    detached: !!status.detached,
    skip: null,
    blocked: [],
    ignore: [],
    commit: [],
    review: [],
    pointers: [],
    push: false,
  };

  if (!status.isRepo) {
    out.skip = status.error || 'not a git repository';
    return out;
  }
  // A detached HEAD has no branch to push; a repo behind its upstream needs a
  // pull/merge decision a sweeper must never make on its own. Report, don't act.
  if (status.detached) {
    out.skip = 'detached HEAD';
    return out;
  }
  if (!status.branch) {
    out.skip = 'no branch';
    return out;
  }
  if (status.behind > 0) {
    out.skip = `behind upstream by ${status.behind} commit(s) — needs a pull decision`;
    return out;
  }

  const groups = new Map();
  for (const f of status.files || []) {
    const p = normPath(f.path);
    const tracked = f.kind !== 'untracked';

    // Parent-repo gitlink bump: `sites/x.com` modified means the submodule's
    // HEAD moved. It is committed by the pointer pass, not as a normal file,
    // and only once that submodule is itself clean and pushed.
    if (isParent && submodulePaths.has(p)) {
      out.pointers.push({ path: p });
      continue;
    }

    const rule = ruleFor(policy, slug, p);
    if (!rule) {
      out.review.push({ path: p, kind: f.kind, reason: 'no policy rule matches' });
      continue;
    }
    if (rule.action === 'block') {
      out.blocked.push({ path: p, ruleId: rule.id, reason: rule.reason || 'blocked by policy' });
      continue;
    }
    if (rule.action === 'review') {
      out.review.push({ path: p, kind: f.kind, reason: rule.reason || `rule ${rule.id}` });
      continue;
    }
    if (rule.action === 'ignore') {
      // Ignoring an already-TRACKED path means untracking it — a history
      // change. Only rules that opted in (`untrack: true`) may do that
      // unattended; anything else goes to an operator.
      if (tracked && !rule.untrack) {
        out.review.push({
          path: p,
          kind: f.kind,
          reason: `rule ${rule.id} would ignore this, but it is already tracked (needs untrack approval)`,
        });
        continue;
      }
      out.ignore.push({
        path: p,
        ruleId: rule.id,
        pattern: matchedPattern(rule, p) || p,
        tracked,
        untrack: !!rule.untrack,
      });
      continue;
    }
    // commit
    const key = rule.group || rule.id;
    if (!groups.has(key))
      groups.set(key, {
        group: key,
        message: rule.message || `chore: sync ${key}`,
        paths: [],
        ruleIds: new Set(),
      });
    const g = groups.get(key);
    g.paths.push(p);
    g.ruleIds.add(rule.id);
  }

  const maxFiles = policy.limits.max_files_per_commit;
  for (const g of groups.values()) {
    // A commit far larger than any normal cron tick is a signal something went
    // wrong (a bad checkout, a tool writing into the wrong tree) — not
    // something to rubber-stamp at 200+ files unattended.
    if (g.paths.length > maxFiles) {
      for (const p of g.paths)
        out.review.push({
          path: p,
          kind: 'bulk',
          reason: `group "${g.group}" has ${g.paths.length} files (limit ${maxFiles})`,
        });
      continue;
    }
    out.commit.push({
      group: g.group,
      message: g.message,
      paths: g.paths,
      ruleIds: [...g.ruleIds],
    });
  }

  // Blocked credentials halt the whole repo: do not commit, ignore or push
  // anything while a secret is sitting in the tree.
  if (out.blocked.length) {
    out.skip = `blocked: ${out.blocked.length} credential-shaped path(s)`;
    out.ignore = [];
    out.commit = [];
    out.pointers = [];
    return out;
  }

  out.push = out.ahead > 0 || out.commit.length > 0 || out.ignore.length > 0;
  return out;
}

function isClean(p) {
  return (
    !p.skip &&
    !p.blocked.length &&
    !p.ignore.length &&
    !p.commit.length &&
    !p.review.length &&
    !p.pointers.length &&
    !p.ahead
  );
}

module.exports = { plan, isClean };
