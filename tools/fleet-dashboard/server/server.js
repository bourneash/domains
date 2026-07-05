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
const cron = require('./cron');
const deployhealth = require('./deployhealth');
const datahub = require('./datahub');
const datahubImages = require('./datahub-images');

const DEFAULT_ROOT = process.env.FD_DOMAINS_ROOT
  || path.resolve(__dirname, '..', '..', '..');     // tools/fleet-dashboard/server → repo root
const PORT = parseInt(process.env.FD_PORT || '4754', 10);
const HOST = process.env.FD_HOST || '127.0.0.1';

function createApp({ root = DEFAULT_ROOT } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

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
    try { res.json({ ok: true, container: await run.runEngineer(req.params.slug) }); }
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

  app.get('/api/git/:slug', requireSite, async (req, res) => {
    try { res.json(await git.status(root, req.params.slug)); }
    catch (e) { res.status(500).json({ error: e.message }); }
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

  // Kick off the background CF deploy-health poller (re-discovers sites each
  // sweep so new sites are picked up without a restart).
  deployhealth.start(root, () => discoverSites(root));

  return app;
}

if (require.main === module) {
  createApp().listen(PORT, HOST, () => console.log(`fleet-dashboard on http://${HOST}:${PORT}`));
}

module.exports = { createApp };
