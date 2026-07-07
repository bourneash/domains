'use strict';

// Per-role last-run facts + log resolution for the cron control plane.
// Ported verbatim from tools/cron-manager (server/runinfo.js).

const fs = require('node:fs');
const path = require('node:path');

// Per-role last-run facts come from each site's ops/board/last-run.json, which
// the roles themselves write: { "<role>": { at, exit, log }, ... }.
// `at` is an ISO timestamp, `exit` the process code, `log` a container-path
// (/work/ops/logs/...) to that run's log file.
function readLastRuns(opsDir) {
  if (!opsDir) return {};
  try {
    const raw = fs.readFileSync(path.join(opsDir, 'board', 'last-run.json'), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

// Translate a container log path (/work/ops/logs/x.log) recorded in
// last-run.json into a real host path, and refuse anything that escapes the
// site's ops/logs dir (defense against traversal / absolute paths).
function resolveLogPath(root, slug, containerPath) {
  if (!containerPath || typeof containerPath !== 'string') return null;
  const siteRoot = path.join(root, 'sites', slug);
  const logsDir = path.join(siteRoot, 'ops', 'logs');
  let hostPath;
  if (containerPath.startsWith('/work/')) {
    hostPath = path.join(siteRoot, containerPath.slice('/work/'.length));
  } else if (containerPath.startsWith('ops/')) {
    hostPath = path.join(siteRoot, containerPath);
  } else {
    return null;
  }
  const resolved = path.resolve(hostPath);
  if (resolved !== logsDir && !resolved.startsWith(logsDir + path.sep)) return null;
  return resolved;
}

// Tail the last N lines of a file WITHOUT reading the whole thing into memory.
// Reads at most `maxBytes` from the end (enough to comfortably cover N lines of
// ordinary log output); if we started mid-file, the first (partial) line is
// dropped. Never throws.
function tailFile(file, lines = 400, maxBytes = 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    if (len > 0) fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');          // drop the partial first line
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    const arr = text.replace(/\n+$/, '').split('\n');
    return arr.slice(Math.max(0, arr.length - lines)).join('\n').trim() || '(empty log)';
  } catch (e) {
    return `error reading log: ${e.message}`;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

module.exports = { readLastRuns, resolveLogPath, tailFile };
