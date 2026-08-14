'use strict';

// Backend for the "Guardrails" tab — thin wrapper around
// tools/content-guardrails/lib.js (the single source of truth for the
// matching/classification logic, shared with the git pre-commit hook).
// This module only adds read/write access to config.json + the audit log.

const lib = require('../../content-guardrails/lib');

function getConfig() {
  return lib.loadConfig();
}

// Full-replace write, with light shape validation so a bad PUT can't corrupt
// the file every commit fleet-wide depends on.
function setConfig(next) {
  if (!next || typeof next !== 'object') throw httpErr(400, 'config must be an object');
  const global = next.global || {};
  const overrides = next.overrides || {};
  if (!Array.isArray(global.blocked) || !Array.isArray(global.warn)) {
    throw httpErr(400, 'global.blocked and global.warn must be arrays');
  }
  for (const [repo, ov] of Object.entries(overrides)) {
    if (!ov || typeof ov !== 'object') throw httpErr(400, `overrides.${repo} must be an object`);
    if (ov.blocked && !Array.isArray(ov.blocked))
      throw httpErr(400, `overrides.${repo}.blocked must be an array`);
    if (ov.warn && !Array.isArray(ov.warn))
      throw httpErr(400, `overrides.${repo}.warn must be an array`);
  }
  const clean = arr => [...new Set((arr || []).map(s => String(s).trim()).filter(Boolean))];
  const cfg = {
    _comment: getConfig()._comment || undefined,
    global: { blocked: clean(global.blocked), warn: clean(global.warn) },
    overrides: Object.fromEntries(
      Object.entries(overrides).map(([repo, ov]) => [
        repo,
        { blocked: clean(ov.blocked), warn: clean(ov.warn) },
      ])
    ),
  };
  lib.saveConfig(cfg);
  return cfg;
}

function getLog(limit) {
  return lib.readLog(limit ? Number(limit) : 200);
}

function httpErr(status, msg) {
  const e = new Error(msg);
  e.httpStatus = status;
  return e;
}

module.exports = { getConfig, setConfig, getLog };
