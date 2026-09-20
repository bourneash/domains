'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSiteUrl, parseUserSites, summarizeLinks } = require('./bing');

test('normalizes Bing site URLs for API matching', () => {
  assert.equal(normalizeSiteUrl('https://www.Example.com/path'), 'https://example.com/');
  assert.deepEqual(parseUserSites([{ Url: 'http://www.Example.com/', IsVerified: true }]), [
    { url: 'http://www.Example.com/', host: 'example.com', verified: true },
  ]);
});

test('summarizes target counts and returned link details', () => {
  const summary = summarizeLinks(
    [
      {
        Links: [
          { Url: 'https://site.test/a', Count: 3 },
          { Url: 'https://site.test/b', Count: 1 },
        ],
      },
    ],
    [
      {
        Details: [
          { Url: 'https://ref.example/a', AnchorText: 'one' },
          { Url: 'https://ref.example/b', AnchorText: 'one' },
          { Url: 'https://other.test/x', AnchorText: 'two' },
        ],
      },
    ]
  );
  assert.equal(summary.backlinkCount, 4);
  assert.equal(summary.referringDomainsObserved, 2);
  assert.deepEqual(summary.domainCounts[0], ['ref.example', 2]);
  assert.deepEqual(summary.anchors[0], ['one', 2]);
});
