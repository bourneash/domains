"""Tests for amz_stats.taskfiler — consecutive-miss tracking and task filing."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from amz_stats import taskfiler


def _init_repo(root: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
    (root / "README.md").write_text("x")
    subprocess.run(["git", "add", "README.md"], cwd=root, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=root, check=True)


def _make_site(domains_root: Path, site: str, id_asin_pairs: list[tuple[str, str]]) -> Path:
    site_root = domains_root / "sites" / site
    lib_dir = site_root / "site" / "src" / "lib"
    lib_dir.mkdir(parents=True)
    body = "\n".join(
        f"  {{\n    id: '{pid}',\n    name: 'Thing',\n    asin: '{asin}',\n  }},"
        for pid, asin in id_asin_pairs
    )
    (lib_dir / "affiliate.ts").write_text(f"export const PRODUCTS = [\n{body}\n];\n")
    (site_root / "ops" / "tasks" / "backlog").mkdir(parents=True)
    _init_repo(site_root)
    return site_root


class TestBuildIdAsinMap:
    def test_extracts_pairs(self, tmp_path: Path):
        domains_root = tmp_path
        _make_site(domains_root, "example.com", [("widget-a", "B000000001"), ("widget-b", "B000000002")])
        result = taskfiler.build_id_asin_map(domains_root)
        assert result["example.com"] == {"B000000001": "widget-a", "B000000002": "widget-b"}


class TestProcess:
    def test_no_task_below_threshold(self, tmp_path: Path):
        domains_root = tmp_path
        _make_site(domains_root, "example.com", [("widget-a", "B000000001")])
        asins_by_site = {"example.com": ["B000000001"]}
        catalog = {"asins": {}, "errors": []}  # missing this run — only 1st occurrence
        state_path = tmp_path / "state.json"

        filed = taskfiler.process(domains_root, asins_by_site, catalog, "2026-01-01", state_path, push=False)

        assert filed == []
        backlog = domains_root / "sites" / "example.com" / "ops" / "tasks" / "backlog"
        assert list(backlog.glob("*.md")) == []

    def test_files_task_on_threshold(self, tmp_path: Path):
        domains_root = tmp_path
        _make_site(domains_root, "example.com", [("widget-a", "B000000001")])
        asins_by_site = {"example.com": ["B000000001"]}
        catalog = {"asins": {}, "errors": []}
        state_path = tmp_path / "state.json"

        taskfiler.process(domains_root, asins_by_site, catalog, "2026-01-01", state_path, push=False)
        filed = taskfiler.process(
            domains_root, asins_by_site, catalog, "2026-01-02", state_path, push=False,
            http_confirm=lambda asin: True,
        )

        assert filed == ["example.com:widget-a (B000000001)"]
        backlog = domains_root / "sites" / "example.com" / "ops" / "tasks" / "backlog"
        files = list(backlog.glob("*widget-a*"))
        assert len(files) == 1
        assert "B000000001" in files[0].read_text()

    def test_does_not_refile_same_asin(self, tmp_path: Path):
        domains_root = tmp_path
        _make_site(domains_root, "example.com", [("widget-a", "B000000001")])
        asins_by_site = {"example.com": ["B000000001"]}
        catalog = {"asins": {}, "errors": []}
        state_path = tmp_path / "state.json"

        stub = lambda asin: True
        taskfiler.process(domains_root, asins_by_site, catalog, "2026-01-01", state_path, push=False, http_confirm=stub)
        taskfiler.process(domains_root, asins_by_site, catalog, "2026-01-02", state_path, push=False, http_confirm=stub)
        filed_again = taskfiler.process(
            domains_root, asins_by_site, catalog, "2026-01-03", state_path, push=False, http_confirm=stub
        )

        assert filed_again == []
        backlog = domains_root / "sites" / "example.com" / "ops" / "tasks" / "backlog"
        assert len(list(backlog.glob("*widget-a*"))) == 1

    def test_recovery_resets_streak(self, tmp_path: Path):
        domains_root = tmp_path
        _make_site(domains_root, "example.com", [("widget-a", "B000000001")])
        asins_by_site = {"example.com": ["B000000001"]}
        state_path = tmp_path / "state.json"

        missing_catalog = {"asins": {}, "errors": []}
        found_catalog = {"asins": {"B000000001": {"availability": "IN_STOCK"}}, "errors": []}

        taskfiler.process(domains_root, asins_by_site, missing_catalog, "2026-01-01", state_path, push=False)
        # Recovers before hitting the threshold
        taskfiler.process(domains_root, asins_by_site, found_catalog, "2026-01-02", state_path, push=False)
        filed = taskfiler.process(domains_root, asins_by_site, missing_catalog, "2026-01-03", state_path, push=False)

        # Streak reset, so this is only the 1st consecutive miss again — no task yet.
        assert filed == []

    def test_batch_error_does_not_count_as_missing(self, tmp_path: Path):
        domains_root = tmp_path
        _make_site(domains_root, "example.com", [("widget-a", "B000000001")])
        asins_by_site = {"example.com": ["B000000001"]}
        state_path = tmp_path / "state.json"

        rate_limited = {"asins": {}, "errors": ["B000000001"]}  # transient batch failure

        taskfiler.process(domains_root, asins_by_site, rate_limited, "2026-01-01", state_path, push=False)
        filed = taskfiler.process(domains_root, asins_by_site, rate_limited, "2026-01-02", state_path, push=False)

        assert filed == []  # errors never accumulate toward the missing streak

    def test_skips_asin_already_covered_by_existing_task(self, tmp_path: Path):
        domains_root = tmp_path
        site_root = _make_site(domains_root, "example.com", [("widget-a", "B000000001")])
        existing = site_root / "ops" / "tasks" / "backlog" / "2025-12-01-manual.md"
        existing.write_text("Dead ASIN B000000001 already filed by a human.\n")
        asins_by_site = {"example.com": ["B000000001"]}
        catalog = {"asins": {}, "errors": []}
        state_path = tmp_path / "state.json"

        stub = lambda asin: True
        taskfiler.process(domains_root, asins_by_site, catalog, "2026-01-01", state_path, push=False, http_confirm=stub)
        filed = taskfiler.process(
            domains_root, asins_by_site, catalog, "2026-01-02", state_path, push=False, http_confirm=stub
        )

        assert filed == []
        backlog = site_root / "ops" / "tasks" / "backlog"
        assert len(list(backlog.glob("*.md"))) == 1  # only the pre-existing one

    def test_no_task_when_id_unmappable(self, tmp_path: Path):
        domains_root = tmp_path
        site_root = _make_site(domains_root, "example.com", [])
        (site_root / "ops" / "tasks" / "backlog" / ".gitkeep").write_text("")
        asins_by_site = {"example.com": ["B000000001"]}  # not in affiliate.ts's id map
        catalog = {"asins": {}, "errors": []}
        state_path = tmp_path / "state.json"

        taskfiler.process(domains_root, asins_by_site, catalog, "2026-01-01", state_path, push=False)
        filed = taskfiler.process(domains_root, asins_by_site, catalog, "2026-01-02", state_path, push=False)

        assert filed == []

    def test_commits_task_file(self, tmp_path: Path):
        domains_root = tmp_path
        site_root = _make_site(domains_root, "example.com", [("widget-a", "B000000001")])
        asins_by_site = {"example.com": ["B000000001"]}
        catalog = {"asins": {}, "errors": []}
        state_path = tmp_path / "state.json"

        stub = lambda asin: True
        taskfiler.process(domains_root, asins_by_site, catalog, "2026-01-01", state_path, push=False, http_confirm=stub)
        taskfiler.process(domains_root, asins_by_site, catalog, "2026-01-02", state_path, push=False, http_confirm=stub)

        log = subprocess.run(
            ["git", "log", "--oneline"], cwd=site_root, check=True, capture_output=True, text=True
        ).stdout
        assert "widget-a" in log
        status = subprocess.run(
            ["git", "status", "--short", "ops/"], cwd=site_root, check=True, capture_output=True, text=True
        ).stdout
        assert status.strip() == ""  # the task file itself is committed

    def test_http_confirms_alive_resets_streak_no_task(self, tmp_path: Path):
        """PA-API says missing, but a direct fetch shows a live product page —
        don't file, and reset the streak (this is the persistent-omission case)."""
        domains_root = tmp_path
        _make_site(domains_root, "example.com", [("widget-a", "B000000001")])
        asins_by_site = {"example.com": ["B000000001"]}
        catalog = {"asins": {}, "errors": []}
        state_path = tmp_path / "state.json"
        stub = lambda asin: False  # confirmed alive

        taskfiler.process(domains_root, asins_by_site, catalog, "2026-01-01", state_path, push=False, http_confirm=stub)
        filed = taskfiler.process(
            domains_root, asins_by_site, catalog, "2026-01-02", state_path, push=False, http_confirm=stub
        )

        assert filed == []
        backlog = domains_root / "sites" / "example.com" / "ops" / "tasks" / "backlog"
        assert list(backlog.glob("*.md")) == []
        state = taskfiler.load_state(state_path)
        assert state["example.com:B000000001"]["consecutive_missing"] == 0

    def test_http_inconclusive_does_not_file_or_reset(self, tmp_path: Path):
        """Bot wall / network error — don't guess either way; retry next run."""
        domains_root = tmp_path
        _make_site(domains_root, "example.com", [("widget-a", "B000000001")])
        asins_by_site = {"example.com": ["B000000001"]}
        catalog = {"asins": {}, "errors": []}
        state_path = tmp_path / "state.json"
        stub = lambda asin: None  # inconclusive

        taskfiler.process(domains_root, asins_by_site, catalog, "2026-01-01", state_path, push=False, http_confirm=stub)
        filed = taskfiler.process(
            domains_root, asins_by_site, catalog, "2026-01-02", state_path, push=False, http_confirm=stub
        )
        assert filed == []
        state = taskfiler.load_state(state_path)
        # Streak preserved (not reset, not marked filed) so it keeps retrying.
        assert state["example.com:B000000001"]["consecutive_missing"] == 2
        assert state["example.com:B000000001"]["task_filed"] is False

        # A third consecutive miss that still can't confirm keeps not filing —
        # never falls back to filing blind just because the streak grows.
        filed3 = taskfiler.process(
            domains_root, asins_by_site, catalog, "2026-01-03", state_path, push=False, http_confirm=stub
        )
        assert filed3 == []
