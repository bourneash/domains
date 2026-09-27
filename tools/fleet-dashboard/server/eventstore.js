'use strict';

// Durable relationship/event store for the fleet control plane. This is not a
// replacement for source-owned telemetry; it records the joins between signals,
// work, runs and outcomes so those systems can be followed as one causal chain.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const workflowEngine = require('./workflow-engine');

const TYPES = /^[a-z][a-z0-9_.-]{1,79}$/;
const EXECUTIVE_EVIDENCE_TYPES = new Set([
  'source',
  'artifact',
  'test',
  'measurement',
  'decision',
  'diff',
  'preview',
]);

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
      review_attempts INTEGER NOT NULL DEFAULT 0,
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
    CREATE TABLE IF NOT EXISTS executive_notifications (
      notification_id TEXT PRIMARY KEY,
      recipient TEXT NOT NULL,
      notification_type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      work_id TEXT,
      message_id TEXT,
      dedupe_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS executive_notifications_recipient ON executive_notifications(recipient, read_at, created_at);
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
    CREATE TABLE IF NOT EXISTS executive_goals (
      goal_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      statement TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      owner TEXT NOT NULL DEFAULT 'ceo',
      parent_goal_id TEXT,
      target_at TEXT,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      outcome TEXT
    );
    CREATE INDEX IF NOT EXISTS executive_goals_parent ON executive_goals(parent_goal_id, status);
    CREATE INDEX IF NOT EXISTS executive_goals_status ON executive_goals(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS executive_work_items (
      work_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'normal',
      owner TEXT NOT NULL DEFAULT 'ceo',
      source_type TEXT,
      source_id TEXT,
      site TEXT,
      summary TEXT NOT NULL DEFAULT '',
      next_action TEXT NOT NULL DEFAULT '',
      due_at TEXT,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution_note TEXT
    );
    CREATE INDEX IF NOT EXISTS executive_work_items_queue ON executive_work_items(status, priority, updated_at DESC);
    CREATE INDEX IF NOT EXISTS executive_work_items_owner ON executive_work_items(owner, status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS executive_knowledge_items (
      knowledge_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      resource_type TEXT NOT NULL DEFAULT 'official',
      audience TEXT NOT NULL DEFAULT 'all',
      status TEXT NOT NULL DEFAULT 'candidate',
      url TEXT,
      publisher TEXT,
      jurisdiction TEXT,
      license TEXT,
      published_at TEXT,
      summary TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      source_work_id TEXT,
      created_by TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      takeaway TEXT NOT NULL DEFAULT '',
      applied_to TEXT NOT NULL DEFAULT '',
      reviewed_by TEXT,
      reviewed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS executive_knowledge_queue ON executive_knowledge_items(status, audience, updated_at DESC);
    CREATE TABLE IF NOT EXISTS workflow_links (
      link_id TEXT PRIMARY KEY,
      from_type TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_type TEXT NOT NULL,
      to_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(from_type, from_id, to_type, to_id, relation)
    );
    CREATE INDEX IF NOT EXISTS workflow_links_from ON workflow_links(from_type, from_id);
    CREATE INDEX IF NOT EXISTS workflow_links_to ON workflow_links(to_type, to_id);
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
    CREATE TABLE IF NOT EXISTS agent_registry (
      agent_id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      role TEXT NOT NULL,
      manager_id TEXT,
      provider TEXT NOT NULL,
      model TEXT,
      adapter TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      permissions_json TEXT NOT NULL DEFAULT '[]',
      budget_json TEXT NOT NULL DEFAULT '{}',
      heartbeat_json TEXT NOT NULL DEFAULT '{}',
      workspace_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      paused_at TEXT,
      pause_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_registry_role ON agent_registry(role, status);
    CREATE INDEX IF NOT EXISTS agent_registry_manager ON agent_registry(manager_id, status);
    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      work_id TEXT,
      goal_id TEXT,
      session_id TEXT,
      idempotency_key TEXT UNIQUE,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      provider TEXT NOT NULL,
      model TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      heartbeat_at TEXT,
      workspace_path TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_runs_agent_time ON agent_runs(agent_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS agent_runs_work_time ON agent_runs(work_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS agent_runs_status ON agent_runs(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS agent_artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT,
      work_id TEXT,
      agent_id TEXT,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      uri TEXT,
      sha256 TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_artifacts_run ON agent_artifacts(run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS agent_artifacts_work ON agent_artifacts(work_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS budget_policies (
      policy_id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      period TEXT NOT NULL,
      limit_usd REAL NOT NULL,
      warning_pct REAL NOT NULL DEFAULT 0.8,
      hard_stop INTEGER NOT NULL DEFAULT 1,
      spent_usd REAL NOT NULL DEFAULT 0,
      window_start TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at TEXT NOT NULL,
      UNIQUE(scope_type, scope_id, period)
    );
    CREATE INDEX IF NOT EXISTS budget_policies_scope ON budget_policies(scope_type, scope_id, status);
    CREATE TABLE IF NOT EXISTS agent_routines (
      routine_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      trigger_type TEXT NOT NULL DEFAULT 'interval',
      schedule TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      coalesce INTEGER NOT NULL DEFAULT 1,
      catch_up INTEGER NOT NULL DEFAULT 0,
      max_concurrency INTEGER NOT NULL DEFAULT 1,
      next_due_at TEXT,
      last_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, name)
    );
    CREATE INDEX IF NOT EXISTS agent_routines_due ON agent_routines(status, next_due_at);
    CREATE TABLE IF NOT EXISTS agent_watchdogs (
      watchdog_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      expected_outcome TEXT NOT NULL,
      timeout_seconds INTEGER NOT NULL DEFAULT 900,
      status TEXT NOT NULL DEFAULT 'armed',
      recovery_action TEXT NOT NULL DEFAULT 'escalate',
      last_checked_at TEXT,
      fired_at TEXT,
      detail TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_watchdogs_due ON agent_watchdogs(status, last_checked_at);
    CREATE TABLE IF NOT EXISTS agent_evals (
      eval_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      run_id TEXT,
      evaluator TEXT NOT NULL,
      dimension TEXT NOT NULL,
      score REAL NOT NULL,
      feedback TEXT NOT NULL DEFAULT '',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_evals_agent ON agent_evals(agent_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS agent_tool_grants (
      grant_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      scope_json TEXT NOT NULL DEFAULT '{}',
      approval_required INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, tool_name)
    );
    CREATE INDEX IF NOT EXISTS agent_tool_grants_agent ON agent_tool_grants(agent_id, status);
    CREATE TABLE IF NOT EXISTS agent_workspaces (
      workspace_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      run_id TEXT,
      site TEXT,
      path TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'isolated',
      status TEXT NOT NULL DEFAULT 'active',
      preview_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_workspaces_agent ON agent_workspaces(agent_id, status);
    CREATE INDEX IF NOT EXISTS agent_workspaces_run ON agent_workspaces(run_id, status);
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
  ensureColumn(db, 'change_requests', 'review_attempts', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'change_requests', 'lease_owner', 'TEXT');
  ensureColumn(db, 'change_requests', 'lease_expires_at', 'TEXT');
  ensureColumn(db, 'change_requests', 'heartbeat_at', 'TEXT');
  ensureColumn(db, 'change_requests', 'measurement_override', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'change_queue_settings', 'auto_review_enabled', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'change_queue_settings', 'lease_minutes', 'INTEGER NOT NULL DEFAULT 30');
  ensureColumn(db, 'executive_proposals', 'implementation_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'executive_messages', 'work_id', 'TEXT');
  ensureColumn(db, 'executive_messages', 'reply_to', 'TEXT');
  ensureColumn(db, 'executive_messages', 'message_type', "TEXT NOT NULL DEFAULT 'update'");
  ensureColumn(db, 'executive_work_items', 'waiting_on', 'TEXT');
  ensureColumn(db, 'executive_work_items', 'lifecycle_state', "TEXT NOT NULL DEFAULT 'open'");
  ensureColumn(db, 'executive_work_items', 'acknowledged_at', 'TEXT');
  ensureColumn(db, 'executive_work_items', 'answered_at', 'TEXT');
  ensureColumn(db, 'executive_work_items', 'closed_at', 'TEXT');
  ensureColumn(db, 'executive_work_items', 'outcome', 'TEXT');
  ensureColumn(db, 'executive_work_items', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'executive_work_items', 'lease_owner', 'TEXT');
  ensureColumn(db, 'executive_work_items', 'lease_expires_at', 'TEXT');
  ensureColumn(db, 'executive_work_items', 'heartbeat_at', 'TEXT');
  ensureColumn(db, 'executive_work_items', 'retry_at', 'TEXT');
  ensureColumn(db, 'executive_work_items', 'last_error', 'TEXT');
  ensureColumn(db, 'executive_work_items', 'goal_id', 'TEXT');
  ensureColumn(db, 'executive_work_items', 'parent_work_id', 'TEXT');
  ensureColumn(db, 'executive_notifications', 'delivery_status', "TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn(db, 'executive_notifications', 'delivery_attempts', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'executive_notifications', 'last_error', 'TEXT');
  ensureColumn(db, 'executive_notifications', 'next_attempt_at', 'TEXT');
  ensureColumn(db, 'executive_notifications', 'delivered_at', 'TEXT');
  ensureColumn(db, 'executive_knowledge_items', 'takeaway', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'executive_knowledge_items', 'applied_to', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'executive_knowledge_items', 'reviewed_by', 'TEXT');
  ensureColumn(db, 'executive_knowledge_items', 'reviewed_at', 'TEXT');
  db.exec(
    'CREATE INDEX IF NOT EXISTS executive_messages_work ON executive_messages(work_id, created_at)'
  );

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

  const WORKFLOW_ENTITY_TYPES = new Set(['work-item', 'request', 'proposal']);
  const WORKFLOW_RELATIONS = new Set(['blocks', 'blocked_by', 'related_to']);
  function workflowEntityExists(type, id) {
    if (type === 'work-item') return Boolean(getExecutiveWorkItem(id));
    if (type === 'request') return Boolean(getChangeRequest(id));
    if (type === 'proposal') return Boolean(getExecutiveProposal(id));
    return false;
  }
  function createWorkflowLink(input = {}) {
    const row = {
      link_id: input.link_id || crypto.randomUUID(),
      from_type: String(input.from_type || ''),
      from_id: String(input.from_id || ''),
      to_type: String(input.to_type || ''),
      to_id: String(input.to_id || ''),
      relation: String(input.relation || 'related_to'),
      created_by: String(input.created_by || 'owner'),
      created_at: input.created_at || new Date().toISOString(),
    };
    if (row.relation === 'blocked_by') {
      [row.from_type, row.to_type] = [row.to_type, row.from_type];
      [row.from_id, row.to_id] = [row.to_id, row.from_id];
      row.relation = 'blocks';
    }
    if (!WORKFLOW_ENTITY_TYPES.has(row.from_type) || !WORKFLOW_ENTITY_TYPES.has(row.to_type))
      throw httpErr(400, 'invalid workflow entity type');
    if (!WORKFLOW_RELATIONS.has(row.relation)) throw httpErr(400, 'invalid workflow relation');
    if (!row.from_id || !row.to_id || row.from_id === row.to_id)
      throw httpErr(400, 'workflow links require two different entities');
    if (
      !workflowEntityExists(row.from_type, row.from_id) ||
      !workflowEntityExists(row.to_type, row.to_id)
    )
      throw httpErr(404, 'workflow entity not found');
    if (row.relation !== 'related_to') {
      const items = [
        ...listExecutiveWorkItems({ limit: 1000 }).map(item => ({
          ...item,
          source: 'work-item',
          id: item.work_id,
        })),
        ...listChangeRequests({ limit: 1000 }).map(item => ({
          ...item,
          source: 'request',
          id: item.request_id,
        })),
        ...listExecutiveProposals({ limit: 1000 }).map(item => ({
          ...item,
          source: 'proposal',
          id: item.proposal_id,
        })),
      ];
      const check = workflowEngine.evaluate({
        items,
        links: [...listWorkflowLinks({ limit: 2000 }), row],
      });
      if (check.cycles.length)
        throw httpErr(409, 'workflow link would create a circular dependency');
    }
    db.prepare(
      'INSERT INTO workflow_links (link_id,from_type,from_id,to_type,to_id,relation,created_by,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(from_type,from_id,to_type,to_id,relation) DO NOTHING'
    ).run(
      row.link_id,
      row.from_type,
      row.from_id,
      row.to_type,
      row.to_id,
      row.relation,
      row.created_by,
      row.created_at
    );
    return db
      .prepare(
        'SELECT * FROM workflow_links WHERE from_type=? AND from_id=? AND to_type=? AND to_id=? AND relation=?'
      )
      .get(row.from_type, row.from_id, row.to_type, row.to_id, row.relation);
  }
  function listWorkflowLinks({ entity_type, entity_id, limit = 500 } = {}) {
    const where =
      entity_type && entity_id
        ? ' WHERE (from_type=? AND from_id=?) OR (to_type=? AND to_id=?)'
        : '';
    const args =
      entity_type && entity_id
        ? [String(entity_type), String(entity_id), String(entity_type), String(entity_id)]
        : [];
    return db
      .prepare(`SELECT * FROM workflow_links${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...args, Math.min(Number(limit) || 500, 2000));
  }
  function deleteWorkflowLink(id) {
    const result = db.prepare('DELETE FROM workflow_links WHERE link_id=?').run(String(id));
    if (!result.changes) throw httpErr(404, 'workflow link not found');
    return { link_id: String(id) };
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

  // Claim delivery under SQLite's write lock so two dashboard processes (or a
  // reviewer callback racing recovery) cannot both observe an unclaimed run
  // and start deployment/validation. A stale claim is recoverable after the
  // bounded safety window; the caller remains responsible for recording the
  // audit event.
  function claimImprovementDelivery(
    runId,
    { maxAgeMs = 15 * 60 * 1000, claimedAt = new Date().toISOString(), claimedBy = null } = {}
  ) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = getImprovement(runId);
      if (!current) throw httpErr(404, 'improvement run not found');
      const previousAt = Date.parse(current.outcome?.delivery_claimed_at || '');
      if (
        current.outcome?.delivery_claimed === true &&
        Number.isFinite(previousAt) &&
        Date.parse(claimedAt) - previousAt < Number(maxAgeMs)
      ) {
        db.exec('COMMIT');
        return null;
      }
      const outcome = {
        ...(current.outcome || {}),
        delivery_claimed: true,
        delivery_claimed_at: claimedAt,
        delivery_claimed_by: claimedBy,
      };
      db.prepare('UPDATE improvement_runs SET updated_at=?,outcome_json=? WHERE run_id=?').run(
        claimedAt,
        JSON.stringify(outcome),
        String(runId)
      );
      db.exec('COMMIT');
      return getImprovement(runId);
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* preserve the original transaction error */
      }
      throw error;
    }
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
      provider: String(input.provider || process.env.FD_CHANGE_QUEUE_PROVIDER || 'chatgpt'),
      model:
        input.model ||
        (String(input.provider || process.env.FD_CHANGE_QUEUE_PROVIDER || 'chatgpt') === 'chatgpt'
          ? process.env.FD_CHANGE_QUEUE_MODEL || 'gpt-5.6-luna'
          : null),
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
      review_attempts: 0,
      error: null,
    };
    if (!row.site || !row.title) throw httpErr(400, 'site and title are required');
    db.prepare(
      `INSERT INTO change_requests
      (request_id,site,title,body,category,priority,assigned_role,provider,model,delivery_mode,action_key,max_turns,auto_review,voice_transcript,requested_by,source_proposal_id,status,created_at,updated_at,next_attempt_at,claimed_at,lease_owner,lease_expires_at,heartbeat_at,run_id,attempts,review_attempts,error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
      row.review_attempts,
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
      'measurement_override',
      'run_id',
      'attempts',
      'review_attempts',
      'error',
      'updated_at',
    ];
    const next = {
      ...current,
      ...Object.fromEntries(allowed.filter(k => Object.hasOwn(patch, k)).map(k => [k, patch[k]])),
    };
    next.updated_at = new Date().toISOString();
    db.prepare(
      `UPDATE change_requests SET site=?,title=?,body=?,category=?,priority=?,assigned_role=?,provider=?,model=?,delivery_mode=?,action_key=?,max_turns=?,auto_review=?,voice_transcript=?,requested_by=?,source_proposal_id=?,status=?,updated_at=?,next_attempt_at=?,claimed_at=?,lease_owner=?,lease_expires_at=?,heartbeat_at=?,measurement_override=?,run_id=?,attempts=?,review_attempts=?,error=? WHERE request_id=?`
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
      next.measurement_override ? 1 : 0,
      next.run_id,
      next.attempts,
      next.review_attempts,
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
      work_id: input.work_id ? String(input.work_id).trim() : null,
      reply_to: input.reply_to ? String(input.reply_to).trim() : null,
      message_type: String(input.message_type || 'update').trim(),
      created_at: input.created_at || new Date().toISOString(),
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    };
    if (!row.actor || !row.body) throw httpErr(400, 'actor and body are required');
    db.prepare(
      `INSERT INTO executive_messages
      (message_id,conversation_id,actor,body,work_id,reply_to,message_type,created_at,metadata_json) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      row.message_id,
      row.conversation_id,
      row.actor,
      row.body,
      row.work_id,
      row.reply_to,
      row.message_type,
      row.created_at,
      JSON.stringify(row.metadata)
    );
    return row;
  }

  function listExecutiveMessages({ conversation_id = 'executive', work_id, limit = 200 } = {}) {
    const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
    return db
      .prepare(
        `SELECT * FROM executive_messages WHERE conversation_id = ?${work_id ? ' AND work_id = ?' : ''}
      ORDER BY created_at DESC LIMIT ?`
      )
      .all(
        ...(work_id ? [String(conversation_id), String(work_id), n] : [String(conversation_id), n])
      )
      .map(row => ({ ...row, metadata: safeJson(row.metadata_json), metadata_json: undefined }));
  }

  function purgeExecutiveTranscriptBefore(cutoff) {
    const iso = new Date(cutoff).toISOString();
    const result = db
      .prepare(
        `DELETE FROM executive_messages
         WHERE created_at < ? AND message_type IN
         ('model-prompt','model-response','background','tool-call','tool-result')`
      )
      .run(iso);
    return { deleted: result.changes, cutoff: iso };
  }

  function updateExecutiveMessage(id, patch = {}) {
    const current = db
      .prepare('SELECT * FROM executive_messages WHERE message_id = ?')
      .get(String(id));
    if (!current) throw httpErr(404, 'executive message not found');
    const next = { ...current, ...patch };
    db.prepare(
      'UPDATE executive_messages SET work_id=?, reply_to=?, message_type=?, metadata_json=? WHERE message_id=?'
    ).run(
      next.work_id || null,
      next.reply_to || null,
      next.message_type || 'update',
      typeof next.metadata_json === 'string'
        ? next.metadata_json
        : JSON.stringify(next.metadata || safeJson(current.metadata_json)),
      String(id)
    );
    return db.prepare('SELECT * FROM executive_messages WHERE message_id = ?').get(String(id));
  }

  function createExecutiveNotification(input = {}) {
    const row = {
      notification_id: input.notification_id || crypto.randomUUID(),
      recipient: String(input.recipient || 'owner').trim(),
      notification_type: String(input.notification_type || 'executive-response').trim(),
      title: String(input.title || '').trim(),
      body: String(input.body || '').trim(),
      work_id: input.work_id ? String(input.work_id).trim() : null,
      message_id: input.message_id ? String(input.message_id).trim() : null,
      dedupe_key: input.dedupe_key ? String(input.dedupe_key).trim() : null,
      created_at: input.created_at || new Date().toISOString(),
      read_at: null,
      delivery_status: String(input.delivery_status || 'pending'),
      delivery_attempts: Number(input.delivery_attempts || 0),
      last_error: input.last_error || null,
      next_attempt_at: input.next_attempt_at || new Date().toISOString(),
      delivered_at: input.delivered_at || null,
    };
    if (!row.title || !row.body) throw httpErr(400, 'notification title and body are required');
    try {
      db.prepare(
        `INSERT INTO executive_notifications
        (notification_id,recipient,notification_type,title,body,work_id,message_id,dedupe_key,created_at,read_at,delivery_status,delivery_attempts,last_error,next_attempt_at,delivered_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        row.notification_id,
        row.recipient,
        row.notification_type,
        row.title,
        row.body,
        row.work_id,
        row.message_id,
        row.dedupe_key,
        row.created_at,
        row.read_at,
        row.delivery_status,
        row.delivery_attempts,
        row.last_error,
        row.next_attempt_at,
        row.delivered_at
      );
      return row;
    } catch (error) {
      if (row.dedupe_key && String(error.message).includes('UNIQUE constraint failed'))
        return db
          .prepare('SELECT * FROM executive_notifications WHERE dedupe_key = ?')
          .get(row.dedupe_key);
      throw error;
    }
  }

  function listExecutiveNotifications({ recipient = 'owner', unread, limit = 100 } = {}) {
    const clauses = ['recipient = ?'];
    const args = [String(recipient)];
    if (unread === true || unread === 'true' || unread === '1') clauses.push('read_at IS NULL');
    const n = Math.max(1, Math.min(Number(limit) || 100, 500));
    return db
      .prepare(
        `SELECT * FROM executive_notifications WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`
      )
      .all(...args, n);
  }

  function markExecutiveNotificationRead(id) {
    const readAt = new Date().toISOString();
    db.prepare('UPDATE executive_notifications SET read_at = ? WHERE notification_id = ?').run(
      readAt,
      String(id)
    );
    return (
      db
        .prepare('SELECT * FROM executive_notifications WHERE notification_id = ?')
        .get(String(id)) || null
    );
  }

  function getExecutiveNotification(id) {
    return (
      db
        .prepare('SELECT * FROM executive_notifications WHERE notification_id = ?')
        .get(String(id)) || null
    );
  }

  function markAllExecutiveNotificationsRead(recipient = 'owner') {
    const readAt = new Date().toISOString();
    const result = db
      .prepare(
        'UPDATE executive_notifications SET read_at = ? WHERE recipient = ? AND read_at IS NULL'
      )
      .run(readAt, String(recipient));
    return { updated: result.changes, read_at: readAt };
  }

  function updateExecutiveNotificationDelivery(id, patch = {}) {
    const current = db
      .prepare('SELECT * FROM executive_notifications WHERE notification_id = ?')
      .get(String(id));
    if (!current) throw httpErr(404, 'notification not found');
    const next = { ...current, ...patch };
    db.prepare(
      `UPDATE executive_notifications SET delivery_status=?,delivery_attempts=?,last_error=?,next_attempt_at=?,delivered_at=? WHERE notification_id=?`
    ).run(
      String(next.delivery_status || 'pending'),
      Number(next.delivery_attempts || 0),
      next.last_error || null,
      next.next_attempt_at || null,
      next.delivered_at || null,
      String(id)
    );
    return db
      .prepare('SELECT * FROM executive_notifications WHERE notification_id = ?')
      .get(String(id));
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

  function linkExecutiveProposalRequest(id, requestId) {
    const current = getExecutiveProposal(id);
    if (!current) throw httpErr(404, 'executive proposal not found');
    if (current.linked_request_id && current.linked_request_id !== String(requestId))
      throw httpErr(409, 'executive proposal is already linked to another request');
    db.prepare(
      'UPDATE executive_proposals SET linked_request_id=?,updated_at=? WHERE proposal_id=?'
    ).run(String(requestId), new Date().toISOString(), String(id));
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
    if (
      ![
        'ceo',
        'cto',
        'cfo',
        'legal',
        'security',
        'product-manager-fleet',
        'product-manager-sites',
        'domain-manager',
        'reviewer',
      ].includes(String(reviewed_by))
    )
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
    // Executive scorecards need a complete window, not the first page of the
    // most recent actions. Keep the general API bounded while allowing the
    // scorecard to read a larger, still-safe audit slice.
    const n = Math.max(1, Math.min(Number(limit) || 200, 5000));
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
    if (
      !['started', 'completed', 'completed_with_warning', 'failed', 'blocked', 'skipped'].includes(
        status
      )
    )
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

  function updateExecutiveAction(id, patch = {}) {
    const current = getExecutiveAction(id);
    if (!current) throw httpErr(404, 'executive action not found');
    const result =
      patch.result && typeof patch.result === 'object'
        ? { ...current.result, ...patch.result }
        : current.result;
    db.prepare('UPDATE executive_actions SET result_json=? WHERE action_id=?').run(
      JSON.stringify(result),
      String(id)
    );
    return getExecutiveAction(id);
  }

  const WORK_ITEM_KINDS = new Set([
    'decision',
    'research',
    'incident',
    'legal',
    'security',
    'education',
    'evidence',
    'implementation',
  ]);
  const WORK_ITEM_STATUSES = new Set([
    'open',
    'ready',
    'in_progress',
    'blocked',
    'waiting',
    'done',
    'cancelled',
  ]);
  const WORK_ITEM_PRIORITIES = new Set(['urgent', 'high', 'normal', 'low']);
  const WORK_ITEM_OWNERS = new Set([
    'ceo',
    'cto',
    'cfo',
    'legal',
    'security',
    'cro',
    'product-manager-fleet',
    'product-manager-sites',
    'domain-manager',
    'project-manager',
    'principal-engineer',
    'engineer',
    'owner',
  ]);

  const GOAL_STATUSES = new Set(['active', 'achieved', 'paused', 'cancelled']);

  function decodeExecutiveGoal(row) {
    return row ? { ...row, evidence: safeJson(row.evidence_json), evidence_json: undefined } : null;
  }

  function getExecutiveGoal(id) {
    const row = db.prepare('SELECT * FROM executive_goals WHERE goal_id=?').get(String(id));
    return decodeExecutiveGoal(row);
  }

  function listExecutiveGoals({ status, owner, parent_goal_id, limit = 500 } = {}) {
    const clauses = [],
      args = [];
    if (status) {
      clauses.push('status=?');
      args.push(String(status));
    }
    if (owner) {
      clauses.push('owner=?');
      args.push(String(owner));
    }
    if (parent_goal_id) {
      clauses.push('parent_goal_id=?');
      args.push(String(parent_goal_id));
    }
    return db
      .prepare(
        `SELECT * FROM executive_goals${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`
      )
      .all(...args, Math.max(1, Math.min(Number(limit) || 500, 1000)))
      .map(decodeExecutiveGoal);
  }

  function assertGoalParentDoesNotCycle(goalId, parentGoalId) {
    let current = parentGoalId ? getExecutiveGoal(parentGoalId) : null;
    const seen = new Set();
    while (current) {
      if (current.goal_id === goalId) throw httpErr(409, 'goal hierarchy would create a cycle');
      if (seen.has(current.goal_id)) throw httpErr(409, 'goal hierarchy contains a cycle');
      seen.add(current.goal_id);
      current = current.parent_goal_id ? getExecutiveGoal(current.parent_goal_id) : null;
    }
  }

  function createExecutiveGoal(input = {}) {
    const now = input.created_at || new Date().toISOString();
    const row = {
      goal_id: input.goal_id || crypto.randomUUID(),
      title: String(input.title || '').trim(),
      statement: String(input.statement || '').trim(),
      status: String(input.status || 'active').trim(),
      owner: String(input.owner || 'ceo').trim(),
      parent_goal_id: input.parent_goal_id ? String(input.parent_goal_id).trim() : null,
      target_at: input.target_at || null,
      evidence: Array.isArray(input.evidence) ? input.evidence.slice(0, 20) : [],
      created_by: String(input.created_by || 'system').trim(),
      created_at: now,
      updated_at: now,
      closed_at: input.closed_at || null,
      outcome: input.outcome ? String(input.outcome).trim() : null,
    };
    if (!row.title) throw httpErr(400, 'goal title is required');
    if (!row.statement) throw httpErr(400, 'goal statement is required');
    if (!GOAL_STATUSES.has(row.status)) throw httpErr(400, 'invalid goal status');
    if (!WORK_ITEM_OWNERS.has(row.owner)) throw httpErr(400, 'invalid goal owner');
    if (row.parent_goal_id && !getExecutiveGoal(row.parent_goal_id))
      throw httpErr(404, 'parent goal not found');
    assertGoalParentDoesNotCycle(row.goal_id, row.parent_goal_id);
    db.prepare(
      `INSERT INTO executive_goals (goal_id,title,statement,status,owner,parent_goal_id,target_at,evidence_json,created_by,created_at,updated_at,closed_at,outcome)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.goal_id,
      row.title,
      row.statement,
      row.status,
      row.owner,
      row.parent_goal_id,
      row.target_at,
      JSON.stringify(row.evidence),
      row.created_by,
      row.created_at,
      row.updated_at,
      row.closed_at,
      row.outcome
    );
    return row;
  }

  function updateExecutiveGoal(id, patch = {}) {
    const current = getExecutiveGoal(id);
    if (!current) throw httpErr(404, 'executive goal not found');
    if (
      patch.expected_updated_at &&
      String(patch.expected_updated_at) !== String(current.updated_at)
    )
      throw httpErr(409, 'goal changed; refresh before updating it');
    const next = { ...current, ...patch, goal_id: current.goal_id };
    next.title = String(next.title || '').trim();
    next.statement = String(next.statement || '').trim();
    next.status = String(next.status || '').trim();
    next.owner = String(next.owner || '').trim();
    next.parent_goal_id = next.parent_goal_id ? String(next.parent_goal_id).trim() : null;
    if (!next.title || !next.statement) throw httpErr(400, 'goal title and statement are required');
    if (!GOAL_STATUSES.has(next.status)) throw httpErr(400, 'invalid goal status');
    if (!WORK_ITEM_OWNERS.has(next.owner)) throw httpErr(400, 'invalid goal owner');
    if (next.parent_goal_id && !getExecutiveGoal(next.parent_goal_id))
      throw httpErr(404, 'parent goal not found');
    assertGoalParentDoesNotCycle(next.goal_id, next.parent_goal_id);
    const now = new Date().toISOString();
    const closedAt = ['achieved', 'cancelled'].includes(next.status) ? next.closed_at || now : null;
    const result = db
      .prepare(
        `UPDATE executive_goals SET title=?,statement=?,status=?,owner=?,parent_goal_id=?,target_at=?,evidence_json=?,updated_at=?,closed_at=?,outcome=? WHERE goal_id=? AND updated_at=?`
      )
      .run(
        next.title,
        next.statement,
        next.status,
        next.owner,
        next.parent_goal_id,
        next.target_at || null,
        JSON.stringify(Array.isArray(next.evidence) ? next.evidence.slice(0, 20) : []),
        now,
        closedAt,
        next.outcome || null,
        current.goal_id,
        current.updated_at
      );
    if (!result.changes) throw httpErr(409, 'goal changed; refresh before updating it');
    return getExecutiveGoal(current.goal_id);
  }

  function decodeExecutiveWorkItem(row) {
    return {
      ...row,
      evidence: normalizeExecutiveEvidence(safeJson(row.evidence_json)),
      evidence_contract: 'executive-evidence/v1',
      evidence_json: undefined,
    };
  }

  // Evidence was historically an untyped list of {label,note,url} objects.
  // Keep those records readable while giving new work products an explicit
  // type that downstream reviewers can reason about.
  function normalizeExecutiveEvidence(value, { strict = false } = {}) {
    if (!Array.isArray(value)) return [];
    const normalized = [];
    for (const entry of value.slice(0, 20)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        if (strict) throw httpErr(400, 'evidence entries must be objects');
        continue;
      }
      const type = String(entry.type || 'source')
        .trim()
        .toLowerCase();
      const label = entry.label === undefined ? undefined : String(entry.label).trim();
      const note = entry.note === undefined ? undefined : String(entry.note).trim();
      const url = entry.url === undefined ? undefined : String(entry.url).trim();
      const detail = entry.detail === undefined ? undefined : String(entry.detail).trim();
      const artifact = entry.artifact === undefined ? undefined : String(entry.artifact).trim();
      if (!EXECUTIVE_EVIDENCE_TYPES.has(type)) {
        if (strict) throw httpErr(400, `invalid evidence type: ${type}`);
        continue;
      }
      if (![label, note, url, detail, artifact].some(Boolean)) {
        if (strict) throw httpErr(400, 'evidence requires label, note, url, detail, or artifact');
        continue;
      }
      const item = { ...entry, type };
      for (const [key, field] of Object.entries({ label, note, url, detail, artifact })) {
        if (field === undefined) delete item[key];
        else item[key] = field;
      }
      normalized.push(item);
    }
    return normalized;
  }

  function assertWorkLineage(input, currentId = null) {
    if (input.goal_id && !getExecutiveGoal(input.goal_id)) throw httpErr(404, 'goal not found');
    if (!input.parent_work_id) return;
    if (String(input.parent_work_id) === String(currentId || input.work_id))
      throw httpErr(409, 'work item cannot be its own parent');
    const parent = getExecutiveWorkItem(input.parent_work_id);
    if (!parent) throw httpErr(404, 'parent work item not found');
    if (input.goal_id && parent.goal_id && String(input.goal_id) !== String(parent.goal_id))
      throw httpErr(409, 'parent work item belongs to a different goal');
    const seen = new Set([String(currentId || input.work_id)]);
    let cursor = parent;
    while (cursor) {
      if (seen.has(String(cursor.work_id)))
        throw httpErr(409, 'work hierarchy would create a cycle');
      seen.add(String(cursor.work_id));
      cursor = cursor.parent_work_id ? getExecutiveWorkItem(cursor.parent_work_id) : null;
    }
  }

  function createExecutiveWorkItem(input = {}) {
    const now = input.created_at || new Date().toISOString();
    const row = {
      work_id: input.work_id || crypto.randomUUID(),
      title: String(input.title || '').trim(),
      kind: String(input.kind || 'decision').trim(),
      status: String(input.status || 'open').trim(),
      priority: String(input.priority || 'normal').trim(),
      owner: String(input.owner || 'ceo').trim(),
      source_type: input.source_type ? String(input.source_type).trim() : null,
      source_id: input.source_id ? String(input.source_id).trim() : null,
      site: input.site ? String(input.site).trim() : null,
      goal_id: input.goal_id ? String(input.goal_id).trim() : null,
      parent_work_id: input.parent_work_id ? String(input.parent_work_id).trim() : null,
      summary: String(input.summary || '').trim(),
      next_action: String(input.next_action || '').trim(),
      waiting_on: input.waiting_on ? String(input.waiting_on).trim() : null,
      due_at: input.due_at ? String(input.due_at).trim() : null,
      evidence: normalizeExecutiveEvidence(input.evidence, { strict: true }),
      evidence_contract: 'executive-evidence/v1',
      created_by: String(input.created_by || 'system').trim(),
      created_at: now,
      updated_at: now,
      resolved_at: null,
      resolution_note: null,
      lifecycle_state: String(input.lifecycle_state || 'open').trim(),
      acknowledged_at: input.acknowledged_at || null,
      answered_at: input.answered_at || null,
      closed_at: input.closed_at || null,
      outcome: input.outcome ? String(input.outcome).trim() : null,
      attempts: Number(input.attempts || 0),
      lease_owner: input.lease_owner ? String(input.lease_owner).trim() : null,
      lease_expires_at: input.lease_expires_at || null,
      heartbeat_at: input.heartbeat_at || null,
      retry_at: input.retry_at || null,
      last_error: input.last_error ? String(input.last_error).trim() : null,
    };
    if (!row.title) throw httpErr(400, 'title is required');
    if (!WORK_ITEM_KINDS.has(row.kind)) throw httpErr(400, 'invalid work item kind');
    if (!WORK_ITEM_STATUSES.has(row.status)) throw httpErr(400, 'invalid work item status');
    if (!WORK_ITEM_PRIORITIES.has(row.priority)) throw httpErr(400, 'invalid work item priority');
    if (!WORK_ITEM_OWNERS.has(row.owner)) throw httpErr(400, 'invalid work item owner');
    assertWorkLineage(row);
    db.prepare(
      `INSERT INTO executive_work_items
      (work_id,title,kind,status,priority,owner,source_type,source_id,site,goal_id,parent_work_id,summary,next_action,waiting_on,due_at,evidence_json,created_by,created_at,updated_at,resolved_at,resolution_note,lifecycle_state,acknowledged_at,answered_at,closed_at,outcome,attempts,lease_owner,lease_expires_at,heartbeat_at,retry_at,last_error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.work_id,
      row.title,
      row.kind,
      row.status,
      row.priority,
      row.owner,
      row.source_type,
      row.source_id,
      row.site,
      row.goal_id,
      row.parent_work_id,
      row.summary,
      row.next_action,
      row.waiting_on,
      row.due_at,
      JSON.stringify(row.evidence),
      row.created_by,
      row.created_at,
      row.updated_at,
      row.resolved_at,
      row.resolution_note,
      row.lifecycle_state,
      row.acknowledged_at,
      row.answered_at,
      row.closed_at,
      row.outcome,
      row.attempts,
      row.lease_owner,
      row.lease_expires_at,
      row.heartbeat_at,
      row.retry_at,
      row.last_error
    );
    return row;
  }

  function listExecutiveWorkItems({
    status,
    owner,
    kind,
    goal_id,
    parent_work_id,
    priority,
    site,
    source_type,
    limit = 200,
  } = {}) {
    const clauses = [],
      args = [];
    if (status) {
      clauses.push('status = ?');
      args.push(String(status));
    }
    if (owner) {
      clauses.push('owner = ?');
      args.push(String(owner));
    }
    if (kind) {
      clauses.push('kind = ?');
      args.push(String(kind));
    }
    if (goal_id) {
      clauses.push('goal_id = ?');
      args.push(String(goal_id));
    }
    if (parent_work_id) {
      clauses.push('parent_work_id = ?');
      args.push(String(parent_work_id));
    }
    if (priority) {
      clauses.push('priority = ?');
      args.push(String(priority));
    }
    if (site) {
      clauses.push('site = ?');
      args.push(String(site));
    }
    if (source_type) {
      clauses.push('source_type = ?');
      args.push(String(source_type));
    }
    const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return db
      .prepare(
        `SELECT * FROM executive_work_items${where} ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, updated_at DESC LIMIT ?`
      )
      .all(...args, n)
      .map(decodeExecutiveWorkItem);
  }

  function getExecutiveWorkItem(id) {
    let row = db.prepare('SELECT * FROM executive_work_items WHERE work_id = ?').get(String(id));
    // Compatibility for callers that still hold the pre-canonical approved
    // proposal key. The old row is preserved when it exists, but once it has
    // been migrated this lookup follows the canonical case.
    if (!row && String(id).startsWith('approved-proposal:')) {
      row = db
        .prepare('SELECT * FROM executive_work_items WHERE work_id = ?')
        .get(`executive-proposal:${String(id).slice('approved-proposal:'.length)}`);
    }
    return row ? decodeExecutiveWorkItem(row) : null;
  }

  function updateExecutiveWorkItem(id, patch = {}) {
    const current = getExecutiveWorkItem(id);
    if (!current) throw httpErr(404, 'executive work item not found');
    if (
      patch.expected_updated_at &&
      String(patch.expected_updated_at) !== String(current.updated_at)
    )
      throw httpErr(409, 'work item changed; refresh before updating it');
    const next = { ...current, ...patch };
    next.title = String(next.title || '').trim();
    next.kind = String(next.kind || '').trim();
    next.status = String(next.status || '').trim();
    next.priority = String(next.priority || '').trim();
    next.owner = String(next.owner || '').trim();
    next.lifecycle_state = String(next.lifecycle_state || 'open').trim();
    next.evidence = normalizeExecutiveEvidence(next.evidence, { strict: true });
    if (!next.title) throw httpErr(400, 'title is required');
    if (!WORK_ITEM_KINDS.has(next.kind)) throw httpErr(400, 'invalid work item kind');
    if (!WORK_ITEM_STATUSES.has(next.status)) throw httpErr(400, 'invalid work item status');
    if (!WORK_ITEM_PRIORITIES.has(next.priority)) throw httpErr(400, 'invalid work item priority');
    if (!WORK_ITEM_OWNERS.has(next.owner)) throw httpErr(400, 'invalid work item owner');
    next.goal_id = next.goal_id ? String(next.goal_id).trim() : null;
    next.parent_work_id = next.parent_work_id ? String(next.parent_work_id).trim() : null;
    assertWorkLineage(next, current.work_id);
    if (next.status === 'done' && current.status !== 'done') {
      const hasEvidence = Array.isArray(next.evidence) && next.evidence.length > 0;
      if (
        !hasEvidence &&
        !String(next.outcome || '').trim() &&
        !String(next.resolution_note || '').trim()
      )
        throw httpErr(409, 'completion requires outcome, resolution note, or evidence');
    }
    if (next.status === 'in_progress' && current.status !== 'in_progress') {
      const boardItems = [
        ...listExecutiveWorkItems({ limit: 1000 }).map(item => ({
          ...item,
          source: 'work-item',
          id: item.work_id,
        })),
        ...listChangeRequests({ limit: 1000 }).map(item => ({
          ...item,
          source: 'request',
          id: item.request_id,
        })),
        ...listExecutiveProposals({ limit: 1000 }).map(item => ({
          ...item,
          source: 'proposal',
          id: item.proposal_id,
        })),
      ];
      const workflow = workflowEngine.evaluate({
        items: boardItems,
        links: listWorkflowLinks({ limit: 2000 }),
      });
      const node = workflow.nodes[`work-item:${id}`];
      if (node?.blockers?.length)
        throw httpErr(409, `work item is blocked by ${node.blockers.join(', ')}`);
      if (workflow.cycles.some(cycle => cycle.includes(`work-item:${id}`)))
        throw httpErr(409, 'work item is part of a circular dependency');
    }
    const now = new Date().toISOString();
    const resolved = ['done', 'cancelled'].includes(next.status) ? next.resolved_at || now : null;
    const result = db
      .prepare(
        `UPDATE executive_work_items SET title=?,kind=?,status=?,priority=?,owner=?,source_type=?,source_id=?,site=?,goal_id=?,parent_work_id=?,summary=?,next_action=?,waiting_on=?,due_at=?,evidence_json=?,updated_at=?,resolved_at=?,resolution_note=?,lifecycle_state=?,acknowledged_at=?,answered_at=?,closed_at=?,outcome=?,attempts=?,lease_owner=?,lease_expires_at=?,heartbeat_at=?,retry_at=?,last_error=? WHERE work_id=? AND updated_at=?`
      )
      .run(
        next.title,
        next.kind,
        next.status,
        next.priority,
        next.owner,
        next.source_type || null,
        next.source_id || null,
        next.site || null,
        next.goal_id || null,
        next.parent_work_id || null,
        String(next.summary || ''),
        String(next.next_action || ''),
        next.waiting_on || null,
        next.due_at || null,
        JSON.stringify(next.evidence),
        now,
        resolved,
        next.resolution_note || null,
        next.lifecycle_state,
        next.acknowledged_at || null,
        next.answered_at || null,
        next.closed_at || null,
        next.outcome || null,
        Number(next.attempts || 0),
        next.lease_owner || null,
        next.lease_expires_at || null,
        next.heartbeat_at || null,
        next.retry_at || null,
        next.last_error || null,
        String(current.work_id),
        String(current.updated_at)
      );
    if (!result.changes) throw httpErr(409, 'work item changed; refresh before updating it');
    return getExecutiveWorkItem(current.work_id);
  }

  function claimExecutiveWorkItem(id, leaseOwner, leaseSeconds = 900) {
    const owner = String(leaseOwner || '').trim();
    if (!owner) throw httpErr(400, 'lease owner is required');
    const workId = String(id);
    const now = new Date();
    const nowIso = now.toISOString();
    const expires = new Date(
      now.getTime() + Math.max(30, Number(leaseSeconds) || 900) * 1000
    ).toISOString();
    const result = db
      .prepare(
        `UPDATE executive_work_items SET lease_owner=?,lease_expires_at=?,heartbeat_at=?,attempts=attempts+1,updated_at=?
       WHERE work_id=? AND status IN ('open','ready','waiting','blocked')
       AND (lease_expires_at IS NULL OR lease_expires_at <= ? OR lease_owner=?)`
      )
      .run(owner, expires, nowIso, nowIso, workId, nowIso, owner);
    return result.changes ? getExecutiveWorkItem(workId) : null;
  }

  function heartbeatExecutiveWorkItem(id, leaseOwner, leaseSeconds = 900) {
    const owner = String(leaseOwner || '').trim();
    const now = new Date();
    const nowIso = now.toISOString();
    const expires = new Date(
      now.getTime() + Math.max(30, Number(leaseSeconds) || 900) * 1000
    ).toISOString();
    const result = db
      .prepare(
        `UPDATE executive_work_items SET lease_expires_at=?,heartbeat_at=?,updated_at=? WHERE work_id=? AND lease_owner=?`
      )
      .run(expires, nowIso, nowIso, String(id), owner);
    return result.changes ? getExecutiveWorkItem(id) : null;
  }

  function releaseExecutiveWorkItem(id, leaseOwner, patch = {}) {
    const current = getExecutiveWorkItem(id);
    if (!current || current.lease_owner !== String(leaseOwner || '')) return null;
    return updateExecutiveWorkItem(id, {
      ...patch,
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
    });
  }

  const AGENT_STATUSES = new Set(['active', 'paused', 'disabled']);
  const AGENT_RUN_STATUSES = new Set([
    'queued',
    'running',
    'paused',
    'succeeded',
    'failed',
    'cancelled',
  ]);
  const AGENT_ARTIFACT_KINDS = new Set([
    'report',
    'diff',
    'preview',
    'test',
    'screenshot',
    'deployment',
    'other',
  ]);
  const BUDGET_PERIODS = new Set(['run', 'hour', 'day', 'month']);

  function decodeAgent(row) {
    if (!row) return null;
    return {
      ...row,
      permissions: safeJsonArray(row.permissions_json),
      budget: safeJson(row.budget_json),
      heartbeat: safeJson(row.heartbeat_json),
      workspace: safeJson(row.workspace_json),
    };
  }

  function decodeAgentRun(row) {
    if (!row) return null;
    return { ...row, result: safeJson(row.result_json) };
  }

  function decodeAgentArtifact(row) {
    if (!row) return null;
    return { ...row, metadata: safeJson(row.metadata_json) };
  }

  function decodeBudget(row) {
    return row ? { ...row, hard_stop: Boolean(row.hard_stop) } : null;
  }

  function createAgent(input = {}) {
    const now = input.created_at || new Date().toISOString();
    const row = {
      agent_id: String(input.agent_id || crypto.randomUUID()),
      slug: String(input.slug || '').trim(),
      name: String(input.name || '').trim(),
      title: String(input.title || '').trim(),
      role: String(input.role || '').trim(),
      manager_id: input.manager_id ? String(input.manager_id).trim() : null,
      provider: String(input.provider || 'chatgpt').trim(),
      model: input.model ? String(input.model).trim() : null,
      adapter: String(input.adapter || 'codex').trim(),
      status: String(input.status || 'active').trim(),
      permissions: Array.isArray(input.permissions) ? input.permissions : [],
      budget: input.budget && typeof input.budget === 'object' ? input.budget : {},
      heartbeat: input.heartbeat && typeof input.heartbeat === 'object' ? input.heartbeat : {},
      workspace: input.workspace && typeof input.workspace === 'object' ? input.workspace : {},
      created_at: now,
      updated_at: now,
      paused_at: input.paused_at || null,
      pause_reason: input.pause_reason ? String(input.pause_reason).trim() : null,
    };
    if (!/^[a-z0-9][a-z0-9._-]{1,80}$/.test(row.slug)) throw httpErr(400, 'invalid agent slug');
    if (!row.name || !row.title || !row.role)
      throw httpErr(400, 'agent name, title, and role are required');
    if (!AGENT_STATUSES.has(row.status)) throw httpErr(400, 'invalid agent status');
    if (!row.provider || !row.adapter)
      throw httpErr(400, 'agent provider and adapter are required');
    if (row.manager_id && !getAgent(row.manager_id)) throw httpErr(404, 'agent manager not found');
    try {
      db.prepare(
        `INSERT INTO agent_registry
        (agent_id,slug,name,title,role,manager_id,provider,model,adapter,status,permissions_json,budget_json,heartbeat_json,workspace_json,created_at,updated_at,paused_at,pause_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        row.agent_id,
        row.slug,
        row.name,
        row.title,
        row.role,
        row.manager_id,
        row.provider,
        row.model,
        row.adapter,
        row.status,
        JSON.stringify(row.permissions),
        JSON.stringify(row.budget),
        JSON.stringify(row.heartbeat),
        JSON.stringify(row.workspace),
        row.created_at,
        row.updated_at,
        row.paused_at,
        row.pause_reason
      );
    } catch (error) {
      if (/UNIQUE/i.test(String(error.message))) throw httpErr(409, 'agent slug already exists');
      throw error;
    }
    return decodeAgent(
      db.prepare('SELECT * FROM agent_registry WHERE agent_id = ?').get(row.agent_id)
    );
  }

  function getAgent(id) {
    const row = db
      .prepare('SELECT * FROM agent_registry WHERE agent_id = ? OR slug = ?')
      .get(String(id), String(id));
    return decodeAgent(row);
  }

  function listAgents({ role, status, manager_id, limit = 200 } = {}) {
    const clauses = [],
      args = [];
    if (role) {
      clauses.push('role = ?');
      args.push(String(role));
    }
    if (status) {
      clauses.push('status = ?');
      args.push(String(status));
    }
    if (manager_id) {
      clauses.push('manager_id = ?');
      args.push(String(manager_id));
    }
    const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
    return db
      .prepare(
        `SELECT * FROM agent_registry${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY role, slug LIMIT ?`
      )
      .all(...args, n)
      .map(decodeAgent);
  }

  function updateAgent(id, patch = {}) {
    const current = getAgent(id);
    if (!current) throw httpErr(404, 'agent not found');
    const next = {
      ...current,
      ...patch,
      agent_id: current.agent_id,
      updated_at: new Date().toISOString(),
    };
    next.slug = String(next.slug || '').trim();
    next.name = String(next.name || '').trim();
    next.title = String(next.title || '').trim();
    next.role = String(next.role || '').trim();
    next.status = String(next.status || '').trim();
    if (!AGENT_STATUSES.has(next.status)) throw httpErr(400, 'invalid agent status');
    if (next.manager_id && !getAgent(next.manager_id))
      throw httpErr(404, 'agent manager not found');
    if (next.status === 'paused' && !next.paused_at) next.paused_at = next.updated_at;
    if (next.status !== 'paused') {
      next.paused_at = null;
      next.pause_reason = null;
    }
    db.prepare(
      `UPDATE agent_registry SET slug=?,name=?,title=?,role=?,manager_id=?,provider=?,model=?,adapter=?,status=?,permissions_json=?,budget_json=?,heartbeat_json=?,workspace_json=?,updated_at=?,paused_at=?,pause_reason=? WHERE agent_id=?`
    ).run(
      next.slug,
      next.name,
      next.title,
      next.role,
      next.manager_id || null,
      next.provider,
      next.model || null,
      next.adapter,
      next.status,
      JSON.stringify(next.permissions || []),
      JSON.stringify(next.budget || {}),
      JSON.stringify(next.heartbeat || {}),
      JSON.stringify(next.workspace || {}),
      next.updated_at,
      next.paused_at || null,
      next.pause_reason || null,
      current.agent_id
    );
    return getAgent(current.agent_id);
  }

  function createAgentRun(input = {}) {
    const agent = getAgent(input.agent_id);
    if (!agent) throw httpErr(404, 'agent not found');
    const status = String(input.status || 'queued');
    if (!AGENT_RUN_STATUSES.has(status)) throw httpErr(400, 'invalid agent run status');
    const now = input.started_at || new Date().toISOString();
    const run = {
      run_id: String(input.run_id || crypto.randomUUID()),
      agent_id: agent.agent_id,
      work_id: input.work_id ? String(input.work_id) : null,
      goal_id: input.goal_id ? String(input.goal_id) : null,
      session_id: input.session_id ? String(input.session_id) : crypto.randomUUID(),
      idempotency_key: input.idempotency_key ? String(input.idempotency_key) : null,
      status,
      attempt: Math.max(1, Number(input.attempt) || 1),
      provider: String(input.provider || agent.provider),
      model: input.model || agent.model || null,
      started_at: now,
      updated_at: now,
      finished_at: input.finished_at || null,
      heartbeat_at: input.heartbeat_at || now,
      workspace_path: input.workspace_path || null,
      input_tokens: Number(input.input_tokens) || 0,
      output_tokens: Number(input.output_tokens) || 0,
      total_tokens: Number(input.total_tokens) || 0,
      cost_usd: Number(input.cost_usd) || 0,
      result: input.result && typeof input.result === 'object' ? input.result : {},
      error: input.error || null,
    };
    if (run.cost_usd < 0 || run.input_tokens < 0 || run.output_tokens < 0)
      throw httpErr(400, 'usage values cannot be negative');
    try {
      db.prepare(
        `INSERT INTO agent_runs
        (run_id,agent_id,work_id,goal_id,session_id,idempotency_key,status,attempt,provider,model,started_at,updated_at,finished_at,heartbeat_at,workspace_path,input_tokens,output_tokens,total_tokens,cost_usd,result_json,error)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        run.run_id,
        run.agent_id,
        run.work_id,
        run.goal_id,
        run.session_id,
        run.idempotency_key,
        run.status,
        run.attempt,
        run.provider,
        run.model,
        run.started_at,
        run.updated_at,
        run.finished_at,
        run.heartbeat_at,
        run.workspace_path,
        run.input_tokens,
        run.output_tokens,
        run.total_tokens || run.input_tokens + run.output_tokens,
        run.cost_usd,
        JSON.stringify(run.result),
        run.error
      );
    } catch (error) {
      if (/UNIQUE/i.test(String(error.message)) && run.idempotency_key)
        return getAgentRunByIdempotency(run.idempotency_key);
      throw error;
    }
    return getAgentRun(run.run_id);
  }

  function getAgentRun(id) {
    return decodeAgentRun(db.prepare('SELECT * FROM agent_runs WHERE run_id = ?').get(String(id)));
  }

  function getAgentRunByIdempotency(key) {
    return decodeAgentRun(
      db.prepare('SELECT * FROM agent_runs WHERE idempotency_key = ?').get(String(key))
    );
  }

  function listAgentRuns({ agent_id, work_id, status, limit = 200 } = {}) {
    const clauses = [],
      args = [];
    if (agent_id) {
      clauses.push('agent_id = ?');
      args.push(String(agent_id));
    }
    if (work_id) {
      clauses.push('work_id = ?');
      args.push(String(work_id));
    }
    if (status) {
      clauses.push('status = ?');
      args.push(String(status));
    }
    const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
    return db
      .prepare(
        `SELECT * FROM agent_runs${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`
      )
      .all(...args, n)
      .map(decodeAgentRun);
  }

  function updateAgentRun(id, patch = {}) {
    const current = getAgentRun(id);
    if (!current) throw httpErr(404, 'agent run not found');
    const status = patch.status ? String(patch.status) : current.status;
    if (!AGENT_RUN_STATUSES.has(status)) throw httpErr(400, 'invalid agent run status');
    const now = new Date().toISOString();
    const terminal = ['succeeded', 'failed', 'cancelled'].includes(status);
    db.prepare(
      `UPDATE agent_runs SET status=?,updated_at=?,finished_at=?,heartbeat_at=?,workspace_path=?,input_tokens=?,output_tokens=?,total_tokens=?,cost_usd=?,result_json=?,error=? WHERE run_id=?`
    ).run(
      status,
      now,
      terminal ? patch.finished_at || current.finished_at || now : null,
      patch.heartbeat_at || (terminal ? current.heartbeat_at : now),
      patch.workspace_path ?? current.workspace_path,
      Number(patch.input_tokens ?? current.input_tokens) || 0,
      Number(patch.output_tokens ?? current.output_tokens) || 0,
      Number(patch.total_tokens ?? current.total_tokens) || 0,
      Number(patch.cost_usd ?? current.cost_usd) || 0,
      JSON.stringify(patch.result ?? current.result ?? {}),
      patch.error ?? current.error ?? null,
      current.run_id
    );
    return getAgentRun(current.run_id);
  }

  function createAgentArtifact(input = {}) {
    const kind = String(input.kind || 'other');
    const label = String(input.label || '').trim();
    if (!AGENT_ARTIFACT_KINDS.has(kind)) throw httpErr(400, 'invalid artifact kind');
    if (!label) throw httpErr(400, 'artifact label is required');
    if (input.run_id && !getAgentRun(input.run_id)) throw httpErr(404, 'agent run not found');
    const row = {
      artifact_id: String(input.artifact_id || crypto.randomUUID()),
      run_id: input.run_id || null,
      work_id: input.work_id || null,
      agent_id: input.agent_id || null,
      kind,
      label,
      uri: input.uri || null,
      sha256: input.sha256 || null,
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
      created_at: input.created_at || new Date().toISOString(),
    };
    db.prepare(
      `INSERT INTO agent_artifacts (artifact_id,run_id,work_id,agent_id,kind,label,uri,sha256,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.artifact_id,
      row.run_id,
      row.work_id,
      row.agent_id,
      row.kind,
      row.label,
      row.uri,
      row.sha256,
      JSON.stringify(row.metadata),
      row.created_at
    );
    return decodeAgentArtifact(
      db.prepare('SELECT * FROM agent_artifacts WHERE artifact_id = ?').get(row.artifact_id)
    );
  }

  function listAgentArtifacts({ run_id, work_id, agent_id, limit = 200 } = {}) {
    const clauses = [],
      args = [];
    for (const [field, value] of [
      ['run_id', run_id],
      ['work_id', work_id],
      ['agent_id', agent_id],
    ])
      if (value) {
        clauses.push(`${field} = ?`);
        args.push(String(value));
      }
    const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
    return db
      .prepare(
        `SELECT * FROM agent_artifacts${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`
      )
      .all(...args, n)
      .map(decodeAgentArtifact);
  }

  function upsertBudgetPolicy(input = {}) {
    const scopeType = String(input.scope_type || '').trim();
    const scopeId = String(input.scope_id || '').trim();
    const period = String(input.period || 'month').trim();
    const limit = Number(input.limit_usd);
    if (
      !scopeType ||
      !scopeId ||
      !BUDGET_PERIODS.has(period) ||
      !Number.isFinite(limit) ||
      limit < 0
    )
      throw httpErr(400, 'invalid budget policy');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO budget_policies (policy_id,scope_type,scope_id,period,limit_usd,warning_pct,hard_stop,spent_usd,window_start,status,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_type,scope_id,period) DO UPDATE SET limit_usd=excluded.limit_usd,warning_pct=excluded.warning_pct,hard_stop=excluded.hard_stop,status=excluded.status,updated_at=excluded.updated_at`
    ).run(
      input.policy_id || crypto.randomUUID(),
      scopeType,
      scopeId,
      period,
      limit,
      Number(input.warning_pct ?? 0.8),
      input.hard_stop === false ? 0 : 1,
      Number(input.spent_usd) || 0,
      input.window_start || now,
      String(input.status || 'active'),
      now
    );
    return getBudgetPolicy({ scope_type: scopeType, scope_id: scopeId, period });
  }

  function getBudgetPolicy({ scope_type, scope_id, period }) {
    return decodeBudget(
      db
        .prepare('SELECT * FROM budget_policies WHERE scope_type=? AND scope_id=? AND period=?')
        .get(String(scope_type), String(scope_id), String(period))
    );
  }

  function listBudgetPolicies({ scope_type, scope_id, status, limit = 200 } = {}) {
    const clauses = [],
      args = [];
    for (const [field, value] of [
      ['scope_type', scope_type],
      ['scope_id', scope_id],
      ['status', status],
    ])
      if (value) {
        clauses.push(`${field} = ?`);
        args.push(String(value));
      }
    const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
    return db
      .prepare(
        `SELECT * FROM budget_policies${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY scope_type, scope_id, period LIMIT ?`
      )
      .all(...args, n)
      .map(decodeBudget);
  }

  function reserveBudget({ scope_type, scope_id, period = 'month', amount_usd = 0 }) {
    const amount = Number(amount_usd);
    if (!Number.isFinite(amount) || amount < 0) throw httpErr(400, 'invalid budget amount');
    const policy = getBudgetPolicy({ scope_type, scope_id, period });
    if (!policy || policy.status !== 'active')
      return { allowed: true, policy: policy || null, reason: 'no_active_policy' };
    const result = db
      .prepare(
        `UPDATE budget_policies SET spent_usd=spent_usd+?,updated_at=? WHERE policy_id=? AND status='active' AND (hard_stop=0 OR spent_usd+? <= limit_usd)`
      )
      .run(amount, new Date().toISOString(), policy.policy_id, amount);
    const updated = getBudgetPolicy({ scope_type, scope_id, period });
    if (!result.changes) return { allowed: false, policy: updated, reason: 'budget_exceeded' };
    return {
      allowed: true,
      policy: updated,
      warning: updated.spent_usd >= updated.limit_usd * updated.warning_pct,
    };
  }

  function reserveBudgetBatch(reservations = []) {
    if (!Array.isArray(reservations) || !reservations.length)
      return { allowed: true, policies: [] };
    const normalized = reservations.map(item => ({
      scope_type: String(item.scope_type || '').trim(),
      scope_id: String(item.scope_id || '').trim(),
      period: String(item.period || 'month').trim(),
      amount_usd: Number(item.amount_usd || 0),
    }));
    if (
      normalized.some(
        item =>
          !item.scope_type ||
          !item.scope_id ||
          !Number.isFinite(item.amount_usd) ||
          item.amount_usd < 0
      )
    )
      throw httpErr(400, 'invalid budget reservation batch');
    db.exec('BEGIN IMMEDIATE');
    try {
      const policies = [];
      for (const item of normalized) {
        const policy = db
          .prepare('SELECT * FROM budget_policies WHERE scope_type=? AND scope_id=? AND period=?')
          .get(item.scope_type, item.scope_id, item.period);
        if (!policy || policy.status !== 'active') continue;
        const result = db
          .prepare(
            `UPDATE budget_policies SET spent_usd=spent_usd+?,updated_at=? WHERE policy_id=? AND status='active' AND (hard_stop=0 OR spent_usd+? <= limit_usd)`
          )
          .run(item.amount_usd, new Date().toISOString(), policy.policy_id, item.amount_usd);
        if (!result.changes)
          throw httpErr(409, `budget exceeded for ${item.scope_type}:${item.scope_id}`);
        policies.push(
          db.prepare('SELECT * FROM budget_policies WHERE policy_id=?').get(policy.policy_id)
        );
      }
      db.exec('COMMIT');
      return { allowed: true, policies: policies.map(decodeBudget) };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw error;
    }
  }

  function createAgentRoutine(input = {}) {
    if (!getAgent(input.agent_id)) throw httpErr(404, 'agent not found');
    const now = new Date().toISOString();
    const row = {
      routine_id: input.routine_id || crypto.randomUUID(),
      agent_id: String(input.agent_id),
      name: String(input.name || '').trim(),
      trigger_type: String(input.trigger_type || 'interval'),
      schedule: String(input.schedule || '').trim(),
      status: String(input.status || 'active'),
      coalesce: input.coalesce === false ? 0 : 1,
      catch_up: input.catch_up === true ? 1 : 0,
      max_concurrency: Math.max(1, Number(input.max_concurrency) || 1),
      next_due_at: input.next_due_at || null,
      last_run_at: input.last_run_at || null,
      created_at: input.created_at || now,
      updated_at: now,
    };
    if (!row.name || !row.schedule) throw httpErr(400, 'routine name and schedule are required');
    if (!['interval', 'cron', 'event', 'webhook'].includes(row.trigger_type))
      throw httpErr(400, 'invalid routine trigger');
    db.prepare(
      `INSERT INTO agent_routines (routine_id,agent_id,name,trigger_type,schedule,status,coalesce,catch_up,max_concurrency,next_due_at,last_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id,name) DO UPDATE SET trigger_type=excluded.trigger_type,schedule=excluded.schedule,status=excluded.status,coalesce=excluded.coalesce,catch_up=excluded.catch_up,max_concurrency=excluded.max_concurrency,next_due_at=excluded.next_due_at,updated_at=excluded.updated_at`
    ).run(
      row.routine_id,
      row.agent_id,
      row.name,
      row.trigger_type,
      row.schedule,
      row.status,
      row.coalesce,
      row.catch_up,
      row.max_concurrency,
      row.next_due_at,
      row.last_run_at,
      row.created_at,
      row.updated_at
    );
    return db
      .prepare('SELECT * FROM agent_routines WHERE agent_id=? AND name=?')
      .get(row.agent_id, row.name);
  }
  function listAgentRoutines({ agent_id, status, due_before, limit = 200 } = {}) {
    const clauses = [],
      args = [];
    for (const [field, value] of [
      ['agent_id', agent_id],
      ['status', status],
    ])
      if (value) {
        clauses.push(`${field}=?`);
        args.push(String(value));
      }
    if (due_before) {
      clauses.push('next_due_at IS NOT NULL AND next_due_at <= ?');
      args.push(String(due_before));
    }
    const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
    return db
      .prepare(
        `SELECT * FROM agent_routines${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY next_due_at LIMIT ?`
      )
      .all(...args, n);
  }
  function touchAgentRoutine(id, patch = {}) {
    const current = db.prepare('SELECT * FROM agent_routines WHERE routine_id=?').get(String(id));
    if (!current) throw httpErr(404, 'routine not found');
    db.prepare(
      'UPDATE agent_routines SET status=?,next_due_at=?,last_run_at=?,updated_at=? WHERE routine_id=?'
    ).run(
      patch.status || current.status,
      patch.next_due_at ?? current.next_due_at,
      patch.last_run_at ?? new Date().toISOString(),
      new Date().toISOString(),
      current.routine_id
    );
    return db.prepare('SELECT * FROM agent_routines WHERE routine_id=?').get(current.routine_id);
  }

  function createAgentWatchdog(input = {}) {
    if (!getAgentRun(input.run_id)) throw httpErr(404, 'agent run not found');
    const now = new Date().toISOString();
    const row = {
      watchdog_id: input.watchdog_id || crypto.randomUUID(),
      run_id: String(input.run_id),
      expected_outcome: String(input.expected_outcome || 'terminal run with verified result'),
      timeout_seconds: Math.max(30, Number(input.timeout_seconds) || 900),
      status: String(input.status || 'armed'),
      recovery_action: String(input.recovery_action || 'escalate'),
      last_checked_at: null,
      fired_at: null,
      detail: null,
      created_at: now,
      updated_at: now,
    };
    db.prepare(
      'INSERT INTO agent_watchdogs (watchdog_id,run_id,expected_outcome,timeout_seconds,status,recovery_action,last_checked_at,fired_at,detail,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      row.watchdog_id,
      row.run_id,
      row.expected_outcome,
      row.timeout_seconds,
      row.status,
      row.recovery_action,
      row.last_checked_at,
      row.fired_at,
      row.detail,
      row.created_at,
      row.updated_at
    );
    return row;
  }
  function listAgentWatchdogs({ run_id, status, limit = 200 } = {}) {
    const clauses = [],
      args = [];
    for (const [field, value] of [
      ['run_id', run_id],
      ['status', status],
    ])
      if (value) {
        clauses.push(`${field}=?`);
        args.push(String(value));
      }
    const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
    return db
      .prepare(
        `SELECT * FROM agent_watchdogs${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`
      )
      .all(...args, n);
  }
  function auditAgentWatchdogs({ now = new Date() } = {}) {
    const armed = listAgentWatchdogs({ status: 'armed', limit: 1000 });
    const fired = [];
    for (const watchdog of armed) {
      const run = getAgentRun(watchdog.run_id);
      if (!run) continue;
      const iso = now.toISOString();
      if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
        db.prepare(
          'UPDATE agent_watchdogs SET status=?,last_checked_at=?,updated_at=? WHERE watchdog_id=?'
        ).run(run.status === 'succeeded' ? 'satisfied' : 'failed', iso, iso, watchdog.watchdog_id);
      } else if (now.getTime() - Date.parse(run.updated_at) > watchdog.timeout_seconds * 1000) {
        db.prepare(
          'UPDATE agent_watchdogs SET status=?,fired_at=?,last_checked_at=?,detail=?,updated_at=? WHERE watchdog_id=?'
        ).run(
          'fired',
          iso,
          iso,
          `run ${run.run_id} exceeded ${watchdog.timeout_seconds}s`,
          iso,
          watchdog.watchdog_id
        );
        fired.push({ ...watchdog, status: 'fired', fired_at: iso });
      } else
        db.prepare(
          'UPDATE agent_watchdogs SET last_checked_at=?,updated_at=? WHERE watchdog_id=?'
        ).run(iso, iso, watchdog.watchdog_id);
    }
    return { checked: armed.length, fired };
  }

  function createAgentEval(input = {}) {
    if (!getAgent(input.agent_id)) throw httpErr(404, 'agent not found');
    const score = Number(input.score);
    if (!Number.isFinite(score) || score < 0 || score > 100)
      throw httpErr(400, 'eval score must be 0-100');
    const row = {
      eval_id: input.eval_id || crypto.randomUUID(),
      agent_id: String(input.agent_id),
      run_id: input.run_id || null,
      evaluator: String(input.evaluator || 'system'),
      dimension: String(input.dimension || 'quality'),
      score,
      feedback: String(input.feedback || ''),
      evidence: input.evidence && typeof input.evidence === 'object' ? input.evidence : {},
      created_at: input.created_at || new Date().toISOString(),
    };
    db.prepare(
      'INSERT INTO agent_evals (eval_id,agent_id,run_id,evaluator,dimension,score,feedback,evidence_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(
      row.eval_id,
      row.agent_id,
      row.run_id,
      row.evaluator,
      row.dimension,
      row.score,
      row.feedback,
      JSON.stringify(row.evidence),
      row.created_at
    );
    return row;
  }
  function listAgentEvals({ agent_id, run_id, dimension, limit = 200 } = {}) {
    const clauses = [],
      args = [];
    for (const [field, value] of [
      ['agent_id', agent_id],
      ['run_id', run_id],
      ['dimension', dimension],
    ])
      if (value) {
        clauses.push(`${field}=?`);
        args.push(String(value));
      }
    const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
    return db
      .prepare(
        `SELECT * FROM agent_evals${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`
      )
      .all(...args, n)
      .map(row => ({ ...row, evidence: safeJson(row.evidence_json) }));
  }
  function agentEvalSummary(agentId) {
    const rows = listAgentEvals({ agent_id: agentId, limit: 1000 });
    const byDimension = {};
    for (const row of rows) {
      const bucket =
        byDimension[row.dimension] || (byDimension[row.dimension] = { count: 0, total: 0 });
      bucket.count++;
      bucket.total += Number(row.score) || 0;
    }
    for (const bucket of Object.values(byDimension))
      bucket.average = Number((bucket.total / bucket.count).toFixed(2));
    return { agent_id: String(agentId), evaluations: rows.length, by_dimension: byDimension };
  }

  function upsertAgentToolGrant(input = {}) {
    if (!getAgent(input.agent_id)) throw httpErr(404, 'agent not found');
    const row = {
      grant_id: input.grant_id || crypto.randomUUID(),
      agent_id: String(input.agent_id),
      tool_name: String(input.tool_name || '').trim(),
      scope: input.scope && typeof input.scope === 'object' ? input.scope : {},
      approval_required: input.approval_required === false ? 0 : 1,
      status: String(input.status || 'active'),
      created_at: input.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (!row.tool_name) throw httpErr(400, 'tool name is required');
    db.prepare(
      'INSERT INTO agent_tool_grants (grant_id,agent_id,tool_name,scope_json,approval_required,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(agent_id,tool_name) DO UPDATE SET scope_json=excluded.scope_json,approval_required=excluded.approval_required,status=excluded.status,updated_at=excluded.updated_at'
    ).run(
      row.grant_id,
      row.agent_id,
      row.tool_name,
      JSON.stringify(row.scope),
      row.approval_required,
      row.status,
      row.created_at,
      row.updated_at
    );
    return getAgentToolGrant(row.agent_id, row.tool_name);
  }
  function getAgentToolGrant(agentId, toolName) {
    const row = db
      .prepare('SELECT * FROM agent_tool_grants WHERE agent_id=? AND tool_name=?')
      .get(String(agentId), String(toolName));
    return row
      ? {
          ...row,
          scope: safeJson(row.scope_json),
          approval_required: Boolean(row.approval_required),
        }
      : null;
  }
  function listAgentToolGrants({ agent_id, status, limit = 200 } = {}) {
    const clauses = [],
      args = [];
    for (const [field, value] of [
      ['agent_id', agent_id],
      ['status', status],
    ])
      if (value) {
        clauses.push(`${field}=?`);
        args.push(String(value));
      }
    const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
    return db
      .prepare(
        `SELECT * FROM agent_tool_grants${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY agent_id,tool_name LIMIT ?`
      )
      .all(...args, n)
      .map(row => ({
        ...row,
        scope: safeJson(row.scope_json),
        approval_required: Boolean(row.approval_required),
      }));
  }
  function canAgentUseTool(agentId, toolName, context = {}) {
    const agent = getAgent(agentId);
    const grant = getAgentToolGrant(agentId, toolName);
    const scope = grant?.scope || {};
    const sites = Array.isArray(scope.sites) ? scope.sites.map(String) : null;
    const scopeAllowed = !sites || (context.site && sites.includes(String(context.site)));
    const approvalAllowed = !grant?.approval_required || context.approved === true;
    return {
      allowed: Boolean(
        agent &&
        agent.status === 'active' &&
        grant &&
        grant.status === 'active' &&
        scopeAllowed &&
        approvalAllowed
      ),
      requires_approval: Boolean(grant?.approval_required && context.approved !== true),
      scope_allowed: Boolean(scopeAllowed),
      agent_status: agent?.status || 'missing',
      grant: grant || null,
    };
  }

  function createAgentWorkspace(input = {}) {
    if (!getAgent(input.agent_id)) throw httpErr(404, 'agent not found');
    const workspacePath = String(input.path || '').trim();
    if (
      !workspacePath ||
      workspacePath.includes('..') ||
      /[\u0000-\u001f\u007f]/.test(workspacePath) ||
      !/^(\/tmp|\/workspace|\/home\/jesse\/projects\/domains\/tools\/executive\/data\/workspaces)(\/|$)/.test(
        workspacePath
      )
    )
      throw httpErr(400, 'invalid workspace path');
    const now = new Date().toISOString();
    const row = {
      workspace_id: input.workspace_id || crypto.randomUUID(),
      agent_id: String(input.agent_id),
      run_id: input.run_id || null,
      site: input.site || null,
      path: workspacePath,
      mode: String(input.mode || 'isolated'),
      status: String(input.status || 'active'),
      preview_url: input.preview_url || null,
      created_at: now,
      updated_at: now,
      closed_at: null,
    };
    db.prepare(
      'INSERT INTO agent_workspaces (workspace_id,agent_id,run_id,site,path,mode,status,preview_url,created_at,updated_at,closed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      row.workspace_id,
      row.agent_id,
      row.run_id,
      row.site,
      row.path,
      row.mode,
      row.status,
      row.preview_url,
      row.created_at,
      row.updated_at,
      row.closed_at
    );
    return row;
  }
  function listAgentWorkspaces({ agent_id, run_id, status, limit = 200 } = {}) {
    const clauses = [],
      args = [];
    for (const [field, value] of [
      ['agent_id', agent_id],
      ['run_id', run_id],
      ['status', status],
    ])
      if (value) {
        clauses.push(`${field}=?`);
        args.push(String(value));
      }
    const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
    return db
      .prepare(
        `SELECT * FROM agent_workspaces${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`
      )
      .all(...args, n);
  }
  function closeAgentWorkspace(id) {
    const now = new Date().toISOString();
    const result = db
      .prepare(
        "UPDATE agent_workspaces SET status='closed',closed_at=?,updated_at=? WHERE workspace_id=? AND status='active'"
      )
      .run(now, now, String(id));
    return result.changes
      ? db.prepare('SELECT * FROM agent_workspaces WHERE workspace_id=?').get(String(id))
      : null;
  }

  const KNOWLEDGE_TYPES = new Set([
    'official',
    'book',
    'course',
    'checklist',
    'paper',
    'reference',
  ]);
  const KNOWLEDGE_AUDIENCES = new Set([
    'all',
    'ceo',
    'cto',
    'cfo',
    'legal',
    'security',
    'cro',
    'product-manager-fleet',
    'product-manager-sites',
    'domain-manager',
    'engineer',
  ]);
  const KNOWLEDGE_STATUSES = new Set([
    'candidate',
    'queued',
    'in_progress',
    'complete',
    'rejected',
  ]);

  function decodeKnowledge(row) {
    return { ...row, tags: safeJson(row.tags_json), tags_json: undefined };
  }

  function validateKnowledge(row) {
    if (!row.title) throw httpErr(400, 'knowledge title is required');
    if (!KNOWLEDGE_TYPES.has(row.resource_type))
      throw httpErr(400, 'invalid knowledge resource type');
    if (!KNOWLEDGE_AUDIENCES.has(row.audience)) throw httpErr(400, 'invalid knowledge audience');
    if (!KNOWLEDGE_STATUSES.has(row.status)) throw httpErr(400, 'invalid knowledge status');
    if (row.url && !/^https?:\/\//i.test(row.url))
      throw httpErr(400, 'knowledge url must be http(s)');
  }

  function createExecutiveKnowledge(input = {}) {
    const now = input.created_at || new Date().toISOString();
    const row = {
      knowledge_id: input.knowledge_id || crypto.randomUUID(),
      title: String(input.title || '').trim(),
      resource_type: String(input.resource_type || 'official').trim(),
      audience: String(input.audience || 'all').trim(),
      status: String(input.status || 'candidate').trim(),
      url: input.url ? String(input.url).trim() : null,
      publisher: input.publisher ? String(input.publisher).trim() : null,
      jurisdiction: input.jurisdiction ? String(input.jurisdiction).trim() : null,
      license: input.license ? String(input.license).trim() : null,
      published_at: input.published_at ? String(input.published_at).trim() : null,
      summary: String(input.summary || '').trim(),
      tags: Array.isArray(input.tags) ? input.tags.slice(0, 20).map(String) : [],
      source_work_id: input.source_work_id ? String(input.source_work_id).trim() : null,
      created_by: String(input.created_by || 'system').trim(),
      created_at: now,
      updated_at: now,
      completed_at: null,
      takeaway: String(input.takeaway || '').trim(),
      applied_to: String(input.applied_to || '').trim(),
      reviewed_by: input.reviewed_by ? String(input.reviewed_by).trim() : null,
      reviewed_at: input.reviewed_at ? String(input.reviewed_at).trim() : null,
    };
    validateKnowledge(row);
    db.prepare(
      `INSERT INTO executive_knowledge_items
      (knowledge_id,title,resource_type,audience,status,url,publisher,jurisdiction,license,published_at,summary,tags_json,source_work_id,created_by,created_at,updated_at,completed_at,takeaway,applied_to,reviewed_by,reviewed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.knowledge_id,
      row.title,
      row.resource_type,
      row.audience,
      row.status,
      row.url,
      row.publisher,
      row.jurisdiction,
      row.license,
      row.published_at,
      row.summary,
      JSON.stringify(row.tags),
      row.source_work_id,
      row.created_by,
      row.created_at,
      row.updated_at,
      row.completed_at,
      row.takeaway,
      row.applied_to,
      row.reviewed_by,
      row.reviewed_at
    );
    return row;
  }

  function listExecutiveKnowledge({ status, audience, resource_type, limit = 200 } = {}) {
    const clauses = [],
      args = [];
    for (const [column, value] of [
      ['status', status],
      ['audience', audience],
      ['resource_type', resource_type],
    ]) {
      if (value) {
        clauses.push(`${column} = ?`);
        args.push(String(value));
      }
    }
    const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return db
      .prepare(
        `SELECT * FROM executive_knowledge_items${where} ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'queued' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END, updated_at DESC LIMIT ?`
      )
      .all(...args, n)
      .map(decodeKnowledge);
  }

  function updateExecutiveKnowledge(id, patch = {}) {
    const current = db
      .prepare('SELECT * FROM executive_knowledge_items WHERE knowledge_id = ?')
      .get(String(id));
    if (!current) throw httpErr(404, 'knowledge item not found');
    const next = { ...decodeKnowledge(current), ...patch };
    next.title = String(next.title || '').trim();
    next.resource_type = String(next.resource_type || '').trim();
    next.audience = String(next.audience || '').trim();
    next.status = String(next.status || '').trim();
    validateKnowledge(next);
    const now = new Date().toISOString();
    const completed = next.status === 'complete' ? next.completed_at || now : null;
    const reviewed =
      next.takeaway || next.applied_to ? next.reviewed_at || now : next.reviewed_at || null;
    db.prepare(
      `UPDATE executive_knowledge_items SET title=?,resource_type=?,audience=?,status=?,url=?,publisher=?,jurisdiction=?,license=?,published_at=?,summary=?,tags_json=?,source_work_id=?,updated_at=?,completed_at=?,takeaway=?,applied_to=?,reviewed_by=?,reviewed_at=? WHERE knowledge_id=?`
    ).run(
      next.title,
      next.resource_type,
      next.audience,
      next.status,
      next.url || null,
      next.publisher || null,
      next.jurisdiction || null,
      next.license || null,
      next.published_at || null,
      String(next.summary || ''),
      JSON.stringify(Array.isArray(next.tags) ? next.tags.slice(0, 20).map(String) : []),
      next.source_work_id || null,
      now,
      completed,
      String(next.takeaway || ''),
      String(next.applied_to || ''),
      next.reviewed_by || null,
      reviewed,
      String(id)
    );
    return decodeKnowledge(
      db.prepare('SELECT * FROM executive_knowledge_items WHERE knowledge_id = ?').get(String(id))
    );
  }

  return {
    record,
    recordOnce,
    list,
    createImprovement,
    listImprovements,
    getImprovement,
    updateImprovement,
    claimImprovementDelivery,
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
    purgeExecutiveTranscriptBefore,
    updateExecutiveMessage,
    createExecutiveNotification,
    listExecutiveNotifications,
    markExecutiveNotificationRead,
    getExecutiveNotification,
    markAllExecutiveNotificationsRead,
    updateExecutiveNotificationDelivery,
    createExecutiveProposal,
    listExecutiveProposals,
    getExecutiveProposal,
    decideExecutiveProposal,
    linkExecutiveProposalRequest,
    reviewExecutiveProposal,
    createExecutiveAction,
    listExecutiveActions,
    getExecutiveAction,
    finishExecutiveAction,
    updateExecutiveAction,
    createExecutiveGoal,
    listExecutiveGoals,
    getExecutiveGoal,
    updateExecutiveGoal,
    createExecutiveWorkItem,
    listExecutiveWorkItems,
    getExecutiveWorkItem,
    updateExecutiveWorkItem,
    claimExecutiveWorkItem,
    heartbeatExecutiveWorkItem,
    releaseExecutiveWorkItem,
    createWorkflowLink,
    listWorkflowLinks,
    deleteWorkflowLink,
    createExecutiveKnowledge,
    listExecutiveKnowledge,
    updateExecutiveKnowledge,
    createAgent,
    getAgent,
    listAgents,
    updateAgent,
    createAgentRun,
    getAgentRun,
    getAgentRunByIdempotency,
    listAgentRuns,
    updateAgentRun,
    createAgentArtifact,
    listAgentArtifacts,
    upsertBudgetPolicy,
    getBudgetPolicy,
    listBudgetPolicies,
    reserveBudget,
    reserveBudgetBatch,
    createAgentRoutine,
    listAgentRoutines,
    touchAgentRoutine,
    createAgentWatchdog,
    listAgentWatchdogs,
    auditAgentWatchdogs,
    createAgentEval,
    listAgentEvals,
    agentEvalSummary,
    upsertAgentToolGrant,
    getAgentToolGrant,
    listAgentToolGrants,
    canAgentUseTool,
    createAgentWorkspace,
    listAgentWorkspaces,
    closeAgentWorkspace,
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
function safeJsonArray(value) {
  const parsed = safeJson(value);
  return Array.isArray(parsed) ? parsed : [];
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
