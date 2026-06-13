'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const cronstrue = require('cronstrue');

const { discoverSystems } = require('./discovery');
const { containerStatus, rebuildCron } = require('./docker');
const crontab = require('./crontab');

const DEFAULT_ROOT = process.env.CM_DOMAINS_ROOT
  || path.resolve(__dirname, '..', '..', '..');     // tools/cron-manager/server → repo root
const PORT = parseInt(process.env.CM_PORT || '4753', 10);
const HOST = process.env.CM_HOST || '127.0.0.1';

function describe(expr) {
  try { return cronstrue.toString(expr, { use24HourTimeFormat: false }); }
  catch { return expr; }
}

function findSystem(root, slug) {
  return discoverSystems(root).find((s) => s.slug === slug) || null;
}

function createApp({ root = DEFAULT_ROOT, statusRunner } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // List all systems, with container status + human schedules.
  app.get('/api/systems', async (_req, res) => {
    const systems = discoverSystems(root);
    for (const s of systems) {
      s.status = await containerStatus(s.container, statusRunner);
      s.entries = s.entries.map((e) => ({ ...e, human: describe(e.schedule) }));
    }
    res.json(systems);
  });

  // Instant enable/disable for run-worker.sh roles (flag file).
  app.post('/api/systems/:slug/jobs/:role/:action', (req, res) => {
    const { slug, role, action } = req.params;
    const sys = findSystem(root, slug);
    if (!sys) return res.status(404).json({ error: 'unknown system' });
    if (!sys.opsDir) return res.status(400).json({ error: 'tool jobs have no role flags; use crontab comment' });
    if (!/^[A-Za-z0-9._-]+$/.test(role)) return res.status(400).json({ error: 'bad role' });
    const flag = path.join(sys.opsDir, `.${role}-disabled`);
    try {
      if (action === 'disable') fs.writeFileSync(flag, '');
      else if (action === 'enable') { if (fs.existsSync(flag)) fs.unlinkSync(flag); }
      else return res.status(400).json({ error: 'bad action' });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // File-mutating actions: comment/uncomment/edit/remove. Marks pending rebuild.
  app.post('/api/systems/:slug/crontab', (req, res) => {
    const sys = findSystem(root, req.params.slug);
    if (!sys) return res.status(404).json({ error: 'unknown system' });
    const { action, lineIndex, newSchedule, expectedRawLine } = req.body || {};
    let text;
    try { text = fs.readFileSync(sys.crontabPath, 'utf8'); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    let out;
    try {
      if (action === 'comment') out = crontab.commentLine(text, lineIndex, expectedRawLine);
      else if (action === 'uncomment') out = crontab.uncommentLine(text, lineIndex, expectedRawLine);
      else if (action === 'edit') out = crontab.editSchedule(text, lineIndex, newSchedule, expectedRawLine);
      else if (action === 'remove') out = crontab.removeLine(text, lineIndex, expectedRawLine);
      else return res.status(400).json({ error: 'bad action' });
    } catch (e) {
      const code = e.code === 'STALE' ? 409 : 400;
      return res.status(code).json({ error: e.message });
    }
    try { fs.writeFileSync(sys.crontabPath, out); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    return res.json({ ok: true, pendingRebuild: true });
  });

  // Rebuild + restart this system's cron container; stream output.
  app.post('/api/systems/:slug/rebuild', async (req, res) => {
    const sys = findSystem(root, req.params.slug);
    if (!sys) return res.status(404).json({ error: 'unknown system' });
    const cwd = sys.kind === 'site' ? path.join(sys.opsDir, '..') : path.dirname(sys.crontabPath);
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    const result = await rebuildCron(cwd, (d) => res.write(d));
    res.write(`\n[exit ${result.code}] ${result.ok ? 'OK' : 'FAILED'}\n`);
    res.end();
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(PORT, HOST, () => console.log(`cron-manager on http://${HOST}:${PORT}`));
}

module.exports = { createApp, describe };
