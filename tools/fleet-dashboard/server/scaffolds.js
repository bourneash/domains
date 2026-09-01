'use strict';

// Parked inventory — the domains that are registered and scaffolded but not
// built (F51).
//
// WHY THIS EXISTS
// ---------------
// 23 of the registry's entries carry `status: scaffold`: a domain that was
// bought, bootstrapped to a COMING SOON page, and then left. They cost
// registrar renewal every year and return nothing. Until now the only place
// that fact existed was registry/fleet.yaml, so dead inventory was invisible
// to anyone looking at the panel — Domain Control renders sites that *run*
// something, and a scaffold runs nothing by definition. Inventory you cannot
// see is inventory you never decide about.
//
// DESIGN NOTES
// ------------
// * **The registry is the roster, not the filesystem.** Every other module
//   here starts from discoverSites() (a dir with ops/). That is the right
//   truth for "what is running"; it is the wrong truth for "what do I own".
//   This module reads registry/fleet.yaml directly and is the dashboard's
//   first registry consumer (see F22 — the rest still keep their own rosters).
// * **days_parked comes from git, not a hand-maintained field.** The first
//   commit in the site's submodule is when it was scaffolded, and that date
//   cannot drift or be forgotten. A site with no repo on disk reports null
//   rather than guessing.
// * **renewal date is optional and never invented.** `registrar_expires` in
//   the registry is hand-owned; absent means the column reads "unknown". The
//   alternative — deriving it from WHOIS on a timer — is a different tool and
//   a network dependency this panel does not need.
// * Cached like every other sweep here: the git calls are O(scaffolds) spawns,
//   far too slow to run inside each GET.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');

const CACHE_TTL_MS = 5 * 60 * 1000;
const GIT_TIMEOUT_MS = 5000;

const _cache = new Map(); // root -> { at, data }

function registryPath(root) {
  return path.join(root, 'registry', 'fleet.yaml');
}

// First-commit date of the site's own repo, as an ISO day. This is the
// scaffold date: bootstrap-domain.sh's initial push is always commit one.
// Returns null when there is no repo on disk to ask — an unbuilt domain may
// exist only as a registry row and a GitHub repo.
function firstCommitDay(root, domain) {
  const dir = path.join(root, 'sites', domain);
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  try {
    const out = execFileSync(
      'git',
      ['-C', dir, 'log', '--reverse', '--format=%cs', '--max-parents=0'],
      { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const day = out.split('\n')[0].trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  } catch {
    return null;
  }
}

function daysSince(day) {
  if (!day) return null;
  const then = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86400000);
}

function daysUntil(day) {
  if (!day) return null;
  const then = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  return Math.ceil((then - Date.now()) / 86400000);
}

function readRegistry(root) {
  const p = registryPath(root);
  if (!fs.existsSync(p)) return null;
  const doc = yaml.load(fs.readFileSync(p, 'utf8'));
  return doc && typeof doc.sites === 'object' ? doc.sites : null;
}

function build(root) {
  const sites = readRegistry(root);
  if (!sites) {
    return { ok: false, error: 'registry/fleet.yaml not found or has no sites: key', rows: [] };
  }

  const rows = [];
  for (const [domain, entry] of Object.entries(sites)) {
    if (!entry || entry.status !== 'scaffold') continue;
    const scaffolded = firstCommitDay(root, domain);
    const expires = typeof entry.registrar_expires === 'string' ? entry.registrar_expires : null;
    rows.push({
      domain,
      repo: entry.repo || null,
      worker: entry.worker || null,
      cf_zone: entry.cf_zone || null,
      // A scaffold that already has social accounts or a data-hub feed is a
      // different kind of parked than a bare COMING SOON page — it means prior
      // investment that a sunset would throw away. Surface it rather than
      // flattening every scaffold into one row shape.
      capabilities: Array.isArray(entry.capabilities) ? entry.capabilities : [],
      notes: entry.notes || null,
      scaffolded_on: scaffolded,
      days_parked: daysSince(scaffolded),
      registrar_expires: expires,
      days_to_renewal: daysUntil(expires),
    });
  }

  // Longest-parked first: the top of this list is the inventory that has had
  // the most time to prove itself and hasn't.
  rows.sort((a, b) => (b.days_parked ?? -1) - (a.days_parked ?? -1) || a.domain.localeCompare(b.domain));

  const total = Object.keys(sites).length;
  return {
    ok: true,
    rows,
    summary: {
      scaffolds: rows.length,
      total_registry_entries: total,
      // How much of the portfolio is dead weight, in one number.
      parked_pct: total ? Math.round((rows.length / total) * 100) : 0,
      oldest_days_parked: rows.length ? rows[0].days_parked : null,
      renewals_due_90d: rows.filter((r) => r.days_to_renewal !== null && r.days_to_renewal <= 90).length,
      unknown_renewal: rows.filter((r) => r.registrar_expires === null).length,
    },
    generated_at: new Date().toISOString(),
  };
}

function all(root, { fresh = false } = {}) {
  const hit = _cache.get(root);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const data = build(root);
  _cache.set(root, { at: Date.now(), data });
  return data;
}

module.exports = { all, _build: build };
