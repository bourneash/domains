"""The scheduling engine: timer heap -> bounded queue -> subprocess runner.

Everything here runs on ONE asyncio loop thread (the API hands work over via
call_soon_threadsafe), so state needs no locks. The DB is only touched from
that thread as well.

Concepts
  fire      a schedule tick for a job. Becomes a `runs` row (status queued) or,
            if it can't run, an explanatory terminal row (skipped_overlap/missed).
  class     'light' (in-container probes, seconds) vs 'heavy' (spawns a worker
            container / runs Claude). Each class has a global concurrency cap;
            heavy also has a per-site cap. Excess fires QUEUE instead of all
            starting on the same minute boundary.
  adopted   a site only fires once adopted; until then its jobs are imported
            but inert, so the legacy per-site cron container is never doubled.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import heapq
import itertools
import logging
import os
import random
import re
import signal
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from . import cronexpr
from .db import DB

log = logging.getLogger("fleetsched")

SITE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]{0,80}$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")
TERMINAL = {"ok", "failed", "timeout", "killed", "missed", "lost",
            "skipped_overlap", "skipped_queue"}

ENVFILE_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def make_wrapper(env_file: str = ".env.shared") -> str:
    """Sourced exactly like the legacy cron entrypoint did, then handed to /bin/sh like
    supercronic does. env_file is a bare filename (validated) relative to the job's cwd."""
    if not ENVFILE_RE.match(env_file):
        raise ValueError(f"bad env file name {env_file!r}")
    return f'if [ -f ./{env_file} ]; then set -a; . ./{env_file}; set +a; fi; exec /bin/sh -c "$1"'


WRAPPER = make_wrapper()
ENV_PASSTHROUGH = ("PATH", "HOME", "LANG", "DOCKER_HOST", "DOCKER_CONFIG",
                   "FLEET_WORKER_IMAGE", "FLEET_WORKER_VERSION")
MANUAL_PRIORITY = 1000


class SchedError(Exception):
    def __init__(self, msg: str, status: int = 400):
        super().__init__(msg)
        self.status = status


@dataclass
class Config:
    root: Path = Path("/home/jesse/projects/domains")
    tail_ok: int = 4096
    tail_fail: int = 16384
    kill_grace_s: float = 30.0
    tick_max_s: float = 15.0
    wrapper: str = WRAPPER
    # Single-group mode (the fleet-tools instance): every job runs in `cwd`, not sites/<site>.
    cwd: Path | None = None
    group: str | None = None
    env_extra: tuple = ()
    housekeeping_every_s: float = 6 * 3600
    backup_dir: Path | None = None
    backups_keep: int = 7

    @property
    def sites_dir(self) -> Path:
        return self.root / "sites"

    def crontab_for(self, site: str) -> Path | None:
        """The legacy crontab.docker this group mirrors to (None = don't mirror)."""
        if self.cwd:  # single-group instance (fleet tools)
            p = self.root / "tools" / "fleet-cron" / "crontab.docker"
            return p if site == self.group else None
        return self.sites_dir / site / "ops" / "docker" / "crontab.docker"


@dataclass
class Job:
    row: dict
    expr: cronexpr.CronExpr
    tz: Any
    gen: int = 0

    @property
    def id(self) -> int:
        return self.row["id"]


@dataclass
class Pending:
    run_id: int
    job_id: int
    site: str
    name: str
    cls: str
    priority: int
    scheduled_for: float
    queued_at: float
    not_before: float
    deadline: float | None
    trigger: str
    command: str
    timeout_s: int
    tz: str
    env: dict
    ok_codes: tuple = (0,)
    seq: int = 0


@dataclass
class Running:
    p: Pending
    task: asyncio.Task | None = None
    proc: asyncio.subprocess.Process | None = None
    cancel_reason: str | None = None


class Engine:
    def __init__(self, db: DB, cfg: Config | None = None, *, now: Callable[[], float] = time.time,
                 executor=None):
        self.db = db
        self.cfg = cfg or Config()
        self.now = now
        self._executor = executor or self._exec_subprocess
        self.jobs: dict[int, Job] = {}
        self.heap: list[tuple[float, int, int, int]] = []  # (fire_ts, seq, job_id, gen)
        self.pending: list[Pending] = []
        self.running: dict[int, Running] = {}
        self._seq = itertools.count()
        self._gen = itertools.count(1)
        self.adopted: set[str] = set()
        self.stopping = False
        self.started_at = now()
        self.last_loop_ts = now()
        self.counters: dict[str, int] = {}
        self._wake: asyncio.Event | None = None
        self._next_housekeeping = 0.0
        self.settings: dict[str, str] = {}

    # ---------------------------------------------------------- loading
    def start(self) -> None:
        """Synchronous bootstrap; call once before run_forever()."""
        if not self.db.integrity_ok():
            raise SchedError("database failed integrity check", 500)
        n = self.db.reconcile_orphans("scheduler restarted while run was queued/running")
        if n:
            log.warning("reconciled %d orphaned run(s) from previous process", n)
            self._count("lost", n)
        self.reload_all(catch_up=True)

    def reload_all(self, catch_up: bool = False) -> None:
        self.settings = self.db.settings()
        self.adopted = self.db.adopted_sites()
        self.heap.clear()
        self.jobs.clear()
        for row in self.db.jobs():
            self._install(dict(row), catch_up=catch_up)
        self._poke()

    def reload_job(self, job_id: int) -> None:
        self.settings = self.db.settings()
        self.adopted = self.db.adopted_sites()
        row = self.db.job(job_id)
        self.jobs.pop(job_id, None)  # heap entries carry the old generation -> ignored
        if row:
            self._install(dict(row), catch_up=False)
        self._poke()

    def _install(self, row: dict, *, catch_up: bool) -> None:
        try:
            expr = cronexpr.parse(row["schedule"])
            tz = cronexpr.zone(row["tz"])
        except cronexpr.CronError as e:
            log.error("job %s/%s has invalid schedule/tz, not scheduling: %s", row["site"], row["name"], e)
            return
        job = Job(row=row, expr=expr, tz=tz, gen=next(self._gen))
        self.jobs[job.id] = job
        if not self._schedulable(row):
            return
        now = self.now()
        base = row["last_fire_ts"] if row["last_fire_ts"] is not None else now
        if row["last_fire_ts"] is None:
            self.db.update_job(job.id, last_fire_ts=int(now))
        nxt = self._next(job, base)
        if catch_up and nxt <= now and now - nxt <= row["misfire_grace_s"]:
            self._fire(job, nxt, note="catch-up after scheduler restart")
            nxt = self._next(job, now)
        elif nxt <= now:
            nxt = self._next(job, now)
        self._push(job, nxt)

    def _schedulable(self, row: dict) -> bool:
        return bool(row["enabled"]) and row["site"] in self.adopted

    def _next(self, job: Job, after_ts: float) -> float:
        return job.expr.next_after(dt.datetime.fromtimestamp(after_ts, dt.timezone.utc), job.tz).timestamp()

    def _push(self, job: Job, ts: float) -> None:
        heapq.heappush(self.heap, (ts, next(self._seq), job.id, job.gen))

    def next_fire(self, job_id: int) -> float | None:
        """Display helper: next fire time for a job whether or not it's active."""
        j = self.jobs.get(job_id)
        return self._next(j, self.now()) if j else None

    # ---------------------------------------------------------- firing
    def tick(self) -> None:
        """Process every due timer. Safe to call at any time."""
        with self.db.txn():
            self._tick_locked()

    def _tick_locked(self) -> None:
        now = self.now()
        while self.heap and self.heap[0][0] <= now:
            ts, _, job_id, gen = heapq.heappop(self.heap)
            job = self.jobs.get(job_id)
            if job is None or job.gen != gen or not self._schedulable(job.row):
                continue
            late = now - ts
            if late > job.row["misfire_grace_s"]:
                self._record_terminal(job, ts, "missed", f"fired {late:.0f}s late (grace {job.row['misfire_grace_s']}s)")
            else:
                self._fire(job, ts)
            self.db.update_job(job.id, last_fire_ts=int(ts))
            job.row["last_fire_ts"] = int(ts)
            self._push(job, self._next(job, max(now, ts)))
        self._expire_queue(now)

    def _fire(self, job: Job, scheduled_ts: float, *, note: str | None = None,
              trigger: str = "schedule") -> int | None:
        if self.stopping or self.settings.get("paused") == "1":
            self._count("skipped_paused")
            return None
        r = job.row
        if trigger == "schedule" and r["class"] == "heavy" and self.settings.get("drain_heavy") == "1":
            self._count("skipped_draining")  # deploy in progress: no NEW heavy work; light probes keep running
            return None
        if self._active(job.id):
            self._record_terminal(job, scheduled_ts, "skipped_overlap", "previous run still queued/running")
            return None
        now = self.now()
        jitter = random.uniform(0, r["jitter_s"]) if r["jitter_s"] and trigger == "schedule" else 0.0
        run_id = self.db.insert_run(job_id=job.id, site=r["site"], name=r["name"], **{"class": r["class"]},
                                    trigger=trigger, status="queued", scheduled_for=int(scheduled_ts),
                                    queued_at=int(now), note=note)
        self.pending.append(Pending(
            run_id=run_id, job_id=job.id, site=r["site"], name=r["name"], cls=r["class"],
            priority=MANUAL_PRIORITY if trigger == "manual" else r["priority"],
            scheduled_for=scheduled_ts, queued_at=now, not_before=now + jitter,
            deadline=None if trigger == "manual" else now + r["queue_timeout_s"] + jitter,
            trigger=trigger, command=r["command"], timeout_s=r["timeout_s"], tz=r["tz"],
            env=self._job_env(r), ok_codes=self._ok_codes(r), seq=next(self._seq)))
        self._poke()
        return run_id

    def trigger_manual(self, job_id: int, actor: str) -> int:
        job = self.jobs.get(job_id)
        if job is None:
            raise SchedError("no such job (or invalid schedule)", 404)
        if self.stopping:
            raise SchedError("scheduler is shutting down", 503)
        if self.settings.get("paused") == "1":
            raise SchedError("scheduler is paused", 409)
        if self._active(job_id):
            raise SchedError("job already queued or running", 409)
        run_id = self._fire(job, self.now(), trigger="manual", note=f"manual by {actor}")
        self.db.audit(actor, "run", job_id, {"run_id": run_id})
        return run_id  # type: ignore[return-value]

    def _active(self, job_id: int) -> bool:
        return any(p.job_id == job_id for p in self.pending) or \
            any(r.p.job_id == job_id for r in self.running.values())

    def _record_terminal(self, job: Job, scheduled_ts: float, status: str, note: str) -> None:
        now = int(self.now())
        self.db.insert_run(job_id=job.id, site=job.row["site"], name=job.row["name"],
                           **{"class": job.row["class"]}, trigger="schedule", status=status,
                           scheduled_for=int(scheduled_ts), queued_at=now, finished_at=now, note=note)
        self._count(status)

    @staticmethod
    def _ok_codes(row: dict) -> tuple:
        try:
            codes = tuple(int(x) for x in str(row.get("ok_codes") or "0").split(",") if x.strip() != "")
        except ValueError:
            codes = (0,)
        return codes or (0,)

    @staticmethod
    def _job_env(row: dict) -> dict:
        import json
        try:
            extra = json.loads(row["env_json"] or "{}")
        except ValueError:
            extra = {}
        return {str(k): str(v) for k, v in extra.items()}

    # ---------------------------------------------------------- queue
    def _caps(self) -> tuple[int, int, int]:
        s = self.settings
        return int(s.get("light_cap", 24)), int(s.get("heavy_cap", 8)), int(s.get("site_heavy_cap", 2))

    def _expire_queue(self, now: float) -> None:
        keep = []
        for p in self.pending:
            if p.deadline is not None and now >= p.deadline:
                self.db.update_run(p.run_id, status="skipped_queue", finished_at=int(now),
                                   note=f"waited {now - p.queued_at:.0f}s in queue; caps saturated")
                self._count("skipped_queue")
            else:
                keep.append(p)
        self.pending = keep

    def dispatch(self) -> None:
        """Start as many queued runs as the caps allow."""
        if self.stopping or self.settings.get("paused") == "1":
            return
        now = self.now()
        light_cap, heavy_cap, site_cap = self._caps()
        n_class = {"light": 0, "heavy": 0}
        n_site_heavy: dict[str, int] = {}
        for r in self.running.values():
            n_class[r.p.cls] += 1
            if r.p.cls == "heavy":
                n_site_heavy[r.p.site] = n_site_heavy.get(r.p.site, 0) + 1
        started: list[Pending] = []
        for p in sorted(self.pending, key=lambda x: (-x.priority, x.scheduled_for, x.seq)):
            if p.not_before > now:
                continue
            if p.cls == "heavy" and self.settings.get("drain_heavy") == "1":
                continue
            cap = light_cap if p.cls == "light" else heavy_cap
            if n_class[p.cls] >= cap:
                continue
            if p.cls == "heavy" and n_site_heavy.get(p.site, 0) >= site_cap:
                continue
            n_class[p.cls] += 1
            if p.cls == "heavy":
                n_site_heavy[p.site] = n_site_heavy.get(p.site, 0) + 1
            started.append(p)
        if not started:
            return
        ids = {p.run_id for p in started}
        self.pending = [p for p in self.pending if p.run_id not in ids]
        with self.db.txn():
            for p in started:
                self.db.update_run(p.run_id, status="running", started_at=int(now))
        for p in started:
            ctx = Running(p=p)
            self.running[p.run_id] = ctx
            ctx.task = asyncio.get_running_loop().create_task(self._run(ctx), name=f"run-{p.run_id}")

    async def _run(self, ctx: Running) -> None:
        p = ctx.p
        status, exit_code, tail, note = "failed", None, b"", None
        try:
            status, exit_code, tail, note = await self._executor(ctx)
        except asyncio.CancelledError:
            status, note = "killed", "scheduler task cancelled"
        except Exception as e:  # never let a runner bug wedge a slot
            log.exception("runner crashed for run %s", p.run_id)
            status, note = "failed", f"runner error: {e!r}"
        finally:
            limit = self.cfg.tail_ok if status == "ok" else self.cfg.tail_fail
            text = tail[-limit:].decode("utf-8", "replace").replace("\x00", "") if tail else None
            self.db.update_run(p.run_id, status=status, exit_code=exit_code, finished_at=int(self.now()),
                               output_tail=text or None, note=note or ctx.cancel_reason)
            self._count(status)
            self.running.pop(p.run_id, None)
            log.info("run %s %s/%s -> %s exit=%s", p.run_id, p.site, p.name, status, exit_code)
            self._poke()

    async def _exec_subprocess(self, ctx: Running):
        p, cfg = ctx.p, self.cfg
        cwd = cfg.cwd or (cfg.sites_dir / p.site)
        if not cwd.is_dir():
            return "failed", 127, b"", f"working directory missing: {cwd}"
        env = {k: os.environ[k] for k in (*ENV_PASSTHROUGH, *cfg.env_extra) if k in os.environ}
        env.update({"TZ": p.tz, "SITE_NAME": p.site})
        env.update(p.env)
        try:
            proc = await asyncio.create_subprocess_exec(
                "bash", "-c", cfg.wrapper, "_", p.command, cwd=str(cwd), env=env,
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT, start_new_session=True)
        except OSError as e:
            return "failed", 127, b"", f"spawn failed: {e}"
        ctx.proc = proc
        buf = bytearray()
        keep = cfg.tail_fail

        async def pump():  # bounded memory: never holds more than ~2x the kept tail
            assert proc.stdout
            while chunk := await proc.stdout.read(65536):
                buf.extend(chunk)
                if len(buf) > 2 * keep:
                    del buf[:-keep]

        pump_task = asyncio.ensure_future(pump())
        timed_out = False
        try:
            await asyncio.wait_for(asyncio.shield(proc.wait()), timeout=p.timeout_s)
        except asyncio.TimeoutError:
            timed_out = True
            await self._kill(proc)
        except asyncio.CancelledError:
            await self._kill(proc)
            raise
        rc = proc.returncode
        try:
            await asyncio.wait_for(pump_task, timeout=5)
        except asyncio.TimeoutError:
            pump_task.cancel()  # a backgrounded grandchild is holding the pipe open
        note = None
        if timed_out:
            status, note = "timeout", f"exceeded {p.timeout_s}s; process group terminated"
        elif rc in p.ok_codes:
            status = "ok"
            if rc != 0:
                note = f"exit {rc} counted as ok (job ok_codes)"
        else:
            status = "killed" if ctx.cancel_reason else "failed"
        return status, rc, bytes(buf), note

    async def _kill(self, proc: asyncio.subprocess.Process) -> None:
        for sig, wait in ((signal.SIGTERM, self.cfg.kill_grace_s), (signal.SIGKILL, 10)):
            try:
                os.killpg(proc.pid, sig)
            except ProcessLookupError:
                return
            try:
                await asyncio.wait_for(proc.wait(), timeout=wait)
                return
            except asyncio.TimeoutError:
                continue

    def cancel_run(self, run_id: int, actor: str) -> str:
        ctx = self.running.get(run_id)
        if ctx:
            ctx.cancel_reason = f"cancelled by {actor}"
            if ctx.proc and ctx.proc.returncode is None:
                try:
                    os.killpg(ctx.proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            elif ctx.task:
                ctx.task.cancel()
            self.db.audit(actor, "cancel", ctx.p.job_id, {"run_id": run_id})
            return "cancelling"
        for p in self.pending:
            if p.run_id == run_id:
                self.pending.remove(p)
                self.db.update_run(run_id, status="killed", finished_at=int(self.now()),
                                   note=f"cancelled by {actor} while queued")
                self._count("killed")
                self.db.audit(actor, "cancel", p.job_id, {"run_id": run_id})
                return "dequeued"
        raise SchedError("run is not queued or running", 404)

    # ---------------------------------------------------------- loop
    def _poke(self) -> None:
        if self._wake is not None:
            self._wake.set()

    def _count(self, key: str, n: int = 1) -> None:
        self.counters[key] = self.counters.get(key, 0) + n

    def _sleep_for(self) -> float:
        now = self.now()
        t = now + self.cfg.tick_max_s
        if self.heap:
            t = min(t, self.heap[0][0])
        for p in self.pending:
            if p.not_before > now:
                t = min(t, p.not_before)
            if p.deadline is not None:
                t = min(t, p.deadline)
        return max(0.0, t - now)

    async def run_forever(self, on_beat: Callable[[], None] | None = None) -> None:
        self._wake = asyncio.Event()
        while not self.stopping:
            self.last_loop_ts = self.now()
            if on_beat:
                on_beat()
            try:
                self.tick()
                self.dispatch()
                self._housekeeping()
            except Exception:
                log.exception("scheduler loop iteration failed; continuing")
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=self._sleep_for())
            except asyncio.TimeoutError:
                pass

    def _housekeeping(self) -> None:
        now = self.now()
        if now < self._next_housekeeping:
            return
        self._next_housekeeping = now + self.cfg.housekeeping_every_s
        try:
            days = int(self.settings.get("retention_days", 30))
            self.db.prune(days)
            if not self.db.integrity_ok():
                log.error("DATABASE INTEGRITY CHECK FAILED")
            if self.cfg.backup_dir:
                self.cfg.backup_dir.mkdir(parents=True, exist_ok=True)
                stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d")
                self.db.backup(str(self.cfg.backup_dir / f"fleet-scheduler-{stamp}.db"))
                old = sorted(self.cfg.backup_dir.glob("fleet-scheduler-*.db"))[:-self.cfg.backups_keep]
                for f in old:
                    f.unlink(missing_ok=True)
        except Exception:
            log.exception("housekeeping failed")

    async def shutdown(self, grace_s: float = 20.0) -> None:
        self.stopping = True
        now = int(self.now())
        for p in self.pending:
            self.db.update_run(p.run_id, status="missed", finished_at=now, note="scheduler shutting down")
            self._count("missed")
        self.pending.clear()
        for ctx in list(self.running.values()):
            ctx.cancel_reason = "scheduler shutdown"
            if ctx.proc and ctx.proc.returncode is None:
                try:
                    os.killpg(ctx.proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        tasks = [c.task for c in self.running.values() if c.task]
        if tasks:
            done, left = await asyncio.wait(tasks, timeout=grace_s)
            for t in left:
                t.cancel()
            if left:
                await asyncio.wait(left, timeout=5)
        self._poke()

    # ---------------------------------------------------------- introspection
    def status(self) -> dict:
        light_cap, heavy_cap, site_cap = self._caps()
        return {
            "paused": self.settings.get("paused") == "1",
            "uptime_s": int(self.now() - self.started_at),
            "running": len(self.running), "queued": len(self.pending),
            "jobs": len(self.jobs), "scheduled": sum(1 for j in self.jobs.values() if self._schedulable(j.row)),
            "adopted_sites": sorted(self.adopted),
            "caps": {"light": light_cap, "heavy": heavy_cap, "site_heavy": site_cap},
            "counters": dict(self.counters),
            "loop_lag_s": round(self.now() - self.last_loop_ts, 2),
        }

    def healthy(self) -> bool:
        return not self.stopping and (self.now() - self.last_loop_ts) < self.cfg.tick_max_s * 3 + 5
