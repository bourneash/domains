"""Tests for collectors.filesystem."""
from __future__ import annotations

import json
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import pytest

from site_tracker import registry, store
from site_tracker.collectors import filesystem as fs_collector


@pytest.fixture
def domains_root(tmp_path: Path) -> Path:
    """A minimal /work-style layout with two site repos."""
    root = tmp_path / "domains"
    for site in ("alpha.test", "beta.test"):
        d = root / "sites" / site
        d.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=d, check=True)
        subprocess.run(["git", "config", "user.email", "t@t"], cwd=d, check=True)
        subprocess.run(["git", "config", "user.name", "t"], cwd=d, check=True)
        (d / "README.md").write_text("x\n")
        subprocess.run(["git", "add", "."], cwd=d, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=d, check=True)
    return root


@pytest.fixture
def reg(domains_root: Path) -> registry.Registry:
    return registry.Registry(
        config={"domains_root": str(domains_root)},
        sites={
            "alpha.test": {"active": True, "applies_to": ["git", "ops"]},
            "beta.test":  {"active": True, "applies_to": ["git", "ops"]},
        },
    )


def test_collects_last_commit_age(db, reg, domains_root):
    # The fixture commits at real wall-clock time. Patch _now to a known
    # offset after that real time so the age computation is deterministic
    # regardless of when the test runs.
    future = datetime.now(timezone.utc) + timedelta(hours=1)
    with mock.patch.object(fs_collector, "_now", return_value=future):
        fs_collector.run(reg, db)
    row = store.get_site_facts(db, "alpha.test")
    assert "fs.last_commit_age_hours" in row
    assert row["fs.last_commit_age_hours"]["state"] == "green"
    assert row["fs.last_commit_age_hours"]["source"] == "filesystem"
    value = row["fs.last_commit_age_hours"]["value"]
    assert isinstance(value, (int, float))
    assert 0.5 < value < 1.5   # 1h ± rounding


def test_collects_ops_board_last_run(db, reg, domains_root):
    board = domains_root / "sites" / "beta.test" / "ops" / "board"
    board.mkdir(parents=True, exist_ok=True)
    (board / "last-run.json").write_text(json.dumps({"role": "x", "exit": 0}))
    future = datetime.now(timezone.utc) + timedelta(hours=2)
    with mock.patch.object(fs_collector, "_now", return_value=future):
        fs_collector.run(reg, db)
    facts = store.get_site_facts(db, "beta.test")
    assert "fs.ops_board_last_run_age_hours" in facts
    assert facts["fs.ops_board_last_run_age_hours"]["state"] == "green"
    value = facts["fs.ops_board_last_run_age_hours"]["value"]
    assert isinstance(value, (int, float))
    assert 1.5 < value < 2.5   # 2h ± rounding


def test_missing_repo_marks_unknown(db, reg, domains_root):
    # nuke alpha.test's .git
    import shutil
    shutil.rmtree(domains_root / "sites" / "alpha.test" / ".git")
    fs_collector.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["fs.last_commit_age_hours"]["state"] == "unknown"


def test_skips_sites_without_git_family(db, domains_root):
    reg_no_git = registry.Registry(
        config={"domains_root": str(domains_root)},
        sites={"alpha.test": {"active": True, "applies_to": ["cf"]}},
    )
    fs_collector.run(reg_no_git, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert "fs.last_commit_age_hours" not in facts
