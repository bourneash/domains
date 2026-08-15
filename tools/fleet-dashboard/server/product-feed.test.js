'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const productFeed = require('./product-feed');

test('inventoryStats() requests the verified-product inventory endpoint', async () => {
  let calledUrl = null;
  global.fetch = async url => {
    calledUrl = url;
    return { ok: true, json: async () => ({ products: 47, sites: {} }) };
  };
  assert.deepEqual(await productFeed.inventoryStats(), { products: 47, sites: {} });
  assert.match(calledUrl, /\/inventory\/stats$/);
});

test('subscriptionsWithDepth() reports independent per-site product state', async () => {
  global.fetch = async url => {
    const site = decodeURIComponent(url.match(/subscriptions\/([^/]+)\/inventory-depth$/)[1]);
    return {
      ok: true,
      json: async () => ({
        site,
        available: site === 'weirdgirlstore.com' ? 24 : 28,
        reviewing: 1,
        queued: 3,
        publishing: 0,
        published: 5,
        rejected: 2,
        active: 28,
      }),
    };
  };
  const rows = await productFeed.subscriptionsWithDepth();
  const girl = rows.find(row => row.site === 'weirdgirlstore.com');
  const stuff = rows.find(row => row.site === 'weirdassstuff.com');
  assert.equal(girl.available, 24);
  assert.equal(girl.target_available_depth, 24);
  assert.equal(stuff.available, 28);
  assert.equal(stuff.target_available_depth, 28);
  assert.equal(stuff.queued, 3);
});

test('recentProducts() never substitutes legacy candidates on failure', async () => {
  global.fetch = async () => {
    throw new Error('feed down');
  };
  const result = await productFeed.recentProducts(12);
  assert.equal(result.ok, false);
  assert.deepEqual(result.items, []);
  assert.match(result.error, /feed down/);
});
