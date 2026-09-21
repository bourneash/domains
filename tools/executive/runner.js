'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const eventstore = require('../fleet-dashboard/server/eventstore');
const executive = require('../fleet-dashboard/server/executive');
const changequeue = require('../fleet-dashboard/server/changequeue');
const research = require('./research');
const croResearch = require('./cro');
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

function executiveSites(root = ROOT) {
  return discoverSites(root).filter(site => !EXECUTIVE_EXCLUDED_SITES.has(site));
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

async function collectIntel(root, sites) {
  // Host-only import: the isolated model image loads runner.js for prompt and
  // plan validation, but it must not need dashboard telemetry modules.
  const executiveIntel = require('../fleet-dashboard/server/executive-intel');
  const intelligence = await executiveIntel.collect({ root, sites });
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
  };
}

async function buildBrief(store, root = ROOT) {
  const queued = store.listChangeRequests({ limit: 50 });
  const improvements = store.listImprovements({ limit: 50 });
  const proposals = store.listExecutiveProposals({ limit: 10 });
  const messages = store.listExecutiveMessages({ limit: 10 });
  const sites = executiveSites(root);
  const intel = await collectIntel(root, sites);
  return {
    generated_at: new Date().toISOString(),
    sites,
    site_context: buildSiteContext(root),
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
        'read_only_analytics_health_and_traffic',
        'read_only_seo_web_vitals_and_link_health',
        'read_only_revenue_and_affiliate_attribution',
        'read_only_ai_usage_and_costs',
        'read_only_social_account_coverage',
        'read_only_datahub_source_and_dataset_health',
        'read_only_operations_deploy_uptime_errors_and_fleet_doctor',
        'bounded_public_research',
      ],
      research_limits: {
        max_requests_per_tick: 10,
        max_response_bytes: 262144,
        timeout_ms: 8000,
        redirects: false,
      },
      execution:
        'Messages and proposals may be applied automatically; queued work requires explicit queue enablement or owner approval. Deployments, spending, credentials, domains, and destructive operations are never direct model actions.',
      delegation:
        'CEO, CTO, and independent reviewer passes run sequentially; later passes may reduce or reject the earlier plan.',
    },
    owner_strategy: store.getExecutiveSettings(),
    intelligence: intel,
    specialist_inputs: {
      cro_github_trends: croResearch.recent(root),
      cro_contract:
        'CRO trend signals are discovery leads, not proof of quality, license fit, security, revenue, or conversion impact. CEO/CTO must validate before implementation.',
    },
    queue: queued.map(({ request_id, site, title, category, priority, status, assigned_role }) => ({
      request_id,
      site,
      title,
      category,
      priority,
      status,
      assigned_role,
    })),
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
    conversation: messages
      .slice()
      .reverse()
      .map(({ actor, body, created_at }) => ({ actor, body, created_at })),
  };
}

function buildPrompt(brief) {
  return `You are the autonomous CEO and CTO of a domain portfolio. Your mission is attributable revenue growth and durable enterprise value. You are proactive: inspect the evidence, identify the next best actions, delegate research when useful, and do not wait for a human prompt. The owner remains principal and must approve material decisions.

Rules:
- Use only evidence present in the brief; label uncertainty and propose research when evidence is missing.
- Treat the owner_strategy as the operating contract. If it is empty, propose a concrete default strategy and ask for confirmation rather than inventing a budget or target.
- Rank opportunities by expected attributable revenue, confidence, contribution margin, time-to-learn, and reversibility. Report the source and measurement window for every quantitative claim. Treat low-volume or missing affiliate attribution as a background measurement gap—not a blocker to higher-impact work—unless the evidence shows material revenue at stake.
- Use intelligence.sources and intelligence.decision_support, including source freshness and errors, to create research proposals before making strong portfolio claims. Never interpret an unavailable source as a zero metric.
- Treat specialist_inputs.cro_github_trends as a lead feed from the CRO. Validate license, security, maintenance, fit, and measurable conversion/revenue upside before recommending adoption; never install or deploy a discovered repository directly.
- Manage every listed site except the explicitly excluded sites. 3boobs.com is out of scope entirely: do not analyze it, propose work for it, mention it in owner updates, or queue work for it.
- The managed properties are satire/meme sites. Never infer adult or NSFW classification from a domain name. Use the supplied site description/registry evidence and owner instructions; if evidence is incomplete, say so without inventing a classification.
- Prefer reversible, measurable actions with a clear expected upside and time-to-learn.
- You may recommend ethical technical/editorial SEO, experimentation, partnerships, outreach with consent, product work, and redesigns.
- Never propose cloaking, link spam, fake reviews, fake engagement, impersonation, credential abuse, platform evasion, or deceptive marketing.
- Do not deploy, spend money, change credentials, add domains, or make irreversible infrastructure changes.

Return ONLY valid JSON with this shape:
{
  "messages": [{"actor":"ceo|cto","body":"concise owner update"}],
  "research_requests": [{"url":"https://public.example/","question":"specific question to answer"}],
  "proposals": [{"created_by":"ceo|cto","title":"...","proposal_type":"business|growth|product|engineering|site-redesign|hiring|spend","summary":"...","rationale":"...","expected_upside":{"metric":"...","estimate":"...","source":"...","measurement_window":"..."},"risks":["..."],"requested_action":"...","implementation":{"site":"existing domain","title":"optional low-risk task","body":"optional implementation body","category":"engineering|content|marketing|sales|seo|design|other","priority":"medium|low","assigned_role":"...","provider":"claude|chatgpt","max_turns":20,"auto_review":true}}],
  "change_requests": [{"site":"existing domain","title":"...","body":"...","category":"engineering|content|marketing|sales|seo|design|other","priority":"high|medium|low","assigned_role":"...","provider":"claude|chatgpt","max_turns":20,"auto_review":true}]
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
      : 'You are the independent executive reviewer. Reject unsupported revenue claims, missing evidence, scope violations, unsafe tactics, high-priority queue work, and proposals that lack a measurable outcome. Keep only the smallest defensible plan and add a concise owner message explaining material concerns.';
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
  for (const key of ['messages', 'proposals', 'change_requests', 'research_requests'])
    if (result[key] !== undefined && !Array.isArray(result[key]))
      throw new Error(`${key} must be an array`);
  const plan = {
    messages: result.messages || [],
    proposals: result.proposals || [],
    change_requests: result.change_requests || [],
    research_requests: result.research_requests || [],
  };
  validatePlan(plan);
  return plan;
}

function validatePlan(plan) {
  if (
    plan.messages.length > 20 ||
    plan.proposals.length > 20 ||
    plan.change_requests.length > 20 ||
    plan.research_requests.length > 10
  )
    throw new Error('provider plan exceeds per-tick item limit');
  for (const item of plan.research_requests) {
    if (
      !String(item.url || '').trim() ||
      !String(item.question || '').trim() ||
      String(item.question).length > 500
    )
      throw new Error('invalid research request in provider plan');
    research.validateUrl(item.url);
  }
  for (const item of plan.messages) {
    if (
      !['ceo', 'cto'].includes(String(item.actor)) ||
      !String(item.body || '').trim() ||
      String(item.body).length > 10000
    )
      throw new Error('invalid executive message in provider plan');
    if (/3boobs(?:\.com)?/i.test(String(item.body)))
      throw new Error('executive plan references an excluded site');
  }
  for (const item of plan.proposals) {
    if (
      !['ceo', 'cto'].includes(String(item.created_by || 'ceo')) ||
      !String(item.title || '').trim() ||
      String(item.title).length > 300 ||
      !String(item.summary || '').trim() ||
      !String(item.requested_action || '').trim()
    )
      throw new Error('invalid executive proposal in provider plan');
    if (/3boobs(?:\.com)?/i.test(JSON.stringify(item)))
      throw new Error('executive plan references an excluded site');
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
  }
  return plan;
}

function planFingerprint(plan) {
  return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
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
  const created = { messages: [], proposals: [], change_requests: [], research: [] };
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
  for (const item of plan.proposals) {
    const audit = executive.action(store, {
      actor: item.created_by || 'ceo',
      action_type: 'propose',
      summary: item.title,
    });
    try {
      const proposal = executive.proposal(store, item);
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
  if (allowQueue) {
    for (const item of plan.change_requests) {
      if (!item.site || !item.title || !item.body)
        throw new Error('change request requires site, title and body');
      const audit = executive.action(store, {
        actor: item.assigned_role === 'cto' ? 'cto' : 'ceo',
        action_type: 'queue-work',
        summary: item.title,
      });
      try {
        const request = changequeue.create(store, { ...item, source: 'executive-ceo' }, site =>
          executiveSites(root).includes(site)
        );
        created.change_requests.push(request);
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
  buildSiteContext,
  buildBrief,
  buildPrompt,
  buildPassPrompt,
  parseOutput,
  validatePlan,
  planFingerprint,
  applyPlan,
  runProvider,
  tick,
};
