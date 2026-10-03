'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createApp } = require('./server');

function request(server, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: pathname,
        method,
        headers:
          body === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) })
        );
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('Workbench summary view preserves rendered fields and evidence counts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-workbench-summary-'));
  const server = createApp({ root }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const created = await request(server, 'POST', '/api/executive/work-items', {
    title: 'Summarize this workbench case',
    kind: 'evidence',
    owner: 'cto',
    priority: 'high',
    summary: 'Keep the operator context.',
    next_action: 'Review the attached evidence.',
    waiting_on: 'a deployment',
    evidence: [
      { type: 'test', label: 'First check', note: 'Passed.' },
      { type: 'artifact', label: 'Preview', url: 'https://example.test/preview' },
    ],
  });
  assert.equal(created.status, 201);

  const full = await request(server, 'GET', '/api/executive/work-items?limit=300&quiet=0');
  const compact = await request(
    server,
    'GET',
    '/api/executive/work-items?limit=300&quiet=0&summary=1'
  );
  assert.equal(full.status, 200);
  assert.equal(compact.status, 200);
  const fullItem = full.body.work_items.find(
    item => item.work_id === created.body.work_item.work_id
  );
  const summaryItem = compact.body.work_items.find(
    item => item.work_id === created.body.work_item.work_id
  );
  assert.equal(fullItem.evidence.length, 2);
  assert.equal(fullItem.evidence_contract, 'executive-evidence/v1');
  assert.equal(summaryItem.evidence_count, 2);
  assert.equal(summaryItem.summary, fullItem.summary);
  assert.equal(summaryItem.next_action, fullItem.next_action);
  assert.equal(summaryItem.waiting_on, fullItem.waiting_on);
  assert.ok(!('evidence' in summaryItem));
  assert.ok(!('resolution_note' in summaryItem));
  assert.equal(summaryItem.work_id, fullItem.work_id);
});
