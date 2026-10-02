'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('isolated executive image includes eventstore static dependencies', () => {
  const root = path.resolve(__dirname, '..', '..');
  const source = fs.readFileSync(
    path.join(root, 'tools/fleet-dashboard/server/eventstore.js'),
    'utf8'
  );
  const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
  const ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
  const sandbox = fs.readFileSync(path.join(__dirname, 'run-sandbox.sh'), 'utf8');
  for (const [, moduleName] of source.matchAll(/require\(['"]\.\/(.+?)['"]\)/g)) {
    const file = `tools/fleet-dashboard/server/${moduleName}.js`;
    assert.match(dockerfile, new RegExp(`COPY --chown=dev:dev ${file.replaceAll('.', '\\.')} `));
    assert.ok(ignore.split('\n').includes(`!${file}`), `${file} excluded from build context`);
    assert.ok(sandbox.includes(`$ROOT/${file}`), `${file} absent from source fingerprint`);
  }
});

test('isolated executive image includes queue readiness static dependencies', () => {
  const root = path.resolve(__dirname, '..', '..');
  const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
  const ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
  const sandbox = fs.readFileSync(path.join(__dirname, 'run-sandbox.sh'), 'utf8');
  for (const file of [
    'tools/fleet-dashboard/server/changequeue-view.js',
    'tools/fleet-dashboard/server/fleetregistry.js',
  ]) {
    assert.ok(dockerfile.includes(`COPY --chown=dev:dev ${file} `));
    assert.ok(ignore.split('\n').includes(`!${file}`));
    assert.ok(sandbox.includes(`$ROOT/${file}`));
  }
  assert.ok(sandbox.indexOf('EXECUTIVE_PREFLIGHT_ONLY') < sandbox.indexOf('RUN_DIR="$(mktemp'));
});

test('sandbox terminal failure checks consecutive executive failures immediately', () => {
  const sandbox = fs.readFileSync(path.join(__dirname, 'run-sandbox.sh'), 'utf8');
  assert.match(sandbox, /runtime\.finish\(store, runId/);
  assert.match(sandbox, /agent\?\.slug === 'fleet-ceo' && updated\.status === 'failed'/);
  assert.match(sandbox, /await alertConsecutiveFailures\(store/);
});
