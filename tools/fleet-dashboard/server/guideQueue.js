'use strict';

// Guide Queue — same file-kanban model as tasks.js (mirrored on purpose),
// for the guide-writing pipeline: ops/guide-queue/{ideas,drafted,ready,
// released,rejected}/*.md. Backs the Fleet Dashboard's Guides tab.
//
// See tools/guide-queue/lib/guide_queue.py — the Python side the cron roles
// use. This is the same frontmatter contract read/written from Node instead.

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { siteDir } = require('./sites');

const STATUSES = ['ideas', 'drafted', 'ready', 'released', 'rejected'];

const QUEUE_FIELDS = [
  'queue_id', 'queue_status', 'source', 'created', 'brief', 'notes',
  'hero_image', 'card_image',
];

const FIELD_ORDER = [...QUEUE_FIELDS, 'title', 'description', 'category',
  'updated', 'published', 'author', 'featuredProducts', 'faq', 'schemaType', 'steps'];

const SCHEMA = yaml.CORE_SCHEMA; // same rationale as tasks.js: keep `created: 2026-08-10` a string

function isValidStatus(s) { return STATUSES.includes(s); }

// Same filename-safety rule as tasks.js.
function isValidFilename(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name) && !name.includes('..');
}

function queueDir(root, slug) { return path.join(siteDir(root, slug), 'ops', 'guide-queue'); }
function statusDir(root, slug, status) { return path.join(queueDir(root, slug), status); }

function parseItem(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  let meta = {};
  try { meta = yaml.load(m[1], { schema: SCHEMA }) || {}; } catch { meta = {}; }
  if (typeof meta !== 'object' || Array.isArray(meta)) meta = {};
  return { meta, body: m[2] };
}

function serializeItem(meta, body) {
  const clean = {};
  for (const k of Object.keys(meta || {})) {
    const v = meta[k];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    clean[k] = v;
  }
  const ordered = {};
  for (const k of FIELD_ORDER) if (k in clean) { ordered[k] = clean[k]; delete clean[k]; }
  for (const k of Object.keys(clean)) ordered[k] = clean[k];
  const cleanBody = (body || '').replace(/^\n+/, '').replace(/\n+$/, '');
  const fm = yaml.dump(ordered, { schema: SCHEMA, lineWidth: 100, quotingType: '"', forceQuotes: false }).trimEnd();
  return `---\n${fm}\n---\n\n${cleanBody}\n`;
}

function readItemCard(dir, status, name, slug) {
  if (!name.endsWith('.md')) return null;
  const fp = path.join(dir, name);
  let st; try { st = fs.statSync(fp); } catch { return null; }
  if (!st.isFile()) return null;
  const { meta, body } = parseItem(fs.readFileSync(fp, 'utf8'));
  const excerpt = body.replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return {
    site: slug, file: name, status,
    title: meta.title || meta.brief && String(meta.brief).slice(0, 60) || name.replace(/\.md$/, ''),
    category: meta.category || null,
    source: meta.source || null,
    created: meta.created ? String(meta.created) : null,
    hasImages: !!(meta.hero_image && meta.card_image),
    excerpt,
    mtime: st.mtimeMs,
  };
}

// List every item across all statuses for one site.
function list(root, slug) {
  const base = queueDir(root, slug);
  const out = {};
  for (const status of STATUSES) {
    out[status] = [];
    const dir = path.join(base, status);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    for (const name of names.sort()) {
      const card = readItemCard(dir, status, name, slug);
      if (card) out[status].push(card);
    }
  }
  return out;
}

// Aggregate across every site with a guide-queue dir.
function listAll(root, slugs) {
  const all = [];
  for (const slug of slugs) {
    const base = queueDir(root, slug);
    if (!fs.existsSync(base)) continue;
    for (const status of STATUSES) {
      const dir = path.join(base, status);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names.sort()) {
        const card = readItemCard(dir, status, name, slug);
        if (card) all.push(card);
      }
    }
  }
  return all;
}

// Full item content incl. body + resolvable image paths, for the preview modal.
function get(root, slug, status, file) {
  if (!isValidStatus(status) || !isValidFilename(file)) throw httpErr(400, 'bad status or filename');
  const fp = path.join(statusDir(root, slug, status), file);
  if (!fs.existsSync(fp)) throw httpErr(404, 'item not found');
  const raw = fs.readFileSync(fp, 'utf8');
  const { meta, body } = parseItem(raw);
  const images = {};
  for (const [key, field] of [['hero', 'hero_image'], ['card', 'card_image']]) {
    if (meta[field]) {
      const abs = path.join(siteDir(root, slug), meta[field]);
      images[key] = fs.existsSync(abs)
        ? `/api/guide-queue/${slug}/image?path=${encodeURIComponent(meta[field])}`
        : null;
    }
  }
  return { file, status, meta, body, images };
}

// Serve raw image bytes for the preview modal. `relPath` must resolve inside
// this site's ops/guide-queue/drafted-assets/ or site/public/images/ — the
// two places generate-guide-images.py / guide-publish.sh ever write to.
function imagePath(root, slug, relPath) {
  if (typeof relPath !== 'string' || relPath.includes('..')) throw httpErr(400, 'bad path');
  const base = siteDir(root, slug);
  const abs = path.resolve(base, relPath);
  const allowedRoots = [
    path.resolve(base, 'ops', 'guide-queue', 'drafted-assets'),
    path.resolve(base, 'site', 'public', 'images'),
  ];
  if (!allowedRoots.some((r) => abs === r || abs.startsWith(r + path.sep))) {
    throw httpErr(400, 'path outside allowed image roots');
  }
  if (!fs.existsSync(abs)) throw httpErr(404, 'image not found');
  return abs;
}

function slugify(s) {
  return String(s || 'guide').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'guide';
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Add a new idea (dashboard's "add idea" form — same shape as the AI
// seeder's add-idea CLI call, just from Node instead of Python).
function addIdea(root, slug, payload) {
  const title = payload.title || 'Untitled guide idea';
  const qid = slugify(title);
  const meta = {
    queue_id: qid,
    queue_status: 'idea',
    source: payload.source === 'ai' ? 'ai' : 'human',
    created: today(),
    brief: payload.brief || '',
    title,
    category: payload.category || undefined,
  };
  const dir = statusDir(root, slug, 'ideas');
  fs.mkdirSync(dir, { recursive: true });
  let name = `${qid}.md`, n = 2;
  while (fs.existsSync(path.join(dir, name))) { name = `${qid}-${n}.md`; n += 1; }
  fs.writeFileSync(path.join(dir, name), serializeItem(meta, ''));
  return name;
}

// Move between columns — used by the dashboard's Accept/Reject/Send-back
// buttons. Plain fs rename; the next cron tick (or a human) picks up state
// from the directory, same non-committing convention as tasks.move().
function move(root, slug, fromStatus, file, toStatus) {
  if (!isValidStatus(fromStatus) || !isValidStatus(toStatus) || !isValidFilename(file)) {
    throw httpErr(400, 'bad status or filename');
  }
  const from = path.join(statusDir(root, slug, fromStatus), file);
  if (!fs.existsSync(from)) throw httpErr(404, 'item not found');
  const toDir = statusDir(root, slug, toStatus);
  fs.mkdirSync(toDir, { recursive: true });
  let dest = path.join(toDir, file), name = file, n = 2;
  while (fs.existsSync(dest)) { name = file.replace(/\.md$/, `-${n}.md`); dest = path.join(toDir, name); n += 1; }
  // Keep queue_status in sync with its new directory.
  const raw = fs.readFileSync(from, 'utf8');
  const { meta, body } = parseItem(raw);
  meta.queue_status = { ideas: 'idea', drafted: 'drafted', ready: 'ready', released: 'released', rejected: 'rejected' }[toStatus] || toStatus;
  fs.writeFileSync(from, serializeItem(meta, body));
  fs.renameSync(from, dest);
  return { status: toStatus, file: name };
}

// Overwrite notes / a light edit from the preview modal (title/brief/notes
// only — the actual guide body is the writer role's job, not a dashboard
// text field).
function update(root, slug, status, file, payload) {
  if (!isValidStatus(status) || !isValidFilename(file)) throw httpErr(400, 'bad status or filename');
  const fp = path.join(statusDir(root, slug, status), file);
  if (!fs.existsSync(fp)) throw httpErr(404, 'item not found');
  const { meta, body } = parseItem(fs.readFileSync(fp, 'utf8'));
  if (payload.notes !== undefined) meta.notes = payload.notes;
  if (payload.title !== undefined) meta.title = payload.title;
  if (payload.brief !== undefined) meta.brief = payload.brief;
  if (payload.category !== undefined) meta.category = payload.category;
  fs.writeFileSync(fp, serializeItem(meta, body));
  return { file };
}

// --- Per-site config (ops/tracked.yaml's manual: block) -------------------
// Read via full YAML parse (safe); WRITE via a targeted line replace so we
// never clobber the hand-written comments in tracked.yaml (a full
// yaml.dump round-trip would strip them — this file is meant to stay
// human-readable, same reasoning as tasks.js's comment about CORE_SCHEMA).

function trackedYamlPath(root, slug) { return path.join(siteDir(root, slug), 'ops', 'tracked.yaml'); }

function getConfig(root, slug) {
  const fp = trackedYamlPath(root, slug);
  let data = {};
  try { data = yaml.load(fs.readFileSync(fp, 'utf8'), { schema: SCHEMA }) || {}; } catch { data = {}; }
  const manual = (data && data.manual) || {};
  return {
    guide_cadence_days: manual.guide_cadence_days != null ? Number(manual.guide_cadence_days) : 5,
    guide_ideas_min: manual.guide_ideas_min != null ? Number(manual.guide_ideas_min) : 3,
  };
}

function setConfigField(root, slug, field, value) {
  if (!['guide_cadence_days', 'guide_ideas_min'].includes(field)) throw httpErr(400, 'unknown config field');
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) throw httpErr(400, 'value must be a positive number');
  const fp = trackedYamlPath(root, slug);
  if (!fs.existsSync(fp)) throw httpErr(404, 'ops/tracked.yaml not found for this site');
  let text = fs.readFileSync(fp, 'utf8');
  // Replace only the value token, preserving any trailing `# comment` on the
  // same line (tracked.yaml's fields are hand-documented — a full-line
  // replace would silently drop that documentation on every dashboard edit).
  const lineRe = new RegExp(`^(\\s*${field}:)\\s*\\S+(\\s*(#.*)?)$`, 'm');
  if (lineRe.test(text)) {
    text = text.replace(lineRe, `$1 ${n}$2`);
  } else if (/^manual:\s*$/m.test(text)) {
    text = text.replace(/^manual:\s*$/m, `manual:\n  ${field}: ${n}`);
  } else {
    text += `\nmanual:\n  ${field}: ${n}\n`;
  }
  fs.writeFileSync(fp, text);
  return getConfig(root, slug);
}

function httpErr(status, msg) { const e = new Error(msg); e.httpStatus = status; return e; }

module.exports = {
  STATUSES, list, listAll, get, imagePath, addIdea, move, update,
  getConfig, setConfigField,
  parseItem, serializeItem,
};
