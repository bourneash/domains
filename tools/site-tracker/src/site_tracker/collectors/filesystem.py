"""Filesystem / git collector.

Reads each site's repo for:
  - last commit timestamp on HEAD     -> fs.last_commit_age_hours
  - ops/board/last-run.json mtime     -> fs.ops_board_last_run_age_hours

Skips a fact when the site's applies_to does not include its family.
Marks 'unknown' when the data source is missing (no .git, no board file).
"""
from __future__ import annotations

import logging
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from site_tracker import registry
from site_tracker.collectors.base import emit, emit_unknown

log = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _last_commit_age_hours(repo: Path) -> float | None:
    if not (repo / ".git").exists():
        return None
    try:
        out = subprocess.check_output(
            ["git", "log", "-1", "--format=%cI"],
            cwd=repo, stderr=subprocess.DEVNULL, text=True,
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    if not out:
        return None
    ts = datetime.fromisoformat(out)
    return (_now() - ts).total_seconds() / 3600


def _ops_board_age_hours(repo: Path) -> float | None:
    f = repo / "ops" / "board" / "last-run.json"
    if not f.exists():
        return None
    mtime = datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc)
    return (_now() - mtime).total_seconds() / 3600


def run(reg: registry.Registry, conn: sqlite3.Connection) -> None:
    domains_root = Path(reg.config["domains_root"])
    for site_name, site_cfg in reg.sites.items():
        applies = site_cfg.get("applies_to", [])
        repo = domains_root / "sites" / site_name

        if "git" in applies:
            age = _last_commit_age_hours(repo)
            if age is None:
                emit_unknown(conn, site_name, site_cfg, "fs.last_commit_age_hours")
            else:
                emit(conn, site_name, site_cfg, "fs.last_commit_age_hours", round(age, 2))

        if "ops" in applies:
            age = _ops_board_age_hours(repo)
            if age is None:
                emit_unknown(conn, site_name, site_cfg, "fs.ops_board_last_run_age_hours")
            else:
                emit(conn, site_name, site_cfg, "fs.ops_board_last_run_age_hours", round(age, 2))
