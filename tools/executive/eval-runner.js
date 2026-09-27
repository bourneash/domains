'use strict';

async function run(store, { suite_id, agent_id, evaluator, results } = {}) {
  const suite = store.getEvalSuite(suite_id);
  if (!suite) throw new Error('evaluation suite not found');
  const evalRun = store.createEvalRun({
    suite_id,
    agent_id,
    status: 'running',
    started_at: new Date().toISOString(),
  });
  try {
    const scores = {};
    for (let index = 0; index < suite.cases.length; index += 1) {
      const testCase = suite.cases[index];
      const result =
        typeof evaluator === 'function'
          ? await evaluator({ testCase, index, agent_id, suite })
          : Array.isArray(results)
            ? results[index]
            : null;
      const score = Number(typeof result === 'number' ? result : result?.score);
      if (!Number.isFinite(score) || score < 0 || score > 1)
        throw new Error(`invalid score for evaluation case ${index}`);
      scores[String(index)] = score;
    }
    const values = Object.values(scores);
    const average = values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : 1;
    const status = average >= suite.threshold ? 'succeeded' : 'failed';
    return store.updateEvalRun(evalRun.eval_run_id, {
      status,
      scores: { ...scores, average, threshold: suite.threshold, passed: status === 'succeeded' },
      feedback:
        status === 'succeeded'
          ? 'Evaluation suite passed.'
          : 'Evaluation suite fell below its threshold.',
      finished_at: new Date().toISOString(),
    });
  } catch (error) {
    return store.updateEvalRun(evalRun.eval_run_id, {
      status: 'failed',
      feedback: error.message,
      finished_at: new Date().toISOString(),
    });
  }
}

module.exports = { run };
