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
  assert.match(runner.buildPassPrompt(brief, 'legal'), /compliance/);
  assert.match(runner.buildPassPrompt(brief, 'domain-manager'), /created_by to domain-manager/);
  delete process.env.EXECUTIVE_DOMAIN;
  store.close();
});

test('accepts Legal messages and rejects unreviewed go-live proposals', () => {
  const legalPlan = runner.parseOutput(
    JSON.stringify({
      messages: [{ actor: 'legal', body: 'The launch needs a documented compliance checklist.' }],
      proposals: [
        {
          created_by: 'legal',
          title: 'Launch-readiness checklist',
          proposal_type: 'growth',
          summary: 'Resolve the private preview decision with evidence.',
          requested_action: 'Review the checklist before launch.',
          implementation: {
            site: 'example.com',
            launch_gate: 'go_live',
            legal_review: {
              status: 'approved',
              reviewed_by: 'legal',
              decision_note: 'No blocker found in the baseline.',
            },
          },
        },
      ],
    })
  );
  assert.equal(legalPlan.messages[0].actor, 'legal');
  assert.throws(
    () =>
      runner.parseOutput(
        JSON.stringify({
          proposals: [
            {
              created_by: 'ceo',
              title: 'Launch now',
              summary: 'Go live.',
              requested_action: 'Launch.',
              implementation: { site: 'example.com', launch_gate: 'go_live' },
            },
          ],
        })
      ),
    /approved legal review/
  );
});

test('normalizes ordinary Legal review wording to the internal CRO handoff states', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      proposal_reviews: [
        {
          proposal_id: 'cro-1',
          reviewed_by: 'legal',
          status: 'approved',
          decision_note: 'The public-purpose fit is acceptable for research.',
        },
      ],
    })
  );
  assert.equal(plan.proposal_reviews[0].status, 'accepted_research');
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

test('caps queue work and prevents two active implementations on one site', async () => {
  const { root, store } = db();
  for (const site of ['other.example', 'third.example', 'fourth.example'])
    fs.mkdirSync(path.join(root, 'sites', site), { recursive: true });
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [],
      proposals: [],
      change_requests: [
        {
          site: 'example.com',
          title: 'First bounded change',
          body: 'Do first',
          category: 'seo',
          priority: 'low',
        },
        {
          site: 'example.com',
          title: 'Duplicate bounded change',
          body: 'Do second',
          category: 'seo',
          priority: 'low',
        },
        {
          site: 'other.example',
          title: 'Second site change',
          body: 'Do third',
          category: 'seo',
          priority: 'low',
        },
        {
          site: 'third.example',
          title: 'Third site change',
          body: 'Do fourth',
          category: 'seo',
          priority: 'low',
        },
        {
          site: 'fourth.example',
          title: 'Fourth site change',
          body: 'Do fifth',
          category: 'seo',
          priority: 'low',
        },
      ],
      research_requests: [],
    })
  );
  const created = await runner.applyPlan(store, plan, { allowQueue: true, root });
  assert.equal(created.change_requests.length, 3);
  assert.equal(created.skipped_change_requests.length, 2);
  assert.equal(
    created.skipped_change_requests[0].reason,
    'site already has queued or active implementation work'
  );
  store.close();
});

test('reviews CRO handoffs without putting them in owner approval', async () => {
  const { root, store } = db();
  const cro = store.createExecutiveProposal({
    title: 'CRO candidate',
    proposal_type: 'product',
    created_by: 'researcher',
    summary: 'A purpose-fit repository lead.',
    requested_action: 'CEO and CTO validate it.',
  });
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [],
      proposal_reviews: [
        {
          proposal_id: cro.proposal_id,
          reviewed_by: 'ceo',
          status: 'accepted_research',
          decision_note: 'Commission bounded validation.',
        },
      ],
      proposals: [],
      change_requests: [],
      research_requests: [],
    })
  );
  const created = await runner.applyPlan(store, plan, { root });
  assert.equal(created.proposal_reviews[0].status, 'reviewed');
  assert.equal(store.getExecutiveProposal(cro.proposal_id).status, 'reviewed');
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

test('normalizes model proposal labels instead of retrying the manager run', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [],
      proposals: [
        {
          created_by: 'domain-manager',
          title: 'Technical health review',
          proposal_type: 'technical',
          summary: 'Review the site health before implementation.',
          requested_action: 'Approve a report-only review.',
        },
        {
          created_by: 'domain-manager',
          title: 'Unexpected model category',
          proposal_type: 'site-health-and-revenue',
          summary: 'Preserve this evidence-backed finding.',
          requested_action: 'Review the finding.',
        },
      ],
      change_requests: [],
      research_requests: [],
    })
  );
  assert.equal(plan.proposals[0].proposal_type, 'engineering');
  assert.equal(plan.proposals[1].proposal_type, 'report-only');
});

test('defaults an omitted model proposal type to the safe business category', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [],
      proposals: [
        {
          created_by: 'ceo',
          title: 'Portfolio review',
          summary: 'Review the current portfolio evidence.',
          requested_action: 'Review the findings.',
        },
      ],
      change_requests: [],
      research_requests: [],
    })
  );
  assert.equal(plan.proposals[0].proposal_type, 'business');
});

test('identifies read-only telemetry requests without suppressing implementation work', () => {
  assert.equal(
    runner.isTelemetryRequestProposal({
      title: 'Review measurement coverage',
      summary: 'Document analytics and attribution gaps.',
    }),
    true
  );
  assert.equal(
    runner.isTelemetryRequestProposal({
      title: 'Fix analytics instrumentation',
      summary: 'Ship a bounded implementation.',
      implementation: { site: 'example.com', title: 'Fix analytics', body: 'Add event.' },
    }),
    false
  );
  assert.equal(
    runner.isTelemetryRequestProposal({
      title: 'Improve content depth',
      summary: 'Review internal linking opportunities.',
    }),
    false
  );
});

test('enforces a bounded action or an explicit evidence-based rejection', () => {
  const brief = { action_mandate: { candidates: [{ site: 'example.com' }] } };
  assert.equal(
    runner.actionMandateSatisfied(
      { change_requests: [{ site: 'example.com' }], proposals: [], messages: [] },
      brief
    ),
    true
  );
  assert.equal(
    runner.actionMandateSatisfied(
      {
        change_requests: [],
        proposals: [],
        messages: [{ body: 'No safe action is justified by the evidence.' }],
      },
      brief
    ),
    true
  );
  assert.equal(
    runner.actionMandateSatisfied({ messages: [], proposals: [], change_requests: [] }, brief),
    false
  );
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

test('allows the independent reviewer to publish an owner update', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [{ actor: 'reviewer', body: 'The proposed work is bounded and measurable.' }],
    })
  );
  assert.equal(plan.messages[0].actor, 'reviewer');
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
