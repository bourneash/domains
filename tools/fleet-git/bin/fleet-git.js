#!/usr/bin/env node
'use strict';

// fleet-git — fleet-wide git hygiene: classify every dirty path against
// policy.json, then ignore / commit / push it, and queue anything policy
// doesn't recognise for one operator decision instead of fifty.
//
//   fleet-git audit              dry run, human report (exit 1 if not clean)
//   fleet-git sweep --apply      do it for real
//   fleet-git queue              open review items
//   fleet-git resolve ...        decide one queued item (optionally as a rule)
//   fleet-git ignore-sync --apply  push the managed .gitignore block fleet-wide
//
// Flags: --json  --site a,b  --no-push  --dry-run

const path = require('node:path');
const ROOT = process.env.FLEET_GIT_ROOT || path.resolve(__dirname, '..', '..', '..');

const { sweep } = require('../lib/sweep');
const { load: loadPolicy, addRule } = require('../lib/policy');
const queue = require('../lib/queue');
const gitignore = require('../lib/gitignore');
const { discover } = require('../lib/repos');
const { git } = require('../lib/gitexec');

const argv = process.argv.slice(2);
const cmd = argv[0] || 'audit';
const flag = n => argv.includes(`--${n}`);
const val = n => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? null : argv[i + 1];
};

const JSON_OUT = flag('json');
const only = val('site')
  ? val('site')
      .split(',')
      .map(s => s.trim())
  : null;
const push = !flag('no-push');

const C = process.stdout.isTTY
  ? {
      g: s => `\x1b[32m${s}\x1b[0m`,
      r: s => `\x1b[31m${s}\x1b[0m`,
      y: s => `\x1b[33m${s}\x1b[0m`,
      d: s => `\x1b[2m${s}\x1b[0m`,
    }
  : { g: s => s, r: s => s, y: s => s, d: s => s };

async function main() {
  switch (cmd) {
    case 'audit':
      return report(await sweep(ROOT, { apply: false, push, only }), false);
    case 'sweep': {
      const apply = flag('apply') && !flag('dry-run');
      const rep = await sweep(ROOT, { apply, push, only });
      return report(rep, apply);
    }
    case 'queue':
      return showQueue();
    case 'resolve':
      return resolve();
    case 'ignore-sync':
      return ignoreSync();
    case 'policy':
      return console.log(JSON.stringify(loadPolicy().raw, null, 2));
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(2);
  }
}

function report(rep, applied) {
  if (JSON_OUT) {
    // process.exit() does NOT flush an async pipe write — a ~200KB report piped
    // to a consumer arrives truncated and unparseable. Set the code and let the
    // process end naturally instead.
    console.log(JSON.stringify(rep, null, 2));
    process.exitCode = rep.blocked.length || rep.errors.length || rep.reviewCount ? 1 : 0;
    return;
  }
  const mode = applied ? 'SWEEP (applied)' : 'AUDIT (dry run)';
  console.log(`fleet-git ${mode} — ${rep.repos} repo(s) @ ${rep.at}\n`);

  for (const r of rep.results) {
    const acts = r.acts;
    const interesting = acts.length || r.plan.review.length || r.plan.skip || r.plan.blocked.length;
    if (!interesting) continue;
    console.log(`## ${r.slug}`);
    if (r.plan.skip) console.log(`   ${C.y('skip')} ${r.plan.skip}`);
    for (const b of r.plan.blocked) console.log(`   ${C.r('BLOCKED')} ${b.path} — ${b.reason}`);
    for (const a of acts) {
      const tag =
        a.action === 'push'
          ? C.g('push')
          : a.action === 'hold'
            ? C.y('hold')
            : a.action === 'gitignore-check'
              ? C.d('would-ignore')
              : C.g(a.action);
      console.log(`   ${tag} ${a.detail}`);
    }
    for (const v of r.plan.review) console.log(`   ${C.y('review')} ${v.path} — ${v.reason}`);
    for (const e of r.errors || []) console.log(`   ${C.r('error')} ${e}`);
    console.log('');
  }

  if (rep.unregistered.length)
    console.log(
      `${C.y('unregistered')} ${rep.unregistered.join(', ')} — directories under sites/ that are NOT submodules; ` +
        `git commands inside them silently operate on the monorepo.\n`
    );

  const bad = rep.blocked.length + rep.errors.length;
  console.log(
    `summary: ${rep.dirty.length} repo(s) not clean · ${rep.reviewCount} review item(s) · ` +
      `${rep.blocked.length} blocked · ${rep.errors.length} error(s)`
  );
  for (const e of rep.errors) console.log(`  ${C.r('error')} ${e}`);
  process.exitCode = bad || rep.reviewCount || rep.dirty.length ? 1 : 0;
}

function showQueue() {
  const items = queue.open();
  if (JSON_OUT) return console.log(JSON.stringify(items, null, 2));
  if (!items.length) return console.log('review queue is empty.');
  console.log(`${items.length} open review item(s):\n`);
  for (const i of items)
    console.log(
      `  ${i.slug.padEnd(24)} ${i.path}\n      ${C.d(i.reason)}  ${C.d(`first seen ${i.first_seen}`)}`
    );
  console.log(
    `\nresolve with:\n  fleet-git resolve --slug <slug> --path <path> --action ignore|commit|always-ignore|always-commit|drop`
  );
}

async function resolve() {
  const slug = val('slug');
  const p = val('path');
  const action = val('action');
  if (!slug || !p || !action) {
    console.error('resolve needs --slug, --path and --action');
    process.exit(2);
  }
  const { repos } = await discover(ROOT);
  const repo = repos.find(r => r.slug === slug);
  if (!repo) {
    console.error(`unknown repo: ${slug}`);
    process.exit(2);
  }

  if (action === 'always-ignore' || action === 'always-commit') {
    const glob = val('glob') || p;
    const id =
      val('id') ||
      `${action === 'always-ignore' ? 'ignore' : 'commit'}-${glob
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase()}`;
    const rule =
      action === 'always-ignore'
        ? {
            id,
            action: 'ignore',
            scope: flag('fleet') ? 'fleet' : [slug],
            match: [glob],
            untrack: flag('untrack'),
            reason: val('reason') || 'operator decision',
          }
        : {
            id,
            action: 'commit',
            scope: flag('fleet') ? 'fleet' : [slug],
            group: val('group') || 'ops',
            message: val('message') || 'chore(ops): sync ops state',
            match: [glob],
            reason: val('reason') || 'operator decision',
          };
    addRule(rule);
    console.log(
      `policy rule added: ${id} (${rule.action}, scope ${flag('fleet') ? 'fleet' : slug}) → ${glob}`
    );
  }

  if (action === 'ignore' || action === 'always-ignore') {
    gitignore.appendLocal(repo.dir, p);
    const tracked = await git(repo.dir, ['ls-files', '--error-unmatch', '--', p]);
    if (tracked.ok) await git(repo.dir, ['rm', '--cached', '-r', '--quiet', '--', p]);
    await git(repo.dir, ['add', '--', '.gitignore']);
    await git(repo.dir, ['commit', '-m', `chore(git-hygiene): ignore ${p}`]);
    console.log(`ignored ${p} in ${slug}`);
  } else if (action === 'commit' || action === 'always-commit') {
    const msg = val('message') || `chore(ops): sync ${p}`;
    await git(repo.dir, ['add', '--', p]);
    const c = await git(repo.dir, ['commit', '-m', msg, '--', p]);
    if (!c.ok && !/nothing to commit/i.test(c.out + c.err)) {
      console.error((c.err || c.out).trim());
      process.exit(1);
    }
    console.log(`committed ${p} in ${slug}`);
  } else if (action !== 'drop' && action !== 'always-ignore' && action !== 'always-commit') {
    console.error(`unknown action: ${action}`);
    process.exit(2);
  }
  queue.remove(slug, p);
  console.log('queue item resolved.');
}

async function ignoreSync() {
  const apply = flag('apply') && !flag('dry-run');
  const policy = loadPolicy();
  const { repos } = await discover(ROOT);
  let changed = 0;
  for (const r of repos) {
    if (r.parent) continue;
    if (only && !only.includes(r.slug)) continue;
    const res = gitignore.sync(r.dir, policy.ignoreBlock, { write: apply });
    if (res.changed) {
      changed++;
      console.log(`${apply ? 'updated' : 'would update'} ${r.slug}/.gitignore`);
    }
  }
  console.log(
    `${changed} repo(s) ${apply ? 'updated' : 'need updating'}${apply ? '' : ' (re-run with --apply)'}`
  );
}

main().catch(e => {
  console.error(e.stack || String(e));
  process.exit(1);
});
