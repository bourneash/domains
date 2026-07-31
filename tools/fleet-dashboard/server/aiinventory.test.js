'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const aiinventory = require('./aiinventory');

const ROOT = path.resolve(__dirname, '..', '..', '..');

test('scriptPath resolves the fleet canonical classifier', () => {
  assert.equal(aiinventory.scriptPath(ROOT), path.join(ROOT, 'tools', 'ai-inventory', 'audit-ai.py'));
});

test('fleet returns dispatch-aware rows and summary counts', async () => {
  const data = await aiinventory.fleet(ROOT);
  assert.ok(data.summary.services > 0);
  assert.equal(data.summary.services, data.rows.length);
  assert.equal(data.summary.ai, data.rows.filter((r) => r.provider !== 'None').length);
  const engineer = data.rows.find((r) => r.domain === '0daynews.com' && r.service === 'engineer');
  assert.equal(engineer.model, 'claude-sonnet-4-6');
  assert.equal(engineer.conditional, true);
  const deployer = data.rows.find((r) => r.domain === '0daynews.com' && r.service === 'deployer');
  assert.equal(deployer.provider, 'None');
});
