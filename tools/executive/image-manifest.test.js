'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'tools/executive/Dockerfile'), 'utf8');
const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
const sandbox = fs.readFileSync(path.join(ROOT, 'tools/executive/run-sandbox.sh'), 'utf8');

function copiedSources() {
  return [...dockerfile.matchAll(/^COPY\s+(?:--[^ ]+\s+)*([^\s]+)\s+/gm)].map(match => match[1]);
}

function digestSources() {
  return [...sandbox.matchAll(/"\$ROOT\/(tools\/fleet-dashboard\/server\/[^" ]+)"(?:\s+\\)?/g)].map(
    match => match[1]
  );
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('executive image sources exist, are not ignored, and participate in rebuild fingerprint', () => {
  const sources = copiedSources();
  assert.ok(sources.length > 0);
  for (const source of sources) {
    assert.equal(
      fs.existsSync(path.join(ROOT, source)),
      true,
      `missing Dockerfile source: ${source}`
    );
    const ignoreSource = fs.statSync(path.join(ROOT, source)).isDirectory() ? `${source}/` : source;
    assert.match(dockerignore, new RegExp(`^!${escapeRegex(ignoreSource)}$`, 'm'));
  }

  const dashboardSources = sources.filter(source => source.startsWith('tools/fleet-dashboard/'));
  const fingerprint = new Set(digestSources());
  for (const source of dashboardSources) {
    assert.equal(fingerprint.has(source), true, `source missing from rebuild digest: ${source}`);
  }
});

test('executive image declares a local base whose immutable ID is tracked by the wrapper', () => {
  assert.match(dockerfile, /^ARG\s+EXECUTIVE_BASE_IMAGE=/m);
  assert.match(dockerfile, /^FROM\s+\$\{EXECUTIVE_BASE_IMAGE\}$/m);
  assert.match(sandbox, /BASE_IMAGE_ID=.*docker image inspect/);
  assert.match(sandbox, /base-image-id=%s/);
  assert.match(sandbox, /sha256sum "\$ROOT\/\.dockerignore"/);
  assert.match(sandbox, /com\.bourneash\.executive\.base-image-id=\$BASE_IMAGE_ID/);
});
