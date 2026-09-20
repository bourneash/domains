"""Turn a legacy per-site crontab.docker into scheduler job rows."""
from __future__ import annotations

import json
import os
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


GENERIC_BASES = {"run", "monitor", "tick", "run-tick"}


def _base_name(cmd: str) -> str:
    dx = re.match(r"^\s*docker exec (?:-\S+ )*([A-Za-z0-9_.-]+) (.*)$", cmd)
    if dx:
        tail = re.sub(r"[^A-Za-z0-9]+", "-", dx.group(2).split()[-1]).strip("-").lower()[:30]
        return f"exec-{dx.group(1)}-{tail}"
    if cmd.lstrip().startswith("/"):  # absolute-path tool script: disambiguate generic basenames
        path = cmd.split()[0]
        stem = re.sub(r"\.(sh|py)$", "", path.rsplit("/", 1)[-1])
        if stem in GENERIC_BASES:
            return f"{path.rsplit('/', 2)[-2]}-{stem}"
        args = cmd.split()[1:]
        if args and re.match(r"^--?[A-Za-z]", args[0]):
            return f"{stem}-{args[0].lstrip('-')}"
        return stem
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


FLEET_HEAVY_RE = re.compile(r"ai-optimizer|social-controller/run\.sh")


def _classify_fleet(cmd: str) -> tuple[str, int, int]:
    """Fleet-tool jobs: all get a generous timeout (they include docker gc / lint sweeps);
    the Claude-invoking ones are heavy so they queue behind the heavy cap."""
    if FLEET_HEAVY_RE.search(cmd):
        return "heavy", 7500, 0
    return "light", 3600, 0


def _classify(cmd: str, name: str) -> tuple[str, int, int]:
    """-> (class, timeout_s, priority). Deployer/watchdog are 'light' so a saturated
    heavy pool of long Claude runs can never starve a deploy or an incident check."""
    if name.split("-")[0] in ("deployer", "watchdog"):
        # even when it spawns a worker (long run), it must never queue behind Claude roles
        return "light", (7500 if HEAVY_RE.search(cmd) else 3600), 10
    if HEAVY_RE.search(cmd):
        return "heavy", 7500, 0
    if cmd.lstrip().startswith("find "):
        return "light", 300, -5
    return "light", 900, 0


def parse_crontab(text: str, fleet: bool = False) -> ParseResult:
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
        cls, timeout, prio = _classify_fleet(cmd) if fleet else _classify(cmd, base)
        res.jobs.append(Imported(name, sched, cmd, cls, timeout, prio, dict(res.env)))
    return res


STD_COMPOSE_ENV = {"SITE_NAME", "FLEET_WORKER_IMAGE", "TZ", "COMPOSE_PROJECT_NAME", "HOME"}


def compose_cron_env(site_dir: Path) -> dict:
    """Env the site's legacy cron container got from its compose file (DATAHUB_API, BSG_LLM_*, ...),
    minus what the scheduler already sets. ${VAR:-default} is expanded from the environment/default."""
    try:
        import yaml
        doc = yaml.safe_load((site_dir / "docker-compose.yml").read_text()) or {}
    except Exception:  # noqa: BLE001 - missing yaml/compose just means no extras
        return {}
    env = ((doc.get("services") or {}).get("cron") or {}).get("environment") or {}
    if isinstance(env, list):
        env = dict(x.split("=", 1) for x in env if "=" in x)

    def expand(v: str) -> str:
        return re.sub(r"\$\{(\w+)(?::-([^}]*))?\}",
                      lambda m: os.environ.get(m.group(1)) or (m.group(2) or ""), str(v))
    return {k: expand(v) for k, v in env.items() if k not in STD_COMPOSE_ENV}


def _queue_timeout(schedule: str, tz: str) -> int:
    import datetime as dt
    e = cronexpr.parse(schedule)
    z = cronexpr.zone(tz)
    a = e.next_after(dt.datetime(2026, 1, 15, tzinfo=dt.timezone.utc), z)
    b = e.next_after(a, z)
    return max(300, min(3600, int((b - a).total_seconds())))


def import_site(db: DB, site: str, crontab_text: str, *, update: bool = False, fleet: bool = False,
                compose_env: dict | None = None) -> dict:
    """Idempotent. Existing jobs keep API edits unless update=True."""
    res = parse_crontab(crontab_text, fleet=fleet)
    added, updated, unchanged = [], [], []
    db.conn.execute("BEGIN IMMEDIATE")
    try:
        for j in res.jobs:
            row = db.conn.execute("SELECT * FROM jobs WHERE site=? AND name=?", (site, j.name)).fetchone()
            fields = dict(schedule=j.schedule, command=j.command, **{"class": j.cls}, timeout_s=j.timeout_s,
                          priority=j.priority, tz=DEFAULT_TZ,
                          env_json=json.dumps({**(compose_env or {}), **j.env}, sort_keys=True),
                          ok_codes="0,1" if j.command.lstrip().startswith("find ") else "0",
                          queue_timeout_s=_queue_timeout(j.schedule, DEFAULT_TZ))
            if row is None:
                db.insert_job(site=site, name=j.name, source="crontab", **fields)
                added.append(j.name)
            elif update and (row["schedule"], row["command"]) != (j.schedule, j.command):
                db.update_job(row["id"], **fields, last_fire_ts=None)
                updated.append(j.name)
            else:
                # env is derived purely from files (never API-editable): keep it current.
                if row["env_json"] != fields["env_json"]:
                    db.update_job(row["id"], env_json=fields["env_json"])
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
