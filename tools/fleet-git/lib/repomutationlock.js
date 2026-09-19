'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STALE_MS = Number(process.env.REPO_MUTATION_LOCK_STALE_MS || 3 * 60 * 60 * 1000);

function lockPath(repoDir) {
  return path.join(repoDir, 'ops', '.locks', 'repo-mutation.lock.d');
}

function acquire(repoDir, owner = `fleet-git:${process.pid}`) {
  const dir = lockPath(repoDir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const token = `${owner}:${Date.now()}`;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner'), `${token}\n`);
      return { dir, token };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      if (age <= STALE_MS) return null;
      const stale = `${dir}.stale.${process.pid}.${Date.now()}`;
      try {
        fs.renameSync(dir, stale);
        fs.rmSync(stale, { recursive: true, force: true });
      } catch {
        return null;
      }
    }
  }
  return null;
}

function release(lock) {
  if (!lock) return;
  try {
    const owner = fs.readFileSync(path.join(lock.dir, 'owner'), 'utf8').trim();
    if (owner !== lock.token) return;
    fs.rmSync(path.join(lock.dir, 'owner'), { force: true });
    fs.rmdirSync(lock.dir);
  } catch {
    // A stale-lock reclaimer may already have removed it.
  }
}

module.exports = { acquire, release, lockPath };
