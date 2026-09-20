"""Loopback/internal JSON API over the engine. stdlib ThreadingHTTPServer.

Hardening:
  * bearer token required for everything except /healthz; constant-time compare;
    server refuses to start without a token of >= 24 chars
  * request bodies capped (64 KiB), sockets time out, concurrent handlers capped
  * all engine/DB access is marshalled onto the single loop thread
  * inputs validated against strict schemas; commands set via the API must match a
    no-shell-metacharacter allowlist (the importer, a local trusted CLI, is the only
    path for arbitrary legacy crontab one-liners)
  * responses never include job env or the token
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import hmac
import json
import logging
import os
import re
import sqlite3
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import cronexpr
from .engine import NAME_RE, SITE_RE, Engine, SchedError

log = logging.getLogger("fleetsched.api")

MAX_BODY = 64 * 1024
MAX_CONCURRENT = 16
# bash <script under ops/scripts | .monorepo-tools> [simple args]   — no shell metacharacters.
SAFE_CMD_RE = re.compile(
    r"^bash (?:ops/scripts|\.monorepo-tools)/[A-Za-z0-9_./-]+\.sh(?: [A-Za-z0-9_.:=/@+-]+){0,6}$")
JOB_FIELDS = {
    "schedule": str, "tz": str, "command": str, "class": str, "timeout_s": int, "enabled": bool,
    "jitter_s": int, "misfire_grace_s": int, "queue_timeout_s": int, "priority": int,
}
INT_BOUNDS = {"timeout_s": (1, 86400), "jitter_s": (0, 3600), "misfire_grace_s": (0, 86400),
              "queue_timeout_s": (1, 86400), "priority": (-100, 100)}
SETTING_INTS = {"light_cap": (1, 256), "heavy_cap": (1, 128), "site_heavy_cap": (1, 16),
                "retention_days": (1, 365)}


def _validate_job_patch(body: dict, *, create: bool) -> dict:
    out: dict = {}
    for k, v in body.items():
        if k in ("site", "name") and create:
            continue
        typ = JOB_FIELDS.get(k)
        if typ is None:
            raise SchedError(f"unknown or immutable field {k!r}")
        if typ is int and (isinstance(v, bool) or not isinstance(v, int)):
            raise SchedError(f"{k} must be an integer")
        if typ is int and not INT_BOUNDS[k][0] <= v <= INT_BOUNDS[k][1]:
            raise SchedError(f"{k} must be in [{INT_BOUNDS[k][0]},{INT_BOUNDS[k][1]}]")
        if typ is bool and not isinstance(v, bool):
            raise SchedError(f"{k} must be a boolean")
        if typ is str and not isinstance(v, str):
            raise SchedError(f"{k} must be a string")
        out[k] = v
    try:
        if "schedule" in out:
            cronexpr.parse(out["schedule"])
        if "tz" in out:
            cronexpr.zone(out["tz"])
    except cronexpr.CronError as e:
        raise SchedError(str(e))
    if "command" in out and not SAFE_CMD_RE.match(out["command"]):
        raise SchedError("command must be `bash ops/scripts/<name>.sh [simple args]` "
                         "(no shell metacharacters); import complex lines from the crontab instead")
    if "class" in out and out["class"] not in ("light", "heavy"):
        raise SchedError("class must be light|heavy")
    if "enabled" in out:
        out["enabled"] = int(out["enabled"])
    return out


class Service:
    """Engine facade executed on the loop thread."""

    def __init__(self, engine: Engine, loop: asyncio.AbstractEventLoop, sites_dir: Path,
                 marker_dir: Path | None = None, docker=None):
        self.e, self.loop, self.sites_dir = engine, loop, sites_dir
        self.marker_dir = marker_dir
        self.docker = docker or self._docker
        self.sync_markers()

    def sync_markers(self) -> None:
        """Host-visible flag per adopted site (<data>/adopted/<site>) so legacy self-heal
        scripts (ensure-fleet-cron.sh, fleet-doctor) know not to resurrect the old cron container."""
        if not self.marker_dir:
            return
        try:
            self.marker_dir.mkdir(parents=True, exist_ok=True)
            want = self.e.adopted
            for f in self.marker_dir.iterdir():
                if f.name not in want:
                    f.unlink(missing_ok=True)
            for site in want:
                (self.marker_dir / site).touch()
        except OSError:
            log.exception("could not sync adoption markers")

    def call(self, fn, *a, timeout: float = 15.0):
        fut: concurrent.futures.Future = concurrent.futures.Future()

        def run():
            try:
                fut.set_result(fn(*a))
            except BaseException as ex:  # noqa: BLE001 - propagate to HTTP thread
                fut.set_exception(ex)
        self.loop.call_soon_threadsafe(run)
        return fut.result(timeout=timeout)

    # --- reads
    def jobs(self, site=None):
        e = self.e
        last = e.db.last_runs()
        out = []
        for r in e.db.jobs(site):
            d = {k: r[k] for k in r.keys() if k != "env_json"}
            d["active"] = e._schedulable(dict(r))
            nf = e.next_fire(r["id"])
            d["next_fire"] = int(nf) if nf else None
            lr = last.get(r["id"])
            d["last_run"] = ({k: lr[k] for k in ("id", "status", "exit_code", "started_at", "finished_at")}
                             if lr else None)
            out.append(d)
        return out

    def runs(self, **q):
        return [dict(r) for r in self.e.db.runs(**q)]

    def run(self, run_id):
        r = self.e.db.run(run_id)
        if not r:
            raise SchedError("no such run", 404)
        return dict(r)

    def status(self):
        s = self.e.status()
        s["sites"] = [dict(r) for r in self.e.db.conn.execute(
            "SELECT site, COUNT(*) jobs, SUM(enabled) enabled FROM jobs GROUP BY site")]
        adopted = self.e.adopted
        for x in s["sites"]:
            x["adopted"] = x["site"] in adopted
        s["settings"] = self.e.settings
        return s

    def audit(self, limit=100):
        return [dict(r) for r in self.e.db.conn.execute(
            "SELECT * FROM audit ORDER BY id DESC LIMIT ?", (max(1, min(limit, 500)),))]

    # --- writes
    def create_job(self, body: dict, actor: str):
        site, name = body.get("site"), body.get("name")
        cfg = self.e.cfg
        ok_site = (site == cfg.group) if cfg.cwd else (
            isinstance(site, str) and SITE_RE.match(site) and (self.sites_dir / site).is_dir())
        if not (isinstance(site, str) and ok_site):
            raise SchedError("unknown site")
        if not (isinstance(name, str) and NAME_RE.match(name)):
            raise SchedError("invalid name")
        f = _validate_job_patch(body, create=True)
        for req in ("schedule", "command"):
            if req not in f:
                raise SchedError(f"{req} is required")
        f.setdefault("last_fire_ts", int(time.time()))
        if self.e.db.conn.execute("SELECT 1 FROM jobs WHERE site=? AND name=?", (site, name)).fetchone():
            raise SchedError("job already exists", 409)
        jid = self.e.db.insert_job(site=site, name=name, source="api", **f)
        self.e.db.audit(actor, "create", jid, {"site": site, "name": name, **f})
        self.e.reload_job(jid)
        return {"id": jid}

    def patch_job(self, jid: int, body: dict, actor: str):
        if not self.e.db.job(jid):
            raise SchedError("no such job", 404)
        f = _validate_job_patch(body, create=False)
        if not f:
            raise SchedError("nothing to update")
        if "schedule" in f or "tz" in f:
            f["last_fire_ts"] = int(time.time())  # never "catch up" across an edit
        self.e.db.update_job(jid, **f)
        self.e.db.audit(actor, "update", jid, f)
        self.e.reload_job(jid)
        return {"ok": True}

    def delete_job(self, jid: int, actor: str):
        row = self.e.db.job(jid)
        if not row:
            raise SchedError("no such job", 404)
        self.e.db.delete_job(jid)
        self.e.db.audit(actor, "delete", jid, {"site": row["site"], "name": row["name"]})
        self.e.reload_job(jid)
        return {"ok": True}

    def set_settings(self, body: dict, actor: str):
        applied = {}
        for k, v in body.items():
            if k == "paused":
                if not isinstance(v, bool):
                    raise SchedError("paused must be boolean")
                applied[k] = "1" if v else "0"
            elif k in SETTING_INTS:
                lo, hi = SETTING_INTS[k]
                if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
                    raise SchedError(f"{k} must be an integer in [{lo},{hi}]")
                applied[k] = str(v)
            else:
                raise SchedError(f"unknown setting {k!r}")
        for k, v in applied.items():
            self.e.db.set_setting(k, v)
        self.e.db.audit(actor, "settings", None, applied)
        self.e.settings = self.e.db.settings()
        self.e._poke()
        return self.e.settings

    # -- cutover -------------------------------------------------------
    @staticmethod
    def _docker(args: list[str], cwd: str | None = None, timeout: float = 60.0) -> subprocess.CompletedProcess:
        return subprocess.run(["docker", *args], cwd=cwd, capture_output=True, text=True, timeout=timeout,
                              stdin=subprocess.DEVNULL)

    def _legacy_ids(self, site: str) -> list[str]:
        r = self.docker(["ps", "-a", "-q",
                         "--filter", f"label=com.docker.compose.project.working_dir={self.sites_dir / site}",
                         "--filter", "label=com.docker.compose.service=cron"], timeout=20)
        if r.returncode != 0:
            raise SchedError(f"docker ps failed: {r.stderr.strip()[:200]}", 502)
        return r.stdout.split()

    def _adopt_db(self, site: str, adopted: bool, actor: str):
        now = int(time.time())
        for r in self.e.db.jobs(site):  # never fire schedule ticks from before the handover
            self.e.db.update_job(r["id"], last_fire_ts=now)
        self.e.db.set_adopted(site, adopted)
        self.e.db.audit(actor, "adopt" if adopted else "release", None, {"site": site})
        self.e.reload_all()
        self.sync_markers()

    def _check_adoptable(self, site: str) -> None:
        if not SITE_RE.match(site) or not self.e.db.jobs(site):
            raise SchedError("unknown site (no imported jobs)", 404)
        if self.e.cfg.cwd:  # single-group instance: no per-site overlays to verify
            return
        sd = self.sites_dir / site
        try:
            env_ok = (sd / ".env.shared").is_file() and os.access(sd / ".env.shared", os.R_OK) \
                and (sd / ".env.shared").stat().st_size > 0
            tools_ok = (sd / ".monorepo-tools").is_dir() and any((sd / ".monorepo-tools").iterdir())
        except OSError:
            env_ok = tools_ok = False
        if not (env_ok and tools_ok):
            raise SchedError(f"{site} is missing its .env.shared / .monorepo-tools overlays in the scheduler "
                             f"container — run bin/fleet-scheduler up to re-render mounts", 409)

    def adopt_site(self, site: str, adopted: bool, actor: str) -> dict:
        """Runs on the HTTP thread (docker stop can take ~30s; must not block the engine loop).
        Order matters: a skipped tick is cheap, a doubled tick is not."""
        self.call(self._check_adoptable, site)
        warnings: list[str] = []
        if self.e.cfg.cwd:  # fleet-tools instance: no legacy per-site container to swap
            self.call(self._adopt_db, site, adopted, actor)
            return {"site": site, "adopted": adopted, "warnings": warnings}
        if adopted:
            ids = self._legacy_ids(site)
            if ids:
                r = self.docker(["stop", "-t", "30", *ids], timeout=90)
                if r.returncode != 0:
                    raise SchedError(f"could not stop legacy cron container; NOT adopting: {r.stderr.strip()[:200]}", 502)
            self.call(self._adopt_db, site, True, actor)
            if ids:
                r = self.docker(["rm", *ids], timeout=30)
                if r.returncode != 0:
                    warnings.append(f"legacy container stopped but not removed: {r.stderr.strip()[:200]}")
        else:
            self.call(self._adopt_db, site, False, actor)
            env = dict(os.environ, PWD=str(self.sites_dir / site))
            try:
                r = subprocess.run(["docker", "compose", "up", "-d", "--no-deps", "cron"],
                                   cwd=str(self.sites_dir / site), env=env, capture_output=True, text=True,
                                   timeout=300, stdin=subprocess.DEVNULL)
                if r.returncode != 0:
                    warnings.append(f"released, but legacy cron failed to start: {r.stderr.strip()[-300:]}")
            except (OSError, subprocess.TimeoutExpired) as ex:
                warnings.append(f"released, but legacy cron failed to start: {ex}")
        return {"site": site, "adopted": adopted, "warnings": warnings}

    def reload(self, actor: str):
        self.e.reload_all()
        return {"jobs": len(self.e.jobs)}


ROUTES: list[tuple[str, re.Pattern, str]] = []
HANDLERS: dict = {}


def make_server(svc: Service, token: str, host: str, port: int) -> ThreadingHTTPServer:
    if len(token) < 24:
        raise ValueError("FS_TOKEN must be at least 24 characters")
    slots = threading.BoundedSemaphore(MAX_CONCURRENT)
    tok = token.encode()

    class H(BaseHTTPRequestHandler):
        timeout = 10
        server_version = "fleetsched"
        sys_version = ""

        def log_message(self, fmt, *a):  # quiet; engine logs the interesting bits
            pass

        def _send(self, code: int, obj) -> None:
            data = json.dumps(obj, default=str).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def _auth(self) -> bool:
            h = self.headers.get("Authorization", "")
            return h.startswith("Bearer ") and hmac.compare_digest(h[7:].encode(), tok)

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                raise SchedError("body too large", 413)
            if n == 0:
                return {}
            try:
                v = json.loads(self.rfile.read(n))
            except ValueError:
                raise SchedError("invalid JSON")
            if not isinstance(v, dict):
                raise SchedError("body must be a JSON object")
            return v

        def _handle(self, method: str) -> None:
            if not slots.acquire(blocking=False):
                return self._send(503, {"error": "busy"})
            try:
                u = urlparse(self.path)
                if method == "GET" and u.path == "/healthz":
                    ok = svc.e.healthy()
                    return self._send(200 if ok else 503, {"ok": ok})
                if not self._auth():
                    return self._send(401, {"error": "unauthorized"})
                for m, pat, name in ROUTES:
                    mt = pat.match(u.path) if m == method else None
                    if mt:
                        body = self._body() if method in ("POST", "PATCH") else {}
                        q = {k: v[-1] for k, v in parse_qs(u.query).items()}
                        actor = (self.headers.get("X-Actor", "api")[:64] or "api")
                        actor = re.sub(r"[^A-Za-z0-9._@ -]", "?", actor)
                        return self._send(200, HANDLERS[name](svc, mt, q, body, actor))
                self._send(404, {"error": "not found"})
            except SchedError as e:
                self._send(e.status, {"error": str(e)})
            except sqlite3.IntegrityError as e:  # belt-and-braces behind the validators
                self._send(400, {"error": f"constraint violated: {e}"})
            except concurrent.futures.TimeoutError:
                self._send(504, {"error": "scheduler busy"})
            except Exception:
                log.exception("api error on %s %s", method, self.path)
                self._send(500, {"error": "internal error"})
            finally:
                slots.release()

        def do_GET(self): self._handle("GET")
        def do_POST(self): self._handle("POST")
        def do_PATCH(self): self._handle("PATCH")
        def do_DELETE(self): self._handle("DELETE")

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        request_queue_size = 32

    return Server((host, port), H)


def handler(method: str, pattern: str):
    def deco(fn):
        ROUTES.append((method, re.compile(f"^{pattern}$"), fn.__name__))
        HANDLERS[fn.__name__] = fn
        return fn
    return deco


def _int(q, key, default=None):
    v = q.get(key)
    if v is None:
        return default
    if not v.lstrip("-").isdigit():
        raise SchedError(f"{key} must be an integer")
    return int(v)


@handler("GET", "/api/status")
def h_status(svc, m, q, b, actor): return svc.call(svc.status)


@handler("GET", "/api/jobs")
def h_jobs(svc, m, q, b, actor):
    site = q.get("site")
    if site and not SITE_RE.match(site):
        raise SchedError("bad site")
    return svc.call(svc.jobs, site)


@handler("POST", "/api/jobs")
def h_create(svc, m, q, b, actor): return svc.call(svc.create_job, b, actor)


@handler("PATCH", r"/api/jobs/(\d+)")
def h_patch(svc, m, q, b, actor): return svc.call(svc.patch_job, int(m.group(1)), b, actor)


@handler("DELETE", r"/api/jobs/(\d+)")
def h_delete(svc, m, q, b, actor): return svc.call(svc.delete_job, int(m.group(1)), actor)


@handler("POST", r"/api/jobs/(\d+)/run")
def h_run(svc, m, q, b, actor): return {"run_id": svc.call(svc.e.trigger_manual, int(m.group(1)), actor)}


@handler("GET", "/api/runs")
def h_runs(svc, m, q, b, actor):
    return svc.call(lambda: svc.runs(site=q.get("site"), job_id=_int(q, "job_id"),
                                     status=q.get("status"), limit=_int(q, "limit", 100)))


@handler("GET", r"/api/runs/(\d+)")
def h_run_get(svc, m, q, b, actor): return svc.call(svc.run, int(m.group(1)))


@handler("POST", r"/api/runs/(\d+)/cancel")
def h_cancel(svc, m, q, b, actor): return {"result": svc.call(svc.e.cancel_run, int(m.group(1)), actor)}


@handler("GET", "/api/settings")
def h_settings_get(svc, m, q, b, actor): return svc.call(lambda: dict(svc.e.settings))


@handler("PATCH", "/api/settings")
def h_settings_set(svc, m, q, b, actor): return svc.call(svc.set_settings, b, actor)


@handler("POST", r"/api/sites/([A-Za-z0-9.-]+)/(adopt|release)")
def h_adopt(svc, m, q, b, actor): return svc.adopt_site(m.group(1), m.group(2) == "adopt", actor)


@handler("GET", "/api/audit")
def h_audit(svc, m, q, b, actor): return svc.call(svc.audit, _int(q, "limit", 100))


@handler("POST", "/api/reload")
def h_reload(svc, m, q, b, actor): return svc.call(svc.reload, actor)
