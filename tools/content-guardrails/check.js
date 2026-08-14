#!/usr/bin/env node
'use strict';

// Guardrail check run from the shared pre-commit hook (tools/git-hooks/pre-commit)
// against the CURRENTLY STAGED diff of whatever repo it's invoked from — the
// domains superproject, or any sites/<site> submodule (host or in-container,
// via the .monorepo-tools mount).
//
// Exit 0  = clean, commit proceeds.
// Exit 1  = blocked-list hit, or a warn-list hit the classifier flagged.
//           Commit is rejected; nothing here EVER auto-rewrites content.
//
// Usage: node check.js [--repo-root <path>]  (defaults to `git rev-parse --show-toplevel`)

const path = require('node:path');
const lib = require('./lib');

async function gitTop(cwd) {
  const r = await lib.sh('git', ['rev-parse', '--show-toplevel'], { cwd });
  return r.stdout.trim() || cwd;
}

// The guardrail tool's own config/docs necessarily NAME the protected terms
// to define them — that's not a leak, it's the tool documenting itself.
// Exclude its own directory from the scan (git pathspec magic exclude).
const EXEMPT_PATHSPECS = [':(exclude,glob)tools/content-guardrails/**'];

async function stagedDiff(cwd) {
  const r = await lib.sh(
    'git',
    ['diff', '--cached', '--diff-filter=ACMR', '-U0', '--', '.', ...EXEMPT_PATHSPECS],
    { cwd }
  );
  return r.stdout;
}

// Where to find the SLACK_BOT_TOKEN .env. On the host, __dirname's parent's
// parent is the real domains root (tools/content-guardrails/../.. = domains/).
// In-container, this tool is reached via the .monorepo-tools mirror of tools/,
// so that same walk-up lands on the site root (/work), not the domains root —
// but every site mounts the domains .env there as .env.shared (see every
// site's docker-compose.yml comment "Shared CF / affiliate creds"). Try both.

async function main() {
  const argRootIdx = process.argv.indexOf('--repo-root');
  const cwd = argRootIdx !== -1 ? process.argv[argRootIdx + 1] : process.cwd();

  const repoRoot = await gitTop(cwd);
  const repoSlug = path.basename(repoRoot);
  const diff = await stagedDiff(repoRoot);
  if (!diff.trim()) return 0; // nothing staged (e.g. hook fired with an empty commit)

  const added = lib.addedLinesFromDiff(diff);
  const cfg = lib.loadConfig();
  const { blocked, warn } = lib.effectiveLists(cfg, repoSlug);

  const blockedHits = lib.findMatches(added, blocked);
  if (blockedHits.length) {
    for (const hit of blockedHits) {
      const record = {
        ts: new Date().toISOString(),
        repo: repoSlug,
        kind: 'blocked',
        term: hit.term,
        lineNo: hit.lineNo,
        line: hit.line,
      };
      lib.appendLog(record);
      console.error(
        `GUARDRAIL ERROR: blocked term "${hit.term}" found in staged changes ` +
          `(${repoSlug}, line ${hit.lineNo}): ${hit.line.trim()}`
      );
      await lib.postSlackAlert(
        repoRoot,
        `🚫 *Guardrail BLOCK* — \`${repoSlug}\` commit rejected: blocked term "${hit.term}" ` +
          `found in staged content.\n>${hit.line.trim().slice(0, 200)}`
      );
    }
    // Blocked-list hits are NEVER overridable, by anyone, regardless of env vars.
    console.error('\nCommit rejected. Rewrite the flagged content — this list has no override.');
    return 'blocked';
  }

  const warnHits = lib.findMatches(added, warn);
  let anyFlagged = false;
  for (const hit of warnHits) {
    const verdict = await lib.classifyWarnHit(hit.term, hit.line);
    const record = {
      ts: new Date().toISOString(),
      repo: repoSlug,
      kind: 'warn',
      term: hit.term,
      lineNo: hit.lineNo,
      line: hit.line,
      flagged: verdict.flagged,
      reason: verdict.reason,
    };
    lib.appendLog(record);
    if (verdict.flagged) {
      anyFlagged = true;
      console.error(
        `GUARDRAIL ERROR: warn term "${hit.term}" in staged changes ` +
          `(${repoSlug}, line ${hit.lineNo}) flagged by context check — ${verdict.reason}`
      );
      console.error(`  > ${hit.line.trim()}`);
      await lib.postSlackAlert(
        repoRoot,
        `⚠️ *Guardrail WARN-FLAG* — \`${repoSlug}\` commit rejected: "${hit.term}" flagged in context.\n` +
          `>${hit.line.trim().slice(0, 200)}\nReason: ${verdict.reason}`
      );
    } else {
      console.error(
        `GUARDRAIL: warn term "${hit.term}" matched but cleared by context check ` +
          `(${repoSlug}, line ${hit.lineNo}) — ${verdict.reason || 'unrelated context'}`
      );
    }
  }

  if (anyFlagged) {
    if (process.env.HUMAN_ALLOW_WARN === '1') {
      console.error(
        '\nHUMAN_ALLOW_WARN=1 set — warn-list flag overridden by explicit human action. Commit proceeds.'
      );
      return 'clean';
    }
    console.error(
      '\nCommit rejected. Rewrite the flagged content, or if this is a false ' +
        'positive a human (not the agent) must set HUMAN_ALLOW_WARN=1 to override.'
    );
    return 'warn';
  }

  return 'clean';
}

main()
  .then(result => {
    process.exit(result === 'clean' ? 0 : 1);
  })
  .catch(err => {
    console.error('GUARDRAIL ERROR: check crashed — failing closed (commit blocked).', err);
    process.exit(1);
  });
