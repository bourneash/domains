'use strict';

const express = require('express');
const path = require('node:path');

const { discoverSites, isKnownSite } = require('./sites');
const audit = require('./audit');
const git = require('./git');
const tasks = require('./tasks');
const run = require('./run');

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
