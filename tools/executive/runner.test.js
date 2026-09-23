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
  assert.deepEqual(brief.work_items, []);
  assert.deepEqual(brief.knowledge, []);
  assert.deepEqual(brief.knowledge_summary, { total: 0, active: 0, completed: 0 });
  store.close();
});

test('compacts repeated executive evidence before sending it to model passes', () => {
  const bulky = {
    sites: ['example.com'],
    intelligence: {
      decision_support: {
        rows: Array.from({ length: 80 }, () => ({ detail: 'x'.repeat(2000) })),
      },
    },
    specialist_inputs: {
      cro_repo_lab_runs: [
        {
          run_id: 'lab-1',
          status: 'completed',
          candidate: { full_name: 'example/tool' },
          repository: { file_count: 200, files: Array.from({ length: 500 }, () => 'file.py') },
          checks: Array.from({ length: 100 }, () => ({ status: 'passed', output: 'ok' })),
        },
      ],
    },
    task_queue: {
      engineer: Array.from({ length: 50 }, (_, index) => ({
        request_id: String(index),
        status: 'cancelled',
        body: 'x'.repeat(2000),
      })),
    },
    work_items: Array.from({ length: 50 }, () => ({ evidence: [{ note: 'x'.repeat(2000) }] })),
  };
  const compact = runner.compactModelBrief(bulky);
  assert.ok(
    Buffer.byteLength(JSON.stringify(compact), 'utf8') <
      Buffer.byteLength(JSON.stringify(bulky), 'utf8') / 4
  );
  assert.equal(compact.specialist_inputs.cro_repo_lab_runs[0].repository.file_count, 200);
  assert.equal(compact.specialist_inputs.cro_repo_lab_runs[0].repository.files, undefined);
  assert.equal(compact.task_queue.engineer.length, 4);
  assert.equal(compact.work_items.length, 30);
  assert.match(compact.model_context_note, /authoritative artifacts/);
});

test('action-mandate fallback routes trusted candidates instead of producing a no-op', () => {
  const brief = {
    queue: [{ site: 'already-active.com', status: 'running' }],
    improvements: [],
    action_mandate: {
      candidates: [
        {
          site: 'one.com',
          type: 'seo',
          title: 'Improve one.com metadata',
          recommendation: 'Update the title and description using the observed query gap.',
          evidence: { impressions: 120 },
          metric: 'qualified clicks',
        },
        {
          site: 'two.com',
          type: 'portfolio-baseline',
          title: 'Baseline two.com',
          recommendation: 'Produce a read-only revenue-readiness baseline.',
          metric: 'attributable outbound clicks',
        },
        { site: '3boobs.com', type: 'seo', title: 'must never be selected' },
      ],
    },
  };
  const plan = runner.buildActionMandateFallback({ messages: [], change_requests: [] }, brief);
  assert.equal(plan.change_requests.length, 2);
  assert.deepEqual(
    plan.change_requests.map(item => [item.site, item.delivery_mode || 'direct']),
    [
      ['one.com', 'direct'],
      ['two.com', 'report_only'],
    ]
  );
  assert.match(plan.messages[0].body, /^Recommendation:/);
  runner.validatePlan(plan);
  assert.equal(runner.actionMandateSatisfied(plan, brief), true);
});

test('marks SEO-labelled baselines as report-only work', () => {
  const plan = runner.buildActionMandateFallback(
    { messages: [], change_requests: [] },
    {
      queue: [],
      improvements: [],
      action_mandate: {
        candidates: [
          {
            site: 'example.com',
            type: 'seo',
            title: 'Baseline example.com search opportunity',
            recommendation: 'Capture a read-only baseline before changing production.',
            metric: 'qualified clicks',
          },
        ],
      },
    }
  );
  assert.equal(plan.change_requests[0].delivery_mode, 'report_only');
});

test('routes an engineering-labelled content handoff through the content lane', () => {
  const plan = runner.buildActionMandateFallback(
    { messages: [], change_requests: [] },
    {
      queue: [],
      improvements: [],
      action_mandate: {
        candidates: [
          {
            site: 'news.example.com',
            type: 'engineering',
            title: 'Reassign the daily briefing task',
            recommendation: 'Route the existing content task to its installed writer role.',
            evidence: 'type=content requires content-writer; found news-writer',
          },
        ],
      },
    }
  );
  assert.equal(plan.change_requests[0].category, 'content');
  assert.equal(plan.change_requests[0].assigned_role, 'engineer');
});

test('does not reissue a delivered candidate with the same action key or title', () => {
  const intelligence = {
    decision_support: {
      seo: {
        actions: [
          { site: 'done.example', key: 'done-key', title: 'Already shipped', score: 100 },
          { site: 'new.example', key: 'new-key', title: 'New opportunity', score: 90 },
        ],
      },
    },
  };
  const candidates = runner.actionCandidates(intelligence, ['done.example', 'new.example'], {
    keys: new Set(['done-key']),
    titles: new Set(),
  });
  assert.deepEqual(
    candidates.map(row => row.site),
    ['new.example']
  );
});

test('provides a dedicated CRO review prompt and lets CEO review its plan', () => {
  const brief = {
    sites: ['example.com'],
    tool_contract: {},
    specialist_inputs: {},
    intelligence: { research: [] },
    task_queue: {},
    work_items: [],
    action_mandate: { candidates: [] },
  };
  assert.match(runner.buildPassPrompt(brief, 'cro'), /CRO pass/);
  assert.match(runner.buildPassPrompt(brief, 'cro'), /created_by to cro|created_by.*cro/i);
  assert.match(
    runner.buildPassPrompt(brief, 'ceo', { proposals: [{ title: 'CRO lead' }] }),
    /CANDIDATE PLAN FROM THE CRO/
  );
});

test('roles can create and update bounded workbench cases through the plan', async () => {
  const { root, store } = db();
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [],
      work_items: [
        {
          title: 'Build a legal source checklist',
          kind: 'education',
          owner: 'legal',
          priority: 'normal',
          summary: 'Create a small curated reading path for recurring disclosure reviews.',
          next_action: 'Collect primary sources and record jurisdiction/date metadata.',
        },
      ],
    })
  );
  const created = await runner.applyPlan(store, plan, { root });
  assert.equal(created.work_items.length, 1);
  assert.equal(store.listExecutiveWorkItems()[0].owner, 'legal');
  const id = created.work_items[0].work_id;
  const update = runner.parseOutput(
    JSON.stringify({
      work_items: [
        {
          work_id: id,
          status: 'in_progress',
          owner: 'cto',
          next_action: 'Review the source registry schema.',
        },
      ],
    })
  );
  const updated = await runner.applyPlan(store, update, { root });
  assert.equal(updated.work_items[0].status, 'in_progress');
  assert.equal(store.getExecutiveWorkItem(id).owner, 'cto');
  store.close();
});

test('roles can curate a source and move it through the learning queue', async () => {
  const { root, store } = db();
  const plan = runner.parseOutput(
    JSON.stringify({
      knowledge: [
        {
          title: 'OWASP Top 10',
          resource_type: 'official',
          audience: 'security',
          status: 'queued',
          url: 'https://owasp.org/www-project-top-ten/',
          publisher: 'OWASP',
          license: 'CC BY-SA',
          summary: 'Primary security risk taxonomy for review planning.',
          tags: ['security', 'baseline'],
        },
      ],
    })
  );
  const created = await runner.applyPlan(store, plan, { root });
  assert.equal(created.knowledge.length, 1);
  assert.equal(store.listExecutiveKnowledge({ audience: 'security' })[0].status, 'queued');
  store.close();
});

test('leadership role handoffs survive one autonomous end-to-end plan', async () => {
  const { root, store } = db();
  const item = store.createExecutiveWorkItem({
    title: 'Validate launch evidence',
    kind: 'evidence',
    owner: 'ceo',
  });
  const roles = ['ceo', 'cto', 'cfo', 'legal', 'security'];
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: roles.map(actor => ({
        actor,
        body: `${actor} reviewed the case and recorded the next bounded handoff.`,
        work_id: item.work_id,
        message_type: 'handoff',
        metadata: { to: 'owner' },
      })),
      work_items: [
        {
          work_id: item.work_id,
          status: 'in_progress',
          owner: 'cto',
          next_action: 'Collect the remaining evidence.',
        },
      ],
    })
  );
  const result = await runner.applyPlan(store, plan, { root });
  assert.equal(result.messages.length, roles.length);
  assert.equal(store.listExecutiveMessages({ work_id: item.work_id }).length, roles.length);
  assert.equal(store.getExecutiveWorkItem(item.work_id).owner, 'cto');
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
  assert.match(runner.buildPassPrompt(brief, 'security'), /fleet-doctor|security baseline/);
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
            security_review: {
              status: 'approved',
              reviewed_by: 'security',
              decision_note: 'Release boundary is bounded.',
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

test('drops a blank optional proposal review without discarding the rest of the plan', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [{ actor: 'reviewer', body: 'Recommendation: keep the bounded work.' }],
      proposal_reviews: [
        { proposal_id: 'stale-review', reviewed_by: 'reviewer', status: '' },
        {
          proposal_id: 'valid-review',
          reviewed_by: 'reviewer',
          status: 'accepted_research',
          decision_note: 'Useful evidence handoff.',
        },
      ],
    })
  );
  assert.deepEqual(
    plan.proposal_reviews.map(item => item.proposal_id),
    ['valid-review']
  );
  assert.equal(plan.messages.length, 1);
});

test('normalizes human-readable Legal and Security actor aliases without allowing owner spoofing', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [
        { actor: 'Legal/Compliance', body: 'Recommendation: keep the launch gated.' },
        { actor: 'Security Review', body: 'Recommendation: require a release checklist.' },
      ],
    })
  );
  assert.deepEqual(
    plan.messages.map(message => message.actor),
    ['legal', 'security']
  );
  assert.throws(
    () => runner.parseOutput(JSON.stringify({ messages: [{ actor: 'owner', body: 'spoof' }] })),
    /invalid executive message/
  );
});

test('normalizes domain-manager output aliases without weakening actor validation', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [
        {
          actor: 'domain manager',
          message_type: 'recommendation',
          body: 'Recommendation: refresh the site brief.',
        },
      ],
      proposal_reviews: [
        {
          proposal_id: 'cro-domain-1',
          reviewed_by: 'domain_manager',
          status: 'approved',
          decision_note: 'Accept the bounded research handoff.',
        },
      ],
    })
  );
  assert.equal(plan.messages[0].actor, 'domain-manager');
  assert.equal(plan.messages[0].message_type, 'decision_request');
  assert.equal(plan.proposal_reviews[0].reviewed_by, 'domain-manager');
  assert.equal(plan.proposal_reviews[0].status, 'accepted_research');
  assert.throws(
    () =>
      runner.parseOutput(JSON.stringify({ messages: [{ actor: 'unknown role', body: 'nope' }] })),
    /invalid executive message/
  );
});

test('accepts provider natural-language message field aliases inside the closed contract', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [{ role: 'domain manager', content: 'Recommendation: inspect the site backlog.' }],
    })
  );
  assert.equal(plan.messages[0].actor, 'domain-manager');
  assert.equal(plan.messages[0].body, 'Recommendation: inspect the site backlog.');
});

test('binds an omitted actor to the authenticated pass role', () => {
  const plan = runner.parseOutput(
    JSON.stringify({ messages: [{ body: 'Recommendation: keep this bounded.' }] }),
    { defaultActor: 'domain-manager' }
  );
  assert.equal(plan.messages[0].actor, 'domain-manager');
  assert.throws(
    () =>
      runner.parseOutput(JSON.stringify({ messages: [{ body: 'spoof' }] }), {
        defaultActor: 'owner',
      }),
    /invalid executive message/
  );
});

test('normalizes specialist review message types without widening the message contract', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [
        { actor: 'legal', message_type: 'data_use_review', body: 'Recommendation: keep the gate.' },
        {
          actor: 'security',
          message_type: 'security_review',
          body: 'Recommendation: retain isolation.',
        },
      ],
    })
  );
  assert.deepEqual(
    plan.messages.map(message => message.message_type),
    ['update', 'update']
  );
});

test('normalizes sparse work-item aliases without widening ownership', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      work_items: [
        {
          id: 'existing-case',
          owner: 'reviewer',
          kind: 'analytics',
          status: 'active',
          priority: 'medium',
          description: 'Telemetry needs a durable follow-up.',
          action: 'Record the exact source dependency.',
          evidence: { label: 'health', note: 'source unavailable' },
        },
      ],
    }),
    { defaultActor: 'cto' }
  );
  assert.deepEqual(plan.work_items[0], {
    id: 'existing-case',
    work_id: 'existing-case',
    title: 'Executive follow-up: existing-case',
    owner: 'cto',
    kind: 'evidence',
    status: 'in_progress',
    priority: 'normal',
    description: 'Telemetry needs a durable follow-up.',
    summary: 'Telemetry needs a durable follow-up.',
    action: 'Record the exact source dependency.',
    next_action: 'Record the exact source dependency.',
    evidence: [{ label: 'health', note: 'source unavailable' }],
  });
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

test('binds executive request follow-up to its role and preserves report-only routing', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      change_requests: [
        {
          site: 'example.com',
          title: 'Run a read-only diagnosis',
          body: 'Read-only inspection; do not deploy or change production.',
          category: 'other',
          priority: 'low',
          requested_by: 'cto',
        },
      ],
    })
  );
  assert.equal(plan.change_requests[0].requested_by, 'cto');
  assert.equal(plan.change_requests[0].delivery_mode, 'report_only');
  runner.validatePlan(plan);
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
  const previousLimit = process.env.EXECUTIVE_MAX_QUEUED_ACTIONS;
  process.env.EXECUTIVE_MAX_QUEUED_ACTIONS = '3';
  try {
    const created = await runner.applyPlan(store, plan, { allowQueue: true, root });
    assert.equal(created.change_requests.length, 3);
    assert.equal(created.skipped_change_requests.length, 2);
    assert.equal(
      created.skipped_change_requests[0].reason,
      'site already has queued or active implementation work'
    );
  } finally {
    if (previousLimit === undefined) delete process.env.EXECUTIVE_MAX_QUEUED_ACTIONS;
    else process.env.EXECUTIVE_MAX_QUEUED_ACTIONS = previousLimit;
    store.close();
  }
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
      {
        change_requests: [{ site: 'example.com' }],
        proposals: [],
        messages: [{ body: 'Recommendation: run the bounded test.' }],
      },
      brief
    ),
    true
  );
  assert.equal(
    runner.actionMandateSatisfied(
      {
        change_requests: [],
        proposals: [],
        messages: [{ body: 'Recommendation: run the bounded test. Owner, should we proceed?' }],
      },
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
    false
  );
  assert.equal(
    runner.actionMandateSatisfied({ messages: [], proposals: [], change_requests: [] }, brief),
    false
  );

  const portfolioBrief = {
    action_mandate: {
      candidates: [{ site: 'a.com' }, { site: 'b.com' }, { site: 'c.com' }],
    },
  };
  assert.equal(
    runner.actionMandateSatisfied(
      {
        proposals: [
          { implementation: { site: 'a.com', title: 'Routine fix', body: 'Do it' } },
          { implementation: { site: 'b.com', title: 'Routine fix', body: 'Do it' } },
          { implementation: { site: 'c.com', title: 'Routine fix', body: 'Do it' } },
        ],
        change_requests: [],
        messages: [{ body: 'Recommendation: route the bounded work.' }],
      },
      portfolioBrief
    ),
    false
  );
  assert.equal(
    runner.actionMandateSatisfied(
      {
        proposals: [],
        change_requests: [{ site: 'a.com' }, { site: 'b.com' }, { site: 'c.com' }],
        messages: [{ body: 'Recommendation: route the bounded work.' }],
      },
      portfolioBrief
    ),
    true
  );
});

test('surfaces a rotating multi-site portfolio batch from priorities and scorecards', () => {
  const candidates = runner.actionCandidates(
    {
      generated_at: '2026-09-22T16:50:02.576Z',
      decision_support: {
        seo: { actions: [{ site: 'searchwoot.com', title: 'Sitemap', rankScore: 86 }] },
        priorities: {
          items: [
            { site: '0daynews.com', title: 'Fix routing', score: 96, state: 'blocked' },
            { site: 'americastrikes.com', title: 'Replace OOS item', score: 96, state: 'blocked' },
          ],
          scorecards: [
            { site: 'eastcoastrappers.com', lifecycle: 'live', opportunity_score: 0 },
            { site: 'saveusfarms.com', lifecycle: 'live', opportunity_score: 0 },
          ],
        },
      },
    },
    [
      'searchwoot.com',
      '0daynews.com',
      'americastrikes.com',
      'eastcoastrappers.com',
      'saveusfarms.com',
    ]
  );
  assert.equal(new Set(candidates.map(item => item.site)).size, candidates.length);
  assert.ok(candidates.length >= 4);
  assert.ok(candidates.some(item => item.site === 'eastcoastrappers.com'));
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
