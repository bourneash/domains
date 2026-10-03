'use strict';
const git = require('./git');
const devsandbox = require('./devsandbox');

function conflict(message) {
  const error = new Error(message);
  error.httpStatus = 409;
  return error;
}

// Validation and the preview server mutate generated files. Freeze those
// writers before checking the exact workspace that will be published.
async function preparePublication(
  store,
  run,
  {
    stop = devsandbox.stop,
    restore = git.restoreDeletedAstroTypes,
    snapshot = git.worktreeSnapshot,
  } = {}
) {
  if (run.agent?.status === 'running')
    throw conflict('active worker still owns the publication workspace');
  if (run.validation?.passed !== true)
    throw conflict('workspace must pass validation before publication');
  if (!run.workspace_path || !run.branch)
    throw conflict('publication requires the original isolated branch');
  let current = run;
  if (run.sandbox?.instance && run.sandbox.started !== false) {
    await stop(run.sandbox.instance);
    current = store.updateImprovement(run.run_id, { sandbox: { ...run.sandbox, started: false } });
  }
  const restored = await restore(run.workspace_path);
  const work = await snapshot(run.workspace_path);
  if (work.branch !== run.branch) throw conflict('publication workspace changed branch');
  if (work.dirty)
    throw conflict('improvement worktree has uncommitted changes after preview shutdown');
  store.record({
    event_type: 'improvement.workspace_quiesced',
    source: 'delivery-workspace',
    site_id: `site:${run.site}`,
    entity_type: 'improvement',
    entity_id: run.run_id,
    payload: { branch: work.branch, commit: work.commit, restored_generated_files: restored },
  });
  return current;
}
module.exports = { preparePublication };
