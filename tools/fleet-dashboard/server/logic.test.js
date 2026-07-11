'use strict';

// Unit tests for the pure logic touched by the 2026-07 audit fixes. No docker /
// network needed — these exercise parsing, path guards, bounded tailing, the
// authoritative cron-container resolver, and the task soft-delete.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const parse = require('./cron/parse');
const roles = require('./roles');
const git = require('./git');
const tasks = require('./tasks');
const { tailFile } = require('./cron/runinfo');
const discovery = require('./cron/discovery');

function tmpdir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/* ---- B8/F9: unified role parser ---- */
test('roleFromCommand recognizes worker and dedicated-script roles', () => {
  assert.deepEqual(parse.roleFromCommand('cd /work && bash ops/scripts/run-worker.sh engineer'), { role: 'engineer', worker: true });
  assert.deepEqual(parse.roleFromCommand('bash ops/scripts/run-deployer.sh'), { role: 'deployer', worker: false });
  // run-worker.sh / run-role.sh are the harness, not a role name.
  assert.deepEqual(parse.roleFromCommand('bash run-worker.sh'), { role: null, worker: false });
  assert.deepEqual(parse.roleFromCommand('echo nothing here'), { role: null, worker: false });
});

test('roles.parseRoles and cron parseCrontab agree on role recognition', () => {
  const crontab = [
    '*/6 * * * * cd /work && bash ops/scripts/run-worker.sh engineer',
    '0 7 * * * bash ops/scripts/run-deployer.sh',
    '# 0 8 * * * bash ops/scripts/run-worker.sh planner',   // commented → ignored by parseRoles
  ].join('\n');
  const viaRoles = roles.parseRoles(crontab).map((r) => r.role).sort();
  assert.deepEqual(viaRoles, ['deployer', 'engineer']);
  const viaCron = parse.parseCrontab(crontab).entries.filter((e) => !e.commented && e.role).map((e) => e.role).sort();
  assert.deepEqual(viaCron, ['deployer', 'engineer']);
});

/* ---- B9: safeRel rejects a `..` component but allows `..` in a name ---- */
test('safeRel guards traversal without over-rejecting', () => {
  assert.equal(git.safeRel('ops/notes..draft.md'), 'ops/notes..draft.md');   // B9: dots in a name are fine
  assert.equal(git.safeRel('src/app.js'), 'src/app.js');
  assert.equal(git.safeRel('../etc/passwd'), null);
  assert.equal(git.safeRel('a/../../b'), null);
  assert.equal(git.safeRel('/abs/path'), null);
  assert.equal(git.safeRel('-oProxyCommand'), null);
  assert.equal(git.safeRel('bad\nname'), null);
});

/* ---- B10: parsePorcelain branch header edge cases ---- */
test('parsePorcelain handles normal, fresh, and detached headers', () => {
  const z = (s) => s.replace(/\n/g, '\0');
  const normal = git.parsePorcelain(z('## main...origin/main [ahead 2, behind 1]\n M src/a.js\n'));
  assert.equal(normal.branch, 'main');
  assert.equal(normal.ahead, 2);
  assert.equal(normal.behind, 1);
  assert.equal(normal.detached, false);

  const fresh = git.parsePorcelain(z('## No commits yet on main\n'));
  assert.equal(fresh.branch, 'main');
  assert.equal(fresh.detached, false);

  const detached = git.parsePorcelain(z('## HEAD (no branch)\n'));
  assert.equal(detached.branch, null);
  assert.equal(detached.detached, true);
});

/* ---- sync-state color classification ---- */
test('computeSyncState classifies upstream sync correctly', () => {
  assert.equal(git.computeSyncState({ ahead: 0, behind: 0, upstream: 'origin/main' }), 'synced');
  assert.equal(git.computeSyncState({ ahead: 3, behind: 0, upstream: 'origin/main' }), 'ahead');
  assert.equal(git.computeSyncState({ ahead: 0, behind: 2, upstream: 'origin/main' }), 'diverged-behind');
  assert.equal(git.computeSyncState({ ahead: 1, behind: 2, upstream: 'origin/main' }), 'diverged-behind');
  assert.equal(git.computeSyncState({ ahead: 0, behind: 0, upstream: null }), 'no-upstream');
});

/* ---- repo-link: remote URL -> browsable web URL ---- */
test('remoteToWebUrl converts scp-syntax, ssh://, and http(s) remotes; rejects unknown shapes', () => {
  assert.equal(git.remoteToWebUrl('git@github-bourneash:bourneash/xxxtea.com.git'), 'https://github.com/bourneash/xxxtea.com');
  assert.equal(git.remoteToWebUrl('git@github.com:bourneash/americastrikes.git'), 'https://github.com/bourneash/americastrikes');
  assert.equal(git.remoteToWebUrl('ssh://git@github-bourneash/bourneash/saveusfarms.com.git'), 'https://github.com/bourneash/saveusfarms.com');
  assert.equal(git.remoteToWebUrl('https://github.com/bourneash/reviewtattoo.git'), 'https://github.com/bourneash/reviewtattoo');
  assert.equal(git.remoteToWebUrl('git@gitlab.example.com:team/repo.git'), 'https://gitlab.example.com/team/repo');
  assert.equal(git.remoteToWebUrl(''), null);
  assert.equal(git.remoteToWebUrl(null), null);
  assert.equal(git.remoteToWebUrl('not a url'), null);
});

/* ---- security: never leak embedded HTTPS credentials into the rendered link ---- */
test('remoteToWebUrl strips embedded credentials from an http(s) remote', () => {
  assert.equal(
    git.remoteToWebUrl('https://x-access-token:gho_secrettoken123@github.com/bourneash/sinderella.git'),
    'https://github.com/bourneash/sinderella');
  assert.equal(
    git.remoteToWebUrl('https://user:pass@example.com/team/repo.git'),
    'https://example.com/team/repo');
});

/* ---- B7: bounded tail returns the last N lines ---- */
test('tailFile returns the last N lines without reading the whole file', () => {
  const dir = tmpdir('fd-tail-');
  const f = path.join(dir, 'log.txt');
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const out = tailFile(f, 3).split('\n');
  assert.deepEqual(out, ['line 4997', 'line 4998', 'line 4999']);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---- B1/F10: authoritative cron-container name from compose ---- */
test('siteCronContainer prefers compose container_name, falls back to stem', () => {
  const root = tmpdir('fd-disc-');
  const mk = (slug, compose) => {
    fs.mkdirSync(path.join(root, 'sites', slug), { recursive: true });
    if (compose != null) fs.writeFileSync(path.join(root, 'sites', slug, 'docker-compose.yml'), compose);
  };
  mk('mynewgm.info', 'services:\n  cron:\n    container_name: mynewgm-info-cron\n');
  mk('mynewgm.com', 'services:\n  cron:\n    container_name: mynewgm-com-cron\n');
  mk('bare.com', null);   // no compose → stem fallback
  assert.equal(discovery.siteCronContainer(root, 'mynewgm.info'), 'mynewgm-info-cron');
  assert.equal(discovery.siteCronContainer(root, 'mynewgm.com'), 'mynewgm-com-cron');
  assert.equal(discovery.siteCronContainer(root, 'bare.com'), 'bare-cron');
  fs.rmSync(root, { recursive: true, force: true });
});

/* ---- F8: task delete is a soft delete into .trash ---- */
test('tasks.remove moves the file to .trash instead of unlinking', () => {
  const root = tmpdir('fd-tasks-');
  const col = path.join(root, 'sites', 'x.com', 'ops', 'tasks', 'backlog');
  fs.mkdirSync(col, { recursive: true });
  const file = '2026-07-06-thing.md';
  fs.writeFileSync(path.join(col, file), '---\ntitle: Thing\n---\nbody\n');
  const r = tasks.remove(root, 'x.com', 'backlog', file);
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(col, file)), false);                       // gone from the column
  const trash = path.join(root, 'sites', 'x.com', 'ops', 'tasks', '.trash');
  assert.ok(fs.existsSync(path.join(trash, `backlog__${file}`)));                 // recoverable in .trash
  fs.rmSync(root, { recursive: true, force: true });
});

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

test('parseRemoteOnlyBranches excludes the origin symref and branches that exist locally', () => {
  const remoteOut = 'origin\norigin/main\norigin/feature/foo\norigin/stray-remote-branch\n';
  const localNames = ['main', 'feature/foo'];
  assert.deepEqual(git.parseRemoteOnlyBranches(remoteOut, localNames), [{ name: 'origin/stray-remote-branch' }]);
});

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

test('stashIndex validates and normalizes stash index input', () => {
  assert.equal(git.stashIndex('0'), 0);
  assert.equal(git.stashIndex('3'), 3);
  assert.equal(git.stashIndex(' 3 '), 3);   // tolerates surrounding whitespace
  assert.equal(git.stashIndex('abc'), null);
  assert.equal(git.stashIndex('-1'), null);
  assert.equal(git.stashIndex('1.5'), null);
  assert.equal(git.stashIndex('3abc'), null);
  assert.equal(git.stashIndex(''), null);
});
