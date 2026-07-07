'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { siteDir } = require('./sites');

// The canonical task-board columns. Every site has backlog/in-progress/done;
// some also have hold. We surface all four; missing dirs simply read empty and
// are created on demand when a task is moved/created into them.
const COLUMNS = ['backlog', 'in-progress', 'done', 'hold'];

// Files that live in task dirs but are not tasks.
const NON_TASK = new Set(['README.md', '.gitkeep']);

function tasksDir(root, slug) { return path.join(siteDir(root, slug), 'ops', 'tasks'); }

function isValidColumn(c) { return COLUMNS.includes(c); }

// A task filename is a flat .md name — no path separators, no traversal.
function isValidFilename(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name) && !name.includes('..');
}

// CORE_SCHEMA deliberately omits the YAML timestamp type, so an unquoted date
// like `created: 2026-06-24` loads as the string "2026-06-24" instead of a JS
// Date (which would otherwise JSON-serialize to an ISO datetime and corrupt the
// field on save). ints/floats/bools still parse normally.
const SCHEMA = yaml.CORE_SCHEMA;

// Split a markdown file into { meta, body } where meta is parsed YAML
// frontmatter (or {} when absent). Tolerant of files with no frontmatter.
function parseTask(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  let meta = {};
  try { meta = yaml.load(m[1], { schema: SCHEMA }) || {}; } catch { meta = {}; }
  if (typeof meta !== 'object' || Array.isArray(meta)) meta = {};
  return { meta, body: m[2] };
}

// Serialize { meta, body } back to a frontmatter markdown file. Omits the
// frontmatter block entirely if meta is empty, matching hand-written tasks.
function serializeTask(meta, body) {
  const keys = Object.keys(meta || {}).filter((k) => meta[k] !== undefined && meta[k] !== null && meta[k] !== '');
  const cleanBody = (body || '').replace(/^\n+/, '');
  if (!keys.length) return cleanBody.endsWith('\n') ? cleanBody : cleanBody + '\n';
  const ordered = {};
  // Preserve the conventional field order seen across the fleet.
  for (const k of ['title', 'priority', 'type', 'estimated_turns', 'created', 'assigned_role']) {
    if (keys.includes(k)) ordered[k] = meta[k];
  }
  for (const k of keys) if (!(k in ordered)) ordered[k] = meta[k];
  const fm = yaml.dump(ordered, { schema: SCHEMA, lineWidth: 100, quotingType: '"', forceQuotes: false }).trimEnd();
  return `---\n${fm}\n---\n\n${cleanBody.replace(/\n+$/, '')}\n`;
}

// Normalize one task file into the flat shape both the per-site board and the
// cross-fleet aggregator render from. Returns null for non-task / unreadable.
function readTaskCard(dir, col, name, slug) {
  if (NON_TASK.has(name) || !name.endsWith('.md')) return null;
  const fp = path.join(dir, name);
  let st; try { st = fs.statSync(fp); } catch { return null; }
  if (!st.isFile()) return null;
  const { meta, body } = parseTask(fs.readFileSync(fp, 'utf8'));
  const excerpt = body.replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const prio = meta.priority;
  return {
    site: slug, file: name, column: col,
    title: meta.title || name.replace(/\.md$/, ''),
    priority: prio === undefined || prio === null || prio === '' ? null : Number(prio),
    type: meta.type || null,
    assigned_role: meta.assigned_role || null,
    created: meta.created ? String(meta.created) : null,
    estimated_turns: meta.estimated_turns ?? null,
    blocked_on: meta.blocked_on ? String(meta.blocked_on) : '',
    excerpt,
    mtime: st.mtimeMs,
    birthtime: st.birthtimeMs || st.ctimeMs || null,
  };
}

// List every task across all columns for one site (per-site board view).
function list(root, slug) {
  const base = tasksDir(root, slug);
  const out = {};
  for (const col of COLUMNS) {
    out[col] = [];
    const dir = path.join(base, col);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    for (const name of names.sort()) {
      const card = readTaskCard(dir, col, name, slug);
      if (card) out[col].push(card);
    }
  }
  return out;
}

// Aggregate every task across every site (cross-fleet view — the integrated
// successor to site-tracker's /tasks page). Returns a flat array; the client
// does the faceting, filtering, grouping and counting.
function listAll(root, slugs) {
  const all = [];
  for (const slug of slugs) {
    const base = tasksDir(root, slug);
    for (const col of COLUMNS) {
      const dir = path.join(base, col);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names.sort()) {
        const card = readTaskCard(dir, col, name, slug);
        if (card) all.push(card);
      }
    }
  }
  return all;
}

// Read one task's full content + parsed parts for the editor.
function get(root, slug, column, file) {
  if (!isValidColumn(column) || !isValidFilename(file)) throw httpErr(400, 'bad column or filename');
  const fp = path.join(tasksDir(root, slug), column, file);
  if (!fs.existsSync(fp)) throw httpErr(404, 'task not found');
  const raw = fs.readFileSync(fp, 'utf8');
  const { meta, body } = parseTask(raw);
  return { file, column, meta, body, raw };
}

// Slugify a title into a filename stem.
function slugify(s) {
  return String(s || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'task';
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Create a new task file in `column`. Returns the created filename. Generates a
// `YYYY-MM-DD-<slug>.md` name and de-duplicates with -2, -3, … if it collides.
function create(root, slug, column, payload) {
  if (!isValidColumn(column)) throw httpErr(400, 'bad column');
  const meta = {
    title: payload.title || 'Untitled task',
    priority: payload.priority != null && payload.priority !== '' ? Number(payload.priority) : undefined,
    type: payload.type || undefined,
    estimated_turns: payload.estimated_turns != null && payload.estimated_turns !== '' ? Number(payload.estimated_turns) : undefined,
    created: payload.created || today(),
    assigned_role: payload.assigned_role || undefined,
  };
  const dir = path.join(tasksDir(root, slug), column);
  fs.mkdirSync(dir, { recursive: true });
  const stem = `${meta.created}-${slugify(payload.title)}`;
  let name = `${stem}.md`, n = 2;
  while (fs.existsSync(path.join(dir, name))) { name = `${stem}-${n}.md`; n += 1; }
  fs.writeFileSync(path.join(dir, name), serializeTask(meta, payload.body || ''));
  return name;
}

// Overwrite an existing task's frontmatter + body in place.
function update(root, slug, column, file, payload) {
  if (!isValidColumn(column) || !isValidFilename(file)) throw httpErr(400, 'bad column or filename');
  const fp = path.join(tasksDir(root, slug), column, file);
  if (!fs.existsSync(fp)) throw httpErr(404, 'task not found');
  const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
  fs.writeFileSync(fp, serializeTask(meta, payload.body || ''));
  return file;
}

// Move a task between columns (plain fs rename — the engineer/committer picks
// up the change on its next pass; we never commit here).
function move(root, slug, fromCol, file, toCol) {
  if (!isValidColumn(fromCol) || !isValidColumn(toCol) || !isValidFilename(file)) throw httpErr(400, 'bad column or filename');
  const from = path.join(tasksDir(root, slug), fromCol, file);
  if (!fs.existsSync(from)) throw httpErr(404, 'task not found');
  const toDir = path.join(tasksDir(root, slug), toCol);
  fs.mkdirSync(toDir, { recursive: true });
  let dest = path.join(toDir, file), name = file, n = 2;
  while (fs.existsSync(dest)) { name = file.replace(/\.md$/, `-${n}.md`); dest = path.join(toDir, name); n += 1; }
  fs.renameSync(from, dest);
  return { column: toCol, file: name };
}

// Soft delete (F8): instead of unlinking, move the task into ops/tasks/.trash/
// so an accidental delete is recoverable. The `.trash` dir is hidden and not one
// of COLUMNS, so it never shows on the board or in listAll(). Name is prefixed
// with its origin column and de-duplicated so repeated deletes don't collide.
function remove(root, slug, column, file) {
  if (!isValidColumn(column) || !isValidFilename(file)) throw httpErr(400, 'bad column or filename');
  const fp = path.join(tasksDir(root, slug), column, file);
  if (!fs.existsSync(fp)) throw httpErr(404, 'task not found');
  const trashDir = path.join(tasksDir(root, slug), '.trash');
  fs.mkdirSync(trashDir, { recursive: true });
  let name = `${column}__${file}`;
  let dest = path.join(trashDir, name);
  let n = 2;
  while (fs.existsSync(dest)) { name = `${column}__${file.replace(/\.md$/, `-${n}.md`)}`; dest = path.join(trashDir, name); n += 1; }
  fs.renameSync(fp, dest);
  return { ok: true, trashed: name };
}

function httpErr(status, msg) { const e = new Error(msg); e.httpStatus = status; return e; }

module.exports = { COLUMNS, list, listAll, get, create, update, move, remove, parseTask, serializeTask };
