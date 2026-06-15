'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseCrontab } = require('./crontab');

// site slug → compose name stem. The ops compose files name the project
// `<firstSegment>-ops` and the cron container `<firstSegment>-cron`
// (americastrikes.com → americastrikes).
function stem(slug) {
  return slug.split('.')[0];
}

// The actual cron container name. Convention is `<stem>-cron`, but compose
// can drift from it (e.g. CF/Workers naming stripping dots → xxxtea-com). We
// prefer the real `container_name:` ending in `-cron` straight from the
// site's docker-compose.yml so status lookups never silently miss the
// container and report "never-built". Falls back to the convention.
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

function buildTool(root, slug) {
  const crontabPath = path.join(root, 'tools', slug, 'crontab.docker');
  if (!fs.existsSync(crontabPath)) return null;
  const { entries } = parseCrontab(fs.readFileSync(crontabPath, 'utf8'));
  return {
    kind: 'tool', slug, crontabPath, opsDir: null,
    project: slug, container: slug,
    entries: withEnabled(entries, null),
  };
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

module.exports = { discoverSystems, stem };
