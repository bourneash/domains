'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');

test('change queue UI exposes blocker, context, re-evaluation, and metric contracts', () => {
  assert.match(app, /class="cq-blocker"/);
  assert.match(app, /queue_block\.escalated/);
  assert.match(app, /context\.description/);
  assert.match(app, /change-requests\/\$\{encodeURIComponent\(b\.dataset\.id\)\}\/re-evaluate/);
  assert.match(app, /data\.queue_metrics\?\.oldest_blocked_at/);
});

test('change queue detail view repeats the authoritative blocker context', () => {
  assert.match(app, /insertAdjacentHTML\('beforeend', cqSiteContext\(r\) \+ cqBlocker\(r\)\)/);
  assert.match(app, /cq-detail-reevaluate/);
});
