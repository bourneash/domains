'use strict';

// Cron-system discovery: enumerates sites/* and tools/* that own a crontab.
// Ported verbatim from tools/cron-manager (server/discovery.js); the only
// change is the parser require path (./crontab → ./parse).

const fs = require('node:fs');
const path = require('node:path');
const { parseCrontab } = require('./parse');

// site slug → compose name stem. The ops compose files name the project
// `<firstSegment>-ops` and the cron container `<firstSegment>-cron`
// (americastrikes.com → americastrikes).
function stem(slug) {
  return slug.split('.')[0];
}

// The actual cron container name. Convention is `<stem>-cron`, but compose can
// drift from it (e.g. CF/Workers naming stripping dots → xxxtea-com). We prefer
// the real `container_name:` ending in `-cron` straight from the site's
// docker-compose.yml so status lookups never silently miss the container and
// report "never-built". Falls back to the convention.
function cronContainerName(composePath, fallback) {
  try {
    const text = fs.readFileSync(composePath, 'utf8');
    const names = [...text.matchAll(/container_name:\s*["']?([A-Za-z0-9._-]+)["']?/g)]
      .map((m) => m[1]);
    return names.find((n) => n.endsWith('-cron')) || fallback;
  } catch {
    return fallback;
  }
}

function readDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

function withEnabled(entries, opsDir) {
  return entries.map((e) => {
    let enabled;
    if (e.role && opsDir) {
      enabled = !fs.existsSync(path.join(opsDir, `.${e.role}-disabled`));
    } else {
      enabled = !e.commented;
    }
    return { ...e, enabled };
  });
}

function buildSite(root, slug) {
  const crontabPath = path.join(root, 'sites', slug, 'ops', 'docker', 'crontab.docker');
  if (!fs.existsSync(crontabPath)) return null;
  const opsDir = path.join(root, 'sites', slug, 'ops');
  const { entries } = parseCrontab(fs.readFileSync(crontabPath, 'utf8'));
  const name = stem(slug);
  const composePath = path.join(root, 'sites', slug, 'docker-compose.yml');
  return {
    kind: 'site', slug, crontabPath, opsDir,
    project: `${name}-ops`,
    container: cronContainerName(composePath, `${name}-cron`),
    entries: withEnabled(entries, opsDir),
  };
}

// The actual cron-container name for a tool. Like cronContainerName() for
// sites, this reads `container_name:` from the tool's own docker-compose.yml
// rather than assuming it matches the tools/<slug> directory name — several
// tools (e.g. domain-developer → dd-panel, data-hub → datahub-collector) name
// their container differently. Multi-service compose files (data-hub,
// data-hub-images) are disambiguated by preferring the service block that
// actually runs supercronic/crontab; single-service files just use the one
// container_name found. Falls back to the directory-slug convention if the
// compose file doesn't specify one at all.
function toolContainerName(composePath, fallback) {
  try {
    const text = fs.readFileSync(composePath, 'utf8');
    const names = [...text.matchAll(/container_name:\s*["']?([A-Za-z0-9._-]+)["']?/g)]
      .map((m) => m[1]);
    if (names.length === 0) return fallback;
    if (names.length === 1) return names[0];
    // Multiple services: split into per-service blocks and prefer the one
    // whose block runs the crontab (supercronic).
    const blocks = text.split(/(?=container_name:)/);
    for (const block of blocks) {
      if (/supercronic|crontab/i.test(block)) {
        const m = block.match(/container_name:\s*["']?([A-Za-z0-9._-]+)["']?/);
        if (m) return m[1];
      }
    }
    return names[0];
  } catch {
    return fallback;
  }
}

function buildTool(root, slug) {
  const crontabPath = path.join(root, 'tools', slug, 'crontab.docker');
  if (!fs.existsSync(crontabPath)) return null;
  const composePath = path.join(root, 'tools', slug, 'docker-compose.yml');
  const { entries } = parseCrontab(fs.readFileSync(crontabPath, 'utf8'));
  return {
    kind: 'tool', slug, crontabPath, opsDir: null,
    project: slug, container: toolContainerName(composePath, slug),
    entries: withEnabled(entries, null),
  };
}

// Authoritative cron-container name for a site slug: the site's own
// docker-compose `container_name:` ending in `-cron`, else the `<stem>-cron`
// convention. Single source of truth so run.js and the cron control plane
// resolve the SAME container (see B1) instead of guessing independently.
function siteCronContainer(root, slug) {
  const composePath = path.join(root, 'sites', slug, 'docker-compose.yml');
  return cronContainerName(composePath, `${stem(slug)}-cron`);
}

function discoverSystems(root) {
  const out = [];
  for (const slug of readDirs(path.join(root, 'sites'))) {
    const s = buildSite(root, slug);
    if (s) out.push(s);
  }
  for (const slug of readDirs(path.join(root, 'tools'))) {
    const t = buildTool(root, slug);
    if (t) out.push(t);
  }
  return out;
}

module.exports = { discoverSystems, stem, siteCronContainer, cronContainerName, toolContainerName };
