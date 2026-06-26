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
  app.get('/api/roles', (_req, res) => {
    try { res.json(roles.matrix(root, discoverSites(root))); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/roles/:slug/:role/log', requireSite, (req, res) => {
    try { res.json(roles.roleLog(root, req.params.slug, req.params.role, req.query.tail)); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  // Pause / resume a role (toggles ops/.<role>-disabled).
  app.post('/api/roles/:slug/:role/:action', requireSite, (req, res) => {
    const act = req.params.action;
    if (act !== 'pause' && act !== 'resume') return res.status(400).json({ error: 'unknown action' });
    try { res.json(roles.setEnabled(root, req.params.slug, req.params.role, act === 'resume')); }
    catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
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

  return app;
}

if (require.main === module) {
  createApp().listen(PORT, HOST, () => console.log(`fleet-dashboard on http://${HOST}:${PORT}`));
}

module.exports = { createApp };
