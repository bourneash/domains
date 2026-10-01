'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventstore = require('../fleet-dashboard/server/eventstore');
const runner = require('./runner');
const research = require('./research');
const executive = require('../fleet-dashboard/server/executive');

function db() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'executive-runner-'));
  fs.mkdirSync(path.join(root, 'sites', 'example.com'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sites', 'example.com', 'ops', 'roles'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'sites', 'example.com', 'ops', 'roles', 'engineer.md'),
    '# Engineer\n'
  );
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

test('model prompts hide excluded-domain identifiers while preserving the safety rule', () => {
  const prompt = runner.buildPrompt({
    intelligence: {},
    portfolio_policy: {
      managed_sites: 'all discovered fleet sites except 3boobs.com',
      excluded_sites: ['3boobs.com'],
    },
  });
  assert.equal(prompt.includes('3boobs.com'), false);
  assert.match(prompt, /\[excluded-site\]/);
  assert.match(prompt, /Do not target, analyze, or mention/);
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

test('prioritizes unanswered owner requests ahead of the general work backlog', () => {
  const backlog = Array.from({ length: 150 }, (_, index) => ({
    work_id: `backlog-${index}`,
    status: 'in_progress',
    source_type: 'system',
  }));
  const request = {
    work_id: 'owner-request-1',
    status: 'waiting',
    lifecycle_state: 'submitted',
    source_type: 'owner-request',
    answered_at: null,
  };

  const selected = runner.prioritizeExecutiveWorkItems([...backlog, request], 100);
  assert.equal(selected[0].work_id, request.work_id);
  assert.equal(selected.length, 101);
  assert.equal(
    selected.some(item => item.work_id === 'backlog-100'),
    false
  );

  const compact = runner.compactModelBrief({
    intelligence: {},
    work_items: [...backlog.slice(0, 40), request],
  });
  assert.equal(compact.work_items[0].work_id, request.work_id);
});

test('reviewer cannot author or replace executive proposals', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [{ actor: 'reviewer', body: 'Recommendation: keep the bounded repair.' }],
      proposals: [
        {
          created_by: 'reviewer',
          title: 'Reviewer proposal that must not become durable',
          summary: 'This is review output, not a new proposal.',
          requested_action: 'Do not create this proposal.',
        },
      ],
      change_requests: [],
    }),
    { defaultActor: 'reviewer' }
  );
  assert.deepEqual(plan.proposals, []);
});

test('action-mandate fallback routes trusted candidates instead of producing a no-op', () => {
  const brief = {
    queue: [{ site: 'already-active.com', status: 'running' }],
    improvements: [],
    action_mandate: {
      candidates: [
        {
          site: 'one.com',
          key: 'seo:one.com:metadata',
          type: 'seo',
          title: 'Improve one.com metadata',
          recommendation: 'Update the title and description using the observed query gap.',
          evidence: { impressions: 120 },
          metric: 'qualified clicks',
        },
        {
          site: 'two.com',
          key: 'task-routing:two.com:content.md',
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
  assert.equal(plan.change_requests[1].action_key, 'task-routing:two.com:content.md');
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

test('over-capacity fallback creates an accepted delivery-control checkpoint', () => {
  const brief = {
    generated_at: '2026-09-29T05:00:00.000Z',
    queue: [{ site: 'busy.example.com', status: 'queued' }],
    improvements: [],
    active_delivery: {
      policy: { max_active_slots: 10, active_slots: 10, overflow_count: 3 },
    },
    action_mandate: { candidates: [{ site: 'new.example.com', type: 'seo' }] },
  };
  const plan = runner.buildActionMandateFallback({ messages: [], change_requests: [] }, brief);
  assert.equal(plan.work_items.length, 1);
  assert.equal(plan.work_items[0].owner, 'delivery-lead');
  assert.equal(plan.work_items[0].kind, 'implementation');
  assert.equal(plan.work_items[0].actionability, 'blocker');
  assert.equal(runner.actionMandateSatisfied(plan, brief), true);
});

test('action mandate rejects generic checkpoints and proposal-only plans', () => {
  const brief = { action_mandate: { candidates: [] } };
  assert.equal(
    runner.actionMandateSatisfied(
      { proposals: [{ title: 'More research' }], work_items: [{ title: 'Checkpoint' }] },
      brief
    ),
    false
  );
  assert.equal(
    runner.actionMandateSatisfied(
      {
        work_items: [
          {
            actionability: 'blocker',
            owner: 'delivery-lead',
            priority: 'high',
            summary: 'A queue dependency is blocking delivery.',
            next_action: 'Assign the dependency and queue the next task.',
          },
        ],
      },
      brief
    ),
    true
  );
});

test('empty candidate fallback creates an owner-bound delivery blocker', () => {
  const brief = {
    generated_at: '2026-09-29T05:00:00.000Z',
    action_mandate: { candidates: [], deferred_candidates: [] },
    proposal_execution: { approved_proposals_unexecuted: 2 },
  };
  const plan = runner.buildActionMandateFallback({ messages: [], change_requests: [] }, brief);
  assert.equal(plan.work_items.length, 1);
  assert.equal(plan.work_items[0].actionability, 'blocker');
  assert.equal(plan.work_items[0].owner, 'delivery-lead');
  assert.match(plan.work_items[0].next_action, /approved implementation-ready/);
  assert.equal(runner.actionMandateSatisfied(plan, brief), true);
});

test('site-factory candidates turn queue-ready parked sites into bounded launch-readiness reports', () => {
  const candidates = runner.siteFactoryCandidates(
    [
      {
        domain: 'ready.example.com',
        lifecycle: 'scaffold',
        parked: true,
        parked_days: 120,
        capabilities: ['site', 'ops'],
      },
      { domain: 'live.example.com', lifecycle: 'live', parked: false },
    ],
    ['ready.example.com', 'live.example.com'],
    { keys: new Set(), titles: new Set() }
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].type, 'site-factory');
  assert.equal(candidates[0].delivery_mode, 'report_only');
  assert.match(candidates[0].title, /ready\.example\.com/);
});

test('candidate capacity distinguishes independent work lanes', () => {
  assert.equal(runner.candidateQueueCategory({ type: 'seo' }), 'seo');
  assert.equal(runner.candidateQueueCategory({ type: 'design' }), 'design');
  assert.equal(runner.candidateQueueCategory({ type: 'click-uplift' }), 'marketing');
  assert.equal(runner.candidateQueueCategory({ type: 'site-factory-build' }), 'engineering');
});

test('approved report-only commitments are queueable unless explicitly disabled', () => {
  assert.deepEqual(
    runner.approvedFollowThroughQueueDecision(
      { proposal_type: 'report-only' },
      { delivery_mode: 'report_only' }
    ),
    { queue: true, reason: 'approved bounded report-only follow-through' }
  );
  assert.equal(
    runner.approvedFollowThroughQueueDecision(
      { proposal_type: 'report-only' },
      { delivery_mode: 'report_only', allow_model_followthrough: false }
    ).queue,
    false
  );
});

test('site-factory launch-readiness reports do not satisfy the delivery mandate', () => {
  const brief = {
    launch_readiness: [],
    action_mandate: {
      candidates: [
        { site: 'one.example.com', type: 'site-factory', delivery_mode: 'report_only' },
        { site: 'two.example.com', type: 'site-factory', delivery_mode: 'report_only' },
        { site: 'three.example.com', type: 'site-factory', delivery_mode: 'report_only' },
      ],
    },
  };
  assert.equal(
    runner.actionMandateSatisfied(
      { change_requests: [{ site: 'one.example.com', delivery_mode: 'report_only' }] },
      brief
    ),
    false
  );
  assert.equal(
    runner.actionMandateSatisfied(
      {
        change_requests: [
          { site: 'one.example.com', delivery_mode: 'report_only' },
          { site: 'two.example.com', delivery_mode: 'report_only' },
          { site: 'three.example.com', delivery_mode: 'report_only' },
        ],
      },
      brief
    ),
    false
  );
});

test('site-factory continues from a verified readiness report to a shippable preview', () => {
  const candidates = runner.siteFactoryBuildCandidates(
    [
      { domain: 'ready.example.com', lifecycle: 'scaffold' },
      { domain: 'not-ready.example.com', lifecycle: 'scaffold' },
    ],
    {
      keys: new Set(),
      titles: new Set(['ready.example.com:prepare launch readiness brief for ready example com']),
    }
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].type, 'site-factory-build');
  assert.equal(candidates[0].site, 'ready.example.com');
  assert.match(candidates[0].recommendation, /preview-only launch gate/);
});

test('action-mandate fallback escalates a fully blocked fleet to delivery leadership', () => {
  const brief = {
    generated_at: '2026-09-27T21:00:00.000Z',
    queue: [],
    improvements: [],
    productivity: {
      queue_ready_fleet_sites: [],
      blocked_fleet_sites: [
        {
          site: 'example.com',
          reason: 'active improvement: measuring',
          measurement_due: '2026-10-07',
        },
      ],
    },
    action_mandate: { candidates: [] },
  };
  const plan = runner.buildActionMandateFallback({ messages: [], change_requests: [] }, brief);
  assert.equal(plan.work_items.length, 1);
  assert.equal(plan.work_items[0].work_id, 'executive-throughput-escalation:2026-09-27');
  assert.equal(plan.work_items[0].owner, 'delivery-lead');
  assert.equal(plan.work_items[0].priority, 'high');
  assert.match(plan.work_items[0].title, /no queue-ready fleet sites/);
  assert.match(plan.work_items[0].summary, /example\.com/);
  assert.match(plan.work_items[0].next_action, /six hours/);
});

test('normalizes provider measurement work into the evidence lane', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      work_items: [
        {
          title: 'Measure the SEO treatment result',
          kind: 'measurement',
          status: 'in_progress',
          owner: 'delivery-lead',
          next_action: 'Record the before and after result.',
        },
      ],
    }),
    { defaultActor: 'delivery-lead' }
  );
  assert.equal(plan.work_items[0].kind, 'evidence');
});

test('restores an exact trusted task-routing key omitted by a provider', () => {
  const plan = {
    change_requests: [
      {
        site: 'example.com',
        title: 'Route the existing content task',
      },
    ],
  };
  runner.attachKnownActionKeys(plan, {
    action_mandate: {
      candidates: [
        {
          site: 'example.com',
          title: 'Route the existing content task',
          key: 'task-routing:example.com:ops/tasks/content.md',
        },
      ],
    },
  });
  assert.equal(plan.change_requests[0].action_key, 'task-routing:example.com:ops/tasks/content.md');
});

test('reserves queue capacity for approved implementation work', () => {
  assert.deepEqual(runner.approvedWorkQueueBudgets(6), {
    total: 6,
    proposals: 2,
    failureDiagnostics: 2,
    dataQuality: 2,
  });
  assert.deepEqual(runner.approvedWorkQueueBudgets(2), {
    total: 2,
    proposals: 1,
    failureDiagnostics: 1,
    dataQuality: 0,
  });
  assert.deepEqual(runner.approvedWorkQueueBudgets(1), {
    total: 1,
    proposals: 0,
    failureDiagnostics: 1,
    dataQuality: 0,
  });
});

test('uses stable lineage for chained automatic failure diagnoses', () => {
  const key = runner.failureDiagnosisLineageKey({
    site: 'arttogogh.com',
    title:
      'Repair failed request: Failure diagnosis: Follow through: Arttogogh orchestration failure diagnosis',
  });
  assert.equal(key, 'arttogogh.com:arttogogh orchestration failure diagnosis');
});

test('recognizes a completed diagnosis or repair descendant', () => {
  const requests = [
    {
      request_id: 'failed-1',
      status: 'failed',
      body: 'original',
    },
    {
      request_id: 'diagnosis-1',
      status: 'verified',
      delivery_mode: 'report_only',
      action_key: 'failure-diagnosis:failed-1',
    },
    {
      request_id: 'failed-2',
      status: 'failed',
      body: 'original',
    },
    {
      request_id: 'repair-2',
      status: 'deployed',
      body: 'Project-manager work_id: failed-change-request:failed-2',
    },
  ];
  assert.equal(
    runner.failedRequestDescendantCompleted(requests, 'failed-1').request_id,
    'diagnosis-1'
  );
  assert.equal(
    runner.failedRequestDescendantCompleted(requests, 'failed-2').request_id,
    'repair-2'
  );
  assert.equal(runner.failedRequestDescendantCompleted(requests, 'missing'), null);
});

test('reconciles completed failure work items without deleting request history', () => {
  const items = [
    {
      work_id: 'failed-change-request:failed-1',
      source_type: 'failed-change-request',
      source_id: 'failed-1',
      status: 'open',
      evidence: [],
    },
  ];
  const requests = [
    { request_id: 'failed-1', status: 'failed', body: 'original' },
    {
      request_id: 'diagnosis-1',
      status: 'verified',
      delivery_mode: 'report_only',
      action_key: 'failure-diagnosis:failed-1',
    },
  ];
  let updated;
  const store = {
    listChangeRequests: () => requests,
    listExecutiveWorkItems: () => items,
    getChangeRequest: id => requests.find(request => request.request_id === id),
    updateExecutiveWorkItem: (id, patch) => {
      updated = { id, patch };
      return { ...items[0], ...patch };
    },
  };
  const result = runner.reconcileCompletedFailureFollowups(store);
  assert.equal(result.length, 1);
  assert.equal(updated.patch.status, 'done');
  assert.equal(updated.patch.lifecycle_state, 'closed');
  assert.match(updated.patch.resolution_note, /diagnosis-1/);
  assert.equal(requests.length, 2);
});

test('does not infer a task-routing key from a near-match', () => {
  const plan = {
    change_requests: [{ site: 'example.com', title: 'Route another content task' }],
  };
  runner.attachKnownActionKeys(plan, {
    action_mandate: {
      candidates: [
        {
          site: 'example.com',
          title: 'Route the existing content task',
          key: 'task-routing:example.com:ops/tasks/content.md',
        },
      ],
    },
  });
  assert.equal(plan.change_requests[0].action_key, undefined);
});

test('infers unique site aliases for approved report-only work', () => {
  const { root, store } = db();
  fs.mkdirSync(path.join(root, 'sites', 'arttogogh.com'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sites', 'greatamericanlakes.com'), { recursive: true });
  assert.equal(
    runner.proposalSite({ title: 'Arttogogh search measurement baseline' }, root),
    'arttogogh.com'
  );
  assert.equal(
    runner.proposalSite({ title: 'Great American Lakes revenue baseline' }, root),
    'greatamericanlakes.com'
  );
  store.close();
});

test('normalizes approved report-only work to queue-safe fields', () => {
  const { root, store } = db();
  const implementation = runner.normalizeApprovedImplementation(
    {
      title: 'Finance readiness report',
      site: 'example.com',
      implementation: {
        site: 'example.com',
        title: 'Finance readiness report',
        body: 'Capture a read-only baseline.',
        category: 'finance',
        assigned_role: 'cfo',
        provider: 'chatgpt',
      },
    },
    root
  );
  assert.equal(implementation.category, 'other');
  assert.equal(implementation.assigned_role, 'engineer');
  assert.equal(implementation.provider, 'chatgpt');
  assert.equal(implementation.model, 'gpt-5.6-luna');
  store.close();
});

test('synthesizes executable briefs for approved implementation metadata', () => {
  const { root, store } = db();
  const implementation = runner.normalizeApprovedImplementation(
    {
      title: 'Improve affiliate conversion path',
      summary: 'Ship one reversible affiliate CTA improvement.',
      requested_action: 'Use existing affiliate configuration only.',
      proposal_type: 'growth',
      implementation: {
        site: 'example.com',
        scope: 'Inspect commercial pages and improve one CTA or merchandising surface.',
        constraints: ['Preserve the existing tracking ID.', 'Do not invent revenue results.'],
        primary_metric: 'affiliate clicks and ordered items',
      },
    },
    root
  );
  assert.equal(implementation.title, 'Improve affiliate conversion path');
  assert.equal(implementation.category, 'marketing');
  assert.match(implementation.body, /Preserve the existing tracking ID/);
  assert.equal(implementation.delivery_mode, 'direct');
  store.close();
});

test('routes concrete SEO candidates as implementation work', () => {
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
            recommendation: 'Update the title and description using the observed query gap.',
            metric: 'qualified clicks',
          },
        ],
      },
    }
  );
  assert.notEqual(plan.change_requests[0].delivery_mode, 'report_only');
});

test('keeps a site behind a blocked private launch gate out of direct delivery', () => {
  const plan = runner.buildActionMandateFallback(
    { messages: [], change_requests: [] },
    {
      queue: [],
      improvements: [],
      launch_readiness: [
        {
          site: 'searchwoot.com',
          current_disposition: 'keep_private',
          authoritative_evidence: { disposition: 'blocked' },
        },
      ],
      action_mandate: {
        candidates: [
          {
            site: 'searchwoot.com',
            type: 'crawlability',
            title: 'Restore the sitemap crawl path',
            recommendation: 'Inspect the private preview sitemap without changing production.',
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

test('supports over-sampling candidates before capacity filtering', () => {
  const candidates = runner.actionCandidates(
    {
      generated_at: '2026-09-23T07:00:00.000Z',
      decision_support: {
        priorities: {
          scorecards: Array.from({ length: 4 }, (_, index) => ({
            site: `site-${index}.example.com`,
            lifecycle: 'live',
            opportunity_score: 100 - index,
          })),
        },
      },
    },
    Array.from({ length: 4 }, (_, index) => `site-${index}.example.com`),
    { keys: new Set(), titles: new Set() },
    4
  );
  assert.equal(candidates.length, 4);
  assert.deepEqual(
    candidates.map(row => row.site),
    ['site-0.example.com', 'site-1.example.com', 'site-2.example.com', 'site-3.example.com']
  );
});

test('classifies organic page opportunities as SEO work', () => {
  const candidates = runner.actionCandidates(
    {
      generated_at: '2026-09-23T07:00:00.000Z',
      decision_support: {
        priorities: {
          items: [
            {
              site: 'example.com',
              kind: 'page-opportunity',
              title: 'Grow organic reach for the tips page',
              recommendation: 'Improve search intent coverage and internal links.',
              score: 79,
            },
          ],
        },
      },
    },
    ['example.com'],
    { keys: new Set(), titles: new Set() }
  );
  assert.equal(candidates[0].type, 'seo');
});

test('does not create a duplicate candidate while the failed request is retryable', () => {
  const candidates = runner.actionCandidates(
    {
      generated_at: '2026-09-23T07:00:00.000Z',
      decision_support: {
        seo: {
          actions: [
            {
              site: 'example.com',
              title: 'Repair metadata',
              rankScore: 90,
            },
          ],
        },
      },
    },
    ['example.com'],
    {
      keys: new Set(),
      titles: new Set(),
      failed: new Map([
        [
          'example.com:repair metadata',
          { until: Date.parse('2026-09-23T07:30:00.000Z'), attempts: 1 },
        ],
      ]),
    }
  );
  assert.equal(candidates.length, 0);
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

test('provides distinct fleet-tooling and managed-site product manager prompts', () => {
  const brief = {
    sites: ['example.com'],
    tool_contract: {},
    specialist_inputs: {},
    intelligence: { research: [] },
    task_queue: {},
    work_items: [],
    action_mandate: { candidates: [] },
  };
  assert.match(runner.buildPassPrompt(brief, 'product-manager-fleet'), /Fleet tooling/);
  assert.match(
    runner.buildPassPrompt(brief, 'product-manager-sites'),
    /managed websites portfolio/
  );
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [
        {
          actor: 'product-manager-fleet',
          body: 'Recommendation: improve operator workflow.',
        },
      ],
      proposals: [
        {
          created_by: 'product-manager-sites',
          title: 'Improve site product journey',
          summary: 'A bounded product opportunity.',
          requested_action: 'CEO review the recommendation.',
        },
      ],
    }),
    { defaultActor: 'product-manager-fleet' }
  );
  assert.equal(plan.messages[0].actor, 'product-manager-fleet');
  assert.equal(plan.proposals[0].created_by, 'product-manager-sites');
});

test('roles create durable cases but route routine updates to the tracking stream', async () => {
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
  assert.equal(updated.work_items.length, 0);
  assert.equal(updated.tracking_updates.length, 1);
  assert.equal(store.getExecutiveWorkItem(id).owner, 'legal');
  assert.equal(store.listExecutiveActions({ action_type: 'track' }).length, 1);
  store.close();
});

test('capacity unblock plans reconcile into one durable CTO case', async () => {
  const { root, store } = db();
  const item = title => ({
    title,
    kind: 'implementation',
    status: 'in_progress',
    priority: 'high',
    owner: 'cto',
    site: 'fleet',
    summary: 'The delivery queue is blocked by infrastructure reviews.',
    next_action: 'Repair the preserved reviews and clear one slot by tomorrow.',
  });
  const first = await runner.applyPlan(
    store,
    runner.parseOutput(
      JSON.stringify({
        work_items: [item('Release one delivery slot before new work')],
      })
    ),
    { root }
  );
  const second = await runner.applyPlan(
    store,
    runner.parseOutput(
      JSON.stringify({
        work_items: [item('Release one implementation slot before admitting candidates')],
      })
    ),
    { root }
  );
  assert.equal(first.work_items[0].work_id, 'delivery-capacity-unblock');
  assert.equal(second.work_items.length, 0);
  assert.equal(second.tracking_updates.length, 1);
  assert.equal(
    store.listExecutiveWorkItems().filter(row => row.work_id === 'delivery-capacity-unblock')
      .length,
    1
  );
  store.close();
});

test('explicit tracking updates never mutate the workbench or count as delivery', async () => {
  const { root, store } = db();
  const item = store.createExecutiveWorkItem({
    work_id: 'tracking-case',
    title: 'Existing evidence case',
    kind: 'evidence',
    status: 'open',
    priority: 'normal',
    owner: 'cto',
    summary: 'Evidence is being collected.',
    next_action: 'Collect the next source.',
  });
  const plan = runner.parseOutput(
    JSON.stringify({
      tracking_updates: [
        {
          work_id: item.work_id,
          actor: 'cto',
          summary: 'The evidence source was checked; no delivery decision changed.',
          status: 'in_progress',
        },
      ],
    })
  );
  const result = await runner.applyPlan(store, plan, { root });
  assert.equal(result.tracking_updates.length, 1);
  assert.equal(store.getExecutiveWorkItem(item.work_id).status, 'open');
  assert.equal(store.listExecutiveActions({ action_type: 'track' }).length, 1);
  store.close();
});

test('explicit new-site owner requests receive a deterministic site-factory handoff', () => {
  const { root, store } = db();
  const owner = executive.ownerRequest(store, {
    body: 'I acquired howtofry.com; onboard the new site in full with an affiliate content plan.',
  });
  executive.transitionOwnerRequest(store, owner.work_item.work_id, 'answered', {
    waiting_on: 'owner',
  });
  const handoffs = runner.ensureOwnerRequestHandoffs(store);
  assert.equal(handoffs[0].status, 'dispatched');
  const handoff = store.getExecutiveWorkItem(handoffs[0].work_id);
  assert.equal(handoff.owner, 'site-factory');
  assert.equal(handoff.site, 'howtofry.com');
  assert.equal(handoff.status, 'ready');
  assert.equal(store.getExecutiveWorkItem(owner.work_item.work_id).lifecycle_state, 'actioned');
  assert.equal(
    store
      .listExecutiveActions({ action_type: 'delegate' })
      .some(action => action.target_id === handoff.work_id),
    true
  );
  store.close();
});

test('sensitive new-site owner requests remain visible as safety gates', () => {
  const { root, store } = db();
  const owner = executive.ownerRequest(store, {
    body: 'Build a pretend escort site at magic.example.com with booking and always unavailable personalities.',
  });
  executive.transitionOwnerRequest(store, owner.work_item.work_id, 'answered', {
    waiting_on: 'executive-team',
  });
  const handoffs = runner.ensureOwnerRequestHandoffs(store);
  assert.equal(handoffs[0].status, 'safety-gated');
  assert.equal(store.getExecutiveWorkItem(owner.work_item.work_id).lifecycle_state, 'answered');
  assert.equal(store.listExecutiveWorkItems({ source_type: 'owner-request-handoff' }).length, 0);
  store.close();
});

test('stale message work links are skipped without aborting the executive plan', async () => {
  const { root, store } = db();
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [
        {
          actor: 'ceo',
          body: 'This stale thread should be audited and skipped.',
          work_id: 'closed-or-missing-work-item',
        },
        { actor: 'cto', body: 'The rest of the plan remains actionable.' },
      ],
      work_items: [
        {
          title: 'Continue the bounded delivery plan',
          kind: 'implementation',
          owner: 'delivery-lead',
          priority: 'high',
          summary: 'Keep valid plan work moving even when a message link is stale.',
          next_action: 'Review the active queue and select the next bounded item.',
        },
      ],
    })
  );
  const created = await runner.applyPlan(store, plan, { root });
  assert.equal(created.work_items.length, 1);
  assert.equal(created.messages.length, 1);
  assert.equal(created.skipped_messages.length, 1);
  assert.equal(created.skipped_messages[0].work_id, 'closed-or-missing-work-item');
  assert.equal(store.listExecutiveMessages().length, 1);
  assert.equal(
    store
      .listExecutiveActions({ limit: 20 })
      .some(action => action.status === 'skipped' && action.action_type === 'message'),
    true
  );
  store.close();
});

test('every pending owner request receives a linked executive acknowledgement', async () => {
  const { root, store } = db();
  const tracked = executive.ownerRequest(store, {
    body: 'Please review and implement the reporting capability.',
  });
  const plan = runner.parseOutput(JSON.stringify({ messages: [] }));
  const created = await runner.applyPlan(store, plan, { root });
  assert.equal(created.messages.length, 1);
  assert.equal(created.messages[0].actor, 'ceo');
  assert.equal(created.messages[0].work_id, tracked.work_item.work_id);
  assert.equal(created.messages[0].reply_to, tracked.message.message_id);
  assert.equal(store.getExecutiveWorkItem(tracked.work_item.work_id).lifecycle_state, 'answered');
  store.close();
});

test('owner coverage can be applied before provider execution', async () => {
  const { root, store } = db();
  const tracked = executive.ownerRequest(store, {
    body: 'Please acknowledge this direction before model execution.',
  });
  const created = await runner.applyPendingOwnerRequestCoverage(store, { root });
  assert.equal(created.messages.length, 1);
  assert.equal(created.messages[0].work_id, tracked.work_item.work_id);
  assert.equal(store.getExecutiveWorkItem(tracked.work_item.work_id).answered_at !== null, true);
  store.close();
});

test('repeated failed runs do not duplicate owner acknowledgements', async () => {
  const { root, store } = db();
  const tracked = executive.ownerRequest(store, { body: 'Keep this request idempotent.' });
  const first = await runner.applyPendingOwnerRequestCoverage(store, { root });
  const second = await runner.applyPendingOwnerRequestCoverage(store, { root });
  assert.equal(first.messages.length, 1);
  assert.equal(second, null);
  assert.equal(store.listExecutiveMessages({ work_id: tracked.work_item.work_id }).length, 2);
  store.close();
});

test('sanitizes malformed and excluded provider items while preserving safe work', () => {
  const plan = {
    messages: [
      { actor: 'not-a-role', body: 'invalid' },
      { actor: 'ceo', body: 'safe message' },
      { actor: 'ceo', body: '3boobs.com must never be retained' },
    ],
    work_items: [
      { title: 'Safe evidence item', owner: 'ceo' },
      { title: '3boobs.com item', owner: 'ceo' },
    ],
  };
  const dropped = runner.sanitizePlan(plan);
  assert.equal(plan.messages.length, 1);
  assert.equal(plan.work_items.length, 1);
  assert.equal(dropped.length, 3);
  const parsed = runner.parseOutput(
    JSON.stringify({ messages: plan.messages, work_items: plan.work_items }),
    { sanitize: true }
  );
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.work_items.length, 1);
});

test('normalizes documented delivery-mode aliases without admitting unknown modes', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      change_requests: [
        {
          site: 'example.com',
          title: 'Safe direct task',
          body: 'Ship a small change',
          delivery_mode: 'direct',
        },
        {
          site: 'example.com',
          title: 'Report',
          body: 'Provide evidence',
          delivery_mode: 'report-only',
        },
        {
          site: 'example.com',
          title: 'Unknown',
          body: 'Do something',
          delivery_mode: 'implementation',
        },
      ],
    }),
    { sanitize: true }
  );
  assert.deepEqual(
    plan.change_requests.map(item => item.delivery_mode),
    ['direct', 'report_only']
  );
});

test('malformed evidence drops only its work item and merged overflows are bounded', () => {
  const plan = runner.emptyPlan();
  plan.work_items = [
    { title: 'Malformed evidence', owner: 'ceo', evidence: ['unsupported source string'] },
    {
      title: 'Valid evidence',
      owner: 'ceo',
      evidence: [{ type: 'source', note: 'Observed fact' }],
    },
  ];
  plan.messages = Array.from({ length: 23 }, (_, index) => ({
    actor: 'ceo',
    body: `Message ${index}`,
  }));
  const dropped = runner.sanitizePlan(plan);
  assert.equal(plan.work_items.length, 1);
  assert.equal(plan.work_items[0].title, 'Valid evidence');
  assert.equal(plan.messages.length, 20);
  assert.equal(dropped.length, 4);
  assert.doesNotThrow(() => runner.validatePlan(plan));
});

test('owner-request acknowledgements reserve message capacity after a full provider plan', async () => {
  const { root, store } = db();
  const tracked = executive.ownerRequest(store, {
    body: 'Please prioritize the next measurable fleet improvement.',
  });
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: Array.from({ length: 20 }, (_, index) => ({
        actor: 'ceo',
        body: `Unlinked status update ${index}`,
      })),
    })
  );
  const created = await runner.applyPlan(store, plan, { root });
  assert.equal(plan.messages.length, 20);
  assert.equal(created.messages.length, 20);
  assert.ok(created.messages.some(message => message.work_id === tracked.work_item.work_id));
  assert.equal(store.getExecutiveWorkItem(tracked.work_item.work_id).lifecycle_state, 'answered');
  store.close();
});

test('linked full provider plans defer overflow owner acknowledgements without failing execution', async () => {
  const { root, store } = db();
  const tracked = executive.ownerRequest(store, {
    body: 'Please acknowledge this direction after the linked handoffs.',
  });
  const linked = Array.from({ length: 20 }, (_, index) =>
    store.createExecutiveWorkItem({
      work_id: `existing-work-${index}`,
      title: `Existing linked work ${index}`,
      owner: 'ceo',
      status: 'open',
    })
  );
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: linked.map((item, index) => ({
        actor: 'ceo',
        body: `Linked handoff ${index}`,
        work_id: item.work_id,
        message_type: 'handoff',
      })),
    })
  );
  const created = await runner.applyPlan(store, plan, { root });
  assert.equal(created.messages.length, 20);
  assert.equal(store.getExecutiveWorkItem(tracked.work_item.work_id).lifecycle_state, 'submitted');
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

test('drops malformed optional proposal reviews and normalizes queue priority casing', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      proposal_reviews: [
        { reviewed_by: 'reviewer', status: 'declined' },
        { proposal_id: 'cro-2', reviewed_by: 'domain_manager', status: 'approved' },
      ],
      messages: [{ actor: 'ceo', body: 'Recommendation: keep the bounded update.' }],
      change_requests: [
        {
          site: 'example.com',
          title: 'Bounded update',
          body: 'Apply the reversible update and report the result.',
          category: 'content',
          priority: 'Medium',
        },
      ],
    })
  );
  assert.deepEqual(
    plan.proposal_reviews.map(item => item.proposal_id),
    ['cro-2']
  );
  assert.equal(plan.proposal_reviews[0].reviewed_by, 'domain-manager');
  assert.equal(plan.change_requests[0].priority, 'medium');
  runner.validatePlan(plan);
});

test('maps work-item normal priority to the change queue medium priority', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [{ actor: 'ceo', body: 'Recommendation: make the bounded update.' }],
      change_requests: [
        {
          site: 'example.com',
          title: 'Bounded update',
          body: 'Apply the reversible update and report the result.',
          category: 'content',
          priority: 'normal',
        },
      ],
    })
  );
  assert.equal(plan.change_requests[0].priority, 'medium');
  runner.validatePlan(plan);
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

test('normalizes natural-language change-request aliases before validation', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      change_requests: [
        {
          domain: 'example.com',
          name: 'Refresh organic title',
          summary: 'Update the title and measure search impressions.',
          type: 'seo',
          priority: 'low',
        },
      ],
    })
  );
  assert.equal(plan.change_requests[0].site, 'example.com');
  assert.equal(plan.change_requests[0].title, 'Refresh organic title');
  assert.equal(plan.change_requests[0].body, 'Update the title and measure search impressions.');
  assert.equal(plan.change_requests[0].category, 'seo');
});

test('normalizes growth and affiliate change-request categories before queue application', () => {
  assert.equal(
    runner.normalizeDirectChangeRequest({ category: 'affiliate' }).category,
    'marketing'
  );
  assert.equal(runner.normalizeDirectChangeRequest({ category: 'growth' }).category, 'marketing');
  assert.equal(runner.normalizeDirectChangeRequest({ category: 'ux' }).category, 'design');
  assert.equal(runner.normalizeDirectChangeRequest({ category: 'unsupported' }).category, 'other');
});

test('preserves direct work as a durable owner gap when a site has no installed roles', () => {
  assert.equal(runner.installedSiteRoles('/tmp/does-not-exist', 'gate03.com').length, 0);
});

test('defaults blank provider message types to update', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [
        {
          actor: 'growth-director',
          message_type: '   ',
          body: 'Recommendation: keep the bounded growth test.',
        },
      ],
    })
  );
  assert.equal(plan.messages[0].message_type, 'update');
  runner.validatePlan(plan);
});

test('accepts messages from the delivery, design, growth, revenue, and site-factory roles', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [
        { actor: 'delivery-lead', body: 'Delivery update.' },
        { actor: 'design-director', body: 'Design update.' },
        { actor: 'growth-director', body: 'Growth update.' },
        { actor: 'revenue-ops', body: 'Revenue update.' },
        { actor: 'site-factory', body: 'Factory update.' },
      ],
    })
  );
  assert.deepEqual(
    plan.messages.map(message => message.actor),
    ['delivery-lead', 'design-director', 'growth-director', 'revenue-ops', 'site-factory']
  );
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

test('normalizes role-specific escalation and disposition messages', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [
        {
          actor: 'delivery-lead',
          message_type: 'escalation',
          body: 'Blocked on a dated owner action.',
        },
        { actor: 'ceo', message_type: 'risk_disposition', body: 'Risk disposition recorded.' },
        { actor: 'cfo', message_type: 'finance_review', body: 'Finance review recorded.' },
        {
          actor: 'security',
          message_type: 'security_disposition',
          body: 'Security disposition recorded.',
        },
      ],
    })
  );
  assert.deepEqual(
    plan.messages.map(message => message.message_type),
    ['update', 'update', 'update', 'update']
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

test('preserves every scheduler-supported work-item owner through normalization', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      work_items: [
        { title: 'Fleet tooling follow-up', owner: 'product-manager-fleet' },
        { title: 'Site product follow-up', owner: 'product-manager-sites' },
        { title: 'Queue follow-up', owner: 'project-manager' },
      ],
    }),
    { defaultActor: 'ceo' }
  );
  assert.deepEqual(
    plan.work_items.map(item => item.owner),
    ['product-manager-fleet', 'product-manager-sites', 'project-manager']
  );
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

test('stale source work ids do not abort otherwise valid queued work', async () => {
  const { root, store } = db();
  const created = await runner.applyPlan(
    store,
    {
      messages: [],
      proposal_reviews: [],
      data_requests: [],
      proposals: [],
      research_requests: [],
      work_items: [],
      knowledge: [],
      change_requests: [
        {
          site: 'example.com',
          title: 'Unsafe urgent request',
          body: 'This must remain out of the normal queue.',
          category: 'engineering',
          priority: 'urgent',
          delivery_mode: 'report_only',
        },
        {
          site: 'example.com',
          source_work_id: 'missing-work-item-from-an-old-run',
          title: 'Repair one measurable SEO path',
          body: 'Update the bounded SEO target and verify the build.',
          category: 'seo',
          priority: 'low',
          assigned_role: 'engineer',
          provider: 'local',
          delivery_mode: 'report_only',
        },
      ],
    },
    { allowQueue: true, root }
  );
  assert.equal(created.change_requests.length, 1);
  assert.match(created.plan_sanitization[0].reason, /high-priority/);
  assert.equal(store.listChangeRequests({ site: 'example.com' }).length, 1);
  store.close();
});

test('end-to-end owner request handoff creates a linked request and threaded acknowledgement', async () => {
  const { root, store } = db();
  const ownerRequest = executive.ownerRequest(store, {
    actor: 'owner',
    body: 'Add our Bluesky profile links to the sites and surface them clearly.',
  });
  const created = await runner.applyPlan(
    store,
    {
      messages: [],
      proposal_reviews: [],
      data_requests: [],
      proposals: [],
      research_requests: [],
      work_items: [],
      knowledge: [],
      change_requests: [
        {
          site: 'example.com',
          source_work_id: ownerRequest.work_item.work_id,
          title: 'Add social profile links',
          body: 'Add the approved social profile links to the site footer and verify the rendered links.',
          category: 'marketing',
          priority: 'low',
          assigned_role: 'engineer',
          provider: 'local',
          delivery_mode: 'direct',
          max_turns: 1,
          auto_review: true,
        },
      ],
    },
    { allowQueue: true, root }
  );
  assert.equal(created.change_requests.length, 1);
  const request = created.change_requests[0];
  const messages = store.listExecutiveMessages({ work_id: ownerRequest.work_item.work_id });
  const acknowledgement = messages.find(
    message => message.metadata?.downstream_id === request.request_id
  );
  assert.ok(acknowledgement);
  assert.match(acknowledgement.body, /queued agents/);
  assert.equal(acknowledgement.reply_to, ownerRequest.message.message_id);
  const updated = store.getExecutiveWorkItem(ownerRequest.work_item.work_id);
  assert.equal(updated.lifecycle_state, 'actioned');
  assert.equal(updated.waiting_on, 'worker');
  assert.ok(
    store
      .listWorkflowLinks({ from_type: 'work-item', from_id: ownerRequest.work_item.work_id })
      .some(link => link.to_type === 'request' && link.to_id === request.request_id)
  );
  const notification = store
    .listExecutiveNotifications({ unread: true })
    .find(item => item.message_id === acknowledgement.message_id);
  assert.ok(notification);
  store.close();
});

test('routes approved implementation and creates durable follow-through for unfinished proposals', async () => {
  const { root, store } = db();
  const ready = store.createExecutiveProposal({
    created_by: 'ceo',
    title: 'Ship the approved bounded change',
    proposal_type: 'growth',
    summary: 'A reversible implementation with a measurable outcome.',
    requested_action: 'Approve the implementation.',
    implementation: {
      site: 'example.com',
      title: 'Ship the approved bounded change',
      body: 'Update the page and record the before/after metric.',
      category: 'seo',
      priority: 'low',
      delivery_mode: 'direct',
    },
  });
  store.decideExecutiveProposal(ready.proposal_id, { status: 'approved', decided_by: 'owner' });
  const underspecified = store.createExecutiveProposal({
    created_by: 'cto',
    title: 'Define the next technical improvement',
    proposal_type: 'engineering',
    summary: 'This approved proposal still needs an executable task.',
    requested_action: 'Turn the decision into bounded implementation work.',
  });
  store.decideExecutiveProposal(underspecified.proposal_id, {
    status: 'approved',
    decided_by: 'owner',
  });

  const result = await runner.applyPlan(
    store,
    {
      messages: [],
      proposal_reviews: [],
      data_requests: [],
      proposals: [],
      change_requests: [],
      research_requests: [],
      work_items: [],
      knowledge: [],
    },
    { allowQueue: true, root }
  );
  assert.equal(result.follow_through.filter(row => row.type === 'queued').length, 1);
  assert.equal(store.listChangeRequests({ source_proposal_id: ready.proposal_id }).length, 1);
  assert.ok(store.getExecutiveProposal(ready.proposal_id).linked_request_id);
  const followUp = store.getExecutiveWorkItem(`approved-proposal:${underspecified.proposal_id}`);
  assert.equal(followUp.status, 'open');
  assert.match(followUp.next_action, /implementation/);

  const second = await runner.applyPlan(
    store,
    {
      messages: [],
      proposal_reviews: [],
      data_requests: [],
      proposals: [],
      change_requests: [],
      research_requests: [],
      work_items: [],
      knowledge: [],
    },
    { allowQueue: true, root }
  );
  assert.equal(second.follow_through.length, 0);
  store.close();
});

test('keeps an approved report-only proposal in the quiet workbench by default', async () => {
  const { root, store } = db();
  const proposal = store.createExecutiveProposal({
    created_by: 'ceo',
    title: 'Assess example.com search readiness',
    proposal_type: 'report-only',
    summary: 'Review example.com search coverage, content gaps, and measurable next steps.',
    requested_action:
      'Approve a report-only assessment. Do not deploy, change production, or modify credentials.',
  });
  store.decideExecutiveProposal(proposal.proposal_id, { status: 'approved', decided_by: 'owner' });

  const result = await runner.applyPlan(
    store,
    {
      messages: [],
      proposal_reviews: [],
      data_requests: [],
      proposals: [],
      change_requests: [],
      research_requests: [],
      work_items: [],
      knowledge: [],
    },
    { allowQueue: true, root }
  );
  assert.equal(result.follow_through.filter(row => row.type === 'queued').length, 0);
  assert.equal(store.listChangeRequests({ source_proposal_id: proposal.proposal_id }).length, 0);
  const followUp = store.getExecutiveWorkItem(`executive-proposal:${proposal.proposal_id}`);
  assert.equal(followUp.status, 'waiting');
  assert.match(followUp.next_action, /No model run scheduled/);
  store.close();
});

test('does not route approved SEO evidence to a worker even when an engineer is installed', async () => {
  const { root, store } = db();
  fs.mkdirSync(path.join(root, 'sites', 'example.com', 'ops', 'roles'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'sites', 'example.com', 'ops', 'roles', 'engineer.md'),
    '# engineer\n'
  );
  const proposal = store.createExecutiveProposal({
    created_by: 'ceo',
    title: 'Assess example.com SEO coverage',
    proposal_type: 'report-only',
    summary: 'Review example.com search coverage and measurable next steps.',
    requested_action: 'Approve a read-only assessment. Do not deploy or change production.',
  });
  store.decideExecutiveProposal(proposal.proposal_id, { status: 'approved', decided_by: 'owner' });

  runner.drainApprovedProposalQueue(store, { root, maxQueue: 1 });
  assert.equal(store.listChangeRequests({ source_proposal_id: proposal.proposal_id }).length, 0);
  store.close();
});

test('deterministic approved-work drain does not spend a model turn on report-only work', () => {
  const { root, store } = db();
  const proposal = store.createExecutiveProposal({
    created_by: 'ceo',
    title: 'Assess example.com monetization readiness',
    proposal_type: 'report-only',
    summary: 'Review example.com monetization paths and measurement gaps.',
    requested_action:
      'Approve a bounded report-only assessment. Do not deploy, spend money, or change production.',
  });
  store.decideExecutiveProposal(proposal.proposal_id, { status: 'approved', decided_by: 'owner' });

  const drained = runner.drainApprovedProposalQueue(store, { root, maxQueue: 1 });
  assert.equal(drained.filter(row => row.type === 'queued').length, 0);
  assert.equal(store.listChangeRequests({ source_proposal_id: proposal.proposal_id }).length, 0);
  store.close();
});

test('approved report-only work stays quiet while a deployed improvement is measuring', () => {
  const { root, store } = db();
  store.createImprovement({
    site: 'example.com',
    source: 'fleet-dashboard',
    title: 'Already deployed improvement',
    state: 'measuring',
    outcome: { deployment_verified_at: new Date().toISOString() },
  });
  const proposal = store.createExecutiveProposal({
    created_by: 'ceo',
    title: 'Assess example.com measurement readiness',
    proposal_type: 'report-only',
    summary: 'Review the current measurement evidence and identify any gaps.',
    requested_action:
      'Approve a bounded report-only assessment. Do not deploy, spend money, or change production.',
  });
  store.decideExecutiveProposal(proposal.proposal_id, { status: 'approved', decided_by: 'owner' });

  const drained = runner.drainApprovedProposalQueue(store, { root, maxQueue: 1 });
  assert.equal(drained.filter(row => row.type === 'queued').length, 0);
  assert.equal(store.listChangeRequests({ source_proposal_id: proposal.proposal_id }).length, 0);
  store.close();
});

test('caps new proposals while approved execution backlog is high', async () => {
  const { root, store } = db();
  for (let index = 0; index < 10; index += 1) {
    const proposal = store.createExecutiveProposal({
      created_by: 'ceo',
      title: `Approved backlog item ${index}`,
      proposal_type: 'report-only',
      summary: 'An approved site-specific report remains to be executed.',
      requested_action: 'Approve a read-only report for example.com.',
    });
    store.decideExecutiveProposal(proposal.proposal_id, {
      status: 'approved',
      decided_by: 'owner',
    });
  }
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [],
      proposals: [
        {
          created_by: 'ceo',
          title: 'New idea one',
          proposal_type: 'business',
          summary: 'one',
          requested_action: 'Review one.',
        },
        {
          created_by: 'ceo',
          title: 'New idea two',
          proposal_type: 'business',
          summary: 'two',
          requested_action: 'Review two.',
        },
        {
          created_by: 'ceo',
          title: 'New idea three',
          proposal_type: 'business',
          summary: 'three',
          requested_action: 'Review three.',
        },
      ],
      change_requests: [],
    })
  );
  const created = await runner.applyPlan(store, plan, { root });
  assert.equal(created.proposals.length, 2);
  assert.equal(created.skipped_proposals.length, 1);
  assert.match(created.skipped_proposals[0].reason, /backlog/);
  store.close();
});

test('failed approved execution becomes a blocked follow-through case instead of a blind retry', async () => {
  const { root, store } = db();
  const proposal = store.createExecutiveProposal({
    created_by: 'cto',
    title: 'Repair the failed technical change',
    proposal_type: 'engineering',
    summary: 'Investigate the failed implementation and prepare a bounded replacement.',
    requested_action: 'Approve the repair investigation.',
    implementation: {
      site: 'example.com',
      title: 'Repair the failed technical change',
      body: 'Inspect the failure, add a regression test, and document rollback.',
      category: 'engineering',
      priority: 'medium',
    },
  });
  store.decideExecutiveProposal(proposal.proposal_id, { status: 'approved', decided_by: 'owner' });
  store.createChangeRequest({
    site: 'example.com',
    title: proposal.implementation.title,
    body: proposal.implementation.body,
    category: 'engineering',
    priority: 'medium',
    source_proposal_id: proposal.proposal_id,
    status: 'failed',
  });
  const result = await runner.applyPlan(
    store,
    {
      messages: [],
      proposal_reviews: [],
      data_requests: [],
      proposals: [],
      change_requests: [],
      research_requests: [],
      work_items: [],
      knowledge: [],
    },
    { allowQueue: true, root }
  );
  assert.equal(
    result.follow_through.some(row => row.type === 'queued'),
    false
  );
  assert.equal(store.listChangeRequests({ source_proposal_id: proposal.proposal_id }).length, 1);
  assert.equal(
    store.getExecutiveWorkItem(`approved-proposal:${proposal.proposal_id}`).status,
    'blocked'
  );
  assert.match(
    store.getExecutiveWorkItem(`approved-proposal:${proposal.proposal_id}`).next_action,
    /automatic retry is disabled/
  );
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
  for (const site of ['other.example', 'third.example', 'fourth.example']) {
    fs.mkdirSync(path.join(root, 'sites', site), { recursive: true });
    fs.mkdirSync(path.join(root, 'sites', site, 'ops', 'roles'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sites', site, 'ops', 'roles', 'engineer.md'), '# Engineer\n');
  }
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
  const second = await runner.applyPlan(
    store,
    { ...plan, proposals: [{ ...plan.proposals[0], title: 'Finance review follow-up' }] },
    { root }
  );
  assert.notEqual(first.proposals[0].proposal_id, 'provider-reused-slug');
  assert.notEqual(first.proposals[0].proposal_id, second.proposals[0].proposal_id);
  store.close();
});

test('does not create another open proposal for the same executive decision', async () => {
  const { root, store } = db();
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [],
      proposals: [
        {
          created_by: 'ceo',
          title: 'Run a bounded revenue test',
          proposal_type: 'growth',
          summary: 'Use the strongest current evidence.',
          requested_action: 'Queue the reversible test.',
          implementation: {
            site: 'example.com',
            action_key: 'growth:test',
            title: 'Run a bounded revenue test',
            body: 'Run the reversible test and record the result.',
          },
        },
      ],
      change_requests: [],
      research_requests: [],
    })
  );
  const first = await runner.applyPlan(store, plan, { root });
  const second = await runner.applyPlan(store, plan, { root });
  assert.equal(first.proposals.length, 1);
  assert.equal(second.proposals.length, 0);
  assert.equal(second.skipped_proposals.length, 1);
  assert.equal(store.listExecutiveProposals({ limit: 100 }).length, 1);
  store.close();
});

test('routes routine security posture updates to one durable workbench item', async () => {
  const { root, store } = db();
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [],
      proposals: [
        {
          created_by: 'security',
          title: 'Security evidence remains incomplete',
          proposal_type: 'report-only',
          summary: 'Keep public exposure gated while the evidence matrix is completed.',
          requested_action: 'Continue the private posture and report the next evidence check.',
        },
      ],
      change_requests: [],
      research_requests: [],
    })
  );
  const first = await runner.applyPlan(store, plan, { root });
  const second = await runner.applyPlan(store, plan, { root });
  assert.equal(first.proposals.length, 0);
  assert.equal(first.work_items.length, 1);
  assert.equal(second.work_items.length, 1);
  assert.equal(
    store
      .listExecutiveWorkItems({ limit: 100 })
      .filter(item => item.source_type === 'executive-routine').length,
    1
  );
  assert.equal(store.listExecutiveProposals({ limit: 100 }).length, 0);
  store.close();
});

test('accepts researcher proposals as CRO evidence handoffs', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [],
      proposals: [
        {
          created_by: 'researcher',
          title: 'Purpose-fit repository review',
          proposal_type: 'report-only',
          summary: 'A CRO lab lead for CEO and CTO review.',
          requested_action: 'Review the evidence before any adoption decision.',
        },
      ],
      change_requests: [],
      research_requests: [],
    })
  );
  assert.equal(plan.proposals[0].created_by, 'researcher');
});

test('rejects non-JSON provider output', () => {
  assert.throws(() => runner.parseOutput('not json'), /valid JSON/);
});

test('accepts provider JSON wrapped in commentary and repairs raw string controls', () => {
  const plan = runner.parseOutput(
    `Here is the plan:\n{"messages":[{"actor":"ceo","body":"Recommendation: inspect the evidence\nthen measure it."}],"proposals":[],"change_requests":[],"research_requests":[]}`
  );
  assert.equal(plan.messages[0].actor, 'ceo');
  assert.match(plan.messages[0].body, /inspect the evidence\nthen measure it/);
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

test('scopes domain-manager proposals to the active managed site', () => {
  const plan = runner.parseOutput(
    JSON.stringify({
      messages: [],
      proposals: [
        {
          created_by: 'domain-manager',
          proposal_type: 'report-only',
          title: 'Site evidence review',
          summary: 'Review the site evidence.',
          requested_action: 'Return a bounded report.',
        },
      ],
      change_requests: [],
      research_requests: [],
    }),
    { defaultActor: 'domain-manager', defaultSite: 'example.com' }
  );
  assert.equal(plan.proposals[0].implementation.site, 'example.com');
});

test('data-quality work drains into idempotent report-only requests', () => {
  const { root, store } = db();
  store.createExecutiveWorkItem({
    work_id: 'data-quality:analytics:example.com',
    title: 'Restore analytics coverage for example.com',
    kind: 'evidence',
    status: 'open',
    priority: 'normal',
    owner: 'cto',
    source_type: 'data-quality',
    source_id: 'analytics:example.com',
    site: 'example.com',
    summary: 'No successful source was observed.',
    next_action: 'Verify the registry and latest fetch result.',
    created_by: 'system',
  });
  const first = runner.drainDataQualityWork(store, { root, maxQueue: 1 });
  assert.equal(first.filter(row => row.type === 'queued-data-quality').length, 1);
  const request = store.listChangeRequests({ limit: 10 })[0];
  assert.equal(request.delivery_mode, 'report_only');
  assert.equal(request.action_key, 'data-quality:data-quality:analytics:example.com');
  assert.equal(runner.drainDataQualityWork(store, { root, maxQueue: 1 }).length, 0);
  store.close();
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
    false
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

test('owner-request coverage does not reintroduce an excluded site', () => {
  const plan = { messages: [] };
  runner.ensureOwnerRequestCoverage(
    {
      listExecutiveWorkItems: () => [
        {
          work_id: 'excluded-owner-request',
          source_id: 'owner-message',
          source_type: 'owner-request',
          status: 'open',
          lifecycle_state: 'open',
          summary: 'Review 3boobs.com immediately',
        },
        {
          work_id: 'managed-owner-request',
          source_id: 'managed-message',
          source_type: 'owner-request',
          status: 'open',
          lifecycle_state: 'open',
          summary: 'Improve example.com conversion tracking',
        },
      ],
    },
    plan
  );
  assert.equal(plan.messages.length, 1);
  assert.equal(plan.messages[0].work_id, 'managed-owner-request');
  assert.doesNotMatch(JSON.stringify(plan), /3boobs(?:\.com)?/i);
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
