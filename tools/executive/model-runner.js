'use strict';

const fs = require('node:fs');
const runner = require('./runner');

let activeRun = null;

function estimateTokens(value) {
  return Math.ceil(Buffer.byteLength(String(value || ''), 'utf8') / 4);
}

function createUsageLedger() {
  return {
    provider: process.env.EXECUTIVE_PROVIDER || 'chatgpt',
    model: process.env.EXECUTIVE_MODEL || null,
    actual_usage_reported: false,
    billing_basis: 'provider subscription or external provider ledger',
    estimation_method: 'ceil(UTF-8 bytes / 4); directional only',
    calls: [],
    estimated_input_tokens: 0,
    estimated_output_tokens: 0,
    estimated_total_tokens: 0,
  };
}

async function runTracked(prompt, usage, role, repair = false) {
  const started = Date.now();
  const inputTokens = estimateTokens(prompt);
  try {
    const output = await runner.runProvider(prompt);
    const outputTokens = estimateTokens(output);
    usage.calls.push({
      role,
      repair,
      duration_ms: Date.now() - started,
      estimated_input_tokens: inputTokens,
      estimated_output_tokens: outputTokens,
      estimated_total_tokens: inputTokens + outputTokens,
      status: 'completed',
    });
    usage.estimated_input_tokens += inputTokens;
    usage.estimated_output_tokens += outputTokens;
    usage.estimated_total_tokens += inputTokens + outputTokens;
    return output;
  } catch (error) {
    usage.calls.push({
      role,
      repair,
      duration_ms: Date.now() - started,
      estimated_input_tokens: inputTokens,
      estimated_output_tokens: 0,
      estimated_total_tokens: inputTokens,
      status: 'failed',
      error: String(error.message || error),
    });
    usage.estimated_input_tokens += inputTokens;
    usage.estimated_total_tokens += inputTokens;
    throw error;
  }
}

function mergePassPlans(previous, next) {
  if (!previous) return next;
  const seen = new Set();
  const messages = [...(previous.messages || []), ...(next.messages || [])]
    .filter(message => {
      const key = JSON.stringify([message.actor, message.body]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-20);
  // Review passes commonly return only the fields they changed. Treating an
  // omitted/empty array as an instruction to erase the prior pass silently
  // converted good CEO decisions into observation-only cycles. Preserve
  // earlier durable work unless a later pass supplies a replacement list.
  const preserveWhenEmpty = [
    'proposal_reviews',
    'data_requests',
    'proposals',
    'change_requests',
    'research_requests',
    'work_items',
    'knowledge',
  ];
  const merged = { ...next, messages };
  for (const key of preserveWhenEmpty) {
    if ((!Array.isArray(next[key]) || next[key].length === 0) && Array.isArray(previous[key]))
      merged[key] = previous[key];
  }
  return merged;
}

async function main() {
  const brief = JSON.parse(fs.readFileSync('/input/brief.json', 'utf8'));
  const requestedPasses = String(process.env.EXECUTIVE_PASSES || 'adaptive')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
  if (
    !requestedPasses.length ||
    requestedPasses.some(
      x =>
        ![
          'adaptive',
          'ceo',
          'cro',
          'cto',
          'cfo',
          'legal',
          'security',
          'domain-manager',
          'reviewer',
        ].includes(x)
    )
  )
    throw new Error(
      'EXECUTIVE_PASSES must contain adaptive or ceo, cro, cto, cfo, legal, security, domain-manager, reviewer'
    );
  const passes = requestedPasses[0] === 'adaptive' ? ['ceo'] : requestedPasses;
  const passTimeout = Number(process.env.EXECUTIVE_PASS_TIMEOUT_MS || 5 * 60 * 1000);
  if (!Number.isInteger(passTimeout) || passTimeout < 10_000 || passTimeout > 15 * 60 * 1000)
    throw new Error('EXECUTIVE_PASS_TIMEOUT_MS must be 10000-900000');
  process.env.EXECUTIVE_TIMEOUT_MS = String(passTimeout);
  let plan = null;
  const audit = [];
  const usage = createUsageLedger();
  let finalized = false;
  // Preserve partial cost/pass evidence when a provider response fails
  // validation. The sandbox may not produce a plan, but it must still export
  // the calls already made so failures cannot disappear from the audit ledger.
  activeRun = { audit, usage, failure: null };
  process.on('exit', () => {
    if (finalized) return;
    try {
      fs.writeFileSync(
        '/output/passes.json',
        JSON.stringify(
          { passes: audit, incomplete: true, failure: activeRun?.failure || null },
          null,
          2
        ),
        { mode: 0o600 }
      );
      fs.writeFileSync('/output/usage.json', JSON.stringify(usage, null, 2), { mode: 0o600 });
      if (activeRun?.failure) {
        fs.writeFileSync(
          '/output/failure.json',
          JSON.stringify(
            {
              error: activeRun.failure,
              passes_completed: audit,
              usage: {
                calls: usage.calls.length,
                estimated_total_tokens: usage.estimated_total_tokens,
              },
            },
            null,
            2
          ),
          { mode: 0o600 }
        );
      }
    } catch {
      /* best effort during process shutdown */
    }
  });
  const proposalReviews = new Map();
  for (const role of passes) {
    const prompt = runner.buildPassPrompt(brief, role, plan);
    let output = await runTracked(prompt, usage, role);
    let repaired = false;
    try {
      const nextPlan = runner.parseOutput(output, {
        defaultActor: role,
        defaultSite: brief.domain_manager?.site || '',
      });
      plan = mergePassPlans(plan, nextPlan);
    } catch (error) {
      // Formatting failures never reach the trusted host application path.
      // Allow one bounded correction attempt, then fail closed.
      repaired = true;
      output = await runTracked(
        `${prompt}\n\nYour previous response failed validation (${error.message}). Correct that exact validation error and return the same plan again as strict JSON only. Messages may only use the role actors allowed by the contract; do not include owner or system, markdown, or commentary. Proposal reviews must use an existing proposal_id, reviewed_by ceo|cto|cfo|legal|security|domain-manager|reviewer, and status accepted_research|escalate_owner|declined. Proposals must include created_by, title, summary, and requested_action; created_by must be ceo|cto|cro|cfo|legal|security|domain-manager|researcher.`,
        usage,
        role,
        true
      );
      const nextPlan = runner.parseOutput(output, {
        defaultActor: role,
        defaultSite: brief.domain_manager?.site || '',
      });
      plan = mergePassPlans(plan, nextPlan);
    }
    audit.push({
      role,
      repaired,
      counts: Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.length])),
    });
    for (const review of plan.proposal_reviews || [])
      proposalReviews.set(review.proposal_id, review);
    if (requestedPasses[0] === 'adaptive' && role === 'ceo') {
      const hasWork = ['proposals', 'change_requests', 'research_requests'].some(
        key => plan[key]?.length
      );
      if (hasWork) passes.push('cfo', 'cto', 'legal', 'security', 'reviewer');
    }
  }
  // Do not silently turn a telemetry-rich cycle into an observation-only
  // no-op. Give the reviewer one bounded repair pass; if it still cannot
  // select or explicitly reject a candidate, fail closed before the trusted
  // host can apply the plan.
  if (!runner.actionMandateSatisfied(plan, brief)) {
    const repairPrompt = `${runner.buildPassPrompt(brief, 'reviewer', plan)}\n\nThe portfolio action mandate was not satisfied. Return the complete plan again and either (a) route a small batch of up to six highest-confidence, low-risk, reversible candidates to engineer across distinct sites, covering at least three sites when three or more candidates are available, with acceptance and rollback criteria, or (b) include one owner-facing message beginning with Recommendation: that gives a clear evidence-backed disposition and asks at most one concrete decision question when the brief has fewer than three actionable sites. Do not return an observation-only plan or a question without a recommendation.`;
    const repairedOutput = await runTracked(repairPrompt, usage, 'action-mandate-repair', true);
    plan = mergePassPlans(plan, runner.parseOutput(repairedOutput, { defaultActor: 'reviewer' }));
    for (const review of plan.proposal_reviews || [])
      proposalReviews.set(review.proposal_id, review);
    audit.push({
      role: 'action-mandate-repair',
      repaired: true,
      counts: Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.length])),
    });
    if (!runner.actionMandateSatisfied(plan, brief)) {
      // The trusted brief already contains the candidate sites and evidence.
      // Use the deterministic bounded fallback before spending another model
      // call trying to restate the same portfolio decision. The fallback is
      // still validated and queued through the normal host path.
      plan = runner.buildActionMandateFallback(plan, brief);
      audit.push({
        role: 'action-mandate-fallback',
        repaired: true,
        counts: Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.length])),
      });
    }
    if (!runner.actionMandateSatisfied(plan, brief)) {
      const finalRepairPrompt = `${runner.buildPassPrompt(brief, 'ceo', plan)}\n\nFINAL PORTFOLIO DECISION-MEMO REPAIR: The prior plan still failed the action mandate. Return the complete plan as strict JSON. Preserve the useful existing work, and include a concise CEO message whose body starts with Recommendation: and gives: (1) the action you recommend now, (2) at least one known number/date or an explicit statement that the number is not calculable and why, (3) the main unknown, (4) the smallest next step, and (5) at most one direct owner question with concrete options. When the brief has three or more actionable sites, also include bounded, reversible implementation or evidence work covering at least three distinct sites. Do not return a maintenance-only update or a question without a recommendation.`;
      const finalRepairOutput = await runTracked(
        finalRepairPrompt,
        usage,
        'decision-memo-repair',
        true
      );
      plan = mergePassPlans(plan, runner.parseOutput(finalRepairOutput, { defaultActor: 'ceo' }));
      audit.push({
        role: 'decision-memo-repair',
        repaired: true,
        counts: Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.length])),
      });
      if (!runner.actionMandateSatisfied(plan, brief)) {
        plan = runner.buildActionMandateFallback(plan, brief);
        audit.push({
          role: 'action-mandate-fallback',
          repaired: true,
          counts: Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.length])),
        });
      }
      if (!runner.actionMandateSatisfied(plan, brief))
        throw new Error('executive action mandate was not satisfied');
    }
  }
  // The host owns action keys. Restore a trusted task-routing key when a
  // provider restates the exact candidate without carrying that metadata.
  runner.attachKnownActionKeys(plan, brief);
  // Later review passes are allowed to revise an earlier conclusion, but a
  // pass that simply omits a CRO handoff must not reopen it for the owner.
  plan.proposal_reviews = [...proposalReviews.values()];
  fs.writeFileSync('/output/plan.json', JSON.stringify(plan, null, 2), { mode: 0o600 });
  fs.writeFileSync('/output/passes.json', JSON.stringify(audit, null, 2), { mode: 0o600 });
  fs.writeFileSync('/output/usage.json', JSON.stringify(usage, null, 2), { mode: 0o600 });
  finalized = true;
  process.stdout.write(JSON.stringify({ passes: audit, usage }) + '\n');
}

if (require.main === module) {
  main().catch(error => {
    if (activeRun) activeRun.failure = String(error.message || error);
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { mergePassPlans };
