'use strict';

// Durable relationship/event store for the fleet control plane. This is not a
// replacement for source-owned telemetry; it records the joins between signals,
// work, runs and outcomes so those systems can be followed as one causal chain.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const TYPES = /^[a-z][a-z0-9_.-]{1,79}$/;

function open(root, { file } = {}) {
  const dbFile = file || path.join(root, 'tools', 'fleet-dashboard', 'data', 'fleet-events.sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      site_id TEXT,
      entity_type TEXT,
      entity_id TEXT,
      correlation_id TEXT,
      causation_id TEXT,
      source TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS events_site_time ON events(site_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS events_correlation ON events(correlation_id, occurred_at);
    CREATE INDEX IF NOT EXISTS events_entity ON events(entity_type, entity_id, occurred_at);
    CREATE TABLE IF NOT EXISTS improvement_runs (
      run_id TEXT PRIMARY KEY,
      site TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT,
      correlation_id TEXT NOT NULL,
      task_id TEXT,
      task_file TEXT,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      measurement_due TEXT,
      branch TEXT,
      preview_url TEXT,
      deployment_id TEXT,
      workspace_path TEXT,
      production_before TEXT,
      baseline_json TEXT NOT NULL DEFAULT '{}',
      validation_json TEXT NOT NULL DEFAULT '{}',
      outcome_json TEXT NOT NULL DEFAULT '{}',
      sandbox_json TEXT NOT NULL DEFAULT '{}',
      agent_json TEXT NOT NULL DEFAULT '{}',
      approval_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS improvement_runs_site ON improvement_runs(site, updated_at DESC);
    CREATE INDEX IF NOT EXISTS improvement_runs_source ON improvement_runs(source, source_id);
    CREATE INDEX IF NOT EXISTS improvement_runs_state ON improvement_runs(state, updated_at DESC);
  `);
  ensureColumn(db, 'improvement_runs', 'workspace_path', 'TEXT');
  ensureColumn(db, 'improvement_runs', 'production_before', 'TEXT');
  ensureColumn(db, 'improvement_runs', 'sandbox_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'improvement_runs', 'agent_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'improvement_runs', 'approval_json', "TEXT NOT NULL DEFAULT '{}'");

  function record(input) {
    if (!input || !TYPES.test(String(input.event_type || ''))) throw httpErr(400, 'invalid event_type');
    if (!TYPES.test(String(input.source || ''))) throw httpErr(400, 'invalid event source');
    const event = {
      event_id: input.event_id || crypto.randomUUID(),
      event_type: String(input.event_type),
      occurred_at: input.occurred_at || new Date().toISOString(),
      site_id: input.site_id || null,
      entity_type: input.entity_type || null,
      entity_id: input.entity_id || null,
      correlation_id: input.correlation_id || input.event_id || null,
      causation_id: input.causation_id || null,
      source: String(input.source),
      schema_version: Number(input.schema_version) || 1,
      payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
    };
    if (!event.correlation_id) event.correlation_id = event.event_id;
    db.prepare(`INSERT INTO events
      (event_id,event_type,occurred_at,site_id,entity_type,entity_id,correlation_id,causation_id,source,schema_version,payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      event.event_id, event.event_type, event.occurred_at, event.site_id,
      event.entity_type, event.entity_id, event.correlation_id, event.causation_id,
      event.source, event.schema_version, JSON.stringify(event.payload)
    );
    return event;
  }

  function recordOnce(input) {
    try { return record(input); }
    catch (error) {
      if (String(error.message || error).includes('UNIQUE constraint failed'))
        return db.prepare('SELECT event_id FROM events WHERE event_id = ?').get(String(input.event_id)) || null;
      throw error;
    }
  }

  function list({ site_id, correlation_id, entity_type, entity_id, event_type, limit = 200 } = {}) {
    const clauses = [], args = [];
    for (const [column, value] of Object.entries({ site_id, correlation_id, entity_type, entity_id, event_type })) {
      if (value == null || value === '') continue;
      clauses.push(`${column} = ?`); args.push(String(value));
    }
    const n = Math.max(1, Math.min(Number(limit) || 200, 2000));
    const sql = `SELECT * FROM events${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY occurred_at DESC LIMIT ?`;
    return db.prepare(sql).all(...args, n).map(row => ({
      ...row, payload: safeJson(row.payload_json), payload_json: undefined,
    }));
  }

  function close() { db.close(); }

  function createImprovement(input) {
    const now = input.created_at || new Date().toISOString();
    const row = {
      run_id: input.run_id || crypto.randomUUID(), site: String(input.site || ''),
      source: String(input.source || ''), source_id: input.source_id || null,
      correlation_id: input.correlation_id || `improvement:${crypto.randomUUID()}`,
      task_id: input.task_id || null, task_file: input.task_file || null,
      title: String(input.title || ''), state: input.state || 'proposed',
      created_at: now, updated_at: now, measurement_due: input.measurement_due || null,
      branch: input.branch || null, preview_url: input.preview_url || null,
      deployment_id: input.deployment_id || null, workspace_path: input.workspace_path || null,
      production_before: input.production_before || null, baseline: input.baseline || {},
      validation: input.validation || {}, outcome: input.outcome || {}, sandbox: input.sandbox || {},
      agent: input.agent || {}, approval: input.approval || {},
    };
    if (!row.site || !row.source || !row.title) throw httpErr(400, 'site, source and title are required');
    db.prepare(`INSERT INTO improvement_runs
      (run_id,site,source,source_id,correlation_id,task_id,task_file,title,state,created_at,updated_at,measurement_due,branch,preview_url,deployment_id,workspace_path,production_before,baseline_json,validation_json,outcome_json,sandbox_json,agent_json,approval_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.run_id, row.site, row.source, row.source_id, row.correlation_id, row.task_id,
      row.task_file, row.title, row.state, row.created_at, row.updated_at,
      row.measurement_due, row.branch, row.preview_url, row.deployment_id, row.workspace_path,
      row.production_before, JSON.stringify(row.baseline), JSON.stringify(row.validation), JSON.stringify(row.outcome),
      JSON.stringify(row.sandbox), JSON.stringify(row.agent), JSON.stringify(row.approval));
    return row;
  }

  function listImprovements({ site, state, source, source_id, limit = 250 } = {}) {
    const clauses = [], args = [];
    for (const [column, value] of Object.entries({ site, state, source, source_id })) {
      if (value == null || value === '') continue;
      clauses.push(`${column} = ?`); args.push(String(value));
    }
    const n = Math.max(1, Math.min(Number(limit) || 250, 1000));
    return db.prepare(`SELECT * FROM improvement_runs${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`)
      .all(...args, n).map(decodeImprovement);
  }

  function getImprovement(runId) {
    const row = db.prepare('SELECT * FROM improvement_runs WHERE run_id = ?').get(String(runId));
    return row ? decodeImprovement(row) : null;
  }

  function updateImprovement(runId, patch) {
    const current = getImprovement(runId);
    if (!current) throw httpErr(404, 'improvement run not found');
    const allowed = ['state', 'branch', 'preview_url', 'deployment_id', 'measurement_due', 'workspace_path', 'production_before'];
    const next = { ...current };
    for (const key of allowed) if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key] || null;
    for (const key of ['baseline', 'validation', 'outcome', 'sandbox', 'agent', 'approval']) {
      if (patch[key] && typeof patch[key] === 'object') next[key] = { ...current[key], ...patch[key] };
    }
    next.updated_at = new Date().toISOString();
    db.prepare(`UPDATE improvement_runs SET state=?,updated_at=?,measurement_due=?,branch=?,preview_url=?,deployment_id=?,workspace_path=?,production_before=?,baseline_json=?,validation_json=?,outcome_json=?,sandbox_json=?,agent_json=?,approval_json=? WHERE run_id=?`)
      .run(next.state, next.updated_at, next.measurement_due, next.branch, next.preview_url,
        next.deployment_id, next.workspace_path, next.production_before, JSON.stringify(next.baseline), JSON.stringify(next.validation),
        JSON.stringify(next.outcome), JSON.stringify(next.sandbox), JSON.stringify(next.agent), JSON.stringify(next.approval), String(runId));
    return getImprovement(runId);
  }

  return { record, recordOnce, list, createImprovement, listImprovements, getImprovement, updateImprovement, close, file: dbFile };
}

function safeJson(value) { try { return JSON.parse(value); } catch { return {}; } }
function decodeImprovement(row) {
  return { ...row, baseline: safeJson(row.baseline_json), validation: safeJson(row.validation_json),
    outcome: safeJson(row.outcome_json), sandbox: safeJson(row.sandbox_json), agent: safeJson(row.agent_json),
    approval: safeJson(row.approval_json), baseline_json: undefined, validation_json: undefined, outcome_json: undefined,
    sandbox_json: undefined, agent_json: undefined, approval_json: undefined };
}
function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function httpErr(status, message) { const e = new Error(message); e.httpStatus = status; return e; }

module.exports = { open };
