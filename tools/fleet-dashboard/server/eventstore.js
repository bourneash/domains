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
  `);

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
  return { record, recordOnce, list, close, file: dbFile };
}

function safeJson(value) { try { return JSON.parse(value); } catch { return {}; } }
function httpErr(status, message) { const e = new Error(message); e.httpStatus = status; return e; }

module.exports = { open };
