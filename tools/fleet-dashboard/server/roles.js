'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { siteDir } = require('./sites');
const gitMod = require('./git');
const deployhealth = require('./deployhealth');
const { roleFromCommand } = require('./cron/parse');
const { tailFile } = require('./cron/runinfo');

function httpErr(status, msg) { const e = new Error(msg); e.httpStatus = status; return e; }

const CRONTABS = ['ops/docker/crontab.docker', 'ops/docker/crontab'];
// Roles whose log files don't (always) start with the role name. Value is the
// list of accepted log prefixes — deployers are named `deployer-…` on most
// sites but `deploy-…` on americastrikes, so accept both.
const LOG_PREFIX = { deployer: ['deployer', 'deploy'] };
// Staleness thresholds (seconds) by inferred cadence — a cell goes amber past
// the threshold and red past 2×.
const THRESH = { frequent: 2 * 3600, daily: 26 * 3600, weekly: 8 * 86400 };

// Regex matching a role's `<prefix>-<date>…` log files. Accepts any of the
// role's configured prefixes (default: the role name itself).
function logRe(role) {
  const prefixes = LOG_PREFIX[role] || [role];
  const alt = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp('^(?:' + alt)(?:-\\d)?');
}
// ... rest of file unchanged ...
