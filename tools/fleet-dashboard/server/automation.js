'use strict';

// Unified automation control plane. Social Hub settings live in the site's
// tracked ops/social/hub.yaml; role cadence lives in the site's tracked
// crontab; role prompts live in ops/roles/<role>.md. This module is deliberately
// a thin, validated file editor so those existing files remain the source of
// truth for both the dashboard and the workers.

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { siteDir } = require('./sites');
const cronParse = require('./cron/parse');

const CRONTABS = ['ops/docker/crontab.docker', 'ops/docker/crontab'];

function httpErr(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

function readFirst(cwd, rels) {
  for (const rel of rels) {
    try {
      return { path: path.join(cwd, rel), text: fs.readFileSync(path.join(cwd, rel), 'utf8') };
    } catch {
      /* try the next format */
    }
  }
  return { path: path.join(cwd, rels[0]), text: '' };
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function loadSocial(root, slug) {
  const file = path.join(siteDir(root, slug), 'ops', 'social', 'hub.yaml');
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw httpErr(404, 'Social Hub config not found');
  }
  let config;
  try {
    config = yaml.load(raw) || {};
  } catch (e) {
    throw httpErr(409, `invalid Social Hub YAML: ${e.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw httpErr(409, 'Social Hub config must be a YAML mapping');
  return { file, raw, config };
}

function roleRows(root, slug) {
  const cwd = siteDir(root, slug);
  const crontab = readFirst(cwd, CRONTABS);
  const parsed = cronParse.parseCrontab(crontab.text);
  const grouped = new Map();
  for (const entry of parsed.entries) {
    if (entry.commented || !entry.role) continue;
    if (!grouped.has(entry.role)) grouped.set(entry.role, []);
    grouped.get(entry.role).push(entry);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, entries]) => {
      const promptPath = path.join(cwd, 'ops', 'roles', `${role}.md`);
      let prompt = '';
      try {
        prompt = fs.readFileSync(promptPath, 'utf8');
      } catch {
        /* some shell roles have no markdown prompt */
      }
      return {
        role,
        enabled: !fs.existsSync(path.join(cwd, 'ops', `.${role}-disabled`)),
        worker: entries[0].worker,
        schedule: entries[0].schedule,
        entries: entries.map(e => ({
          lineIndex: e.lineIndex,
          schedule: e.schedule,
          rawLine: e.rawLine,
        })),
        promptPath: fs.existsSync(promptPath) ? path.relative(root, promptPath) : null,
        prompt,
      };
    });
}

function get(root, slug) {
  const social = loadSocial(root, slug);
  const crontab = readFirst(siteDir(root, slug), CRONTABS);
  return {
    site: slug,
    social: { file: path.relative(root, social.file), raw: social.raw, config: social.config },
    roles: roleRows(root, slug),
    crontab: { file: path.relative(root, crontab.path), available: Boolean(crontab.text) },
  };
}

function patchSocial(root, slug, body) {
  const current = loadSocial(root, slug);
  const allowed = [
    'enabled',
    'approval',
    'max_source_age_hours',
    'variants_per_source',
    'max_sources_per_run',
    'voice',
    'content_direction',
    'hashtags',
    'link_style',
  ];
  const next = yaml.load(current.raw) || {};
  for (const key of allowed) if (body[key] !== undefined) next[key] = body[key];
  if (body.cadence && typeof body.cadence === 'object') {
    next.cadence = { ...(next.cadence || {}), ...body.cadence };
  }
  if (body.reply && typeof body.reply === 'object') {
    next.reply = { ...(next.reply || {}), ...body.reply };
  }
  if (body.ai && typeof body.ai === 'object') {
    next.ai = { ...(next.ai || {}), ...body.ai };
  }
  if (body.platformApprovals && typeof body.platformApprovals === 'object') {
    next.platform_overrides = { ...(next.platform_overrides || {}) };
    for (const [platform, approval] of Object.entries(body.platformApprovals)) {
      if (!/^[a-z0-9_.-]{1,50}$/i.test(platform) || !['auto', 'manual'].includes(String(approval)))
        throw httpErr(400, `invalid approval for ${platform}`);
      next.platform_overrides[platform] = {
        ...(next.platform_overrides[platform] || {}),
        approval,
      };
    }
  }
  if (!['auto', 'manual'].includes(String(next.approval)))
    throw httpErr(400, 'approval must be auto or manual');
  if (next.enabled !== undefined && typeof next.enabled !== 'boolean')
    throw httpErr(400, 'enabled must be true or false');
  if (next.link_style !== undefined && !['append', 'none'].includes(String(next.link_style)))
    throw httpErr(400, 'link_style must be append or none');
  if (next.hashtags !== undefined && (!Array.isArray(next.hashtags) || next.hashtags.some(tag => typeof tag !== 'string')))
    throw httpErr(400, 'hashtags must be a list of strings');
  for (const key of ['max_source_age_hours', 'variants_per_source', 'max_sources_per_run']) {
    if (next[key] !== undefined && (!Number.isFinite(Number(next[key])) || Number(next[key]) < 0))
      throw httpErr(400, `${key} must be a non-negative number`);
  }
  if (next.cadence) {
    for (const key of ['per_platform_per_day', 'min_gap_minutes']) {
      if (
        next.cadence[key] !== undefined &&
        (!Number.isFinite(Number(next.cadence[key])) || Number(next.cadence[key]) < 0)
      )
        throw httpErr(400, `cadence.${key} must be a non-negative number`);
    }
    if (next.cadence.slots !== undefined) {
      if (!Array.isArray(next.cadence.slots) || next.cadence.slots.some(slot => !/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(slot))))
        throw httpErr(400, 'cadence.slots must contain times in HH:MM format');
    }
    if (next.cadence.quiet_hours !== undefined) {
      if (!Array.isArray(next.cadence.quiet_hours) || next.cadence.quiet_hours.length !== 2 || next.cadence.quiet_hours.some(hour => !Number.isInteger(Number(hour)) || Number(hour) < 0 || Number(hour) > 23))
        throw httpErr(400, 'cadence.quiet_hours must contain two hours from 0 to 23');
    }
    for (const key of ['immediate', 'stagger']) {
      if (next.cadence[key] !== undefined && typeof next.cadence[key] !== 'boolean')
        throw httpErr(400, `cadence.${key} must be true or false`);
    }
  }
  if (next.reply) {
    for (const key of ['max_per_day', 'poll_limit']) {
      if (next.reply[key] !== undefined && (!Number.isFinite(Number(next.reply[key])) || Number(next.reply[key]) < 0))
        throw httpErr(400, `reply.${key} must be a non-negative number`);
    }
    if (next.reply.enabled !== undefined && typeof next.reply.enabled !== 'boolean')
      throw httpErr(400, 'reply.enabled must be true or false');
  }
  if (next.ai) {
    if (next.ai.backend !== undefined && !['auto', 'api', 'cli', 'fake'].includes(String(next.ai.backend)))
      throw httpErr(400, 'ai.backend must be auto, api, cli, or fake');
    if (next.ai.max_tokens !== undefined && (!Number.isFinite(Number(next.ai.max_tokens)) || Number(next.ai.max_tokens) < 1))
      throw httpErr(400, 'ai.max_tokens must be a positive number');
  }
  atomicWrite(current.file, yaml.dump(next, { noRefs: true, lineWidth: 120 }));
  return get(root, slug);
}

function replaceSocialYaml(root, slug, raw) {
  const current = loadSocial(root, slug);
  let parsed;
  try {
    parsed = yaml.load(String(raw || ''));
  } catch (e) {
    throw httpErr(400, `invalid Social Hub YAML: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw httpErr(400, 'Social Hub config must be a YAML mapping');
  if (!['auto', 'manual'].includes(String(parsed.approval || 'auto')))
    throw httpErr(400, 'approval must be auto or manual');
  atomicWrite(current.file, `${String(raw).trim()}\n`);
  return get(root, slug);
}

function updateRole(root, slug, role, body) {
  const r = String(role || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(r)) throw httpErr(400, 'invalid role');
  const cwd = siteDir(root, slug);
  const crontab = readFirst(cwd, CRONTABS);
  const parsed = cronParse.parseCrontab(crontab.text);
  const entry = parsed.entries.find(e => !e.commented && e.role === r);
  if (!entry) throw httpErr(404, 'role is not scheduled on this site');

  if (body.schedule !== undefined) {
    if (!cronParse.isValidCron(body.schedule))
      throw httpErr(400, 'invalid five-field cron schedule');
    const updated = cronParse.editSchedule(
      crontab.text,
      entry.lineIndex,
      String(body.schedule).trim(),
      entry.rawLine
    );
    atomicWrite(crontab.path, updated);
  }
  if (body.enabled !== undefined) {
    if (!entry.worker) throw httpErr(400, 'this role is not a run-worker.sh role');
    const flag = path.join(cwd, 'ops', `.${r}-disabled`);
    if (body.enabled) {
      try {
        fs.unlinkSync(flag);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    } else if (!fs.existsSync(flag)) fs.writeFileSync(flag, '');
  }
  if (body.prompt !== undefined) {
    if (String(body.prompt).length > 100000) throw httpErr(400, 'prompt is too large');
    atomicWrite(path.join(cwd, 'ops', 'roles', `${r}.md`), String(body.prompt));
  }
  return get(root, slug);
}

function createRole(root, slug, body) {
  const r = String(body.role || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(r)) throw httpErr(400, 'invalid role');
  if (!cronParse.isValidCron(body.schedule)) throw httpErr(400, 'invalid five-field cron schedule');
  const prompt = String(body.prompt || '').trim();
  if (!prompt) throw httpErr(400, 'prompt is required');
  const cwd = siteDir(root, slug);
  const crontab = readFirst(cwd, CRONTABS);
  const parsed = cronParse.parseCrontab(crontab.text);
  if (parsed.entries.some(e => !e.commented && e.role === r))
    throw httpErr(409, 'role is already scheduled on this site');
  atomicWrite(
    crontab.path,
    cronParse.addLine(
      crontab.text,
      String(body.schedule).trim(),
      `bash ops/scripts/run-worker.sh ${r}`
    )
  );
  atomicWrite(
    path.join(cwd, 'ops', 'roles', `${r}.md`),
    prompt.endsWith('\n') ? prompt : `${prompt}\n`
  );
  if (body.enabled === false) fs.writeFileSync(path.join(cwd, 'ops', `.${r}-disabled`), '');
  return get(root, slug);
}

module.exports = { get, patchSocial, replaceSocialYaml, updateRole, createRole };
