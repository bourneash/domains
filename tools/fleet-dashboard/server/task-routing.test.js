'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assignedRoleForType, assignedRoleForSite, ownershipMismatch } = require('./task-routing');

test('SEO tasks always start with the SEO analyst', () => {
  assert.equal(assignedRoleForType('seo', 'engineer'), 'seo-analyst');
  assert.equal(assignedRoleForType('SEO', 'principal-engineer'), 'seo-analyst');
  assert.equal(assignedRoleForType('engineering', 'engineer'), 'engineer');
  assert.equal(assignedRoleForType('content', 'engineer'), 'content-writer');
  assert.equal(assignedRoleForType('marketing', undefined), 'social-media');
  assert.deepEqual(ownershipMismatch('seo', 'engineer'), {
    expected_role: 'seo-analyst',
    allowed_roles: ['seo-analyst'],
  });
  assert.equal(ownershipMismatch('engineering', 'engineer'), null);
});

test('site-aware routing uses an installed equivalent role', () => {
  assert.equal(assignedRoleForSite('content', 'content-writer', ['news-writer']), 'news-writer');
  assert.equal(assignedRoleForSite('seo', 'seo-analyst', ['engineer']), undefined);
  assert.equal(
    assignedRoleForSite('seo', 'seo-analyst', ['seo-analyst', 'engineer']),
    'seo-analyst'
  );
});

test('SEO never treats an installed engineer as the SEO owner', () => {
  assert.equal(assignedRoleForSite('seo', 'engineer', ['engineer', 'promoter']), undefined);
});

test('implementation work selects an installed engineering owner', () => {
  assert.equal(assignedRoleForSite('engineering', 'principal-engineer', ['engineer']), 'engineer');
  assert.equal(assignedRoleForSite('engineering', 'principal-engineer', ['promoter']), undefined);
});

test('site-aware routing fails closed for empty inventories and non-owner substitutes', () => {
  assert.equal(assignedRoleForSite('seo', 'seo-analyst', []), undefined);
  assert.equal(assignedRoleForSite('content', 'engineer', ['engineer']), undefined);
  assert.equal(assignedRoleForSite('marketing', 'engineer', ['engineer']), undefined);
});
