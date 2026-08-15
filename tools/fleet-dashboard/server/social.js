'use strict';

// Fleet social registry — the tracked, editable replacement for the old
// hand-maintained `tools/social-setup/FLEET_SOCIAL_MAP.md`.
//
// Three record types, one JSON store:
//   siteMeta  — per-site bucket (active / positioning_tbd / adult_excluded / retired)
//               so the "correctly excluded" lists from the markdown survive.
//   personas  — named bylines per site. A persona exists independently of any
//               account (0daynews has 4 bylines and zero accounts), which is
//               exactly the gap the old map tracked in prose.
//   accounts  — one row per (site, platform, brand|persona). Status is the
//               load-bearing field: `suspended`/`closed` is how an Instagram
//               spam-ban gets communicated back to the signup automation
//               without a human writing a markdown note nobody reads.
//
// Every mutation appends to an events JSONL so "when did this break, and what
// did we say about it" is answerable. That log is the audit trail the markdown
// never had.
//
// Storage lives under tools/social-setup/registry/ (NOT fleet-dashboard/data/,
// which is gitignored cache): this is authoritative fleet state and must be in
// git, and it sits next to the signup scripts that consume it. Same convention
// as tools/product-feed/registry/.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = process.env.FD_DOMAINS_ROOT || path.join(__dirname, '..', '..', '..');
const REGISTRY_DIR =
  process.env.FD_SOCIAL_DIR || path.join(ROOT, 'tools', 'social-setup', 'registry');
const STORE_FILE = path.join(REGISTRY_DIR, 'social.json');
const EVENTS_FILE = path.join(REGISTRY_DIR, 'social-events.jsonl');

const MAX_TEXT = 2000;
const MAX_SHORT = 200;
const MAX_EVENTS = 5000;

function httpErr(status, msg) {
  const e = new Error(msg);
  e.httpStatus = status;
  return e;
}

// ---- catalogs ------------------------------------------------------------
// Built-in platforms. The store may append more (POST /api/social/platforms)
// and any platform key referenced by an account is surfaced even if unknown —
// so adding a platform never requires a code change or a redeploy.
const BUILTIN_PLATFORMS = [
  { key: 'bluesky', label: 'Bluesky', urlTemplate: 'https://bsky.app/profile/{handle}' },
  { key: 'pinterest', label: 'Pinterest', urlTemplate: 'https://pinterest.com/{handle}' },
  { key: 'instagram', label: 'Instagram', urlTemplate: 'https://instagram.com/{handle}' },
  { key: 'x', label: 'X', urlTemplate: 'https://x.com/{handle}' },
  { key: 'reddit', label: 'Reddit', urlTemplate: 'https://reddit.com/user/{handle}' },
  { key: 'tiktok', label: 'TikTok', urlTemplate: 'https://tiktok.com/@{handle}' },
  { key: 'youtube', label: 'YouTube', urlTemplate: 'https://youtube.com/@{handle}' },
  { key: 'facebook', label: 'Facebook', urlTemplate: 'https://facebook.com/{handle}' },
  { key: 'linkedin', label: 'LinkedIn', urlTemplate: 'https://linkedin.com/company/{handle}' },
  { key: 'threads', label: 'Threads', urlTemplate: 'https://threads.net/@{handle}' },
  { key: 'mastodon', label: 'Mastodon', urlTemplate: '' },
];

// `tone` drives the UI colour; `live` means the account is usable for posting;
// `attention` means a human/automation needs to do something about it.
const STATUSES = [
  { key: 'active', label: 'Active', tone: 'green', live: true, attention: false },
  {
    key: 'pending',
    label: 'Pending',
    tone: 'blue',
    live: false,
    attention: false,
    describe: 'Signup started — awaiting verification/onboarding',
  },
  {
    key: 'stuck',
    label: 'Stuck',
    tone: 'yellow',
    live: false,
    attention: true,
    describe: 'Partially created, blocked on a known platform bug',
  },
  {
    key: 'blocked',
    label: 'Blocked',
    tone: 'orange',
    live: false,
    attention: true,
    describe: 'Platform-level blocker (rate limit, shadow restriction)',
  },
  {
    key: 'suspended',
    label: 'Suspended',
    tone: 'red',
    live: false,
    attention: true,
    describe: 'Platform suspended/banned the account — needs re-provisioning',
  },
  {
    key: 'closed',
    label: 'Closed',
    tone: 'red',
    live: false,
    attention: true,
    describe: 'Account gone (deleted by us or by the platform)',
  },
  { key: 'not_started', label: 'Not started', tone: 'gray', live: false, attention: false },
  {
    key: 'excluded',
    label: 'Excluded',
    tone: 'gray',
    live: false,
    attention: false,
    describe: 'Deliberately not applicable for this site/persona',
  },
];
const STATUS_KEYS = new Set(STATUSES.map(s => s.key));
const ATTENTION_STATUSES = new Set(STATUSES.filter(s => s.attention).map(s => s.key));

const SITE_CATEGORIES = [
  { key: 'active', label: 'Active' },
  {
    key: 'positioning_tbd',
    label: 'Positioning TBD',
    describe: 'No brand brief yet — social deliberately not attempted',
  },
  {
    key: 'adult_excluded',
    label: 'Adult / excluded',
    describe: 'Explicit brand — mainstream-platform ToS risk',
  },
  { key: 'retired', label: 'Retired' },
];
const SITE_CATEGORY_KEYS = new Set(SITE_CATEGORIES.map(c => c.key));

const SCOPES = ['brand', 'persona'];

// What to do about an account, derived from status — this is the field the
// signup automation reads to decide whether to act.
function actionFor(status) {
  if (status === 'suspended' || status === 'closed') return 'reprovision';
  if (status === 'stuck' || status === 'blocked') return 'unblock';
  if (status === 'not_started') return 'provision';
  return null;
}

// ---- store I/O -----------------------------------------------------------
const EMPTY = {
  version: 1,
  updatedAt: null,
  platforms: [],
  siteMeta: {},
  personas: [],
  accounts: [],
};

let CACHE = null;

function load() {
  if (CACHE) return CACHE;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    CACHE = {
      ...EMPTY,
      ...raw,
      platforms: Array.isArray(raw.platforms) ? raw.platforms : [],
      personas: Array.isArray(raw.personas) ? raw.personas : [],
      accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
      siteMeta: raw.siteMeta && typeof raw.siteMeta === 'object' ? raw.siteMeta : {},
    };
  } catch {
    CACHE = JSON.parse(JSON.stringify(EMPTY));
  }
  return CACHE;
}

// The panel container runs as root but the repo is the host user's. Match the
// containing directory's ownership after writing so a host-side edit (or a
// `git checkout`) doesn't hit EACCES on a root-owned file.
function matchDirOwner(file) {
  try {
    const st = fs.statSync(path.dirname(file));
    if (process.getuid && process.getuid() === 0) fs.chownSync(file, st.uid, st.gid);
  } catch {
    /* best-effort */
  }
}

function save(store) {
  store.updatedAt = new Date().toISOString();
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  fs.renameSync(tmp, STORE_FILE); // atomic — never a half-written registry
  matchDirOwner(STORE_FILE);
  CACHE = store;
  return store;
}

function appendEvent(evt) {
  const row = { at: new Date().toISOString(), ...evt };
  try {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(row)}\n`);
    matchDirOwner(EVENTS_FILE);
  } catch {
    /* best-effort — never fail a mutation because the log is unwritable */
  }
  return row;
}

function readEvents({ limit = 100, site = null, accountId = null } = {}) {
  let lines;
  try {
    lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < Math.min(limit, MAX_EVENTS); i--) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (site && row.site !== site) continue;
    if (accountId && row.accountId !== accountId) continue;
    out.push(row);
  }
  return out;
}

// ---- validation ----------------------------------------------------------
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function str(v, field, { max = MAX_SHORT, required = false } = {}) {
  if (v == null) {
    if (required) throw httpErr(400, `${field} is required`);
    return '';
  }
  if (typeof v !== 'string') throw httpErr(400, `${field} must be a string`);
  const s = v.trim();
  if (required && !s) throw httpErr(400, `${field} is required`);
  if (s.length > max) throw httpErr(400, `${field} too long (max ${max})`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s))
    throw httpErr(400, `${field} contains control characters`);
  return s;
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function platformCatalog(store) {
  const seen = new Map();
  for (const p of BUILTIN_PLATFORMS) seen.set(p.key, { ...p, builtin: true });
  for (const p of store.platforms || []) {
    if (p && KEY_RE.test(String(p.key || ''))) {
      seen.set(p.key, {
        key: p.key,
        label: p.label || p.key,
        urlTemplate: p.urlTemplate || '',
        builtin: false,
      });
    }
  }
  // Any platform an account references but no catalog entry covers still shows up.
  for (const a of store.accounts) {
    if (!seen.has(a.platform))
      seen.set(a.platform, { key: a.platform, label: a.platform, urlTemplate: '', builtin: false });
  }
  return [...seen.values()];
}

function profileUrl(store, account) {
  if (account.profileUrl) return account.profileUrl;
  if (!account.handle) return '';
  const p = platformCatalog(store).find(x => x.key === account.platform);
  if (!p || !p.urlTemplate) return '';
  return p.urlTemplate.replace('{handle}', encodeURIComponent(account.handle).replace(/%40/g, '@'));
}

// ---- accounts ------------------------------------------------------------
function decorate(store, a) {
  const persona = a.personaId ? store.personas.find(p => p.id === a.personaId) : null;
  const st = STATUSES.find(s => s.key === a.status);
  return {
    ...a,
    personaName: persona ? persona.name : null,
    profileUrl: profileUrl(store, a),
    tone: st ? st.tone : 'gray',
    live: !!(st && st.live),
    needsAttention: ATTENTION_STATUSES.has(a.status),
    action: actionFor(a.status),
  };
}

function listAccounts(filter = {}) {
  const store = load();
  const q = (filter.q || '').trim().toLowerCase();
  return store.accounts
    .filter(a => {
      if (filter.site && a.site !== filter.site) return false;
      if (filter.platform && a.platform !== filter.platform) return false;
      if (filter.status && a.status !== filter.status) return false;
      if (filter.scope && a.scope !== filter.scope) return false;
      if (filter.personaId && a.personaId !== filter.personaId) return false;
      if (filter.needsAttention && !ATTENTION_STATUSES.has(a.status)) return false;
      if (filter.live && !(STATUSES.find(s => s.key === a.status) || {}).live) return false;
      if (q) {
        const persona = a.personaId
          ? (store.personas.find(p => p.id === a.personaId) || {}).name
          : '';
        const hay = [
          a.site,
          a.platform,
          a.handle,
          a.notes,
          a.statusNote,
          persona,
          (a.tags || []).join(' '),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .map(a => decorate(store, a))
    .sort(
      (x, y) =>
        x.site.localeCompare(y.site) ||
        x.platform.localeCompare(y.platform) ||
        String(x.personaName || '').localeCompare(String(y.personaName || ''))
    );
}

function getAccount(accountId) {
  const store = load();
  const a = store.accounts.find(x => x.id === accountId);
  if (!a) throw httpErr(404, 'account not found');
  return decorate(store, a);
}

function normalizeAccountInput(store, body, existing) {
  const b = body || {};
  const out = { ...(existing || {}) };

  if (!existing || b.site !== undefined) out.site = str(b.site, 'site', { required: !existing });
  if (!existing || b.platform !== undefined) {
    const p = str(b.platform, 'platform', { required: !existing }).toLowerCase();
    if (p && !KEY_RE.test(p)) throw httpErr(400, 'platform must be a short lowercase key');
    out.platform = p || out.platform;
  }
  if (b.scope !== undefined || !existing) {
    const sc = str(b.scope, 'scope') || 'brand';
    if (!SCOPES.includes(sc)) throw httpErr(400, `scope must be one of: ${SCOPES.join(', ')}`);
    out.scope = sc;
  }
  if (b.personaId !== undefined) {
    const pid = str(b.personaId, 'personaId');
    if (pid && !store.personas.some(p => p.id === pid)) throw httpErr(400, 'unknown personaId');
    out.personaId = pid || null;
  }
  if (out.personaId === undefined) out.personaId = null;
  if (out.scope === 'persona' && !out.personaId)
    throw httpErr(400, 'persona-scoped accounts need a personaId');
  if (out.scope === 'brand') out.personaId = null;

  if (b.status !== undefined || !existing) {
    const s = str(b.status, 'status') || 'not_started';
    if (!STATUS_KEYS.has(s))
      throw httpErr(400, `status must be one of: ${[...STATUS_KEYS].join(', ')}`);
    out.status = s;
  }
  if (b.handle !== undefined) out.handle = str(b.handle, 'handle');
  if (b.profileUrl !== undefined) {
    const u = str(b.profileUrl, 'profileUrl', { max: 500 });
    if (u && !/^https?:\/\//i.test(u)) throw httpErr(400, 'profileUrl must be http(s)');
    out.profileUrl = u;
  }
  if (b.statusNote !== undefined)
    out.statusNote = str(b.statusNote, 'statusNote', { max: MAX_TEXT });
  if (b.notes !== undefined) out.notes = str(b.notes, 'notes', { max: MAX_TEXT });
  if (b.credsInVault !== undefined) out.credsInVault = !!b.credsInVault;
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags)) throw httpErr(400, 'tags must be an array');
    out.tags = b.tags
      .map(t => str(t, 'tag', { max: 40 }))
      .filter(Boolean)
      .slice(0, 20);
  }
  if (b.lastPostedAt !== undefined) out.lastPostedAt = str(b.lastPostedAt, 'lastPostedAt');
  if (b.followers !== undefined) {
    if (b.followers !== null && !Number.isFinite(Number(b.followers)))
      throw httpErr(400, 'followers must be a number');
    out.followers = b.followers === null ? null : Number(b.followers);
  }

  out.handle = out.handle || '';
  out.profileUrl = out.profileUrl || '';
  out.statusNote = out.statusNote || '';
  out.notes = out.notes || '';
  out.tags = out.tags || [];
  out.credsInVault = !!out.credsInVault;
  out.followers = out.followers ?? null;
  out.lastPostedAt = out.lastPostedAt || null;
  return out;
}

function sameSlot(a, b) {
  return (
    a.site === b.site &&
    a.platform === b.platform &&
    a.scope === b.scope &&
    (a.personaId || null) === (b.personaId || null)
  );
}

// Upsert on the (site, platform, scope, persona) slot — so an automation can
// blind-POST a result without first checking whether the row already exists.
function upsertAccount(body, actor = 'api') {
  const store = load();
  const draft = normalizeAccountInput(store, body, null);
  const existing = store.accounts.find(a => sameSlot(a, draft));
  if (existing) return updateAccount(existing.id, body, actor);

  const now = new Date().toISOString();
  const rec = { id: id('acc'), ...draft, createdAt: now, updatedAt: now };
  store.accounts.push(rec);
  save(store);
  appendEvent({
    kind: 'account.created',
    accountId: rec.id,
    site: rec.site,
    platform: rec.platform,
    scope: rec.scope,
    personaId: rec.personaId,
    to: rec.status,
    note: rec.statusNote,
    actor,
  });
  return decorate(store, rec);
}

function updateAccount(accountId, body, actor = 'api') {
  const store = load();
  const i = store.accounts.findIndex(a => a.id === accountId);
  if (i === -1) throw httpErr(404, 'account not found');
  const before = store.accounts[i];
  const merged = normalizeAccountInput(store, body, before);
  const rec = {
    ...before,
    ...merged,
    id: before.id,
    createdAt: before.createdAt,
    updatedAt: new Date().toISOString(),
  };
  // Reject a slot collision created by moving an account onto an occupied slot.
  if (store.accounts.some(a => a.id !== rec.id && sameSlot(a, rec))) {
    throw httpErr(409, 'another account already occupies that site/platform/persona slot');
  }
  store.accounts[i] = rec;
  save(store);
  if (before.status !== rec.status) {
    appendEvent({
      kind: 'account.status',
      accountId: rec.id,
      site: rec.site,
      platform: rec.platform,
      scope: rec.scope,
      personaId: rec.personaId,
      from: before.status,
      to: rec.status,
      note: rec.statusNote,
      actor,
    });
  } else {
    appendEvent({
      kind: 'account.updated',
      accountId: rec.id,
      site: rec.site,
      platform: rec.platform,
      scope: rec.scope,
      personaId: rec.personaId,
      to: rec.status,
      actor,
    });
  }
  return decorate(store, rec);
}

function setStatus(accountId, status, note, actor = 'api') {
  const payload = { status };
  if (note !== undefined && note !== null) payload.statusNote = note;
  return updateAccount(accountId, payload, actor);
}

function deleteAccount(accountId, actor = 'api') {
  const store = load();
  const i = store.accounts.findIndex(a => a.id === accountId);
  if (i === -1) throw httpErr(404, 'account not found');
  const [gone] = store.accounts.splice(i, 1);
  save(store);
  appendEvent({
    kind: 'account.deleted',
    accountId: gone.id,
    site: gone.site,
    platform: gone.platform,
    scope: gone.scope,
    actor,
  });
  return { ok: true };
}

// ---- personas ------------------------------------------------------------
function listPersonas(site) {
  const store = load();
  return store.personas
    .filter(p => !site || p.site === site)
    .map(p => ({ ...p, accounts: store.accounts.filter(a => a.personaId === p.id).length }))
    .sort((a, b) => a.site.localeCompare(b.site) || a.name.localeCompare(b.name));
}

function createPersona(body, actor = 'api') {
  const store = load();
  const b = body || {};
  const rec = {
    id: id('per'),
    site: str(b.site, 'site', { required: true }),
    name: str(b.name, 'name', { required: true }),
    beat: str(b.beat, 'beat'),
    notes: str(b.notes, 'notes', { max: MAX_TEXT }),
    realPerson: !!b.realPerson,
    active: b.active === undefined ? true : !!b.active,
    createdAt: new Date().toISOString(),
  };
  if (
    store.personas.some(p => p.site === rec.site && p.name.toLowerCase() === rec.name.toLowerCase())
  ) {
    throw httpErr(409, `persona "${rec.name}" already exists on ${rec.site}`);
  }
  store.personas.push(rec);
  save(store);
  appendEvent({
    kind: 'persona.created',
    site: rec.site,
    personaId: rec.id,
    note: rec.name,
    actor,
  });
  return rec;
}

function updatePersona(personaId, body, actor = 'api') {
  const store = load();
  const i = store.personas.findIndex(p => p.id === personaId);
  if (i === -1) throw httpErr(404, 'persona not found');
  const b = body || {};
  const rec = { ...store.personas[i] };
  if (b.name !== undefined) rec.name = str(b.name, 'name', { required: true });
  if (b.beat !== undefined) rec.beat = str(b.beat, 'beat');
  if (b.notes !== undefined) rec.notes = str(b.notes, 'notes', { max: MAX_TEXT });
  if (b.realPerson !== undefined) rec.realPerson = !!b.realPerson;
  if (b.active !== undefined) rec.active = !!b.active;
  store.personas[i] = rec;
  save(store);
  appendEvent({
    kind: 'persona.updated',
    site: rec.site,
    personaId: rec.id,
    note: rec.name,
    actor,
  });
  return rec;
}

function deletePersona(personaId, actor = 'api') {
  const store = load();
  const i = store.personas.findIndex(p => p.id === personaId);
  if (i === -1) throw httpErr(404, 'persona not found');
  const used = store.accounts.filter(a => a.personaId === personaId).length;
  if (used)
    throw httpErr(409, `persona still has ${used} account row(s) — delete or reassign those first`);
  const [gone] = store.personas.splice(i, 1);
  save(store);
  appendEvent({
    kind: 'persona.deleted',
    site: gone.site,
    personaId: gone.id,
    note: gone.name,
    actor,
  });
  return { ok: true };
}

// ---- site meta -----------------------------------------------------------
function setSiteMeta(site, body, actor = 'api') {
  const store = load();
  const b = body || {};
  const cur = store.siteMeta[site] || {};
  const rec = { ...cur };
  if (b.category !== undefined) {
    const c = str(b.category, 'category', { required: true });
    if (!SITE_CATEGORY_KEYS.has(c))
      throw httpErr(400, `category must be one of: ${[...SITE_CATEGORY_KEYS].join(', ')}`);
    rec.category = c;
  }
  if (b.note !== undefined) rec.note = str(b.note, 'note', { max: MAX_TEXT });
  rec.updatedAt = new Date().toISOString();
  store.siteMeta[site] = rec;
  save(store);
  appendEvent({ kind: 'site.meta', site, to: rec.category, note: rec.note, actor });
  return rec;
}

function addPlatform(body, actor = 'api') {
  const store = load();
  const key = str((body || {}).key, 'key', { required: true }).toLowerCase();
  if (!KEY_RE.test(key)) throw httpErr(400, 'key must be lowercase letters/digits/-/_ (max 32)');
  if (platformCatalog(store).some(p => p.key === key))
    throw httpErr(409, 'platform already exists');
  // Scheme-check the template for the same reason upsertAccount checks
  // profileUrl: this string is interpolated into a profile link, so a
  // `javascript:` template would be stored XSS against the panel operator.
  const urlTemplate = str((body || {}).urlTemplate, 'urlTemplate', { max: 300 });
  if (urlTemplate && !/^https?:\/\//i.test(urlTemplate))
    throw httpErr(400, 'urlTemplate must be http(s)');
  const rec = {
    key,
    label: str((body || {}).label, 'label') || key,
    urlTemplate,
  };
  store.platforms.push(rec);
  save(store);
  appendEvent({ kind: 'platform.added', note: key, actor });
  return rec;
}

// ---- read surfaces -------------------------------------------------------
// Sites are the union of what's on disk (so a newly-onboarded site shows up
// with no registry edit at all) and whatever the registry already references.
function siteList(discovered) {
  const store = load();
  const set = new Set([
    ...(discovered || []),
    ...store.accounts.map(a => a.site),
    ...store.personas.map(p => p.site),
    ...Object.keys(store.siteMeta),
  ]);
  return [...set].sort();
}

function summary(discovered) {
  const store = load();
  const sites = siteList(discovered);
  const platforms = platformCatalog(store);
  const byStatus = {};
  for (const s of STATUSES) byStatus[s.key] = 0;
  const byPlatform = {};
  for (const a of store.accounts) {
    byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    byPlatform[a.platform] = byPlatform[a.platform] || { total: 0, live: 0, attention: 0 };
    byPlatform[a.platform].total += 1;
    if ((STATUSES.find(s => s.key === a.status) || {}).live) byPlatform[a.platform].live += 1;
    if (ATTENTION_STATUSES.has(a.status)) byPlatform[a.platform].attention += 1;
  }
  const attention = store.accounts.filter(a => ATTENTION_STATUSES.has(a.status));
  const eligible = sites.filter(s => {
    const cat = (store.siteMeta[s] || {}).category || 'active';
    return cat === 'active';
  });
  return {
    sites: sites.length,
    eligibleSites: eligible.length,
    accounts: store.accounts.length,
    personas: store.personas.length,
    live: store.accounts.filter(a => (STATUSES.find(s => s.key === a.status) || {}).live).length,
    needsAttention: attention.length,
    byStatus,
    byPlatform,
    platforms: platforms.length,
    updatedAt: store.updatedAt,
  };
}

function snapshot(discovered) {
  const store = load();
  return {
    platforms: platformCatalog(store),
    statuses: STATUSES,
    siteCategories: SITE_CATEGORIES,
    scopes: SCOPES,
    sites: siteList(discovered).map(s => ({
      site: s,
      onDisk: (discovered || []).includes(s),
      ...(store.siteMeta[s] || { category: 'active' }),
    })),
    personas: listPersonas(null),
    accounts: store.accounts.map(a => decorate(store, a)),
    summary: summary(discovered),
  };
}

// Compact, AI-friendly digest: what is broken and what has never been tried,
// per eligible site. This is what the social-setup skill reads on entry.
function worklist(discovered) {
  const store = load();
  const sites = siteList(discovered);
  const rows = [];
  for (const a of store.accounts) {
    const act = actionFor(a.status);
    if (act && act !== 'provision') {
      rows.push({
        action: act,
        site: a.site,
        platform: a.platform,
        scope: a.scope,
        persona: a.personaId ? (store.personas.find(p => p.id === a.personaId) || {}).name : null,
        status: a.status,
        note: a.statusNote,
        accountId: a.id,
        updatedAt: a.updatedAt,
      });
    }
  }
  const covered = new Set(
    store.accounts.filter(a => a.scope === 'brand').map(a => `${a.site}|${a.platform}`)
  );
  const missing = [];
  for (const s of sites) {
    const cat = (store.siteMeta[s] || {}).category || 'active';
    if (cat !== 'active') continue;
    for (const p of ['bluesky', 'pinterest']) {
      if (!covered.has(`${s}|${p}`))
        missing.push({
          action: 'provision',
          site: s,
          platform: p,
          scope: 'brand',
          status: 'not_started',
        });
    }
  }
  return { attention: rows, missing, summary: summary(discovered) };
}

module.exports = {
  STATUSES,
  SITE_CATEGORIES,
  SCOPES,
  BUILTIN_PLATFORMS,
  snapshot,
  summary,
  worklist,
  siteList,
  listAccounts,
  getAccount,
  upsertAccount,
  updateAccount,
  setStatus,
  deleteAccount,
  listPersonas,
  createPersona,
  updatePersona,
  deletePersona,
  setSiteMeta,
  addPlatform,
  readEvents,
  _reset() {
    CACHE = null;
  }, // tests
  _paths: { STORE_FILE, EVENTS_FILE, REGISTRY_DIR },
};
