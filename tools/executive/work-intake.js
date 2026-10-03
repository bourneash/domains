'use strict';

// Classify the requested action before selecting a manager. A mention of a
// website or build inside a rejection must never create a site launch job.
function classify(summary = '') {
  const text = String(summary).trim();
  const denial =
    /^(?:deny|denied|reject|rejected|decline|do not deploy|don't deploy|hold deployment|stop deployment)\b/i.test(
      text
    );
  const revalidation =
    /\b(?:revalidat\w*|rerun (?:the )?(?:validation|checks)|preserve for validation)\b/i.test(text);
  if (denial)
    return {
      intent: revalidation ? 'revalidation' : 'rejection',
      kind: revalidation ? 'implementation' : 'decision',
      dispatch: revalidation,
      next_action: revalidation
        ? 'Preserve the existing implementation and release hold. Identify its request/run, repair only the failed validation environment or branch conflict, and rerun the required gates. Do not implement a replacement or publish before the release gate clears.'
        : 'Record this rejection against the linked work and preserve the release hold. No implementation or publication is authorized by this message.',
    };
  if (/^(?:evaluate|investigate|research|audit|analy[sz]e|report|review)\b/i.test(text))
    return {
      intent: 'research',
      kind: 'research',
      dispatch: true,
      next_action:
        'Deliver the requested evidence and conclusion with source references. Any implementation requires a separate scoped request.',
    };
  if (/^(?:approve|approved|decide|decision|pause|cancel|hold)\b/i.test(text))
    return {
      intent: 'decision',
      kind: 'decision',
      dispatch: false,
      next_action:
        'Apply this decision to the referenced existing work through its normal decision endpoint. Do not create replacement implementation or bypass a release gate.',
    };
  return {
    intent: 'implementation',
    kind: 'implementation',
    dispatch: true,
    next_action:
      'Continue this task through one linked specialist request, acceptance, validation and confirmed release. Keep the same worker/workspace for feedback. A handoff alone does not complete the task.',
  };
}

module.exports = { classify };
