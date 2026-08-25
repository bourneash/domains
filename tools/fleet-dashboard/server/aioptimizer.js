'use strict';

// AI Optimizer — fleet AI-cost finding queue, read/written by the dashboard's
// "AI Optimizer" tab. Same file-kanban model as guideQueue.js/tasks.js, but
// FLEET-level rather than per-site: findings routinely span several sites
// (e.g. one verbose-build-output fix that applied to five), so a per-site
// board would have no natural home for them.
//
// The Python side (tools/ai-optimizer/lib/ai_optimizer.py) owns filing and
// validation — the evidence bar that keeps telemetry-only guesses out of the
// queue lives there, because the analyst role is what needs to be held to it.
// This module deliberately does NOT re-implement validation: the dashboard
// only ever *decides* on tickets an analyst already filed (approve / reject /
// defer / mark applied), it never creates them.

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const STATUSES = ['proposed', 'approved', 'applied', 'rejected', 'deferred'];

// Which moves a human is allowed to make from the dashboard. Filing is the
// analyst's job (CLI), so nothing transitions INTO `proposed` here.
const ALLOWED_MOVES = {
  proposed: ['approved', 'rejected', 'deferred'],
  deferred: ['approved', 'rejected'],
  approved: ['applied', 'rejected', 'deferred'],
  rejected: ['deferred'],
  applied: [],
};

const SCHEMA = yaml.CORE_SCHEMA; // keep `created: 2026-08-25` a string, as in tasks.js

function queueRoot(root) {
  return path.join(root, 'tools', 'ai-optimizer', 'queue');
}
function statusDir(root, status) {
  return path.join(queueRoot(root), status);
}

function isValidStatus(s) {
  return STATUSES.includes(s);
}
function isValidFilename(name) {
  return (
    typeof name === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name) &&
    !name.includes('..')
  );
}

function httpErr(status, msg) {
  const e = new Error(msg);
  e.httpStatus = status;
  return e;
}

function parseTicket(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  let meta = {};
  try {
    meta = yaml.load(m[1], { schema: SCHEMA }) || {};
  } catch {
    meta = {};
  }
  if (typeof meta !== 'object' || Array.isArray(meta)) meta = {};
  return { meta, body: m[2] };
}

const FIELD_ORDER = [
  'ticket_id',
  'status',
  'title',
  'created',
  'decided',
  'finding_class',
  'dedupe_key',
  'scope',
  'sites',
  'role',
  'window_from',
  'window_to',
  'measured_cost_usd',
  'estimated_savings_usd_per_day',
  'risk',
  'verified_current_code',
  'verified_git_check',
  'evidence_files',
  'applied_commit',
  'decided_by',
  'decision_note',
];

function serializeTicket(meta, body) {
  const clean = {};
  for (const k of Object.keys(meta || {})) {
    const v = meta[k];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    clean[k] = v;
  }
  const ordered = {};
  for (const k of FIELD_ORDER)
    if (k in clean) {
      ordered[k] = clean[k];
      delete clean[k];
    }
  for (const k of Object.keys(clean)) ordered[k] = clean[k];
  // lineWidth:-1 + flowLevel:1 keep this inside the flat single-line-per-key
  // subset the Python side parses (tools/ai-optimizer/lib/ai_optimizer.py).
  // Without them js-yaml folds long strings into `>-` block scalars and writes
  // block-style lists, and the Python flat parser silently drops both — which
  // ate `sites` and `evidence_files` off a real ticket during bring-up.
  // aioptimizer.crosslang.test.js guards this both ways.
  const fm = yaml
    .dump(ordered, {
      schema: SCHEMA,
      lineWidth: -1,
      flowLevel: 1,
      quotingType: '"',
      forceQuotes: false,
    })
    .trimEnd();
  const cleanBody = (body || '').replace(/^\n+/, '').replace(/\n+$/, '');
  return `---\n${fm}\n---\n\n${cleanBody}\n`;
}

function readCard(dir, status, name) {
  if (!name.endsWith('.md')) return null;
  const fp = path.join(dir, name);
  let st;
  try {
    st = fs.statSync(fp);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const { meta, body } = parseTicket(fs.readFileSync(fp, 'utf8'));
  const excerpt = body.replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const sites = Array.isArray(meta.sites) ? meta.sites : meta.sites ? [meta.sites] : [];
  return {
    file: name,
    status,
    ticket_id: meta.ticket_id || name.replace(/\.md$/, ''),
    title: meta.title || name.replace(/\.md$/, ''),
    finding_class: meta.finding_class || null,
    scope: meta.scope || null,
    sites,
    role: meta.role || null,
    risk: meta.risk || null,
    measured_cost_usd: Number(meta.measured_cost_usd) || 0,
    estimated_savings_usd_per_day:
      meta.estimated_savings_usd_per_day != null
        ? Number(meta.estimated_savings_usd_per_day)
        : null,
    window_from: meta.window_from ? String(meta.window_from) : null,
    window_to: meta.window_to ? String(meta.window_to) : null,
    created: meta.created ? String(meta.created) : null,
    decided: meta.decided ? String(meta.decided) : null,
    verified_git_check: meta.verified_git_check || null,
    evidence_files: Array.isArray(meta.evidence_files) ? meta.evidence_files : [],
    applied_commit: meta.applied_commit || null,
    decision_note: meta.decision_note || null,
    allowed_moves: ALLOWED_MOVES[status] || [],
    excerpt,
    mtime: st.mtimeMs,
  };
}

// Every ticket across every column, newest-decision-first within each column.
function list(root) {
  const out = {};
  for (const status of STATUSES) {
    out[status] = [];
    const dir = statusDir(root, status);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    for (const name of names.sort()) {
      const card = readCard(dir, status, name);
      if (card) out[status].push(card);
    }
    out[status].sort((a, b) => (b.measured_cost_usd || 0) - (a.measured_cost_usd || 0));
  }
  return out;
}

function get(root, status, file) {
  if (!isValidStatus(status) || !isValidFilename(file))
    throw httpErr(400, 'bad status or filename');
  const fp = path.join(statusDir(root, status), file);
  if (!fs.existsSync(fp)) throw httpErr(404, 'ticket not found');
  const { meta, body } = parseTicket(fs.readFileSync(fp, 'utf8'));
  return { file, status, meta, body, allowed_moves: ALLOWED_MOVES[status] || [] };
}

// Approve / reject / defer / mark-applied. Mirrors guideQueue.move(): a plain
// rename plus a frontmatter status sync, no commit — the implementer script
// and the next analyst run both read state from the directory.
function move(root, fromStatus, file, toStatus, payload = {}) {
  if (!isValidStatus(fromStatus) || !isValidStatus(toStatus) || !isValidFilename(file)) {
    throw httpErr(400, 'bad status or filename');
  }
  const allowed = ALLOWED_MOVES[fromStatus] || [];
  if (!allowed.includes(toStatus)) {
    throw httpErr(
      400,
      `cannot move ${fromStatus} -> ${toStatus} (allowed: ${allowed.join(', ') || 'none'})`
    );
  }
  const from = path.join(statusDir(root, fromStatus), file);
  if (!fs.existsSync(from)) throw httpErr(404, 'ticket not found');

  const { meta, body } = parseTicket(fs.readFileSync(from, 'utf8'));
  meta.status = toStatus;
  meta.decided = new Date().toISOString().slice(0, 10);
  if (payload.note) meta.decision_note = String(payload.note).slice(0, 500);
  meta.decided_by = payload.by ? String(payload.by).slice(0, 60) : 'dashboard';
  if (payload.commit) meta.applied_commit = String(payload.commit).slice(0, 60);

  const toDir = statusDir(root, toStatus);
  fs.mkdirSync(toDir, { recursive: true });
  let name = file,
    dest = path.join(toDir, name),
    n = 2;
  while (fs.existsSync(dest)) {
    name = file.replace(/\.md$/, `-${n}.md`);
    dest = path.join(toDir, name);
    n += 1;
  }
  fs.writeFileSync(dest, serializeTicket(meta, body));
  fs.unlinkSync(from);
  return { from: fromStatus, to: toStatus, file: name };
}

// --- Kill switches -------------------------------------------------------
// The two cron jobs (fleet-cron 16 + 17) each honour a flag file, same
// convention as every site role's ops/.<role>-disabled — see roles.setEnabled.
// Surfaced here because a kill switch you have to SSH in to flip is one you
// will not reach for at the moment you actually want it.
const JOBS = {
  analyst: {
    flag: '.analyst-disabled',
    label: 'Daily analyst',
    detail: 'Files new findings at 06:45 ET. Off = no new tickets.',
  },
  implement: {
    flag: '.implement-disabled',
    label: 'Implementer',
    detail: 'Applies approved tickets (:11/:31/:51). Off = approvals queue up, nothing changes.',
  },
};

function flagPath(root, job) {
  const j = JOBS[job];
  if (!j) throw httpErr(400, `unknown job ${job}`);
  return path.join(root, 'tools', 'ai-optimizer', j.flag);
}

function toggles(root) {
  return Object.fromEntries(
    Object.entries(JOBS).map(([k, j]) => [
      k,
      { enabled: !fs.existsSync(flagPath(root, k)), label: j.label, detail: j.detail },
    ])
  );
}

function setToggle(root, job, enabled) {
  const fp = flagPath(root, job);
  if (enabled) {
    try {
      fs.unlinkSync(fp);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  } else if (!fs.existsSync(fp)) {
    // Empty file, matching `touch` — the scripts only test for existence.
    fs.writeFileSync(fp, '');
  }
  return { ok: true, job, enabled };
}

// Headline numbers for the tab: what's waiting on a human, and what the
// approved-but-unapplied backlog is theoretically worth per day.
function summary(root) {
  const all = list(root);
  const sum = (rows, k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  return {
    counts: Object.fromEntries(STATUSES.map(s => [s, all[s].length])),
    toggles: toggles(root),
    open_savings_usd_per_day: sum(all.proposed, 'estimated_savings_usd_per_day'),
    approved_savings_usd_per_day: sum(all.approved, 'estimated_savings_usd_per_day'),
    applied_savings_usd_per_day: sum(all.applied, 'estimated_savings_usd_per_day'),
  };
}

module.exports = {
  STATUSES,
  ALLOWED_MOVES,
  JOBS,
  list,
  get,
  move,
  summary,
  toggles,
  setToggle,
  parseTicket,
  serializeTicket,
  queueRoot,
};
