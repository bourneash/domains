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
const gatushealth = require('./gatushealth');
const datahub = require('./datahub');
const analytics = require('./analytics');
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

const DEFAULT_ROOT = process.env.FD_DOMAINS_ROOT || path.resolve(__dirname, '..', '..', '..'); // tools/fleet-dashboard/server → repo root
const PORT = parseInt(process.env.FD_PORT || '4754', 10);
const HOST = process.env.FD_HOST || '127.0.0.1';

function createApp({ root = DEFAULT_ROOT } = {}) {
  const app = express();
  app.disable('x-powered-by');

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

  app.use(express.static(path.join(__dirname, 'public')));

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
      res.json(compliance.matrix(discoverSites(root)));
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
  app.get('/api/gatus', (_req, res) => res.json(gatushealth.all()));

  // Parked inventory (F51) — registry entries with status: scaffold. Read
  // straight from registry/fleet.yaml, not from site discovery: a scaffold
  // runs nothing, so it is invisible to every other roster in this panel.
  app.get('/api/scaffolds', (req, res) =>
    res.json(scaffolds.all(root, { fresh: req.query.fresh === '1' })));

  // Domain renewals (F51) — served from tools/registrar's cache, never a live
  // Cloudflare call. auto_renew matters more than the date: an expiry 40 days
  // out is routine if it renews itself and an emergency if it does not.
  app.get('/api/registrar', (req, res) =>
    res.json(registrar.all(root, { fresh: req.query.fresh === '1' })));

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

  // Fleet-wide bounce: restart every cron container. Defined before :id/:action.
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
      res.json(
        await git.commit(root, req.params.slug, (req.body || {}).paths, (req.body || {}).message)
      );
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
      res.json(await git.push(root, req.params.slug));
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
      res.json({
        ok: true,
        file: tasks.create(root, req.params.slug, req.params.column, req.body || {}),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.put('/api/tasks/:slug/:column/:file', requireSite, (req, res) => {
    try {
      res.json({
        ok: true,
        file: tasks.update(
          root,
          req.params.slug,
          req.params.column,
          req.params.file,
          req.body || {}
        ),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/tasks/:slug/:column/:file/move', requireSite, (req, res) => {
    try {
      res.json({
        ok: true,
        ...tasks.move(
          root,
          req.params.slug,
          req.params.column,
          req.params.file,
          (req.body || {}).to
        ),
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.delete('/api/tasks/:slug/:column/:file', requireSite, (req, res) => {
    try {
      tasks.remove(root, req.params.slug, req.params.column, req.params.file);
      res.json({ ok: true });
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
        'gatus, site-facts, compliance) already owned by another live process — serving ' +
        'HTTP only. Remove tools/fleet-dashboard/data/server.lock only if that process is ' +
        'actually gone.'
    );
  }

  return app;
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
  if (auth.TOKEN || LOOPBACK.has(host)) return;
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

module.exports = { createApp };
