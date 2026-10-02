'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { once } = require('node:events');
const { createApp } = require('./server');

function request(server, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: pathname,
        headers: { 'accept-encoding': 'gzip' },
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        );
      }
    );
    req.on('error', reject);
  });
}

test('gzip-compresses static assets without compressing API responses', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-dashboard-compression-'));
  const server = createApp({ root }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const asset = await request(server, '/app.js');
  assert.equal(asset.status, 200);
  assert.equal(asset.headers['content-encoding'], 'gzip');
  assert.equal(
    zlib.gunzipSync(asset.body).toString(),
    fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8')
  );

  const api = await request(server, '/api/version');
  assert.equal(api.status, 200);
  assert.equal(api.headers['content-encoding'], undefined);
});
