#!/usr/bin/env node
'use strict';

// One-shot migration: tools/social-setup/FLEET_SOCIAL_MAP.md -> the social
// registry (tools/social-setup/registry/social.json).
//
// Kept in-tree after the run as provenance for where the seed data came from —
// re-running it against the (now deleted) markdown is not expected, and it
// refuses to clobber a registry that already has accounts unless --force.
//
//   node scripts/import-social-map.js [path/to/FLEET_SOCIAL_MAP.md] [--force] [--dry-run]

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY = args.includes('--dry-run');
const MAP =
  args.find(a => !a.startsWith('--')) ||
  path.join(ROOT, 'tools', 'social-setup', 'FLEET_SOCIAL_MAP.md');

const social = require('../server/social');
const STORE = social._paths.STORE_FILE;

const SYMBOL = {
  '✅': 'active',
  '🟡': 'stuck',
  '⛔': 'blocked',
  '⬜': 'not_started',
  '—': 'excluded',
};

// Per-cell notes for the non-green cells — the markdown carried these in a
// shared per-row Notes column, which is exactly the ambiguity the registry
// removes (a note now hangs off the cell it describes).
const CELL_NOTES = {
  '0daynews.com|pinterest':
    'Orphaned email reservation — no known recovery path, do not keep retrying.',
  'sinderella.org|pinterest': 'Orphaned email reservation, unresolved.',
  'americastrikes.com|reddit':
    'Account exists but OAuth app creation is silently blocked. Reddit is parked fleet-wide.',
};

// The map's §"Not started" prose said fishhooklabs.com and weapontester.com
// already had creds in the vault, but nobody ever added them to the table —
// precisely the drift this migration exists to end. Seeded here, flagged for
// verification rather than silently trusted.
const EXTRA_BRAND = [
  ['fishhooklabs.com', 'bluesky'],
  ['fishhooklabs.com', 'pinterest'],
  ['weapontester.com', 'bluesky'],
  ['weapontester.com', 'pinterest'],
];
const EXTRA_NOTE =
  'Carried over from the FLEET_SOCIAL_MAP correction footnote (2026-08-14) — the table itself was never updated. Verify against the vault before relying on it.';

function cellsOf(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => c.trim());
}

function parse(md) {
  const lines = md.split('\n');
  const out = { siteMeta: {}, personas: [], accounts: [] };

  // ---- §1 brand table ----
  const headIdx = lines.findIndex(l => /^\|\s*Domain\s*\|/.test(l));
  if (headIdx === -1) throw new Error('brand table header not found');
  const platforms = cellsOf(lines[headIdx])
    .slice(1, -1)
    .map(p => p.toLowerCase());
  for (let i = headIdx + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const cells = cellsOf(lines[i]);
    const site = cells[0];
    const note = cells[cells.length - 1];
    out.siteMeta[site] = { category: 'active', note: note === '—' ? '' : note };
    platforms.forEach((platform, pi) => {
      const status = SYMBOL[cells[pi + 1]] || 'not_started';
      if (status === 'not_started') return; // nothing to record; absence is the signal
      out.accounts.push({
        site,
        platform,
        scope: 'brand',
        status,
        statusNote: CELL_NOTES[`${site}|${platform}`] || '',
        credsInVault: status === 'active',
      });
    });
  }

  // ---- site buckets ----
  const bucket = (headingRe, category) => {
    const i = lines.findIndex(l => headingRe.test(l));
    if (i === -1) return;
    const body = [];
    for (let j = i + 1; j < lines.length && !lines[j].startsWith('#'); j++) body.push(lines[j]);
    const text = body.join(' ');
    for (const d of text.match(/[a-z0-9][a-z0-9-]*\.(com|org|net|work|info)/g) || []) {
      out.siteMeta[d] = { category, note: out.siteMeta[d] ? out.siteMeta[d].note : '' };
    }
  };
  for (const [site, platform] of EXTRA_BRAND) {
    if (!out.siteMeta[site]) out.siteMeta[site] = { category: 'active', note: '' };
    out.accounts.push({
      site,
      platform,
      scope: 'brand',
      status: 'active',
      statusNote: EXTRA_NOTE,
      credsInVault: true,
    });
  }

  bucket(/^### Positioning TBD/, 'positioning_tbd');
  bucket(/^### Explicit \/ adult-content/, 'adult_excluded');

  // ---- §2 persona table ----
  const pHead = lines.findIndex(l => /^\|\s*Site\s*\|\s*Brand status\s*\|/.test(l));
  if (pHead === -1) throw new Error('persona table header not found');
  let curSite = null;
  for (let i = pHead + 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const c = cellsOf(lines[i]);
    if (c[0]) curSite = c[0];
    const name = c[2];
    if (!name) continue;
    const beat = c[3] || '';
    const status = c[4] || '';
    const realPerson = /real person/i.test(beat) || /his own identity/i.test(status);
    out.personas.push({ site: curSite, name, beat, realPerson, statusText: status });
  }
  return out;
}

// Turn a persona's free-text status cell into account rows.
function personaAccounts(p) {
  const rows = [];
  const t = p.statusText;
  if (!t || /no accounts/i.test(t) || /n\/a/i.test(t)) return rows;
  for (const platform of ['bluesky', 'pinterest', 'instagram']) {
    const re = new RegExp(`${platform}[^·;]*`, 'i');
    const seg = (t.match(re) || [])[0];
    if (!seg) continue;
    const handle = (seg.match(/`([^`]+)`/) || [])[1] || '';
    const stuck = /\*\*stuck\*\*|stuck/i.test(seg);
    rows.push({
      platform,
      status: stuck ? 'stuck' : 'active',
      handle: stuck ? '' : handle,
      statusNote: stuck ? seg.replace(/\*\*/g, '').trim() : '',
      credsInVault: !stuck,
    });
  }
  return rows;
}

function main() {
  const existing = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, 'utf8')) : null;
  if (existing && (existing.accounts || []).length && !FORCE) {
    console.error(
      `refusing to overwrite ${STORE} (${existing.accounts.length} accounts). Pass --force.`
    );
    process.exit(1);
  }
  const parsed = parse(fs.readFileSync(MAP, 'utf8'));

  const store = {
    version: 1,
    updatedAt: new Date().toISOString(),
    platforms: [],
    siteMeta: parsed.siteMeta,
    personas: [],
    accounts: [],
  };
  let n = 0;
  const mkId = p => `${p}_${(n++).toString(16).padStart(12, '0')}`;
  const now = new Date().toISOString();

  for (const a of parsed.accounts) {
    store.accounts.push({
      id: mkId('acc'),
      personaId: null,
      handle: '',
      profileUrl: '',
      notes: '',
      tags: [],
      followers: null,
      lastPostedAt: null,
      ...a,
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const p of parsed.personas) {
    const rec = {
      id: mkId('per'),
      site: p.site,
      name: p.name,
      beat: p.beat,
      notes: '',
      realPerson: p.realPerson,
      active: true,
      createdAt: now,
    };
    store.personas.push(rec);
    for (const a of personaAccounts(p)) {
      store.accounts.push({
        id: mkId('acc'),
        site: p.site,
        scope: 'persona',
        personaId: rec.id,
        profileUrl: '',
        notes: '',
        tags: [],
        followers: null,
        lastPostedAt: null,
        ...a,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  console.log(
    `sites: ${Object.keys(store.siteMeta).length}  personas: ${store.personas.length}  accounts: ${store.accounts.length}`
  );
  const byStatus = {};
  for (const a of store.accounts) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  console.log('by status:', byStatus);
  const byCat = {};
  for (const m of Object.values(store.siteMeta)) byCat[m.category] = (byCat[m.category] || 0) + 1;
  console.log('site buckets:', byCat);

  if (DRY) {
    console.log('(dry run — nothing written)');
    return;
  }
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, `${JSON.stringify(store, null, 2)}\n`);
  console.log(`wrote ${STORE}`);
}

main();
