'use strict';

// Git Hygiene tab — the control surface for tools/fleet-git.
//
// The dashboard owns none of the logic: it calls the same library the CLI and
// the cron sweep call, so a decision made by clicking a button in here and one
// made by the hourly cron are the same code path. The only thing this file
// adds is (a) one-at-a-time serialization of sweeps and (b) turning an
// operator's "always do this" into a persisted policy rule.

const path = require('node:path');

const FG = path.join(__dirname, '..', '..', 'fleet-git');
const { sweep } = require(path.join(FG, 'lib', 'sweep'));
const { load: loadPolicy, addRule } = require(path.join(FG, 'lib', 'policy'));
const queue = require(path.join(FG, 'lib', 'queue'));
const gitignore = require(path.join(FG, 'lib', 'gitignore'));
const { discover } = require(path.join(FG, 'lib', 'repos'));
const { git } = require(path.join(FG, 'lib', 'gitexec'));

function httpErr(status, msg) {
  const e = new Error(msg);
  e.httpStatus = status;
  return e;
}

// A sweep mutates ~49 repos; two concurrent ones would interleave commits and
// pushes on the same trees. One at a time, globally.
let inFlight = null;

async function run(root, { apply = false, only = null } = {}) {
  if (inFlight) throw httpErr(409, 'a sweep is already running');
  inFlight = sweep(root, { apply, push: true, only });
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

function running() {
  return !!inFlight;
}

// Board state for the tab: last applied sweep + the live review queue, with no
// git calls of its own (so polling this is cheap).
function board() {
  const policy = loadPolicy();
  return {
    running: running(),
    lastSweep: queue.lastSweep(),
    queue: queue
      .open()
      .sort((a, b) => a.slug.localeCompare(b.slug) || a.path.localeCompare(b.path)),
    policy: {
      version: policy.version,
      rules: policy.rules.map(r => ({
        id: r.id,
        action: r.action,
        scope: r.scope,
        match: r.match,
        reason: r.reason,
      })),
      ignoreBlock: policy.ignoreBlock,
      limits: policy.limits,
    },
  };
}

const SLUG_RE = /^[A-Za-z0-9._-]+$/;

async function repoFor(root, slug) {
  if (!SLUG_RE.test(String(slug || ''))) throw httpErr(400, 'invalid slug');
  const { repos } = await discover(root);
  const repo = repos.find(r => r.slug === slug);
  if (!repo) throw httpErr(404, `unknown repo: ${slug}`);
  return repo;
}

// Reject anything that could escape the repo or be read as a git option.
function safeRel(p) {
  const s = String(p || '').trim();
  if (!s || s.startsWith('-') || s.startsWith('/') || s.includes('\0')) return null;
  if (s.split('/').includes('..')) return null;
  return s.replace(/\/+$/, '');
}

// Resolve one queued review item. `remember` turns the same decision into a
// policy rule so the item's whole CLASS stops reaching the operator.
async function resolve(
  root,
  { slug, path: rel, decision, remember, scope, message, group, untrack }
) {
  const p = safeRel(rel);
  if (!p) throw httpErr(400, 'invalid path');
  if (!['commit', 'ignore', 'dismiss'].includes(decision)) throw httpErr(400, 'bad decision');
  const repo = await repoFor(root, slug);

  let rule = null;
  if (remember && decision !== 'dismiss') {
    const glob = safeRel(remember === true ? p : remember);
    if (!glob) throw httpErr(400, 'invalid remember glob');
    const id = `${decision}-${glob
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase()}`.slice(0, 80);
    rule =
      decision === 'ignore'
        ? {
            id,
            action: 'ignore',
            scope: scope === 'fleet' ? 'fleet' : [slug],
            match: [glob],
            untrack: !!untrack,
            reason: 'operator decision (Git Hygiene board)',
          }
        : {
            id,
            action: 'commit',
            scope: scope === 'fleet' ? 'fleet' : [slug],
            group: group || 'ops',
            message: message || 'chore(ops): sync ops state',
            match: [glob],
            reason: 'operator decision (Git Hygiene board)',
          };
    try {
      addRule(rule);
    } catch (e) {
      // A duplicate id means the class is already covered — not a failure.
      if (!/already has a rule id/.test(e.message)) throw e;
      rule = { ...rule, existing: true };
    }
  }

  if (decision === 'ignore') {
    gitignore.appendLocal(repo.dir, p);
    const tracked = await git(repo.dir, ['ls-files', '--error-unmatch', '--', p]);
    if (tracked.ok) {
      const pre = await git(repo.dir, ['diff', '--cached', '--name-only']);
      if (pre.ok && pre.out.trim())
        throw httpErr(
          409,
          'repo has staged changes — commit or unstage them before untracking a file'
        );
      await git(repo.dir, ['rm', '--cached', '-r', '--quiet', '--', p]);
    }
    await git(repo.dir, ['add', '--', '.gitignore']);
    const c = await git(repo.dir, ['commit', '-m', `chore(git-hygiene): ignore ${p}`]);
    if (!c.ok && !/nothing to commit/i.test(c.out + c.err))
      throw httpErr(500, (c.err || c.out).trim() || 'git commit failed');
  } else if (decision === 'commit') {
    const msg = (message || '').trim() || `chore(ops): sync ${p}`;
    const add = await git(repo.dir, ['add', '--', p]);
    if (!add.ok) throw httpErr(500, add.err.trim() || 'git add failed');
    const c = await git(repo.dir, ['commit', '-m', msg, '--', p]);
    if (!c.ok && !/nothing to commit/i.test(c.out + c.err))
      throw httpErr(500, (c.err || c.out).trim() || 'git commit failed');
  }

  queue.remove(slug, p);
  return { ok: true, decision, rule };
}

// Deliberate, reviewable adoption of the fleet-managed .gitignore block.
// Never runs as a side effect of a sweep (see gitignore.sync requireExisting).
async function ignoreSync(root, { apply = false, only = null } = {}) {
  const policy = loadPolicy();
  const { repos } = await discover(root);
  const changed = [];
  for (const r of repos) {
    if (r.parent) continue;
    if (only && !only.includes(r.slug)) continue;
    const res = gitignore.sync(r.dir, policy.ignoreBlock, { write: apply });
    if (res.changed) changed.push({ slug: r.slug, created: res.created });
  }
  return { ok: true, apply, changed };
}

module.exports = { run, board, resolve, ignoreSync, running };
