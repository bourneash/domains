'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { discoverSites, isKnownSite } = require('./sites');
const audit = require('./audit');
const git = require('./git');
const githygiene = require('./githygiene');
const tasks = require('./tasks');
const guideQueue = require('./guideQueue');
const aiOptimizer = require('./aioptimizer');
const run = require('./run');
const containers = require('./containers');
const roles = require('./roles');
const taskbudget = require('./taskbudget');
const aiinventory = require('./aiinventory');
const aiusage = require('./aiusage');
const cron = require('./cron');
const deployhealth = require('./deployhealth');
const cloudflarebuilds = require('./cloudflarebuilds');
const gatushealth = require('./gatushealth');
const datahub = require('./datahub');
const analytics = require('./analytics');
const revenue = require('./revenue');
const seoIntelligence = require('./seointelligence');
const webvitals = require('./webvitals');
const backlinks = require('./backlinks');
const datahubImages = require('./datahub-images');
const productFeed = require('./product-feed');
const auth = require('./auth');
const health = require('./health');
const actionlog = require('./actionlog');
const devsandbox = require('./devsandbox');
const sitefacts = require('./sitefacts');
const compliance = require('./compliance');
const lintfleet = require('./lintfleet');
const errorscan = require('./errorscan');
const guardrails = require('./guardrails');
const domains = require('./domains');
const scaffolds = require('./scaffolds');
const registrar = require('./registrar');
const fleetdoctor = require('./fleetdoctor');
const retention = require('./retention');
const social = require('./social');
const socialhub = require('./socialhub');
const automation = require('./automation');
const eventstore = require('./eventstore');
const priorities = require('./priorities');
const dataquality = require('./dataquality');
const improvements = require('./improvements');
const measurementRunner = require('./measurement-runner');
const improvementAgent = require('./improvement-agent');
const changequeue = require('./changequeue');
const changequeueNotify = require('./changequeue-notify');
const executiveFollowup = require('./executive-followup');
const executiveFailureFollowup = require('./executive-failure-followup');
const executiveData = require('./executive-data');
const executive = require('./executive');
const executiveRunner = require('../../executive/runner');
const executiveCro = require('../../executive/cro');
const executiveCroLab = require('../../executive/cro-lab');
const executiveIntel = require('./executive-intel');
const executiveSnapshot = require('./executive-snapshot');
const executiveScorecard = require('./executive-scorecard');
const revops = require('./revops');
const experiments = require('./experiments');
const campaigns = require('./campaigns');
const domainReports = require('./domain-reports');
const domainDispatcher = require('./domain-dispatcher');
const fleetTask = require('./fleet-task');
const { assignedRoleForType, assignedRoleForSite } = require('./task-routing');

const DEFAULT_ROOT = process.env.FD_DOMAINS_ROOT || path.resolve(__dirname, '..', '..', '..'); // tools/fleet-dashboard/server → repo root
const PORT = parseInt(process.env.FD_PORT || '4754', 10);
const HOST = process.env.FD_HOST || '127.0.0.1';
const QUALITY_GATES = ['diff', 'tests', 'build', 'preview', 'browser'];
const MAX_AUTOMATIC_QUEUE_ATTEMPTS = 3;
const MAX_AUTOMATIC_REVIEW_REPAIRS = 2;
// Failed rows remain part of the audit history, but a failure from an old
// queue epoch must not wake up indefinitely and compete with current work.
// Owners can still explicitly requeue an older request after reviewing it.
const AUTOMATIC_RETRY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// A reviewer process updates the durable run row before its close callback
// finishes the delivery handoff. Do not mistake that short, normal window for
// an interrupted handoff during the 15-second queue pulse.
const AUTOMATIC_REVIEW_HANDOFF_GRACE_MS = 2 * 60 * 1000;
// A reviewer callback can be lost while deterministic delivery is still
// running. Do not let the process-local active set suppress recovery forever;
// after this bound, the durable PASS marker is authoritative and the sweep may
// reclaim the handoff once.
const AUTOMATIC_REVIEW_ACTIVE_MAX_MS = 8 * 60 * 1000;
const AUTOMATIC_DELIVERY_CLAIM_MAX_MS = 15 * 60 * 1000;
// Bump this when the validation harness changes. A preserved implementation
// may then receive one bounded revalidation automatically, without reopening
// the same infrastructure failure on every queue pulse.
const INFRASTRUCTURE_REVALIDATION_VERSION = 'ipv4-preview-v2';
// Recovery inspects historical failed work and may need Docker/Git probes.
// It must not hold the normal queue pickup path hostage when an old worker or
// container is slow; the recovery lock keeps the long pass single-flight.
const QUEUE_RECOVERY_WAIT_MS = 5000;

// Report-only work produces evidence in an isolated checkout and cannot ship
// code. It should not spend another model call on a release-marker review;
// direct and pull-request work still require the independent reviewer.
function workerCompletionPath(request, result, settings) {
  if (!request || result?.code !== 0 || result?.timedOut) return 'none';
  if (request.delivery_mode === 'report_only') return 'report-only';
  if (request.auto_review && settings?.auto_review_enabled) return 'review';
  return 'none';
}

function interruptedWorkerRecoveryPath(request) {
  return request?.delivery_mode === 'report_only' ? 'report-only' : 'review';
}

function shouldRetryQueueFailure(text, validation = null) {
  const value = String(text || '');
  // Reviewer rejection is a substantive decision about the diff. Repeating
  // the same worker without new feedback only burns a slot and creates audit
  // noise; bounded reviewer repair is handled separately.
  if (/automatic reviewer rejected the change|reviewer rejected/i.test(value)) return false;
  // Once deterministic validation has run, preserve the failure for an owner
  // or tooling fix. Automatic review already marks infrastructure blocks
  // explicitly; blindly retrying the unchanged checkout is not recovery.
  if (validation?.passed === false) return false;
  if (/quality gates? (?:did not pass|failed)/i.test(value)) return false;
  return /(worker process|implementation agent ended|reviewer handoff|automatic reviewer handoff|ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection refused|failed to connect|server is not responding)/i.test(
    value
  );
}

function shouldAutoRevalidateInfrastructureReview(
  request,
  run,
  version = INFRASTRUCTURE_REVALIDATION_VERSION
) {
  const completedReviewerHandoff =
    run?.state === 'building' &&
    run.agent?.phase === 'reviewer' &&
    run.agent?.status === 'completed' &&
    Number(run.agent?.exit_code) === 0;
  return Boolean(
    request &&
    request.status === 'review' &&
    run &&
    (run.state === 'review' || completedReviewerHandoff) &&
    run.outcome?.infrastructure_blocked === true &&
    run.outcome?.infrastructure_revalidation_version !== version
  );
}

// Re-projecting a preserved infrastructure review must be idempotent. The
// change-queue store intentionally rejects lifecycle updates that attempt to
// transition a request to its current status, so callers must omit `status`
// when the durable row is already in review.
function infrastructureReviewProjectionPatch(request, queueError) {
  return {
    ...(request?.status === 'review' ? {} : { status: 'review' }),
    error: queueError,
    next_attempt_at: null,
    lease_owner: null,
    lease_expires_at: null,
    heartbeat_at: null,
  };
}

function shouldRecoverStaleDeliveryClaim(
  request,
  run,
  now = Date.now(),
  maxAgeMs = AUTOMATIC_DELIVERY_CLAIM_MAX_MS
) {
  const claimedAt = Date.parse(run?.outcome?.delivery_claimed_at || '');
  return Boolean(
    request &&
    ['reviewing', 'review'].includes(request.status) &&
    run?.state === 'review' &&
    run.validation?.passed === true &&
    run.outcome?.delivery_claimed === true &&
    run.agent?.phase === 'reviewer' &&
    run.agent?.status === 'completed' &&
    Number.isFinite(claimedAt) &&
    now - claimedAt >= Number(maxAgeMs)
  );
}

function shouldValidateBeforeDelivery(item) {
  return !(item?.state === 'review' && item.validation?.passed === true);
}

function isKnownTarget(root, target) {
  return target === 'fleet' || isKnownSite(root, target);
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

function reportArtifactPath(root, requestId) {
  return path.join(
    root,
    'tools',
    'fleet-dashboard',
    'data',
    'executive-reports',
    `${requestId}.json`
  );
}

function writeReportArtifact(root, request, run, diff, logTail) {
  const file = reportArtifactPath(root, request.request_id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const text = String(diff || '');
  const artifact = {
    schema: 'executive-report/v1',
    request_id: request.request_id,
    source_proposal_id: request.source_proposal_id || null,
    requested_by: request.requested_by || null,
    site: request.site,
    title: request.title,
    generated_at: new Date().toISOString(),
    run_id: run.run_id,
    commit: run.commit || run.branch || null,
    diff: text.slice(0, 250000),
    diff_truncated: text.length > 250000,
    agent_log_tail: String(logTail || '').slice(-12000),
  };
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(artifact, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
  return { file, url: `/api/change-requests/${request.request_id}/report` };
}

function applyQualityPolicy(root, site, validation) {
  const defaultRequired = [...QUALITY_GATES];
  const policyPath = path.join(root, 'sites', site, 'ops', 'change-queue-quality.json');
  let required = defaultRequired;
  let source = 'fleet-default';
  let policyError = null;
  try {
    if (fs.existsSync(policyPath)) {
      const parsed = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
      if (!Array.isArray(parsed.required) || parsed.required.length === 0)
        throw new Error('required must be a non-empty array');
      required = [...new Set(parsed.required.map(String))];
      if (required.some(gate => !QUALITY_GATES.includes(gate)))
        throw new Error(`required gates must be one of ${QUALITY_GATES.join(', ')}`);
      source = policyPath;
    }
  } catch (error) {
    policyError = error.message;
    required = defaultRequired;
  }
  const status = {
    diff: validation.checks?.diff?.status,
    tests: validation.checks?.tests?.status,
    build: validation.checks?.build?.status,
    preview: validation.preview?.passed === true ? 'pass' : 'fail',
    browser:
      validation.browser?.passed === true
        ? 'pass'
        : validation.browser?.infrastructure_warning === true
          ? 'warn'
          : 'fail',
  };
  // A browser runtime crash is useful evidence, but it is not evidence that
  // the page itself is broken. Keep the warning in the durable validation
  // record while allowing the deterministic build/preview gates to decide.
  const passed = required.every(
    gate => status[gate] === 'pass' || (gate === 'browser' && status[gate] === 'warn')
  );
  return {
    ...validation,
    passed,
    policy: { required, source, error: policyError, status },
  };
}

function createApp({ root = DEFAULT_ROOT } = {}) {
  const app = express();
  const events = eventstore.open(root);
  const queueWorkerId = `${process.pid}:${crypto.randomUUID()}`;
  app.disable('x-powered-by');

  // Repair legacy executive requests whose body clearly declared report-only
  // work but was persisted as direct delivery. This is deliberately narrow,
  // idempotent, and auditable; historical failures remain historical events.
  for (const request of events.listChangeRequests({ limit: 1000 })) {
    const legacyInferenceInput = { ...request };
    delete legacyInferenceInput.delivery_mode;
    if (
      request.delivery_mode !== 'direct' ||
      !['queued', 'failed'].includes(request.status) ||
      changequeue.inferredDeliveryMode(legacyInferenceInput) !== 'report_only'
    )
      continue;
    try {
      const repaired = changequeue.update(
        events,
        request.request_id,
        { delivery_mode: 'report_only' },
        site => isKnownTarget(root, site)
      );
      events.record({
        event_type: 'change-request.delivery-mode-repaired',
        source: 'fleet-dashboard',
        site_id: `site:${request.site}`,
        entity_type: 'change-request',
        entity_id: request.request_id,
        correlation_id: `change-request:${request.request_id}`,
        payload: {
          previous: 'direct',
          repaired: repaired.delivery_mode,
          reason: 'request text explicitly declared report-only work',
        },
      });
    } catch {
      // A concurrent worker or invalid legacy row must not prevent the
      // dashboard from starting. The original row remains auditable.
    }
  }

  function emitChangeNotification(event, request, run, details = '') {
    try {
      executiveFollowup.notify(events, { event, request, run, details });
    } catch {
      // Role follow-up must never make a queue transition fail.
    }
    changequeueNotify
      .notify({ event, request, run, details })
      .then(result => {
        events.record({
          event_type: 'change-request.notification',
          source: 'fleet-dashboard',
          site_id: request?.site ? `site:${request.site}` : null,
          entity_type: 'change-request',
          entity_id: request?.request_id || null,
          correlation_id: request?.request_id ? `change-request:${request.request_id}` : null,
          payload: { event, ...result },
        });
      })
      .catch(() => {});
  }

  // Host allowlist for EVERY request (defeats DNS-rebinding — B3). Always on.
  app.use(auth.hostGuard);

  // Structured request log (F11): one line per request with status + duration,
  // mutations flagged. Silent under test to keep `node --test` output clean.
  if (process.env.NODE_ENV !== 'test' && process.env.FD_QUIET !== '1') {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const write = req.method !== 'GET' && req.method !== 'HEAD';
        // Skip the noisy SSE/asset/version polling; keep mutations + errors + API reads.
        if (req.path === '/api/version' || req.path === '/api/stream') return;
        if (!write && res.statusCode < 400 && !req.path.startsWith('/api/')) return;
        console.log(
          `${new Date().toISOString()} ${write ? 'WRITE ' : ''}${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`
        );
      });
      next();
    });
  }

  app.use(express.json({ limit: '1mb' }));

  // Persisted audit trail (B4): append one JSONL record per mutating /api/*
  // request — actor fingerprint, path, status, duration, sanitized body. Mounted
  // after express.json (so req.body is populated) and BEFORE the token gate so
  // rejected mutation attempts (401/403) are recorded too.
  app.use(actionlog.middleware);

  // Token gate for the API (opt-in via FD_TOKEN — F1). App-wide but only acts on
  // /api/* (see auth.apiGuard); mounted after express.json so POST /api/login can
  // read its body, and before routes. Static assets + /healthz stay open so the
  // login shell always loads.
  app.use(auth.apiGuard);

  // Prevent browsers from retaining an older SPA after a restart. Without this,
  // new controls can be present on disk but invisible in an already-open tab.
  app.use((req, res, next) => {
    if (['/index.html', '/app.js', '/shell.js', '/style.css', '/theme.css'].includes(req.path)) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    }
    next();
  });

  app.use(express.static(path.join(__dirname, 'public')));

  async function dispatchChangeRequest(request) {
    const claimedAt = new Date();
    const settings = events.getChangeQueueSettings();
    const claimed = events.claimQueuedChangeRequest(request.request_id, {
      owner: queueWorkerId,
      claimedAt: claimedAt.toISOString(),
      leaseExpiresAt: new Date(
        claimedAt.getTime() + Number(settings.lease_minutes) * 60000
      ).toISOString(),
    });
    if (!claimed)
      throw Object.assign(new Error('request was already claimed or is no longer due'), {
        httpStatus: 409,
      });
    // Last-mile defense for requests queued before role routing was enforced.
    // Resolve against the site's installed roles: `content-writer` is the
    // canonical fleet owner, but some sites intentionally use `news-writer`,
    // and some older sites have no SEO analyst at all. Never launch a worker
    // under a role that does not exist in its own site checkout.
    const previousRole = claimed.assigned_role;
    const availableRoles = installedSiteRoles(root, claimed.site);
    const routedRole = assignedRoleForSite(
      claimed.category,
      claimed.assigned_role,
      availableRoles,
      { delivery_mode: claimed.delivery_mode }
    );
    if (claimed.site !== 'fleet' && (!routedRole || !availableRoles.includes(routedRole))) {
      const reason =
        `no installed owner for category=${claimed.category} on ${claimed.site}; ` +
        `requested role=${claimed.assigned_role || 'unassigned'}`;
      const blocked = events.updateChangeRequest(claimed.request_id, {
        status: 'failed',
        error: reason,
        next_attempt_at: null,
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: null,
      });
      events.record({
        event_type: 'change-request.owner_missing',
        source: 'fleet-dashboard',
        site_id: `site:${claimed.site}`,
        entity_type: 'change-request',
        entity_id: claimed.request_id,
        correlation_id: `change-request:${claimed.request_id}`,
        payload: {
          category: claimed.category,
          requested_role: claimed.assigned_role,
          available_roles: availableRoles,
        },
      });
      throw Object.assign(new Error(reason), { httpStatus: 409, request: blocked });
    }
    if (routedRole && routedRole !== previousRole) {
      const rebound = events.updateChangeRequest(claimed.request_id, {
        assigned_role: routedRole,
      });
      Object.assign(claimed, rebound);
      events.record({
        event_type: 'change-request.role_rebound',
        source: 'fleet-dashboard',
        site_id: `site:${claimed.site}`,
        entity_type: 'change-request',
        entity_id: claimed.request_id,
        correlation_id: `change-request:${claimed.request_id}`,
        payload: {
          previous_role: previousRole,
          assigned_role: routedRole,
          category: claimed.category,
          reason: 'canonical role is not installed on this site',
        },
      });
    }
    const workerProvider = improvementAgent.resolveWorkerProvider(claimed);
    if (
      workerProvider.fallback ||
      workerProvider.provider !== claimed.provider ||
      workerProvider.model !== claimed.model
    ) {
      const previousProvider = claimed.provider;
      const previousModel = claimed.model;
      const rebound = changequeue.update(
        events,
        claimed.request_id,
        { provider: workerProvider.provider, model: workerProvider.model },
        site => isKnownTarget(root, site)
      );
      Object.assign(claimed, rebound);
      events.record({
        event_type: 'change-request.provider_rebound',
        source: 'fleet-dashboard',
        site_id: `site:${claimed.site}`,
        entity_type: 'change-request',
        entity_id: claimed.request_id,
        correlation_id: `change-request:${claimed.request_id}`,
        payload: {
          previous_provider: previousProvider,
          previous_model: previousModel,
          provider: claimed.provider,
          model: claimed.model,
          reason: workerProvider.reason || 'fleet worker policy',
        },
      });
    }
    events.record({
      event_type: 'change-request.claimed',
      source: 'fleet-dashboard',
      site_id: `site:${claimed.site}`,
      entity_type: 'change-request',
      entity_id: claimed.request_id,
      correlation_id: `change-request:${claimed.request_id}`,
      payload: { owner: queueWorkerId, attempts: claimed.attempts },
    });
    if (claimed.site === 'fleet') return dispatchFleetRequest(claimed);
    const lease = settings.lease_minutes;
    let createdRun = null;
    let agentStarted = false;
    try {
      let baseline = {};
      try {
        // Capture the pre-change window while the request is being claimed.
        // A missing data hub must not strand safe implementation work; it is
        // recorded as unavailable and the later measurement remains honest.
        const [analyticsBaseline, revenueSnapshot] = await Promise.all([
          analytics.summary(claimed.site, 14),
          Promise.resolve(revenue.amazonSummary(root)),
        ]);
        baseline = {
          ...analyticsBaseline,
          revenue: revenue.siteAttribution(revenueSnapshot, claimed.site) || {
            has_data: false,
            site: claimed.site,
          },
        };
      } catch {
        baseline = {
          has_data: false,
          error: 'baseline collection failed',
          revenue: { has_data: false, site: claimed.site },
        };
      }
      const created = improvements.startManual({ store: events, root, request: claimed, baseline });
      createdRun = created.run;
      // A retry can arrive after the task/run was created but before the
      // request was linked or the worker was started. Reuse a live run rather
      // than creating another sandbox; a proposed run is safe to resume
      // through the normal setup below.
      if (created.duplicate && created.run.state !== 'proposed') {
        const resumed = changequeue.update(events, claimed.request_id, {
          status: 'running',
          run_id: created.run.run_id,
          error: null,
          lease_owner: queueWorkerId,
          lease_expires_at: new Date(Date.now() + Number(lease) * 60000).toISOString(),
          heartbeat_at: new Date().toISOString(),
        });
        return { request: resumed, run: created.run, deduplicated: true };
      }
      const queuedTask = findImprovementTask(root, createdRun);
      if (!queuedTask)
        throw new Error(`linked task ${created.task_file} is missing before queue commit`);
      // A task-routing request points at an existing, already committed board
      // item. Do not manufacture an empty commit for it: the worker's isolated
      // worktree is based on that existing item and owns the next edit. New
      // tasks still get the normal path-limited queue commit.
      if (!created.task_reused) {
        await git.commit(
          root,
          claimed.site,
          [`ops/tasks/${queuedTask.column}/${created.task_file}`],
          `chore: queue ${claimed.title}`
        );
      }
      const worktree = await git.createWorktree(root, claimed.site, created.run.run_id);
      const sandbox = await devsandbox.startImprovement(
        root,
        claimed.site,
        created.run.run_id,
        worktree.path
      );
      const runWithSandbox = events.updateImprovement(created.run.run_id, {
        workspace_path: worktree.path,
        sandbox: { ...sandbox, workspace_path: worktree.path },
      });
      createdRun = runWithSandbox;
      // Link the request before the provider check so an unavailable CLI can
      // still be cleaned up and retried from the dashboard.
      changequeue.update(events, claimed.request_id, { run_id: created.run.run_id });
      const environmentCheck = await devsandbox.preflight(sandbox.instance);
      events.updateImprovement(created.run.run_id, { preflight: environmentCheck });
      events.record({
        event_type: 'improvement.preflight',
        source: 'improvement-workbench',
        site_id: `site:${claimed.site}`,
        entity_type: 'improvement',
        entity_id: created.run.run_id,
        correlation_id: `change-request:${claimed.request_id}`,
        payload: environmentCheck,
      });
      if (!environmentCheck.passed) {
        const failed = Object.entries(environmentCheck.checks)
          .filter(([, check]) => check.status === 'fail')
          .map(([name, check]) => `${name}: ${check.evidence}`)
          .join('; ');
        throw Object.assign(
          new Error(`environment preflight failed${failed ? `: ${failed}` : ''}`),
          {
            httpStatus: 503,
          }
        );
      }
      const providerCheck = await improvementAgent.preflight({
        run: runWithSandbox,
        provider: claimed.provider,
        model: claimed.model,
      });
      if (!providerCheck.ok) {
        const error = new Error(providerCheck.error);
        error.httpStatus = 503;
        throw error;
      }
      const building = improvements.transition(events, created.run.run_id, {
        state: 'building',
        branch: worktree.branch,
      });
      const runnable = events.getImprovement(created.run.run_id);
      const workerTaskBody = String(claimed.action_key || '').startsWith('task-routing:')
        ? `${claimed.body}\n\nTASK-ROUTING EXECUTION CONTRACT:\n- Edit the existing task identified by action_key.\n- Do not create a replacement or wrapper task.\n- Use the effective installed queue role ${claimed.assigned_role || 'engineer'}; if the request text names a role that is not installed, substitute this role and record the reason.\n- Preserve rollback metadata and leave unrelated tasks unchanged.`
        : claimed.body;
      const result = improvementAgent.start({
        root,
        store: events,
        run: runnable,
        taskBody: workerTaskBody,
        provider: claimed.provider,
        model: claimed.model,
        maxTurns: claimed.max_turns,
        role: claimed.assigned_role,
        onFinished: result => {
          const completionPath = workerCompletionPath(
            claimed,
            result,
            events.getChangeQueueSettings()
          );
          if (completionPath === 'none') return;
          // Report-only work cannot deploy, push, or change production. Once
          // the bounded worker exits successfully, finalize its evidence
          // deterministically instead of sending it through a second model
          // reviewer that can reject a safe report for formatting or marker
          // reasons. Direct/pull-request work keeps the independent reviewer.
          if (completionPath === 'report-only') {
            Promise.resolve()
              .then(async () => {
                const finished = events.getImprovement(created.run.run_id);
                if (!finished) throw new Error('report-only improvement run disappeared');
                await deliverAutomatically(finished);
              })
              .catch(error => recordAutoReviewFailure(claimed.request_id, error));
            return;
          }
          if (completionPath === 'review') {
            // Task-routing requests are metadata-only work. Normalize an
            // invalid canonical role in the isolated checkout before the
            // independent reviewer sees it. This keeps a site's installed
            // role inventory authoritative even when the model copied the
            // fleet-wide role name into frontmatter.
            if (result.code === 0 && !result.timedOut) {
              try {
                const finished = events.getImprovement(created.run.run_id);
                if (!finished) throw new Error('routing improvement run disappeared');
                normalizeTaskRoutingWorktree(finished, claimed);
              } catch (error) {
                recordAutoReviewFailure(claimed.request_id, error);
                return;
              }
            }
            autoReviewRequest(claimed.request_id).catch(error =>
              recordAutoReviewFailure(claimed.request_id, error)
            );
          }
        },
      });
      agentStarted = true;
      changequeue.update(events, claimed.request_id, {
        status: 'running',
        run_id: created.run.run_id,
        error: null,
        lease_owner: queueWorkerId,
        lease_expires_at: new Date(Date.now() + Number(lease) * 60000).toISOString(),
        heartbeat_at: new Date().toISOString(),
      });
      events.record({
        event_type: 'change-request.started',
        source: 'fleet-dashboard',
        site_id: `site:${claimed.site}`,
        entity_type: 'change-request',
        entity_id: claimed.request_id,
        correlation_id: `change-request:${claimed.request_id}`,
        payload: {
          run_id: created.run.run_id,
          provider: claimed.provider,
          model: claimed.model,
          max_turns: claimed.max_turns,
        },
      });
      emitChangeNotification('started', events.getChangeRequest(claimed.request_id), runnable);
      return { request: events.getChangeRequest(claimed.request_id), run: building, agent: result };
    } catch (e) {
      if (createdRun && !agentStarted) {
        try {
          const cleanup = await cleanupImprovementResources(root, createdRun);
          if (cleanup.cleaned) {
            const current = events.getImprovement(createdRun.run_id);
            if (current && ['proposed', 'building'].includes(current.state)) {
              await syncImprovementTask(root, current, 'hold');
              improvements.transition(events, current.run_id, { state: 'cancelled' });
            }
          }
        } catch (cleanupError) {
          events.record({
            event_type: 'change-request.cleanup_failed',
            source: 'fleet-dashboard',
            site_id: `site:${claimed.site}`,
            entity_type: 'change-request',
            entity_id: claimed.request_id,
            correlation_id: `change-request:${claimed.request_id}`,
            payload: { error: cleanupError.message },
          });
        }
      }
      const terminal = claimed.attempts >= MAX_AUTOMATIC_QUEUE_ATTEMPTS;
      const failedRequest = changequeue.update(events, claimed.request_id, {
        status: 'failed',
        error: String(e.message || e),
        next_attempt_at: terminal ? null : new Date(Date.now() + 15 * 60000).toISOString(),
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: null,
      });
      emitChangeNotification('failed', failedRequest, createdRun, String(e.message || e));
      if (terminal) {
        events.record({
          event_type: 'change-request.manual_intervention_required',
          source: 'fleet-dashboard',
          site_id: `site:${claimed.site}`,
          entity_type: 'change-request',
          entity_id: claimed.request_id,
          correlation_id: `change-request:${claimed.request_id}`,
          payload: {
            attempts: claimed.attempts,
            max_automatic_attempts: MAX_AUTOMATIC_QUEUE_ATTEMPTS,
            error: String(e.message || e),
          },
        });
      }
      throw e;
    }
  }

  async function dispatchFleetRequest(claimed) {
    const settings = events.getChangeQueueSettings();
    const finish = patch =>
      changequeue.update(events, claimed.request_id, patch, target => isKnownTarget(root, target));
    try {
      finish({
        status: 'running',
        lease_owner: queueWorkerId,
        lease_expires_at: new Date(
          Date.now() + Number(settings.lease_minutes) * 60000
        ).toISOString(),
        heartbeat_at: new Date().toISOString(),
      });
      events.record({
        event_type: 'fleet-request.started',
        source: 'fleet-dashboard',
        site_id: 'fleet',
        entity_type: 'change-request',
        entity_id: claimed.request_id,
        correlation_id: `change-request:${claimed.request_id}`,
        payload: { action_key: claimed.action_key },
      });
      const result = fleetTask.execute({ root, store: events, request: claimed });
      finish({ status: 'reviewing' });
      finish({ status: 'review' });
      const verified = finish({
        status: 'verified',
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: null,
        error: null,
      });
      events.record({
        event_type: 'fleet-request.verified',
        source: 'fleet-dashboard',
        site_id: 'fleet',
        entity_type: 'change-request',
        entity_id: claimed.request_id,
        correlation_id: `change-request:${claimed.request_id}`,
        payload: result,
      });
      executiveFollowup.notify(events, {
        event: 'verified',
        request: verified,
        details: result.artifact?.url || 'fleet operation completed',
      });
      return { request: verified, fleet: result };
    } catch (error) {
      try {
        finish({
          status: 'failed',
          error: String(error.message || error),
          lease_owner: null,
          lease_expires_at: null,
          heartbeat_at: null,
        });
      } catch {
        /* preserve the original operation error */
      }
      throw error;
    }
  }

  async function resetChangeRequestRun(request) {
    if (!request.run_id) return;
    const run = events.getImprovement(request.run_id);
    if (!run || !['proposed', 'building', 'failed'].includes(run.state)) return;
    // Any failed worker may leave useful or partially corrected work in a
    // dirty checkout. Preserve that checkout for audit and detach the request
    // so a retry gets a fresh isolated worktree. Refusing every retry because
    // the previous worker left changes behind is a major source of queue
    // starvation; preserving the evidence is safer than deleting it.
    if (run.state === 'failed') {
      let dirty = false;
      try {
        dirty = (await git.worktreeSnapshot(run.workspace_path)).dirty;
      } catch {
        /* the normal cleanup path below will report a missing worktree */
      }
      if (dirty) {
        if (run.sandbox?.instance) {
          try {
            await devsandbox.remove(run.sandbox.instance);
          } catch {
            /* the interrupted sandbox may already be gone */
          }
        }
        changequeue.update(events, request.request_id, { run_id: null }, site =>
          isKnownTarget(root, site)
        );
        events.record({
          event_type: 'change-request.retry_preserved_worktree',
          source: 'fleet-dashboard',
          site_id: `site:${request.site}`,
          entity_type: 'change-request',
          entity_id: request.request_id,
          correlation_id: `change-request:${request.request_id}`,
          payload: {
            previous_run_id: run.run_id,
            reason: 'preserved failed worker changes before retry',
            delivery_mode: request.delivery_mode,
          },
        });
        return;
      }
    }
    const cleanup = await cleanupImprovementResources(root, run);
    if (!cleanup.cleaned) throw Object.assign(new Error(cleanup.error), { httpStatus: 409 });
    const current = events.getImprovement(run.run_id);
    if (current && ['proposed', 'building'].includes(current.state)) {
      await syncImprovementTask(root, current, 'hold');
      improvements.transition(events, current.run_id, { state: 'cancelled' });
    }
  }

  function leaseExpiry(minutes) {
    return new Date(Date.now() + Math.max(5, Number(minutes) || 30) * 60000).toISOString();
  }

  function renewQueueLeases() {
    const settings = events.getChangeQueueSettings();
    const now = new Date().toISOString();
    for (const request of events.listChangeRequests({ limit: 1000 })) {
      if (
        !['claimed', 'running', 'reviewing'].includes(request.status) ||
        request.lease_owner !== queueWorkerId
      )
        continue;
      events.updateChangeRequest(request.request_id, {
        lease_expires_at: leaseExpiry(settings.lease_minutes),
        heartbeat_at: now,
      });
    }
  }

  let recoveryRunning = false;
  async function recoverExpiredQueueWork() {
    if (recoveryRunning) return 0;
    recoveryRunning = true;
    try {
      const settings = events.getChangeQueueSettings();
      const now = Date.now();
      const stale = events.listChangeRequests({ limit: 1000 }).filter(request => {
        if (!['claimed', 'running', 'reviewing'].includes(request.status)) return false;
        const expiry = request.lease_expires_at
          ? Date.parse(request.lease_expires_at)
          : Date.parse(request.updated_at) + Number(settings.lease_minutes) * 60000;
        return Number.isFinite(expiry) && expiry <= now;
      });
      for (const candidate of stale) {
        const request = events.claimExpiredChangeRequest(candidate.request_id, {
          owner: queueWorkerId,
          now: new Date(now).toISOString(),
          leaseExpiresAt: leaseExpiry(settings.lease_minutes),
          fallbackCutoff: new Date(now - Number(settings.lease_minutes) * 60000).toISOString(),
        });
        if (!request) continue;
        const run = request.run_id ? events.getImprovement(request.run_id) : null;
        let recoverable = true;
        let reason = `worker lease expired while ${request.status}; requeued after dashboard recovery`;
        try {
          if (run?.workspace_path) {
            const snapshot = await git.worktreeSnapshot(run.workspace_path);
            if (snapshot.dirty) {
              recoverable = false;
              reason =
                'worker lease expired with a dirty worktree; manual inspection is required before retry';
            }
          }
          if (recoverable && request.attempts < MAX_AUTOMATIC_QUEUE_ATTEMPTS)
            await resetChangeRequestRun(request);
          else if (recoverable) {
            recoverable = false;
            reason = `worker lease expired after ${request.attempts} attempts; manual retry required`;
          }
        } catch (error) {
          recoverable = false;
          reason = `worker lease expired but recovery could not cleanly reset the run: ${error.message}`;
        }
        try {
          changequeue.update(
            events,
            request.request_id,
            {
              status: 'failed',
              error: reason,
              next_attempt_at: recoverable ? new Date().toISOString() : null,
              lease_owner: null,
              lease_expires_at: null,
              heartbeat_at: null,
            },
            site => isKnownTarget(root, site)
          );
          if (recoverable)
            changequeue.update(
              events,
              request.request_id,
              {
                status: 'queued',
                error: null,
                next_attempt_at: new Date().toISOString(),
                attempts: 0,
              },
              site => isKnownTarget(root, site)
            );
          events.record({
            event_type: recoverable ? 'change-request.recovered' : 'change-request.recovery_failed',
            source: 'fleet-dashboard',
            site_id: `site:${request.site}`,
            entity_type: 'change-request',
            entity_id: request.request_id,
            correlation_id: `change-request:${request.request_id}`,
            payload: { reason, previous_status: request.status, run_id: request.run_id },
          });
        } catch {
          /* another worker may have claimed it during recovery */
        }
      }
      return stale.length;
    } finally {
      recoveryRunning = false;
    }
  }

  let failedRecoveryRunning = false;
  function reconcileStalledImprovementRuns() {
    let changed = 0;
    // The request/run link can be lost during a crash between creating the
    // improvement row and writing change_requests.run_id. The improvement's
    // source_id is the second durable join key; inspect both so a failed
    // worker cannot leave a queued request permanently blocked by a stale
    // building run.
    for (const run of events.listImprovements({ source: 'fleet-dashboard', limit: 1000 })) {
      const request = run.source_id ? events.getChangeRequest(run.source_id) : null;
      if (!request || request.status === 'cancelled') {
        // A cancelled request must not leave its old building run in the busy
        // site set forever. Only close it once the agent is no longer running;
        // an active worker still gets to finish its current isolated process.
        if (
          ['proposed', 'building', 'review'].includes(run.state) &&
          run.agent?.status !== 'running'
        ) {
          try {
            improvements.transition(events, run.run_id, {
              state: 'cancelled',
              outcome: {
                ...(run.outcome || {}),
                cancelled_at: new Date().toISOString(),
                error: request
                  ? 'linked change request was cancelled before the improvement run completed'
                  : 'orphaned improvement run had no linked change request',
              },
            });
            changed += 1;
          } catch {
            /* preserve the audit row if another worker advanced it */
          }
        }
        continue;
      }
      if (request.run_id && request.run_id !== run.run_id) continue;
      if (['reported', 'deployed', 'measuring', 'proven', 'inconclusive'].includes(run.state)) {
        const previousStatus = request.status;
        const synced = syncChangeRequestFromRun(run);
        if (synced && synced.status !== previousStatus) {
          events.record({
            event_type: 'change-request.reconciled',
            source: 'fleet-dashboard',
            site_id: `site:${request.site}`,
            entity_type: 'change-request',
            entity_id: request.request_id,
            correlation_id: `change-request:${request.request_id}`,
            payload: {
              reason: 'queue projection lagged behind terminal improvement run',
              previous_status: previousStatus,
              status: synced.status,
              run_id: run.run_id,
            },
          });
        }
        continue;
      }
      if (run.state === 'cancelled' && request.status !== 'cancelled') {
        syncChangeRequestFromRun(run, 'cancelled');
        continue;
      }
      if (!run || run.state !== 'building') continue;
      const agentFailed = ['failed', 'timed-out'].includes(run.agent?.status);
      const reviewExhausted =
        ['review', 'reviewing'].includes(request.status) &&
        run.agent?.phase === 'reviewer' &&
        run.agent?.status === 'completed' &&
        Number(request.review_attempts || 0) >= MAX_AUTOMATIC_REVIEW_REPAIRS;
      if (!agentFailed && !reviewExhausted) continue;
      try {
        const failedRun = improvements.transition(events, run.run_id, {
          state: 'failed',
          outcome: {
            ...(run.outcome || {}),
            failed_at: new Date().toISOString(),
            error: agentFailed
              ? `implementation agent ended ${run.agent.status}`
              : 'automatic reviewer handoff exhausted its bounded repair attempts',
          },
        });
        syncChangeRequestFromRun(failedRun, 'failed');
        changed += 1;
      } catch {
        /* keep the existing audit record if a concurrent worker advanced it */
      }
    }
    return changed;
  }

  async function reconcileInterruptedWorkers() {
    let changed = 0;
    for (const run of events.listImprovements({ source: 'fleet-dashboard', limit: 1000 })) {
      if (run.state !== 'building' || run.agent?.status !== 'running') continue;
      // Do not race the provider child's close callback. During this short
      // handoff the container may already have reaped `codex`/`claude` while
      // this dashboard process still owns the live child and will persist its
      // terminal status itself.
      if (improvementAgent.isActive(run)) continue;
      // The durable row can outlive the dashboard process. Check the actual
      // isolated container rather than trusting the in-memory child map.
      if (await improvementAgent.workerProcessAlive(run)) continue;
      if (improvementAgent.workerStartupGraceActive(run)) continue;
      const request = run.source_id ? events.getChangeRequest(run.source_id) : null;
      let snapshot = null;
      try {
        snapshot = await git.worktreeSnapshot(run.workspace_path);
      } catch {
        /* missing worktree remains a real interrupted-worker failure */
      }
      // Preserve useful work when the provider died after editing but before
      // its close callback. The original interrupted state is still recorded
      // below as an event. Report-only work goes straight to deterministic
      // artifact delivery; code work retains the independent reviewer gate.
      if (request && snapshot?.dirty > 0) {
        try {
          const recoveryPath = interruptedWorkerRecoveryPath(request);
          events.updateImprovement(run.run_id, {
            agent: {
              status: 'completed',
              finished_at: new Date().toISOString(),
              recovered_from: 'interrupted-worker-with-dirty-worktree',
              error:
                recoveryPath === 'report-only'
                  ? 'provider exited after producing an isolated report; deterministic report recovery started'
                  : 'provider exited after producing an isolated diff; reviewer recovery started',
            },
          });
          if (recoveryPath === 'review' && request.status !== 'review')
            changequeue.update(
              events,
              request.request_id,
              {
                status: 'review',
                error: 'worker exited after producing an isolated diff; reviewer recovery started',
                next_attempt_at: null,
                lease_owner: null,
                lease_expires_at: null,
                heartbeat_at: null,
              },
              site => isKnownTarget(root, site)
            );
          events.record({
            event_type: 'improvement.worker_evidence_recovered',
            source: 'improvement-workbench',
            site_id: `site:${run.site}`,
            entity_type: 'improvement',
            entity_id: run.run_id,
            correlation_id: run.correlation_id,
            payload: {
              request_id: request.request_id,
              dirty_files: snapshot.dirty,
              diff_stat: snapshot.diff_stat,
              recovery_path: recoveryPath,
            },
          });
          if (recoveryPath === 'report-only') {
            Promise.resolve()
              .then(async () => {
                const recovered = events.getImprovement(run.run_id);
                if (!recovered) throw new Error('recovered report-only improvement disappeared');
                await deliverAutomatically(recovered);
              })
              .catch(error => recordAutoReviewFailure(request.request_id, error));
          } else {
            autoReviewRequest(request.request_id).catch(error =>
              recordAutoReviewFailure(request.request_id, error)
            );
          }
          changed += 1;
          continue;
        } catch {
          /* fall through to the durable failure path below */
        }
      }
      try {
        const failedRun = improvements.transition(events, run.run_id, {
          state: 'failed',
          outcome: {
            ...(run.outcome || {}),
            failed_at: new Date().toISOString(),
            error: 'worker process is no longer present in its isolated container',
          },
        });
        events.updateImprovement(run.run_id, {
          agent: {
            status: 'interrupted',
            finished_at: new Date().toISOString(),
            error: 'worker process is no longer present in its isolated container',
          },
        });
        const failedRequest = syncChangeRequestFromRun(failedRun, 'failed');
        if (failedRequest && failedRequest.status === 'failed') {
          const retryable = failedRequest.attempts < MAX_AUTOMATIC_QUEUE_ATTEMPTS;
          changequeue.update(
            events,
            failedRequest.request_id,
            {
              next_attempt_at: retryable ? new Date().toISOString() : null,
              lease_owner: null,
              lease_expires_at: null,
              heartbeat_at: null,
            },
            site => isKnownTarget(root, site)
          );
        }
        events.record({
          event_type: 'improvement.worker_interrupted',
          source: 'fleet-dashboard',
          site_id: `site:${run.site}`,
          entity_type: 'improvement',
          entity_id: run.run_id,
          correlation_id: run.correlation_id,
          payload: {
            request_id: request?.request_id || null,
            error: 'worker process is no longer present in its isolated container',
          },
        });
        changed += 1;
      } catch {
        /* preserve the audit row if a concurrent worker advanced it */
      }
    }
    return changed;
  }

  function failedRequestReason(request, run) {
    if (run?.outcome?.error) return String(run.outcome.error);
    if (run?.validation?.passed === false) {
      const failedGates = Object.entries(run.validation.policy?.status || {})
        .filter(([, status]) => status === 'fail')
        .map(([gate]) => gate);
      if (failedGates.length) return `quality gates failed: ${failedGates.join(', ')}`;
      return 'quality gates did not pass';
    }
    if (run?.agent?.status === 'failed' || run?.agent?.status === 'timed-out')
      return `implementation agent ended ${run.agent.status}`;
    if (run?.agent?.phase === 'reviewer' && run?.agent?.status === 'completed')
      return 'automatic reviewer handoff ended without a durable reason';
    if (run?.state === 'building')
      return 'request is failed while its linked improvement run remains building; manual worker inspection is required';
    if (run)
      return `linked improvement run ${run.run_id} failed without a recorded reason; manual inspection is required`;
    return 'failed request has no linked improvement run or recorded reason; manual inspection is required';
  }

  function retryableQueueFailure(request, run) {
    const createdAt = Date.parse(request?.created_at || '');
    if (Number.isFinite(createdAt) && Date.now() - createdAt > AUTOMATIC_RETRY_MAX_AGE_MS)
      return false;
    if (
      Number(request?.review_attempts || 0) >= MAX_AUTOMATIC_REVIEW_REPAIRS &&
      /reviewer handoff|automatic reviewer/i.test(
        `${request?.error || ''} ${failedRequestReason(request, run)}`
      )
    )
      return false;
    if (run?.validation && validationInfrastructureBlock(run.validation)) return false;
    const text = `${request?.error || ''} ${failedRequestReason(request, run)}`;
    return shouldRetryQueueFailure(text, run?.validation || null);
  }

  function scheduleFailedRequestRetry(
    request,
    reason = request?.error || 'bounded automatic retry'
  ) {
    if (!request || request.status !== 'failed') return false;
    if (request.next_attempt_at || Number(request.attempts || 0) >= MAX_AUTOMATIC_QUEUE_ATTEMPTS)
      return false;
    const run = request.run_id ? events.getImprovement(request.run_id) : null;
    if (!retryableQueueFailure(request, run)) return false;
    const nextAttempt = new Date(Date.now() + 5 * 60000).toISOString();
    try {
      changequeue.update(events, request.request_id, { next_attempt_at: nextAttempt }, site =>
        isKnownTarget(root, site)
      );
      events.record({
        event_type: 'change-request.retry-scheduled',
        source: 'fleet-dashboard',
        site_id: `site:${request.site}`,
        entity_type: 'change-request',
        entity_id: request.request_id,
        correlation_id: `change-request:${request.request_id}`,
        payload: {
          reason: 'bounded retry scheduled after recoverable worker/reviewer failure',
          failure: String(reason).slice(0, 1000),
          attempts: Number(request.attempts || 0),
          max_automatic_attempts: MAX_AUTOMATIC_QUEUE_ATTEMPTS,
          next_attempt_at: nextAttempt,
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  function reconcileFailedRequestErrors() {
    let changed = 0;
    for (const request of events.listChangeRequests({ status: 'failed', limit: 1000 })) {
      const run = request.run_id ? events.getImprovement(request.run_id) : null;
      try {
        const followup = executiveFailureFollowup.upsert(events, request, run);
        if (followup.changed) {
          events.record({
            event_type: followup.created
              ? 'change-request.failure-followup-created'
              : 'change-request.failure-followup-updated',
            source: 'fleet-dashboard',
            site_id: request.site ? `site:${request.site}` : null,
            entity_type: 'change-request',
            entity_id: request.request_id,
            correlation_id: `change-request:${request.request_id}`,
            payload: {
              work_id: followup.item.work_id,
              owner: followup.item.owner,
              kind: followup.item.kind,
              priority: followup.item.priority,
            },
          });
          changed += 1;
        }
      } catch {
        // A failure follow-up is useful recovery metadata, but it must never
        // prevent queue reconciliation from diagnosing or retrying a request.
      }
      // A report-only run is complete work. Repair the queue projection rather
      // than asking an operator to retry a missing worktree.
      if (run?.state === 'reported') {
        const synced = syncChangeRequestFromRun(run);
        if (synced?.status === 'verified') {
          events.record({
            event_type: 'change-request.reconciled',
            source: 'fleet-dashboard',
            site_id: `site:${request.site}`,
            entity_type: 'change-request',
            entity_id: request.request_id,
            correlation_id: `change-request:${request.request_id}`,
            payload: { reason: 'linked report run was already reported', run_id: run.run_id },
          });
          changed += 1;
        }
        continue;
      }
      if (request.error) continue;
      const error = failedRequestReason(request, run);
      try {
        const diagnosed = changequeue.update(
          events,
          request.request_id,
          { status: 'failed', error },
          site => isKnownTarget(root, site)
        );
        scheduleFailedRequestRetry(diagnosed, error);
        events.record({
          event_type: 'change-request.failure-diagnosed',
          source: 'fleet-dashboard',
          site_id: `site:${request.site}`,
          entity_type: 'change-request',
          entity_id: request.request_id,
          correlation_id: `change-request:${request.request_id}`,
          payload: { error, run_id: request.run_id || null, historical_reason_missing: true },
        });
        changed += 1;
      } catch {
        /* another worker may have advanced the request */
      }
    }
    return changed;
  }

  function reportOnlyEvidenceReady(run) {
    const logFile = run?.agent?.log;
    if (!logFile) return false;
    try {
      const text = fs.readFileSync(logFile, 'utf8').slice(-60000);
      return improvements.reportOnlyEvidenceReady(text);
    } catch {
      return false;
    }
  }

  async function reconcileFalseFailedReportRuns() {
    let changed = 0;
    for (const request of events.listChangeRequests({ status: 'failed', limit: 1000 })) {
      if (request.delivery_mode !== 'report_only' || !request.run_id) continue;
      let run = events.getImprovement(request.run_id);
      if (
        run?.state === 'failed' &&
        ['running', 'interrupted'].includes(run.agent?.status) &&
        reportOnlyEvidenceReady(run) &&
        !(await improvementAgent.workerProcessAlive(run))
      ) {
        events.updateImprovement(run.run_id, {
          agent: {
            status: 'completed',
            exit_code: 0,
            finished_at: new Date().toISOString(),
            recovered_from: run.agent.status,
            recovery_reason: 'report-only evidence was durable after the liveness false failure',
          },
        });
        run = events.getImprovement(run.run_id);
        events.record({
          event_type: 'improvement.agent_recovered',
          source: 'fleet-dashboard',
          site_id: `site:${run.site}`,
          entity_type: 'improvement',
          entity_id: run.run_id,
          correlation_id: run.correlation_id,
          payload: {
            request_id: request.request_id,
            reason: 'report-only evidence was durable after the liveness false failure',
          },
        });
      }
      // A report-only implementation already completed before an old
      // dashboard process sent it through the model reviewer. A reviewer
      // rejection cannot invalidate a read-only evidence artifact, provided
      // the implementation log contains the required report sections.
      const reviewerRejectedAfterSuccessfulWorker =
        run?.state === 'failed' &&
        run.agent?.phase === 'reviewer' &&
        run.agent?.status === 'completed' &&
        Number(run.agent?.exit_code) === 0 &&
        run.outcome?.phase === 'reviewer' &&
        reportOnlyEvidenceReady(run);
      if (
        !improvements.canRecoverReportOnly(run, {
          state: 'reported',
          recover_report_only: true,
          delivery_mode: request.delivery_mode,
        }) ||
        (reviewerRejectedAfterSuccessfulWorker && request.delivery_mode !== 'report_only')
      )
        continue;
      try {
        await deliverAutomatically(run);
        events.record({
          event_type: 'change-request.reconciled',
          source: 'fleet-dashboard',
          site_id: `site:${request.site}`,
          entity_type: 'change-request',
          entity_id: request.request_id,
          correlation_id: `change-request:${request.request_id}`,
          payload: {
            reason: reviewerRejectedAfterSuccessfulWorker
              ? 'report-only implementation was complete; reviewer rejection was non-blocking'
              : 'completed report-only worker was falsely marked failed by the liveness probe',
            run_id: run.run_id,
          },
        });
        changed += 1;
      } catch (error) {
        events.record({
          event_type: 'change-request.reconciliation_failed',
          source: 'fleet-dashboard',
          site_id: `site:${request.site}`,
          entity_type: 'change-request',
          entity_id: request.request_id,
          correlation_id: `change-request:${request.request_id}`,
          payload: {
            reason: 'report-only recovery could not finalize the completed worker',
            run_id: run.run_id,
            error: String(error.message || error).slice(0, 1000),
          },
        });
      }
    }
    return changed;
  }

  function reconcileInfrastructureBlockedReviews() {
    let changed = 0;
    for (const request of events.listChangeRequests({ limit: 1000 })) {
      if (!['failed', 'review'].includes(request.status)) continue;
      if (!request.run_id) continue;
      const run = events.getImprovement(request.run_id);
      // An operator-triggered revalidation deliberately reopens the preserved
      // run in building. Do not let the periodic failed-row reconciliation
      // immediately move that work back to review while its gates execute.
      if (run?.state === 'building') continue;
      // The durable outcome marker is authoritative when quality policy
      // preserved an implementation because infrastructure was unavailable,
      // even if the validation payload itself was otherwise passed.
      if (
        run?.outcome?.infrastructure_blocked !== true &&
        (!run?.validation || !validationInfrastructureBlock(run.validation))
      )
        continue;
      const recovered = preserveInfrastructureBlockedReview(request, run, {
        message:
          'previous validation run recorded an infrastructure failure; revalidation is required',
        validation: run.validation,
        noAutomaticRepair: true,
      });
      if (recovered) changed += 1;
    }
    return changed;
  }

  async function recoverFailedQueueWork() {
    if (failedRecoveryRunning) return 0;
    failedRecoveryRunning = true;
    try {
      await reconcileInterruptedWorkers();
      await reconcileFalseFailedReportRuns();
      // Preserve valid worker output from historical validation-infrastructure
      // failures before normal retry/tombstone handling sees those requests.
      reconcileInfrastructureBlockedReviews();
      // A prior dashboard process may already have persisted the liveness
      // failure before this process came back. Recover those durable rows too
      // when their isolated checkout still contains useful work; otherwise
      // the retry path would strand the evidence or detach it into a fresh
      // empty run.
      for (const request of events.listChangeRequests({ status: 'failed', limit: 1000 })) {
        const run = request.run_id ? events.getImprovement(request.run_id) : null;
        await recoverInterruptedWorkerEvidence(request, run);
      }
      reconcileStalledImprovementRuns();
      reconcileFailedRequestErrors();
      // Older failed rows were historically left with no next_attempt_at,
      // which made them permanent queue tombstones. Keep those failure rows
      // intact for audit, but give transient worker/reviewer/build failures a
      // bounded path back into the normal queue.
      for (const request of events.listChangeRequests({ status: 'failed', limit: 1000 }))
        scheduleFailedRequestRetry(request);
      // Older versions left retry timestamps on failures that are no longer
      // eligible. Clear only the retry lease—not the request or its audit
      // events—so the dashboard cannot display a stale failure as pending work.
      for (const request of events.listChangeRequests({ status: 'failed', limit: 1000 })) {
        if (!request.next_attempt_at) continue;
        const run = request.run_id ? events.getImprovement(request.run_id) : null;
        if (retryableQueueFailure(request, run)) continue;
        try {
          changequeue.update(events, request.request_id, { next_attempt_at: null }, site =>
            isKnownTarget(root, site)
          );
          events.record({
            event_type: 'change-request.retry_blocked',
            source: 'fleet-dashboard',
            site_id: `site:${request.site}`,
            entity_type: 'change-request',
            entity_id: request.request_id,
            correlation_id: `change-request:${request.request_id}`,
            payload: {
              reason:
                Number.isFinite(Date.parse(request.created_at || '')) &&
                Date.now() - Date.parse(request.created_at) > AUTOMATIC_RETRY_MAX_AGE_MS
                  ? 'stale failure requires explicit owner requeue'
                  : 'automatic retry budget exhausted or failure is non-retryable',
              run_id: request.run_id || null,
            },
          });
        } catch {
          /* another recovery pass may already have cleared it */
        }
      }
      const now = Date.now();
      const candidates = events
        .listChangeRequests({ status: 'failed', limit: 1000 })
        .filter(request => {
          const retryAt = Date.parse(request.next_attempt_at || '');
          return (
            request.attempts < MAX_AUTOMATIC_QUEUE_ATTEMPTS &&
            retryableQueueFailure(
              request,
              request.run_id ? events.getImprovement(request.run_id) : null
            ) &&
            Number.isFinite(retryAt) &&
            retryAt <= now
          );
        });
      for (const request of candidates) {
        const run = request.run_id ? events.getImprovement(request.run_id) : null;
        try {
          if (run?.workspace_path) {
            const snapshot = await git.worktreeSnapshot(run.workspace_path);
            if (snapshot.dirty) {
              events.record({
                event_type: 'change-request.retry_blocked',
                source: 'fleet-dashboard',
                site_id: `site:${request.site}`,
                entity_type: 'change-request',
                entity_id: request.request_id,
                correlation_id: `change-request:${request.request_id}`,
                payload: { reason: 'failed worker left a dirty worktree', run_id: request.run_id },
              });
              changequeue.update(events, request.request_id, { next_attempt_at: null }, site =>
                isKnownTarget(root, site)
              );
              continue;
            }
          }
          await resetChangeRequestRun(request);
          const queued = changequeue.update(
            events,
            request.request_id,
            {
              status: 'queued',
              error: null,
              next_attempt_at: new Date().toISOString(),
              lease_owner: null,
              lease_expires_at: null,
              heartbeat_at: null,
            },
            site => isKnownTarget(root, site)
          );
          events.record({
            event_type: 'change-request.retry-scheduled',
            source: 'fleet-dashboard',
            site_id: `site:${request.site}`,
            entity_type: 'change-request',
            entity_id: request.request_id,
            correlation_id: `change-request:${request.request_id}`,
            payload: { attempts: queued.attempts, previous_run_id: request.run_id },
          });
        } catch (error) {
          changequeue.update(
            events,
            request.request_id,
            { next_attempt_at: null, error: `automatic retry blocked: ${error.message}` },
            site => isKnownTarget(root, site)
          );
          events.record({
            event_type: 'change-request.retry_blocked',
            source: 'fleet-dashboard',
            site_id: `site:${request.site}`,
            entity_type: 'change-request',
            entity_id: request.request_id,
            correlation_id: `change-request:${request.request_id}`,
            payload: { reason: error.message, run_id: request.run_id },
          });
        }
      }
      return candidates.length;
    } finally {
      failedRecoveryRunning = false;
    }
  }

  async function pickupChangeRequests(max) {
    // Start the audit-preserving recovery pass, but do not make fresh queued
    // work wait behind every historical failure. A completed recovery pass is
    // still awaited when it is fast; otherwise it continues under its own
    // single-flight guard while the worker queue makes progress.
    const recovery = recoverFailedQueueWork().catch(() => 0);
    await Promise.race([
      recovery,
      new Promise(resolve => setTimeout(resolve, QUEUE_RECOVERY_WAIT_MS)),
    ]);
    const settings = events.getChangeQueueSettings();
    const running = events
      .listChangeRequests({ limit: 1000 })
      .filter(r => ['claimed', 'running', 'reviewing'].includes(r.status)).length;
    const slots = Math.max(0, Number(max ?? settings.max_concurrent) - running);
    // A deployed run is complete work, not an active checkout. Keeping it in
    // this set permanently strands every later request for that site because
    // automatic deployment clears measurement_due and the run never leaves
    // `deployed`. Only states with a live worktree or an open measurement
    // window should block a concurrent pickup.
    const busySites = new Set(
      events
        .listImprovements({ limit: 1000 })
        .filter(r => ['building', 'review'].includes(r.state))
        .map(r => r.site)
    );
    const measuringSites = new Set(
      events
        .listImprovements({ limit: 1000 })
        .filter(r => r.state === 'measuring')
        .map(r => r.site)
    );
    // Pull a wider candidate window so a code change that must wait for a
    // measurement window does not hide a later report-only request that can
    // safely run on the same site. `pick` only reads queued rows; claiming
    // still happens inside dispatchChangeRequest.
    const candidates = changequeue.pick(events, { max: Math.min(100, Math.max(slots, 1) * 25) });
    const picked = candidates
      .filter(request => {
        if (busySites.has(request.site)) return false;
        if (measuringSites.has(request.site) && request.delivery_mode !== 'report_only')
          return false;
        busySites.add(request.site);
        return true;
      })
      .slice(0, slots);
    const results = [];
    for (const request of picked) {
      try {
        results.push(await dispatchChangeRequest(request));
      } catch (error) {
        results.push({ request_id: request.request_id, error: error.message });
      }
    }
    return { picked: picked.length, results, settings };
  }

  // Keep the operator-facing queue honest when work is advanced from the
  // Improvement workbench. The queue is not allowed to claim delivery based
  // on agent output alone; committed/deployed/verified are derived from the
  // linked improvement record.
  function syncChangeRequestFromRun(run, preferredStatus) {
    if (!run || run.source !== 'fleet-dashboard' || !run.source_id) return null;
    const request = events.getChangeRequest(run.source_id);
    if (!request || request.status === 'cancelled') return request;
    let target = preferredStatus;
    if (!target) {
      if (['proven', 'inconclusive'].includes(run.state)) target = 'verified';
      else if (['deployed', 'measuring'].includes(run.state)) target = 'deployed';
      else if (run.state === 'review') target = 'review';
      else if (run.state === 'failed') target = 'failed';
      else if (run.state === 'reported') target = 'verified';
    }
    if (!target) return request;
    if (target === request.status) {
      // Never erase the only durable explanation for a failed request. Older
      // sync paths cleared it when the run and queue were already both failed,
      // which made the audit trail look like an unexplained worker failure.
      if (target === 'failed') {
        const failure = String(
          run.outcome?.error || request.error || `improvement run ${run.run_id} failed`
        );
        if (request.error === failure) return request;
        try {
          return changequeue.update(events, request.request_id, { error: failure }, site =>
            isKnownSite(root, site)
          );
        } catch {
          return request;
        }
      }
      if (!request.error) return request;
      try {
        return changequeue.update(events, request.request_id, { error: null }, site =>
          isKnownSite(root, site)
        );
      } catch {
        return request;
      }
    }
    if (target === 'verified' && run.state === 'reported') {
      try {
        return changequeue.reconcileVerified(events, request.request_id, site =>
          isKnownTarget(root, site)
        );
      } catch {
        return request;
      }
    }
    if (target === 'cancelled') {
      try {
        const cancelled = changequeue.update(
          events,
          request.request_id,
          {
            status: 'cancelled',
            error:
              run.outcome?.error ||
              request.error ||
              `linked improvement run ${run.run_id} was cancelled`,
            lease_owner: null,
            lease_expires_at: null,
            heartbeat_at: null,
          },
          site => isKnownTarget(root, site)
        );
        events.record({
          event_type: 'change-request.reconciled',
          source: 'fleet-dashboard',
          site_id: `site:${request.site}`,
          entity_type: 'change-request',
          entity_id: request.request_id,
          correlation_id: `change-request:${request.request_id}`,
          payload: {
            reason: 'linked improvement run was cancelled',
            previous_status: request.status,
            status: cancelled.status,
            run_id: run.run_id,
          },
        });
        return cancelled;
      } catch {
        return request;
      }
    }
    if (target === 'failed') {
      try {
        const failure = String(
          run.outcome?.error || request.error || `improvement run ${run.run_id} failed`
        );
        return changequeue.update(
          events,
          request.request_id,
          { status: 'failed', error: failure },
          site => isKnownSite(root, site)
        );
      } catch {
        return request;
      }
    }
    const order = [
      'queued',
      'claimed',
      'running',
      'reviewing',
      'review',
      'committed',
      'deployed',
      'verified',
    ];
    const currentIndex = order.indexOf(request.status);
    const targetIndex = order.indexOf(target);
    if (currentIndex < 0 || targetIndex < 0 || targetIndex < currentIndex) return request;
    let current = request;
    for (const next of order.slice(currentIndex + 1, targetIndex + 1)) {
      try {
        current = changequeue.update(
          events,
          current.request_id,
          { status: next, error: null },
          site => isKnownSite(root, site)
        );
      } catch {
        break;
      }
    }
    return current;
  }

  async function recoverInterruptedWorkerEvidence(request, run) {
    if (!request || !run?.workspace_path) return false;
    if (run.outcome?.error !== improvements.FALSE_LIVENESS_ERROR) return false;
    let snapshot;
    try {
      snapshot = await git.worktreeSnapshot(run.workspace_path);
    } catch {
      return false;
    }
    if (!snapshot?.dirty) return false;

    try {
      let recovered = run;
      if (run.state === 'failed') {
        recovered = improvements.transition(events, run.run_id, {
          state: 'building',
          recover_worker: true,
          worktree_dirty: true,
          outcome: {
            ...(run.outcome || {}),
            recovered_at: new Date().toISOString(),
            recovery_reason: 'interrupted worker left a dirty isolated worktree',
          },
        });
      }
      events.updateImprovement(recovered.run_id, {
        agent: {
          ...(recovered.agent || {}),
          status: 'completed',
          finished_at: new Date().toISOString(),
          recovered_from: 'interrupted-worker-with-dirty-worktree',
          error: 'provider exited after producing an isolated diff; reviewer recovery started',
        },
      });
      const currentRequest = events.getChangeRequest(request.request_id);
      if (currentRequest && currentRequest.status !== 'review')
        changequeue.update(
          events,
          request.request_id,
          {
            status: 'review',
            error: 'worker exited after producing an isolated diff; reviewer recovery started',
            next_attempt_at: null,
            lease_owner: null,
            lease_expires_at: null,
            heartbeat_at: null,
          },
          site => isKnownTarget(root, site)
        );
      events.record({
        event_type: 'improvement.worker_evidence_recovered',
        source: 'improvement-workbench',
        site_id: `site:${recovered.site}`,
        entity_type: 'improvement',
        entity_id: recovered.run_id,
        correlation_id: recovered.correlation_id,
        payload: {
          request_id: request.request_id,
          dirty_files: snapshot.dirty,
          diff_stat: snapshot.diff_stat,
          previous_state: run.state,
        },
      });
      autoReviewRequest(request.request_id).catch(error =>
        recordAutoReviewFailure(request.request_id, error)
      );
      return true;
    } catch {
      return false;
    }
  }

  const activeAutomaticReviews = new Map();

  async function validateImprovementForDelivery(item) {
    if (item.state !== 'building')
      throw Object.assign(new Error(`cannot validate from ${item.state}`), { httpStatus: 409 });
    if (!item.sandbox?.instance)
      throw Object.assign(new Error('isolated sandbox is not running'), { httpStatus: 409 });
    const workspace = await git.worktreeSnapshot(item.workspace_path);
    if (workspace.dirty)
      throw Object.assign(new Error('commit the worktree changes before validation'), {
        httpStatus: 409,
      });
    if (improvementAgent.status(root, item).running)
      throw Object.assign(new Error('wait for the implementation agent to finish'), {
        httpStatus: 409,
      });
    await devsandbox.prepareDependencies(item.sandbox.instance);
    let previewStartError = null;
    try {
      await devsandbox.devStart(item.sandbox.instance);
    } catch (error) {
      previewStartError = String(error.message || error);
    }
    let validation = await devsandbox.validate(item.sandbox.instance);
    validation.commit = workspace.commit;
    validation.preview = await validatePreview(item.sandbox.instance, item.sandbox.devUrl);
    if (previewStartError) validation.preview.startup_error = previewStartError;
    validation.browser = await devsandbox.browserAudit(root, item.sandbox.instance, item.site);
    validation = applyQualityPolicy(root, item.site, validation);
    const changed = events.updateImprovement(item.run_id, {
      validation,
      preview_url: validation.preview.url || item.sandbox.devUrl,
    });
    events.record({
      event_type: 'improvement.validated',
      source: 'improvement-workbench',
      site_id: `site:${item.site}`,
      entity_type: 'improvement',
      entity_id: item.run_id,
      correlation_id: item.correlation_id,
      payload: { passed: validation.passed, checks: validation.checks, automated: true },
    });
    return { run: changed, validation };
  }

  function findWorktreeTask(workspacePath, file) {
    for (const column of tasks.COLUMNS) {
      const candidate = path.join(workspacePath, 'ops', 'tasks', column, file);
      if (fs.existsSync(candidate)) return { column, path: candidate };
    }
    return null;
  }

  function normalizeTaskRoutingWorktree(run, request) {
    if (!String(request?.action_key || '').startsWith('task-routing:')) return false;
    const workTask = findWorktreeTask(run.workspace_path, run.task_file);
    if (!workTask) throw new Error(`routing task ${run.task_file} is missing from worktree`);
    const parsed = tasks.parseTask(fs.readFileSync(workTask.path, 'utf8'));
    const available = installedSiteRoles(root, request.site);
    const requestedRole = request.assigned_role || parsed.meta.assigned_role;
    const effectiveRole =
      assignedRoleForSite(parsed.meta.type || request.category, requestedRole, available, {
        delivery_mode: request.delivery_mode,
      }) || assignedRoleForType(parsed.meta.type || request.category, requestedRole);
    if (!effectiveRole || effectiveRole === parsed.meta.assigned_role) return false;

    const previousRole = parsed.meta.assigned_role || null;
    const stamp = new Date().toISOString().slice(0, 10);
    const note = [
      '',
      '## Assignment normalization record',
      '',
      `- Normalized: ${stamp}`,
      `- Requested role: ${requestedRole || 'unassigned'}`,
      `- Effective installed role: ${effectiveRole}`,
      `- Previous task role: ${previousRole || 'unassigned'}`,
      '- Reason: the requested role is not installed for this site; the queue selected the nearest installed owner for this task type.',
      '- Rollback: restore the previous role only after that role is installed and the task is intentionally reassigned.',
      '',
    ].join('\n');
    fs.writeFileSync(
      workTask.path,
      tasks.serializeTask({ ...parsed.meta, assigned_role: effectiveRole }, `${parsed.body}${note}`)
    );
    events.record({
      event_type: 'change-request.role_normalized_in_worktree',
      source: 'fleet-dashboard',
      site_id: `site:${request.site}`,
      entity_type: 'change-request',
      entity_id: request.request_id,
      correlation_id: `change-request:${request.request_id}`,
      payload: {
        run_id: run.run_id,
        previous_role: previousRole,
        requested_role: requestedRole || null,
        effective_role: effectiveRole,
        installed_roles: available,
      },
    });
    return true;
  }

  async function deliverTaskRoutingAutomatically(item, request) {
    const workTask = findWorktreeTask(item.workspace_path, item.task_file);
    if (!workTask) throw new Error(`routing task ${item.task_file} is missing from worktree`);
    const canonicalTask = findImprovementTask(root, item);
    if (!canonicalTask) throw new Error(`routing task ${item.task_file} is missing from site`);
    const canonicalPath = path.join(
      root,
      'sites',
      item.site,
      'ops',
      'tasks',
      canonicalTask.column,
      item.task_file
    );
    const canonicalStatus = await git.status(root, item.site);
    const canonicalRel = `ops/tasks/${canonicalTask.column}/${item.task_file}`;
    if (canonicalStatus.files.some(file => file.path === canonicalRel))
      throw new Error(`canonical routing task is already dirty: ${canonicalRel}`);
    const worker = tasks.parseTask(fs.readFileSync(workTask.path, 'utf8'));
    const current = tasks.parseTask(fs.readFileSync(canonicalPath, 'utf8'));
    if (worker.body !== current.body)
      throw new Error('routing worker changed task body; refusing metadata-only delivery');

    // Routing is an auditable ops metadata change, not a production-code
    // improvement. Merge only worker metadata onto the current canonical task
    // so completion timestamps and concurrent board lifecycle fields survive.
    const lifecycle = new Map(
      ['task_id', 'created', 'started_at', 'completed_at', 'measurement_due'].map(key => [
        key,
        current.meta[key],
      ])
    );
    const mergedMeta = { ...current.meta, ...worker.meta };
    for (const [key, value] of lifecycle) {
      if (value !== undefined) mergedMeta[key] = value;
    }
    fs.writeFileSync(canonicalPath, tasks.serializeTask(mergedMeta, current.body));
    const committed = await git.commit(
      root,
      item.site,
      [canonicalRel],
      `chore: route ${item.title}`
    );
    const pushed = await git.push(root, item.site);
    const reported = improvements.transition(events, item.run_id, {
      state: 'reported',
      deployment_id: committed.out || null,
      outcome: {
        measured_at: new Date().toISOString(),
        kind: 'task-routing',
        request_id: request.request_id,
        commit: pushed.out || committed.out || null,
        assigned_role: request.assigned_role,
      },
    });
    const verified = syncChangeRequestFromRun(reported);
    events.updateChangeRequest(request.request_id, {
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
    });
    emitChangeNotification('verified', verified, reported, pushed.out || committed.out || null);
    const cleaned = await cleanupImprovementResources(root, reported);
    if (!cleaned.cleaned) throw new Error(cleaned.error);
    return { run: reported, deployment: { committed, pushed } };
  }

  async function deliverAutomatically(item) {
    const request = events.getChangeRequest(item.source_id);
    const claimed = claimAutomaticDelivery(item);
    if (!claimed) {
      return { run: events.getImprovement(item.run_id), deduplicated: true };
    }
    item = claimed;
    try {
      return await deliverClaimedAutomatically(item, request);
    } catch (error) {
      // A failed validation, report, routing commit, or deployment must not
      // hold the durable claim until its safety timeout. The failure remains
      // fully auditable; only the retry lock is released.
      releaseAutomaticDeliveryClaim(events.getImprovement(item.run_id));
      throw error;
    }
  }

  async function deliverClaimedAutomatically(item, request) {
    if (String(request?.action_key || '').startsWith('task-routing:'))
      return deliverTaskRoutingAutomatically(item, request);
    if (request?.delivery_mode === 'report_only') {
      let workspace = await git.worktreeSnapshot(item.workspace_path);
      if (workspace.dirty) {
        workspace = await git.commitWorktree(item.workspace_path, `report: ${item.title}`);
      }
      const diff = await git.worktreeDiff(item.workspace_path);
      const agentStatus = improvementAgent.status(root, item);
      const artifact = writeReportArtifact(root, request, item, diff.text, agentStatus.log_tail);
      const reported = improvements.transition(events, item.run_id, {
        state: 'reported',
        ...(item.state === 'failed'
          ? { recover_report_only: true, delivery_mode: 'report_only' }
          : {}),
        outcome: {
          measured_at: new Date().toISOString(),
          kind: 'report-only',
          artifact: artifact.url,
          commit: workspace.commit,
        },
      });
      await syncImprovementTask(root, reported, 'done');
      const cleaned = await cleanupImprovementResources(root, reported);
      if (!cleaned.cleaned) throw new Error(cleaned.error);
      const verified = syncChangeRequestFromRun(reported);
      emitChangeNotification('report ready', verified, reported, artifact.url);
      return { run: reported, report: artifact };
    }
    // Reviewer callbacks and the restart recovery sweep can both observe the
    // same PASS marker. The first delivery attempt may already have completed
    // deterministic validation and persisted `review`; make that handoff
    // idempotent instead of trying to validate a second time from `review`.
    let reviewRun = item;
    if (shouldValidateBeforeDelivery(item)) {
      const validated = await validateImprovementForDelivery(item);
      if (validated.validation.passed !== true) {
        const infrastructureBlock = validationInfrastructureBlock(validated.validation);
        throw Object.assign(new Error('quality gates did not pass'), {
          httpStatus: 409,
          validation: validated.validation,
          noAutomaticRepair: infrastructureBlock,
        });
      }
      reviewRun = improvements.transition(events, item.run_id, {
        state: 'review',
        validation: validated.validation,
      });
      await syncImprovementTask(root, reviewRun, 'done');
    }
    const reviewRequest = events.getChangeRequest(reviewRun.source_id);
    if (reviewRequest?.delivery_mode === 'pull_request') {
      const published = await git.publishWorktree(
        root,
        reviewRun.site,
        reviewRun.workspace_path,
        reviewRun.branch
      );
      const committed = changequeue.update(
        events,
        reviewRequest.request_id,
        {
          status: 'committed',
          error: null,
          lease_owner: null,
          lease_expires_at: null,
          heartbeat_at: null,
        },
        site => isKnownTarget(root, site)
      );
      const publishedRun = events.updateImprovement(reviewRun.run_id, {
        approval: { delivery_mode: 'pull_request', pull_request: published },
      });
      events.record({
        event_type: 'improvement.pull_request_published',
        source: 'improvement-workbench',
        site_id: `site:${reviewRun.site}`,
        entity_type: 'improvement',
        entity_id: reviewRun.run_id,
        correlation_id: reviewRun.correlation_id,
        payload: published,
      });
      emitChangeNotification(
        'pull request ready',
        committed,
        publishedRun,
        published.compare_url || published.branch
      );
      return { run: publishedRun, pull_request: published };
    }
    const deployed = await git.deployWorktree(
      root,
      reviewRun.site,
      reviewRun.workspace_path,
      reviewRun.branch
    );
    const changed = improvements.transition(events, reviewRun.run_id, {
      state: 'deployed',
      deployment_id: deployed.commit,
      measurement_due: improvements.measurementDate(14),
      approval: {
        approved_at: new Date().toISOString(),
        access: 'automatic-reviewer',
        confirmation: 'automatic-reviewer',
      },
      production_before: deployed.before,
    });
    syncChangeRequestFromRun(changed, 'deployed');
    emitChangeNotification(
      'deployed',
      events.getChangeRequest(changed.source_id),
      changed,
      deployed.commit
    );
    events.updateChangeRequest(changed.source_id, {
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
    });
    if (reviewRun.sandbox?.instance) {
      try {
        await devsandbox.stop(reviewRun.sandbox.instance);
      } catch {
        /* already stopped */
      }
    }
    return { run: changed, deployment: deployed };
  }

  function automaticReviewFeedback(rootPath, run, error) {
    const status = run ? improvementAgent.status(rootPath, run) : null;
    const log = String(status?.log_tail || '').trim();
    return `${String(error?.message || error || 'automatic review failed')}\n${log}`.slice(-8000);
  }

  function reviewTaskBodyForRequest(request, task) {
    const taskBody = task?.body || request.body;
    if (!String(request.action_key || '').startsWith('task-routing:')) return taskBody;
    // A routing request intentionally changes assignment metadata on an
    // existing board item; its underlying task may describe a much larger
    // future implementation. The reviewer must validate the routing request,
    // not reject the metadata-only handoff for not already completing that
    // future implementation.
    return [
      'TASK-ROUTING REVIEW CONTRACT',
      "Review the requested queue-routing metadata change only. Do not require the underlying task's implementation acceptance criteria to be completed in this run.",
      `The effective installed queue role for this request is ${request.assigned_role || 'engineer'}. If the diff contains a fleet-wide alias that is not installed on this site, treat the normalized installed role as the correct result when the substitution and rollback record are present.`,
      'PASS when the diff edits the existing task in place, assigns an installed effective role, records the requested role/substitution and rollback metadata where applicable, and contains no unrelated production changes.',
      'FAIL only when the existing task was not edited, the effective role is not installed, rollback metadata is missing when needed, or unrelated changes were made.',
      '',
      `Routing request:\n${String(request.body || '').slice(0, 12000)}`,
      '',
      `Existing task context:\n${String(taskBody || '').slice(0, 24000)}`,
    ].join('\n');
  }

  function validationInfrastructureBlock(validation) {
    const text = JSON.stringify(validation || {});
    return /(ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection refused|failed to connect|server is not responding|D1 binding|interstitial|compatibility date|newest date supported|Workers runtime failed)/i.test(
      text
    );
  }

  function claimAutomaticDelivery(item) {
    const now = new Date().toISOString();
    const claimed = events.claimImprovementDelivery(item.run_id, {
      maxAgeMs: AUTOMATIC_DELIVERY_CLAIM_MAX_MS,
      claimedAt: now,
      claimedBy: queueWorkerId,
    });
    if (!claimed) return null;
    events.record({
      event_type: 'improvement.delivery_claimed',
      source: 'fleet-dashboard',
      site_id: `site:${claimed.site}`,
      entity_type: 'improvement',
      entity_id: claimed.run_id,
      correlation_id: claimed.correlation_id,
      payload: { claimed_at: now, claimed_by: queueWorkerId },
    });
    return claimed;
  }

  function releaseAutomaticDeliveryClaim(run) {
    if (!run || run.state === 'deployed' || run.state === 'reported') return;
    try {
      events.updateImprovement(run.run_id, {
        outcome: {
          ...(run.outcome || {}),
          delivery_claimed: false,
          delivery_released_at: new Date().toISOString(),
        },
      });
    } catch {
      /* preserve the original delivery failure */
    }
  }

  function reviewInfrastructureBlock(rootPath, run, error) {
    const evidence = automaticReviewFeedback(rootPath, run, error);
    return /(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection refused|failed to connect|server is not responding|browserType\.launch|executable doesn't exist|playwright install|missing (?:browser|chromium)|cannot find module|network request failed)/i.test(
      evidence
    );
  }

  function markImprovementFailed(run, error) {
    if (!run) return run;
    if (run.state === 'failed') {
      syncChangeRequestFromRun(run, 'failed');
      return run;
    }
    if (!['proposed', 'building'].includes(run.state)) return run;
    try {
      const failedRun = improvements.transition(events, run.run_id, {
        state: 'failed',
        outcome: {
          failed_at: new Date().toISOString(),
          phase: run.agent?.phase || 'reviewer',
          error: String(error?.message || error || 'automatic review failed'),
        },
      });
      syncChangeRequestFromRun(failedRun, 'failed');
      return failedRun;
    } catch {
      return run;
    }
  }

  // A completed worker can leave a valid isolated diff behind while the
  // preview/browser harness is unavailable. Preserve that implementation for
  // revalidation instead of converting an environment outage into a terminal
  // code failure. The original failure remains in the event log and outcome.
  function preserveInfrastructureBlockedReview(request, run, error) {
    const validation = error?.validation || run?.validation;
    const infrastructureBlocked =
      run?.outcome?.infrastructure_blocked === true || validationInfrastructureBlock(validation);
    if (!request || !run || !validation || !infrastructureBlocked) return false;
    const message = String(
      error?.message ||
        run.outcome?.infrastructure_error ||
        run.outcome?.error ||
        'validation infrastructure is unavailable; implementation is preserved for revalidation'
    );
    const queueError = `implementation preserved; validation infrastructure blocked revalidation: ${message}`;
    if (run.state === 'review' && run.outcome?.infrastructure_blocked === true) {
      try {
        if (request.status !== 'review' || request.error !== queueError)
          changequeue.update(
            events,
            request.request_id,
            infrastructureReviewProjectionPatch(request, queueError),
            site => isKnownTarget(root, site)
          );
        return true;
      } catch {
        return false;
      }
    }
    let current = run;
    try {
      if (current.state === 'failed') {
        const reviewerRecovery = improvements.canRecoverReviewerFailure(current, {
          state: 'building',
          recover_reviewer: true,
        });
        const infrastructureRecovery = improvements.canRecoverInfrastructureReview(current, {
          state: 'building',
          recover_infrastructure: true,
        });
        if (!reviewerRecovery && !infrastructureRecovery) return false;
        current = improvements.transition(events, current.run_id, {
          state: 'building',
          ...(reviewerRecovery ? { recover_reviewer: true } : { recover_infrastructure: true }),
        });
      }
      if (current.state !== 'building') return false;
      const reviewed = improvements.transition(events, current.run_id, {
        state: 'review',
        infrastructure_blocked: true,
        validation: { ...validation, infrastructure_blocked: true },
        outcome: {
          ...(current.outcome || {}),
          phase: 'validation',
          infrastructure_blocked: true,
          preserved_for_revalidation: true,
          infrastructure_error: message,
          preserved_at: new Date().toISOString(),
        },
      });
      const updated = changequeue.update(
        events,
        request.request_id,
        {
          status: 'review',
          error: queueError,
          next_attempt_at: null,
          lease_owner: null,
          lease_expires_at: null,
          heartbeat_at: null,
        },
        site => isKnownTarget(root, site)
      );
      events.record({
        event_type: 'change-request.infrastructure_blocked',
        source: 'fleet-dashboard',
        site_id: `site:${request.site}`,
        entity_type: 'change-request',
        entity_id: request.request_id,
        correlation_id: `change-request:${request.request_id}`,
        payload: {
          run_id: reviewed.run_id,
          previous_state: run.state,
          status: 'review',
          preserved_for_revalidation: true,
          error: message,
        },
      });
      emitChangeNotification('review blocked', updated, reviewed, message);
      return true;
    } catch {
      // Keep the original failure if a concurrent queue callback advanced the
      // run between the read and the guarded recovery transition.
      return false;
    }
  }

  function startAutomaticReviewRepair(request, run, error) {
    const settings = events.getChangeQueueSettings();
    if (!request || !run || request.auto_review === 0 || !settings.auto_review_enabled)
      return false;
    const repairCount = Number(request.review_attempts || 0);
    if (repairCount >= MAX_AUTOMATIC_REVIEW_REPAIRS || improvementAgent.status(root, run).running)
      return false;

    const feedback = automaticReviewFeedback(root, run, error);
    const task = findImprovementTask(root, run);
    const taskBody = [
      reviewTaskBodyForRequest(request, task),
      '',
      'AUTOMATIC REVIEW REPAIR',
      `This is bounded repair attempt ${repairCount + 1} of ${MAX_AUTOMATIC_REVIEW_REPAIRS}.`,
      'The previous implementation did not satisfy the request. Inspect the existing worktree and make the smallest correction that completes the original request.',
      'Reviewer feedback:',
      feedback,
      'Do not merely add another backlog item when the request asks you to edit or reassign an existing task; make the requested change in place and record rollback metadata.',
    ].join('\n');
    try {
      // A reviewer handoff can race the durable failure update. Reopen only a
      // reviewer-completed run, preserving the failure in the event log while
      // allowing the bounded repair attempt to do real corrective work.
      let repairRun = run;
      if (run.state === 'failed') {
        repairRun = improvements.transition(events, run.run_id, {
          state: 'building',
          recover_reviewer: true,
        });
      }
      const recoveryStatus = request.status === 'failed' ? 'review' : 'running';
      changequeue.update(
        events,
        request.request_id,
        {
          status: recoveryStatus,
          review_attempts: repairCount + 1,
          error: `automatic review repair ${repairCount + 1}/${MAX_AUTOMATIC_REVIEW_REPAIRS} started`,
          lease_owner: queueWorkerId,
          lease_expires_at: leaseExpiry(settings.lease_minutes),
          heartbeat_at: new Date().toISOString(),
        },
        site => isKnownTarget(root, site)
      );
      if (recoveryStatus === 'review')
        changequeue.update(events, request.request_id, { status: 'running' }, site =>
          isKnownTarget(root, site)
        );
      events.record({
        event_type: 'change-request.review-repair-started',
        source: 'fleet-dashboard',
        site_id: `site:${request.site}`,
        entity_type: 'change-request',
        entity_id: request.request_id,
        correlation_id: `change-request:${request.request_id}`,
        payload: { run_id: run.run_id, review_attempts: repairCount + 1 },
      });
      improvementAgent.start({
        root,
        store: events,
        run: repairRun,
        taskBody,
        provider: request.provider,
        model: request.model,
        maxTurns: request.max_turns,
        role: request.assigned_role || 'engineer',
        onFinished: result => {
          if (result.code === 0 && !result.timedOut && request.auto_review !== 0) {
            autoReviewRequest(request.request_id).catch(repairError =>
              recordAutoReviewFailure(request.request_id, repairError)
            );
          }
        },
      });
      return true;
    } catch (repairError) {
      try {
        changequeue.update(
          events,
          request.request_id,
          { status: 'review', error: `automatic repair could not start: ${repairError.message}` },
          site => isKnownTarget(root, site)
        );
      } catch {
        /* preserve the original review failure */
      }
      return false;
    }
  }

  function recordAutoReviewFailure(id, error) {
    const request = events.getChangeRequest(id);
    if (!request || ['cancelled', 'deployed', 'verified'].includes(request.status)) return;
    const run = request.run_id ? events.getImprovement(request.run_id) : null;
    if (run && ['reported', 'deployed', 'measuring', 'proven', 'inconclusive'].includes(run.state))
      return;
    const message = String(error.message || error);
    // A reviewer can report a real code concern and an unavailable local
    // tool in the same log. Preserve that failure, but do not spend bounded
    // repair attempts repeating a model call that cannot fix the environment.
    if (!error?.noAutomaticRepair && reviewInfrastructureBlock(root, run, error))
      error.noAutomaticRepair = true;
    if (error?.noAutomaticRepair) {
      if (preserveInfrastructureBlockedReview(request, run, error)) return;
      const failedRun = markImprovementFailed(run, error);
      // Infrastructure failures need an operator/tooling fix, not another
      // identical model attempt. Keep the failed request and evidence
      // visible, but do not schedule a retry until the infrastructure is
      // repaired or the owner explicitly retries it.
      const retryable = false;
      try {
        changequeue.update(
          events,
          id,
          {
            status: failedRun?.state === 'failed' ? 'failed' : 'review',
            error: message,
            next_attempt_at: retryable ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null,
            lease_owner: null,
            lease_expires_at: null,
            heartbeat_at: null,
          },
          site => isKnownTarget(root, site)
        );
        events.record({
          event_type: 'change-request.review_blocked',
          source: 'fleet-dashboard',
          site_id: `site:${request.site}`,
          entity_type: 'change-request',
          entity_id: id,
          correlation_id: `change-request:${id}`,
          payload: { error: message, automatic_repair: 'suppressed', reason: 'infrastructure' },
        });
        emitChangeNotification('review blocked', events.getChangeRequest(id), null, message);
      } catch {
        /* preserve the original infrastructure failure */
      }
      return;
    }
    if (startAutomaticReviewRepair(request, run, error)) return;
    const failedRun = markImprovementFailed(run, error);
    try {
      changequeue.update(
        events,
        id,
        {
          status: failedRun?.state === 'failed' ? 'failed' : 'review',
          error: message,
          lease_owner: null,
          lease_expires_at: null,
          heartbeat_at: null,
        },
        site => isKnownTarget(root, site)
      );
      emitChangeNotification('review blocked', events.getChangeRequest(id), null, message);
    } catch {
      // A dashboard restart can race the callback's final state update. Keep
      // the failure visible even if the guarded transition was already lost;
      // the recovery sweep below will clear any remaining reviewer lease.
      try {
        events.record({
          event_type: 'change-request.review_failure',
          source: 'fleet-dashboard',
          site_id: `site:${request.site}`,
          entity_type: 'change-request',
          entity_id: id,
          correlation_id: `change-request:${id}`,
          payload: { error: message },
        });
      } catch {
        /* best effort */
      }
    }
  }

  function recoverAutomaticReviewHandoffs() {
    for (const request of events.listChangeRequests({ limit: 1000 })) {
      const run = request.run_id ? events.getImprovement(request.run_id) : null;
      if (!['reviewing', 'review'].includes(request.status)) continue;
      const activeSince = activeAutomaticReviews.get(request.request_id);
      if (activeSince) {
        const finishedAt = Date.parse(run?.agent?.finished_at || '');
        const handoffAge = Number.isFinite(finishedAt)
          ? Date.now() - finishedAt
          : Date.now() - activeSince;
        if (
          run?.agent?.phase !== 'reviewer' ||
          run?.agent?.status !== 'completed' ||
          handoffAge < AUTOMATIC_REVIEW_ACTIVE_MAX_MS
        )
          continue;
        activeAutomaticReviews.delete(request.request_id);
        events.record({
          event_type: 'improvement.reviewer_handoff_reclaimed',
          source: 'fleet-dashboard',
          site_id: `site:${request.site}`,
          entity_type: 'improvement',
          entity_id: run.run_id,
          correlation_id: run.correlation_id,
          payload: { request_id: request.request_id, handoff_age_ms: handoffAge },
        });
      }
      // A process can die after claiming delivery but before the deterministic
      // deployment handoff completes. Once the bounded claim window expires,
      // clear only that retry lock and let the durable reviewer PASS marker
      // drive one fresh delivery attempt. Never recover a building or
      // unvalidated run here: those still have active validation work.
      if (
        shouldRecoverStaleDeliveryClaim(request, run) &&
        !activeAutomaticReviews.has(request.request_id)
      ) {
        const recoveredAt = new Date().toISOString();
        try {
          events.updateImprovement(run.run_id, {
            outcome: {
              ...(run.outcome || {}),
              delivery_claimed: false,
              delivery_claim_recovered_at: recoveredAt,
              delivery_claim_recovery_reason:
                'stale validated delivery claim; no active handoff owner',
            },
          });
          events.record({
            event_type: 'improvement.delivery_claim_recovered',
            source: 'fleet-dashboard',
            site_id: `site:${run.site}`,
            entity_type: 'improvement',
            entity_id: run.run_id,
            correlation_id: run.correlation_id,
            payload: { request_id: request.request_id, recovered_at: recoveredAt },
          });
        } catch {
          /* another recovery pass may already own the durable handoff */
        }
      }
      // Validation-infrastructure blocks are preserved in review, but a
      // versioned harness fix gets one bounded automatic revalidation. This
      // removes the operator bottleneck without retrying the same broken
      // environment forever; the version marker remains in the audit record.
      const completedReviewerHandoff =
        run?.state === 'building' &&
        run.agent?.phase === 'reviewer' &&
        run.agent?.status === 'completed';
      if (run?.outcome?.infrastructure_blocked === true && !completedReviewerHandoff) {
        if (
          shouldAutoRevalidateInfrastructureReview(request, run) &&
          events.listChangeRequests({ status: 'reviewing', limit: 1000 }).length <
            Number(events.getChangeQueueSettings().max_concurrent || 1)
        ) {
          const startedAt = new Date().toISOString();
          try {
            events.updateImprovement(run.run_id, {
              outcome: {
                ...(run.outcome || {}),
                infrastructure_revalidation_version: INFRASTRUCTURE_REVALIDATION_VERSION,
                infrastructure_revalidation_started_at: startedAt,
              },
            });
            autoReviewRequest(request.request_id).catch(error =>
              recordAutoReviewFailure(request.request_id, error)
            );
          } catch {
            /* preserve the review block; the next versioned operator pass can retry */
          }
        }
        continue;
      }
      if (!run || run.agent?.phase !== 'reviewer' || run.agent?.status !== 'completed') continue;
      const finishedAt = Date.parse(run.agent.finished_at || '');
      if (
        Number.isFinite(finishedAt) &&
        Date.now() - finishedAt < AUTOMATIC_REVIEW_HANDOFF_GRACE_MS
      )
        continue;
      if (['reported', 'deployed', 'measuring', 'proven', 'inconclusive'].includes(run.state))
        continue;
      // A dashboard restart can happen after the reviewer container exits but
      // before its in-memory close callback delivers the result. The marker is
      // durable in the reviewer log; recover it directly instead of creating a
      // false interrupted-handoff failure or spending a repair call.
      const reviewer = improvementAgent.reviewResult(improvementAgent.status(root, run).log_tail);
      if (reviewer.marker) {
        if (activeAutomaticReviews.has(request.request_id)) continue;
        activeAutomaticReviews.set(request.request_id, Date.now());
        completeAutomaticReview(request.request_id, run, {
          ...reviewer,
          code: run.agent?.exit_code,
          timedOut: run.agent?.status === 'timed-out',
        }).finally(() => activeAutomaticReviews.delete(request.request_id));
        continue;
      }
      const reason =
        run.validation?.passed === false
          ? run.validation.checks?.build?.excerpt || 'quality gates did not pass'
          : 'automatic reviewer handoff was interrupted; retry required';
      recordAutoReviewFailure(request.request_id, new Error(reason));
    }
  }

  async function completeAutomaticReview(id, run, reviewerResult) {
    const cleanExit =
      reviewerResult?.code == null
        ? run?.agent?.exit_code === 0 && run?.agent?.status === 'completed'
        : reviewerResult.code === 0 && reviewerResult.timedOut !== true;
    if (!reviewerResult?.approved || !cleanExit) {
      recordAutoReviewFailure(
        id,
        new Error(
          reviewerResult?.marker
            ? 'automatic reviewer rejected the change'
            : 'automatic reviewer did not return PASS'
        )
      );
      return;
    }
    try {
      const latest = events.getImprovement(run.run_id);
      if (!latest) throw new Error('reviewed improvement run disappeared');
      let snapshot = await git.worktreeSnapshot(latest.workspace_path);
      if (snapshot.dirty)
        snapshot = await git.commitWorktree(latest.workspace_path, `feat: ${latest.title}`);
      const fresh = events.getImprovement(run.run_id);
      await deliverAutomatically(fresh);
    } catch (error) {
      releaseAutomaticDeliveryClaim(events.getImprovement(run.run_id));
      recordAutoReviewFailure(id, error);
    }
  }

  async function autoReviewRequest(id) {
    if (activeAutomaticReviews.has(id)) return { status: 'already-running' };
    const request = events.getChangeRequest(id);
    if (!request) throw Object.assign(new Error('change request not found'), { httpStatus: 404 });
    if (!['review', 'reviewing', 'running'].includes(request.status))
      throw Object.assign(new Error(`request is ${request.status}, not awaiting review`), {
        httpStatus: 409,
      });
    let run = request.run_id ? events.getImprovement(request.run_id) : null;
    if (!run) throw Object.assign(new Error('request has no improvement run'), { httpStatus: 409 });
    if (activeAutomaticReviews.has(id)) return { status: 'already-running' };
    // Claim the durable reviewing slot before the first await below. Without
    // this ordering, a recovery sweep could launch several async reviews in
    // one turn while every request still looked like `review`, bypassing the
    // queue's max_concurrent setting and exhausting browser/build resources.
    if (request.status !== 'reviewing')
      changequeue.update(
        events,
        id,
        {
          status: 'reviewing',
          error: null,
          lease_owner: queueWorkerId,
          lease_expires_at: leaseExpiry(events.getChangeQueueSettings().lease_minutes),
          heartbeat_at: new Date().toISOString(),
        },
        site => isKnownTarget(root, site)
      );
    activeAutomaticReviews.set(id, Date.now());
    try {
      if (run.state === 'review') {
        await syncImprovementTask(root, run, 'in-progress');
        run = improvements.transition(events, run.run_id, { state: 'building' });
      }
      if (run.state !== 'building')
        throw Object.assign(new Error(`improvement run is ${run.state}, not reviewable`), {
          httpStatus: 409,
        });
    } catch (error) {
      activeAutomaticReviews.delete(id);
      recordAutoReviewFailure(id, error);
      throw error;
    }
    const task = findImprovementTask(root, run);
    try {
      return improvementAgent.startReview({
        root,
        store: events,
        run,
        taskBody: reviewTaskBodyForRequest(request, task),
        provider: request.provider,
        model: request.model,
        maxTurns: request.max_turns,
        role: 'reviewer',
        onFinished: result => {
          completeAutomaticReview(id, run, {
            ...(result.result || {}),
            code: result.code,
            timedOut: result.timedOut,
          }).finally(() => activeAutomaticReviews.delete(id));
        },
      });
    } catch (error) {
      activeAutomaticReviews.delete(id);
      recordAutoReviewFailure(id, error);
      throw error;
    }
  }

  app.get('/api/change-requests', (req, res) => {
    try {
      for (const request of events.listChangeRequests({ limit: 1000 })) {
        if (request.run_id) syncChangeRequestFromRun(events.getImprovement(request.run_id));
      }
      res.json({
        requests: events.listChangeRequests(req.query),
        settings: events.getChangeQueueSettings(),
        categories: changequeue.CATEGORIES,
        providers: changequeue.PROVIDERS,
        delivery_modes: changequeue.DELIVERY_MODES,
        statuses: changequeue.STATUSES,
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/change-requests', (req, res) => {
    try {
      res.status(201).json({
        request: changequeue.create(events, req.body || {}, site => isKnownTarget(root, site)),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/executive/messages', (req, res) => {
    try {
      res.json({ messages: events.listExecutiveMessages(req.query) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/executive/settings', (_req, res) => {
    try {
      res.json({ settings: events.getExecutiveSettings() });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/executive/brief', async (_req, res) => {
    try {
      res.json({ brief: await executiveRunner.buildBrief(events, root) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  // Shared read-only intelligence contract for CEO/CTO/CRO and UI diagnostics.
  app.get('/api/executive/intelligence', async (_req, res) => {
    try {
      res.json(await executiveIntel.collect({ root, sites: executiveRunner.executiveSites(root) }));
    } catch (e) {
      res.status(e.httpStatus || 503).json({ error: e.message || String(e) });
    }
  });
  app.get('/api/executive/intelligence-snapshot', (_req, res) => {
    try {
      const snapshot = executiveSnapshot.readLatest(root, {
        sites: executiveRunner.executiveSites(root),
      });
      if (!snapshot) return res.status(404).json({ error: 'no fresh executive snapshot' });
      res.json({ snapshot });
    } catch (e) {
      res.status(e.httpStatus || 503).json({ error: e.message || String(e) });
    }
  });
  app.get('/api/executive/scorecard', (req, res) => {
    try {
      res.json({
        scorecard: executiveScorecard.buildScorecard(events, {
          windowDays: req.query.window_days,
        }),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message || String(e) });
    }
  });
  app.post('/api/executive/data-requests', async (req, res) => {
    try {
      const result = await executiveData.fulfill({
        store: events,
        root,
        request: req.body || {},
        managedSites: executiveRunner.executiveSites(root),
      });
      res.status(result.status === 'fulfilled' ? 201 : 503).json({ result });
    } catch (e) {
      res.status(e.httpStatus || 400).json({ error: e.message || String(e) });
    }
  });
  app.get('/api/executive/data-requests/:id', (req, res) => {
    const result = executiveData.read(root, req.params.id);
    if (!result) return res.status(404).json({ error: 'data request not found' });
    res.json({ result });
  });
  app.get('/api/change-requests/:id/report', (req, res) => {
    const request = events.getChangeRequest(req.params.id);
    if (!request) return res.status(404).json({ error: 'change request not found' });
    const file = reportArtifactPath(root, request.request_id);
    try {
      res.json({ report: JSON.parse(fs.readFileSync(file, 'utf8')) });
    } catch {
      res.status(404).json({ error: 'report not found' });
    }
  });
  app.get('/api/executive/task-queue', (req, res) => {
    try {
      const role = String(req.query.role || '').trim();
      const requests = events.listChangeRequests({
        assigned_role: role || undefined,
        status: req.query.status || undefined,
        site: req.query.site || undefined,
        limit: req.query.limit || 250,
      });
      res.json({
        role: role || 'all',
        requests,
        summary: {
          queued: requests.filter(row => row.status === 'queued').length,
          active: requests.filter(row => ['claimed', 'running', 'reviewing'].includes(row.status))
            .length,
          review: requests.filter(row => row.status === 'review').length,
          failed: requests.filter(row => row.status === 'failed').length,
        },
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/executive/reports', (req, res) => {
    try {
      res.json({ reports: domainReports.recent(root, req.query.limit) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/executive/reports/:id', (req, res) => {
    try {
      const report = domainReports.get(root, req.params.id);
      if (!report) return res.status(404).json({ error: 'domain report not found' });
      res.json({ report });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  // CRO repo-lab evidence is read-only to the fleet. The lab stores only a
  // bounded report; its temporary checkout is deleted before this responds.
  app.get('/api/executive/cro-lab/runs', (req, res) => {
    try {
      res.json({ runs: executiveCroLab.recent(root, req.query.limit) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/executive/cro-lab/runs/:id', (req, res) => {
    const report = executiveCroLab.read(root, req.params.id);
    if (!report) return res.status(404).json({ error: 'CRO repo-lab run not found' });
    res.json({ report });
  });
  app.post('/api/executive/cro-lab/run', async (req, res) => {
    try {
      // The CRO runner is date-idempotent; an on-demand click never creates
      // duplicate proposals for the same daily snapshot.
      const result = await executiveCro.run({ root });
      res.status(201).json({
        result: {
          duplicate: result.duplicate === true,
          proposal_ids: (result.proposals || []).map(item => item.proposal_id),
          lab_run_ids: result.message?.metadata?.lab_run_ids || [],
        },
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/executive/domain-manager-queue', (_req, res) => {
    try {
      res.json({
        queue: domainDispatcher.summary(root),
        jobs: domainDispatcher.readState(root).jobs.slice(-100).reverse(),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/executive/reports/run', async (req, res) => {
    try {
      const cadence = String(req.body?.cadence || 'six_hour');
      const focusSite = req.body?.site ? String(req.body.site) : null;
      const report = await domainReports.generate({ root, cadence, focusSite });
      res.status(201).json({ report });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/revops/summary', (req, res) => {
    try {
      res.json({ summary: revops.summary(events, { site: req.query.site }) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/revops/leads', (req, res) => {
    try {
      res.json({ leads: revops.leads(events, req.query) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/revops/leads', (req, res) => {
    try {
      res
        .status(201)
        .json({ lead: revops.createLead(events, req.body || {}, site => isKnownSite(root, site)) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.patch('/api/revops/leads/:id', (req, res) => {
    try {
      res.json({
        lead: revops.updateLead(events, req.params.id, req.body || {}, site =>
          isKnownSite(root, site)
        ),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/revops/activities', (req, res) => {
    try {
      res.status(201).json({
        activity: revops.recordActivity(events, req.body || {}, site => isKnownSite(root, site)),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/experiments', (req, res) => {
    try {
      res.json({ experiments: experiments.list(events, req.query) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/experiments', (req, res) => {
    try {
      res.status(201).json({
        experiment: experiments.create(events, req.body || {}, site => isKnownSite(root, site)),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/experiments/:id/transition', (req, res) => {
    try {
      res.json({ experiment: experiments.transition(events, req.params.id, req.body?.state) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/experiments/events', (req, res) => {
    try {
      res.status(201).json({
        event: experiments.recordEvent(events, req.body || {}, site => isKnownSite(root, site)),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/experiments/:id/assignment', (req, res) => {
    try {
      const experiment = experiments
        .list(events, { limit: 1000 })
        .find(row => row.experiment_id === req.params.id);
      if (!experiment) return res.status(404).json({ error: 'experiment not found' });
      if (!req.query.subject_ref) return res.status(400).json({ error: 'subject_ref is required' });
      res.json({
        experiment_id: experiment.experiment_id,
        variant: experiments.assign(experiment, req.query.subject_ref),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/experiments/:id/analysis', (req, res) => {
    try {
      res.json(experiments.analyze(events, req.params.id));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/campaigns', (req, res) => {
    try {
      res.json({ campaigns: campaigns.list(events, req.query) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/campaigns/summary', (_req, res) => {
    try {
      res.json({ summary: campaigns.summary(events) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/campaigns', (req, res) => {
    try {
      res.status(201).json({
        campaign: campaigns.create(
          events,
          req.body || {},
          site => isKnownSite(root, site),
          revops.buildUtmUrl
        ),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/campaigns/:id/transition', (req, res) => {
    try {
      res.json({ campaign: campaigns.transition(events, req.params.id, req.body?.status) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/campaigns/touches', (req, res) => {
    try {
      res
        .status(201)
        .json({ touch: campaigns.touch(events, req.body || {}, site => isKnownSite(root, site)) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.patch('/api/executive/settings', (req, res) => {
    try {
      const body = req.body || {};
      const allowed = [
        'revenue_target_monthly',
        'fixed_costs_monthly',
        'marketing_budget_monthly',
        'revenue_floor_monthly',
        'attribution_materiality_threshold',
        'monthly_spend_limit',
        'risk_tolerance',
        'priority_sites',
        'ignored_sites',
        'approval_thresholds',
        'brand_constraints',
        'operating_notes',
        'checkin_hours',
        'tick_enabled',
      ];
      const patch = Object.fromEntries(
        allowed.filter(k => Object.prototype.hasOwnProperty.call(body, k)).map(k => [k, body[k]])
      );
      const settings = events.updateExecutiveSettings(patch);
      events.record({
        event_type: 'executive.settings.updated',
        source: 'fleet-dashboard',
        entity_type: 'executive',
        entity_id: 'fleet',
        payload: { keys: Object.keys(patch) },
      });
      res.json({ settings });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/executive/messages', (req, res) => {
    try {
      if (String(req.body?.actor || '') !== 'owner')
        throw Object.assign(
          new Error('only owner messages may be submitted through the dashboard'),
          { httpStatus: 403 }
        );
      res.status(201).json({ message: executive.message(events, req.body || {}) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/executive/proposals', (req, res) => {
    try {
      res.json({
        proposals: events.listExecutiveProposals(req.query),
        proposal_types: executive.PROPOSAL_TYPES,
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/executive/proposals/:id/decision', (req, res) => {
    try {
      res.json({
        proposal: executive.decision(events, req.params.id, req.body || {}, {
          knownSite: site => isKnownTarget(root, site),
        }),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/executive/actions', (req, res) => {
    try {
      res.json({
        actions: events.listExecutiveActions(req.query),
        action_types: executive.ACTION_TYPES,
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/executive/work-items', (req, res) => {
    try {
      res.json({ work_items: events.listExecutiveWorkItems(req.query) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/executive/work-items', (req, res) => {
    try {
      const workItem = events.createExecutiveWorkItem(req.body || {});
      res.status(201).json({ work_item: workItem });
    } catch (e) {
      res.status(e.httpStatus || 400).json({ error: e.message });
    }
  });
  app.patch('/api/executive/work-items/:id', (req, res) => {
    try {
      res.json({ work_item: events.updateExecutiveWorkItem(req.params.id, req.body || {}) });
    } catch (e) {
      res.status(e.httpStatus || 400).json({ error: e.message });
    }
  });
  app.get('/api/executive/knowledge', (req, res) => {
    try {
      res.json({ knowledge: events.listExecutiveKnowledge(req.query) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/executive/knowledge', (req, res) => {
    try {
      res.status(201).json({ knowledge: events.createExecutiveKnowledge(req.body || {}) });
    } catch (e) {
      res.status(e.httpStatus || 400).json({ error: e.message });
    }
  });
  app.patch('/api/executive/knowledge/:id', (req, res) => {
    try {
      res.json({ knowledge: events.updateExecutiveKnowledge(req.params.id, req.body || {}) });
    } catch (e) {
      res.status(e.httpStatus || 400).json({ error: e.message });
    }
  });
  app.post('/api/change-requests/transcribe', async (req, res) => {
    try {
      res.json(await changequeue.transcribe(req.body || {}));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.patch('/api/change-requests/queue-settings', (req, res) => {
    try {
      const body = req.body || {};
      if (
        body.interval_minutes !== undefined &&
        (!Number.isInteger(Number(body.interval_minutes)) ||
          Number(body.interval_minutes) < 1 ||
          Number(body.interval_minutes) > 1440)
      )
        throw Object.assign(new Error('interval_minutes must be 1-1440'), { httpStatus: 400 });
      if (
        body.max_concurrent !== undefined &&
        (!Number.isInteger(Number(body.max_concurrent)) ||
          Number(body.max_concurrent) < 1 ||
          Number(body.max_concurrent) > 10)
      )
        throw Object.assign(new Error('max_concurrent must be 1-10'), { httpStatus: 400 });
      if (
        body.lease_minutes !== undefined &&
        (!Number.isInteger(Number(body.lease_minutes)) ||
          Number(body.lease_minutes) < 5 ||
          Number(body.lease_minutes) > 1440)
      )
        throw Object.assign(new Error('lease_minutes must be 5-1440'), { httpStatus: 400 });
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean')
        throw Object.assign(new Error('enabled must be boolean'), { httpStatus: 400 });
      if (body.auto_review_enabled !== undefined && typeof body.auto_review_enabled !== 'boolean')
        throw Object.assign(new Error('auto_review_enabled must be boolean'), { httpStatus: 400 });
      res.json({ settings: events.updateChangeQueueSettings(body) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/change-requests/pickup', async (req, res) => {
    try {
      res.json(await pickupChangeRequests(req.body?.max));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/change-requests/:id', (req, res) => {
    try {
      const request = events.getChangeRequest(req.params.id);
      if (!request) return res.status(404).json({ error: 'change request not found' });
      const run = request.run_id ? events.getImprovement(request.run_id) : null;
      res.json({
        request,
        run,
        events: events.list({ correlation_id: `change-request:${request.request_id}`, limit: 100 }),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/change-requests/:id/preflight', async (req, res) => {
    try {
      const request = events.getChangeRequest(req.params.id);
      if (!request) return res.status(404).json({ error: 'change request not found' });
      const run = request.run_id ? events.getImprovement(request.run_id) : null;
      if (!run?.sandbox?.instance)
        return res.status(409).json({ error: 'isolated sandbox is not running' });
      const environment = await devsandbox.preflight(run.sandbox.instance);
      const provider = await improvementAgent.preflight({
        run,
        provider: request.provider,
        model: request.model,
      });
      const preflight = { environment, provider, passed: environment.passed && provider.ok };
      events.updateImprovement(run.run_id, { preflight });
      events.record({
        event_type: 'improvement.preflight',
        source: 'improvement-workbench',
        site_id: `site:${request.site}`,
        entity_type: 'improvement',
        entity_id: run.run_id,
        correlation_id: `change-request:${request.request_id}`,
        payload: preflight,
      });
      res.json({
        request: events.getChangeRequest(request.request_id),
        run: events.getImprovement(run.run_id),
        preflight,
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
    }
  });
  app.post('/api/change-requests/:id/pickup', async (req, res) => {
    try {
      let request = events.getChangeRequest(req.params.id);
      if (!request) return res.status(404).json({ error: 'change request not found' });
      if (request.status === 'failed') {
        await resetChangeRequestRun(request);
        request = changequeue.update(
          events,
          request.request_id,
          { status: 'queued', next_attempt_at: new Date().toISOString(), error: null, attempts: 0 },
          site => isKnownTarget(root, site)
        );
      }
      if (request.status !== 'queued')
        return res.status(409).json({ error: `request is ${request.status}, not queued` });
      res.status(202).json(await dispatchChangeRequest(request));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/change-requests/:id/auto-review', async (req, res) => {
    try {
      const result = await autoReviewRequest(req.params.id);
      res
        .status(result?.status === 'already-running' ? 200 : 202)
        .json({ result, request: events.getChangeRequest(req.params.id) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.patch('/api/change-requests/:id', (req, res) => {
    try {
      const before = events.getChangeRequest(req.params.id);
      const request = changequeue.update(events, req.params.id, req.body || {}, site =>
        isKnownSite(root, site)
      );
      if (before?.status !== request.status)
        executiveFollowup.notify(events, {
          event: request.status,
          request,
          run: request.run_id ? events.getImprovement(request.run_id) : null,
          details: request.error || '',
        });
      res.json({ request });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/change-requests/:id/cancel', (req, res) => {
    try {
      const request = changequeue.update(events, req.params.id, { status: 'cancelled' }, site =>
        isKnownSite(root, site)
      );
      executiveFollowup.notify(events, { event: 'cancelled', request });
      res.json({ request });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/change-requests/:id/retry', async (req, res) => {
    try {
      const existing = events.getChangeRequest(req.params.id);
      if (!existing) return res.status(404).json({ error: 'change request not found' });
      const existingRun = existing.run_id ? events.getImprovement(existing.run_id) : null;
      // Preserve a dirty reviewer worktree and repair it in place. The normal
      // retry path intentionally refuses dirty cleanup, but a successful
      // reviewer process that rejected the change is exactly the bounded
      // recovery case covered by the improvement transition guard.
      if (
        existingRun &&
        improvements.canRecoverReviewerFailure(existingRun, {
          state: 'building',
          recover_reviewer: true,
        })
      ) {
        const started = startAutomaticReviewRepair(
          existing,
          existingRun,
          new Error(existing.error || 'reviewer rejected the change; bounded repair requested')
        );
        if (started)
          return res.status(202).json({
            repaired_in_place: true,
            request: events.getChangeRequest(existing.request_id),
            run: events.getImprovement(existingRun.run_id),
          });
      }
      await resetChangeRequestRun(existing);
      res.json({
        request: changequeue.update(
          events,
          req.params.id,
          { status: 'queued', next_attempt_at: new Date().toISOString(), error: null, attempts: 0 },
          site => isKnownTarget(root, site)
        ),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/change-requests/:id/complete', (req, res) => {
    try {
      const request = events.getChangeRequest(req.params.id);
      if (!request) return res.status(404).json({ error: 'change request not found' });
      const run = request.run_id ? events.getImprovement(request.run_id) : null;
      if (
        !run ||
        !run.deployment_id ||
        !['deployed', 'measuring', 'proven', 'inconclusive'].includes(run.state)
      )
        return res.status(409).json({
          error: 'request cannot be completed until a validated commit has been deployed',
        });
      const updated = syncChangeRequestFromRun(
        run,
        ['proven', 'inconclusive'].includes(run.state) ? 'verified' : 'deployed'
      );
      res.json({ request: updated, run });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  let lastQueuePickup = 0;
  let lastImprovementCleanup = 0;
  async function cleanupExpiredImprovementSandboxes() {
    const ttlHours = Math.max(1, Number(process.env.FD_IMPROVEMENT_SANDBOX_TTL_HOURS || 24));
    const cutoff = Date.now() - ttlHours * 3600000;
    for (const run of events.listImprovements({ limit: 1000 })) {
      const terminal = ['cancelled', 'failed', 'proven', 'inconclusive', 'rolled-back'].includes(
        run.state
      );
      if (!terminal) continue;
      // Failed runs are safe to reap as soon as their worker is no longer
      // active. They commonly represent a provider/reviewer failure and must
      // not retain an idle ttyd/container until the 24-hour evidence TTL.
      // Successful terminal runs keep the historical TTL to preserve an
      // operator's short-lived preview/review surface.
      if (run.state !== 'failed' && Date.parse(run.updated_at || run.created_at) > cutoff) continue;
      if (improvementAgent.isActive(run) || (await improvementAgent.workerProcessAlive(run)))
        continue;
      try {
        const result = await cleanupImprovementResources(root, run);
        if (result.cleaned)
          events.record({
            event_type: 'improvement.resources_expired',
            source: 'improvement-workbench',
            site_id: `site:${run.site}`,
            entity_type: 'improvement',
            entity_id: run.run_id,
            correlation_id: run.correlation_id,
            payload: { ttl_hours: ttlHours },
          });
      } catch (error) {
        events.record({
          event_type: 'improvement.cleanup_failed',
          source: 'improvement-workbench',
          site_id: `site:${run.site}`,
          entity_type: 'improvement',
          entity_id: run.run_id,
          correlation_id: run.correlation_id,
          payload: { error: error.message },
        });
      }
    }
  }
  const queuePulse = setInterval(() => {
    renewQueueLeases();
    recoverAutomaticReviewHandoffs();
    reconcileInterruptedWorkers().catch(() => {});
    // Projection repair is cheap and must not wait for the slower pickup
    // interval. A worker can finish between pickups, leaving a reported run
    // displayed as reviewing until the next ten-minute queue pass.
    try {
      reconcileStalledImprovementRuns();
      reconcileFailedRequestErrors();
    } catch {
      /* the next pulse retries reconciliation without interrupting pickup */
    }
    recoverExpiredQueueWork().catch(() => {});
    if (Date.now() - lastImprovementCleanup >= 3600000) {
      lastImprovementCleanup = Date.now();
      cleanupExpiredImprovementSandboxes().catch(() => {});
    }
    const settings = events.getChangeQueueSettings();
    if (!settings.enabled) return;
    if (Date.now() - lastQueuePickup < Number(settings.interval_minutes) * 60000) return;
    lastQueuePickup = Date.now();
    pickupChangeRequests().catch(error => {
      events.record({
        event_type: 'change-queue.pickup_failed',
        source: 'fleet-dashboard',
        entity_type: 'change-queue',
        entity_id: queueWorkerId,
        correlation_id: `change-queue:${queueWorkerId}`,
        payload: { error: String(error.message || error).slice(0, 1000) },
      });
      console.error(`[fleet-dashboard] change queue pickup failed: ${error.message || error}`);
    });
  }, 15000);
  if (queuePulse.unref) queuePulse.unref();

  // Auth surface (always available, even when the token gate is on).
  app.get('/api/auth', auth.authStatus);
  app.post('/api/login', auth.loginHandler);

  // Audit trail read-back (B4): the most-recent mutating actions, newest first.
  app.get('/api/actions', (req, res) => {
    try {
      res.json({ actions: actionlog.tail(req.query.limit) });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Liveness + dependency preflight (F7).
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/api/health/deps', async (_req, res) => {
    try {
      res.json(await health.deps(root));
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // Live-refresh channel (F4): a lightweight SSE heartbeat. The SPA subscribes
  // and refreshes in place on each tick instead of polling on its own timer.
  const sseClients = new Set();
  app.get('/api/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (res.flushHeaders) res.flushHeaders();
    res.write('retry: 5000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ version: assetVersion() })}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(
          `event: tick\ndata: ${JSON.stringify({ t: Date.now(), version: assetVersion() })}\n\n`
        );
      } catch {
        /* client gone; cleanup runs on close */
      }
    }, 10000);
    if (ping.unref) ping.unref();
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
  });

  // Gate every :slug route through discovery so no request can address a
  // directory we didn't enumerate.
  function requireSite(req, res, next) {
    if (!isKnownSite(root, req.params.slug)) return res.status(404).json({ error: 'unknown site' });
    next();
  }

  // A fingerprint of the served front-end assets. The SPA polls this and
  // self-updates when it changes, so a tab left open across a deploy doesn't
  // keep running stale JS.
  function assetVersion() {
    const h = crypto.createHash('sha1');
    for (const f of ['index.html', 'app.js', 'style.css', 'theme.css', 'shell.js']) {
      try {
        const st = fs.statSync(path.join(__dirname, 'public', f));
        h.update(`${f}:${st.mtimeMs}:${st.size};`);
      } catch {
        /* ignore a missing asset */
      }
    }
    return h.digest('hex').slice(0, 12);
  }
  app.get('/api/version', (_req, res) => res.json({ version: assetVersion() }));

  // Data Hub routes — all static paths, no :param conflicts.
  app.get('/api/datahub/health', async (_req, res) => res.json(await datahub.health()));
  app.get('/api/datahub/egress', async (req, res) => {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 60, 300));
    res.json(await datahub.egress(limit));
  });
  app.get('/api/datahub/pulls', async (req, res) => {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 60, 300));
    res.json(await datahub.pulls(limit));
  });
  app.get('/api/datahub/sources', async (_req, res) => res.json(await datahub.sources()));
  app.post('/api/datahub/sources/:id/enabled', async (req, res) => {
    const enabled = !!(req.body && req.body.enabled);
    res.json(await datahub.setSourceEnabled(req.params.id, enabled));
  });
  app.get('/api/datahub/datasets', async (_req, res) => res.json(await datahub.datasets()));
  app.get('/api/datahub/matrix', (_req, res) => {
    try {
      res.json(datahub.matrix());
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Product Feed routes — proxy over tools/product-feed's API (:4761). Same
  // degrade-to-200 convention as /api/datahub/* above.
  app.get('/api/product-feed/health', async (_req, res) => res.json(await productFeed.health()));
  app.get('/api/product-feed/stats', async (_req, res) => res.json(await productFeed.stats()));
  app.get('/api/product-feed/inventory-stats', async (_req, res) =>
    res.json(await productFeed.inventoryStats())
  );
  app.get('/api/product-feed/subscriptions', async (_req, res) =>
    res.json(await productFeed.subscriptionsWithDepth())
  );
  app.get('/api/product-feed/candidates', async (req, res) => {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 30, 200));
    res.json(await productFeed.recentCandidates(limit));
  });
  app.get('/api/product-feed/products', async (req, res) => {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 30, 200));
    res.json(await productFeed.recentProducts(limit));
  });

  // Analytics routes — GA4 + Search Console metrics, proxied from the data-hub
  // /metrics/* endpoints (tools/data-hub/src/datahub/api.py). Same degrade-to-200
  // convention as /api/datahub/* above.
  app.get('/api/analytics/health', async (_req, res) => res.json(await analytics.health()));
  app.get('/api/analytics/summary', async (req, res) => {
    const window = Math.max(1, Math.min(parseInt(req.query.window, 10) || 28, 400));
    res.json(await analytics.summary(req.query.site, window));
  });
  app.get('/api/analytics/top', async (req, res) => {
    const window = Math.max(1, Math.min(parseInt(req.query.window, 10) || 28, 400));
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 10, 50));
    const fn = req.query.source === 'gsc' ? analytics.topGsc : analytics.topGa4;
    res.json(await fn(req.query.site, req.query.metric, window, limit));
  });
  app.get('/api/analytics/wow', async (req, res) => res.json(await analytics.wow(req.query.site)));
  app.get('/api/revenue/amazon', (_req, res) => res.json(revenue.amazonSummary(root)));

  // Portfolio decision surface: joins canonical lifecycle, coverage, work and
  // growth signals. Dollar estimates stay null until attributable revenue exists.
  app.get('/api/priorities', async (_req, res) => {
    try {
      const [seo, analyticsHealth, usage] = await Promise.all([
        seoIntelligence.buildSnapshot({ root }),
        analytics.health(),
        aiusage.fleet(root),
      ]);
      const builds = cloudflarebuilds.summarize(undefined, { days: 30, limit: 250 });
      const reg = require('./fleetregistry').read(root);
      const siteByWorker = Object.fromEntries(
        reg.sites.filter(s => s.worker).map(s => [s.worker, s])
      );
      for (const build of builds.builds || []) {
        const site = siteByWorker[build.worker];
        if (!site || !build.uuid) continue;
        const prior = build.commitHash
          ? events.list({
              entity_type: 'commit',
              entity_id: String(build.commitHash).slice(0, 7),
              limit: 1,
            })[0]
          : null;
        events.recordOnce({
          event_id: `cf-build:${build.uuid}`,
          event_type: 'deployment.completed',
          source: 'cloudflare-builds',
          occurred_at: build.stoppedOn || build.createdOn || new Date().toISOString(),
          site_id: site.site_id,
          entity_type: 'deployment',
          entity_id: build.uuid,
          correlation_id: prior?.correlation_id || `commit:${build.commitHash || build.uuid}`,
          causation_id: prior?.event_id || null,
          payload: {
            commit: build.commitHash || null,
            outcome: build.outcome,
            duration_seconds: build.durationSeconds,
          },
        });
      }
      res.json(
        priorities.build({
          root,
          discoveredSites: discoverSites(root),
          seo,
          revenue: revenue.amazonSummary(root),
          analyticsHealth,
          aiUsage: usage,
        })
      );
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });
  app.get('/api/data-quality', async (_req, res) => {
    try {
      const [seo, analyticsHealth, usage] = await Promise.all([
        seoIntelligence.buildSnapshot({ root }),
        analytics.health(),
        aiusage.fleet(root),
      ]);
      res.json(
        dataquality.assess({
          root,
          discoveredSites: discoverSites(root),
          seo,
          analyticsHealth,
          aiUsage: usage,
          revenue: revenue.amazonSummary(root),
        })
      );
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });
  app.get('/api/events', (req, res) => {
    try {
      res.json({ events: events.list(req.query) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
    }
  });

  app.get('/api/improvements', (req, res) => {
    try {
      let rows = events.listImprovements(req.query);
      for (const item of rows.filter(row => row.state === 'deployed')) {
        const live = deployhealth.get(item.site);
        if (live?.live !== true) continue;
        improvements.transition(events, item.run_id, {
          state: 'measuring',
          measurement_due:
            item.measurement_due || improvements.measurementDate(14, Date.parse(item.updated_at)),
          outcome: {
            deployment_verified_at: new Date().toISOString(),
            worker_version: live.version || null,
          },
        });
      }
      rows = events.listImprovements(req.query).map(item => {
        const task = findImprovementTask(root, item);
        const expected = improvements.expectedTaskColumn(item.state);
        return {
          ...item,
          task_column: task?.column || null,
          task_drift: !task || task.column !== expected,
          expected_task_column: expected,
        };
      });
      res.json(improvements.summary(rows));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
    }
  });
  app.get('/api/improvements/:id', (req, res) => {
    const item = events.getImprovement(req.params.id);
    if (!item) return res.status(404).json({ error: 'improvement run not found' });
    Promise.all(
      item.workspace_path
        ? [
            git.worktreeSnapshot(item.workspace_path).catch(e => ({ error: e.message })),
            git.worktreeDiff(item.workspace_path).catch(e => ({ error: e.message })),
          ]
        : [null, null]
    ).then(([workspace, diff]) =>
      res.json({
        run: item,
        workspace,
        diff,
        agent: improvementAgent.status(root, item),
        events: events.list({ correlation_id: item.correlation_id, limit: 200 }),
      })
    );
  });
  app.get('/api/improvements/:id/artifacts/:name', (req, res) => {
    try {
      const item = events.getImprovement(req.params.id);
      if (!item) return res.status(404).json({ error: 'improvement run not found' });
      if (!item.sandbox?.instance)
        return res.status(404).json({ error: 'improvement sandbox not found' });
      const file = devsandbox.improvementArtifactPath(root, item.sandbox.instance, req.params.name);
      if (!fs.existsSync(file)) return res.status(404).json({ error: 'artifact not found' });
      res.set('X-Content-Type-Options', 'nosniff');
      if (req.params.name.endsWith('.png')) res.type('image/png');
      else res.type('application/json');
      res.sendFile(file);
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
    }
  });
  app.post('/api/improvements/start', async (req, res) => {
    try {
      const site = req.body && req.body.site;
      const key = req.body && req.body.key;
      if (!isKnownSite(root, site)) return res.status(404).json({ error: 'unknown site' });
      if (!/^[a-f0-9]{20}$/.test(String(key || '')))
        return res.status(400).json({ error: 'invalid intelligence action key' });
      const [snapshot, analyticsBaseline, revenueSnapshot] = await Promise.all([
        seoIntelligence.buildSnapshot({ root }),
        analytics.summary(site, 28),
        Promise.resolve(revenue.amazonSummary(root)),
      ]);
      const action = snapshot.actions.find(row => row.site === site && row.key === key);
      if (!action) return res.status(404).json({ error: 'intelligence action no longer exists' });
      const baseline = {
        ...analyticsBaseline,
        revenue: revenue.siteAttribution(revenueSnapshot, site) || {
          has_data: false,
          site,
        },
      };
      const result = improvements.start({ store: events, root, site, action, baseline });
      if (!result.duplicate) {
        const rel = `ops/tasks/backlog/${result.run.task_file}`;
        await git.commit(root, site, [rel], `chore: queue ${result.run.title}`);
        events.record({
          event_type: 'improvement.task_committed',
          source: 'improvement-workbench',
          site_id: `site:${site}`,
          entity_type: 'task',
          entity_id: result.run.task_id,
          correlation_id: result.run.correlation_id,
          payload: { path: rel },
        });
      }
      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
    }
  });
  app.post('/api/improvements/:id/transition', async (req, res) => {
    try {
      const item = events.getImprovement(req.params.id);
      if (!item) return res.status(404).json({ error: 'improvement run not found' });
      const target = req.body?.state;
      if (['deployed', 'rolled-back'].includes(target))
        return res.status(400).json({
          error: `use the guarded ${target === 'deployed' ? 'deploy' : 'rollback'} action`,
        });
      if (target === 'building') await syncImprovementTask(root, item, 'in-progress');
      if (target === 'cancelled') {
        const cleanup = await cleanupImprovementResources(root, item);
        if (!cleanup.cleaned) return res.status(409).json({ error: cleanup.error });
        await syncImprovementTask(root, item, 'hold');
      }
      const changed = improvements.transition(events, req.params.id, req.body || {});
      syncChangeRequestFromRun(changed);
      res.json({ run: changed });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
    }
  });
  app.post('/api/improvements/:id/build', async (req, res) => {
    try {
      const item = events.getImprovement(req.params.id);
      if (!item) return res.status(404).json({ error: 'improvement run not found' });
      if (item.state !== 'proposed' && item.state !== 'regressed')
        return res.status(409).json({ error: `cannot start build from ${item.state}` });
      const collision = events
        .listImprovements({ site: item.site, limit: 100 })
        .find(
          row =>
            row.run_id !== item.run_id &&
            ['building', 'review', 'deployed', 'measuring'].includes(row.state)
        );
      if (collision)
        return res
          .status(409)
          .json({ error: `another improvement is active for this site: ${collision.title}` });
      await syncImprovementTask(root, item, 'in-progress');
      const worktree = await git.createWorktree(root, item.site, item.run_id);
      const sandbox = await devsandbox.startImprovement(
        root,
        item.site,
        item.run_id,
        worktree.path
      );
      const changed = improvements.transition(events, item.run_id, {
        state: 'building',
        branch: worktree.branch,
      });
      const enriched = events.updateImprovement(item.run_id, {
        workspace_path: worktree.path,
        sandbox: { ...sandbox, workspace_path: worktree.path },
      });
      events.record({
        event_type: 'improvement.sandbox_started',
        source: 'improvement-workbench',
        site_id: `site:${item.site}`,
        entity_type: 'improvement',
        entity_id: item.run_id,
        correlation_id: item.correlation_id,
        payload: { branch: worktree.branch, workspace_path: worktree.path, sandbox },
      });
      res.json({ run: enriched, worktree, sandbox });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
    }
  });
  app.post('/api/improvements/:id/measure', async (req, res) => {
    try {
      const item = events.getImprovement(req.params.id);
      if (!item) return res.status(404).json({ error: 'improvement run not found' });
      if (item.state !== 'measuring')
        return res.status(409).json({ error: `cannot measure from ${item.state}` });
      const today = new Date().toISOString().slice(0, 10);
      if (item.measurement_due && item.measurement_due > today && !(req.body && req.body.force))
        return res.status(409).json({ error: `measurement window closes ${item.measurement_due}` });
      const current = await measurementRunner.captureMetrics(root, item.site, analytics, revenue);
      const outcome = improvements.compareOutcome(
        item.baseline?.analytics || item.baseline || {},
        current
      );
      const changed = improvements.transition(events, item.run_id, {
        state: outcome.classification,
        outcome,
      });
      if (['proven', 'inconclusive'].includes(outcome.classification))
        await cleanupImprovementResources(root, item);
      syncChangeRequestFromRun(changed);
      res.json({ run: changed, outcome });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
    }
  });
  app.post('/api/improvements/:id/validate', async (req, res) => {
    try {
      const item = events.getImprovement(req.params.id);
      if (!item) return res.status(404).json({ error: 'improvement run not found' });
      if (item.state !== 'building')
        return res.status(409).json({ error: `cannot validate from ${item.state}` });
      if (!item.sandbox?.instance)
        return res.status(409).json({ error: 'isolated sandbox is not running' });
      const workspace = await git.worktreeSnapshot(item.workspace_path);
      if (workspace.dirty)
        return res.status(409).json({ error: 'commit the worktree changes before validation' });
      if (improvementAgent.status(root, item).running)
        return res.status(409).json({ error: 'wait for the implementation agent to finish' });
      await devsandbox.prepareDependencies(item.sandbox.instance);
      let preview = {};
      try {
        preview = await devsandbox.devStart(item.sandbox.instance);
      } catch (e) {
        preview = { status: 'error', error: e.message };
      }
      const validation = await devsandbox.validate(item.sandbox.instance);
      validation.commit = workspace.commit;
      validation.preview = await validatePreview(item.sandbox.instance, item.sandbox.devUrl);
      if (preview.error) validation.preview.startup_error = preview.error;
      validation.browser = await devsandbox.browserAudit(root, item.sandbox.instance, item.site);
      const finalValidation = applyQualityPolicy(root, item.site, validation);
      const changed = events.updateImprovement(item.run_id, {
        validation: finalValidation,
        preview_url: finalValidation.preview.url || item.sandbox.devUrl,
      });
      events.record({
        event_type: 'improvement.validated',
        source: 'improvement-workbench',
        site_id: `site:${item.site}`,
        entity_type: 'improvement',
        entity_id: item.run_id,
        correlation_id: item.correlation_id,
        payload: {
          passed: finalValidation.passed,
          checks: finalValidation.checks,
          policy: finalValidation.policy,
        },
      });
      res.json({ run: changed, validation: finalValidation });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
    }
  });

  app.post('/api/improvements/:id/agent', (req, res) => {
    try {
      const item = events.getImprovement(req.params.id);
      if (!item) return res.status(404).json({ error: 'improvement run not found' });
      const task = findImprovementTask(root, item);
      res.status(202).json(
        improvementAgent.start({
          root,
          store: events,
          run: item,
          taskBody: task?.body,
          provider:
            req.body?.provider || item.agent?.provider || improvementAgent.defaultProvider(),
          model: req.body?.model || item.agent?.model || improvementAgent.defaultModel(),
          maxTurns: req.body?.max_turns || item.agent?.max_turns || 20,
          role: req.body?.assigned_role || item.agent?.assigned_role || null,
        })
      );
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
    }
  });

  app.post('/api/improvements/:id/commit', async (req, res) => {
    try {
      const item = events.getImprovement(req.params.id);
      if (!item) return res.status(404).json({ error: 'improvement run not found' });
      if (item.state !== 'building' || !item.workspace_path)
        return res.status(409).json({ error: 'run is not build-ready' });
      if (improvementAgent.status(root, item).running)
        return res.status(409).json({ error: 'wait for the implementation agent to finish' });
      const snapshot = await git.commitWorktree(
        item.workspace_path,
        req.body?.message || `feat: ${item.title}`
      );
      events.record({
        event_type: 'improvement.change_committed',
        source: 'improvement-workbench',
        site_id: `site:${item.site}`,
        entity_type: 'commit',
        entity_id: snapshot.commit,
        correlation_id: item.correlation_id,
        payload: snapshot,
      });
      syncChangeRequestFromRun(item, 'committed');
      res.json({ workspace: snapshot });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
    }
  });

  app.post('/api/improvements/:id/deploy', async (req, res) => {
    try {
      const item = events.getImprovement(req.params.id);
      if (!item) return res.status(404).json({ error: 'improvement run not found' });
      if (item.state !== 'review' || item.validation?.passed !== true)
        return res.status(409).json({ error: 'approved, passing review required' });
      if (req.body?.confirm !== item.title)
        return res.status(400).json({ error: 'type the improvement title to approve deployment' });
      const workspace = await git.worktreeSnapshot(item.workspace_path);
      if (workspace.dirty || workspace.commit !== item.validation.commit)
        return res
          .status(409)
          .json({ error: 'worktree changed after validation; commit and rerun quality gates' });
      await syncImprovementTask(root, item, 'done');
      const deployed = await git.deployWorktree(root, item.site, item.workspace_path, item.branch);
      const changed = improvements.transition(events, item.run_id, {
        state: 'deployed',
        deployment_id: deployed.commit,
        measurement_due: improvements.measurementDate(14),
        approval: {
          approved_at: new Date().toISOString(),
          access: auth.accessLevel(req),
          confirmation: 'title',
        },
        production_before: deployed.before,
      });
      syncChangeRequestFromRun(changed, 'deployed');
      if (item.sandbox?.instance) {
        try {
          await devsandbox.stop(item.sandbox.instance);
        } catch {
          /* already stopped */
        }
      }
      res.json({ run: changed, deployment: deployed });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
    }
  });

  app.post('/api/improvements/:id/rollback', async (req, res) => {
    try {
      const item = events.getImprovement(req.params.id);
      if (!item) return res.status(404).json({ error: 'improvement run not found' });
      if (!['deployed', 'measuring', 'regressed'].includes(item.state))
        return res.status(409).json({ error: `cannot roll back from ${item.state}` });
      if (req.body?.confirm !== item.title)
        return res.status(400).json({ error: 'type the improvement title to confirm rollback' });
      const result = await git.rollbackCommit(root, item.site, item.deployment_id);
      const run = improvements.transition(events, item.run_id, {
        state: 'rolled-back',
        outcome: {
          ...(item.outcome || {}),
          rolled_back_at: new Date().toISOString(),
          rollback_commit: result.localSha,
        },
      });
      syncChangeRequestFromRun(run, 'failed');
      await cleanupImprovementResources(root, item);
      res.json({ run, git: result });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
    }
  });

  // SEO Intelligence joins first-party GSC data with the latest fleet-owned
  // web-vitals and link-rot reports, then emits ranked, evidence-backed work.
  app.get('/api/seo-intelligence', async (req, res) => {
    try {
      const days = Math.max(28, Math.min(parseInt(req.query.days, 10) || 90, 400));
      res.json(await seoIntelligence.buildSnapshot({ root, days }));
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });
  app.post('/api/seo-intelligence/file', async (req, res) => {
    try {
      const site = req.body && req.body.site;
      const key = req.body && req.body.key;
      if (!isKnownSite(root, site)) return res.status(404).json({ error: 'unknown site' });
      if (!/^[a-f0-9]{20}$/.test(String(key || '')))
        return res.status(400).json({ error: 'invalid intelligence action key' });
      const snapshot = await seoIntelligence.buildSnapshot({ root });
      const action = snapshot.actions.find(row => row.site === site && row.key === key);
      if (!action) return res.status(404).json({ error: 'intelligence action no longer exists' });
      // Re-read task markers at mutation time instead of trusting the cached
      // snapshot, so two open dashboard tabs cannot file the same action.
      if (seoIntelligence.filedActionKeys(root, [site]).has(key))
        return res.json({ ok: true, duplicate: true });
      const assignedRole = ['web-vitals', 'broken-links', 'crawlability'].includes(action.type)
        ? 'engineer'
        : 'seo-analyst';
      const priority = action.priority === 'high' ? 1 : action.priority === 'medium' ? 2 : 3;
      const correlationId = `seo:${action.key}`;
      const taskId = crypto.randomUUID();
      const measurementDue = new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);
      const executionPlan = (action.plan || [])
        .map((step, index) => `${index + 1}. ${step}`)
        .join('\n');
      const file = tasks.create(root, site, 'backlog', {
        task_id: taskId,
        title: action.title,
        priority,
        type: 'seo',
        estimated_turns: action.priority === 'high' ? 3 : 2,
        assigned_role: assignedRole,
        source: 'seo-intelligence',
        source_id: action.key,
        correlation_id: correlationId,
        measurement_due: measurementDue,
        body:
          `## Evidence\n\n${action.evidence}\n\n` +
          `${action.page ? `Page: https://${site}${action.page}\n\n` : ''}` +
          `${action.query ? `Query: ${action.query}\n\n` : ''}` +
          `Opportunity score: ${action.score}/100\n\n` +
          `Value signal: ${action.valueScore || 0}/100 (conversions, sessions, engagement, and search demand; not revenue)\n\n` +
          `Prioritized rank: ${action.rankScore || action.score}/100\n\n` +
          `## Recommended action\n\n${action.recommendation}\n\n` +
          `## Execution plan\n\n${executionPlan}\n\n` +
          `## Acceptance criteria\n\nComplete the plan, rerun the relevant fleet measurement, and record the post-change result against this baseline.\n\n` +
          `seo-intelligence-key: ${action.key}\n`,
      });
      events.record({
        event_type: 'recommendation.task_filed',
        source: 'seo-intelligence',
        site_id: `site:${site}`,
        entity_type: 'task',
        entity_id: taskId,
        correlation_id: correlationId,
        payload: {
          action_key: action.key,
          file,
          assigned_role: assignedRole,
          baseline: action.metric || null,
          measurement_due: measurementDue,
        },
      });
      seoIntelligence.clearCache();
      res.status(201).json({
        ok: true,
        file,
        site,
        task_id: taskId,
        correlation_id: correlationId,
        assigned_role: assignedRole,
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: String(e.message || e) });
    }
  });

  // Deterministic Lighthouse evidence. The dashboard reads factor-specific
  // reports and queues a detached sweep; it never runs Chrome in the request
  // process or treats a manually queued run as completed until the report
  // lands on disk.
  app.get('/api/web-vitals', (_req, res) => {
    try {
      res.json(webvitals.snapshot(root));
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });
  app.post('/api/web-vitals/run', async (req, res) => {
    try {
      res.status(202).json(await webvitals.run(root, req.body?.form_factor || 'mobile'));
    } catch (e) {
      res.status(e.httpStatus || 400).json({ error: String(e.message || e) });
    }
  });

  // Backlink coverage/provenance is a separate fleet dataset from SEO
  // Intelligence. The read path is deterministic and falls back to a live
  // repo scan when the scheduled artifact is absent.
  app.get('/api/backlinks', (_req, res) => {
    try {
      res.json(backlinks.readSnapshot(root));
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });
  app.get('/api/backlinks/:slug', requireSite, (req, res) => {
    try {
      const result = backlinks.detail(root, req.params.slug);
      if (!result) return res.status(404).json({ error: 'backlink record not found' });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });
  app.post('/api/backlinks/:slug/file', requireSite, (req, res) => {
    try {
      const site = req.params.slug;
      const record = backlinks.detail(root, site);
      if (!record) return res.status(404).json({ error: 'backlink record not found' });
      const existing = tasks
        .list(root, site)
        .backlog.concat(
          tasks.list(root, site)['in-progress'] || [],
          tasks.list(root, site).hold || []
        )
        .find(task => task.source === 'backlink-audit' && task.source_id === site);
      if (existing) return res.json({ ok: true, duplicate: true, file: existing.file });
      const taskId = crypto.randomUUID();
      const priority = record.priority === 'high' ? 1 : record.priority === 'medium' ? 2 : 3;
      const file = tasks.create(root, site, 'backlog', {
        task_id: taskId,
        title: `Capture and review backlinks for ${site}`,
        priority,
        type: 'seo',
        estimated_turns: 2,
        assigned_role: 'seo-analyst',
        source: 'backlink-audit',
        source_id: site,
        correlation_id: `backlink:${site}`,
        body:
          `## Current status\n\n${record.label}: ${record.recommendation}\n\n` +
          `Latest report: ${record.latestDate || 'none'}\n\n` +
          `## Acceptance criteria\n\nRun the strongest available backlink source, preserve the raw provenance in \`ops/seo/backlinks-YYYY-MM-DD.md\`, and record whether any legacy URLs or referring domains should be reclaimed.\n`,
      });
      res.status(201).json({ ok: true, file, task_id: taskId, assigned_role: 'seo-analyst' });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });
  app.post('/api/backlinks/baseline-tasks', (_req, res) => {
    try {
      res.status(201).json(backlinks.createBaselineTasks(root));
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });
  app.post('/api/backlinks/run', (_req, res) => {
    try {
      const script = path.join(root, 'tools', 'backlink-audit', 'audit.js');
      const child = require('node:child_process').spawn(
        process.execPath,
        [script, '--root', root],
        {
          cwd: root,
          detached: true,
          stdio: 'ignore',
        }
      );
      child.unref();
      res.status(202).json({ ok: true, message: 'backlink audit queued' });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Data Hub Images routes — proxy over the data-hub-images FastAPI service
  // (tools/data-hub-images, :4770). Same degrade-to-200 convention as
  // /api/datahub/* above: proxied reads never throw, so they never 500.
  app.get('/api/datahub-images/health', async (_req, res) =>
    res.json(await datahubImages.health())
  );
  app.get('/api/datahub-images/stats', async (_req, res) => res.json(await datahubImages.stats()));
  app.get('/api/datahub-images/sources', async (_req, res) =>
    res.json(await datahubImages.sources())
  );
  app.get('/api/datahub-images/egress', async (req, res) => {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 200, 300));
    res.json(await datahubImages.egress(limit));
  });
  app.get('/api/datahub-images/pulls', async (req, res) => {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 200, 300));
    res.json(await datahubImages.pulls(limit));
  });
  app.get('/api/datahub-images/images', async (req, res) => {
    res.json(
      await datahubImages.images({
        topic: req.query.topic,
        site: req.query.site,
        status: req.query.status,
        limit: req.query.limit,
      })
    );
  });
  app.post('/api/datahub-images/sources/:id/enabled', async (req, res) => {
    const enabled = !!(req.body && req.body.enabled);
    res.json(await datahubImages.setSourceEnabled(req.params.id, enabled));
  });
  app.post('/api/datahub-images/images/:id/blacklist', async (req, res) => {
    res.json(await datahubImages.blacklistImage(req.params.id));
  });
  app.post('/api/datahub-images/images/:id/reject', async (req, res) => {
    res.json(await datahubImages.rejectImage(req.params.id));
  });
  // Binary passthrough — the thumbnail source. Never a JSON 200 on failure
  // (there's no useful degraded image), so this is the one datahub-images
  // route that returns a non-200 status when the upstream is unreachable.
  app.get('/api/datahub-images/image/:id', async (req, res) => {
    const r = await datahubImages.imageBytes(req.params.id);
    if (!r.ok) return res.status(404).json({ error: 'image unavailable' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const contentType =
      typeof r.contentType === 'string' && r.contentType.startsWith('image/')
        ? r.contentType
        : 'application/octet-stream';
    res.setHeader('content-type', contentType);
    res.send(r.buffer);
  });

  app.get('/api/sites', (_req, res) => res.json(discoverSites(root)));

  // Domain onboarding/offboarding. The panel NEVER runs the domain scripts
  // itself — it spools a job that tools/scripts/domain-job-runner.sh picks up
  // on the host (as uid 1000, with gh/nvm on PATH) and hands to the existing
  // tools/scripts/domain-manager-cli.sh. See server/domains.js for why.
  app.get('/api/domains', (_req, res) => {
    try {
      res.json(domains.overview(root, discoverSites(root)));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/domains/jobs', (req, res) => {
    try {
      res.status(202).json(domains.enqueue(root, req.body || {}));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.get('/api/domains/jobs/:id', (req, res) => {
    try {
      res.json(domains.jobLog(root, req.params.id));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/domains/jobs/:id/cancel', (req, res) => {
    try {
      res.json(domains.cancel(root, req.params.id));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // Identity/content guardrail lists (blocked/warn terms) + audit log —
  // backs both the pre-commit hook (tools/content-guardrails) and this tab.
  app.get('/api/guardrails/config', (_req, res) => {
    try {
      res.json(guardrails.getConfig());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.put('/api/guardrails/config', (req, res) => {
    try {
      res.json(guardrails.setConfig(req.body));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/guardrails/log', (req, res) => {
    try {
      res.json(guardrails.getLog(req.query.limit));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Live technical privacy baseline. Results come from deployed pages and
  // same-origin JS bundles, not COOKIE_COMPLIANCE.md.
  app.get('/api/compliance', (_req, res) => {
    try {
      const sites = discoverSites(root);
      compliance.scanMissing(sites).catch(() => {});
      res.json(compliance.matrix(sites));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.get('/api/compliance/progress', (_req, res) => res.json(compliance.progress()));
  app.get('/api/compliance/history', (req, res) => {
    try {
      res.json(compliance.fleetHistory(discoverSites(root), req.query.limit));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.post('/api/compliance/scan', (_req, res) => {
    try {
      res.status(202).json(compliance.startScan(discoverSites(root)));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.post('/api/compliance/:slug/scan', requireSite, async (req, res) => {
    try {
      res.json(await compliance.scanOne(req.params.slug));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // The fleet engineer audit (delegates to engineer-status.py --json).
  app.get('/api/fleet', async (_req, res) => {
    try {
      res.json(await audit.fleet(root));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/fleet/history', async (req, res) => {
    try {
      res.json(await audit.history(root, req.query.days));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Trigger one engineer to run now (same command cron fires, detached).
  app.post('/api/fleet/:slug/run', requireSite, async (req, res) => {
    try {
      res.json({ ok: true, container: await run.runEngineer(root, req.params.slug) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // Agent list for the nav dropdown (roles on ≥2 sites, engineer first).
  app.get('/api/agents', (_req, res) => {
    try {
      res.json(roles.agents(root, discoverSites(root)));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Roles matrix: site × role status from crontab + disabled flags + logs.
  app.get('/api/roles', async (_req, res) => {
    try {
      res.json(await roles.matrix(root, discoverSites(root)));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Seven-day role health: expected-vs-observed runs, failures, AI cost, and
  // prompt/runner drift. The role matrix remains the enrollment source.
  app.get('/api/agents/:role/health', async (req, res) => {
    try {
      const now = new Date();
      const day = d => d.toISOString().slice(0, 10);
      const from = new Date(now.getTime() - 7 * 86400 * 1000);
      const usage = await aiusage.fleet(root, { from: day(from), to: day(now) });
      res.json(await roles.health(root, req.params.role, discoverSites(root), usage));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // Writer-role turn-budget audit (delegates to tools/task-budget/turn_budget.py
  // audit --json): static vs. computed --max-turns per site/role, plus
  // dead-role backlog task drift.
  app.get('/api/task-budget', async (_req, res) => {
    try {
      res.json(await taskbudget.fleet(root));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Dispatch-aware AI inventory: provider/model/policy for every scheduled
  // service. The Python CLI remains the single source of truth.
  app.get('/api/ai-inventory', async (_req, res) => {
    try {
      res.json(await aiinventory.fleet(root));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Fleet lint sweep. GET serves the cached report the CLI wrote (a live sweep
  // is ~25s, too slow for a request); POST kicks a fresh one off in the
  // background and the UI polls GET until progress.running clears.
  app.get('/api/lint', (_req, res) => {
    try {
      res.json(lintfleet.latest(root));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/lint/scan', (req, res) => {
    try {
      const { started, running, scope, startedAt } = lintfleet.scan(root, req.query.site);
      res.status(202).json({ started, running, scope, startedAt });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // Real AI token usage/cost, rolled up from the per-site ledgers written by
  // tools/scripts/claude-tracked.sh (tools/ai-usage/aggregate.py is the source
  // of truth). Sites not yet migrated to the tracked wrapper report zero
  // calls, listed under summary.sites_uninstrumented, not as an error.
  app.get('/api/ai-usage', async (req, res) => {
    try {
      res.json(await aiusage.fleet(root, { from: req.query.from, to: req.query.to }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Background CF deploy-health cache (powers the deployer cell's "is it live?"
  // half). Exposed for inspection/debugging.
  app.get('/api/deploy-health', (_req, res) => res.json(deployhealth.all()));
  app.get('/api/cloudflare-builds', (req, res) => {
    try {
      res.json(
        cloudflarebuilds.summarize(undefined, {
          days: req.query.days,
          limit: req.query.limit,
        })
      );
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });
  app.get('/api/gatus', (_req, res) => res.json(gatushealth.all()));

  // Parked inventory (F51) — registry entries with status: scaffold. Read
  // straight from registry/fleet.yaml, not from site discovery: a scaffold
  // runs nothing, so it is invisible to every other roster in this panel.
  app.get('/api/scaffolds', (req, res) =>
    res.json(scaffolds.all(root, { fresh: req.query.fresh === '1' }))
  );

  // Domain renewals (F51) — served from tools/registrar's cache, never a live
  // Cloudflare call. auto_renew matters more than the date: an expiry 40 days
  // out is routine if it renews itself and an emergency if it does not.
  app.get('/api/registrar', (req, res) =>
    res.json(registrar.all(root, { fresh: req.query.fresh === '1' }))
  );

  // fleet-doctor (F33) — container/image invariants across every cron site.
  // Served from a background sweep; POST re-runs it on demand.
  app.get('/api/fleet-doctor', (_req, res) => res.json(fleetdoctor.all()));

  // Retention policy (F20/F43) — tools/retention/policy.yaml, the one place
  // retention is declared. Only retain_days is settable from here;
  // delete_after_days stays file-only on purpose (see retention.js header:
  // on this host retention means compress, not delete).
  app.get('/api/retention', (_req, res) => res.json(retention.read(root)));
  app.post('/api/retention', (req, res) => {
    const out = retention.setRetainDays(root, {
      klass: req.body && req.body.class,
      days: req.body && req.body.retain_days,
    });
    res.status(out.ok ? 200 : 400).json(out);
  });
  app.post('/api/fleet-doctor/run', async (_req, res) => {
    await fleetdoctor.run(root);
    res.json(fleetdoctor.all());
  });

  // Social Hub (tools/social-hub) — proxied; see socialhub.js for why.
  socialhub.registerRoutes(app);

  // Unified automation controls: tracked Social Hub YAML, worker schedules,
  // enable flags, and role prompt files. The module validates and writes the
  // existing source-of-truth files; the dashboard adds the audit record.
  app.get('/api/automation/:slug', requireSite, (req, res) => {
    try {
      res.json(automation.get(root, req.params.slug));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.patch('/api/automation/:slug/social', requireSite, (req, res) => {
    try {
      res.json(automation.patchSocial(root, req.params.slug, req.body || {}));
    } catch (e) {
      res.status(e.httpStatus || 400).json({ error: e.message });
    }
  });
  app.put('/api/automation/:slug/social', requireSite, (req, res) => {
    try {
      res.json(automation.replaceSocialYaml(root, req.params.slug, req.body && req.body.raw));
    } catch (e) {
      res.status(e.httpStatus || 400).json({ error: e.message });
    }
  });
  app.patch('/api/automation/:slug/roles/:role', requireSite, (req, res) => {
    try {
      res.json(automation.updateRole(root, req.params.slug, req.params.role, req.body || {}));
    } catch (e) {
      res.status(e.httpStatus || 400).json({ error: e.message });
    }
  });
  app.post('/api/automation/:slug/roles', requireSite, (req, res) => {
    try {
      res.json(automation.createRole(root, req.params.slug, req.body || {}));
    } catch (e) {
      res.status(e.httpStatus || 400).json({ error: e.message });
    }
  });
  app.delete('/api/automation/:slug/roles/:role', requireSite, (req, res) => {
    try {
      res.json(automation.removeRole(root, req.params.slug, req.params.role));
    } catch (e) {
      res.status(e.httpStatus || 400).json({ error: e.message });
    }
  });

  // Background fleet-wide error/warn log scan (server/errorscan.js). Read-only
  // rollup; :id/lines below is guarded implicitly — errorscan only ever tracks
  // ids sourced from containers.list(root), which is already repo-scoped.
  app.get('/api/errors', (_req, res) => res.json(errorscan.rollup()));
  app.get('/api/errors/:id/lines', (req, res) => {
    const r = errorscan.lines(req.params.id, req.query.limit);
    if (!r) return res.status(404).json({ error: 'unknown container (not currently scanned)' });
    res.json(r);
  });

  app.get('/api/roles/:slug/:role/log', requireSite, (req, res) => {
    try {
      res.json(roles.roleLog(root, req.params.slug, req.params.role, req.query.tail));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // Role actions: pause / resume (toggle ops/.<role>-disabled) or run (fire now).
  app.post('/api/roles/:slug/:role/:action', requireSite, async (req, res) => {
    const act = req.params.action;
    try {
      if (act === 'run')
        return res.json({
          ok: true,
          container: await run.runRole(root, req.params.slug, req.params.role),
        });
      if (act === 'pause' || act === 'resume')
        return res.json(roles.setEnabled(root, req.params.slug, req.params.role, act === 'resume'));
      return res.status(400).json({ error: 'unknown action' });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // Containers: list domains-repo containers, lifecycle actions, logs, bounce.
  app.get('/api/containers', async (_req, res) => {
    try {
      res.json(await containers.list(root));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // Fleet-wide bounce: restart every released site's legacy cron container.
  // Adopted sites are controlled by fleet-scheduler. Defined before :id/:action.
  app.post('/api/containers/restart-crons', async (_req, res) => {
    try {
      res.json(await containers.restartCrons(root));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/containers/:id/:action', async (req, res) => {
    try {
      res.json(await containers.action(root, req.params.id, req.params.action));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.get('/api/containers/:id/logs', async (req, res) => {
    try {
      res.json(await containers.logs(root, req.params.id, req.query.tail));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/sites/:slug/bounce', requireSite, async (req, res) => {
    try {
      res.json(await containers.bounce(root, req.params.slug));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // Cron control plane (folded in from the retired cron-manager tool). Operates
  // at the crontab-LINE level: list every cron entry, edit a schedule, comment/
  // remove a line, diff/revert vs the baked-in crontab, rebuild + verify. Routes
  // are thin wrappers over server/cron.js. NOTE: cron "systems" include tools/*,
  // not just sites/*, so these validate via cron.findSystem (not requireSite).
  app.get('/api/cron/describe', (req, res) => res.json(cron.validateAndDescribe(req.query.expr)));

  app.get('/api/cron/systems', async (_req, res) => {
    try {
      res.json(await cron.systems(root));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.get('/api/cron/systems/:slug/logs', async (req, res) => {
    try {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.send(await cron.logs(root, req.params.slug, req.query.source, req.query.tail));
    } catch (e) {
      res.status(e.httpStatus || 500).send(e.message);
    }
  });

  app.get('/api/cron/systems/:slug/diff', async (req, res) => {
    try {
      res.json(await cron.diff(root, req.params.slug));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/cron/systems/:slug/crontab', async (req, res) => {
    try {
      res.json(await cron.crontabMutate(root, req.params.slug, req.body || {}));
    } catch (e) {
      res.status(e.httpStatus || 400).json({ error: e.message });
    }
  });

  app.post('/api/cron/systems/:slug/revert', async (req, res) => {
    try {
      res.json(await cron.revert(root, req.params.slug));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/cron/systems/:slug/rebuild', async (req, res) => {
    try {
      await cron.rebuild(root, req.params.slug, res);
    } catch (e) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* already closed */
        }
      } else res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // Manual run streams — define BEFORE the generic :action flag route.
  app.post('/api/cron/systems/:slug/jobs/:role/run', async (req, res) => {
    try {
      await cron.runJob(root, req.params.slug, req.params.role, res);
    } catch (e) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* already closed */
        }
      } else res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/cron/systems/:slug/jobs/:role/:action', (req, res) => {
    try {
      res.json(cron.jobFlag(root, req.params.slug, req.params.role, req.params.action));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // ---- Git Hygiene (tools/fleet-git) ------------------------------------
  // Defined BEFORE /api/git/:slug so "hygiene" is never captured as a slug.
  app.get('/api/git/hygiene', (_req, res) => {
    try {
      res.json(githygiene.board());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Dry run by default; { apply: true } is the only thing that writes.
  app.post('/api/git/hygiene/sweep', async (req, res) => {
    try {
      const b = req.body || {};
      const only = Array.isArray(b.only) && b.only.length ? b.only : null;
      res.json(await githygiene.run(root, { apply: b.apply === true, only }));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/git/hygiene/resolve', async (req, res) => {
    try {
      res.json(await githygiene.resolve(root, req.body || {}));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/git/hygiene/ignore-sync', async (req, res) => {
    try {
      const b = req.body || {};
      const only = Array.isArray(b.only) && b.only.length ? b.only : null;
      res.json(await githygiene.ignoreSync(root, { apply: b.apply === true, only }));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // Git: fleet-wide one-line summaries, and a per-site detailed file list.
  app.get('/api/git', async (_req, res) => {
    try {
      res.json(await git.summaries(root, discoverSites(root)));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Fleet-wide bulk push (F6): push every site that's ahead of origin. Defined
  // before :slug so "push-all" isn't captured as a slug.
  app.post('/api/git/push-all', async (_req, res) => {
    try {
      res.json(await git.pushAll(root, discoverSites(root)));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // Fleet-wide bulk pull (F25): pull every site that's behind origin. Same
  // shape as push-all, defined before :slug for the same reason.
  app.post('/api/git/pull-all', async (_req, res) => {
    try {
      res.json(await git.pullAll(root, discoverSites(root)));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.get('/api/git/:slug', requireSite, async (req, res) => {
    try {
      res.json(await git.status(root, req.params.slug));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Per-file diff preview (F5): working tree vs HEAD (or whole file for untracked).
  app.get('/api/git/:slug/diff', requireSite, async (req, res) => {
    try {
      res.json(await git.fileDiff(root, req.params.slug, req.query.path));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // Safe write ops: commit selected paths, ignore (gitignore+commit), push.
  app.post('/api/git/:slug/commit', requireSite, async (req, res) => {
    try {
      const body = req.body || {};
      const correlations = [];
      for (const rel of Array.isArray(body.paths) ? body.paths : []) {
        if (!/^ops\/tasks\/(?:backlog|in-progress|done|hold)\/[A-Za-z0-9._-]+\.md$/.test(rel))
          continue;
        try {
          const [, , column, file] = rel.split('/');
          const task = tasks.get(root, req.params.slug, column, file);
          correlations.push({
            task_id: task.meta.task_id || `legacy:${req.params.slug}:${file}`,
            correlation_id: task.meta.correlation_id || null,
            file,
          });
        } catch {
          /* selected task may be a deletion */
        }
      }
      const result = await git.commit(root, req.params.slug, body.paths, body.message);
      const after = await git.status(root, req.params.slug);
      for (const link of correlations)
        events.record({
          event_type: 'change.committed',
          source: 'fleet-dashboard',
          site_id: `site:${req.params.slug}`,
          entity_type: 'commit',
          entity_id: after.localSha,
          correlation_id: link.correlation_id || `task:${link.task_id}`,
          payload: {
            task_id: link.task_id,
            file: link.file,
            paths: body.paths,
            message: body.message,
          },
        });
      res.json({ ...result, commit: after.localSha, correlations: correlations.length });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/git/:slug/ignore', requireSite, async (req, res) => {
    try {
      res.json(await git.ignore(root, req.params.slug, (req.body || {}).path));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/git/:slug/push', requireSite, async (req, res) => {
    try {
      const before = await git.status(root, req.params.slug);
      const result = await git.push(root, req.params.slug);
      events.record({
        event_type: 'change.pushed',
        source: 'fleet-dashboard',
        site_id: `site:${req.params.slug}`,
        entity_type: 'commit',
        entity_id: before.localSha,
        payload: { branch: before.branch },
      });
      res.json(result);
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.get('/api/git/:slug/branches', requireSite, async (req, res) => {
    try {
      res.json(await git.branches(root, req.params.slug));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.delete('/api/git/:slug/branches/:branch(*)', requireSite, async (req, res) => {
    try {
      res.json(await git.deleteBranch(root, req.params.slug, req.params.branch));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.get('/api/git/:slug/stashes', requireSite, async (req, res) => {
    try {
      res.json(await git.stashes(root, req.params.slug));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.get('/api/git/:slug/stashes/:index/diff', requireSite, async (req, res) => {
    try {
      res.json(await git.stashDiff(root, req.params.slug, req.params.index));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.delete('/api/git/:slug/stashes/:index', requireSite, async (req, res) => {
    try {
      res.json(await git.dropStash(root, req.params.slug, req.params.index));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/git/:slug/pull', requireSite, async (req, res) => {
    try {
      res.json(await git.pull(root, req.params.slug));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // Tasks CRUD ------------------------------------------------------------
  // Cross-fleet aggregate (every site's tasks, flat) — the integrated
  // successor to site-tracker's /tasks page. Client does facet/filter/group.
  app.get('/api/tasks', (_req, res) => {
    try {
      res.json(tasks.listAll(root, discoverSites(root)));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/tasks/:slug', requireSite, (req, res) => {
    try {
      res.json(tasks.list(root, req.params.slug));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.get('/api/tasks/:slug/:column/:file', requireSite, (req, res) => {
    try {
      res.json(tasks.get(root, req.params.slug, req.params.column, req.params.file));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/tasks/:slug/:column', requireSite, (req, res) => {
    try {
      const payload = { ...(req.body || {}) };
      payload.task_id ||= crypto.randomUUID();
      payload.source ||= 'fleet-dashboard';
      payload.correlation_id ||= `task:${payload.task_id}`;
      payload.assigned_role = assignedRoleForType(payload.type, payload.assigned_role);
      const file = tasks.create(root, req.params.slug, req.params.column, payload);
      events.record({
        event_type: 'task.created',
        source: 'fleet-dashboard',
        site_id: `site:${req.params.slug}`,
        entity_type: 'task',
        entity_id: payload.task_id,
        correlation_id: payload.correlation_id,
        payload: {
          file,
          column: req.params.column,
          title: payload.title || 'Untitled task',
          assigned_role: payload.assigned_role || null,
        },
      });
      res.json({
        ok: true,
        file,
        task_id: payload.task_id,
        correlation_id: payload.correlation_id,
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.put('/api/tasks/:slug/:column/:file', requireSite, (req, res) => {
    try {
      const before = tasks.get(root, req.params.slug, req.params.column, req.params.file);
      const taskId = before.meta.task_id || `legacy:${req.params.slug}:${req.params.file}`;
      const correlationId = before.meta.correlation_id || `task:${taskId}`;
      const file = tasks.update(
        root,
        req.params.slug,
        req.params.column,
        req.params.file,
        req.body || {}
      );
      events.record({
        event_type: 'task.updated',
        source: 'fleet-dashboard',
        site_id: `site:${req.params.slug}`,
        entity_type: 'task',
        entity_id: taskId,
        correlation_id: correlationId,
        payload: { file: req.params.file, column: req.params.column },
      });
      res.json({ ok: true, file });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/tasks/:slug/:column/:file/move', requireSite, (req, res) => {
    try {
      const before = tasks.get(root, req.params.slug, req.params.column, req.params.file);
      const taskId = before.meta.task_id || `legacy:${req.params.slug}:${req.params.file}`;
      const correlationId = before.meta.correlation_id || `task:${taskId}`;
      const moved = tasks.move(
        root,
        req.params.slug,
        req.params.column,
        req.params.file,
        (req.body || {}).to
      );
      events.record({
        event_type: moved.column === 'done' ? 'task.completed' : 'task.moved',
        source: 'fleet-dashboard',
        site_id: `site:${req.params.slug}`,
        entity_type: 'task',
        entity_id: taskId,
        correlation_id: correlationId,
        payload: {
          file: moved.file,
          from: req.params.column,
          to: moved.column,
          measurement_due: before.meta.measurement_due || null,
        },
      });
      res.json({ ok: true, ...moved });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.delete('/api/tasks/:slug/:column/:file', requireSite, (req, res) => {
    try {
      const before = tasks.get(root, req.params.slug, req.params.column, req.params.file);
      const taskId = before.meta.task_id || `legacy:${req.params.slug}:${req.params.file}`;
      const removed = tasks.remove(root, req.params.slug, req.params.column, req.params.file);
      events.record({
        event_type: 'task.trashed',
        source: 'fleet-dashboard',
        site_id: `site:${req.params.slug}`,
        entity_type: 'task',
        entity_id: taskId,
        correlation_id: before.meta.correlation_id || `task:${taskId}`,
        payload: { file: req.params.file, from: req.params.column, trashed: removed.trashed },
      });
      res.json(removed);
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // Guide Queue CRUD --------------------------------------------------------
  // Idea -> drafted -> ready -> released pipeline (tools/guide-queue). Same
  // shape as the Tasks routes above, plus image serving + per-site cadence
  // config (ops/tracked.yaml's manual.guide_cadence_days / guide_ideas_min).
  app.get('/api/guide-queue', (_req, res) => {
    try {
      res.json(guideQueue.listAll(root, discoverSites(root)));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/guide-queue/:slug', requireSite, (req, res) => {
    try {
      res.json(guideQueue.list(root, req.params.slug));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.get('/api/guide-queue/:slug/config', requireSite, (req, res) => {
    try {
      res.json(guideQueue.getConfig(root, req.params.slug));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.put('/api/guide-queue/:slug/config/:field', requireSite, (req, res) => {
    try {
      res.json(
        guideQueue.setConfigField(root, req.params.slug, req.params.field, (req.body || {}).value)
      );
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/guide-queue/:slug/ideas', requireSite, (req, res) => {
    try {
      res.json({ ok: true, file: guideQueue.addIdea(root, req.params.slug, req.body || {}) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.get('/api/guide-queue/:slug/image', requireSite, (req, res) => {
    try {
      res.sendFile(guideQueue.imagePath(root, req.params.slug, req.query.path));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.get('/api/guide-queue/:slug/:status/:file', requireSite, (req, res) => {
    try {
      res.json(guideQueue.get(root, req.params.slug, req.params.status, req.params.file));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.put('/api/guide-queue/:slug/:status/:file', requireSite, (req, res) => {
    try {
      res.json({
        ok: true,
        ...guideQueue.update(
          root,
          req.params.slug,
          req.params.status,
          req.params.file,
          req.body || {}
        ),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/guide-queue/:slug/:status/:file/move', requireSite, (req, res) => {
    try {
      res.json({
        ok: true,
        ...guideQueue.move(
          root,
          req.params.slug,
          req.params.status,
          req.params.file,
          (req.body || {}).to
        ),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // AI Optimizer — fleet AI-cost finding queue (tools/ai-optimizer). Read-and-
  // decide only: tickets are FILED by the analyst role via the Python CLI,
  // which enforces the evidence bar. The dashboard just approves/denies them,
  // so there is deliberately no POST-create route here.
  app.get('/api/ai-optimizer', (_req, res) => {
    try {
      res.json({ summary: aiOptimizer.summary(root), tickets: aiOptimizer.list(root) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/ai-optimizer/:status/:file', (req, res) => {
    try {
      res.json(aiOptimizer.get(root, req.params.status, req.params.file));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // Kill switches for the two ai-optimizer cron jobs. Same flag-file
  // convention as a site role's pause toggle (roles.setEnabled).
  app.put('/api/ai-optimizer/toggle/:job', (req, res) => {
    try {
      const enabled = !!(req.body || {}).enabled;
      res.json(aiOptimizer.setToggle(root, req.params.job, enabled));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // On-demand run of either job — same command supercronic fires, detached
  // inside fleet-cron. The scripts' own flock makes a concurrent trigger a
  // safe no-op. Refuses when the job is paused (see aioptimizer.run).
  app.post('/api/ai-optimizer/run/:job', async (req, res) => {
    try {
      res.json(await aiOptimizer.run(root, req.params.job));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/ai-optimizer/:status/:file/move', (req, res) => {
    try {
      const body = req.body || {};
      res.json({
        ok: true,
        ...aiOptimizer.move(root, req.params.status, req.params.file, body.to, body),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // Dev Sandboxes — per-site sandboxed Claude/ttyd containers, folded in from
  // the standalone domain-developer tool. Site-name validation is entirely
  // delegated to requireSite/discoverSites (no separate allowlist needed).
  app.get('/api/devsandbox/sites', async (_req, res) => {
    try {
      res.json(await devsandbox.list(root, discoverSites(root)));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.get('/api/devsandbox/stats', async (_req, res) => {
    try {
      res.json({ ok: true, containers: await devsandbox.stats() });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/devsandbox/orphans', async (_req, res) => {
    try {
      res.json(await devsandbox.findOrphans(discoverSites(root)));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/devsandbox/orphans/cleanup', async (_req, res) => {
    try {
      res.json(await devsandbox.cleanupOrphans(discoverSites(root)));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/devsandbox/stop-all', async (_req, res) => {
    try {
      res.json(await devsandbox.stopAll());
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/devsandbox/remove-stopped', async (_req, res) => {
    try {
      res.json(await devsandbox.removeStopped());
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/devsandbox/:slug/start', requireSite, async (req, res) => {
    try {
      res.json({ ok: true, ...(await devsandbox.start(root, req.params.slug)) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ ok: false, error: e.message });
    }
  });
  app.post('/api/devsandbox/:slug/stop', requireSite, async (req, res) => {
    try {
      res.json(await devsandbox.stop(req.params.slug));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ ok: false, error: e.message });
    }
  });
  app.post('/api/devsandbox/:slug/remove', requireSite, async (req, res) => {
    try {
      res.json(await devsandbox.remove(req.params.slug));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/devsandbox/:slug/dev', requireSite, async (req, res) => {
    try {
      res.json({ ok: true, ...(await devsandbox.devStatus(req.params.slug)) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ ok: false, error: e.message });
    }
  });
  app.post('/api/devsandbox/:slug/dev/start', requireSite, async (req, res) => {
    try {
      res.json({ ok: true, ...(await devsandbox.devStart(req.params.slug)) });
    } catch (e) {
      res.status(e.httpStatus || 400).json({ ok: false, error: e.message });
    }
  });
  app.post('/api/devsandbox/:slug/dev/stop', requireSite, async (req, res) => {
    try {
      res.json({ ok: true, ...(await devsandbox.devStop(req.params.slug)) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ ok: false, error: e.message });
    }
  });
  app.get('/api/devsandbox/:slug/dev/logs', requireSite, async (req, res) => {
    try {
      res.type('text/plain').send(await devsandbox.devLogs(req.params.slug, req.query.n));
    } catch (e) {
      res
        .status(e.httpStatus || 500)
        .type('text/plain')
        .send(e.message);
    }
  });

  // Site Facts — SEO/trust/branding/ads/legal recipe checks + Amazon ASIN
  // health + manual annotations, folded in from the standalone site-tracker
  // tool (which covered only 15 of ~59 sites and was stalled since 2026-05).
  app.get('/api/sitefacts', (_req, res) => {
    try {
      res.json(sitefacts.matrix(discoverSites(root)));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.get('/api/sitefacts/:slug', requireSite, (req, res) => {
    try {
      res.json(sitefacts.siteDetail(req.params.slug));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/sitefacts/:slug/manual/:key', requireSite, (req, res) => {
    try {
      res.json({
        ok: true,
        ...sitefacts.setManualFact(req.params.slug, req.params.key, (req.body || {}).value),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ ok: false, error: e.message });
    }
  });
  app.delete('/api/sitefacts/:slug/manual/:key', requireSite, (req, res) => {
    try {
      sitefacts.deleteManualFact(req.params.slug, req.params.key);
      res.json({ ok: true });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ ok: false, error: e.message });
    }
  });

  // Social registry — the tracked replacement for the old hand-edited
  // tools/social-setup/FLEET_SOCIAL_MAP.md. Read+write, so both the operator
  // (this UI) and the signup automation (`social-registry` CLI → this API)
  // work off one source of truth. `actor` is threaded through so the event log
  // says who changed a status.
  const actorOf = req => {
    const a = (req.body && req.body.actor) || req.query.actor || '';
    return String(a).slice(0, 60) || 'ui';
  };

  app.get('/api/social', (_req, res) => {
    try {
      res.json(social.snapshot(discoverSites(root)));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/social/summary', (_req, res) => {
    try {
      res.json(social.summary(discoverSites(root)));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  // The digest the AI reads on entry: what is broken, what was never attempted.
  app.get('/api/social/worklist', (_req, res) => {
    try {
      res.json(social.worklist(discoverSites(root)));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.get('/api/social/events', (req, res) => {
    try {
      res.json({
        events: social.readEvents({
          limit: Math.min(Number(req.query.limit) || 100, 1000),
          site: req.query.site || null,
          accountId: req.query.accountId || null,
        }),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.get('/api/social/accounts', (req, res) => {
    try {
      res.json({
        accounts: social.listAccounts({
          site: req.query.site || null,
          platform: req.query.platform || null,
          status: req.query.status || null,
          scope: req.query.scope || null,
          personaId: req.query.personaId || null,
          q: req.query.q || '',
          needsAttention: req.query.needsAttention === '1' || req.query.needsAttention === 'true',
          live: req.query.live === '1' || req.query.live === 'true',
        }),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/social/accounts', (req, res) => {
    try {
      res.json({ ok: true, account: social.upsertAccount(req.body, actorOf(req)) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ ok: false, error: e.message });
    }
  });
  app.get('/api/social/accounts/:id', (req, res) => {
    try {
      res.json(social.getAccount(req.params.id));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.put('/api/social/accounts/:id', (req, res) => {
    try {
      res.json({ ok: true, account: social.updateAccount(req.params.id, req.body, actorOf(req)) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ ok: false, error: e.message });
    }
  });
  app.post('/api/social/accounts/:id/status', (req, res) => {
    try {
      const b = req.body || {};
      res.json({
        ok: true,
        account: social.setStatus(req.params.id, b.status, b.note, actorOf(req)),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ ok: false, error: e.message });
    }
  });
  app.delete('/api/social/accounts/:id', (req, res) => {
    try {
      res.json(social.deleteAccount(req.params.id, actorOf(req)));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/social/personas', (req, res) => {
    try {
      res.json({ personas: social.listPersonas(req.query.site || null) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  app.post('/api/social/personas', (req, res) => {
    try {
      res.json({ ok: true, persona: social.createPersona(req.body, actorOf(req)) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ ok: false, error: e.message });
    }
  });
  app.put('/api/social/personas/:id', (req, res) => {
    try {
      res.json({ ok: true, persona: social.updatePersona(req.params.id, req.body, actorOf(req)) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ ok: false, error: e.message });
    }
  });
  app.delete('/api/social/personas/:id', (req, res) => {
    try {
      res.json(social.deletePersona(req.params.id, actorOf(req)));
    } catch (e) {
      res.status(e.httpStatus || 500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/social/platforms', (req, res) => {
    try {
      res.json({ ok: true, platform: social.addPlatform(req.body, actorOf(req)) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ ok: false, error: e.message });
    }
  });
  // Site bucket (active / positioning_tbd / adult_excluded / retired). Not
  // gated by requireSite: the registry also carries sites that predate or
  // outlive a sites/<slug> checkout.
  app.put('/api/social/sites/:slug/meta', (req, res) => {
    try {
      res.json({ ok: true, meta: social.setSiteMeta(req.params.slug, req.body, actorOf(req)) });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ ok: false, error: e.message });
    }
  });

  // Fleet Scheduler control plane (proxy to tools/fleet-scheduler).
  require('./scheduler').register(app);

  // JSON 404 for unmatched API routes (B5) — anything under /api/* that no route
  // handled returns { error } JSON, not the static middleware's HTML 404.
  app.use('/api', (req, res) =>
    res.status(404).json({ error: 'not found', path: req.originalUrl })
  );

  // Terminal error handler (B5): guarantees every failure — including a body
  // parse error from express.json (malformed JSON → SyntaxError) or a throw in a
  // handler that lacks its own try/catch — is emitted as { error } JSON for the
  // API surface, instead of Express's default HTML error page.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || err.httpStatus || 500;
    if (req.path.startsWith('/api/'))
      return res.status(status).json({ error: String(err.message || err) });
    return res.status(status).send(String(err.message || 'error'));
  });

  // Kick off the background CF deploy-health poller (re-discovers sites each
  // sweep so new sites are picked up without a restart). Skipped under test so
  // its outbound CF fetch doesn't race a test's stubbed global.fetch.
  //
  // Gated by a PID-file lock (see acquireBackgroundJobLock below), NOT just
  // NODE_ENV: a stray second `node server.js` on a different FD_PORT (a
  // forgotten local dev session) used to run these same pollers a second
  // time, independently, against the same docker containers — duplicate
  // Slack alerts every sweep with no cooldown coordination between the two
  // processes (2026-08-27 amputeenews.com incident: 3 leaked host processes
  // from Aug 25 dev sessions each fired their own errorscan alert burst).
  // Only the lock-holding process runs these; every other process still
  // serves the HTTP API/UI normally.
  const ownsBackgroundJobs = process.env.NODE_ENV !== 'test' && acquireBackgroundJobLock(root);
  if (ownsBackgroundJobs) {
    deployhealth.start(root, () => discoverSites(root));
    cloudflarebuilds.start(root);
    gatushealth.start();
    fleetdoctor.start(root);
    errorscan.start(root);
    // Site Facts background sweep (hourly — these change rarely). Same
    // skip-under-test convention as the deploy-health poller above.
    sitefacts.start(() => discoverSites(root));
    compliance.start(() => discoverSites(root));
  } else if (process.env.NODE_ENV !== 'test') {
    console.warn(
      `[fleet-dashboard] pid ${process.pid}: background pollers (errorscan, deploy-health, ` +
        'cloudflare-builds, gatus, site-facts, compliance) already owned by another live process — serving ' +
        'HTTP only. Remove tools/fleet-dashboard/data/server.lock only if that process is ' +
        'actually gone.'
    );
  }

  return app;
}

function findImprovementTask(root, run) {
  for (const column of tasks.COLUMNS) {
    try {
      return { ...tasks.get(root, run.site, column, run.task_file), column };
    } catch {
      /* try next column */
    }
  }
  return null;
}

async function syncImprovementTask(root, run, target) {
  const current = findImprovementTask(root, run);
  if (!current)
    throw Object.assign(new Error('linked improvement task is missing'), { httpStatus: 409 });
  if (current.column === target) return current;
  const moved = tasks.move(root, run.site, current.column, run.task_file, target);
  const paths = [
    `ops/tasks/${current.column}/${run.task_file}`,
    `ops/tasks/${target}/${moved.file}`,
  ];
  await git.commit(root, run.site, paths, `chore: mark improvement ${target}`);
  return { ...moved, previous: current.column };
}

async function cleanupImprovementResources(root, run) {
  let cleaned = true;
  let cleanupError = null;
  if (run.workspace_path) {
    try {
      await git.removeWorktree(root, run.site, run.run_id);
    } catch (error) {
      if (error.httpStatus !== 409) throw error;
      // Preserve a dirty worktree for recovery rather than deleting evidence,
      // but continue to remove the disposable sandbox below. A failed worker
      // must not leave an idle container consuming resources just because its
      // worktree needs operator review.
      cleaned = false;
      cleanupError = error.message;
    }
  }
  if (run.sandbox?.instance) {
    try {
      await devsandbox.remove(run.sandbox.instance);
    } catch (error) {
      cleaned = false;
      cleanupError = cleanupError || error.message;
    }
  }
  return { cleaned, error: cleanupError };
}

async function validatePreview(instance, url) {
  const out = { url: url || null, passed: false, checks: {} };
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(String(url || ''))) {
    out.error = 'sandbox preview URL is unavailable';
    return out;
  }
  for (let attempt = 1; attempt <= 5; attempt += 1)
    try {
      const response = await devsandbox.preview(instance, '/');
      if (!response.ok && response.error) throw new Error(response.error);
      const html = response.body;
      const images = [...html.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]);
      out.checks = {
        http: { status: response.ok ? 'pass' : 'fail', evidence: `HTTP ${response.status}` },
        title: { status: /<title>[^<]+<\/title>/i.test(html) ? 'pass' : 'fail' },
        description: {
          status:
            /<meta\s+[^>]*name=["']description["'][^>]*content=["'][^"']+/i.test(html) ||
            /<meta\s+[^>]*content=["'][^"']+[^>]*name=["']description["']/i.test(html)
              ? 'pass'
              : 'fail',
        },
        viewport: { status: /<meta\s+[^>]*name=["']viewport["']/i.test(html) ? 'pass' : 'fail' },
        image_alt: {
          // Keep pre-existing accessibility debt visible without blocking an
          // unrelated reversible change. Lighthouse/browser checks remain the
          // hard accessibility gate when their runtime is healthy.
          status: images.every(tag => /\balt=["'][^"']*["']/i.test(tag)) ? 'pass' : 'warn',
          evidence: `${images.length} image(s); missing alt text is a warning until the changed diff is image/template-related`,
        },
        analytics: {
          status: /G-[A-Z0-9]+|googletagmanager|dataLayer/i.test(html) ? 'pass' : 'warn',
        },
        accessibility_structure: {
          status:
            /<main\b/i.test(html) && /<h1\b/i.test(html) && /\blang=["'][^"']+/i.test(html)
              ? 'pass'
              : 'fail',
        },
        structured_data: { status: /application\/ld\+json/i.test(html) ? 'pass' : 'warn' },
      };
      const hrefs = [...html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)]
        .map(m => m[1])
        .filter(href => href.startsWith('/'))
        .slice(0, 20);
      const broken = [];
      for (const href of [...new Set(hrefs)]) {
        try {
          const link = await devsandbox.preview(instance, href);
          if (!link.ok) broken.push(`${href} (${link.status || 'error'})`);
        } catch {
          broken.push(`${href} (unreachable)`);
        }
      }
      out.checks.internal_links = {
        status: broken.length ? 'fail' : 'pass',
        evidence: broken.length ? broken.join(', ') : `${hrefs.length} checked`,
      };
      out.passed =
        response.ok &&
        [
          'http',
          'title',
          'description',
          'viewport',
          'accessibility_structure',
          'internal_links',
        ].every(k => out.checks[k].status === 'pass');
      return out;
    } catch (error) {
      out.error = error.name === 'TimeoutError' ? 'preview timeout' : error.message;
      if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  return out;
}

// One process per repo root may run the side-effecting background pollers
// (errorscan posts to Slack, deploy-health/gatus/compliance write shared
// state) — everything else is safe to run N-up (e.g. local dev on another
// FD_PORT). A PID-file lock enforces that regardless of port: readers check
// the held PID is actually alive (kill -0) before trusting the lock, so a
// crashed/killed owner never wedges the fleet without a poller.
function acquireBackgroundJobLock(root) {
  const file = path.join(root, 'tools', 'fleet-dashboard', 'data', 'server.lock');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const held = fs.existsSync(file) ? parseInt(fs.readFileSync(file, 'utf8').trim(), 10) : NaN;
    if (Number.isFinite(held) && held !== process.pid) {
      try {
        process.kill(held, 0); // throws ESRCH if that pid is not alive
        return false; // another live process already owns the pollers
      } catch {
        /* stale lock (owner exited without cleanup, e.g. kill -9) — reclaim it below */
      }
    }
    fs.writeFileSync(file, String(process.pid));
    process.on('exit', () => {
      try {
        if (parseInt(fs.readFileSync(file, 'utf8').trim(), 10) === process.pid) fs.unlinkSync(file);
      } catch {
        /* best effort — a leftover lock naturally self-heals via the liveness check above */
      }
    });
    return true;
  } catch {
    return true; // lock bookkeeping failed (e.g. read-only fs) — don't block startup over it
  }
}

// A pure-loopback bind is the only case where a missing token is safe. Note this
// does NOT account for docker network membership: in compose the panel binds
// 0.0.0.0 AND joins vpn_proxy, so any peer container can reach it regardless of
// the published-port address — the token is the only real gate there. Hence the
// guard keys off a non-loopback bind, which is exactly the compose case.
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function assertSafeToBind(host) {
  if (auth.AUTH_REQUIRED || LOOPBACK.has(host)) return;
  // FD_AUTH=0 is a deliberate, documented opt-out — same acknowledgement as
  // FD_ALLOW_INSECURE=1, just the one people actually reach for.
  if (auth.AUTH_DISABLED || process.env.FD_ALLOW_INSECURE === '1') return;
  console.error(
    `\n[fleet-dashboard] REFUSING TO START — bound to ${host}:${PORT} with no FD_TOKEN.\n` +
      '  This panel mounts the docker socket and drives the whole fleet; on a non-loopback\n' +
      '  bind (or the shared vpn_proxy network) an unauthenticated port = full fleet + host\n' +
      '  takeover for any peer that can reach it. Fix one of:\n' +
      '    • set FD_TOKEN=<secret>            (recommended — gate the API)\n' +
      '    • set FD_HOST=127.0.0.1            (loopback only, no network exposure)\n' +
      '    • set FD_AUTH=0                    (explicit opt-out — you accept the risk)\n'
  );
  process.exit(1);
}

if (require.main === module) {
  assertSafeToBind(HOST);
  if (!auth.TOKEN && !LOOPBACK.has(HOST)) {
    const why = auth.AUTH_DISABLED ? 'FD_AUTH=0' : 'FD_ALLOW_INSECURE=1';
    console.warn(
      `[fleet-dashboard] WARNING: bound to ${HOST}:${PORT} with the token gate OFF (${why}). API is UNAUTHENTICATED — any container on vpn_proxy can drive the fleet.`
    );
  }
  createApp().listen(PORT, HOST, () => console.log(`fleet-dashboard on http://${HOST}:${PORT}`));
}

module.exports = {
  createApp,
  workerCompletionPath,
  interruptedWorkerRecoveryPath,
  shouldRetryQueueFailure,
  shouldAutoRevalidateInfrastructureReview,
  infrastructureReviewProjectionPatch,
  shouldRecoverStaleDeliveryClaim,
  shouldValidateBeforeDelivery,
  applyQualityPolicy,
};
