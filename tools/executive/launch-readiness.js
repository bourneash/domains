'use strict';

// Read-only launch-readiness artifacts checked into the repository so
// executive runs and human reviewers use the same evidence checklist. This is
// risk triage and workflow state, not a legal opinion.

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join('ops', 'executive', 'checklists');

function read(root, site = null) {
  const dir = path.join(root, DIR);
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter(file => file.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }

  return files
    .map(file => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(
      item => item && (!site || String(item.site).toLowerCase() === String(site).toLowerCase())
    );
}

module.exports = { DIR, read };
