'use strict';

// Cross-language format guard for the AI Optimizer queue.
//
// Two processes write these ticket files: the Python analyst CLI
// (tools/ai-optimizer/lib/ai_optimizer.py) and this Node module, whenever a
// human approves/rejects from the dashboard. Python reads them with a flat
// one-line-per-key parser, NOT a full YAML parser (deliberately — the fleet's
// worker containers mostly lack PyYAML, same constraint tools/task-budget
// documents).
//
// So js-yaml MUST stay inside that subset. It does not by default: with
// folding on it emits `>-` block scalars for long strings and block-style
// lists, and during bring-up that silently ate `sites` and `evidence_files`
// off a real ticket after one approve round-trip. These tests fail if that
// ever regresses.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ai = require('./aioptimizer');

const PY_LIB = path.resolve(__dirname, '..', '..', 'ai-optimizer', 'lib');

// Deliberately hostile: em-dash, colons, commas, quotes, and long enough that
// js-yaml would fold it if line-width folding were left on.
const NASTY_TITLE =
  'voice-auditor costs ~$1.05/call — 5 rewrites, "in place", per run: a title long enough that js-yaml would fold it into a block scalar under default options';
const NASTY_GIT =
  'git log -3 ops/roles/voice-auditor.md — last tuned cc470e57 (2026-08-23, cap 40->70); cost continued after, so this is current, not pre-fix telemetry';

function pyParse(file) {
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(PY_LIB)})
import ai_optimizer as q
meta, body = q.parse(open(${JSON.stringify(file)}, encoding="utf-8").read())
print(json.dumps({"meta": meta, "body": body}))
`;
  return JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf8' }));
}

test('Node-written frontmatter survives the Python flat parser intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-xl-'));
  const fp = path.join(dir, 't.md');
  const meta = {
    ticket_id: 't1',
    status: 'approved',
    title: NASTY_TITLE,
    created: '2026-08-25',
    finding_class: 'rewrite-scope-cost',
    dedupe_key: 'b644e751ae31198e',
    scope: 'site',
    sites: ['sinderella.org', 'rodhat.com'],
    role: 'voice-auditor',
    window_from: '2026-08-11',
    window_to: '2026-08-25',
    measured_cost_usd: 29.38,
    estimated_savings_usd_per_day: 0.8,
    risk: 'medium',
    verified_current_code: true,
    verified_git_check: NASTY_GIT,
    evidence_files: [
      'sites/sinderella.org/ops/roles/voice-auditor.md:40',
      'sites/sinderella.org/ops/scripts/run-role.sh:501',
    ],
    decision_note: 'approved: worth it, watch the pending count',
  };
  fs.writeFileSync(fp, ai.serializeTicket(meta, '## Problem\n\nBody text.'));

  const raw = fs.readFileSync(fp, 'utf8');
  assert.ok(!/:\s*>-?\s*$/m.test(raw), 'must not emit folded block scalars');
  assert.ok(!/^\s+-\s/m.test(raw.split('---')[1]), 'must not emit block-style lists');

  const { meta: back } = pyParse(fp);
  assert.equal(back.title, NASTY_TITLE, 'title survives folding + quoting');
  assert.equal(back.verified_git_check, NASTY_GIT);
  assert.deepEqual(back.sites, ['sinderella.org', 'rodhat.com'], 'sites list survives');
  assert.deepEqual(back.evidence_files, meta.evidence_files, 'evidence_files survives');
  assert.strictEqual(back.verified_current_code, true, 'booleans stay booleans');
  assert.strictEqual(back.measured_cost_usd, 29.38, 'floats stay floats');
});

test('Python-written frontmatter round-trips through the Node parser', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-xl2-'));
  const fp = path.join(dir, 't.md');
  const code = `
import sys
sys.path.insert(0, ${JSON.stringify(PY_LIB)})
import ai_optimizer as q
meta = {
  "ticket_id": "t1", "status": "proposed", "title": ${JSON.stringify(NASTY_TITLE)},
  "scope": "site", "sites": ["sinderella.org"], "role": "voice-auditor",
  "measured_cost_usd": 29.38, "verified_current_code": True,
  "verified_git_check": ${JSON.stringify(NASTY_GIT)},
  "evidence_files": ["a/b.md:40", "c/d.sh:501"],
}
open(${JSON.stringify(fp)}, "w", encoding="utf-8").write(q.serialize(meta, "## Problem\\n\\nBody."))
`;
  execFileSync('python3', ['-c', code]);
  const { meta: back, body } = ai.parseTicket(fs.readFileSync(fp, 'utf8'));
  assert.equal(back.title, NASTY_TITLE);
  assert.equal(back.verified_git_check, NASTY_GIT);
  assert.deepEqual(back.sites, ['sinderella.org']);
  assert.deepEqual(back.evidence_files, ['a/b.md:40', 'c/d.sh:501']);
  assert.strictEqual(back.verified_current_code, true);
  assert.match(body, /Body\./);
});

test('a full approve round-trip preserves every field', () => {
  // The exact path that lost data during bring-up: Python files it, a human
  // approves in the dashboard (Node rewrites the file), Python reads it back.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiopt-rt-'));
  const qdir = path.join(root, 'tools', 'ai-optimizer', 'queue');
  for (const s of ai.STATUSES) fs.mkdirSync(path.join(qdir, s), { recursive: true });
  const code = `
import sys
sys.path.insert(0, ${JSON.stringify(PY_LIB)})
from pathlib import Path
import ai_optimizer as q
meta = {
  "title": ${JSON.stringify(NASTY_TITLE)}, "finding_class": "rewrite-scope-cost",
  "scope": "site", "sites": ["sinderella.org"], "role": "voice-auditor",
  "window_from": "2026-08-11", "window_to": "2026-08-25",
  "measured_cost_usd": 29.38, "risk": "medium", "verified_current_code": True,
  "verified_git_check": ${JSON.stringify(NASTY_GIT)},
  "evidence_files": ["a/b.md:40"],
}
fp, _ = q.file_ticket(meta, "## Problem\\n\\nBody.", root=Path(${JSON.stringify(qdir)}))
print(fp.name)
`;
  const file = execFileSync('python3', ['-c', code], { encoding: 'utf8' }).trim();
  ai.move(root, 'proposed', file, 'approved', { note: 'ok', by: 'jesse' });
  const { meta: back } = pyParse(path.join(qdir, 'approved', file));
  assert.deepEqual(back.sites, ['sinderella.org'], 'sites survived the approve');
  assert.deepEqual(back.evidence_files, ['a/b.md:40'], 'evidence survived the approve');
  assert.equal(back.verified_git_check, NASTY_GIT, 'git check survived the approve');
  assert.equal(back.status, 'approved');
  assert.equal(back.decision_note, 'ok');
});
