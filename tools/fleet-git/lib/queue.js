'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATE_DIR = path.join(__dirname, '..', 'state');
const QUEUE_PATH = path.join(STATE_DIR, 'queue.json');
const LAST_PATH = path.join(STATE_DIR, 'last-sweep.json');

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
}

const key = (slug, p) => `${slug}:${p}`;

function load() {
  const q = readJson(QUEUE_PATH, { version: 1, items: {} });
  q.items = q.items || {};
  return q;
}

// Merge this sweep's review items into the persistent queue. Items keep their
// first_seen (so "this has been unresolved for 6 days" is answerable) and are
// auto-closed when they stop appearing — a path an operator fixed by hand
// disappears from the board without anyone clicking anything.
function reconcile(reviewsBySlug, { now, sweptSlugs }) {
  const q = load();
  const seen = new Set();
  for (const [slug, reviews] of Object.entries(reviewsBySlug)) {
    for (const r of reviews) {
      const k = key(slug, r.path);
      seen.add(k);
      const prev = q.items[k];
      q.items[k] = {
        slug,
        path: r.path,
        kind: r.kind,
        reason: r.reason,
        first_seen: prev?.first_seen || now,
        last_seen: now,
        status: 'open',
      };
    }
  }
  for (const [k, item] of Object.entries(q.items)) {
    if (seen.has(k)) continue;
    // Only auto-close items belonging to a repo this sweep actually visited.
    if (!sweptSlugs.has(item.slug)) continue;
    delete q.items[k];
  }
  writeJson(QUEUE_PATH, q);
  return q;
}

function open() {
  return Object.values(load().items).filter(i => i.status === 'open');
}

function remove(slug, p) {
  const q = load();
  delete q.items[key(slug, p)];
  writeJson(QUEUE_PATH, q);
}

function saveSweep(report) {
  writeJson(LAST_PATH, report);
}

function lastSweep() {
  return readJson(LAST_PATH, null);
}

module.exports = {
  load,
  reconcile,
  open,
  remove,
  saveSweep,
  lastSweep,
  QUEUE_PATH,
  LAST_PATH,
  STATE_DIR,
};
