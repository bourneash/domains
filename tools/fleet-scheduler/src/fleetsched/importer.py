"""Turn a legacy per-site crontab.docker into scheduler job rows."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import cronexpr
from .db import DB
from .engine import NAME_RE

ENV_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
HEAVY_RE = re.compile(r"run-worker\.sh|run-role\.sh|run-engineer\.sh|run-principal-engineer\.sh|run-scraper\.sh|"
                      r"run-guide-publisher\.sh|run-image-repair\.sh")
RUN_SCRIPT_RE = re.compile(r"(?:^|[\s/])run-([A-Za-z0-9_-]+)\.sh(?:\s+([A-Za-z0-9._-]+))?")
SCRIPT_RE = re.compile(r"([A-Za-z0-9_-]+)\.(?:sh|py)\b")
DEFAULT_TZ = "America/New_York"


@dataclass
class Imported:
    name: str
    schedule: str
    command: str
    cls: str
    timeout_s: int
    priority: int
    env: dict


@dataclass
class ParseResult:
    jobs: list[Imported] = field(default_factory=list)
    env: dict = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)


def _base_name(cmd: str) -> str:
    m = RUN_SCRIPT_RE.search(cmd)
    if m:
        if m.group(1) in ("worker", "role") and m.group(2):
            return m.group(2)
        return m.group(1)
    if cmd.lstrip().startswith("find "):
        for key, nm in (("ops/logs", "prune-logs"), ("ops/.locks", "prune-locks"), ("ops/cache", "prune-cache")):
            if key in cmd:
                return nm
        return "prune"
    m = SCRIPT_RE.search(cmd)
    return m.group(1) if m else "job"


def _classify(cmd: str, name: str) -> tuple[str, int, int]:
    """-> (class, timeout_s, priority). Deployer/watchdog are 'light' so a saturated
    heavy pool of long Claude runs can never starve a deploy or an incident check."""
    if HEAVY_RE.search(cmd):
        return "heavy", 7500, 0
    if name in ("deployer", "watchdog"):
        return "light", 3600, 10
    if cmd.lstrip().startswith("find "):
        return "light", 300, -5
    return "light", 900, 0


def parse_crontab(text: str) -> ParseResult:
    res = ParseResult()
    seen: dict[str, int] = {}
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = ENV_RE.match(line)
        if m and not re.match(r"^[\d*@]", line):
            res.env[m.group(1)] = m.group(2).strip().strip("\"'")
            continue
        if line.startswith("@"):
            head, _, cmd = line.partition(" ")
            sched = head
        else:
            parts = line.split(None, 5)
            if len(parts) < 6:
                res.errors.append(f"line {lineno}: not a cron entry: {line[:80]!r}")
                continue
            sched, cmd = " ".join(parts[:5]), parts[5].strip()
        try:
            cronexpr.parse(sched)
        except cronexpr.CronError as e:
            res.errors.append(f"line {lineno}: {e}")
            continue
        base = _base_name(cmd)
        n = seen.get(base, 0) + 1
        seen[base] = n
        name = base if n == 1 else f"{base}-{n}"
        if not NAME_RE.match(name):
            res.errors.append(f"line {lineno}: derived job name {name!r} is invalid")
            continue
        cls, timeout, prio = _classify(cmd, base)
        res.jobs.append(Imported(name, sched, cmd, cls, timeout, prio, dict(res.env)))
    return res


def _queue_timeout(schedule: str, tz: str) -> int:
    import datetime as dt
    e = cronexpr.parse(schedule)
    z = cronexpr.zone(tz)
    a = e.next_after(dt.datetime(2026, 1, 15, tzinfo=dt.timezone.utc), z)
    b = e.next_after(a, z)
    return max(300, min(3600, int((b - a).total_seconds())))


def import_site(db: DB, site: str, crontab_text: str, *, update: bool = False) -> dict:
    """Idempotent. Existing jobs keep API edits unless update=True."""
    res = parse_crontab(crontab_text)
    added, updated, unchanged = [], [], []
    db.conn.execute("BEGIN IMMEDIATE")
    try:
        for j in res.jobs:
            row = db.conn.execute("SELECT * FROM jobs WHERE site=? AND name=?", (site, j.name)).fetchone()
            fields = dict(schedule=j.schedule, command=j.command, **{"class": j.cls}, timeout_s=j.timeout_s,
                          priority=j.priority, env_json=json.dumps(j.env, sort_keys=True), tz=DEFAULT_TZ,
                          queue_timeout_s=_queue_timeout(j.schedule, DEFAULT_TZ))
            if row is None:
                db.insert_job(site=site, name=j.name, source="crontab", **fields)
                added.append(j.name)
            elif update and (row["schedule"], row["command"]) != (j.schedule, j.command):
                db.update_job(row["id"], **fields, last_fire_ts=None)
                updated.append(j.name)
            else:
                unchanged.append(j.name)
        db.audit("importer", "import", None, {"site": site, "added": added, "updated": updated,
                                              "errors": res.errors})
        db.conn.execute("COMMIT")
    except Exception:
        db.conn.execute("ROLLBACK")
        raise
    return {"site": site, "added": added, "updated": updated, "unchanged": unchanged, "errors": res.errors}


def crontab_path(sites_dir: Path, site: str) -> Path:
    return sites_dir / site / "ops" / "docker" / "crontab.docker"


def export_crontab(db: DB, site: str) -> str:
    """Render the DB back to crontab syntax (rollback / audit). Disabled jobs are commented."""
    out = [f"# exported from fleet-scheduler for {site}", f"TZ={DEFAULT_TZ}"]
    env_seen: dict = {}
    for r in db.jobs(site):
        env = json.loads(r["env_json"] or "{}")
        for k, v in env.items():
            if env_seen.get(k) != v:
                out.append(f"{k}={v}")
                env_seen[k] = v
        line = f"{r['schedule']}  {r['command']}"
        out.append(line if r["enabled"] else f"# (disabled) {line}")
    return "\n".join(out) + "\n"
