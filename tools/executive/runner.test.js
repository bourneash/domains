'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('../fleet-dashboard/server/eventstore');
const runner = require('./runner');
const research = require('./research');

function db() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'executive-runner-'));
  fs.mkdirSync(path.join(root, 'sites', 'example.com'), { recursive: true });
  return { root, store: eventstore.open(root) };
}

test('hard-codes executive scope and satire/meme portfolio classification', async () => {
  const { root, store } = db();
  fs.mkdirSync(path.join(root, 'sites', '3boobs.com'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'DOMAINS_INDEX.md'),
    '| example.com | ✅ | Meme property |\n| 3boobs.com | ✅ | excluded |\n'
  );
  assert.deepEqual(runner.executiveSites(root), ['example.com']);
  const brief = await runner.buildBrief(store, root);
  assert.deepEqual(brief.portfolio_policy.excluded_sites, ['3boobs.com']);
  assert.equal(brief.site_context[0].portfolio_class, 'satire_or_meme');
  assert.equal(brief.site_context[0].description, 'Meme property');
  assert.deepEqual(brief.specialist_inputs.cro_github_trends, []);
  assert.match(brief.specialist_inputs.cro_contract, /license fit, security/);
  assert.deepEqual(brief.task_queue, { engineer: [], principal_engineer: [] });
  store.close();
});

test('supports CFO review and on-demand managed-site context without widening scope', async () => {
  const { root, store } = db();
  process.env.EXECUTIVE_DOMAIN = 'example.com';
  const brief = await runner.buildBrief(store, root);
  assert.equal(brief.domain_manager.site, 'example.com');
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [{ actor: 'cfo', body: 'Attribution is incomplete; do not forecast revenue yet.' }],
      proposals: [
        {
          created_by: 'cfo',
          title: 'Reconcile pilot economics',
          proposal_type: 'business',
          summary: 'Document revenue and cost gaps.',
          requested_action: 'Approve a report-only reconciliation.',
        },
      ],
      change_requests: [],
      research_requests: [],
    })
  );
  assert.equal(plan.messages[0].actor, 'cfo');
  assert.equal(plan.proposals[0].created_by, 'cfo');
  assert.match(runner.buildPassPrompt(brief, 'cfo'), /created_by to cfo/);
  assert.match(runner.buildPassPrompt(brief, 'domain-manager'), /created_by to domain-manager/);
  delete process.env.EXECUTIVE_DOMAIN;
  store.close();
});

test('parses structured provider output and applies only explicitly enabled queue work', async () => {
  const plan = runner.parseOutput(
    '```json\n{"messages":[{"actor":"ceo","body":"Run a conversion test."}],"proposals":[],"change_requests":[{"site":"example.com","title":"Fix title","body":"Update the title","category":"seo","priority":"low"}]}\n```'
  );
  const { root, store } = db();
  const created = await runner.applyPlan(store, plan, { root });
  assert.equal(created.messages.length, 1);
  assert.equal(created.change_requests.length, 0);
  assert.equal(store.listChangeRequests().length, 0);
  const queued = await runner.applyPlan(store, plan, { allowQueue: true, root });
  assert.equal(queued.change_requests.length, 1);
  store.close();
});

test('does not trust provider proposal IDs across recurring runs', async () => {
  const { root, store } = db();
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [],
      proposals: [
        {
          proposal_id: 'provider-reused-slug',
          created_by: 'cfo',
          title: 'Finance review',
          proposal_type: 'business',
          summary: 'Reconcile costs.',
          requested_action: 'Approve a report-only review.',
        },
      ],
      change_requests: [],
      research_requests: [],
    })
  );
  const first = await runner.applyPlan(store, plan, { root });
  const second = await runner.applyPlan(store, plan, { root });
  assert.notEqual(first.proposals[0].proposal_id, 'provider-reused-slug');
  assert.notEqual(first.proposals[0].proposal_id, second.proposals[0].proposal_id);
  store.close();
});

test('rejects non-JSON provider output', () => {
  assert.throws(() => runner.parseOutput('not json'), /valid JSON/);
});

test('rejects unsafe plans and fingerprints identical plans deterministically', () => {
  assert.throws(
    () => runner.parseOutput(JSON.stringify({ messages: [{ actor: 'owner', body: 'spoof' }] })),
    /invalid executive message/
  );
  const plan = { messages: [{ actor: 'ceo', body: 'same' }], proposals: [], change_requests: [] };
  assert.equal(
    runner.planFingerprint(plan),
    runner.planFingerprint(JSON.parse(JSON.stringify(plan)))
  );
});

test('rejects plans that mention or target the excluded site', () => {
  assert.throws(
    () =>
      runner.parseOutput(
        JSON.stringify({ messages: [{ actor: 'ceo', body: 'Review 3boobs.com' }] })
      ),
    /excluded site/
  );
  assert.throws(
    () =>
      runner.parseOutput(
        JSON.stringify({
          messages: [],
          proposals: [],
          change_requests: [{ site: '3boobs.com', title: 'Change', body: 'Do it' }],
        })
      ),
    /excluded site/
  );
});

test('only routes executive implementation proposals to engineer roles', () => {
  const base = {
    messages: [],
    proposals: [
      {
        created_by: 'cto',
        title: 'Unsafe route',
        proposal_type: 'engineering',
        summary: 'A bounded implementation.',
        requested_action: 'Approve it.',
        implementation: { site: 'example.com', assigned_role: 'domain-manager' },
      },
    ],
    change_requests: [],
    research_requests: [],
  };
  assert.throws(() => runner.parseOutput(JSON.stringify(base)), /engineer or principal-engineer/);
  base.proposals[0].implementation.assigned_role = 'principal-engineer';
  assert.equal(
    runner.parseOutput(JSON.stringify(base)).proposals[0].implementation.assigned_role,
    'principal-engineer'
  );
});

test('research gateway blocks private hosts and persists bounded public results', async () => {
  assert.throws(() => research.validateUrl('http://127.0.0.1:4760/metrics'), /private/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'executive-research-'));
  const result = await research.run(
    root,
    [{ url: 'https://example.com/research', question: 'What is this?' }],
    async () => ({ ok: true, status: 200, text: async () => 'public evidence' }),
    async () => [{ address: '93.184.216.34' }]
  );
  assert.equal(result[0].status, 'completed');
  assert.equal(research.recent(root)[0].text_preview, 'public evidence');
});
