'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lab = require('./cro-lab');

const candidate = {
  full_name: 'acme/fleet-tool',
  html_url: 'https://github.com/acme/fleet-tool',
  default_branch: 'main',
  purpose: 'seo_content',
  description: 'Markdown publishing and sitemap helpers for editorial SEO',
  topics: ['seo', 'markdown'],
  license_spdx_id: 'MIT',
};

test('accepts only canonical public GitHub candidates', () => {
  assert.equal(lab.candidateSlug(candidate), 'acme/fleet-tool');
  assert.equal(lab.archiveUrl(candidate), 'https://codeload.github.com/acme/fleet-tool/tar.gz/main');
  assert.throws(() => lab.githubUrl({ ...candidate, html_url: 'https://example.com/acme/fleet-tool' }), /canonical public GitHub/);
  assert.throws(() => lab.candidateSlug({ full_name: '../escape' }), /invalid GitHub candidate/);
});

test('derives a purpose-specific use case from repository evidence', () => {
  const result = lab.purposeEvidence(candidate, {
    docs: [{ file: 'README.md', text: 'This SEO CMS publishes markdown and generates a sitemap.' }],
    package: { scripts: { test: 'node test.js' } },
  });
  assert.equal(result.fit, 'supported');
  assert.ok(result.keyword_hits >= 3);
  assert.match(result.question, /seo/i);
});

test('runs a candidate through an ephemeral lab and persists only the report', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cro-lab-test-'));
  const checks = [];
  const result = await lab.runCandidate({
    root,
    candidate,
    now: new Date('2026-09-22T12:00:00Z'),
    downloadArchiveImpl: async () => ({ url: 'https://codeload.github.com/acme/fleet-tool/tar.gz/main', buffer: Buffer.from('archive') }),
    extractArchiveImpl: (_archivePath, repoDir) => {
      fs.mkdirSync(repoDir, { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'README.md'), '# SEO publishing\nThis creates a sitemap for markdown content.');
      fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'fleet-tool', license: 'MIT', scripts: { test: 'node test.js' } }));
      fs.writeFileSync(path.join(repoDir, 'index.js'), 'module.exports = 1;\n');
    },
    runSandbox: async input => {
      checks.push(input);
      return [{ command: 'node --check /workspace/repo/index.js', status: 'passed', output: '' }];
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.workspace.project_mounts.length, 0);
  assert.equal(result.workspace.secrets, false);
  assert.equal(result.safety.dependency_install, 'not_performed');
  assert.equal(result.recommendation.decision, 'research');
  assert.equal(checks.length, 1);
  assert.deepEqual(lab.read(root, result.run_id), result);
});
