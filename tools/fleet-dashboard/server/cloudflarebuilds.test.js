'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const builds = require('./cloudflarebuilds');

const NOW = Date.parse('2026-09-10T12:00:00Z');

function fixture() {
  return {
    lastSweep: NOW - 60000,
    refreshing: false,
    error: null,
    errors: [],
    triggers: [
      {
        uuid: 'prod',
        worker: 'alpha-example',
        repo: 'alpha.example',
        providerAccount: 'owner',
        root: 'site',
        branchIncludes: ['main'],
        branchExcludes: [],
        pathIncludes: ['site/*', '.deploy-probe'],
        pathExcludes: ['ops/*'],
        caching: true,
      },
      {
        uuid: 'preview',
        worker: 'alpha-example',
        repo: 'alpha.example',
        providerAccount: 'owner',
        root: 'site',
        branchIncludes: ['*'],
        branchExcludes: ['main'],
        pathIncludes: ['site/*', '.deploy-probe'],
        pathExcludes: ['ops/*'],
        caching: true,
      },
    ],
    builds: [
      {
        uuid: 'one',
        worker: 'alpha-example',
        repo: 'alpha.example',
        providerAccount: 'owner',
        createdOn: '2026-09-09T10:00:00Z',
        durationSeconds: 120,
        outcome: 'success',
        commitHash: 'abcdef123456',
        commitMessage: 'publish: one',
      },
      {
        uuid: 'two',
        worker: 'alpha-example',
        repo: 'alpha.example',
        providerAccount: 'owner',
        createdOn: '2026-09-08T10:00:00Z',
        durationSeconds: 60,
        outcome: 'fail',
        commitHash: '123456abcdef',
        commitMessage: 'publish: two',
      },
    ],
  };
}

test('summarize rolls builds up by repository, day, policy, and cost window', () => {
  const out = builds.summarize(fixture(), { days: 7, limit: 50, now: NOW });
  assert.equal(out.summary.builds, 2);
  assert.equal(out.summary.minutes, 3);
  assert.equal(out.summary.failed, 1);
  assert.equal(out.summary.connectedRepos, 1);
  assert.equal(out.summary.productionTriggers, 1);
  assert.equal(out.summary.previewTriggers, 1);
  assert.equal(out.summary.compliantTriggers, 2);
  assert.equal(out.byRepo[0].builds, 2);
  assert.equal(out.byRepo[0].policyOk, true);
  assert.equal(out.byRepo[0].cacheOk, true);
  assert.equal(out.byDay.length, 2);
  assert.equal(out.builds.length, 2);
});

test('trigger compliance requires the fleet allowlist and cache', () => {
  const good = fixture().triggers[0];
  assert.equal(builds._triggerCompliant(good), true);
  assert.equal(builds._triggerCompliant({ ...good, pathIncludes: ['*'] }), false);
  assert.equal(builds._triggerCompliant({ ...good, pathExcludes: [] }), false);
  assert.equal(builds._triggerCompliant({ ...good, pathExcludes: ['ops/**'] }), false);
  assert.equal(builds._triggerCompliant({ ...good, caching: false }), false);
});

test('sanitized build excludes Cloudflare tokens and environment variables', () => {
  const row = builds._sanitizeBuild(
    {
      build_uuid: 'uuid',
      created_on: '2026-09-10T10:00:00Z',
      running_on: '2026-09-10T10:00:02Z',
      stopped_on: '2026-09-10T10:01:02Z',
      build_outcome: 'success',
      build_trigger_metadata: {
        repo_name: 'alpha.example',
        commit_hash: 'abc',
        environment_variables: { SECRET: 'must-not-leak' },
        build_token_uuid: 'must-not-leak',
      },
    },
    'alpha-example'
  );
  assert.equal(row.durationSeconds, 60);
  assert.equal(row.repo, 'alpha.example');
  assert.equal(Object.hasOwn(row, 'environment_variables'), false);
  assert.doesNotMatch(JSON.stringify(row), /must-not-leak/);
});

test('SPA exposes the professional Cloudflare build usage view', () => {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
  assert.match(source, /\['builds', 'Build Usage'\]/);
  assert.match(source, /renderCloudflareBuilds/);
  assert.match(source, /\/api\/cloudflare-builds/);
  assert.match(source, /Recent builds &amp; commits/);
  assert.match(source, /Live trigger inventory/);
});
