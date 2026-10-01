'use strict';

const fs = require('node:fs');
const path = require('node:path');

function engineerProhibitsContent(root, site) {
  const file = path.join(root, 'sites', site, 'ops', 'roles', 'engineer.md');
  if (!fs.existsSync(file)) return false;
  const instructions = fs.readFileSync(file, 'utf8');
  const section = instructions.split(/\*\*You MUST NOT:\*\*/i)[1] || '';
  const mustNot = section.split(/^(?:\*\*|## )/m)[0];
  return /^\s*-\s*Implement content, SEO, or voice work yourself\.?\s*$/im.test(mustNot);
}

function changedContentPaths(diff) {
  const paths = new Set();
  for (const line of String(diff || '').split('\n')) {
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!match) continue;
    for (const file of [match[1], match[2]]) {
      if (file.startsWith('site/src/content/')) paths.add(file);
    }
  }
  return [...paths].sort();
}

function violation(root, request, diff) {
  if (request?.delivery_mode === 'report_only' || request?.assigned_role !== 'engineer')
    return null;
  if (!engineerProhibitsContent(root, request.site)) return null;
  if (diff?.truncated)
    return 'engineer role scope cannot be verified because the delivery diff was truncated';
  const files = changedContentPaths(diff?.text);
  if (!files.length) return null;
  return `site engineer role forbids content/SEO edits; reassign or remove ${files.join(', ')}`;
}

module.exports = { violation, engineerProhibitsContent, changedContentPaths };
