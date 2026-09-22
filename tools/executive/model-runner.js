'use strict';

const fs = require('node:fs');
const runner = require('./runner');

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
  return { ...next, messages };
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
      'EXECUTIVE_PASSES must contain adaptive or ceo, cto, cfo, legal, security, domain-manager, reviewer'
    );
  const passes = requestedPasses[0] === 'adaptive' ? ['ceo'] : requestedPasses;
  const passTimeout = Number(process.env.EXECUTIVE_PASS_TIMEOUT_MS || 5 * 60 * 1000);
  if (!Number.isInteger(passTimeout) || passTimeout < 10_000 || passTimeout > 15 * 60 * 1000)
    throw new Error('EXECUTIVE_PASS_TIMEOUT_MS must be 10000-900000');
  process.env.EXECUTIVE_TIMEOUT_MS = String(passTimeout);
  let plan = null;
  const audit = [];
  const proposalReviews = new Map();
  for (const role of passes) {
    const prompt = runner.buildPassPrompt(brief, role, plan);
    let output = await runner.runProvider(prompt);
    let repaired = false;
    try {
      const nextPlan = runner.parseOutput(output);
      plan = mergePassPlans(plan, nextPlan);
    } catch (error) {
      // Formatting failures never reach the trusted host application path.
      // Allow one bounded correction attempt, then fail closed.
      repaired = true;
      output = await runner.runProvider(
        `${prompt}\n\nYour previous response failed validation (${error.message}). Return the same plan again as strict JSON only. Messages may only use the role actors allowed by the contract; do not include owner or system, markdown, or commentary. Proposal reviews must use an existing proposal_id, reviewed_by ceo|cto|cfo|legal|security|domain-manager|reviewer, and status accepted_research|escalate_owner|declined.`
      );
      const nextPlan = runner.parseOutput(output);
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
    const repairPrompt = `${runner.buildPassPrompt(brief, 'reviewer', plan)}\n\nThe action mandate was not satisfied. Return the complete plan again and either (a) route one highest-confidence, low-risk, reversible candidate to engineer with acceptance and rollback criteria, or (b) include one owner-facing message beginning with Recommendation: that gives a clear evidence-backed disposition and asks at most one concrete decision question. Do not return an observation-only plan or a question without a recommendation.`;
    const repairedOutput = await runner.runProvider(repairPrompt);
    plan = mergePassPlans(plan, runner.parseOutput(repairedOutput));
    for (const review of plan.proposal_reviews || [])
      proposalReviews.set(review.proposal_id, review);
    audit.push({
      role: 'action-mandate-repair',
      repaired: true,
      counts: Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.length])),
    });
    if (!runner.actionMandateSatisfied(plan, brief)) {
      const finalRepairPrompt = `${runner.buildPassPrompt(brief, 'ceo', plan)}\n\nFINAL DECISION-MEMO REPAIR: The prior plan still failed the action mandate. Return the complete plan as strict JSON. Preserve the useful existing work, and include exactly one concise CEO message whose body starts with Recommendation: and then gives: (1) the action you recommend now, (2) at least one known number/date or an explicit statement that the number is not calculable and why, (3) the main unknown, (4) the smallest next step, and (5) at most one direct owner question with concrete options. Do not return a maintenance-only update or a question without a recommendation.`;
      const finalRepairOutput = await runner.runProvider(finalRepairPrompt);
      plan = mergePassPlans(plan, runner.parseOutput(finalRepairOutput));
      audit.push({
        role: 'decision-memo-repair',
        repaired: true,
        counts: Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.length])),
      });
      if (!runner.actionMandateSatisfied(plan, brief))
        throw new Error('executive action mandate was not satisfied');
    }
  }
  // Later review passes are allowed to revise an earlier conclusion, but a
  // pass that simply omits a CRO handoff must not reopen it for the owner.
  plan.proposal_reviews = [...proposalReviews.values()];
  fs.writeFileSync('/output/plan.json', JSON.stringify(plan, null, 2), { mode: 0o600 });
  fs.writeFileSync('/output/passes.json', JSON.stringify(audit, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ passes: audit }) + '\n');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { mergePassPlans };
