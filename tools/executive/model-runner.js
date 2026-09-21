'use strict';

const fs = require('node:fs');
const runner = require('./runner');

async function main() {
  const brief = JSON.parse(fs.readFileSync('/input/brief.json', 'utf8'));
  const requestedPasses = String(process.env.EXECUTIVE_PASSES || 'adaptive')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
  if (
    !requestedPasses.length ||
    requestedPasses.some(x => !['adaptive', 'ceo', 'cto', 'reviewer'].includes(x))
  )
    throw new Error('EXECUTIVE_PASSES must contain adaptive or ceo, cto, reviewer');
  const passes = requestedPasses[0] === 'adaptive' ? ['ceo'] : requestedPasses;
  const passTimeout = Number(process.env.EXECUTIVE_PASS_TIMEOUT_MS || 5 * 60 * 1000);
  if (!Number.isInteger(passTimeout) || passTimeout < 10_000 || passTimeout > 15 * 60 * 1000)
    throw new Error('EXECUTIVE_PASS_TIMEOUT_MS must be 10000-900000');
  process.env.EXECUTIVE_TIMEOUT_MS = String(passTimeout);
  let plan = null;
  const audit = [];
  for (const role of passes) {
    const prompt = runner.buildPassPrompt(brief, role, plan);
    let output = await runner.runProvider(prompt);
    let repaired = false;
    try {
      plan = runner.parseOutput(output);
    } catch (error) {
      // Formatting failures never reach the trusted host application path.
      // Allow one bounded correction attempt, then fail closed.
      repaired = true;
      output = await runner.runProvider(
        `${prompt}\n\nYour previous response failed validation (${error.message}). Return the same plan again as strict JSON only. Every message actor must be exactly ceo or cto; do not include owner, reviewer, system, markdown, or commentary.`
      );
      plan = runner.parseOutput(output);
    }
    audit.push({
      role,
      repaired,
      counts: Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.length])),
    });
    if (requestedPasses[0] === 'adaptive' && role === 'ceo') {
      const hasWork = ['proposals', 'change_requests', 'research_requests'].some(
        key => plan[key]?.length
      );
      if (hasWork) passes.push('cto', 'reviewer');
    }
  }
  fs.writeFileSync('/output/plan.json', JSON.stringify(plan, null, 2), { mode: 0o600 });
  fs.writeFileSync('/output/passes.json', JSON.stringify(audit, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ passes: audit }) + '\n');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
