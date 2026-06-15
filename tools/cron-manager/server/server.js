'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const cronstrue = require('cronstrue');

const { discoverSystems } = require('./discovery');
const { inspectContainer, confirmHealthy, containerLogs, containerCreatedAt, rebuildCron } = require('./docker');
const { readLastRuns, resolveLogPath, tailFile } = require('./runinfo');
const crontab = require('./crontab');

const DEFAULT_ROOT = process.env.CM_DOMAINS_ROOT
  || path.resolve(__dirname, '..', '..', '..');     // tools/cron-manager/server → repo root
const PORT = parseInt(process.env.CM_PORT || '4753', 10);
const HOST = process.env.CM_HOST || '127.0.0.1';

function describe(expr) {
  try { return cronstrue.toString(expr, { use24HourTimeFormat: false }); }
  catch { return expr; }
}

// Validate + translate a cron expression for the inline editor's live feedback.
function validateAndDescribe(expr) {
  const e = String(expr || '').trim();
  if (!crontab.isValidCron(e)) {
    return { valid: false, human: '', error: 'Need 5 fields: minute hour day-of-month month day-of-week' };
  }
  try { return { valid: true, human: cronstrue.toString(e, { use24HourTimeFormat: false }), error: null }; }
  catch (err) { return { valid: false, human: '', error: err.message || 'invalid expression' }; }
}

function findSystem(root, slug) {
  return discoverSystems(root).find((s) => s.slug === slug) || null;
}

function fileMtime(p) {
  try { return fs.statSync(p).mtime; } catch { return null; }
}

function createApp({ root = DEFAULT_ROOT, statusRunner } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // Last streamed rebuild output, per slug — so the log viewer can show it
  // on demand instead of force-opening a modal during the rebuild.
  const lastRebuildLog = new Map();

  // Live cron validation + plain-language translation for the inline editor.
  app.get('/api/cron/describe', (req, res) => {
    res.json(validateAndDescribe(req.query.expr));
  });

  // List all systems, with honest container health, per-job last-run facts,
  // needs-rebuild (dirty) detection, and available log sources.
  app.get('/api/systems', async (_req, res) => {
    const systems = discoverSystems(root);
    for (const s of systems) {
      const i = await inspectContainer(s.container, statusRunner);
      s.status = i.state;           // real docker state, badge driver
      s.statusText = i.raw;         // "Up 3 hours" / "Exited (127) 2 min ago"
      s.exitCode = i.exitCode;
      s.failed = i.failed;          // true → red badge, surfaces failed starts

      // Dirty detection: crontab edited after the container was last built/created.
      s.needsRebuild = false;
      if (i.state !== 'never-built') {
        const created = await containerCreatedAt(s.container, statusRunner);
        const mtime = fileMtime(s.crontabPath);
        if (created && mtime && mtime > created) s.needsRebuild = true;
      }

      const lr = readLastRuns(s.opsDir);
      const sources = [{ id: 'container', label: 'Container' }];
      if (lastRebuildLog.has(s.slug)) sources.push({ id: 'rebuild', label: 'Last rebuild' });
      s.entries = s.entries.map((e) => {
        const rec = e.role ? lr[e.role] : null;
        const hasLog = Boolean(rec && resolveLogPath(root, s.slug, rec.log));
        if (hasLog && !sources.some((x) => x.id === `role:${e.role}`)) {
          sources.push({ id: `role:${e.role}`, label: e.role });
        }
        return {
          ...e,
          human: describe(e.schedule),
          lastRun: rec?.at || null,
          lastExit: rec && typeof rec.exit === 'number' ? rec.exit : null,
          hasLog,
        };
      });
      s.logSources = sources;
    }
    res.json(systems);
  });

  // Tail logs from a chosen source: container | rebuild | role:<role>.
  app.get('/api/systems/:slug/logs', async (req, res) => {
    const sys = findSystem(root, req.params.slug);
    if (!sys) return res.status(404).json({ error: 'unknown system' });
    const tail = Math.min(parseInt(req.query.tail, 10) || 400, 2000);
    const source = String(req.query.source || 'container');
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    if (source === 'container') {
      return res.send(await containerLogs(sys.container, statusRunner, tail));
    }
    if (source === 'rebuild') {
      return res.send(lastRebuildLog.get(sys.slug) || '(no rebuild has run in this session yet)');
    }
    if (source.startsWith('role:')) {
      const role = source.slice(5);
      if (!/^[A-Za-z0-9._-]+$/.test(role)) return res.status(400).send('bad role');
      const rec = readLastRuns(sys.opsDir)[role];
      const p = rec && resolveLogPath(root, sys.slug, rec.log);
      return res.send(p ? tailFile(p, tail) : '(no log file recorded for this role)');
    }
    return res.status(400).send('unknown log source');
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

  // Rebuild + restart this system's cron container; stream output, capture it,
  // and emit a machine-readable final verdict line the client turns into a toast.
  app.post('/api/systems/:slug/rebuild', async (req, res) => {
    const sys = findSystem(root, req.params.slug);
    if (!sys) return res.status(404).json({ error: 'unknown system' });
    const cwd = sys.kind === 'site' ? path.join(sys.opsDir, '..') : path.dirname(sys.crontabPath);
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    let buf = '';
    const emit = (d) => { buf += d; res.write(d); };
    const result = await rebuildCron(cwd, emit);
    emit(`\n[exit ${result.code}] compose ${result.ok ? 'OK' : 'FAILED'}\n`);
    emit(`Verifying ${sys.container} actually started…\n`);
    const health = await confirmHealthy(sys.container, statusRunner);
    if (health.ok) {
      emit(`✅ ${sys.container} is running (${health.raw}).\n`);
    } else {
      emit(`❌ ${sys.container} did NOT come up — state="${health.state}"`
        + `${health.exitCode != null ? ` exit=${health.exitCode}` : ''} (${health.raw || 'no status'}).\n`);
    }
    // Machine-readable verdict for the client toast (last line).
    emit(`@@VERDICT ${health.ok ? 'ok' : 'fail'} ${sys.container}\n`);
    lastRebuildLog.set(sys.slug, buf);
    res.end();
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(PORT, HOST, () => console.log(`cron-manager on http://${HOST}:${PORT}`));
}

module.exports = { createApp, describe, validateAndDescribe };
