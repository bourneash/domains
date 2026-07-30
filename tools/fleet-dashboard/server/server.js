'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { discoverSites, isKnownSite } = require('./sites');
const audit = require('./audit');
const git = require('./git');
const tasks = require('./tasks');
const run = require('./run');
const containers = require('./containers');
const roles = require('./roles');
const taskbudget = require('./taskbudget');
const aiusage = require('./aiusage');
const cron = require('./cron');
const deployhealth = require('./deployhealth');
const datahub = require('./datahub');
const analytics = require('./analytics');
const datahubImages = require('./datahub-images');
const auth = require('./auth');
const health = require('./health');
const actionlog = require('./actionlog');
const devsandbox = require('./devsandbox');
const sitefacts = require('./sitefacts');

const DEFAULT_ROOT = process.env.FD_DOMAINS_ROOT
  || path.resolve(__dirname, '..', '..', '..');     // tools/fleet-dashboard/server → repo root
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
        console.log(`${new Date().toISOString()} ${write ? 'WRITE ' : ''}${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
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
    try { res.json({ actions: actionlog.tail(req.query.limit) }); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Liveness + dependency preflight (F7).
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/api/health/deps', async (_req, res) => {
    try { res.json(await health.deps(root)); }
    catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
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
      try { res.write(`event: tick\ndata: ${JSON.stringify({ t: Date.now(), version: assetVersion() })}\n\n`); }
      catch { /* client gone; cleanup runs on close */ }
    }, 10000);
    if (ping.unref) ping.unref();
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
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
    for (const f of ['index.html', 'app.js', 'style.css']) {
      try { const st = fs.statSync(path.join(__dirname, 'public', f)); h.update(`${f}:${st.mtimeMs}:${st.size};`); }
      catch { /* ignore a missing asset */ }
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
    try { res.json(datahub.matrix()); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
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
  app.get('/api/datahub-images/health', async (_req, res) => res.json(await datahubImages.health()));
  app.get('/api/datahub-images/stats', async (_req, res) => res.json(await datahubImages.stats()));
  app.get('/api/datahub-images/sources', async (_req, res) => res.json(await datahubImages.sources()));
  app.get('/api/datahub-images/egress', async (req, res) => {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 200, 300));
    res.json(await datahubImages.egress(limit));
  });
  app.get('/api/datahub-images/pulls', async (req, res) => {
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 200, 300));
    res.json(await datahubImages.pulls(limit));
  });
  app.get('/api/datahub-images/images', async (req, res) => {
    res.json(await datahubImages.images({
      topic: req.query.topic, site: req.query.site,
      status: req.query.status, limit: req.query.limit,
    }));
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
    const contentType = typeof r.contentType === 'string' && r.contentType.startsWith('image/') ? r.contentType : 'application/octet-stream';
    res.setHeader('content-type', contentType);
    res.send(r.buffer);
  });

  app.get('/api/sites', (_req, res) => res.json(discoverSites(root)));

  // The fleet engineer audit (delegates to engineer-status.py --json).
  app.get('/api/fleet', async (_req, res) => {
    try { res.json(await audit.fleet(root)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/fleet/history', async (req, res) => {
    try { res.json(await audit.history(root, req.query.days)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Trigger one engineer to run now (same command cron fires, detached).
  app.post('/api/fleet/:slug/run', requireSite, async (req, res) => {
    try { res.json({ ok: true, container: await run.runEngineer(root, req.params.slug) }); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  // Agent list for the nav dropdown (roles on ≥2 sites, engineer first).
  app.get('/api/agents', (_req, res) => {
    try { res.json(roles.agents(root, discoverSites(root))); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Roles matrix: site × role status from crontab + disabled flags + logs.
  app.get('/api/roles', async (_req, res) => {
    try { res.json(await roles.matrix(root, discoverSites(root))); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Writer-role turn-budget audit (delegates to tools/task-budget/turn_budget.py
  // audit --json): static vs. computed --max-turns per site/role, plus
  // dead-role backlog task drift.
  app.get('/api/task-budget', async (_req, res) => {
    try { res.json(await taskbudget.fleet(root)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Real AI token usage/cost, rolled up from the per-site ledgers written by
  // tools/scripts/claude-tracked.sh (tools/ai-usage/aggregate.py is the source
  // of truth). Sites not yet migrated to the tracked wrapper report zero
  // calls, listed under summary.sites_uninstrumented, not as an error.
  app.get('/api/ai-usage', async (req, res) => {
    try { res.json(await aiusage.fleet(root, { from: req.query.from, to: req.query.to })); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Background CF deploy-health cache (powers the deployer cell's "is it live?"
  // half). Exposed for inspection/debugging.
  app.get('/api/deploy-health', (_req, res) => res.json(deployhealth.all()));

  app.get('/api/roles/:slug/:role/log', requireSite, (req, res) => {
    try { res.json(roles.roleLog(root, req.params.slug, req.params.role, req.query.tail)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  // Role actions: pause / resume (toggle ops/.<role>-disabled) or run (fire now).
  app.post('/api/roles/:slug/:role/:action', requireSite, async (req, res) => {
    const act = req.params.action;
    try {
      if (act === 'run') return res.json({ ok: true, container: await run.runRole(root, req.params.slug, req.params.role) });
      if (act === 'pause' || act === 'resume') return res.json(roles.setEnabled(root, req.params.slug, req.params.role, act === 'resume'));
      return res.status(400).json({ error: 'unknown action' });
    } catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  // Containers: list domains-repo containers, lifecycle actions, logs, bounce.
  app.get('/api/containers', async (_req, res) => {
    try { res.json(await containers.list(root)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  // Fleet-wide bounce: restart every cron container. Defined before :id/:action.
  app.post('/api/containers/restart-crons', async (_req, res) => {
    try { res.json(await containers.restartCrons(root)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.post('/api/containers/:id/:action', async (req, res) => {
    try { res.json(await containers.action(root, req.params.id, req.params.action)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.get('/api/containers/:id/logs', async (req, res) => {
    try { res.json(await containers.logs(root, req.params.id, req.query.tail)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.post('/api/sites/:slug/bounce', requireSite, async (req, res) => {
    try { res.json(await containers.bounce(root, req.params.slug)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  // Cron control plane (folded in from the retired cron-manager tool). Operates
  // at the crontab-LINE level: list every cron entry, edit a schedule, comment/
  // remove a line, diff/revert vs the baked-in crontab, rebuild + verify. Routes
  // are thin wrappers over server/cron.js. NOTE: cron "systems" include tools/*,
  // not just sites/*, so these validate via cron.findSystem (not requireSite).
  app.get('/api/cron/describe', (req, res) => res.json(cron.validateAndDescribe(req.query.expr)));

  app.get('/api/cron/systems', async (_req, res) => {
    try { res.json(await cron.systems(root)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.get('/api/cron/systems/:slug/logs', async (req, res) => {
    try {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.send(await cron.logs(root, req.params.slug, req.query.source, req.query.tail));
    } catch (e) { res.status(e.httpStatus || 500).send(e.message); }
  });

  app.get('/api/cron/systems/:slug/diff', async (req, res) => {
    try { res.json(await cron.diff(root, req.params.slug)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.post('/api/cron/systems/:slug/crontab', async (req, res) => {
    try { res.json(await cron.crontabMutate(root, req.params.slug, req.body || {})); }
    catch (e) { res.status(e.httpStatus || 400).json({ error: e.message }); }
  });

  app.post('/api/cron/systems/:slug/revert', async (req, res) => {
    try { res.json(await cron.revert(root, req.params.slug)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.post('/api/cron/systems/:slug/rebuild', async (req, res) => {
    try { await cron.rebuild(root, req.params.slug, res); }
    catch (e) {
      if (res.headersSent) { try { res.end(); } catch { /* already closed */ } }
      else res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // Manual run streams — define BEFORE the generic :action flag route.
  app.post('/api/cron/systems/:slug/jobs/:role/run', async (req, res) => {
    try { await cron.runJob(root, req.params.slug, req.params.role, res); }
    catch (e) {
      if (res.headersSent) { try { res.end(); } catch { /* already closed */ } }
      else res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  app.post('/api/cron/systems/:slug/jobs/:role/:action', (req, res) => {
    try { res.json(cron.jobFlag(root, req.params.slug, req.params.role, req.params.action)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  // Git: fleet-wide one-line summaries, and a per-site detailed file list.
  app.get('/api/git', async (_req, res) => {
    try { res.json(await git.summaries(root, discoverSites(root))); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Fleet-wide bulk push (F6): push every site that's ahead of origin. Defined
  // before :slug so "push-all" isn't captured as a slug.
  app.post('/api/git/push-all', async (_req, res) => {
    try { res.json(await git.pushAll(root, discoverSites(root))); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  // Fleet-wide bulk pull (F25): pull every site that's behind origin. Same
  // shape as push-all, defined before :slug for the same reason.
  app.post('/api/git/pull-all', async (_req, res) => {
    try { res.json(await git.pullAll(root, discoverSites(root))); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.get('/api/git/:slug', requireSite, async (req, res) => {
    try { res.json(await git.status(root, req.params.slug)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Per-file diff preview (F5): working tree vs HEAD (or whole file for untracked).
  app.get('/api/git/:slug/diff', requireSite, async (req, res) => {
    try { res.json(await git.fileDiff(root, req.params.slug, req.query.path)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  // Safe write ops: commit selected paths, ignore (gitignore+commit), push.
  app.post('/api/git/:slug/commit', requireSite, async (req, res) => {
    try { res.json(await git.commit(root, req.params.slug, (req.body || {}).paths, (req.body || {}).message)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.post('/api/git/:slug/ignore', requireSite, async (req, res) => {
    try { res.json(await git.ignore(root, req.params.slug, (req.body || {}).path)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.post('/api/git/:slug/push', requireSite, async (req, res) => {
    try { res.json(await git.push(root, req.params.slug)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.get('/api/git/:slug/branches', requireSite, async (req, res) => {
    try { res.json(await git.branches(root, req.params.slug)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.delete('/api/git/:slug/branches/:branch(*)', requireSite, async (req, res) => {
    try { res.json(await git.deleteBranch(root, req.params.slug, req.params.branch)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.get('/api/git/:slug/stashes', requireSite, async (req, res) => {
    try { res.json(await git.stashes(root, req.params.slug)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.get('/api/git/:slug/stashes/:index/diff', requireSite, async (req, res) => {
    try { res.json(await git.stashDiff(root, req.params.slug, req.params.index)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.delete('/api/git/:slug/stashes/:index', requireSite, async (req, res) => {
    try { res.json(await git.dropStash(root, req.params.slug, req.params.index)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.post('/api/git/:slug/pull', requireSite, async (req, res) => {
    try { res.json(await git.pull(root, req.params.slug)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  // Tasks CRUD ------------------------------------------------------------
  // Cross-fleet aggregate (every site's tasks, flat) — the integrated
  // successor to site-tracker's /tasks page. Client does facet/filter/group.
  app.get('/api/tasks', (_req, res) => {
    try { res.json(tasks.listAll(root, discoverSites(root))); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/tasks/:slug', requireSite, (req, res) => {
    try { res.json(tasks.list(root, req.params.slug)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.get('/api/tasks/:slug/:column/:file', requireSite, (req, res) => {
    try { res.json(tasks.get(root, req.params.slug, req.params.column, req.params.file)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.post('/api/tasks/:slug/:column', requireSite, (req, res) => {
    try { res.json({ ok: true, file: tasks.create(root, req.params.slug, req.params.column, req.body || {}) }); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.put('/api/tasks/:slug/:column/:file', requireSite, (req, res) => {
    try { res.json({ ok: true, file: tasks.update(root, req.params.slug, req.params.column, req.params.file, req.body || {}) }); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.post('/api/tasks/:slug/:column/:file/move', requireSite, (req, res) => {
    try { res.json({ ok: true, ...tasks.move(root, req.params.slug, req.params.column, req.params.file, (req.body || {}).to) }); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.delete('/api/tasks/:slug/:column/:file', requireSite, (req, res) => {
    try { tasks.remove(root, req.params.slug, req.params.column, req.params.file); res.json({ ok: true }); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  // Dev Sandboxes — per-site sandboxed Claude/ttyd containers, folded in from
  // the standalone domain-developer tool. Site-name validation is entirely
  // delegated to requireSite/discoverSites (no separate allowlist needed).
  app.get('/api/devsandbox/sites', async (_req, res) => {
    try { res.json(await devsandbox.list(root, discoverSites(root))); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.get('/api/devsandbox/stats', async (_req, res) => {
    try { res.json({ ok: true, containers: await devsandbox.stats() }); }
    catch (e) { res.status(e.httpStatus || 500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/devsandbox/orphans', async (_req, res) => {
    try { res.json(await devsandbox.findOrphans(discoverSites(root))); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });
  app.post('/api/devsandbox/orphans/cleanup', async (_req, res) => {
    try { res.json(await devsandbox.cleanupOrphans(discoverSites(root))); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.post('/api/devsandbox/stop-all', async (_req, res) => {
    try { res.json(await devsandbox.stopAll()); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });
  app.post('/api/devsandbox/remove-stopped', async (_req, res) => {
    try { res.json(await devsandbox.removeStopped()); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  app.post('/api/devsandbox/:slug/start', requireSite, async (req, res) => {
    try { res.json({ ok: true, ...await devsandbox.start(root, req.params.slug) }); }
    catch (e) { res.status(e.httpStatus || 500).json({ ok: false, error: e.message }); }
  });
  app.post('/api/devsandbox/:slug/stop', requireSite, async (req, res) => {
    try { res.json(await devsandbox.stop(req.params.slug)); }
    catch (e) { res.status(e.httpStatus || 500).json({ ok: false, error: e.message }); }
  });
  app.post('/api/devsandbox/:slug/remove', requireSite, async (req, res) => {
    try { res.json(await devsandbox.remove(req.params.slug)); }
    catch (e) { res.status(e.httpStatus || 500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/devsandbox/:slug/dev', requireSite, async (req, res) => {
    try { res.json({ ok: true, ...await devsandbox.devStatus(req.params.slug) }); }
    catch (e) { res.status(e.httpStatus || 500).json({ ok: false, error: e.message }); }
  });
  app.post('/api/devsandbox/:slug/dev/start', requireSite, async (req, res) => {
    try { res.json({ ok: true, ...await devsandbox.devStart(req.params.slug) }); }
    catch (e) { res.status(e.httpStatus || 400).json({ ok: false, error: e.message }); }
  });
  app.post('/api/devsandbox/:slug/dev/stop', requireSite, async (req, res) => {
    try { res.json({ ok: true, ...await devsandbox.devStop(req.params.slug) }); }
    catch (e) { res.status(e.httpStatus || 500).json({ ok: false, error: e.message }); }
  });
  app.get('/api/devsandbox/:slug/dev/logs', requireSite, async (req, res) => {
    try { res.type('text/plain').send(await devsandbox.devLogs(req.params.slug, req.query.n)); }
    catch (e) { res.status(e.httpStatus || 500).type('text/plain').send(e.message); }
  });

  // Site Facts — SEO/trust/branding/ads/legal recipe checks + Amazon ASIN
  // health + manual annotations, folded in from the standalone site-tracker
  // tool (which covered only 15 of ~59 sites and was stalled since 2026-05).
  app.get('/api/sitefacts', (_req, res) => {
    try { res.json(sitefacts.matrix(discoverSites(root))); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/sitefacts/:slug', requireSite, (req, res) => {
    try { res.json(sitefacts.siteDetail(req.params.slug)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });
  app.post('/api/sitefacts/:slug/manual/:key', requireSite, (req, res) => {
    try { res.json({ ok: true, ...sitefacts.setManualFact(req.params.slug, req.params.key, (req.body || {}).value) }); }
    catch (e) { res.status(e.httpStatus || 500).json({ ok: false, error: e.message }); }
  });
  app.delete('/api/sitefacts/:slug/manual/:key', requireSite, (req, res) => {
    try { sitefacts.deleteManualFact(req.params.slug, req.params.key); res.json({ ok: true }); }
    catch (e) { res.status(e.httpStatus || 500).json({ ok: false, error: e.message }); }
  });

  // JSON 404 for unmatched API routes (B5) — anything under /api/* that no route
  // handled returns { error } JSON, not the static middleware's HTML 404.
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found', path: req.originalUrl }));

  // Terminal error handler (B5): guarantees every failure — including a body
  // parse error from express.json (malformed JSON → SyntaxError) or a throw in a
  // handler that lacks its own try/catch — is emitted as { error } JSON for the
  // API surface, instead of Express's default HTML error page.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || err.httpStatus || 500;
    if (req.path.startsWith('/api/')) return res.status(status).json({ error: String(err.message || err) });
    return res.status(status).send(String(err.message || 'error'));
  });

  // Kick off the background CF deploy-health poller (re-discovers sites each
  // sweep so new sites are picked up without a restart). Skipped under test so
  // its outbound CF fetch doesn't race a test's stubbed global.fetch.
  if (process.env.NODE_ENV !== 'test') deployhealth.start(root, () => discoverSites(root));
  // Site Facts background sweep (hourly — these change rarely). Same
  // skip-under-test convention as the deploy-health poller above.
  if (process.env.NODE_ENV !== 'test') sitefacts.start(() => discoverSites(root));

  return app;
}

// A pure-loopback bind is the only case where a missing token is safe. Note this
// does NOT account for docker network membership: in compose the panel binds
// 0.0.0.0 AND joins vpn_proxy, so any peer container can reach it regardless of
// the published-port address — the token is the only real gate there. Hence the
// guard keys off a non-loopback bind, which is exactly the compose case.
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function assertSafeToBind(host) {
  if (auth.TOKEN || LOOPBACK.has(host) || process.env.FD_ALLOW_INSECURE === '1') return;
  console.error(
    `\n[fleet-dashboard] REFUSING TO START — bound to ${host}:${PORT} with no FD_TOKEN.\n`
    + '  This panel mounts the docker socket and drives the whole fleet; on a non-loopback\n'
    + '  bind (or the shared vpn_proxy network) an unauthenticated port = full fleet + host\n'
    + '  takeover for any peer that can reach it. Fix one of:\n'
    + '    • set FD_TOKEN=<secret>            (recommended — gate the API)\n'
    + '    • set FD_HOST=127.0.0.1            (loopback only, no network exposure)\n'
    + '    • set FD_ALLOW_INSECURE=1          (explicit opt-out — you accept the risk)\n');
  process.exit(1);
}

if (require.main === module) {
  assertSafeToBind(HOST);
  if (!auth.TOKEN && process.env.FD_ALLOW_INSECURE === '1' && !LOOPBACK.has(HOST)) {
    console.warn(`[fleet-dashboard] WARNING: bound to ${HOST}:${PORT} with no FD_TOKEN (FD_ALLOW_INSECURE=1). API is UNAUTHENTICATED.`);
  }
  createApp().listen(PORT, HOST, () => console.log(`fleet-dashboard on http://${HOST}:${PORT}`));
}

module.exports = { createApp };
