'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const eventstore = require('../fleet-dashboard/server/eventstore');
const executive = require('../fleet-dashboard/server/executive');
const changequeue = require('../fleet-dashboard/server/changequeue');
const handoff = require('./handoff');
const research = require('./research');
const croResearch = require('./cro');
const croLab = require('./cro-lab');
const executiveSnapshot = require('../fleet-dashboard/server/executive-snapshot');
const executiveData = require('../fleet-dashboard/server/executive-data');
const executiveScorecard = require('../fleet-dashboard/server/executive-scorecard');
const launchReadiness = require('./launch-readiness');
const crypto = require('node:crypto');

const ROOT = process.env.FD_DOMAINS_ROOT || path.resolve(__dirname, '..', '..');

function discoverSites(root = ROOT) {
  const dir = path.join(root, 'sites');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(x => x.isDirectory())
      .map(x => x.name)
      .sort();
  } catch {
    return [];
  }
}

const EXECUTIVE_EXCLUDED_SITES = new Set(['3boobs.com']);
const FLEET_ACTION_KEY = 'publish-fleet-operating-baseline';
const PROPOSAL_TYPES = new Set(executive.PROPOSAL_TYPES);
const PROPOSAL_TYPE_ALIASES = new Map([
  ['analysis', 'report-only'],
  ['analytics', 'report-only'],
  ['audit', 'report-only'],
  ['content', 'growth'],
  ['conversion', 'growth'],
  ['marketing', 'growth'],
  ['monetization', 'growth'],
  ['revenue', 'growth'],
  ['seo', 'growth'],
  ['technical', 'engineering'],
  ['tech', 'engineering'],
  ['research', 'report-only'],
  ['strategy', 'business'],
]);

function executiveSites(root = ROOT) {
  return discoverSites(root).filter(site => !EXECUTIVE_EXCLUDED_SITES.has(site));
}

function executiveTarget(root, site) {
  return site === 'fleet' || executiveSites(root).includes(site);
}

function installedSiteRoles(root, site) {
  if (!site || site === 'fleet') return [];
  try {
    return fs
      .readdirSync(path.join(root, 'sites', site, 'ops', 'roles'))
      .filter(file => file.endsWith('.md'))
      .map(file => file.slice(0, -3));
  } catch {
    return [];
  }
}

function reportOnlyRole(category, site, root) {
  // A read-only SEO assessment is evidence work, not an SEO publishing or
  // link-building action. If a legacy site has no SEO analyst installed,
  // let its installed engineer produce the report instead of failing a safe
  // approved request. Keep the canonical specialist when it exists.
  if (category !== 'seo') return 'engineer';
  const roles = installedSiteRoles(root, site);
  if (roles.includes('seo-analyst')) return 'seo-analyst';
  if (roles.includes('engineer')) return 'engineer';
  if (roles.includes('principal-engineer')) return 'principal-engineer';
  return 'seo-analyst';
}

function normalizeActionTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[“”‘’]/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function completedActionIndex(store) {
  const keys = new Set();
  const titles = new Set();
  const failed = new Map();
  if (!store) return { keys, titles };
  for (const request of store.listChangeRequests({ limit: 1000 })) {
    if (String(request.status) === 'failed') {
      const site = String(request.site || '')
        .trim()
        .toLowerCase();
      const title = normalizeActionTitle(request.title);
      if (site && title) {
        const retryAt = Date.parse(request.next_attempt_at || '');
        const updatedAt = Date.parse(request.updated_at || request.created_at || '') || Date.now();
        failed.set(`${site}:${title}`, {
          until: Number.isFinite(retryAt) ? retryAt : updatedAt + 24 * 3600 * 1000,
          attempts: Number(request.attempts || 0),
        });
      }
      continue;
    }
    if (!['committed', 'deployed', 'verified'].includes(String(request.status))) continue;
    if (request.action_key) keys.add(String(request.action_key));
    const site = String(request.site || '')
      .trim()
      .toLowerCase();
    const title = normalizeActionTitle(request.title);
    if (site && title) titles.add(`${site}:${title}`);
  }
  for (const run of store.listImprovements({ limit: 1000 })) {
    if (!['reported', 'deployed', 'measuring', 'proven'].includes(String(run.state))) continue;
    const site = String(run.site || '')
      .trim()
      .toLowerCase();
    const title = normalizeActionTitle(run.title);
    if (site && title) titles.add(`${site}:${title}`);
  }
  return { keys, titles, failed };
}

function actionCandidates(intelligence, sites, completed = { keys: new Set(), titles: new Set() }) {
  const allowed = new Set(sites);
  const now = Date.parse(intelligence?.generated_at || '') || Date.now();
  const seoActions = Array.isArray(intelligence?.decision_support?.seo?.actions)
    ? intelligence.decision_support.seo.actions
        .filter(action => allowed.has(action.site) && action.filed !== true)
        .map(action => ({
          site: action.site,
          key: action.key || null,
          title: action.title || 'Evidence-backed SEO opportunity',
          type: action.type || 'seo',
          evidence: action.evidence || null,
          score: action.rankScore || action.score || 0,
          recommendation: action.recommendation || null,
          metric: action.metric || null,
        }))
    : [];
  const priorityItems = Array.isArray(intelligence?.decision_support?.priorities?.items)
    ? intelligence.decision_support.priorities.items
        .filter(item => allowed.has(item.site) && item.state !== 'resolved')
        .map(item => ({
          site: item.site,
          key: item.id || null,
          title: item.title || 'Evidence-backed portfolio action',
          type: item.kind || 'portfolio',
          evidence: item.evidence || null,
          score: item.score || 0,
          recommendation: item.recommendation || item.title || null,
          metric: item.metric || null,
        }))
    : [];

  // Keep the portfolio spread visible. The old planner sliced SEO findings
  // before considering the priorities feed, so one site could consume the
  // entire executive cycle while fleet-wide blockers remained hidden.
  const bySite = new Map();
  for (const candidate of [...seoActions, ...priorityItems]) {
    const key = candidate.key ? String(candidate.key) : '';
    const titleKey = `${String(candidate.site || '')
      .trim()
      .toLowerCase()}:${normalizeActionTitle(candidate.title)}`;
    if ((key && completed.keys.has(key)) || completed.titles.has(titleKey)) continue;
    const failed = completed.failed?.get(titleKey);
    if (failed && now < failed.until) continue;
    const current = bySite.get(candidate.site);
    if (!current || Number(candidate.score || 0) > Number(current.score || 0))
      bySite.set(candidate.site, candidate);
  }

  // When source-specific recommendations are sparse, rotate a small cohort of
  // live sites into the brief for a bounded baseline/revenue-readiness check.
  // This is evidence collection, not a claim that missing telemetry is zero.
  const scorecards = intelligence?.decision_support?.priorities?.scorecards || [];
  const rotation = Math.floor(Date.parse(intelligence?.generated_at || '') / (6 * 3600 * 1000));
  const ordered = scorecards
    .filter(row => allowed.has(row.site) && row.lifecycle === 'live')
    .sort((a, b) => String(a.site).localeCompare(String(b.site)));
  for (let offset = 0; offset < ordered.length && bySite.size < 12; offset++) {
    const row = ordered[(rotation + offset) % ordered.length];
    if (!row || bySite.has(row.site)) continue;
    bySite.set(row.site, {
      site: row.site,
      key: `site-baseline:${row.site}`,
      title: `Run bounded revenue-readiness baseline for ${row.site}`,
      type: 'portfolio-baseline',
      evidence: {
        lifecycle: row.lifecycle || null,
        opportunity_score: row.opportunity_score || 0,
        sessions: row.sessions ?? null,
        conversions: row.conversions ?? null,
        ai_cost_usd: row.ai_cost_usd ?? null,
      },
      score: row.opportunity_score || 0,
      recommendation:
        'Inspect the existing site report and route one reversible, measurable improvement or document the evidence-backed blocker.',
      metric: 'site-specific attributable outcome',
    });
  }
  return [...bySite.values()]
    .sort(
      (a, b) =>
        Number(b.score || 0) - Number(a.score || 0) || String(a.site).localeCompare(String(b.site))
    )
    .slice(0, 12);
}

function readSiteDescriptions(root = ROOT) {
  const descriptions = {};
  const file = path.join(root, 'DOMAINS_INDEX.md');
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\|\s*([^|]+?)\s*\|[^|]*\|\s*([^|]+?)\s*\|\s*$/);
      if (match) descriptions[match[1].trim()] = match[2].trim();
    }
  } catch {
    /* the registry remains the source of truth when prose is absent */
  }
  return descriptions;
}

function buildSiteContext(root = ROOT) {
  const descriptions = readSiteDescriptions(root);
  const allowed = new Set(executiveSites(root));
  return executiveSites(root).map(domain => {
    return {
      domain,
      lifecycle: 'discovered',
      description: descriptions[domain] || null,
      portfolio_class: 'satire_or_meme',
      executive_scope: allowed.has(domain) ? 'managed' : 'excluded',
    };
  });
}

function buildPortfolioInventory(root = ROOT) {
  // Host-only imports: the isolated model image receives the generated brief
  // and must not need registry parsers or their host dependency tree.
  const fleetregistry = require('../fleet-dashboard/server/fleetregistry');
  const scaffolds = require('../fleet-dashboard/server/scaffolds');
  const registry = fleetregistry.read(root);
  const parked = scaffolds.all(root).rows || [];
  const parkedByDomain = new Map(parked.map(row => [row.domain, row]));
  return registry.sites
    .filter(row => !EXECUTIVE_EXCLUDED_SITES.has(row.domain))
    .map(row => {
      const parkedRow = parkedByDomain.get(row.domain);
      return {
        domain: row.domain,
        lifecycle: row.lifecycle,
        repo: row.repo,
        worker: row.worker,
        capabilities: row.capabilities,
        registered_in: row.registered_in,
        parked: row.lifecycle === 'scaffold',
        parked_days: parkedRow?.days_parked ?? null,
        registrar_expires: parkedRow?.registrar_expires ?? null,
        days_to_renewal: parkedRow?.days_to_renewal ?? null,
        auto_renew: parkedRow?.auto_renew ?? null,
        notes: parkedRow?.notes ?? null,
      };
    });
}

function buildDomainManagerContext(root = ROOT) {
  const focus = String(process.env.EXECUTIVE_DOMAIN || '')
    .trim()
    .toLowerCase();
  if (!focus) return null;
  if (!executiveSites(root).includes(focus))
    throw new Error('EXECUTIVE_DOMAIN is not a managed site');
  return {
    site: focus,
    role: 'domain-manager',
    instruction:
      'Focus deeply on this managed site while preserving fleet-wide policy. Return site-specific observations and proposals to fleet leadership; do not act outside this site.',
  };
}

async function collectIntel(root, sites) {
  // Host-only import: the isolated model image loads runner.js for prompt and
  // plan validation, but it must not need dashboard telemetry modules.
  const executiveIntel = require('../fleet-dashboard/server/executive-intel');
  const cached =
    executiveSnapshot.readLatest(root, { sites }) ||
    executiveSnapshot.readLatest(root, { sites, allowStale: true });
  const intelligence = cached ? cached.intelligence : await executiveIntel.collect({ root, sites });
  const support = intelligence.decision_support || {};
  const health = support.analytics || {};
  const seo = support.seo || {};
  const usage = support.ai_usage || {};
  const revenue = support.revenue || {};
  const healthSites = health.sites || {};
  return {
    generated_at: new Date().toISOString(),
    analytics: {
      ok: health.ok !== false,
      configured_sites: Object.keys(healthSites).length,
      sites: Object.fromEntries(
        sites.map(site => [site, healthSites[site] || { configured: false }])
      ),
    },
    revenue,
    seo: {
      ok: seo.ok !== false,
      summary: seo.summary || seo.totals || null,
      sources: seo.sources || null,
    },
    ai_usage: {
      generated_at: usage.generated_at || null,
      summary: usage.summary || usage.totals || null,
      by_site: Array.isArray(usage.by_site) ? usage.by_site.slice(0, 100) : [],
      error: usage.error || null,
    },
    research: research.recent(root),
    intelligence,
    intelligence_snapshot: cached
      ? {
          generated_at: cached.generated_at,
          source: 'scheduled-cache',
          stale: cached.freshness?.stale === true,
          age_ms: cached.freshness?.age_ms || null,
        }
      : { generated_at: intelligence.generated_at || null, source: 'live-collection' },
  };
}

async function buildBrief(store, root = ROOT) {
  const queued = store.listChangeRequests({ limit: 50 });
  const improvements = store.listImprovements({ limit: 50 });
  // The model only receives a compact slice below, but the deterministic
  // execution metric must reconcile the whole bounded proposal history. A
  // 100-row sample made approved work disappear from the CEO's backlog.
  const allProposals = store.listExecutiveProposals({ limit: 1000 });
  const proposals = allProposals.slice(0, 10);
  const allRequests = store.listChangeRequests({ limit: 1000 });
  const proposalExecution = executiveScorecard.proposalExecutionSummary(allProposals, allRequests);
  const croProposals = allProposals
    .filter(item => ['researcher', 'cro'].includes(item.created_by))
    .filter(item => ['proposed', 'feedback'].includes(item.status))
    .slice(0, 10);
  const messages = store.listExecutiveMessages({ limit: 10 });
  const work_items = store.listExecutiveWorkItems({ limit: 100 });
  const knowledgeCatalog = store.listExecutiveKnowledge({ limit: 1000 });
  const knowledge = knowledgeCatalog
    .filter(item => ['queued', 'in_progress'].includes(item.status))
    .slice(0, 40)
    .map(
      ({
        knowledge_id,
        title,
        resource_type,
        audience,
        status,
        url,
        publisher,
        jurisdiction,
        license,
        summary,
        tags,
        source_work_id,
        takeaway,
        applied_to,
        reviewed_by,
        reviewed_at,
      }) => ({
        knowledge_id,
        title,
        resource_type,
        audience,
        status,
        url,
        publisher,
        jurisdiction,
        license,
        summary,
        tags,
        source_work_id,
        takeaway,
        applied_to,
        reviewed_by,
        reviewed_at,
      })
    );
  const task_queue = {
    engineer: store.listChangeRequests({ assigned_role: 'engineer', limit: 50 }),
    principal_engineer: store.listChangeRequests({
      assigned_role: 'principal-engineer',
      limit: 50,
    }),
  };
  const sites = executiveSites(root);
  const intel = await collectIntel(root, sites);
  const actionability = executiveScorecard.buildScorecard(store);
  const allActionCandidates = actionCandidates(
    intel.intelligence,
    sites,
    completedActionIndex(store)
  );
  // A candidate is only actionable when its site has capacity. The previous
  // brief exposed already-queued or measuring sites as fresh candidates, then
  // required the model to cover them again. That created needless mandate
  // repair calls and made a correctly conservative cycle look like a failure.
  const activeSites = new Set(
    store
      .listChangeRequests({ limit: 1000 })
      .filter(row =>
        ['queued', 'claimed', 'running', 'reviewing', 'review', 'committed'].includes(row.status)
      )
      .map(row => String(row.site || '').toLowerCase())
      .filter(Boolean)
  );
  for (const run of store.listImprovements({ limit: 1000 })) {
    if (['proposed', 'building', 'review', 'deployed', 'measuring'].includes(run.state))
      activeSites.add(String(run.site || '').toLowerCase());
  }
  const executableActionCandidates = allActionCandidates.filter(
    candidate => !activeSites.has(String(candidate.site || '').toLowerCase())
  );
  const deferredActionCandidates = allActionCandidates
    .filter(candidate => activeSites.has(String(candidate.site || '').toLowerCase()))
    .slice(0, 12)
    .map(candidate => ({
      ...candidate,
      deferred_reason: 'site already has queued, active, deployed, or measuring work',
    }));
  return {
    generated_at: new Date().toISOString(),
    sites,
    site_context: buildSiteContext(root),
    portfolio_inventory: buildPortfolioInventory(root),
    portfolio_policy: {
      managed_sites: 'all discovered fleet sites except 3boobs.com',
      excluded_sites: ['3boobs.com'],
      classification:
        'All managed properties are satire/meme sites for executive planning. Do not infer adult or NSFW status from a domain name.',
    },
    tool_contract: {
      available: [
        'read_only_executive_intelligence_snapshot',
        'read_only_fleet_registry',
        'read_only_full_portfolio_and_parked_domain_inventory',
        'read_only_analytics_health_and_traffic',
        'read_only_seo_web_vitals_and_link_health',
        'read_only_revenue_and_affiliate_attribution',
        'revops_lead_lifecycle_scoring_and_pipeline_summary',
        'revops_utm_campaign_and_affiliate_attribution',
        'experiment_hypotheses_variants_exposures_and_outcomes',
        'read_only_ai_usage_and_costs',
        'read_only_social_account_coverage',
        'read_only_datahub_source_and_dataset_health',
        'read_only_operations_deploy_uptime_errors_and_fleet_doctor',
        'read_only_compliance_baseline_and_scan_history',
        'read_only_data_quality_and_attribution_boundaries',
        'read_only_security_baseline_and_fleet_doctor',
        'read_only_launch_readiness_and_data_use_checklists',
        'bounded_public_research',
        'cro_disposable_repo_lab',
        'allowlisted_fleet_operating_baseline_publish',
        'executive_workbench_case_management',
        'curated_knowledge_shelf_and_learning_queue',
      ],
      research_limits: {
        max_requests_per_tick: 10,
        max_response_bytes: 262144,
        timeout_ms: 8000,
        redirects: false,
      },
      cro_repo_lab: {
        purpose:
          'Clone public GitHub archives into a disposable evidence workspace and run bounded read-only checks.',
        max_candidates_per_run: 3,
        dependency_install: false,
        network_during_checks: 'none',
        project_mounts: [],
        secrets: false,
        docker_socket: false,
        adoption_gate:
          'A lab result is not an adoption approval. Prototype, security review, measurement plan, and owner-approved implementation remain required.',
      },
      execution:
        'Messages and proposals may be applied automatically; queued site work requires explicit queue enablement or owner approval. The only autonomous fleet write is the allowlisted operating-baseline report, which writes a factual audit artifact and never edits site code. Deployments, spending, credentials, domains, and destructive operations are never direct model actions.',
      delegation:
        'CEO, CFO, CTO, Legal/Compliance, Security, and independent reviewer passes run sequentially; domain managers review every managed site on a staggered queue and report back to fleet leadership. Approved implementation work enters the site task/change queue. Use engineer for normal work and principal-engineer for urgent senior technical work. Later passes may reduce, reject, or escalate the earlier plan.',
      telemetry_policy:
        'Read-only telemetry, compliance evidence, data-quality boundaries, and security evidence are collected automatically and are available in intelligence and the scheduled intelligence snapshot. Do not create a proposal merely to request data already present there. Create a proposal when a missing source requires an explicit implementation, credential, budget, or owner decision, or when a site cannot monetize until an owner resolves a launch/compliance/security question.',
    },
    owner_strategy: store.getExecutiveSettings(),
    actionability,
    proposal_execution: proposalExecution,
    action_mandate: {
      cadence: 'hourly',
      minimum_evidence_backed_action: 1,
      maximum_queued_actions: 6,
      rule: 'When an evidence-backed, low-risk and reversible candidate exists, the CEO/CTO pass must either queue it for the engineer or explain why it was rejected. Do not let low-volume affiliate attribution create a no-op.',
      candidates: executableActionCandidates,
      deferred_candidates: deferredActionCandidates,
    },
    intelligence: intel,
    launch_readiness: launchReadiness.read(root),
    specialist_inputs: {
      cro_github_trends: croResearch.recent(root),
      cro_repo_lab_runs: croLab.recent(root, 12),
      cro_contract:
        'CRO trend signals and repo-lab results are discovery evidence, not proof of quality, license fit, security, revenue, or conversion impact. CEO/CTO must validate before implementation.',
    },
    domain_manager: buildDomainManagerContext(root),
    queue: queued.map(
      ({
        request_id,
        site,
        title,
        category,
        priority,
        status,
        assigned_role,
        requested_by,
        source_proposal_id,
        delivery_mode,
      }) => ({
        request_id,
        site,
        title,
        category,
        priority,
        status,
        assigned_role,
        requested_by,
        source_proposal_id,
        delivery_mode,
      })
    ),
    improvements: improvements.map(({ run_id, site, title, state, measurement_due, outcome }) => ({
      run_id,
      site,
      title,
      state,
      measurement_due,
      outcome,
    })),
    proposals: proposals.map(
      ({ proposal_id, title, proposal_type, summary, status, requested_action }) => ({
        proposal_id,
        title,
        proposal_type,
        summary,
        status,
        requested_action,
      })
    ),
    cro_proposals: croProposals.map(
      ({
        proposal_id,
        title,
        proposal_type,
        summary,
        rationale,
        expected_upside,
        risks,
        requested_action,
        status,
        created_at,
      }) => ({
        proposal_id,
        title,
        proposal_type,
        summary,
        rationale,
        expected_upside,
        risks,
        requested_action,
        status,
        created_at,
      })
    ),
    task_queue,
    work_items,
    knowledge,
    knowledge_summary: {
      total: knowledgeCatalog.length,
      active: knowledgeCatalog.filter(item => ['queued', 'in_progress'].includes(item.status))
        .length,
      completed: knowledgeCatalog.filter(item => item.status === 'complete').length,
    },
    conversation: messages
      .slice()
      .reverse()
      .map(({ actor, body, created_at }) => ({ actor, body, created_at })),
    handoffs: handoff.recent(root, 30),
    data_requests: executiveData.recent(store),
  };
}

const MODEL_BRIEF_MAX_ARRAY_ITEMS = 12;
const MODEL_BRIEF_MAX_STRING_LENGTH = 900;

function compactModelValue(value, depth = 0) {
  if (typeof value === 'string') {
    if (value.length <= MODEL_BRIEF_MAX_STRING_LENGTH) return value;
    return `${value.slice(0, MODEL_BRIEF_MAX_STRING_LENGTH)}… [truncated for model context]`;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 7) {
    if (Array.isArray(value)) return [`[${value.length} items omitted at context boundary]`];
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([, item]) => item === null || ['string', 'number', 'boolean'].includes(typeof item)
        )
        .map(([key, item]) => [key, compactModelValue(item, depth + 1)])
    );
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MODEL_BRIEF_MAX_ARRAY_ITEMS)
      .map(item => compactModelValue(item, depth + 1));
    if (value.length > MODEL_BRIEF_MAX_ARRAY_ITEMS)
      items.push(
        `[${value.length - MODEL_BRIEF_MAX_ARRAY_ITEMS} additional items omitted; use the authoritative snapshot]`
      );
    return items;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, compactModelValue(item, depth + 1)])
  );
}

function compactQueueRow(row) {
  return {
    request_id: row.request_id,
    site: row.site,
    title: row.title,
    category: row.category,
    priority: row.priority,
    assigned_role: row.assigned_role,
    provider: row.provider,
    model: row.model,
    status: row.status,
    delivery_mode: row.delivery_mode,
    requested_by: row.requested_by,
    attempts: row.attempts,
    review_attempts: row.review_attempts,
    error: row.error ? String(row.error).slice(0, MODEL_BRIEF_MAX_STRING_LENGTH) : null,
    body: row.body ? String(row.body).slice(0, 700) : null,
  };
}

function compactRepoLabRun(run) {
  const checks = Array.isArray(run.checks) ? run.checks : [];
  return {
    schema: run.schema,
    run_id: run.run_id,
    generated_at: run.generated_at,
    candidate: run.candidate,
    status: run.status,
    repository: {
      file_count: run.repository?.file_count ?? null,
      license: run.repository?.license || null,
    },
    use_case: run.use_case,
    checks: {
      total: checks.length,
      passed: checks.filter(check => check.status === 'passed').length,
      failed: checks.filter(check => check.status === 'failed').length,
      failures: checks
        .filter(check => check.status !== 'passed')
        .slice(0, 3)
        .map(check => ({ command: check.command, status: check.status, output: check.output })),
    },
    safety: run.safety,
    recommendation: run.recommendation,
  };
}

function compactResearchRow(row) {
  return {
    request_id: row.request_id || row.research_id || row.id,
    url: row.url,
    question: row.question,
    status: row.status,
    title: row.title,
    summary: row.summary,
    answer: row.answer,
    error: row.error,
  };
}

function compactModelBrief(brief) {
  const compact = compactModelValue(brief);
  const inputs = brief?.specialist_inputs || {};
  compact.tool_contract = {
    ...compact.tool_contract,
    // This is a short allowlist, not historical evidence; preserve it whole so
    // the model cannot forget an available safety/measurement capability.
    available: brief?.tool_contract?.available || [],
  };
  compact.specialist_inputs = {
    ...compact.specialist_inputs,
    cro_github_trends: (inputs.cro_github_trends || []).slice(0, 3).map(report => ({
      date: report.date,
      generated_at: report.generated_at,
      periods: report.periods,
      errors: report.errors,
      candidates: (report.candidates || []).slice(0, 12).map(candidate => ({
        full_name: candidate.full_name,
        html_url: candidate.html_url,
        period: candidate.period,
        stars: candidate.stars,
        language: candidate.language,
        description: candidate.description,
        purpose: candidate.purpose,
        fit_score: candidate.fit_score,
        license_spdx_id: candidate.license_spdx_id,
      })),
    })),
    cro_repo_lab_runs: (inputs.cro_repo_lab_runs || []).slice(0, 6).map(compactRepoLabRun),
    cro_contract: inputs.cro_contract,
  };

  compact.intelligence.research = (brief?.intelligence?.research || [])
    .slice(0, 10)
    .map(compactResearchRow);
  if (compact.intelligence.intelligence) {
    compact.intelligence.intelligence.research = (brief?.intelligence?.intelligence?.research || [])
      .slice(0, 10)
      .map(compactResearchRow);
  }

  compact.task_queue = Object.fromEntries(
    Object.entries(brief?.task_queue || {}).map(([role, rows]) => {
      const list = Array.isArray(rows) ? rows : [];
      const active = list.filter(
        row => !['done', 'verified', 'deployed', 'cancelled', 'failed'].includes(row.status)
      );
      const recent = list.filter(row => !active.includes(row)).slice(0, 4);
      return [role, [...active, ...recent].slice(0, 24).map(compactQueueRow)];
    })
  );
  const workItems = brief?.work_items || [];
  compact.work_items = workItems
    .filter(item => !['cancelled', 'done', 'complete'].includes(item.status))
    .slice(0, 30)
    .map(item => ({
      work_id: item.work_id,
      title: item.title,
      kind: item.kind,
      status: item.status,
      priority: item.priority,
      owner: item.owner,
      site: item.site,
      summary: item.summary,
      next_action: item.next_action,
      due_at: item.due_at,
      evidence: (item.evidence || []).slice(0, 3),
    }));
  compact.work_item_summary = workItems.reduce((summary, item) => {
    summary[item.status] = (summary[item.status] || 0) + 1;
    return summary;
  }, {});
  compact.handoffs = (brief?.handoffs || []).slice(0, 12).map(handoff => ({
    handoff_id: handoff.handoff_id,
    site: handoff.site,
    from_role: handoff.from_role,
    to_role: handoff.to_role,
    status: handoff.status,
    title: handoff.title,
    summary: handoff.summary,
    next_action: handoff.next_action,
  }));
  compact.data_requests = (brief?.data_requests || []).slice(0, 10).map(request => ({
    request_id: request.request_id,
    requested_by: request.requested_by,
    question: request.question,
    status: request.status,
    generated_at: request.generated_at,
    artifact: request.artifact,
  }));
  compact.model_context_note =
    'Large historical arrays, raw repository listings, and duplicate report bodies are compacted here. The control plane retains the authoritative artifacts and source timestamps; do not treat omitted context as zero or proof of absence.';
  return compact;
}

function buildPrompt(brief) {
  const modelBrief = compactModelBrief(brief);
  return `You are the autonomous CEO of a domain portfolio working with a CTO, CRO, CFO, Legal/Compliance lead, and on-demand domain managers. Your mission is attributable revenue growth and durable enterprise value across the fleet. You are proactive: inspect the evidence, identify the next best actions, delegate research when useful, and do not wait for a human prompt. The owner remains principal and must approve material decisions.

Rules:
- Use only evidence present in the brief; label uncertainty and propose research when evidence is missing.
- Treat the owner_strategy as the operating contract. If it is empty, propose a concrete default strategy and ask for confirmation rather than inventing a budget or target.
- Challenge blockers instead of treating them as terminal. If a managed site is private, password protected, preview-only, parked, noindex/nofollow, or otherwise unable to earn, ask why, who owns the launch decision, whether it can monetize while gated, what must be true to go live, and what opportunity cost comes from remaining private. Create an owner-facing launch-readiness/go-live or monetization proposal, or a bounded research request, unless evidence supports keeping it parked. A blocked site is an unresolved business question, not a completed decision.
- Every cycle with an unblocked candidate, parked/scaffold opportunity, CRO lead, launch blocker, or material revenue question must contain either (a) one direct owner-facing question with concrete answer options and the evidence behind it, or (b) one measurable growth action/proposal with an owner, metric, baseline, time-to-learn, and rollback. A maintenance summary alone is not an acceptable CEO result.
- Lead with a recommendation, not a questionnaire. Every material owner update must state "Recommendation:", the decision or action you recommend now, the evidence and numbers supporting it, what is genuinely unknown or not calculable, and the smallest next step that resolves the uncertainty. Ask the owner only for the one decision that remains after giving that recommendation.
- Rank opportunities by expected attributable revenue, confidence, contribution margin, time-to-learn, and reversibility. Report the source and measurement window for every quantitative claim. Treat low-volume or missing affiliate attribution as a background measurement gap—not a blocker to higher-impact work—unless the evidence shows material revenue at stake.
- Follow action_mandate every hourly cycle: when candidates are present, select a small portfolio batch of up to six highest-confidence, low-risk, reversible improvements as change_requests for the engineer across distinct sites, or explain in a message why every candidate was rejected. When three or more distinct candidates are available, cover at least three distinct sites. Never duplicate a site that already has active work. Do not turn routine reversible implementation into an owner proposal; reserve proposals for material decisions, launch gates, spend, credentials, or scope changes.
- Use intelligence.sources and intelligence.decision_support, including source freshness and errors, to create research proposals before making strong portfolio claims. Never interpret an unavailable source as a zero metric.
- Read the complete intelligence bundle before asking for data. Analytics, SEO, revenue, AI usage, operations, RevOps, experiments, campaigns, social, Data Hub, compliance scan history, data-quality boundaries, priorities, and registry data are read-only inputs collected automatically. If a source is unavailable, report the gap in your owner message and use the recurring snapshot/report path; do not create a duplicate data-request proposal.
- Treat specialist_inputs.cro_github_trends and specialist_inputs.cro_repo_lab_runs as lead evidence from the CRO. The repo lab is disposable and read-only; validate license, security, maintenance, fit, and measurable conversion/revenue upside before recommending adoption. Never install or deploy a discovered repository directly.
- Treat cro_proposals as CRO handoffs for CEO/CTO review, not owner approval requests. For each useful lead, either create a bounded public research request, create a separate owner-facing proposal with measurable acceptance criteria, or explain why no action is justified. Do not leave the lead waiting on the owner merely because it came from the CRO.
- Manage every listed site except the explicitly excluded sites. 3boobs.com is out of scope entirely: do not analyze it, propose work for it, mention it in owner updates, or queue work for it.
- Review portfolio_inventory when deciding where to invest. Parked/scaffold domains are owned inventory, not invisible sites: evaluate their audience fit, monetization potential, renewal cost, build effort, and opportunity cost. A new-domain/site launch always requires an owner proposal and approval before onboarding or production work.
- The managed properties are satire/meme sites. Never infer adult or NSFW classification from a domain name. Use the supplied site description/registry evidence and owner instructions; if evidence is incomplete, say so without inventing a classification.
- Prefer reversible, measurable actions with a clear expected upside and time-to-learn.
- Treat actionability as a hard operating signal: inspect the scorecard before proposing more ideas. If work is queued, finish it; if work is deployed, measure it; if work is proven, compare the actual metric delta with the expected upside. Do not count a proposal, message, or research result as a business improvement by itself.
- Treat approved proposals as commitments, not accomplishments. Inspect proposal_execution before creating more ideas. For each approved proposal without an execution request, either create the smallest safe engineer/principal-engineer request when its implementation is ready, convert a clearly site-specific and explicitly report-only proposal into a bounded report request, or create/update a work_item with an owner, evidence, next action, and explicit blocker. Do not create a duplicate proposal to avoid following through.
- When the approved-execution backlog is high, prioritize draining it over generating new proposals. The trusted control plane applies a small proposal budget and records any suppressed ideas for audit; use messages, work items, and execution requests to move existing commitments instead.
- Treat approved proposals with failed or cancelled requests as unfinished. Do not blindly retry them; create or update the durable follow-through work item with the failure evidence and the smallest repair/replacement action.
- Use RevOps stages and lead scores for any lead or partnership opportunity; do not call traffic an opportunity until there is an intent, lead, affiliate, or revenue signal.
- Use the CFO lens for every material recommendation: contribution margin, attribution confidence, cost to learn, cash/spend exposure, and whether the expected upside is measurable. Never move money, change billing, access banking, sign contracts, or make tax/legal claims.
- Treat Legal/Compliance as a required launch and risk pass. Use the compliance baseline and history to identify privacy, consent, terms, disclosure, data-rights, claims, copyright/trademark, platform-policy, and age/regulated-content questions when supported by evidence. Legal performs risk triage, not legal advice or certification; escalate material uncertainty to the owner or counsel. Do not let incomplete telemetry block ordinary growth, but do not recommend a go-live proposal without a concrete legal review and launch checklist.
- Treat an active launch_readiness checklist as an ongoing workstream, not a one-time question. Review open tasks every cycle, report the evidence found or the exact blocker, and identify the smallest next evidence action. Do not repeatedly ask the owner to restate the same decision while checklist work remains open; the default disposition remains the current safe state unless the owner explicitly changes it.
- Treat Security as a required production and supply-chain risk pass. Use intelligence.decision_support.security, operations, compliance, and data_quality to identify authentication, isolation, secrets, TLS, release, dependency, data exposure, and incident risks. Security performs read-only triage, not penetration testing or certification; never exploit a target or access credentials. Do not block ordinary growth for optional hardening alone, but do not recommend a go-live or security-sensitive change without a concrete Security review and rollback plan.
- Treat domain managers as recurring site specialists. Every managed site receives a lightweight review on the staggered queue; deeper work and implementation still require evidence, proposals, and the normal approval gates. The CEO owns portfolio prioritization and prevents one site from consuming disproportionate attention without evidence.
- Treat the Principal Engineer as the CTO's senior right hand. Route urgent technical investigations, incidents, architecture fixes, and emergency site work to assigned_role: principal-engineer; route ordinary bounded implementation to assigned_role: engineer. Include acceptance criteria, risk, tests, and rollback notes in every task.
- Use task_queue to avoid duplicating work. Review queued, active, review, and failed requests before creating another task. Domain managers should report task progress and surface blocked work back to fleet leadership.
- Use the experiment system for competing variants: state a hypothesis, primary metric, guardrails, sample threshold, and stop/ship decision. Do not recommend a winner before the sample threshold is met.
- You may recommend ethical technical/editorial SEO, experimentation, partnerships, outreach with consent, product work, and redesigns.
- Never propose cloaking, link spam, fake reviews, fake engagement, impersonation, credential abuse, platform evasion, or deceptive marketing.
- Do not deploy, spend money, change credentials, add domains, or make irreversible infrastructure changes. The one fleet write available to you is an allowlisted factual operating-baseline report; it never edits site code.
- Use the workbench for durable follow-through. Create or update a work_item when an evidence gap, legal/security review, decision, incident, or education need has a concrete next action. Do not create duplicate work when an existing item covers the same issue; update it with the latest status, owner, evidence, and next action.
- Use threaded messages for bounded handoffs: put the work_id on a message, name the receiving role in metadata, and make the message an update, question, decision_request, or handoff. Keep the durable case as the source of truth; messages should point to the next action rather than repeat the whole brief.
- Use knowledge as a bounded learning queue, not a link dump. Prefer primary, official, open-licensed, or clearly attributed sources; record publisher, jurisdiction, date, license, and why the source is relevant. Create an education work_item when a role needs to apply the material, and never treat a book or course as legal advice or a substitute for counsel. When completing a source, record a concise takeaway and where it was applied so future roles can reuse the learning.

Return ONLY valid JSON with this shape:
{
  "messages": [{"actor":"ceo|cto|cro|cfo|legal|security|domain-manager|reviewer","body":"concise owner update","work_id":"optional work item id","reply_to":"optional message id","message_type":"update|question|decision_request|handoff","metadata":{"to":"role"}}],
  "proposal_reviews": [{"proposal_id":"existing CRO/research proposal id","reviewed_by":"ceo|cto|cfo|legal|security|domain-manager|reviewer","status":"accepted_research|escalate_owner|declined","decision_note":"why this lead was accepted, escalated, or declined"}],
  "data_requests": [{"requested_by":"ceo|cto|cro|cfo|legal|domain-manager","question":"specific missing read-only data question","sources":["analytics"],"sites":["existing domain"]}],
  "research_requests": [{"url":"https://public.example/","question":"specific question to answer"}],
  "proposals": [{"created_by":"ceo|cto|cfo|legal|security|domain-manager","title":"...","proposal_type":"business|growth|product|engineering|site-redesign|hiring|spend|report-only","summary":"...","rationale":"...","expected_upside":{"metric":"...","estimate":"...","source":"...","measurement_window":"..."},"risks":["..."],"requested_action":"...","implementation":{"site":"existing domain or fleet","launch_gate":"go_live when proposing production launch","legal_review":{"status":"approved","reviewed_by":"legal","decision_note":"evidence-backed risk disposition"},"security_review":{"status":"approved","reviewed_by":"security","decision_note":"evidence-backed risk disposition"},"action_key":"publish-fleet-operating-baseline when site is fleet","delivery_mode":"fleet_report for the fleet operation","title":"optional task","body":"implementation body with acceptance criteria and rollback","category":"engineering|content|marketing|sales|seo|design|other","priority":"high|medium|low","assigned_role":"engineer|principal-engineer","provider":"chatgpt|claude","max_turns":20,"auto_review":true}}],
  "change_requests": [{"site":"existing domain or fleet","action_key":"publish-fleet-operating-baseline when site is fleet","delivery_mode":"fleet_report for the fleet operation","requested_by":"ceo|cto|cfo|legal|security|cro|domain-manager|researcher","title":"...","body":"...","category":"engineering|content|marketing|sales|seo|design|other","priority":"high|medium|low","assigned_role":"...","provider":"chatgpt|claude","max_turns":20,"auto_review":true}],
  "work_items": [{"work_id":"existing id to update, or omit to create","title":"...","kind":"decision|research|incident|legal|security|education|evidence|implementation","status":"open|in_progress|blocked|waiting","priority":"urgent|high|normal|low","owner":"ceo|cto|cfo|legal|security|cro|domain-manager|principal-engineer|engineer|owner","site":"existing domain or fleet","summary":"concise context","next_action":"smallest next action","due_at":"optional ISO timestamp","evidence":[{"label":"source or artifact","url":"https://...","note":"what it proves"}]}],
  "knowledge": [{"knowledge_id":"existing id to update, or omit to create","title":"...","resource_type":"official|book|course|checklist|paper|reference","audience":"all|ceo|cto|cfo|legal|security|cro|domain-manager|engineer","status":"candidate|queued|in_progress|complete|rejected","url":"https://...","publisher":"...","jurisdiction":"...","license":"...","published_at":"optional date","summary":"why this is useful","tags":["..."],"source_work_id":"optional work id","takeaway":"what the role learned","applied_to":"case, decision, or implementation where it was used","reviewed_by":"role"}]
}

Only create a change_request for low-risk, reversible work that can safely enter the existing review queue. Its priority MUST be medium or low; never use high priority. Use proposals for everything material. Keep the response concise.

FLEET BRIEF:
${JSON.stringify(modelBrief)}`;
}

function buildPassPrompt(brief, role, candidate = null) {
  if (role === 'ceo') {
    const prompt = buildPrompt(brief);
    return candidate
      ? `${prompt}\n\nCANDIDATE PLAN FROM THE CRO OR EARLIER PASS:\n${JSON.stringify(compactModelValue(candidate))}\n\nReview and preserve useful evidence-backed work; correct or reject unsafe items explicitly.`
      : prompt;
  }
  const modelBrief = compactModelBrief(brief);
  const base =
    role === 'cro'
      ? 'You are the CRO pass for an autonomous domain-fleet executive. Turn purpose-fit market, GitHub, CRO-lab, search, affiliate, and audience signals into concrete revenue experiments and product opportunities. Do not merely list popular repositories: explain the fleet use case, validation evidence, license/security/maintenance risks, expected metric, time-to-learn, and smallest reversible prototype. CRO leads are handoffs to the CEO and CTO, not owner approval requests. Every proposal you retain must set created_by to cro, and you must not directly deploy, spend, change credentials, or add domains.'
      : role === 'cto'
        ? "You are the CTO review pass for an autonomous domain-fleet executive. Check technical feasibility, isolation, reversibility, implementation effort, measurement instrumentation, and whether the proposed work can safely enter the existing queue. Preserve the CEO's revenue intent while correcting unsafe or technically unsupported items."
        : role === 'cfo'
          ? 'You are the CFO review pass for an autonomous domain-fleet executive. Check attribution quality, contribution margin, cost-to-learn, AI and infrastructure spend, budget exposure, and whether revenue claims are supported. Lead with a financial recommendation, using known numbers and dates from the brief. If a number is not calculable, say exactly why and give the minimum measurement needed; do not merely ask the owner to decide without a recommendation. Push back on vanity metrics and unsupported forecasts. You may propose report-only finance work, but never move money, change billing, access banking, sign contracts, or make legal/tax claims. Every proposal you retain must set created_by to cfo.'
          : role === 'principal-engineer'
            ? 'You are the Principal Engineer review pass and the CTO’s senior implementation partner. Check urgent technical work, failure recovery, architecture risk, acceptance criteria, rollback, and test coverage. Route only bounded, evidence-backed implementation to assigned_role principal-engineer; never deploy directly. Every proposal you retain must set created_by to cto.'
            : role === 'legal'
              ? 'You are the Legal and Compliance review pass for the autonomous domain-fleet executive. Inspect compliance, data_quality, site, analytics, revenue, launch evidence, and launch_readiness checklists. Lead with a risk disposition and recommendation: clear, conditional, blocked, or counsel_required. State the specific evidence, concrete blockers, and the exact decision you recommend. Treat launch_readiness.tracking and its open tasks as an active workstream: report progress, close only evidenced tasks, and name the next evidence action rather than repeating a generic owner question. For every launch-readiness data_use_review item, decide whether the stated source, purpose, processing, display/sharing, and monetization use is clear, conditional, blocked, counsel_required, or evidence_needed; name the missing evidence and the smallest next action. This is risk triage, not legal advice or certification; never invent legal advice, and identify where human counsel is required. Triage privacy, consent, terms, cookie/analytics disclosure, affiliate disclosure, data provenance and rights, claims, copyright/trademark, platform policy, and regulated or age-sensitive concerns when supported by evidence. Do not block ordinary growth merely because telemetry is incomplete. For private or gated sites, require a concrete launch decision and checklist. Every proposal you retain must set created_by to legal. For a go-live proposal, include implementation.launch_gate="go_live" and implementation.legal_review with status approved or needs_owner, reviewed_by legal, and a concise decision_note only when supported by the evidence.'
              : role === 'security'
                ? 'You are the Security review pass for an autonomous domain-fleet executive. Inspect the read-only fleet-doctor security baseline plus intelligence.decision_support.security, operations, compliance, and data_quality. Lead with a security disposition and recommendation: clear, conditional, blocked, or evidence_needed. State the concrete evidence, risk severity, and the exact decision you recommend. This is read-only risk triage, not penetration testing or certification; never exploit targets, access credentials, or claim a clean bill of health from missing data. Triage authentication and access boundaries, secrets exposure, container isolation, release/deploy controls, TLS, dependency and supply-chain risk, data exposure, incident signals, and security.txt or disclosure readiness when evidence supports it. Do not block ordinary growth for optional hardening alone. Every proposal you retain must set created_by to security. For a go-live or security-sensitive proposal, include implementation.security_review with status approved or needs_owner, reviewed_by security, and a concise evidence-backed decision_note.'
                : role === 'domain-manager'
                  ? 'You are an on-demand domain manager for the managed site named in domain_manager. Focus on that site’s audience, content, analytics, monetization, health, and backlog. Return evidence-backed site proposals to fleet leadership; do not expand scope to other sites or directly deploy. Every proposal you retain must set created_by to domain-manager and implementation.site to the exact managed site from domain_manager. Report-only proposals must include a concrete title, body, acceptance artifact, and rollback/follow-up boundary so they can enter the worker queue.'
                  : 'You are the independent executive reviewer. Reject unsupported revenue claims, scope violations, unsafe tactics, high-priority queue work, and production proposals that lack a measurable outcome. Missing attribution or low-volume telemetry should block unsupported financial claims and production work, but should not force a no-op: preserve up to five bounded research_requests when each uses a public URL, answers a specific evidence gap, is read-only and reversible, does not duplicate the shared telemetry contract, and cannot change credentials, configuration, spending, schedules, or production. Keep only the smallest defensible plan and add a concise owner message explaining material concerns.';
  return `${base}\n\nReturn ONLY the same valid JSON plan shape required by the CEO. Do not mention or target 3boobs.com. Do not invent telemetry.\n\nFLEET BRIEF:\n${JSON.stringify(modelBrief)}\n\nCANDIDATE PLAN TO REVIEW:\n${JSON.stringify(compactModelValue(candidate || {}))}`;
}

function extractJsonObject(text) {
  const start = String(text || '').indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

// Some CLI providers wrap the object in a code fence or add one sentence of
// commentary. Raw control characters inside a JSON string are another common
// formatting defect. Repair only those unambiguous transport defects; quotes,
// commas, and schema errors still fail closed and go through the bounded retry.
function escapeJsonControlCharacters(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const char of String(text || '')) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += char;
      } else if (char === '\\') {
        escaped = true;
        out += char;
      } else if (char === '"') {
        inString = false;
        out += char;
      } else if (char.charCodeAt(0) < 0x20) {
        const escapes = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };
        out += escapes[char] || `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
      } else {
        out += char;
      }
    } else {
      out += char;
      if (char === '"') inString = true;
    }
  }
  return out;
}

function parseProviderJson(raw) {
  const candidates = [raw];
  const extracted = extractJsonObject(raw);
  if (extracted && extracted !== raw) candidates.push(extracted);
  let lastError;
  for (const candidate of candidates) {
    try {
      return JSON.parse(escapeJsonControlCharacters(candidate));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('provider output is empty');
}

function parseOutput(text, { defaultActor = '', defaultSite = '' } = {}) {
  const raw = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (raw.length > 1024 * 1024) throw new Error('provider output exceeds 1 MiB');
  let result;
  try {
    result = parseProviderJson(raw);
  } catch (error) {
    throw new Error(`provider did not return valid JSON: ${error.message}`);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('provider output must be a JSON object');
  for (const key of [
    'messages',
    'proposal_reviews',
    'data_requests',
    'proposals',
    'change_requests',
    'research_requests',
    'work_items',
    'knowledge',
  ])
    if (result[key] !== undefined && !Array.isArray(result[key]))
      throw new Error(`${key} must be an array`);
  const plan = {
    messages: result.messages || [],
    proposal_reviews: result.proposal_reviews || [],
    data_requests: result.data_requests || [],
    proposals: result.proposals || [],
    change_requests: result.change_requests || [],
    research_requests: result.research_requests || [],
    work_items: result.work_items || [],
    knowledge: result.knowledge || [],
  };
  normalizeProviderProposalTypes(plan, { defaultActor, defaultSite });
  validatePlan(plan);
  return plan;
}

function normalizeProviderProposalTypes(plan, { defaultActor = '', defaultSite = '' } = {}) {
  for (const item of plan.proposals) {
    // Domain-manager passes are already scoped to one managed site. Preserve
    // that scope when the model omits the repetitive implementation wrapper;
    // without it an approved report-only proposal cannot safely enter the
    // worker queue because the control plane cannot infer a target.
    if (
      String(defaultActor || '') === 'domain-manager' &&
      String(defaultSite || '').trim() &&
      (!item.implementation || typeof item.implementation !== 'object' || !item.implementation.site)
    ) {
      item.implementation = {
        ...(item.implementation && typeof item.implementation === 'object'
          ? item.implementation
          : {}),
        site: String(defaultSite).trim().toLowerCase(),
      };
    }
    const raw = String(item?.proposal_type || '')
      .trim()
      .toLowerCase();
    if (!raw || PROPOSAL_TYPES.has(raw)) {
      if (!raw) item.proposal_type = 'business';
      continue;
    }

    const alias = PROPOSAL_TYPE_ALIASES.get(raw);
    if (alias) {
      item.proposal_type = alias;
      continue;
    }

    // Proposal type is presentation metadata, not authorization. Preserve the
    // evidence and route genuinely unknown model labels to the safest valid
    // bucket instead of retrying the entire manager run.
    item.proposal_type = 'report-only';
  }
  // Proposal reviews are optional metadata. A reviewer occasionally emits a
  // blank review while preserving the rest of a useful plan; discard only
  // that malformed optional row instead of failing the entire executive cycle.
  plan.proposal_reviews = plan.proposal_reviews.filter(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const raw = String(item?.status || '')
      .trim()
      .toLowerCase();
    if (!raw) return false;
    const alias = {
      accepted: 'accepted_research',
      approved: 'accepted_research',
      approve: 'accepted_research',
      accepted_research: 'accepted_research',
      reviewed: 'accepted_research',
      rejected: 'declined',
      denied: 'declined',
      deny: 'declined',
      declined: 'declined',
      feedback: 'escalate_owner',
      owner_review: 'escalate_owner',
      owner: 'escalate_owner',
      needs_owner: 'escalate_owner',
    }[raw];
    if (alias) item.status = alias;
    const reviewActorAliases = {
      domain_manager: 'domain-manager',
      domainmanager: 'domain-manager',
      'domain manager': 'domain-manager',
      'independent reviewer': 'reviewer',
    };
    const reviewers = new Set([
      'ceo',
      'cto',
      'cro',
      'cfo',
      'legal',
      'security',
      'domain-manager',
      'reviewer',
    ]);
    const validStatuses = new Set(['accepted_research', 'escalate_owner', 'declined']);
    if (!String(item.proposal_id || '').trim()) return false;
    const normalizedReviewer =
      reviewActorAliases[
        String(item.reviewed_by || '')
          .trim()
          .toLowerCase()
      ] || String(item.reviewed_by || '');
    item.reviewed_by = normalizedReviewer;
    if (!reviewers.has(normalizedReviewer)) return false;
    if (!validStatuses.has(String(item.status || ''))) return false;
    if (String(item.decision_note || '').length > 2000)
      item.decision_note = String(item.decision_note).slice(0, 2000);
    return true;
  });
  const actorAliases = {
    'chief executive officer': 'ceo',
    'chief technology officer': 'cto',
    'chief financial officer': 'cfo',
    'chief revenue officer': 'cro',
    'domain manager': 'domain-manager',
    domain_manager: 'domain-manager',
    domainmanager: 'domain-manager',
    'independent reviewer': 'reviewer',
    compliance: 'legal',
    'legal/compliance': 'legal',
    'legal-compliance': 'legal',
    'legal review': 'legal',
    'security review': 'security',
    'security officer': 'security',
    'security/compliance': 'security',
  };
  for (const item of plan.messages) {
    // Providers occasionally use the prompt's natural-language field names
    // (role/from/content) even when the JSON contract says actor/body. These
    // aliases are still validated against the closed actor/type allowlists
    // below; they do not grant a new capability or actor.
    if (!item.actor && item.role) item.actor = item.role;
    if (!item.actor && item.from) item.actor = item.from;
    if (!item.actor && defaultActor) item.actor = defaultActor;
    if (!item.body && item.content) item.body = item.content;
    if (!item.body && item.message) item.body = item.message;
    const raw = String(item?.actor || '')
      .trim()
      .toLowerCase();
    item.actor = actorAliases[raw] || raw;
    const messageType = String(item?.message_type || '')
      .trim()
      .toLowerCase();
    const messageTypeAliases = {
      status: 'update',
      status_update: 'update',
      progress: 'update',
      note: 'update',
      report: 'update',
      recommendation: 'decision_request',
      decision: 'decision_request',
      decision_request: 'decision_request',
      review: 'update',
      research: 'handoff',
      research_request: 'handoff',
      task_handoff: 'handoff',
      handoff_request: 'handoff',
      status_report: 'update',
      data_use_review: 'update',
      legal_review: 'update',
      compliance_review: 'update',
      security_review: 'update',
      launch_review: 'update',
    };
    if (messageTypeAliases[messageType]) item.message_type = messageTypeAliases[messageType];
  }
  for (const item of plan.data_requests) {
    const raw = String(item?.requested_by || '')
      .trim()
      .toLowerCase();
    item.requested_by = actorAliases[raw] || raw;
  }
  for (const item of plan.proposal_reviews) {
    const raw = String(item?.reviewed_by || '')
      .trim()
      .toLowerCase();
    item.reviewed_by = actorAliases[raw] || raw || defaultActor;
  }
  for (const item of plan.proposals) {
    const raw = String(item?.created_by || '')
      .trim()
      .toLowerCase();
    item.created_by = actorAliases[raw] || raw || defaultActor;
  }
  const requestors = new Set([
    'ceo',
    'cto',
    'cfo',
    'cro',
    'legal',
    'security',
    'domain-manager',
    'researcher',
  ]);
  for (const item of plan.change_requests) {
    const raw = String(item?.requested_by || item?.actor || '')
      .trim()
      .toLowerCase();
    const normalized = actorAliases[raw] || raw;
    item.requested_by = requestors.has(normalized)
      ? normalized
      : requestors.has(defaultActor)
        ? defaultActor
        : 'ceo';
    // A report/diagnosis that omitted delivery_mode must not enter the
    // deployment path. The queue module owns the same conservative inference
    // for requests created outside this runner.
    if (!Object.prototype.hasOwnProperty.call(item, 'delivery_mode'))
      item.delivery_mode = changequeue.inferredDeliveryMode(item);
    // Work items use `normal`; the durable change queue uses `medium` for the
    // same bounded priority. Normalize that shared human-facing alias before
    // the queue validator sees it. Keep high/urgent values high so the
    // executive safety gate can still reject them rather than silently
    // lowering material work.
    const priorityAliases = { normal: 'medium', critical: 'high', urgent: 'high' };
    const priority = String(item.priority || '')
      .trim()
      .toLowerCase();
    const normalizedPriority = priorityAliases[priority] || priority;
    item.priority = ['high', 'medium', 'low'].includes(normalizedPriority)
      ? normalizedPriority
      : 'medium';
  }
  for (const item of plan.work_items) {
    // Work items are durable follow-through records, not executable commands.
    // Providers still occasionally return human-facing aliases or omit the
    // fields that are defaults in the prompt. Normalize those safe metadata
    // variants here so one malformed case cannot discard an otherwise useful
    // executive cycle. Unknown ownership is deliberately bound to the
    // authenticated pass role (or CEO for the reviewer), never accepted as a
    // new capability.
    if (!item.work_id && item.id) item.work_id = item.id;
    if (!item.title && (item.name || item.label)) item.title = item.name || item.label;
    if (!item.title && item.work_id) item.title = `Executive follow-up: ${item.work_id}`;
    if (!item.summary && item.description) item.summary = item.description;
    if (!item.next_action && (item.action || item.next_step))
      item.next_action = item.action || item.next_step;
    if (item.site === undefined && item.domain !== undefined) item.site = item.domain;
    const kindAliases = {
      task: 'implementation',
      bug: 'incident',
      defect: 'incident',
      analytics: 'evidence',
      telemetry: 'evidence',
      monitoring: 'evidence',
      launch: 'decision',
      growth: 'evidence',
    };
    const kind = String(item.kind || '')
      .trim()
      .toLowerCase();
    if (kindAliases[kind]) item.kind = kindAliases[kind];
    const statusAliases = {
      active: 'in_progress',
      started: 'in_progress',
      pending: 'waiting',
      queued: 'waiting',
    };
    const status = String(item.status || '')
      .trim()
      .toLowerCase();
    if (statusAliases[status]) item.status = statusAliases[status];
    const priorityAliases = { medium: 'normal', critical: 'urgent' };
    const priority = String(item.priority || '')
      .trim()
      .toLowerCase();
    if (priorityAliases[priority]) item.priority = priorityAliases[priority];
    if (item.evidence && !Array.isArray(item.evidence)) item.evidence = [item.evidence];
    const raw = String(item?.owner || '')
      .trim()
      .toLowerCase();
    const normalizedOwner = actorAliases[raw] || raw;
    const validOwners = new Set([
      'ceo',
      'cto',
      'cfo',
      'legal',
      'security',
      'cro',
      'domain-manager',
      'principal-engineer',
      'engineer',
      'owner',
    ]);
    const fallbackOwner = defaultActor && validOwners.has(defaultActor) ? defaultActor : 'ceo';
    item.owner = validOwners.has(normalizedOwner) ? normalizedOwner : fallbackOwner;
  }
  return plan;
}

function validatePlan(plan) {
  if (!Array.isArray(plan.knowledge)) plan.knowledge = [];
  if (
    plan.messages.length > 20 ||
    plan.proposal_reviews.length > 20 ||
    plan.data_requests.length > 10 ||
    plan.proposals.length > 20 ||
    plan.change_requests.length > 20 ||
    plan.research_requests.length > 10 ||
    plan.work_items.length > 20 ||
    plan.knowledge.length > 20
  )
    throw new Error('provider plan exceeds per-tick item limit');
  for (const item of plan.data_requests) {
    if (!String(item.question || '').trim() || String(item.question).length > 500)
      throw new Error('invalid data request in provider plan');
    if (
      !['ceo', 'cto', 'cfo', 'cro', 'legal', 'security', 'domain-manager', 'researcher'].includes(
        String(item.requested_by || '')
      )
    )
      throw new Error('invalid data request actor');
  }
  for (const item of plan.research_requests) {
    if (
      !String(item.url || '').trim() ||
      !String(item.question || '').trim() ||
      String(item.question).length > 500
    )
      throw new Error('invalid research request in provider plan');
    research.validateUrl(item.url);
  }
  for (const [index, item] of plan.proposal_reviews.entries()) {
    if (
      !String(item.proposal_id || '').trim() ||
      !['ceo', 'cto', 'cro', 'cfo', 'legal', 'security', 'domain-manager', 'reviewer'].includes(
        String(item.reviewed_by || '')
      ) ||
      !['accepted_research', 'escalate_owner', 'declined'].includes(String(item.status || '')) ||
      String(item.decision_note || '').length > 2000
    )
      throw new Error(
        `invalid proposal review in provider plan at index ${index} (reviewed_by=${String(item.reviewed_by || '')}, status=${String(item.status || '')}, proposal_id=${String(item.proposal_id || '')})`
      );
    if (/3boobs(?:\.com)?/i.test(JSON.stringify(item)))
      throw new Error('executive plan references an excluded site');
  }
  for (const [index, item] of plan.messages.entries()) {
    if (
      !['ceo', 'cto', 'cro', 'cfo', 'legal', 'security', 'domain-manager', 'reviewer'].includes(
        String(item.actor)
      ) ||
      !String(item.body || '').trim() ||
      String(item.body).length > 10000 ||
      (item.message_type &&
        !['update', 'question', 'decision_request', 'handoff'].includes(
          String(item.message_type)
        )) ||
      (item.metadata !== undefined &&
        (typeof item.metadata !== 'object' || Array.isArray(item.metadata)))
    )
      throw new Error(
        `invalid executive message in provider plan at index ${index} (actor=${String(item.actor || '')}, message_type=${String(item.message_type || '')}, body_length=${String(item.body || '').length}, metadata=${item.metadata === undefined ? 'absent' : Array.isArray(item.metadata) ? 'array' : typeof item.metadata})`
      );
    if (/3boobs(?:\.com)?/i.test(String(item.body)))
      throw new Error('executive plan references an excluded site');
  }
  for (const [index, item] of plan.proposals.entries()) {
    const invalid = [];
    if (
      !item ||
      !['ceo', 'cto', 'cro', 'cfo', 'legal', 'security', 'domain-manager', 'researcher'].includes(
        String(item?.created_by || 'ceo')
      )
    )
      invalid.push(`created_by=${String(item?.created_by || '')}`);
    if (!String(item?.title || '').trim()) invalid.push('title=missing');
    else if (String(item.title).length > 300) invalid.push('title=too-long');
    if (!String(item?.summary || '').trim()) invalid.push('summary=missing');
    if (!String(item?.requested_action || '').trim()) invalid.push('requested_action=missing');
    if (invalid.length)
      throw new Error(
        `invalid executive proposal in provider plan at index ${index} (${invalid.join(', ')})`
      );
    if (/3boobs(?:\.com)?/i.test(JSON.stringify(item)))
      throw new Error('executive plan references an excluded site');
    const assignedRole = item.implementation?.assigned_role;
    if (assignedRole && !['engineer', 'principal-engineer'].includes(String(assignedRole)))
      throw new Error('executive implementation must route to engineer or principal-engineer');
    const launchGate = String(item.implementation?.launch_gate || '').toLowerCase();
    const securityGate = String(item.implementation?.security_gate || '').toLowerCase();
    if (launchGate === 'go_live') {
      const legalReview = item.implementation?.legal_review;
      if (legalReview?.status !== 'approved' || legalReview.reviewed_by !== 'legal')
        throw new Error('go-live proposal requires approved legal review');
    }
    if (launchGate === 'go_live' || securityGate === 'required') {
      const securityReview = item.implementation?.security_review;
      if (securityReview?.status !== 'approved' || securityReview.reviewed_by !== 'security')
        throw new Error('security-sensitive proposal requires approved security review');
    }
  }
  for (const item of plan.work_items) {
    if (
      (!item.work_id && !String(item.title || '').trim()) ||
      String(item.title || '').length > 300 ||
      String(item.summary || '').length > 4000 ||
      String(item.takeaway || '').length > 2000 ||
      String(item.applied_to || '').length > 1000 ||
      String(item.next_action || '').length > 1000 ||
      ![
        'decision',
        'research',
        'incident',
        'legal',
        'security',
        'education',
        'evidence',
        'implementation',
      ].includes(String(item.kind || 'decision')) ||
      !['open', 'in_progress', 'blocked', 'waiting'].includes(String(item.status || 'open')) ||
      !['urgent', 'high', 'normal', 'low'].includes(String(item.priority || 'normal')) ||
      ![
        'ceo',
        'cto',
        'cfo',
        'legal',
        'security',
        'cro',
        'domain-manager',
        'principal-engineer',
        'engineer',
        'owner',
      ].includes(String(item.owner || 'ceo')) ||
      (item.evidence !== undefined && (!Array.isArray(item.evidence) || item.evidence.length > 20))
    )
      throw new Error('invalid work item in provider plan');
    if (item.site && EXECUTIVE_EXCLUDED_SITES.has(String(item.site).toLowerCase()))
      throw new Error('executive plan targets an excluded site');
    if (/3boobs(?:\.com)?/i.test(JSON.stringify(item)))
      throw new Error('executive plan references an excluded site');
  }
  if (plan.knowledge.length > 20) throw new Error('provider plan exceeds knowledge item limit');
  for (const item of plan.knowledge) {
    if (
      (!item.knowledge_id && !String(item.title || '').trim()) ||
      String(item.title || '').length > 300 ||
      String(item.summary || '').length > 4000 ||
      !['official', 'book', 'course', 'checklist', 'paper', 'reference'].includes(
        String(item.resource_type || 'official')
      ) ||
      ![
        'all',
        'ceo',
        'cto',
        'cfo',
        'legal',
        'security',
        'cro',
        'domain-manager',
        'engineer',
      ].includes(String(item.audience || 'all')) ||
      !['candidate', 'queued', 'in_progress', 'complete', 'rejected'].includes(
        String(item.status || 'candidate')
      ) ||
      (item.url && !/^https?:\/\//i.test(String(item.url))) ||
      (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.length > 20))
    )
      throw new Error('invalid knowledge item in provider plan');
    if (/3boobs(?:\.com)?/i.test(JSON.stringify(item)))
      throw new Error('knowledge item references an excluded site');
  }
  for (const item of plan.change_requests) {
    if (
      !String(item.site || '').trim() ||
      !String(item.title || '').trim() ||
      !String(item.body || '').trim()
    )
      throw new Error('invalid change request in provider plan');
    if (String(item.priority || 'medium') === 'high')
      throw new Error('executive provider cannot queue high-priority work');
    if (EXECUTIVE_EXCLUDED_SITES.has(String(item.site).toLowerCase()))
      throw new Error('executive plan targets an excluded site');
    if (String(item.site) === 'fleet') {
      if (
        String(item.delivery_mode || '') !== 'fleet_report' ||
        String(item.action_key || '') !== FLEET_ACTION_KEY
      )
        throw new Error('executive fleet work must use the allowlisted fleet report operation');
    }
    if (
      item.requested_by !== undefined &&
      !['ceo', 'cto', 'cfo', 'cro', 'legal', 'security', 'domain-manager', 'researcher'].includes(
        String(item.requested_by)
      )
    )
      throw new Error('change request has an invalid requested_by role');
  }
  return plan;
}

function planFingerprint(plan) {
  return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

function actionMandateSatisfied(plan = {}, brief = {}) {
  if (!(brief.action_mandate?.candidates || []).length) return true;
  const candidateSites = new Set(
    brief.action_mandate.candidates
      .map(item =>
        String(item.site || '')
          .trim()
          .toLowerCase()
      )
      .filter(site => site && site !== 'fleet' && !EXECUTIVE_EXCLUDED_SITES.has(site))
  );
  const requiredSites = Math.min(3, candidateSites.size);
  const boundedSites = new Set(
    (plan.change_requests || []).map(item =>
      String(item.site || '')
        .trim()
        .toLowerCase()
    )
  );
  const coveredSites = [...candidateSites].filter(site => boundedSites.has(site)).length;
  // A single material owner decision (for example a gated launch) may remain
  // a question after a recommendation. Once the brief contains a portfolio
  // of three or more site candidates, however, a question alone is not enough
  // and the plan must cover at least three sites.
  const portfolioSpread = candidateSites.size < 3 || coveredSites >= requiredSites;
  const hasBoundedWork =
    (plan.change_requests || []).length > 0 ||
    (candidateSites.size < 3 &&
      (plan.proposals || []).some(
        item => item.implementation && Object.keys(item.implementation).length
      ));
  const hasRecommendation = (plan.messages || []).some(message =>
    /recommend(?:ation)?\s*:/i.test(String(message.body || ''))
  );
  if (hasBoundedWork && hasRecommendation && portfolioSpread) return true;
  return (
    (plan.messages || []).some(
      message =>
        /\?/.test(String(message.body || '')) &&
        /owner|choose|approve|decision|should|can we|which|whether/i.test(
          String(message.body || '')
        ) &&
        /recommend(?:ation)?\s*:/i.test(String(message.body || ''))
    ) &&
    (brief.action_mandate?.candidates || []).length > 0 &&
    portfolioSpread
  );
}

const FOLLOW_THROUGH_WORK_PREFIX = 'approved-proposal:';
const FOLLOW_THROUGH_OWNERS = new Set([
  'ceo',
  'cto',
  'cfo',
  'legal',
  'security',
  'cro',
  'domain-manager',
  'principal-engineer',
  'engineer',
  'owner',
]);

function followThroughOwner(createdBy) {
  const role = String(createdBy || '')
    .trim()
    .toLowerCase();
  if (FOLLOW_THROUGH_OWNERS.has(role)) return role;
  if (role === 'researcher') return 'cro';
  return 'ceo';
}

function followThroughKind(proposalType) {
  return (
    {
      engineering: 'implementation',
      'site-redesign': 'implementation',
      growth: 'evidence',
      'report-only': 'research',
      product: 'decision',
      business: 'decision',
      hiring: 'decision',
      spend: 'decision',
    }[String(proposalType || '').toLowerCase()] || 'decision'
  );
}

function proposalSite(proposal, root = ROOT) {
  const sites = executiveSites(root);
  const explicit = [proposal?.site, proposal?.domain, proposal?.implementation?.site]
    .map(value =>
      String(value || '')
        .trim()
        .toLowerCase()
    )
    .find(site => site && sites.includes(site));
  if (explicit) return explicit;
  // Older approved proposals often contain the site's brand name but not its
  // hostname (for example, "Arttogogh" or "Great American Lakes"). Infer a
  // site only when the normalized hostname is a unique token in the proposal;
  // ambiguous fleet-wide proposals remain unassigned and therefore cannot be
  // queued as site work.
  const text =
    `${proposal?.title || ''}\n${proposal?.summary || ''}\n${proposal?.requested_action || ''}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  const matches = sites.filter(site => {
    const token = String(site)
      .toLowerCase()
      .replace(/\.[a-z0-9.-]+$/, '')
      .replace(/[^a-z0-9]+/g, '');
    return token.length >= 4 && text.includes(token);
  });
  return matches.length === 1 ? matches[0] : null;
}

function approvedReportOnlyImplementation(proposal, root = ROOT) {
  const implementation = proposal?.implementation;
  if (implementation && typeof implementation === 'object' && Object.keys(implementation).length)
    return implementation;
  const text = `${proposal?.title || ''}\n${proposal?.summary || ''}\n${proposal?.requested_action || ''}`;
  const explicitlyReadOnly =
    String(proposal?.proposal_type || '').toLowerCase() === 'report-only' ||
    /\b(?:report[- ]only|read[- ]only|no production changes?|do not deploy|do not change production)\b/i.test(
      text
    );
  if (!explicitlyReadOnly) return {};
  const site = proposalSite(proposal, root);
  if (!site || EXECUTIVE_EXCLUDED_SITES.has(site)) return {};
  const category = /\b(?:seo|search|gsc|crawl|sitemap|organic|index(?:ing)?|snippet|query)\b/i.test(
    text
  )
    ? 'seo'
    : /\b(?:performance|analytics|measurement|attribution|cost|technical|lcp|cls|orchestration|runtime|data)\b/i.test(
          text
        )
      ? 'engineering'
      : 'other';
  return {
    site,
    title: proposal.title,
    body: [
      `Execute the approved report-only proposal: ${proposal.title}.`,
      `Objective: ${proposal.summary || 'Produce the requested evidence and recommendations.'}`,
      `Owner direction: ${proposal.requested_action || 'Return a concise evidence-backed report.'}`,
      'Delivery boundary: read-only evidence and an artifact only. Do not deploy, push code, change credentials, schedules, configuration, spending, DNS, or production data.',
      'Acceptance: write a timestamped report artifact with observed facts, unavailable fields, prioritized recommendations, validation criteria, and rollback or follow-up notes where applicable.',
    ].join('\n'),
    category,
    priority: 'low',
    assigned_role: reportOnlyRole(category, site, root),
    requested_by: proposal.created_by === 'researcher' ? 'cro' : proposal.created_by,
    provider: 'chatgpt',
    model: 'gpt-5.6-luna',
    max_turns: 12,
    auto_review: true,
    delivery_mode: 'report_only',
    action_key: 'approved-proposal-report',
  };
}

function approvedImplementation(proposal, root = ROOT) {
  const implementation = proposal?.implementation;
  if (implementation && typeof implementation === 'object' && Object.keys(implementation).length)
    return implementation;
  return approvedReportOnlyImplementation(proposal, root);
}

function normalizeApprovedImplementation(proposal, root = ROOT) {
  const implementation = approvedImplementation(proposal, root);
  if (!implementation || typeof implementation !== 'object') return {};
  const normalized = { ...implementation };
  if (!normalized.site) {
    const site = proposalSite(proposal, root);
    if (site) normalized.site = site;
  }
  const category = String(normalized.category || '')
    .trim()
    .toLowerCase();
  if (!changequeue.CATEGORIES.includes(category)) normalized.category = 'other';
  const assignedRole = String(normalized.assigned_role || '')
    .trim()
    .toLowerCase();
  if (!['engineer', 'principal-engineer'].includes(assignedRole))
    normalized.assigned_role = reportOnlyRole(normalized.category, normalized.site, root);
  if (normalized.priority === 'normal') normalized.priority = 'medium';
  if (!normalized.provider) normalized.provider = 'chatgpt';
  if (normalized.provider === 'chatgpt' && !normalized.model) normalized.model = 'gpt-5.6-luna';
  return normalized;
}

function implementationBlockers(proposal, implementation) {
  const blockers = [];
  const launchGate = String(implementation.launch_gate || '').toLowerCase();
  const securityGate = String(implementation.security_gate || '').toLowerCase();
  const legalStatus = String(implementation.legal_review?.status || '').toLowerCase();
  const securityStatus = String(implementation.security_review?.status || '').toLowerCase();
  if (launchGate === 'go_live') {
    if (legalStatus !== 'approved' || implementation.legal_review?.reviewed_by !== 'legal')
      blockers.push('approved Legal go-live review is missing');
    if (securityStatus !== 'approved' || implementation.security_review?.reviewed_by !== 'security')
      blockers.push('approved Security go-live review is missing');
  }
  if (securityGate === 'required' && securityStatus !== 'approved')
    blockers.push('approved Security review is missing');
  if (['needs_owner', 'blocked', 'counsel_required', 'evidence_needed'].includes(legalStatus))
    blockers.push(`Legal status is ${legalStatus}`);
  if (['needs_owner', 'blocked', 'evidence_needed'].includes(securityStatus))
    blockers.push(`Security status is ${securityStatus}`);
  return [...new Set(blockers)];
}

function followThroughWorkPayload(proposal, implementation, { status, nextAction, blockers }) {
  const source = proposal.proposal_id;
  const implementationReady = Boolean(
    implementation.site && implementation.title && implementation.body
  );
  const evidence = [
    {
      label: 'approved proposal',
      note: `${source} approved by ${proposal.decided_by || 'owner'} on ${proposal.decided_at || proposal.updated_at || proposal.created_at}`,
    },
    {
      label: 'execution readiness',
      note: implementationReady
        ? 'Implementation fields are present; queue routing is gated by current site capacity and review evidence.'
        : 'Implementation fields are incomplete; no engineer request can be created safely.',
    },
  ];
  if (blockers.length) evidence.push({ label: 'blockers', note: blockers.join('; ') });
  return {
    work_id: `${FOLLOW_THROUGH_WORK_PREFIX}${source}`,
    title: `Follow through: ${proposal.title}`,
    kind: implementationReady ? 'implementation' : followThroughKind(proposal.proposal_type),
    status,
    priority: 'normal',
    owner: followThroughOwner(proposal.created_by),
    source_type: 'approved-proposal',
    source_id: source,
    site: implementation.site || null,
    summary: proposal.summary,
    next_action: nextAction,
    evidence,
    created_by: 'system',
  };
}

function sameFollowThroughFields(current, next) {
  return [
    'title',
    'kind',
    'status',
    'priority',
    'owner',
    'source_type',
    'source_id',
    'site',
    'summary',
    'next_action',
  ].some(key => String(current?.[key] ?? '') !== String(next?.[key] ?? ''));
}

function reconcileApprovedProposalFollowThrough(
  store,
  { root = ROOT, allowQueue = false, maxQueue = 0 } = {}
) {
  const result = [];
  const proposals = store
    .listExecutiveProposals({ status: 'approved', limit: 500 })
    .filter(
      proposal =>
        !EXECUTIVE_EXCLUDED_SITES.has(String(proposal.implementation?.site || '').toLowerCase())
    );
  const requests = store.listChangeRequests({ limit: 1000 });
  const requestsById = new Map(requests.map(request => [String(request.request_id), request]));
  const requestsByProposal = new Map();
  for (const request of requests) {
    if (!request.source_proposal_id) continue;
    const key = String(request.source_proposal_id);
    if (!requestsByProposal.has(key)) requestsByProposal.set(key, []);
    requestsByProposal.get(key).push(request);
  }
  const activeSites = new Set(
    requests
      .filter(row =>
        ['queued', 'claimed', 'running', 'reviewing', 'review', 'committed'].includes(row.status)
      )
      .map(row => String(row.site || '').toLowerCase())
      .filter(Boolean)
  );
  // A deployed or measuring improvement is no longer occupying the
  // implementation slot. It must continue measuring, but it should not block
  // a bounded read-only evidence/report request for the same site. Only work
  // that can still change the checkout belongs in this capacity set.
  for (const row of store.listImprovements({ limit: 1000 })) {
    if (['proposed', 'building', 'review'].includes(row.state))
      activeSites.add(String(row.site || '').toLowerCase());
  }
  let queued = 0;
  for (const proposal of proposals) {
    const workId = `${FOLLOW_THROUGH_WORK_PREFIX}${proposal.proposal_id}`;
    const existing = store.getExecutiveWorkItem(workId);
    const sourceRequests = requestsByProposal.get(String(proposal.proposal_id)) || [];
    const currentRequest =
      (proposal.linked_request_id && requestsById.get(String(proposal.linked_request_id))) ||
      sourceRequests[0] ||
      null;
    if (currentRequest && !proposal.linked_request_id && store.linkExecutiveProposalRequest) {
      store.linkExecutiveProposalRequest(proposal.proposal_id, currentRequest.request_id);
      const audit = executive.action(store, {
        actor: 'system',
        action_type: 'other',
        summary: `Relinked approved proposal to existing request: ${proposal.title}`,
        target_type: 'executive-proposal',
        target_id: proposal.proposal_id,
        request_id: currentRequest.request_id,
      });
      executive.finishAction(store, audit.action_id, {
        status: 'completed',
        result: { proposal_id: proposal.proposal_id, request_id: currentRequest.request_id },
      });
      result.push({
        type: 'relinked',
        proposal_id: proposal.proposal_id,
        request_id: currentRequest.request_id,
      });
    }
    const implementation = normalizeApprovedImplementation(proposal, root);
    const ready = Boolean(implementation.site && implementation.title && implementation.body);
    const blockers = implementationBlockers(proposal, implementation);
    const terminalRequest =
      currentRequest && ['failed', 'cancelled'].includes(currentRequest.status);
    if (currentRequest && !terminalRequest) {
      if (existing && !['done', 'cancelled'].includes(existing.status)) {
        const delivered = ['committed', 'deployed', 'verified'].includes(currentRequest.status);
        const payload = followThroughWorkPayload(proposal, implementation, {
          status: delivered ? 'done' : 'waiting',
          nextAction: delivered
            ? `No further follow-through is required; linked request ${currentRequest.request_id} is ${currentRequest.status}.`
            : `Monitor linked request ${currentRequest.request_id} while it is ${currentRequest.status}.`,
          blockers: [],
        });
        payload.resolution_note = delivered
          ? `Linked request ${currentRequest.request_id} reached ${currentRequest.status}.`
          : null;
        if (sameFollowThroughFields(existing, payload)) {
          store.updateExecutiveWorkItem(workId, payload);
          const audit = executive.action(store, {
            actor: 'system',
            action_type: 'other',
            summary: `Reconciled approved-proposal follow-through: ${proposal.title}`,
            target_type: 'executive-work-item',
            target_id: workId,
            proposal_id: proposal.proposal_id,
            request_id: currentRequest.request_id,
          });
          executive.finishAction(store, audit.action_id, {
            status: 'completed',
            result: {
              proposal_id: proposal.proposal_id,
              work_id: workId,
              request_id: currentRequest.request_id,
              status: payload.status,
            },
          });
          result.push({
            type: 'work-item-reconciled',
            proposal_id: proposal.proposal_id,
            work_id: workId,
            request_id: currentRequest.request_id,
            status: payload.status,
          });
        }
      }
      continue;
    }
    if (terminalRequest)
      blockers.push(`existing request is ${currentRequest.status}; automatic retry is disabled`);

    if (!currentRequest && ready && !blockers.length && allowQueue && queued < maxQueue) {
      const site = String(implementation.site || '').toLowerCase();
      if (!activeSites.has(site)) {
        try {
          const request = changequeue.create(
            store,
            {
              ...implementation,
              source: 'approved-proposal-followthrough',
              requested_by: proposal.created_by,
              source_proposal_id: proposal.proposal_id,
            },
            candidate => executiveTarget(root, candidate),
            candidate => installedSiteRoles(root, candidate)
          );
          store.linkExecutiveProposalRequest(proposal.proposal_id, request.request_id);
          const audit = executive.action(store, {
            actor: 'system',
            action_type: 'queue-work',
            summary: `Followed through approved proposal: ${proposal.title}`,
            target_type: 'executive-proposal',
            target_id: proposal.proposal_id,
            request_id: request.request_id,
          });
          executive.finishAction(store, audit.action_id, {
            status: 'completed',
            result: { proposal_id: proposal.proposal_id, request_id: request.request_id },
          });
          activeSites.add(site);
          queued += 1;
          result.push({
            type: 'queued',
            proposal_id: proposal.proposal_id,
            request_id: request.request_id,
            site,
          });
          continue;
        } catch (error) {
          blockers.push(`queue rejected: ${String(error.message || error).slice(0, 240)}`);
        }
      } else {
        blockers.push(`site already has active work: ${site}`);
      }
    }

    if (existing && ['done', 'cancelled'].includes(existing.status)) continue;
    const site = String(implementation.site || '').toLowerCase();
    let status = blockers.length ? 'blocked' : ready ? 'waiting' : 'open';
    let nextAction;
    if (blockers.length) {
      nextAction = `Resolve: ${[...new Set(blockers)].join('; ')}.`;
    } else if (!ready) {
      nextAction =
        'CEO/CTO must add a concrete site, task title, implementation body, acceptance criteria, and rollback, or decline this approved proposal.';
    } else if (!allowQueue) {
      nextAction =
        'Queue execution is disabled for this cycle; route the approved implementation on the next enabled cycle.';
    } else if (site && activeSites.has(site)) {
      nextAction = `Wait for existing work on ${site} to finish, then route this approved implementation.`;
    } else {
      nextAction = 'Route this approved implementation to the engineer queue.';
    }
    const payload = followThroughWorkPayload(proposal, implementation, {
      status,
      nextAction,
      blockers: [...new Set(blockers)],
    });
    if (!existing) {
      store.createExecutiveWorkItem(payload);
      const audit = executive.action(store, {
        actor: 'system',
        action_type: 'other',
        summary: `Created approved-proposal follow-through: ${proposal.title}`,
        target_type: 'executive-work-item',
        target_id: workId,
        proposal_id: proposal.proposal_id,
      });
      executive.finishAction(store, audit.action_id, {
        status: 'completed',
        result: { proposal_id: proposal.proposal_id, work_id: workId, status },
      });
      result.push({
        type: 'work-item-created',
        proposal_id: proposal.proposal_id,
        work_id: workId,
        status,
      });
    } else if (sameFollowThroughFields(existing, payload)) {
      store.updateExecutiveWorkItem(workId, payload);
      const audit = executive.action(store, {
        actor: 'system',
        action_type: 'other',
        summary: `Updated approved-proposal follow-through: ${proposal.title}`,
        target_type: 'executive-work-item',
        target_id: workId,
        proposal_id: proposal.proposal_id,
      });
      executive.finishAction(store, audit.action_id, {
        status: 'completed',
        result: { proposal_id: proposal.proposal_id, work_id: workId, status },
      });
      result.push({
        type: 'work-item-updated',
        proposal_id: proposal.proposal_id,
        work_id: workId,
        status,
      });
    }
  }
  return result;
}

// Approved work must not depend on a successful model pass to enter the
// worker queue. The scheduler uses this bounded, deterministic drain before
// invoking the model so already-approved report-only and implementation-ready
// proposals keep moving while preserving site-capacity and launch gates.
function drainApprovedProposalQueue(store, { root = ROOT, maxQueue = 6 } = {}) {
  const limit = Math.max(0, Math.min(12, Number(maxQueue) || 0));
  return reconcileApprovedProposalFollowThrough(store, {
    root,
    allowQueue: true,
    maxQueue: limit,
  });
}

// Keep deterministic diagnostics from consuming every queue slot. Approved
// implementation-ready proposals are the path from executive planning to
// measurable work, so reserve one slot even on a small queue and up to one
// third of a normal batch for them. The remaining capacity is shared by
// failure diagnosis and data-quality evidence.
function approvedWorkQueueBudgets(maxQueue = 6) {
  const total = Math.max(0, Math.min(12, Number(maxQueue) || 0));
  if (!total) return { total: 0, proposals: 0, failureDiagnostics: 0, dataQuality: 0 };
  const proposals = Math.min(total, Math.max(total >= 2 ? 1 : 0, Math.floor(total / 3)));
  const evidence = total - proposals;
  const failureDiagnostics = Math.min(2, Math.ceil(evidence / 2));
  return {
    total,
    proposals,
    failureDiagnostics,
    dataQuality: evidence - failureDiagnostics,
  };
}

function reportWorkRequestKey(prefix, workId) {
  return `${prefix}:${String(workId || '').trim()}`;
}

function activeRequestStatuses() {
  return new Set(['queued', 'claimed', 'running', 'reviewing', 'review', 'committed']);
}

function appendWorkEvidence(item, evidence) {
  return [...(Array.isArray(item?.evidence) ? item.evidence : []), evidence].slice(-20);
}

function markReportWorkItem(store, item, request, { completed = false, blocked = false } = {}) {
  if (!item || !request) return item;
  const status = completed ? 'done' : blocked ? 'blocked' : 'in_progress';
  return store.updateExecutiveWorkItem(item.work_id, {
    status,
    next_action: completed
      ? `Report request ${request.request_id} completed; use the artifact in the next executive review.`
      : blocked
        ? `Report request ${request.request_id} failed; inspect the durable failure evidence before another retry.`
        : `Monitor report request ${request.request_id}; it is currently ${request.status}.`,
    evidence: appendWorkEvidence(item, {
      label: completed ? 'report completed' : blocked ? 'report failed' : 'report request',
      note: `${request.request_id}; status=${request.status}; action_key=${request.action_key || 'none'}`,
    }),
    resolution_note: completed ? `Completed by report request ${request.request_id}.` : null,
  });
}

function queueBoundedReportWork(
  store,
  item,
  { root = ROOT, actionKey, title, body, requestedBy = 'cto', assignedRole = 'engineer' } = {}
) {
  if (!item?.site || item.site === 'fleet' || EXECUTIVE_EXCLUDED_SITES.has(item.site)) return null;
  const request = changequeue.create(
    store,
    {
      site: item.site,
      title,
      body,
      category: 'engineering',
      priority: 'low',
      assigned_role: assignedRole,
      requested_by: requestedBy,
      provider: 'chatgpt',
      model: 'gpt-5.6-luna',
      max_turns: 12,
      auto_review: true,
      delivery_mode: 'report_only',
      action_key: actionKey,
    },
    site => executiveTarget(root, site),
    site => installedSiteRoles(root, site)
  );
  markReportWorkItem(store, item, request);
  return request;
}

// Data-quality gaps are deterministic evidence, not executive ideas. Route a
// small bounded batch to the worker queue so a missing GA4/GSC/attribution
// source gets investigated without waiting for another model proposal. The
// worker can document public/configuration evidence, but cannot change
// credentials, external configuration, or production code through this path.
function drainDataQualityWork(store, { root = ROOT, maxQueue = 3 } = {}) {
  const limit = Math.max(0, Math.min(6, Number(maxQueue) || 0));
  const requests = store.listChangeRequests({ limit: 1000 });
  const activeSites = new Set(
    requests
      .filter(request => activeRequestStatuses().has(request.status))
      .map(request => String(request.site || '').toLowerCase())
      .filter(Boolean)
  );
  const items = store
    .listExecutiveWorkItems({ limit: 1000 })
    .filter(
      item =>
        item.source_type === 'data-quality' &&
        ['open', 'in_progress'].includes(item.status) &&
        item.site &&
        item.site !== 'fleet'
    );
  const result = [];
  let queued = 0;
  for (const item of items) {
    const actionKey = reportWorkRequestKey('data-quality', item.work_id);
    const existing = requests.find(request => request.action_key === actionKey);
    if (existing) {
      if (existing.status === 'verified')
        markReportWorkItem(store, item, existing, { completed: true });
      else if (existing.status === 'failed')
        markReportWorkItem(store, item, existing, { blocked: true });
      else markReportWorkItem(store, item, existing);
      continue;
    }
    if (queued >= limit || activeSites.has(String(item.site).toLowerCase())) continue;
    const audit = executive.action(store, {
      actor: 'cto',
      action_type: 'queue-work',
      summary: `Investigate data-quality gap: ${item.title}`,
      target_type: 'executive-work-item',
      target_id: item.work_id,
    });
    try {
      const request = queueBoundedReportWork(store, item, {
        root,
        actionKey,
        title: `Evidence report: ${item.title}`,
        body: [
          `Investigate the approved data-quality work item: ${item.title}.`,
          `Observed gap: ${item.summary}`,
          `Evidence and next action: ${item.next_action}`,
          'Scope: read-only inspection of the site checkout, public pages, fleet registry, and available dashboard evidence.',
          'Do not change credentials, external analytics configuration, schedules, spending, DNS, production code, or production data.',
          'Acceptance: write a timestamped report artifact separating observed facts, unavailable evidence, exact owner dependency, and the smallest reversible remediation. Include validation and rollback notes.',
        ].join('\n'),
      });
      if (!request) {
        executive.finishAction(store, audit.action_id, {
          status: 'skipped',
          result: { reason: 'unsupported scope' },
        });
        continue;
      }
      activeSites.add(String(item.site).toLowerCase());
      queued += 1;
      result.push({
        type: 'queued-data-quality',
        work_id: item.work_id,
        request_id: request.request_id,
      });
      executive.finishAction(store, audit.action_id, {
        status: 'completed',
        request_id: request.request_id,
        result: { work_id: item.work_id, request_id: request.request_id },
      });
    } catch (error) {
      executive.finishAction(store, audit.action_id, { status: 'failed', error: error.message });
      result.push({ type: 'data-quality-error', work_id: item.work_id, error: error.message });
    }
  }
  return result;
}

// Failed implementation requests remain terminal audit facts, but their
// repair cases should produce a bounded diagnosis rather than sit forever in
// an owner workbench column. This creates report-only work, never retries the
// unchanged implementation, and closes the repair case only after the report
// is verified.
function drainFailureDiagnostics(store, { root = ROOT, maxQueue = 3 } = {}) {
  const limit = Math.max(0, Math.min(6, Number(maxQueue) || 0));
  const requests = store.listChangeRequests({ limit: 1000 });
  const activeSites = new Set(
    requests
      .filter(request => activeRequestStatuses().has(request.status))
      .map(request => String(request.site || '').toLowerCase())
      .filter(Boolean)
  );
  const items = store
    .listExecutiveWorkItems({ limit: 1000 })
    .filter(
      item =>
        item.source_type === 'failed-change-request' &&
        ['open', 'in_progress'].includes(item.status) &&
        item.site &&
        item.site !== 'fleet'
    );
  const result = [];
  let queued = 0;
  for (const item of items) {
    const original = store.getChangeRequest(item.source_id);
    if (!original || original.status !== 'failed') continue;
    const actionKey = reportWorkRequestKey('failure-diagnosis', original.request_id);
    const existing = requests.find(request => request.action_key === actionKey);
    if (existing) {
      if (existing.status === 'verified')
        markReportWorkItem(store, item, existing, { completed: true });
      else if (existing.status === 'failed')
        markReportWorkItem(store, item, existing, { blocked: true });
      else markReportWorkItem(store, item, existing);
      continue;
    }
    if (queued >= limit || activeSites.has(String(item.site).toLowerCase())) continue;
    const audit = executive.action(store, {
      actor: 'cto',
      action_type: 'queue-work',
      summary: `Diagnose failed implementation: ${original.title}`,
      target_type: 'change-request',
      target_id: original.request_id,
      request_id: original.request_id,
    });
    try {
      const request = queueBoundedReportWork(store, item, {
        root,
        actionKey,
        title: `Failure diagnosis: ${original.title}`,
        body: [
          `Diagnose the failed implementation request ${original.request_id}: ${original.title}.`,
          `Original request: ${String(original.body || '').slice(0, 12000)}`,
          `Durable failure case: ${item.summary}`,
          `Required next action: ${item.next_action}`,
          'Do not retry or modify the original implementation, production checkout, credentials, schedules, or spending.',
          'Acceptance: produce a timestamped report identifying the failure class, exact evidence, whether the original task remains actionable, the smallest corrected task if applicable, validation gates, and rollback notes.',
        ].join('\n'),
      });
      if (!request) {
        executive.finishAction(store, audit.action_id, {
          status: 'skipped',
          result: { reason: 'unsupported scope' },
        });
        continue;
      }
      activeSites.add(String(item.site).toLowerCase());
      queued += 1;
      result.push({
        type: 'queued-failure-diagnosis',
        work_id: item.work_id,
        request_id: request.request_id,
      });
      executive.finishAction(store, audit.action_id, {
        status: 'completed',
        request_id: request.request_id,
        result: { work_id: item.work_id, request_id: request.request_id },
      });
    } catch (error) {
      executive.finishAction(store, audit.action_id, { status: 'failed', error: error.message });
      result.push({ type: 'failure-diagnosis-error', work_id: item.work_id, error: error.message });
    }
  }
  return result;
}

// The provider is responsible for choosing the work, but a malformed or
// indecisive response must not turn an evidence-backed hourly cycle into a
// silent no-op. This fallback uses only candidates already present in the
// trusted brief and creates bounded, reversible queue work.
function buildActionMandateFallback(plan = {}, brief = {}) {
  const basePlan = {
    messages: [],
    proposal_reviews: [],
    data_requests: [],
    proposals: [],
    change_requests: [],
    research_requests: [],
    work_items: [],
    knowledge: [],
    ...plan,
  };
  const candidates = Array.isArray(brief.action_mandate?.candidates)
    ? brief.action_mandate.candidates
    : [];
  if (!candidates.length) return basePlan;

  const activeSites = new Set(
    [...(brief.queue || []), ...(brief.improvements || [])]
      .filter(item =>
        [
          'queued',
          'claimed',
          'running',
          'reviewing',
          'review',
          'committed',
          'building',
          'measuring',
        ].includes(String(item.status || item.state))
      )
      .map(item => String(item.site || '').toLowerCase())
      .filter(Boolean)
  );
  const plannedSites = new Set(
    basePlan.change_requests.map(item => String(item.site || '').toLowerCase())
  );
  const selected = [];
  for (const candidate of candidates) {
    const site = String(candidate.site || '')
      .trim()
      .toLowerCase();
    if (!site || site === 'fleet' || site === '3boobs.com' || activeSites.has(site)) continue;
    if (plannedSites.has(site)) continue;
    selected.push({ ...candidate, site });
    plannedSites.add(site);
    if (selected.length >= 6) break;
  }
  if (!selected.length) return basePlan;

  const change_requests = [
    ...basePlan.change_requests,
    ...selected.map(candidate => {
      const type = String(candidate.type || '').toLowerCase();
      const signal = `${candidate.title || ''} ${candidate.recommendation || ''} ${JSON.stringify(candidate.evidence || '')}`;
      const inferredCategory =
        type === 'engineering' &&
        /\b(?:type\s*[=:]\s*content|content task|content refresh)\b/i.test(signal)
          ? 'content'
          : type;
      const category = ['seo', 'engineering', 'content', 'design', 'marketing'].includes(
        inferredCategory
      )
        ? inferredCategory
        : 'engineering';
      // A baseline/evidence candidate must never enter the deployment path
      // just because intelligence classified its source as SEO or engineering.
      // The delivery mode is a safety boundary, so preserve the explicit
      // report-only intent from either the candidate type or its wording.
      const reportOnly =
        type === 'portfolio-baseline' ||
        isPrivateLaunchGate(candidate.site, brief.launch_readiness) ||
        /\b(?:baseline|read[- ]only|report[- ]only|no production changes?)\b/i.test(
          `${candidate.title || ''} ${candidate.recommendation || ''}`
        );
      const evidence = candidate.evidence
        ? JSON.stringify(candidate.evidence)
        : 'See the executive intelligence snapshot.';
      const metric = candidate.metric || 'site-specific attributable outcome';
      return {
        site: candidate.site,
        ...(typeof candidate.key === 'string' && candidate.key.trim()
          ? { action_key: candidate.key.trim() }
          : {}),
        title: candidate.title || `Bounded improvement for ${candidate.site}`,
        body: [
          `Evidence-backed candidate from the executive intelligence snapshot: ${evidence}`,
          `Recommendation: ${candidate.recommendation || 'Inspect the existing site report and select the smallest reversible improvement.'}`,
          `Primary metric: ${metric}. Record the baseline before changing anything and measure for 14 days or 100 new impressions.`,
          'Acceptance: preserve existing behavior outside the requested change, run focused tests and the site build, and record the exact files or report artifact produced.',
          'Rollback: revert only this bounded change if validation gates fail or the measured metric materially declines.',
        ].join('\n'),
        category,
        priority: 'low',
        assigned_role: 'engineer',
        requested_by: 'ceo',
        provider: 'chatgpt',
        model: 'gpt-5.6-luna',
        max_turns: 12,
        auto_review: true,
        ...(reportOnly ? { delivery_mode: 'report_only' } : {}),
      };
    }),
  ];
  const messages = [...basePlan.messages];
  if (!messages.some(message => /recommend(?:ation)?\s*:/i.test(String(message.body || '')))) {
    messages.push({
      actor: 'ceo',
      body: `Recommendation: execute the ${selected.length} highest-confidence reversible candidates already supported by the intelligence snapshot. The exact business result is not yet calculable; each task records a baseline, metric, and rollback so the next measurement gate can prove or reject it.`,
      message_type: 'update',
      metadata: { to: 'owner', source: 'action-mandate-fallback' },
    });
  }
  return { ...basePlan, change_requests, messages };
}

// Action candidates are generated by the trusted host from durable queue and
// telemetry state. Preserve their routing key when a provider omits it while
// restating the same candidate. Matching is deliberately exact on normalized
// site and title; no model-supplied key is invented or broadened here.
function attachKnownActionKeys(plan = {}, brief = {}) {
  const candidates = Array.isArray(brief.action_mandate?.candidates)
    ? brief.action_mandate.candidates
    : [];
  if (!candidates.length || !Array.isArray(plan.change_requests)) return plan;
  for (const request of plan.change_requests) {
    if (String(request.action_key || '').trim()) continue;
    const site = String(request.site || '')
      .trim()
      .toLowerCase();
    const title = normalizeActionTitle(request.title);
    if (!site || !title) continue;
    const matches = candidates.filter(candidate => {
      const key = String(candidate?.key || '').trim();
      return (
        key.startsWith('task-routing:') &&
        String(candidate?.site || '')
          .trim()
          .toLowerCase() === site &&
        normalizeActionTitle(candidate?.title) === title
      );
    });
    if (matches.length === 1) request.action_key = String(matches[0].key).trim();
  }
  return plan;
}

function isPrivateLaunchGate(site, launchReadiness = []) {
  const normalized = String(site || '')
    .trim()
    .toLowerCase();
  const checklist = (Array.isArray(launchReadiness) ? launchReadiness : []).find(
    item =>
      String(item?.site || '')
        .trim()
        .toLowerCase() === normalized
  );
  if (!checklist) return false;
  return (
    checklist.current_disposition === 'keep_private' ||
    checklist.authoritative_evidence?.disposition === 'blocked'
  );
}

function isTelemetryRequestProposal(item = {}) {
  if (item.implementation && Object.keys(item.implementation).length) return false;
  const text = `${item.title || ''} ${item.summary || ''} ${item.requested_action || ''}`;
  return /measurement|attribution|analytics|mobile performance|performance (?:bottleneck|diagnosis)|data[- ]feed|operational (?:health|diagnosis)|ai[- ]cost|ai usage|cancellation[- ]control|evidence (?:reporting|matrix)|reporting contract|read-only (?:fleet )?evidence/i.test(
    text
  );
}

function proposalDedupeKey(item = {}) {
  const implementation =
    item.implementation && typeof item.implementation === 'object' ? item.implementation : {};
  return [
    item.proposal_type || 'business',
    item.created_by || 'ceo',
    item.title || '',
    implementation.site || '',
    implementation.action_key || '',
  ]
    .map(value => String(value).trim().toLowerCase().replace(/\s+/g, ' '))
    .join('|');
}

function openProposalDuplicate(store, item) {
  const key = proposalDedupeKey(item);
  return store
    .listExecutiveProposals({ limit: 500 })
    .find(
      existing =>
        ['proposed', 'feedback'].includes(existing.status) && proposalDedupeKey(existing) === key
    );
}

function proposalCreationBudget(store, { normal = 6, backlogThreshold = 10, backlog = 2 } = {}) {
  const proposals = store?.listExecutiveProposals({ status: 'approved', limit: 1000 }) || [];
  const requests = store?.listChangeRequests({ limit: 1000 }) || [];
  const executed = new Set(
    requests
      .filter(request => request.source_proposal_id)
      .map(request => String(request.source_proposal_id))
  );
  const unexecuted = proposals.filter(proposal => !executed.has(String(proposal.proposal_id)));
  return {
    limit: unexecuted.length >= backlogThreshold ? backlog : normal,
    approved_unexecuted: unexecuted.length,
  };
}

function runProvider(
  prompt,
  {
    provider = process.env.EXECUTIVE_PROVIDER || 'claude',
    model = process.env.EXECUTIVE_MODEL || '',
    command = process.env.EXECUTIVE_COMMAND,
  } = {}
) {
  const executable = command || (provider === 'chatgpt' ? 'codex' : 'claude');
  const promptOnStdin = provider === 'chatgpt';
  const args =
    provider === 'chatgpt'
      ? [
          'exec',
          '--skip-git-repo-check',
          '--ephemeral',
          '--ignore-user-config',
          '--sandbox',
          'read-only',
          ...(model ? ['--model', model] : []),
          '-',
        ]
      : [
          '--print',
          '--permission-mode',
          'plan',
          '--permission-prompts',
          'none',
          '--allowedTools',
          'Read,Glob,Grep',
          '--no-session-persistence',
          ...(model ? ['--model', model] : []),
          prompt,
        ];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: ROOT,
      env: process.env,
      stdio: [promptOnStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (promptOnStdin) child.stdin.end(prompt);
    let stdout = '',
      stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    const timer = setTimeout(
      () => child.kill('SIGTERM'),
      Number(process.env.EXECUTIVE_TIMEOUT_MS || 15 * 60 * 1000)
    );
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(new Error(`${provider} exited with code ${code}: ${stderr.slice(-500)}`));
      resolve(stdout);
    });
  });
}

async function applyPlan(store, plan, { allowQueue = false, root = ROOT } = {}) {
  validatePlan(plan);
  const created = {
    messages: [],
    proposal_reviews: [],
    data_requests: [],
    proposals: [],
    change_requests: [],
    work_items: [],
    knowledge: [],
    skipped_change_requests: [],
    skipped_proposals: [],
    research: [],
    telemetry_satisfied: [],
    follow_through: [],
  };
  for (const item of plan.work_items) {
    const existing = item.work_id ? store.getExecutiveWorkItem(item.work_id) : null;
    const payload = {
      ...item,
      created_by: item.created_by || 'system',
      source_type: item.source_type || 'executive-tick',
    };
    const workItem = existing
      ? store.updateExecutiveWorkItem(existing.work_id, payload)
      : store.createExecutiveWorkItem(payload);
    created.work_items.push(workItem);
    const audit = executive.action(store, {
      actor: payload.created_by,
      action_type: 'other',
      summary: `${existing ? 'Updated' : 'Created'} workbench item: ${workItem.title}`,
      target_type: 'executive-work-item',
      target_id: workItem.work_id,
    });
    executive.finishAction(store, audit.action_id, {
      status: 'completed',
      result: { work_id: workItem.work_id, status: workItem.status },
    });
  }
  for (const item of plan.knowledge) {
    const existing = item.knowledge_id
      ? store
          .listExecutiveKnowledge({ limit: 1000 })
          .find(row => row.knowledge_id === item.knowledge_id)
      : null;
    const knowledge = existing
      ? store.updateExecutiveKnowledge(existing.knowledge_id, item)
      : store.createExecutiveKnowledge({ ...item, created_by: item.created_by || 'system' });
    created.knowledge.push(knowledge);
  }
  if (plan.data_requests.length) {
    const audit = executive.action(store, {
      actor: 'system',
      action_type: 'research',
      summary: `Fulfill ${plan.data_requests.length} read-only telemetry requests`,
    });
    try {
      created.data_requests = [];
      for (const request of plan.data_requests)
        created.data_requests.push(
          await executiveData.fulfill({
            store,
            root,
            request,
            managedSites: executiveSites(root),
          })
        );
      executive.finishAction(store, audit.action_id, {
        status: 'completed',
        result: { requests: created.data_requests },
      });
    } catch (error) {
      executive.finishAction(store, audit.action_id, { status: 'failed', error: error.message });
      throw error;
    }
  }
  if (plan.research_requests.length) {
    const audit = executive.action(store, {
      actor: 'ceo',
      action_type: 'research',
      summary: `Run ${plan.research_requests.length} bounded research requests`,
    });
    try {
      created.research = await research.run(root, plan.research_requests);
      executive.finishAction(store, audit.action_id, {
        status: 'completed',
        result: {
          results: created.research.map(r => ({ url: r.url, status: r.status, id: r.id || null })),
        },
      });
    } catch (error) {
      executive.finishAction(store, audit.action_id, { status: 'failed', error: error.message });
      throw error;
    }
  }
  for (const item of plan.messages) {
    const audit = executive.action(store, {
      actor: item.actor,
      action_type: 'message',
      summary: item.body.slice(0, 200),
    });
    try {
      const message = executive.message(store, item);
      created.messages.push(message);
      executive.finishAction(store, audit.action_id, {
        status: 'completed',
        result: { message_id: message.message_id },
      });
    } catch (error) {
      executive.finishAction(store, audit.action_id, { status: 'failed', error: error.message });
      throw error;
    }
  }
  for (const item of plan.proposal_reviews) {
    const current = store.getExecutiveProposal(item.proposal_id);
    // A stale CRO handoff can remain in a generated plan after another
    // process reviewed it. Treat that as an idempotent no-op rather than
    // failing the whole executive tick.
    if (!current || !['researcher', 'cro'].includes(current.created_by)) continue;
    if (!['proposed', 'feedback'].includes(current.status)) continue;
    const mappedStatus =
      item.status === 'declined'
        ? 'declined'
        : item.status === 'escalate_owner'
          ? 'feedback'
          : 'reviewed';
    const reviewed = executive.review(store, item.proposal_id, {
      status: mappedStatus,
      decision_note: item.decision_note,
      reviewed_by: item.reviewed_by,
    });
    created.proposal_reviews.push(reviewed);
  }
  const proposalBudget = proposalCreationBudget(store);
  let createdProposalCount = 0;
  for (const item of plan.proposals) {
    if (isTelemetryRequestProposal(item)) {
      const audit = executive.action(store, {
        actor: item.created_by || 'ceo',
        action_type: 'observe',
        summary: `Telemetry request satisfied from executive intelligence: ${item.title}`,
        target_type: 'executive-proposal',
      });
      created.telemetry_satisfied.push({
        title: item.title,
        reason: 'scheduled_read_only_telemetry',
      });
      executive.finishAction(store, audit.action_id, {
        status: 'completed',
        result: {
          title: item.title,
          reason: 'scheduled_read_only_telemetry',
          sources: [
            'executive-intelligence-snapshot',
            'domain-manager-reports',
            'fleet-manager-control-plane',
          ],
        },
      });
      continue;
    }
    const duplicate = openProposalDuplicate(store, item);
    if (duplicate) {
      created.skipped_proposals.push({
        title: item.title,
        duplicate_of: duplicate.proposal_id,
        reason: 'an open proposal with the same role, type, title, site, and action already exists',
      });
      const dedupeAudit = executive.action(store, {
        actor: item.created_by || 'ceo',
        action_type: 'observe',
        summary: `Deduplicated open executive proposal: ${item.title}`,
        target_type: 'executive-proposal',
        target_id: duplicate.proposal_id,
      });
      executive.finishAction(store, dedupeAudit.action_id, {
        status: 'skipped',
        result: created.skipped_proposals.at(-1),
      });
      continue;
    }
    if (createdProposalCount >= proposalBudget.limit) {
      const skipped = {
        title: item.title,
        reason: 'approved execution backlog is above the proposal budget',
        approved_unexecuted: proposalBudget.approved_unexecuted,
        budget: proposalBudget.limit,
      };
      created.skipped_proposals.push(skipped);
      const budgetAudit = executive.action(store, {
        actor: item.created_by || 'ceo',
        action_type: 'observe',
        summary: `Deferred new proposal until approved work drains: ${item.title}`,
        target_type: 'executive-proposal',
      });
      executive.finishAction(store, budgetAudit.action_id, { status: 'skipped', result: skipped });
      continue;
    }
    const audit = executive.action(store, {
      actor: item.created_by || 'ceo',
      action_type: 'propose',
      summary: item.title,
    });
    try {
      // Provider-supplied IDs are not trusted: a model may reuse a slug across
      // recurring runs. The control plane owns durable identifiers so retries
      // cannot collide with an earlier proposal.
      const proposal = executive.proposal(store, {
        ...item,
        proposal_id: undefined,
        created_at: undefined,
      });
      created.proposals.push(proposal);
      createdProposalCount += 1;
      executive.finishAction(store, audit.action_id, {
        status: 'completed',
        result: { proposal_id: proposal.proposal_id },
      });
    } catch (error) {
      executive.finishAction(store, audit.action_id, { status: 'failed', error: error.message });
      throw error;
    }
  }
  if (allowQueue) {
    const activeSites = new Set(
      store
        .listChangeRequests({ limit: 1000 })
        .filter(row =>
          ['queued', 'claimed', 'running', 'reviewing', 'review', 'committed'].includes(row.status)
        )
        .map(row => row.site)
    );
    for (const row of store.listImprovements({ limit: 1000 })) {
      if (['proposed', 'building', 'review'].includes(row.state)) activeSites.add(row.site);
    }
    const queueLimit = Math.max(
      1,
      Math.min(6, Number(process.env.EXECUTIVE_MAX_QUEUED_ACTIONS || 6))
    );
    let queuedCount = 0;
    for (const item of plan.change_requests) {
      if (!item.site || !item.title || !item.body)
        throw new Error('change request requires site, title and body');
      if (queuedCount >= queueLimit || activeSites.has(item.site)) {
        created.skipped_change_requests.push({
          site: item.site,
          title: item.title,
          reason:
            queuedCount >= queueLimit
              ? `per-tick queue limit reached (${queueLimit})`
              : 'site already has queued or active implementation work',
        });
        const skipped = executive.action(store, {
          actor: 'system',
          action_type: 'observe',
          summary: `Skipped duplicate or excess executive work: ${item.title}`,
          target_type: 'change-request',
        });
        executive.finishAction(store, skipped.action_id, {
          status: 'skipped',
          result: created.skipped_change_requests.at(-1),
        });
        continue;
      }
      const audit = executive.action(store, {
        actor:
          item.assigned_role === 'cto'
            ? 'cto'
            : item.assigned_role === 'cfo'
              ? 'cfo'
              : item.assigned_role === 'domain-manager'
                ? 'domain-manager'
                : item.assigned_role === 'legal'
                  ? 'legal'
                  : item.assigned_role === 'security'
                    ? 'security'
                    : 'ceo',
        action_type: 'queue-work',
        summary: item.title,
      });
      try {
        const request = changequeue.create(
          store,
          {
            ...item,
            source: 'executive-ceo',
            requested_by: item.requested_by || 'ceo',
          },
          site => executiveTarget(root, site),
          site => installedSiteRoles(root, site)
        );
        created.change_requests.push(request);
        queuedCount += 1;
        activeSites.add(item.site);
        executive.finishAction(store, audit.action_id, {
          status: 'completed',
          request_id: request.request_id,
          result: { request_id: request.request_id },
        });
      } catch (error) {
        executive.finishAction(store, audit.action_id, { status: 'failed', error: error.message });
        throw error;
      }
    }
  }
  created.follow_through = reconcileApprovedProposalFollowThrough(store, {
    root,
    allowQueue,
    maxQueue: allowQueue
      ? Math.max(
          0,
          Math.min(6, Number(process.env.EXECUTIVE_MAX_QUEUED_ACTIONS || 6)) -
            created.change_requests.length
        )
      : 0,
  });
  handoff.writePlan(root, plan, created);
  return created;
}

async function tick({ root = ROOT, apply = false, allowQueue = false, providerOptions = {} } = {}) {
  const store = eventstore.open(root);
  const tickAction = executive.action(store, {
    actor: 'system',
    action_type: 'tick',
    summary: `Executive tick using ${providerOptions.provider || process.env.EXECUTIVE_PROVIDER || 'claude'}`,
  });
  try {
    const brief = await buildBrief(store, root);
    const prompt = buildPrompt(brief);
    const output = await runProvider(prompt, providerOptions);
    const plan = parseOutput(output);
    const created = apply ? await applyPlan(store, plan, { allowQueue, root }) : null;
    store.record({
      event_type: 'executive.tick',
      source: 'executive-runner',
      entity_type: 'executive',
      entity_id: 'fleet',
      payload: {
        apply,
        allowQueue,
        counts: Object.fromEntries(Object.entries(plan).map(([key, value]) => [key, value.length])),
      },
    });
    executive.finishAction(store, tickAction.action_id, {
      status: 'completed',
      result: {
        apply,
        allowQueue,
        counts: Object.fromEntries(Object.entries(plan).map(([key, value]) => [key, value.length])),
        ...(created
          ? {
              created_counts: Object.fromEntries(
                Object.entries(created).map(([key, value]) => [
                  key,
                  Array.isArray(value) ? value.length : 0,
                ])
              ),
            }
          : {}),
      },
    });
    return { brief, plan, created };
  } catch (error) {
    executive.finishAction(store, tickAction.action_id, { status: 'failed', error: error.message });
    throw error;
  } finally {
    store.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const allowQueue = argv.includes('--allow-queue');
  const planFileIndex = argv.indexOf('--apply-plan-file');
  if (planFileIndex !== -1) {
    const store = eventstore.open(ROOT);
    const plan = JSON.parse(fs.readFileSync(argv[planFileIndex + 1], 'utf8'));
    validatePlan(plan);
    const fingerprint = planFingerprint(plan);
    if (!apply) {
      process.stdout.write(JSON.stringify({ apply: false, plan }, null, 2) + '\n');
      return;
    }
    const previous = store
      .listExecutiveActions({ action_type: 'tick', limit: 1000 })
      .find(item => item.status === 'completed' && item.result?.plan_fingerprint === fingerprint);
    const tickAction = executive.action(store, {
      actor: 'system',
      action_type: 'tick',
      summary: previous ? 'Duplicate executive plan skipped' : 'Executive sandbox tick',
    });
    try {
      if (previous) {
        executive.finishAction(store, tickAction.action_id, {
          status: 'skipped',
          result: { duplicate_of: previous.action_id, plan_fingerprint: fingerprint },
        });
        process.stdout.write(
          JSON.stringify({ apply: false, duplicate: true, duplicate_of: previous.action_id }) + '\n'
        );
        return;
      }
      const created = await applyPlan(store, plan, { allowQueue, root: ROOT });
      const createdCounts = Object.fromEntries(
        Object.entries(created).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.length : 0,
        ])
      );
      executive.finishAction(store, tickAction.action_id, {
        status: 'completed',
        result: {
          apply: true,
          allowQueue,
          plan_fingerprint: fingerprint,
          counts: Object.fromEntries(
            Object.entries(plan).map(([key, value]) => [key, value.length])
          ),
          created_counts: createdCounts,
        },
      });
      process.stdout.write(
        JSON.stringify({ apply: true, allowQueue, plan, created }, null, 2) + '\n'
      );
    } catch (error) {
      executive.finishAction(store, tickAction.action_id, {
        status: 'failed',
        error: error.message,
      });
      throw error;
    } finally {
      store.close();
    }
    return;
  }
  if (argv.includes('--brief-only')) {
    const store = eventstore.open(ROOT);
    try {
      process.stdout.write(JSON.stringify(await buildBrief(store, ROOT), null, 2) + '\n');
    } finally {
      store.close();
    }
    return;
  }
  const result = await tick({ apply, allowQueue });
  process.stdout.write(
    JSON.stringify({ apply, allowQueue, plan: result.plan, created: result.created }, null, 2) +
      '\n'
  );
}

if (require.main === module)
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });

module.exports = {
  discoverSites,
  executiveSites,
  executiveTarget,
  buildSiteContext,
  buildDomainManagerContext,
  actionCandidates,
  buildActionMandateFallback,
  attachKnownActionKeys,
  proposalSite,
  approvedImplementation,
  normalizeApprovedImplementation,
  buildBrief,
  buildPrompt,
  buildPassPrompt,
  compactModelBrief,
  parseOutput,
  isTelemetryRequestProposal,
  normalizeProviderProposalTypes,
  validatePlan,
  planFingerprint,
  actionMandateSatisfied,
  reconcileApprovedProposalFollowThrough,
  drainApprovedProposalQueue,
  approvedWorkQueueBudgets,
  drainDataQualityWork,
  drainFailureDiagnostics,
  applyPlan,
  runProvider,
  tick,
};
