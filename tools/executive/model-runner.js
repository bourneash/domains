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

async function runTracked(prompt, usage, role, repair = false, transcript = []) {
  const started = Date.now();
  const inputTokens = estimateTokens(prompt);
  transcript.push({
    actor: role,
    message_type: 'model-prompt',
    body: prompt,
    metadata: { repair, label: repair ? 'Repair request' : 'Model request' },
    created_at: new Date(started).toISOString(),
  });
  try {
    const output = await runner.runProvider(prompt);
    transcript.push({
      actor: role,
      message_type: 'model-response',
      body: output,
      metadata: { repair, label: 'Model response' },
    });
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
    transcript.push({
      actor: role,
      message_type: 'background',
      body: `Provider call failed: ${String(error.message || error)}`,
      metadata: { repair, label: 'Provider failure', status: 'failed' },
    });
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
    'tracking_updates',
    'knowledge',
  ];
  const merged = { ...next, messages };
  for (const key of preserveWhenEmpty) {
    if ((!Array.isArray(next[key]) || next[key].length === 0) && Array.isArray(previous[key]))
      merged[key] = previous[key];
  }
  return merged;
}

function buildRepairDirective(brief) {
  if (brief.overwatch_directive?.delivery_recovery_cases?.length)
    return 'Review only the supplied original recovery cases. For queued-backlog or failed-startup, return a material in_progress tracking update using the exact supplied case_ref, with review evidence and ordinary pickup next_action. Do not create a duplicate request. Preserve all failure and release gates.';
  if (brief.domain_manager?.site)
    return 'This is one assigned site. Return at most one source-backed engineer implementation for this site, preserving independent measurement holds. Use delivery_mode direct or pull_request, never site_change. Cite the exact supplied full source commit and existing source path in body. Preserve acceptance, tests, metric and rollback. A passive update does not satisfy the implementation mandate.';
  return 'Route up to six high-confidence reversible implementations across available sites, without duplicating work or overlapping measurement holds. Preserve acceptance, tests, metric and rollback. Evidence-backed blockers require an exact owner, unblock action and deadline.';
}

function buildModelPrompt(brief, role, plan) {
  const overwatchDirective = brief.overwatch_directive
    ? `\n\nEXEC OVERWATCH DIRECTIVE:\nYou are the independent execution-improvement controller. Evaluate the supplied evidence from the last four 15-minute cycles. Repair stuck or failed handoffs first. Then produce concrete, bounded, evidence-backed improvements to prompts, routing, process, or implementation work. A status update, unchanged checkpoint, duplicate, or report-only item is not an improvement. If no safe change can be made, state the exact blocker, owner, and next action.\n${JSON.stringify(brief.overwatch_directive)}`
    : '';
  const operatingDirective = brief.operating_manager_task
    ? `\n\nOPERATING MANAGER TASK:\nYou are executing this specific durable manager task now. Produce concrete downstream work for it or an explicit evidence-backed blocker. Do not merely acknowledge it, repeat it, or create generic fleet commentary. This task is under delivery accountability; its prior attempts, labels, and last error are included below. A no-op result is a failed delivery and repeated failures pause this manager lane. For implementation, content, design, SEO, or engineering work, the required output is an executable change_request with a concrete site, scope, acceptance criteria, tests, metric, rollback, and assigned_role. A message, proposal, tracking update, capacity note, report-only item, or generic blocker does not count as delivery. Use a blocker only when the evidence names the owner, unblock action, and deadline.\n${JSON.stringify(brief.operating_manager_task)}`
    : '';

  const manager = brief.domain_manager;
  const sourcePin =
    manager?.source_revision?.status === 'fresh-remote-source' &&
    /^[a-f0-9]{40}$/i.test(manager.source_revision.commit || '')
      ? '\n\nEXACT IMPLEMENTATION SOURCE: Copy this full commit unchanged into change_request.body: ' +
        manager.source_revision.commit +
        '. Existing source paths: ' +
        JSON.stringify((manager.source_documents || []).map(doc => doc.path)) +
        '. Do not insert spaces into the commit, shorten it or replace it with a descriptive placeholder.'
      : '';
  const contract =
    '\n\nDELIVERY CONTRACT: Site implementation delivery_mode must be direct or pull_request. report_only is diagnosis; fleet_report is the fleet reporting operation. site_change is invalid. Omit optional action_key/source_work_id unless supplied. For inline links, a persistent underline is a non-color distinction; do not demand 3:1 contrast against adjacent text as well as an underline. Preserve required text-to-background contrast and verify the actual affected user path.';
  return `${runner.buildPassPrompt(brief, role, plan)}${operatingDirective}${overwatchDirective}${sourcePin}${contract}`;
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
          'product-manager-fleet',
          'product-manager-sites',
          'ceo',
          'cro',
          'cto',
          'cfo',
          'legal',
          'security',
          'domain-manager',
          'reviewer',
          'delivery-lead',
          'design-director',
          'growth-director',
          'revenue-ops',
          'site-factory',
        ].includes(x)
    )
  )
    throw new Error(
      'EXECUTIVE_PASSES must contain adaptive, product-manager-fleet, product-manager-sites, delivery-lead, design-director, growth-director, revenue-ops, site-factory, ceo, cro, cto, cfo, legal, security, domain-manager, reviewer'
    );
  const passes = requestedPasses[0] === 'adaptive' ? ['ceo'] : requestedPasses;
  const passTimeout = Number(process.env.EXECUTIVE_PASS_TIMEOUT_MS || 5 * 60 * 1000);
  if (!Number.isInteger(passTimeout) || passTimeout < 10_000 || passTimeout > 15 * 60 * 1000)
    throw new Error('EXECUTIVE_PASS_TIMEOUT_MS must be 10000-900000');
  process.env.EXECUTIVE_TIMEOUT_MS = String(passTimeout);
  let plan = null;
  const audit = [];
  const usage = createUsageLedger();
  const transcript = [];
  let finalized = false;
  const mergeProviderPlan = nextPlan => {
    const merged = runner.sanitizeExcludedPlanItems(mergePassPlans(plan, nextPlan));
    runner.sanitizePlan(merged);
    return merged;
  };
  // Preserve partial cost/pass evidence when a provider response fails
  // validation. The sandbox may not produce a plan, but it must still export
  // the calls already made so failures cannot disappear from the audit ledger.
  activeRun = { audit, usage, transcript, failure: null };
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
      fs.writeFileSync('/output/transcript.json', JSON.stringify(transcript, null, 2), {
        mode: 0o600,
      });
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
    const prompt = buildModelPrompt(brief, role, plan);
    let output = await runTracked(prompt, usage, role, false, transcript);
    let repaired = false;
    try {
      const nextPlan = runner.parseOutput(output, {
        defaultActor: role,
        defaultSite: brief.domain_manager?.site || '',
        sanitize: true,
        rejectDroppedRequests: true,
      });
      plan = runner.resolveRecoveryReferences(mergeProviderPlan(nextPlan), brief);
    } catch (error) {
      // Formatting failures never reach the trusted host application path.
      // Allow one bounded correction attempt, then fail closed.
      repaired = true;
      output = await runTracked(
        `${prompt}\n\nPREVIOUS RESPONSE TO CORRECT:\n${output.slice(0, 65536)}\n\nYour previous response failed validation (${error.message}). Correct that exact validation error and return the same plan again as strict JSON only. Messages may only use the role actors allowed by the contract; do not include owner or system, markdown, or commentary. Proposal reviews must use an existing proposal_id, reviewed_by ceo|cto|cfo|legal|security|domain-manager|reviewer, and status accepted_research|escalate_owner|declined. Proposals must include created_by, title, summary, and requested_action; created_by must be ceo|cto|cro|cfo|legal|security|domain-manager|researcher.`,
        usage,
        role,
        true,
        transcript
      );
      let nextPlan;
      try {
        nextPlan = runner.parseOutput(output, {
          defaultActor: role,
          defaultSite: brief.domain_manager?.site || '',
          sanitize: true,
          rejectDroppedRequests: true,
        });
      } catch (repairError) {
        // A provider can fail twice on formatting even after the bounded
        // correction prompt. Do not discard the useful passes already
        // completed: an empty replacement lets mergePassPlans retain them,
        // and the trusted action-mandate fallback below can still route
        // evidence-backed work without trusting malformed provider text.
        transcript.push({
          actor: role,
          message_type: 'background',
          body: `Provider plan repair failed; preserving prior plan for deterministic fallback: ${repairError.message}`,
          metadata: { repair: true, label: 'Plan repair failure', status: 'failed' },
        });
        nextPlan = runner.emptyPlan();
      }
      plan = runner.resolveRecoveryReferences(mergeProviderPlan(nextPlan), brief);
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
    const repairPrompt = `${buildModelPrompt(brief, 'reviewer', plan)}\n\nACTION MANDATE REPAIR: Return the complete plan as strict JSON. ${buildRepairDirective(brief)}`;
    const repairedOutput = await runTracked(
      repairPrompt,
      usage,
      'action-mandate-repair',
      true,
      transcript
    );
    let repairedPlan;
    try {
      repairedPlan = runner.parseOutput(repairedOutput, {
        defaultActor: 'reviewer',
        sanitize: true,
        rejectDroppedRequests: true,
      });
    } catch (repairError) {
      transcript.push({
        actor: 'action-mandate-repair',
        message_type: 'background',
        body: `Action-mandate repair returned invalid JSON; deterministic candidate routing will take over: ${repairError.message}`,
        metadata: { repair: true, label: 'Plan repair failure', status: 'failed' },
      });
      repairedPlan = runner.emptyPlan();
    }
    plan = runner.resolveRecoveryReferences(mergeProviderPlan(repairedPlan), brief);
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
      const finalRepairPrompt = `${buildModelPrompt(brief, 'ceo', plan)}\n\nFINAL IMPLEMENTATION REPAIR: Return the complete plan as strict JSON. ${buildRepairDirective(brief)}`;
      const finalRepairOutput = await runTracked(
        finalRepairPrompt,
        usage,
        'decision-memo-repair',
        true,
        transcript
      );
      let finalPlan;
      try {
        finalPlan = runner.parseOutput(finalRepairOutput, {
          defaultActor: 'ceo',
          sanitize: true,
          rejectDroppedRequests: true,
        });
      } catch (repairError) {
        transcript.push({
          actor: 'decision-memo-repair',
          message_type: 'background',
          body: `Final implementation repair returned invalid JSON; deterministic candidate routing will take over: ${repairError.message}`,
          metadata: { repair: true, label: 'Plan repair failure', status: 'failed' },
        });
        finalPlan = runner.emptyPlan();
      }
      plan = runner.resolveRecoveryReferences(mergeProviderPlan(finalPlan), brief);
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
  if (brief.operating_manager_task?.work_id) {
    const task = brief.operating_manager_task;
    if (task.site && (plan.change_requests || []).some(request => request.site !== task.site))
      throw new Error('operating manager attempted work outside its assigned site');
    for (const request of plan.change_requests || [])
      request.body = `${request.body || ''}\n\nOperating task: ${brief.operating_manager_task.work_id}`;
  }
  runner.sanitizePlan(plan);
  // Later review passes are allowed to revise an earlier conclusion, but a
  // pass that simply omits a CRO handoff must not reopen it for the owner.
  plan.proposal_reviews = [...proposalReviews.values()];
  for (const pass of audit)
    transcript.push({
      actor: pass.role,
      message_type: 'background',
      body: `Pass completed: ${pass.role}. ${
        Object.entries(pass.counts || {})
          .map(([key, value]) => `${value} ${key.replaceAll('_', ' ')}`)
          .join(' · ') || 'No structured items recorded.'
      }`,
      metadata: {
        label: 'Background work',
        counts: pass.counts || {},
        repaired: Boolean(pass.repaired),
      },
    });
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

module.exports = { mergePassPlans, buildModelPrompt, buildRepairDirective };
