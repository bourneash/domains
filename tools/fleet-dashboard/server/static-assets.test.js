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

function request(server, asset, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: asset.startsWith('/') ? asset : `/${asset}`,
        headers,
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('static dashboard assets use immutable versioned URLs and revalidate stable URLs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-static-assets-'));
  const server = createApp({ root }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const asset of ['index.html', 'app.js', 'shell.js', 'style.css', 'theme.css']) {
    const first = await request(server, asset);
    assert.equal(first.status, 200, asset);
    assert.equal(first.headers['cache-control'], 'private, no-cache', asset);
    assert.ok(first.headers.etag, asset);

    const revalidated = await request(server, asset, { 'If-None-Match': first.headers.etag });
    assert.equal(revalidated.status, 304, asset);
    assert.equal(revalidated.headers['cache-control'], 'private, no-cache', asset);
  }

  const index = await request(server, '/');
  const version = index.body.match(/app\.js\?v=([a-f0-9]{12})/)?.[1];
  assert.ok(version, 'document points at versioned assets');
  for (const asset of ['app.js', 'shell.js', 'scheduler-view.js', 'style.css', 'theme.css']) {
    const cached = await request(server, `${asset}?v=${version}`);
    assert.equal(cached.status, 200, asset);
    assert.equal(cached.headers['cache-control'], 'private, max-age=31536000, immutable', asset);
    assert.ok(index.body.includes(`${asset}?v=${version}`), `${asset} is versioned in HTML`);
  }
});
