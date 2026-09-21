'use strict';

// Git-visible, non-secret handoffs between executive roles. Runtime telemetry,
// credentials, and provider transcripts stay out of this directory.

const fs = require('node:fs');
const path = require('node:path');

function rootDir(root) {
  return path.join(root, 'ops', 'executive', 'handoffs');
}

function safe(value, fallback = 'fleet') {
  const result = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '-');
  return result || fallback;
}

function write(
  root,
  { role, site = 'fleet', summary, payload = {}, generated_at = new Date().toISOString() }
) {
  if (!role || !summary) throw new Error('handoff role and summary are required');
  const dir = path.join(rootDir(root), safe(role));
  const file = path.join(dir, `${safe(site)}.json`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const document = {
    schema: 'executive-handoff/v1',
    role: safe(role),
    site: safe(site),
    generated_at,
    summary: String(summary).slice(0, 1000),
    payload,
  };
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
  return file;
}

function recent(root, limit = 30) {
  const rows = [];
  const base = rootDir(root);
  for (const role of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    const dir = path.join(base, role);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.json'))) {
      try {
        rows.push(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
      } catch {
        /* ignore partial/corrupt handoffs */
      }
    }
  }
  return rows
    .sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)))
    .slice(0, limit);
}

function writePlan(root, plan, created) {
  const grouped = new Map();
  for (const item of [...(plan.messages || []), ...(plan.proposals || [])]) {
    const role = item.actor || item.created_by || 'ceo';
    if (!grouped.has(role)) grouped.set(role, []);
    grouped.get(role).push({
      kind: item.body ? 'message' : 'proposal',
      title: item.title || null,
      summary: item.summary || item.body || null,
      requested_action: item.requested_action || null,
      proposal_id: created.proposals.find(row => row.title === item.title)?.proposal_id || null,
    });
  }
  for (const [role, items] of grouped) {
    write(root, {
      role,
      summary: `${role} checked in ${items.length} executive handoff item(s)`,
      payload: { items },
    });
  }
}

module.exports = { rootDir, write, recent, writePlan };
