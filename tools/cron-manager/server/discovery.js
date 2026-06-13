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
  return {
    kind: 'site', slug, crontabPath, opsDir,
    project: `${name}-ops`, container: `${name}-cron`,
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
