'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');

const CATEGORIES = [
  'error',
  'design',
  'navigation',
  'content',
  'marketing',
  'sales',
  'seo',
  'engineering',
  'other',
];
const PRIORITIES = ['high', 'medium', 'low'];
const PROVIDERS = ['claude', 'chatgpt', 'local'];
// report_only produces a durable report artifact and can never deploy or push
// site code. Keep it explicit instead of relying on task prose such as
// "please do not deploy".
const DELIVERY_MODES = ['direct', 'pull_request', 'report_only'];
const STATUSES = [
  'queued',
  'claimed',
  'running',
  'reviewing',
  'review',
  'committed',
  'deployed',
  'verified',
  'failed',
  'cancelled',
];
const TRANSITIONS = {
  queued: ['claimed', 'cancelled'],
  claimed: ['running', 'failed', 'cancelled'],
  running: ['reviewing', 'review', 'failed', 'cancelled'],
  reviewing: ['review', 'failed', 'cancelled'],
  review: ['reviewing', 'committed', 'verified', 'failed', 'cancelled'],
  committed: ['deployed', 'failed', 'cancelled'],
  deployed: ['verified', 'failed'],
  verified: [],
  failed: ['queued', 'cancelled'],
  cancelled: [],
};

function validate(input, knownSite) {
  if (!knownSite(input.site)) throw httpErr(404, 'unknown site');
  if (!String(input.title || '').trim()) throw httpErr(400, 'title is required');
  if (!CATEGORIES.includes(String(input.category || 'other')))
    throw httpErr(400, 'invalid category');
  if (!PRIORITIES.includes(String(input.priority || 'medium')))
    throw httpErr(400, 'invalid priority');
  if (!PROVIDERS.includes(String(input.provider || 'claude')))
    throw httpErr(400, 'invalid provider');
  if (!DELIVERY_MODES.includes(String(input.delivery_mode || 'direct')))
    throw httpErr(400, 'invalid delivery mode');
  if (
    String(input.delivery_mode || 'direct') === 'report_only' &&
    (input.auto_review === false || input.auto_review === 0)
  )
    throw httpErr(400, 'report-only requests require automatic review');
  if (input.status && !STATUSES.includes(String(input.status)))
    throw httpErr(400, 'invalid status');
  const turns = Number(input.max_turns || 20);
  if (!Number.isInteger(turns) || turns < 1 || turns > 200)
    throw httpErr(400, 'max_turns must be an integer from 1 to 200');
  if (input.auto_review !== undefined && ![true, false, 0, 1].includes(input.auto_review))
    throw httpErr(400, 'auto_review must be boolean');
  if (input.assigned_role && !/^[a-z0-9][a-z0-9-]{0,50}$/.test(String(input.assigned_role)))
    throw httpErr(400, 'invalid assigned role');
}

function create(store, input, knownSite) {
  validate(input, knownSite);
  const request = store.createChangeRequest({ ...input, max_turns: Number(input.max_turns || 20) });
  store.record({
    event_type: 'change-request.queued',
    source: 'fleet-dashboard',
    site_id: `site:${request.site}`,
    entity_type: 'change-request',
    entity_id: request.request_id,
    correlation_id: `change-request:${request.request_id}`,
    payload: {
      category: request.category,
      priority: request.priority,
      provider: request.provider,
      model: request.model,
      max_turns: request.max_turns,
    },
  });
  return request;
}

function update(store, id, patch, knownSite) {
  const current = store.getChangeRequest(id);
  if (!current) throw httpErr(404, 'change request not found');
  const editKeys = [
    'site',
    'title',
    'body',
    'category',
    'priority',
    'assigned_role',
    'provider',
    'delivery_mode',
    'model',
    'max_turns',
    'auto_review',
    'voice_transcript',
  ];
  if (
    editKeys.some(key => Object.prototype.hasOwnProperty.call(patch, key)) &&
    !['queued', 'failed'].includes(current.status)
  )
    throw httpErr(409, `request fields cannot be edited while ${current.status}`);
  if (patch.status && !STATUSES.includes(patch.status)) throw httpErr(400, 'invalid status');
  if (
    patch.status &&
    patch.status !== current.status &&
    !(TRANSITIONS[current.status] || []).includes(patch.status)
  )
    throw httpErr(409, `cannot transition ${current.status} to ${patch.status}`);
  if (
    patch.site ||
    patch.title ||
    patch.category ||
    patch.priority ||
    patch.provider ||
    patch.delivery_mode ||
    patch.max_turns
  )
    validate({ ...current, ...patch }, knownSite);
  const next = store.updateChangeRequest(id, patch);
  store.record({
    event_type: `change-request.${next.status}`,
    source: 'fleet-dashboard',
    site_id: `site:${next.site}`,
    entity_type: 'change-request',
    entity_id: next.request_id,
    correlation_id: `change-request:${next.request_id}`,
    payload: { status: next.status, error: next.error || null },
  });
  return next;
}

function pick(store, { now = new Date(), max = 1 } = {}) {
  const due = store
    .listChangeRequests({ status: 'queued', limit: 100 })
    .filter(r => !r.next_attempt_at || Date.parse(r.next_attempt_at) <= now.getTime());
  return due.slice(0, Math.max(0, Number(max) || 0));
}

// Optional local STT hook. Configure FD_LOCAL_STT_COMMAND as an executable that
// accepts an audio file path and prints the transcript to stdout (for example,
// whisper-cli). No cloud transcription is used.
function transcribe({ audioBase64, mimeType = 'audio/webm' } = {}) {
  if (!audioBase64) throw httpErr(400, 'audio is required');
  const raw = Buffer.from(String(audioBase64), 'base64');
  // The dashboard's JSON body limit is 1 MB; keep the binary payload below it
  // after base64 expansion rather than weakening the limit for every API.
  if (!raw.length || raw.length > 700 * 1024)
    throw httpErr(400, 'audio must be between 1 byte and 700 KB');
  const ext = mimeType.includes('wav') ? '.wav' : mimeType.includes('mp4') ? '.mp4' : '.webm';
  const file = path.join(os.tmpdir(), `fleet-stt-${crypto.randomUUID()}${ext}`);
  fs.writeFileSync(file, raw, { mode: 0o600 });
  const command = process.env.FD_LOCAL_STT_COMMAND || 'whisper-cli';
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [file],
      { timeout: 120000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        try {
          fs.unlinkSync(file);
        } catch {
          /* best effort */
        }
        if (error) return reject(httpErr(503, `local STT unavailable: ${stderr || error.message}`));
        resolve({ transcript: String(stdout || '').trim() });
      }
    );
  });
}

function httpErr(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}
module.exports = {
  CATEGORIES,
  PRIORITIES,
  PROVIDERS,
  DELIVERY_MODES,
  STATUSES,
  TRANSITIONS,
  create,
  update,
  pick,
  transcribe,
};
