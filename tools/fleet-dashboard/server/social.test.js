'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// social.js resolves its store path at require-time, so point it at a temp dir
// before the module loads.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-social-'));
process.env.FD_SOCIAL_DIR = TMP;
const social = require('./social');

function fresh() {
  for (const f of fs.readdirSync(TMP)) fs.rmSync(path.join(TMP, f));
  social._reset();
}

test('upsert writes an account and lands it in the snapshot', () => {
  fresh();
  const a = social.upsertAccount({ site: 'x.com', platform: 'bluesky', handle: 'x' }, 'test');
  assert.equal(a.status, 'not_started');
  assert.equal(a.scope, 'brand');
  assert.equal(social.snapshot([]).accounts.length, 1);
});

test('upsert is idempotent on the (site, platform, scope, persona) slot', () => {
  fresh();
  const a = social.upsertAccount({ site: 'x.com', platform: 'bluesky', status: 'pending' });
  const b = social.upsertAccount({
    site: 'x.com',
    platform: 'bluesky',
    status: 'active',
    handle: 'x.bsky.social',
  });
  assert.equal(a.id, b.id);
  assert.equal(b.status, 'active');
  assert.equal(b.handle, 'x.bsky.social');
  assert.equal(social.listAccounts().length, 1);
});

test('a suspension is recorded as a status event with its note and asks for reprovisioning', () => {
  fresh();
  const a = social.upsertAccount({ site: 'x.com', platform: 'instagram', status: 'active' });
  const after = social.setStatus(a.id, 'suspended', 'closed for spam 2026-08-15', 'jesse');
  assert.equal(after.needsAttention, true);
  assert.equal(after.action, 'reprovision');
  const ev = social.readEvents({ limit: 5 })[0];
  assert.equal(ev.kind, 'account.status');
  assert.equal(ev.from, 'active');
  assert.equal(ev.to, 'suspended');
  assert.equal(ev.actor, 'jesse');
  assert.match(ev.note, /spam/);
});

test('worklist surfaces broken accounts and never-attempted brand platforms', () => {
  fresh();
  const a = social.upsertAccount({ site: 'a.com', platform: 'instagram', status: 'active' });
  social.setStatus(a.id, 'closed', 'banned');
  social.upsertAccount({ site: 'a.com', platform: 'bluesky', status: 'active' });
  const w = social.worklist(['a.com', 'b.com']);
  assert.deepEqual(
    w.attention.map(r => [r.site, r.platform, r.action]),
    [['a.com', 'instagram', 'reprovision']]
  );
  // a.com already has bluesky; pinterest is missing on both sites.
  assert.deepEqual(w.missing.map(r => `${r.site}/${r.platform}`).sort(), [
    'a.com/pinterest',
    'b.com/bluesky',
    'b.com/pinterest',
  ]);
});

test('non-active site buckets drop out of the provisioning worklist', () => {
  fresh();
  social.setSiteMeta('adult.com', { category: 'adult_excluded', note: 'ToS risk' });
  const w = social.worklist(['adult.com']);
  assert.equal(w.missing.length, 0);
});

test('sites are the union of on-disk discovery and the registry', () => {
  fresh();
  social.upsertAccount({ site: 'registry-only.com', platform: 'bluesky' });
  assert.deepEqual(social.siteList(['on-disk.com']), ['on-disk.com', 'registry-only.com']);
});

test('persona-scoped accounts require a real persona', () => {
  fresh();
  assert.throws(
    () => social.upsertAccount({ site: 'a.com', platform: 'bluesky', scope: 'persona' }),
    /personaId/
  );
  assert.throws(
    () =>
      social.upsertAccount({
        site: 'a.com',
        platform: 'bluesky',
        scope: 'persona',
        personaId: 'per_nope',
      }),
    /unknown personaId/
  );
  const p = social.createPersona({ site: 'a.com', name: 'Sam Reyes', beat: 'Defense' });
  const acc = social.upsertAccount({
    site: 'a.com',
    platform: 'bluesky',
    scope: 'persona',
    personaId: p.id,
    status: 'active',
  });
  assert.equal(acc.personaName, 'Sam Reyes');
});

test('a persona with accounts cannot be deleted out from under them', () => {
  fresh();
  const p = social.createPersona({ site: 'a.com', name: 'Sam' });
  social.upsertAccount({ site: 'a.com', platform: 'bluesky', scope: 'persona', personaId: p.id });
  assert.throws(() => social.deletePersona(p.id), /account row/);
});

test('bad input is rejected with a 400', () => {
  fresh();
  const bad = fn => {
    try {
      fn();
      return null;
    } catch (e) {
      return e.httpStatus;
    }
  };
  assert.equal(
    bad(() => social.upsertAccount({ site: 'a.com', platform: 'bluesky', status: 'nonsense' })),
    400
  );
  assert.equal(
    bad(() => social.upsertAccount({ platform: 'bluesky' })),
    400
  );
  assert.equal(
    bad(() =>
      social.upsertAccount({
        site: 'a.com',
        platform: 'bluesky',
        profileUrl: 'javascript:alert(1)',
      })
    ),
    400
  );
  assert.equal(
    bad(() => social.setSiteMeta('a.com', { category: 'whatever' })),
    400
  );
});

test('profile URLs are derived from the platform template', () => {
  fresh();
  const a = social.upsertAccount({
    site: 'a.com',
    platform: 'bluesky',
    handle: 'a.bsky.social',
    status: 'active',
  });
  assert.equal(a.profileUrl, 'https://bsky.app/profile/a.bsky.social');
});

test('a platform added at runtime shows up in the catalog', () => {
  fresh();
  social.addPlatform({
    key: 'tumblr',
    label: 'Tumblr',
    urlTemplate: 'https://{handle}.tumblr.com',
  });
  assert.ok(social.snapshot([]).platforms.some(p => p.key === 'tumblr'));
  assert.throws(() => social.addPlatform({ key: 'bluesky' }), /already exists/);
});

test('filters compose: needsAttention + search', () => {
  fresh();
  const a = social.upsertAccount({ site: 'a.com', platform: 'instagram', status: 'active' });
  social.setStatus(a.id, 'suspended', 'spam ban');
  social.upsertAccount({ site: 'b.com', platform: 'bluesky', status: 'active' });
  assert.equal(social.listAccounts({ needsAttention: true }).length, 1);
  assert.equal(social.listAccounts({ q: 'spam' }).length, 1);
  assert.equal(social.listAccounts({ q: 'spam', site: 'b.com' }).length, 0);
  assert.equal(social.listAccounts({ live: true }).length, 1);
});

test('a custom platform cannot smuggle a javascript: URL template into profile links', () => {
  fresh();
  assert.throws(
    () => social.addPlatform({ key: 'evil', urlTemplate: 'javascript:alert(1)//{handle}' }),
    /http\(s\)/
  );
  assert.doesNotThrow(() =>
    social.addPlatform({ key: 'good', urlTemplate: 'https://example.com/{handle}' })
  );
});
