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
      approval_json TEXT NOT NULL DEFAULT '{}',
      preflight_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS improvement_runs_site ON improvement_runs(site, updated_at DESC);
    CREATE INDEX IF NOT EXISTS improvement_runs_source ON improvement_runs(source, source_id);
    CREATE INDEX IF NOT EXISTS improvement_runs_state ON improvement_runs(state, updated_at DESC);
    CREATE TABLE IF NOT EXISTS change_requests (
      request_id TEXT PRIMARY KEY,
      site TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL,
      priority TEXT NOT NULL,
      assigned_role TEXT,
      provider TEXT NOT NULL,
      model TEXT,
      delivery_mode TEXT NOT NULL DEFAULT 'direct',
      action_key TEXT,
      max_turns INTEGER NOT NULL,
      auto_review INTEGER NOT NULL DEFAULT 1,
      voice_transcript TEXT,
      requested_by TEXT,
      source_proposal_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      next_attempt_at TEXT,
      claimed_at TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      run_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS change_requests_queue ON change_requests(status, priority, created_at);
    CREATE TABLE IF NOT EXISTS executive_messages (
      message_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS executive_messages_conversation ON executive_messages(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS executive_proposals (
      proposal_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      proposal_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      rationale TEXT NOT NULL DEFAULT '',
      expected_upside_json TEXT NOT NULL DEFAULT '{}',
      risks_json TEXT NOT NULL DEFAULT '[]',
      requested_action TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decision_note TEXT,
      decided_by TEXT,
      decided_at TEXT,
      linked_request_id TEXT
    );
    CREATE INDEX IF NOT EXISTS executive_proposals_status ON executive_proposals(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS executive_actions (
      action_id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      action_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      proposal_id TEXT,
      request_id TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS executive_actions_time ON executive_actions(started_at DESC);
    CREATE INDEX IF NOT EXISTS executive_actions_actor ON executive_actions(actor, started_at DESC);
    CREATE TABLE IF NOT EXISTS change_queue_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      interval_minutes INTEGER NOT NULL DEFAULT 30,
      max_concurrent INTEGER NOT NULL DEFAULT 1,
      auto_review_enabled INTEGER NOT NULL DEFAULT 1,
      lease_minutes INTEGER NOT NULL DEFAULT 30,
      updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO change_queue_settings (id, updated_at) VALUES (1, datetime('now'));
    CREATE TABLE IF NOT EXISTS executive_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      settings_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO executive_settings (id, updated_at) VALUES (1, datetime('now'));
  `);
  ensureColumn(db, 'improvement_runs', 'workspace_path', 'TEXT');
  ensureColumn(db, 'improvement_runs', 'production_before', 'TEXT');
  ensureColumn(db, 'improvement_runs', 'sandbox_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'improvement_runs', 'agent_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'improvement_runs', 'approval_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'improvement_runs', 'preflight_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'change_requests', 'auto_review', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'change_requests', 'delivery_mode', "TEXT NOT NULL DEFAULT 'direct'");
  ensureColumn(db, 'change_requests', 'action_key', 'TEXT');
  ensureColumn(db, 'change_requests', 'requested_by', 'TEXT');
  ensureColumn(db, 'change_requests', 'source_proposal_id', 'TEXT');
  ensureColumn(db, 'change_requests', 'lease_owner', 'TEXT');
  ensureColumn(db, 'change_requests', 'lease_expires_at', 'TEXT');
  ensureColumn(db, 'change_requests', 'heartbeat_at', 'TEXT');
  ensureColumn(db, 'change_queue_settings', 'auto_review_enabled', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'change_queue_settings', 'lease_minutes', 'INTEGER NOT NULL DEFAULT 30');
  ensureColumn(db, 'executive_proposals', 'implementation_json', "TEXT NOT NULL DEFAULT '{}'");

  function record(input) {
    if (!input || !TYPES.test(String(input.event_type || '')))
      throw httpErr(400, 'invalid event_type');
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
    db.prepare(
      `INSERT INTO events
      (event_id,event_type,occurred_at,site_id,entity_type,entity_id,correlation_id,causation_id,source,schema_version,payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      event.event_id,
      event.event_type,
      event.occurred_at,
      event.site_id,
      event.entity_type,
      event.entity_id,
      event.correlation_id,
      event.causation_id,
      event.source,
      event.schema_version,
      JSON.stringify(event.payload)
    );
    return event;
  }

  function recordOnce(input) {
    try {
      return record(input);
    } catch (error) {
      if (String(error.message || error).includes('UNIQUE constraint failed'))
        return (
          db
            .prepare('SELECT event_id FROM events WHERE event_id = ?')
            .get(String(input.event_id)) || null
        );
      throw error;
    }
  }

  function list({ site_id, correlation_id, entity_type, entity_id, event_type, limit = 200 } = {}) {
    const clauses = [],
      args = [];
    for (const [column, value] of Object.entries({
      site_id,
      correlation_id,
      entity_type,
      entity_id,
      event_type,
    })) {
      if (value == null || value === '') continue;
      clauses.push(`${column} = ?`);
      args.push(String(value));
    }
    const n = Math.max(1, Math.min(Number(limit) || 200, 2000));
    const sql = `SELECT * FROM events${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY occurred_at DESC LIMIT ?`;
    return db
      .prepare(sql)
      .all(...args, n)
      .map(row => ({
        ...row,
        payload: safeJson(row.payload_json),
        payload_json: undefined,
      }));
  }

  function close() {
    db.close();
  }

  function createImprovement(input) {
    const now = input.created_at || new Date().toISOString();
    const row = {
      run_id: input.run_id || crypto.randomUUID(),
      site: String(input.site || ''),
      source: String(input.source || ''),
      source_id: input.source_id || null,
      correlation_id: input.correlation_id || `improvement:${crypto.randomUUID()}`,
      task_id: input.task_id || null,
      task_file: input.task_file || null,
      title: String(input.title || ''),
      state: input.state || 'proposed',
      created_at: now,
      updated_at: now,
      measurement_due: input.measurement_due || null,
      branch: input.branch || null,
      preview_url: input.preview_url || null,
      deployment_id: input.deployment_id || null,
      workspace_path: input.workspace_path || null,
      production_before: input.production_before || null,
      baseline: input.baseline || {},
      validation: input.validation || {},
      outcome: input.outcome || {},
      sandbox: input.sandbox || {},
      agent: input.agent || {},
      approval: input.approval || {},
      preflight: input.preflight || {},
    };
    if (!row.site || !row.source || !row.title)
      throw httpErr(400, 'site, source and title are required');
    db.prepare(
      `INSERT INTO improvement_runs
      (run_id,site,source,source_id,correlation_id,task_id,task_file,title,state,created_at,updated_at,measurement_due,branch,preview_url,deployment_id,workspace_path,production_before,baseline_json,validation_json,outcome_json,sandbox_json,agent_json,approval_json,preflight_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.run_id,
      row.site,
      row.source,
      row.source_id,
      row.correlation_id,
      row.task_id,
      row.task_file,
      row.title,
      row.state,
      row.created_at,
      row.updated_at,
      row.measurement_due,
      row.branch,
      row.preview_url,
      row.deployment_id,
      row.workspace_path,
      row.production_before,
      JSON.stringify(row.baseline),
      JSON.stringify(row.validation),
      JSON.stringify(row.outcome),
      JSON.stringify(row.sandbox),
      JSON.stringify(row.agent),
      JSON.stringify(row.approval),
      JSON.stringify(row.preflight)
    );
    return row;
  }

  function listImprovements({ site, state, source, source_id, limit = 250 } = {}) {
    const clauses = [],
      args = [];
    for (const [column, value] of Object.entries({ site, state, source, source_id })) {
      if (value == null || value === '') continue;
      clauses.push(`${column} = ?`);
      args.push(String(value));
    }
    const n = Math.max(1, Math.min(Number(limit) || 250, 1000));
    return db
      .prepare(
        `SELECT * FROM improvement_runs${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`
      )
      .all(...args, n)
      .map(decodeImprovement);
  }

  function getImprovement(runId) {
    const row = db.prepare('SELECT * FROM improvement_runs WHERE run_id = ?').get(String(runId));
    return row ? decodeImprovement(row) : null;
  }

  function updateImprovement(runId, patch) {
    const current = getImprovement(runId);
    if (!current) throw httpErr(404, 'improvement run not found');
    const allowed = [
      'state',
      'branch',
      'preview_url',
      'deployment_id',
      'measurement_due',
      'workspace_path',
      'production_before',
    ];
    const next = { ...current };
    for (const key of allowed)
      if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key] || null;
    for (const key of [
      'baseline',
      'validation',
      'outcome',
      'sandbox',
      'agent',
      'approval',
      'preflight',
    ]) {
      if (patch[key] && typeof patch[key] === 'object')
        next[key] = { ...current[key], ...patch[key] };
    }
    next.updated_at = new Date().toISOString();
    db.prepare(
      `UPDATE improvement_runs SET state=?,updated_at=?,measurement_due=?,branch=?,preview_url=?,deployment_id=?,workspace_path=?,production_before=?,baseline_json=?,validation_json=?,outcome_json=?,sandbox_json=?,agent_json=?,approval_json=?,preflight_json=? WHERE run_id=?`
    ).run(
      next.state,
      next.updated_at,
      next.measurement_due,
      next.branch,
      next.preview_url,
      next.deployment_id,
      next.workspace_path,
      next.production_before,
      JSON.stringify(next.baseline),
      JSON.stringify(next.validation),
      JSON.stringify(next.outcome),
      JSON.stringify(next.sandbox),
      JSON.stringify(next.agent),
      JSON.stringify(next.approval),
      JSON.stringify(next.preflight),
      String(runId)
    );
    return getImprovement(runId);
  }

  function createChangeRequest(input) {
    const now = input.created_at || new Date().toISOString();
    const row = {
      request_id: input.request_id || crypto.randomUUID(),
      site: String(input.site || ''),
      title: String(input.title || '').trim(),
      body: String(input.body || ''),
      category: String(input.category || 'other'),
      priority: String(input.priority || 'medium'),
      assigned_role: input.assigned_role || null,
      provider: String(input.provider || 'claude'),
      model: input.model || null,
      delivery_mode: String(input.delivery_mode || 'direct'),
      action_key: input.action_key || null,
      max_turns: Number(input.max_turns || 20),
      auto_review: input.auto_review === false || input.auto_review === 0 ? 0 : 1,
      voice_transcript: input.voice_transcript || null,
      requested_by: input.requested_by || null,
      source_proposal_id: input.source_proposal_id || null,
      status: input.status || 'queued',
      created_at: now,
      updated_at: now,
      next_attempt_at: input.next_attempt_at || now,
      claimed_at: null,
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
      run_id: null,
      attempts: 0,
      error: null,
    };
    if (!row.site || !row.title) throw httpErr(400, 'site and title are required');
    db.prepare(
      `INSERT INTO change_requests
      (request_id,site,title,body,category,priority,assigned_role,provider,model,delivery_mode,action_key,max_turns,auto_review,voice_transcript,requested_by,source_proposal_id,status,created_at,updated_at,next_attempt_at,claimed_at,lease_owner,lease_expires_at,heartbeat_at,run_id,attempts,error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.request_id,
      row.site,
      row.title,
      row.body,
      row.category,
      row.priority,
      row.assigned_role,
      row.provider,
      row.model,
      row.delivery_mode,
      row.action_key,
      row.max_turns,
      row.auto_review,
      row.voice_transcript,
      row.requested_by,
      row.source_proposal_id,
      row.status,
      row.created_at,
      row.updated_at,
      row.next_attempt_at,
      row.claimed_at,
      row.lease_owner,
      row.lease_expires_at,
      row.heartbeat_at,
      row.run_id,
      row.attempts,
      row.error
    );
    return row;
  }

  function listChangeRequests({
    status,
    site,
    category,
    priority,
    provider,
    assigned_role,
    q,
    limit = 250,
  } = {}) {
    const clauses = [],
      args = [];
    if (status) {
      clauses.push('status = ?');
      args.push(String(status));
    }
    if (site) {
      clauses.push('site = ?');
      args.push(String(site));
    }
    if (category) {
      clauses.push('category = ?');
      args.push(String(category));
    }
    if (priority) {
      clauses.push('priority = ?');
      args.push(String(priority));
    }
    if (provider) {
      clauses.push('provider = ?');
      args.push(String(provider));
    }
    if (assigned_role) {
      clauses.push('assigned_role = ?');
      args.push(String(assigned_role));
    }
    if (q) {
      clauses.push('(title LIKE ? OR body LIKE ? OR site LIKE ? OR assigned_role LIKE ?)');
      const term = `%${String(q)}%`;
      args.push(term, term, term, term);
    }
    const n = Math.max(1, Math.min(Number(limit) || 250, 1000));
    return db
      .prepare(
        `SELECT * FROM change_requests${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at ASC LIMIT ?`
      )
      .all(...args, n);
  }

  function getChangeRequest(id) {
    return db.prepare('SELECT * FROM change_requests WHERE request_id = ?').get(String(id)) || null;
  }

  // Queue claims are compare-and-set operations. This prevents two dashboard
  // processes from both observing the same queued row and launching duplicate
  // work before either process writes its claimed status.
  function claimQueuedChangeRequest(id, { owner, claimedAt, leaseExpiresAt } = {}) {
    const result = db
      .prepare(
        `UPDATE change_requests SET status='claimed', claimed_at=?, updated_at=?, lease_owner=?, lease_expires_at=?, heartbeat_at=?, attempts=attempts+1
      WHERE request_id=? AND status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`
      )
      .run(claimedAt, claimedAt, owner, leaseExpiresAt, claimedAt, String(id), claimedAt);
    return result.changes === 1 ? getChangeRequest(id) : null;
  }

  // Recovery uses the same compare-and-set principle. The first dashboard to
  // acquire the expired lease owns cleanup; other dashboards see no change.
  function claimExpiredChangeRequest(id, { owner, now, leaseExpiresAt, fallbackCutoff } = {}) {
    const result = db
      .prepare(
        `UPDATE change_requests SET lease_owner=?, lease_expires_at=?, heartbeat_at=?, updated_at=?
      WHERE request_id=? AND status IN ('claimed','running','reviewing') AND
      ((lease_expires_at IS NOT NULL AND lease_expires_at <= ?) OR (lease_expires_at IS NULL AND updated_at <= ?))`
      )
      .run(owner, leaseExpiresAt, now, now, String(id), now, fallbackCutoff || now);
    return result.changes === 1 ? getChangeRequest(id) : null;
  }

  function updateChangeRequest(id, patch) {
    const current = getChangeRequest(id);
    if (!current) throw httpErr(404, 'change request not found');
    const allowed = [
      'site',
      'title',
      'body',
      'category',
      'priority',
      'assigned_role',
      'provider',
      'delivery_mode',
      'action_key',
      'model',
      'max_turns',
      'auto_review',
      'voice_transcript',
      'requested_by',
      'source_proposal_id',
      'status',
      'next_attempt_at',
      'claimed_at',
      'lease_owner',
      'lease_expires_at',
      'heartbeat_at',
      'run_id',
      'attempts',
      'error',
      'updated_at',
    ];
    const next = {
      ...current,
      ...Object.fromEntries(allowed.filter(k => Object.hasOwn(patch, k)).map(k => [k, patch[k]])),
    };
    next.updated_at = new Date().toISOString();
    db.prepare(
      `UPDATE change_requests SET site=?,title=?,body=?,category=?,priority=?,assigned_role=?,provider=?,model=?,delivery_mode=?,action_key=?,max_turns=?,auto_review=?,voice_transcript=?,requested_by=?,source_proposal_id=?,status=?,updated_at=?,next_attempt_at=?,claimed_at=?,lease_owner=?,lease_expires_at=?,heartbeat_at=?,run_id=?,attempts=?,error=? WHERE request_id=?`
    ).run(
      next.site,
      next.title,
      next.body,
      next.category,
      next.priority,
      next.assigned_role,
      next.provider,
      next.model,
      next.delivery_mode,
      next.action_key,
      next.max_turns,
      next.auto_review ? 1 : 0,
      next.voice_transcript,
      next.requested_by,
      next.source_proposal_id,
      next.status,
      next.updated_at,
      next.next_attempt_at,
      next.claimed_at,
      next.lease_owner,
      next.lease_expires_at,
      next.heartbeat_at,
      next.run_id,
      next.attempts,
      next.error,
      String(id)
    );
    return getChangeRequest(id);
  }

  function getChangeQueueSettings() {
    const row = db.prepare('SELECT * FROM change_queue_settings WHERE id = 1').get();
    return {
      ...row,
      enabled: Boolean(row.enabled),
      auto_review_enabled: Boolean(row.auto_review_enabled),
    };
  }

  function updateChangeQueueSettings(patch) {
    const current = getChangeQueueSettings();
    const next = { ...current, ...patch };
    db.prepare(
      'UPDATE change_queue_settings SET enabled=?,interval_minutes=?,max_concurrent=?,auto_review_enabled=?,lease_minutes=?,updated_at=? WHERE id=1'
    ).run(
      next.enabled ? 1 : 0,
      Number(next.interval_minutes),
      Number(next.max_concurrent),
      next.auto_review_enabled ? 1 : 0,
      Number(next.lease_minutes),
      new Date().toISOString()
    );
    return getChangeQueueSettings();
  }

  function getExecutiveSettings() {
    const row = db.prepare('SELECT * FROM executive_settings WHERE id = 1').get();
    return { ...safeJson(row?.settings_json || '{}'), updated_at: row?.updated_at || null };
  }

  function updateExecutiveSettings(patch = {}) {
    const current = getExecutiveSettings();
    const next = { ...current, ...patch };
    delete next.updated_at;
    const updatedAt = new Date().toISOString();
    db.prepare('UPDATE executive_settings SET settings_json=?, updated_at=? WHERE id=1').run(
      JSON.stringify(next),
      updatedAt
    );
    return { ...next, updated_at: updatedAt };
  }

  function createExecutiveMessage(input) {
    const row = {
      message_id: input.message_id || crypto.randomUUID(),
      conversation_id: String(input.conversation_id || 'executive'),
      actor: String(input.actor || '').trim(),
      body: String(input.body || '').trim(),
      created_at: input.created_at || new Date().toISOString(),
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    };
    if (!row.actor || !row.body) throw httpErr(400, 'actor and body are required');
    db.prepare(
      `INSERT INTO executive_messages
      (message_id,conversation_id,actor,body,created_at,metadata_json) VALUES (?,?,?,?,?,?)`
    ).run(
      row.message_id,
      row.conversation_id,
      row.actor,
      row.body,
      row.created_at,
      JSON.stringify(row.metadata)
    );
    return row;
  }

  function listExecutiveMessages({ conversation_id = 'executive', limit = 200 } = {}) {
    const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
    return db
      .prepare(
        `SELECT * FROM executive_messages WHERE conversation_id = ?
      ORDER BY created_at DESC LIMIT ?`
      )
      .all(String(conversation_id), n)
      .map(row => ({ ...row, metadata: safeJson(row.metadata_json), metadata_json: undefined }));
  }

  function createExecutiveProposal(input) {
    const now = input.created_at || new Date().toISOString();
    const row = {
      proposal_id: input.proposal_id || crypto.randomUUID(),
      title: String(input.title || '').trim(),
      proposal_type: String(input.proposal_type || 'business'),
      summary: String(input.summary || '').trim(),
      rationale: String(input.rationale || ''),
      expected_upside:
        input.expected_upside && typeof input.expected_upside === 'object'
          ? input.expected_upside
          : {},
      risks: Array.isArray(input.risks) ? input.risks : [],
      requested_action: String(input.requested_action || '').trim(),
      status: 'proposed',
      created_by: String(input.created_by || 'ceo'),
      created_at: now,
      updated_at: now,
      decision_note: null,
      decided_by: null,
      decided_at: null,
      linked_request_id: input.linked_request_id || null,
      implementation:
        input.implementation && typeof input.implementation === 'object'
          ? input.implementation
          : {},
    };
    if (!row.title || !row.summary || !row.requested_action)
      throw httpErr(400, 'title, summary and requested_action are required');
    db.prepare(
      `INSERT INTO executive_proposals
      (proposal_id,title,proposal_type,summary,rationale,expected_upside_json,risks_json,requested_action,status,created_by,created_at,updated_at,decision_note,decided_by,decided_at,linked_request_id,implementation_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.proposal_id,
      row.title,
      row.proposal_type,
      row.summary,
      row.rationale,
      JSON.stringify(row.expected_upside),
      JSON.stringify(row.risks),
      row.requested_action,
      row.status,
      row.created_by,
      row.created_at,
      row.updated_at,
      row.decision_note,
      row.decided_by,
      row.decided_at,
      row.linked_request_id,
      JSON.stringify(row.implementation)
    );
    return row;
  }

  function listExecutiveProposals({ status, limit = 100 } = {}) {
    const n = Math.max(1, Math.min(Number(limit) || 100, 500));
    const rows = status
      ? db
          .prepare(
            `SELECT * FROM executive_proposals WHERE status = ? ORDER BY updated_at DESC LIMIT ?`
          )
          .all(String(status), n)
      : db.prepare(`SELECT * FROM executive_proposals ORDER BY updated_at DESC LIMIT ?`).all(n);
    return rows.map(decodeExecutiveProposal);
  }

  function getExecutiveProposal(id) {
    const row = db
      .prepare('SELECT * FROM executive_proposals WHERE proposal_id = ?')
      .get(String(id));
    return row ? decodeExecutiveProposal(row) : null;
  }

  function decideExecutiveProposal(
    id,
    { status, decision_note = '', decided_by = 'owner', linked_request_id } = {}
  ) {
    if (!['approved', 'declined', 'feedback'].includes(String(status)))
      throw httpErr(400, 'status must be approved, declined or feedback');
    const current = getExecutiveProposal(id);
    if (!current) throw httpErr(404, 'executive proposal not found');
    if (current.status !== 'proposed' && current.status !== 'feedback')
      throw httpErr(409, `proposal is already ${current.status}`);
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE executive_proposals SET status=?,updated_at=?,decision_note=?,decided_by=?,decided_at=?,linked_request_id=? WHERE proposal_id=?`
    ).run(
      String(status),
      now,
      String(decision_note || ''),
      String(decided_by || 'owner'),
      now,
      linked_request_id || current.linked_request_id,
      String(id)
    );
    return getExecutiveProposal(id);
  }

  // Executive passes may review CRO/research handoffs without granting owner
  // approval. A reviewed handoff is intentionally not eligible for the owner
  // approval queue; a separate owner-facing proposal can still be created when
  // the executive team finds a material implementation worth pursuing.
  function reviewExecutiveProposal(
    id,
    { status = 'reviewed', decision_note = '', reviewed_by = 'ceo' } = {}
  ) {
    if (!['reviewed', 'declined', 'feedback'].includes(String(status)))
      throw httpErr(400, 'status must be reviewed, declined or feedback');
    if (!['ceo', 'cto', 'cfo', 'legal', 'domain-manager', 'reviewer'].includes(String(reviewed_by)))
      throw httpErr(403, 'invalid executive reviewer');
    const current = getExecutiveProposal(id);
    if (!current) throw httpErr(404, 'executive proposal not found');
    if (!['researcher', 'cro'].includes(current.created_by))
      throw httpErr(403, 'only CRO/research handoffs may receive executive review');
    if (!['proposed', 'feedback'].includes(current.status))
      throw httpErr(409, `proposal is already ${current.status}`);
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE executive_proposals SET status=?,updated_at=?,decision_note=?,decided_by=?,decided_at=? WHERE proposal_id=?`
    ).run(String(status), now, String(decision_note || ''), String(reviewed_by), now, String(id));
    return getExecutiveProposal(id);
  }

  function createExecutiveAction(input) {
    const row = {
      action_id: input.action_id || crypto.randomUUID(),
      actor: String(input.actor || ''),
      action_type: String(input.action_type || ''),
      summary: String(input.summary || '').trim(),
      status: String(input.status || 'started'),
      target_type: input.target_type || null,
      target_id: input.target_id || null,
      proposal_id: input.proposal_id || null,
      request_id: input.request_id || null,
      started_at: input.started_at || new Date().toISOString(),
      finished_at: input.finished_at || null,
      result: input.result && typeof input.result === 'object' ? input.result : {},
      error: input.error || null,
    };
    if (!row.actor || !row.action_type || !row.summary)
      throw httpErr(400, 'actor, action_type and summary are required');
    db.prepare(
      `INSERT INTO executive_actions
      (action_id,actor,action_type,summary,status,target_type,target_id,proposal_id,request_id,started_at,finished_at,result_json,error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.action_id,
      row.actor,
      row.action_type,
      row.summary,
      row.status,
      row.target_type,
      row.target_id,
      row.proposal_id,
      row.request_id,
      row.started_at,
      row.finished_at,
      JSON.stringify(row.result),
      row.error
    );
    return row;
  }

  function listExecutiveActions({ actor, status, action_type, limit = 200 } = {}) {
    const clauses = [],
      args = [];
    if (actor) {
      clauses.push('actor = ?');
      args.push(String(actor));
    }
    if (status) {
      clauses.push('status = ?');
      args.push(String(status));
    }
    if (action_type) {
      clauses.push('action_type = ?');
      args.push(String(action_type));
    }
    const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
    return db
      .prepare(
        `SELECT * FROM executive_actions${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY started_at DESC LIMIT ?`
      )
      .all(...args, n)
      .map(decodeExecutiveAction);
  }

  function getExecutiveAction(id) {
    const row = db.prepare('SELECT * FROM executive_actions WHERE action_id = ?').get(String(id));
    return row ? decodeExecutiveAction(row) : null;
  }

  function finishExecutiveAction(id, patch = {}) {
    const current = getExecutiveAction(id);
    if (!current) throw httpErr(404, 'executive action not found');
    const status = String(patch.status || 'completed');
    if (!['started', 'completed', 'failed', 'blocked', 'skipped'].includes(status))
      throw httpErr(400, 'invalid executive action status');
    db.prepare(
      `UPDATE executive_actions SET status=?,finished_at=?,result_json=?,error=? WHERE action_id=?`
    ).run(
      status,
      patch.finished_at || new Date().toISOString(),
      JSON.stringify(
        patch.result && typeof patch.result === 'object' ? patch.result : current.result
      ),
      patch.error || null,
      String(id)
    );
    return getExecutiveAction(id);
  }

  return {
    record,
    recordOnce,
    list,
    createImprovement,
    listImprovements,
    getImprovement,
    updateImprovement,
    createChangeRequest,
    listChangeRequests,
    getChangeRequest,
    claimQueuedChangeRequest,
    claimExpiredChangeRequest,
    updateChangeRequest,
    getChangeQueueSettings,
    updateChangeQueueSettings,
    getExecutiveSettings,
    updateExecutiveSettings,
    createExecutiveMessage,
    listExecutiveMessages,
    createExecutiveProposal,
    listExecutiveProposals,
    getExecutiveProposal,
    decideExecutiveProposal,
    reviewExecutiveProposal,
    createExecutiveAction,
    listExecutiveActions,
    getExecutiveAction,
    finishExecutiveAction,
    close,
    file: dbFile,
  };
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
function decodeImprovement(row) {
  return {
    ...row,
    baseline: safeJson(row.baseline_json),
    validation: safeJson(row.validation_json),
    outcome: safeJson(row.outcome_json),
    sandbox: safeJson(row.sandbox_json),
    agent: safeJson(row.agent_json),
    approval: safeJson(row.approval_json),
    preflight: safeJson(row.preflight_json),
    baseline_json: undefined,
    validation_json: undefined,
    outcome_json: undefined,
    sandbox_json: undefined,
    agent_json: undefined,
    approval_json: undefined,
    preflight_json: undefined,
  };
}
function decodeExecutiveProposal(row) {
  return {
    ...row,
    expected_upside: safeJson(row.expected_upside_json),
    risks: safeJson(row.risks_json),
    implementation: safeJson(row.implementation_json),
    expected_upside_json: undefined,
    risks_json: undefined,
    implementation_json: undefined,
  };
}
function decodeExecutiveAction(row) {
  return { ...row, result: safeJson(row.result_json), result_json: undefined };
}
function ensureColumn(db, table, column, definition) {
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function httpErr(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

module.exports = { open };
