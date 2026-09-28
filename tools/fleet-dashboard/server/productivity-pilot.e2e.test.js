'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
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

test('productivity pilot API creates baseline and evaluates treatment output', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-productivity-api-'));
  fs.mkdirSync(path.join(root, 'sites', 'treatment.example', 'ops'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sites', 'control.example', 'ops'), { recursive: true });
  const server = createApp({ root }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const created = await request(server, 'POST', '/api/productivity/pilots', {
    name: 'API pilot',
    treatment_sites: ['treatment.example'],
    control_sites: ['control.example'],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.pilot.status, 'active');
  assert.equal(created.body.baseline.treatment.sites, 1);
  const evaluated = await request(
    server,
    'POST',
    `/api/productivity/pilots/${created.body.pilot.pilot_id}/evaluate`,
    { to: created.body.pilot.end_at, final: true }
  );
  assert.equal(evaluated.status, 200, JSON.stringify(evaluated.body));
  assert.equal(evaluated.body.evaluation.guardrails.measurement_required, true);
  const detail = await request(
    server,
    'GET',
    `/api/productivity/pilots/${created.body.pilot.pilot_id}`
  );
  assert.equal(detail.body.snapshots.length, 2);
});
