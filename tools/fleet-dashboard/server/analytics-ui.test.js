'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('analytics view exposes the affiliate funnel and conversion rate', () => {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
  assert.match(source, /metric=conversions/);
  assert.match(source, /Affiliate Funnel — click origin pages/);
  assert.match(source, /click\/session/);
  assert.match(source, /summary\.conversions \/ summary\.sessions/);
});
