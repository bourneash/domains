'use strict';

const { execFile } = require('node:child_process');

// ALLOWLIST, not a denylist. The cron wrapper sources the fleet `.env` — CF
// tokens, the Slack bot token, affiliate credentials — into its own process.
// A denylist would hand all of that to every `git` child in 49 repos, and git
// honours per-repo `.git/config` (`core.sshCommand`, `credential.helper`,
// aliases), so a single compromised submodule becomes a token-exfiltration
// primitive. Pass only what git actually needs.
//
// Repo-LOCATION vars (GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE...) are absent by
// construction here: they take precedence over `-C <cwd>` in real git, so
// inheriting them from a git hook would silently redirect every call at the
// WRONG repo. `-C` stays the only thing that chooses the repo.
const GIT_ENV_ALLOW = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'SSH_AUTH_SOCK',
  'GIT_SSH_COMMAND',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_TERMINAL_PROMPT',
];
const CLEAN_GIT_ENV = Object.fromEntries(
  GIT_ENV_ALLOW.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])
);
// Never let git stop for an interactive credential prompt in a cron container.
CLEAN_GIT_ENV.GIT_TERMINAL_PROMPT = '0';

// `indexFile` is the ONE sanctioned way to point git at a non-default index:
// an explicit, per-call scratch index (see lib/scratchindex.js), never an
// inherited ambient GIT_INDEX_FILE.
function git(cwd, args, { timeout = 120000, indexFile = null } = {}) {
  const env = indexFile ? { ...CLEAN_GIT_ENV, GIT_INDEX_FILE: indexFile } : CLEAN_GIT_ENV;
  return new Promise(resolve => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout, maxBuffer: 64 * 1024 * 1024, env },
      (err, stdout, stderr) =>
        resolve({
          ok: !err,
          out: stdout || '',
          err: stderr || (err && err.message) || '',
          code: err ? (err.code ?? 1) : 0,
        })
    );
  });
}

// Parse `git status --porcelain=v1 --branch -z`.
function parsePorcelain(out) {
  const parts = out.split('\0').filter(Boolean);
  let branch = null,
    upstream = null,
    ahead = 0,
    behind = 0,
    detached = false;
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (line.startsWith('## ')) {
      const body = line.slice(3);
      if (body.startsWith('No commits yet on ')) {
        branch = body.slice('No commits yet on '.length).trim() || null;
        continue;
      }
      if (body.startsWith('HEAD (no branch)')) {
        detached = true;
        continue;
      }
      const m = body.match(/^([^.\s]+(?:\.[^.\s]+)*)(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?/);
      if (m) {
        branch = m[1];
        upstream = m[2] || null;
        if (m[3]) {
          const a = m[3].match(/ahead (\d+)/);
          if (a) ahead = parseInt(a[1], 10);
          const b = m[3].match(/behind (\d+)/);
          if (b) behind = parseInt(b[1], 10);
        }
      }
      continue;
    }
    const x = line[0],
      y = line[1];
    const p = line.slice(3);
    let kind;
    if (x === '?' && y === '?') kind = 'untracked';
    else if (x === '!' && y === '!') kind = 'ignored';
    else if (x === 'D' || y === 'D') kind = 'deleted';
    else if (x !== ' ') kind = 'staged';
    else kind = 'modified';
    // A rename/copy carries a SECOND NUL-separated path: the original. It must
    // still be classified — `git mv .env ops/config.txt` otherwise presents the
    // classifier with only `ops/config.txt`, which matches an innocuous commit
    // rule while the blob is the credential file.
    let renamedFrom = null;
    if (x === 'R' || x === 'C') {
      renamedFrom = parts[i + 1] || null;
      i += 1;
    }
    if (kind !== 'ignored') {
      files.push({ code: x + y, kind, path: p, staged: x !== ' ' && x !== '?' });
      if (renamedFrom)
        files.push({ code: x + y, kind: 'renamed-from', path: renamedFrom, staged: true });
    }
  }
  return { branch, upstream, ahead, behind, detached, files };
}

async function status(cwd) {
  const r = await git(cwd, ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '-z']);
  // A non-zero exit with PARTIAL stdout is exactly what execFile produces on a
  // maxBuffer overflow or a timeout kill. Parsing that partial output yields a
  // silently TRUNCATED file list — which reads as "clean" to the pointer-bump
  // check and to the board. Any failure is an unusable status, full stop.
  if (!r.ok)
    return {
      isRepo: false,
      error: (r.err || '').trim() || `git status failed (exit ${r.code})`,
      files: [],
    };
  return { isRepo: true, ...parsePorcelain(r.out) };
}

// Committer identity for a repo that has none of its own. Every site repo in
// this fleet sets a local user.name/user.email (its own bot desk), but the
// containers that run the sweep have no ~/.gitconfig, so a repo that never set
// one fails with "Author identity unknown". Resolved per repo and applied via
// `-c` ONLY when git genuinely cannot resolve an identity — `-c` outranks repo
// config, so applying it unconditionally would rewrite every site's bot author.
async function identityArgs(cwd) {
  const r = await git(cwd, ['var', 'GIT_COMMITTER_IDENT']);
  if (r.ok && r.out.trim()) return [];
  return [
    '-c',
    `user.name=${process.env.FLEET_GIT_IDENTITY_NAME || 'Fleet Git Hygiene'}`,
    '-c',
    `user.email=${process.env.FLEET_GIT_IDENTITY_EMAIL || 'ops@fleet.local'}`,
  ];
}

module.exports = { git, status, parsePorcelain, identityArgs, GIT_ENV_ALLOW, CLEAN_GIT_ENV };
