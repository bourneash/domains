'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { git } = require('./gitexec');

// The fleet's repo set: the parent monorepo plus every registered submodule
// under sites/. Deliberately driven by `git submodule` (the gitlink truth),
// NOT by a directory listing — a directory under sites/ that is NOT a
// submodule resolves its git commands against the PARENT repo, which is how
// a "site is dirty" report can silently be the monorepo's own status. Those
// directories are reported separately as `unregistered`.
async function discover(root) {
  const repos = [{ slug: 'domains', dir: root, parent: true }];
  const r = await git(root, ['config', '--file', '.gitmodules', '--get-regexp', 'path']);
  const registered = new Set();
  if (r.ok) {
    for (const line of r.out.split('\n').filter(Boolean)) {
      const p = line.split(' ').slice(1).join(' ').trim();
      if (!p) continue;
      registered.add(p);
      const dir = path.join(root, p);
      if (!fs.existsSync(path.join(dir, '.git'))) continue; // not initialised
      repos.push({ slug: path.basename(p), dir, subPath: p, parent: false });
    }
  }
  const unregistered = [];
  const sitesDir = path.join(root, 'sites');
  if (fs.existsSync(sitesDir)) {
    for (const name of fs.readdirSync(sitesDir)) {
      const rel = `sites/${name}`;
      if (registered.has(rel)) continue;
      if (!fs.statSync(path.join(sitesDir, name)).isDirectory()) continue;
      unregistered.push(rel);
    }
  }
  return { repos, unregistered };
}

module.exports = { discover };
