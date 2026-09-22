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

function actionCandidates(intelligence, sites) {
  const allowed = new Set(sites);
  const actions = intelligence?.decision_support?.seo?.actions;
  if (!Array.isArray(actions)) return [];
  return actions
    .filter(action => allowed.has(action.site) && action.filed !== true)
    .sort((a, b) => Number(b.rankScore || b.score || 0) - Number(a.rankScore || a.score || 0))
    .slice(0, 12)
    .map(action => ({
      site: action.site,
      key: action.key || null,
      title: action.title || 'Evidence-backed SEO opportunity',
      type: action.type || 'seo',
      evidence: action.evidence || null,
      score: action.rankScore || action.score || null,
      recommendation: action.recommendation || null,
      metric: action.metric || null,
    }));
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
  const cached = executiveSnapshot.readLatest(root, { sites });
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
      ? { generated_at: cached.generated_at, source: 'scheduled-cache' }
      : { generated_at: intelligence.generated_at || null, source: 'live-collection' },
  };
}

async function buildBrief(store, root = ROOT) {
  const queued = store.listChangeRequests({ limit: 50 });
  const improvements = store.listImprovements({ limit: 50 });
  const allProposals = store.listExecutiveProposals({ limit: 100 });
  const proposals = allProposals.slice(0, 10);
  const croProposals = allProposals
    .filter(item => ['researcher', 'cro'].includes(item.created_by))
    .filter(item => ['proposed', 'feedback'].includes(item.status))
    .slice(0, 10);
  const messages = store.listExecutiveMessages({ limit: 10 });
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
        'bounded_public_research',
        'cro_disposable_repo_lab',
        'allowlisted_fleet_operating_baseline_publish',
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
    action_mandate: {
      cadence: 'six_hour',
      minimum_evidence_backed_action: 1,
      maximum_queued_actions: 3,
      rule: 'When an evidence-backed, low-risk and reversible candidate exists, the CEO/CTO pass must either queue it for the engineer or explain why it was rejected. Do not let low-volume affiliate attribution create a no-op.',
      candidates: actionCandidates(intel.intelligence, sites),
    },
    intelligence: intel,
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
    conversation: messages
      .slice()
      .reverse()
      .map(({ actor, body, created_at }) => ({ actor, body, created_at })),
    handoffs: handoff.recent(root, 30),
    data_requests: executiveData.recent(store),
  };
}

function buildPrompt(brief) {
  return `You are the autonomous CEO of a domain portfolio working with a CTO, CRO, CFO, Legal/Compliance lead, and on-demand domain managers. Your mission is attributable revenue growth and durable enterprise value across the fleet. You are proactive: inspect the evidence, identify the next best actions, delegate research when useful, and do not wait for a human prompt. The owner remains principal and must approve material decisions.

Rules:
- Use only evidence present in the brief; label uncertainty and propose research when evidence is missing.
- Treat the owner_strategy as the operating contract. If it is empty, propose a concrete default strategy and ask for confirmation rather than inventing a budget or target.
- Challenge blockers instead of treating them as terminal. If a managed site is private, password protected, preview-only, parked, noindex/nofollow, or otherwise unable to earn, ask why, who owns the launch decision, whether it can monetize while gated, what must be true to go live, and what opportunity cost comes from remaining private. Create an owner-facing launch-readiness/go-live or monetization proposal, or a bounded research request, unless evidence supports keeping it parked. A blocked site is an unresolved business question, not a completed decision.
- Every cycle with an unblocked candidate, parked/scaffold opportunity, CRO lead, launch blocker, or material revenue question must contain either (a) one direct owner-facing question with concrete answer options and the evidence behind it, or (b) one measurable growth action/proposal with an owner, metric, baseline, time-to-learn, and rollback. A maintenance summary alone is not an acceptable CEO result.
- Lead with a recommendation, not a questionnaire. Every material owner update must state "Recommendation:", the decision or action you recommend now, the evidence and numbers supporting it, what is genuinely unknown or not calculable, and the smallest next step that resolves the uncertainty. Ask the owner only for the one decision that remains after giving that recommendation.
- Rank opportunities by expected attributable revenue, confidence, contribution margin, time-to-learn, and reversibility. Report the source and measurement window for every quantitative claim. Treat low-volume or missing affiliate attribution as a background measurement gap—not a blocker to higher-impact work—unless the evidence shows material revenue at stake.
- Follow action_mandate every six-hour cycle: when candidates are present, select at least one highest-confidence, low-risk, reversible improvement for the engineer queue or explain in a message why every candidate was rejected. Select no more than three queue actions and never duplicate a site that already has active work.
- Use intelligence.sources and intelligence.decision_support, including source freshness and errors, to create research proposals before making strong portfolio claims. Never interpret an unavailable source as a zero metric.
- Read the complete intelligence bundle before asking for data. Analytics, SEO, revenue, AI usage, operations, RevOps, experiments, campaigns, social, Data Hub, compliance scan history, data-quality boundaries, priorities, and registry data are read-only inputs collected automatically. If a source is unavailable, report the gap in your owner message and use the recurring snapshot/report path; do not create a duplicate data-request proposal.
- Treat specialist_inputs.cro_github_trends and specialist_inputs.cro_repo_lab_runs as lead evidence from the CRO. The repo lab is disposable and read-only; validate license, security, maintenance, fit, and measurable conversion/revenue upside before recommending adoption. Never install or deploy a discovered repository directly.
- Treat cro_proposals as CRO handoffs for CEO/CTO review, not owner approval requests. For each useful lead, either create a bounded public research request, create a separate owner-facing proposal with measurable acceptance criteria, or explain why no action is justified. Do not leave the lead waiting on the owner merely because it came from the CRO.
- Manage every listed site except the explicitly excluded sites. 3boobs.com is out of scope entirely: do not analyze it, propose work for it, mention it in owner updates, or queue work for it.
- Review portfolio_inventory when deciding where to invest. Parked/scaffold domains are owned inventory, not invisible sites: evaluate their audience fit, monetization potential, renewal cost, build effort, and opportunity cost. A new-domain/site launch always requires an owner proposal and approval before onboarding or production work.
- The managed properties are satire/meme sites. Never infer adult or NSFW classification from a domain name. Use the supplied site description/registry evidence and owner instructions; if evidence is incomplete, say so without inventing a classification.
- Prefer reversible, measurable actions with a clear expected upside and time-to-learn.
- Treat actionability as a hard operating signal: inspect the scorecard before proposing more ideas. If work is queued, finish it; if work is deployed, measure it; if work is proven, compare the actual metric delta with the expected upside. Do not count a proposal, message, or research result as a business improvement by itself.
- Use RevOps stages and lead scores for any lead or partnership opportunity; do not call traffic an opportunity until there is an intent, lead, affiliate, or revenue signal.
- Use the CFO lens for every material recommendation: contribution margin, attribution confidence, cost to learn, cash/spend exposure, and whether the expected upside is measurable. Never move money, change billing, access banking, sign contracts, or make tax/legal claims.
- Treat Legal/Compliance as a required launch and risk pass. Use the compliance baseline and history to identify privacy, consent, terms, disclosure, data-rights, claims, copyright/trademark, platform-policy, and age/regulated-content questions when supported by evidence. Legal performs risk triage, not legal advice or certification; escalate material uncertainty to the owner or counsel. Do not let incomplete telemetry block ordinary growth, but do not recommend a go-live proposal without a concrete legal review and launch checklist.
- Treat Security as a required production and supply-chain risk pass. Use intelligence.decision_support.security, operations, compliance, and data_quality to identify authentication, isolation, secrets, TLS, release, dependency, data exposure, and incident risks. Security performs read-only triage, not penetration testing or certification; never exploit a target or access credentials. Do not block ordinary growth for optional hardening alone, but do not recommend a go-live or security-sensitive change without a concrete Security review and rollback plan.
- Treat domain managers as recurring site specialists. Every managed site receives a lightweight review on the staggered queue; deeper work and implementation still require evidence, proposals, and the normal approval gates. The CEO owns portfolio prioritization and prevents one site from consuming disproportionate attention without evidence.
- Treat the Principal Engineer as the CTO's senior right hand. Route urgent technical investigations, incidents, architecture fixes, and emergency site work to assigned_role: principal-engineer; route ordinary bounded implementation to assigned_role: engineer. Include acceptance criteria, risk, tests, and rollback notes in every task.
- Use task_queue to avoid duplicating work. Review queued, active, review, and failed requests before creating another task. Domain managers should report task progress and surface blocked work back to fleet leadership.
- Use the experiment system for competing variants: state a hypothesis, primary metric, guardrails, sample threshold, and stop/ship decision. Do not recommend a winner before the sample threshold is met.
- You may recommend ethical technical/editorial SEO, experimentation, partnerships, outreach with consent, product work, and redesigns.
- Never propose cloaking, link spam, fake reviews, fake engagement, impersonation, credential abuse, platform evasion, or deceptive marketing.
- Do not deploy, spend money, change credentials, add domains, or make irreversible infrastructure changes. The one fleet write available to you is an allowlisted factual operating-baseline report; it never edits site code.

Return ONLY valid JSON with this shape:
{
  "messages": [{"actor":"ceo|cto|cfo|legal|security|domain-manager|reviewer","body":"concise owner update"}],
  "proposal_reviews": [{"proposal_id":"existing CRO/research proposal id","reviewed_by":"ceo|cto|cfo|legal|security|domain-manager|reviewer","status":"accepted_research|escalate_owner|declined","decision_note":"why this lead was accepted, escalated, or declined"}],
  "data_requests": [{"requested_by":"ceo|cto|cfo|legal|domain-manager","question":"specific missing read-only data question","sources":["analytics"],"sites":["existing domain"]}],
  "research_requests": [{"url":"https://public.example/","question":"specific question to answer"}],
  "proposals": [{"created_by":"ceo|cto|cfo|legal|security|domain-manager","title":"...","proposal_type":"business|growth|product|engineering|site-redesign|hiring|spend|report-only","summary":"...","rationale":"...","expected_upside":{"metric":"...","estimate":"...","source":"...","measurement_window":"..."},"risks":["..."],"requested_action":"...","implementation":{"site":"existing domain or fleet","launch_gate":"go_live when proposing production launch","legal_review":{"status":"approved","reviewed_by":"legal","decision_note":"evidence-backed risk disposition"},"security_review":{"status":"approved","reviewed_by":"security","decision_note":"evidence-backed risk disposition"},"action_key":"publish-fleet-operating-baseline when site is fleet","delivery_mode":"fleet_report for the fleet operation","title":"optional task","body":"implementation body with acceptance criteria and rollback","category":"engineering|content|marketing|sales|seo|design|other","priority":"high|medium|low","assigned_role":"engineer|principal-engineer","provider":"claude|chatgpt","max_turns":20,"auto_review":true}}],
  "change_requests": [{"site":"existing domain or fleet","action_key":"publish-fleet-operating-baseline when site is fleet","delivery_mode":"fleet_report for the fleet operation","title":"...","body":"...","category":"engineering|content|marketing|sales|seo|design|other","priority":"high|medium|low","assigned_role":"...","provider":"claude|chatgpt","max_turns":20,"auto_review":true}]
}

Only create a change_request for low-risk, reversible work that can safely enter the existing review queue. Its priority MUST be medium or low; never use high priority. Use proposals for everything material. Keep the response concise.

FLEET BRIEF:
${JSON.stringify(brief)}`;
}

function buildPassPrompt(brief, role, candidate = null) {
  if (role === 'ceo') return buildPrompt(brief);
  const base =
    role === 'cto'
      ? "You are the CTO review pass for an autonomous domain-fleet executive. Check technical feasibility, isolation, reversibility, implementation effort, measurement instrumentation, and whether the proposed work can safely enter the existing queue. Preserve the CEO's revenue intent while correcting unsafe or technically unsupported items."
      : role === 'cfo'
        ? 'You are the CFO review pass for an autonomous domain-fleet executive. Check attribution quality, contribution margin, cost-to-learn, AI and infrastructure spend, budget exposure, and whether revenue claims are supported. Lead with a financial recommendation, using known numbers and dates from the brief. If a number is not calculable, say exactly why and give the minimum measurement needed; do not merely ask the owner to decide without a recommendation. Push back on vanity metrics and unsupported forecasts. You may propose report-only finance work, but never move money, change billing, access banking, sign contracts, or make legal/tax claims. Every proposal you retain must set created_by to cfo.'
        : role === 'principal-engineer'
          ? 'You are the Principal Engineer review pass and the CTO’s senior implementation partner. Check urgent technical work, failure recovery, architecture risk, acceptance criteria, rollback, and test coverage. Route only bounded, evidence-backed implementation to assigned_role principal-engineer; never deploy directly. Every proposal you retain must set created_by to cto.'
          : role === 'legal'
            ? 'You are the Legal and Compliance review pass for the autonomous domain-fleet executive. Inspect compliance, data_quality, site, analytics, revenue, and launch evidence. Lead with a risk disposition and recommendation: clear, conditional, blocked, or counsel_required. State the specific evidence, concrete blockers, and the exact decision you recommend. This is risk triage, not legal advice or certification; never invent legal advice, and identify where human counsel is required. Triage privacy, consent, terms, cookie/analytics disclosure, affiliate disclosure, data provenance and rights, claims, copyright/trademark, platform policy, and regulated or age-sensitive concerns when supported by evidence. Do not block ordinary growth merely because telemetry is incomplete. For private or gated sites, require a concrete launch decision and checklist. Every proposal you retain must set created_by to legal. For a go-live proposal, include implementation.launch_gate="go_live" and implementation.legal_review with status approved or needs_owner, reviewed_by legal, and a concise decision_note only when supported by the evidence.'
            : role === 'security'
              ? 'You are the Security review pass for the autonomous domain-fleet executive. Inspect intelligence.decision_support.security, operations, compliance, and data_quality. Lead with a security disposition and recommendation: clear, conditional, blocked, or evidence_needed. State the concrete evidence, risk severity, and the exact decision you recommend. This is read-only risk triage, not penetration testing or certification; never exploit targets, access credentials, or claim a clean bill of health from missing data. Triage authentication and access boundaries, secrets exposure, container isolation, release/deploy controls, TLS, dependency and supply-chain risk, data exposure, incident signals, and security.txt or disclosure readiness when evidence supports it. Do not block ordinary growth for optional hardening alone. Every proposal you retain must set created_by to security. For a go-live or security-sensitive proposal, include implementation.security_review with status approved or needs_owner, reviewed_by security, and a concise evidence-backed decision_note.'
              : role === 'domain-manager'
                ? 'You are an on-demand domain manager for the managed site named in domain_manager. Focus on that site’s audience, content, analytics, monetization, health, and backlog. Return evidence-backed site proposals to fleet leadership; do not expand scope to other sites or directly deploy. Every proposal you retain must set created_by to domain-manager.'
                : 'You are the independent executive reviewer. Reject unsupported revenue claims, scope violations, unsafe tactics, high-priority queue work, and production proposals that lack a measurable outcome. Missing attribution or low-volume telemetry should block unsupported financial claims and production work, but should not force a no-op: preserve up to five bounded research_requests when each uses a public URL, answers a specific evidence gap, is read-only and reversible, does not duplicate the shared telemetry contract, and cannot change credentials, configuration, spending, schedules, or production. Keep only the smallest defensible plan and add a concise owner message explaining material concerns.';
  return `${base}\n\nReturn ONLY the same valid JSON plan shape required by the CEO. Do not mention or target 3boobs.com. Do not invent telemetry.\n\nFLEET BRIEF:\n${JSON.stringify(brief)}\n\nCANDIDATE PLAN TO REVIEW:\n${JSON.stringify(candidate || {})}`;
}

function parseOutput(text) {
  const raw = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (raw.length > 1024 * 1024) throw new Error('provider output exceeds 1 MiB');
  let result;
  try {
    result = JSON.parse(raw);
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
  };
  normalizeProviderProposalTypes(plan);
  validatePlan(plan);
  return plan;
}

function normalizeProviderProposalTypes(plan) {
  for (const item of plan.proposals) {
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
  for (const item of plan.proposal_reviews) {
    const raw = String(item?.status || '')
      .trim()
      .toLowerCase();
    const alias = {
      accepted: 'accepted_research',
      approved: 'accepted_research',
      reviewed: 'accepted_research',
      rejected: 'declined',
      denied: 'declined',
      feedback: 'escalate_owner',
      owner_review: 'escalate_owner',
    }[raw];
    if (alias) item.status = alias;
  }
  return plan;
}

function validatePlan(plan) {
  if (
    plan.messages.length > 20 ||
    plan.proposal_reviews.length > 20 ||
    plan.data_requests.length > 10 ||
    plan.proposals.length > 20 ||
    plan.change_requests.length > 20 ||
    plan.research_requests.length > 10
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
  for (const item of plan.proposal_reviews) {
    if (
      !String(item.proposal_id || '').trim() ||
      !['ceo', 'cto', 'cfo', 'legal', 'security', 'domain-manager', 'reviewer'].includes(
        String(item.reviewed_by || '')
      ) ||
      !['accepted_research', 'escalate_owner', 'declined'].includes(String(item.status || '')) ||
      String(item.decision_note || '').length > 2000
    )
      throw new Error('invalid proposal review in provider plan');
    if (/3boobs(?:\.com)?/i.test(JSON.stringify(item)))
      throw new Error('executive plan references an excluded site');
  }
  for (const item of plan.messages) {
    if (
      !['ceo', 'cto', 'cfo', 'legal', 'security', 'domain-manager', 'reviewer'].includes(
        String(item.actor)
      ) ||
      !String(item.body || '').trim() ||
      String(item.body).length > 10000
    )
      throw new Error('invalid executive message in provider plan');
    if (/3boobs(?:\.com)?/i.test(String(item.body)))
      throw new Error('executive plan references an excluded site');
  }
  for (const item of plan.proposals) {
    if (
      !['ceo', 'cto', 'cro', 'cfo', 'legal', 'security', 'domain-manager'].includes(
        String(item.created_by || 'ceo')
      ) ||
      !String(item.title || '').trim() ||
      String(item.title).length > 300 ||
      !String(item.summary || '').trim() ||
      !String(item.requested_action || '').trim()
    )
      throw new Error('invalid executive proposal in provider plan');
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
  }
  return plan;
}

function planFingerprint(plan) {
  return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

function actionMandateSatisfied(plan = {}, brief = {}) {
  if (!(brief.action_mandate?.candidates || []).length) return true;
  const hasBoundedWork =
    (plan.change_requests || []).length > 0 ||
    (plan.proposals || []).some(
      item => item.implementation && Object.keys(item.implementation).length
    );
  const hasRecommendation = (plan.messages || []).some(message =>
    /recommend(?:ation)?\s*:/i.test(String(message.body || ''))
  );
  if (hasBoundedWork && hasRecommendation) return true;
  return (
    (plan.messages || []).some(
      message =>
        /\?/.test(String(message.body || '')) &&
        /owner|choose|approve|decision|should|can we|which|whether/i.test(
          String(message.body || '')
        ) &&
        /recommend(?:ation)?\s*:/i.test(String(message.body || ''))
    ) && (brief.action_mandate?.candidates || []).length > 0
  );
}

function isTelemetryRequestProposal(item = {}) {
  if (item.implementation && Object.keys(item.implementation).length) return false;
  const text = `${item.title || ''} ${item.summary || ''} ${item.requested_action || ''}`;
  return /measurement|attribution|analytics|mobile performance|performance (?:bottleneck|diagnosis)|data[- ]feed|operational (?:health|diagnosis)|ai[- ]cost|ai usage|cancellation[- ]control|evidence (?:reporting|matrix)|reporting contract|read-only (?:fleet )?evidence/i.test(
    text
  );
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
    skipped_change_requests: [],
    research: [],
    telemetry_satisfied: [],
  };
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
      executive.finishAction(store, audit.action_id, {
        status: 'completed',
        result: { proposal_id: proposal.proposal_id },
      });
    } catch (error) {
      executive.finishAction(store, audit.action_id, { status: 'failed', error: error.message });
      throw error;
    }
  }
  handoff.writePlan(root, plan, created);
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
      Math.min(3, Number(process.env.EXECUTIVE_MAX_QUEUED_ACTIONS || 3))
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
        const request = changequeue.create(store, { ...item, source: 'executive-ceo' }, site =>
          executiveTarget(root, site)
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
      executive.finishAction(store, tickAction.action_id, {
        status: 'completed',
        result: {
          apply: true,
          allowQueue,
          plan_fingerprint: fingerprint,
          counts: Object.fromEntries(
            Object.entries(plan).map(([key, value]) => [key, value.length])
          ),
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
  buildBrief,
  buildPrompt,
  buildPassPrompt,
  parseOutput,
  isTelemetryRequestProposal,
  normalizeProviderProposalTypes,
  validatePlan,
  planFingerprint,
  actionMandateSatisfied,
  applyPlan,
  runProvider,
  tick,
};
