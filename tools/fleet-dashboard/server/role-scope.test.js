'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { violation, changedContentPaths } = require('./role-scope');

test('the site engineer content prohibition blocks a reviewer-approved editorial SEO edit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-role-scope-'));
  try {
    const roleDir = path.join(root, 'sites', 'example.com', 'ops', 'roles');
    fs.mkdirSync(roleDir, { recursive: true });
    fs.writeFileSync(
      path.join(roleDir, 'engineer.md'),
      '## Authority\n\n**You MUST NOT:**\n- Implement content, SEO, or voice work yourself.\n\n**Blocked or misfiled task?**\n'
    );
    const diff = {
      text:
        'diff --git a/site/src/content/personas/priya.json b/site/src/content/personas/priya.json\n' +
        '--- a/site/src/content/personas/priya.json\n' +
        '+++ b/site/src/content/personas/priya.json\n' +
        '-  "seoTitle": "Old"\n' +
        '+  "seoTitle": "New"\n',
      truncated: false,
    };
    const request = { site: 'example.com', assigned_role: 'engineer', delivery_mode: 'direct' };
    assert.match(violation(root, request, diff), /site engineer role forbids content\/SEO edits/);
    assert.deepEqual(changedContentPaths(diff.text), ['site/src/content/personas/priya.json']);
    assert.equal(violation(root, { ...request, assigned_role: 'seo-analyst' }, diff), null);
    assert.equal(violation(root, { ...request, delivery_mode: 'report_only' }, diff), null);
    assert.equal(
      violation(root, request, {
        text: 'diff --git a/site/src/pages/index.astro b/site/src/pages/index.astro\n',
      }),
      null
    );
    assert.match(violation(root, request, { truncated: true }), /diff was truncated/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
