"""Tests for gh-stats collectors."""
from __future__ import annotations

import httpx
import respx

from gh_stats import collectors as C

BASE = "https://api.github.com"


@respx.mock
def test_collect_repo_happy_path(gh):
    slug = "bourneash/aliencouncil"
    respx.get(f"{BASE}/repos/{slug}").mock(return_value=httpx.Response(
        200, json={"default_branch": "main", "visibility": "private"}))
    respx.get(f"{BASE}/repos/{slug}/branches").mock(return_value=httpx.Response(
        200, json=[{"name": "main"}, {"name": "chore/x"}]))
    respx.get(f"{BASE}/repos/{slug}/commits").mock(return_value=httpx.Response(
        200, json=[{"sha": "b56fe5b1234", "commit": {
            "committer": {"date": "2026-05-22T12:36:51Z"},
            "message": "ops: declare config"}}]))
    respx.get(f"{BASE}/repos/{slug}/pulls").mock(return_value=httpx.Response(
        200, json=[{"number": 2, "title": "migrate astro6",
                    "head": {"ref": "chore/x"}, "merged_at": None}]))
    out = C.collect_repo(gh, "aliencouncil.com", slug)
    assert out["ok"] is True
    assert out["slug"] == slug
    assert out["default_branch"] == "main"
    assert out["branch_count"] == 2
    assert out["last_main_commit"]["sha"] == "b56fe5b"
    assert out["last_main_commit"]["message"] == "ops: declare config"
    assert out["open_pr_count"] == 1
    assert out["open_prs"][0]["head"] == "chore/x"


@respx.mock
def test_collect_repo_404_degrades(gh):
    slug = "bourneash/missing"
    respx.get(f"{BASE}/repos/{slug}").mock(return_value=httpx.Response(404,
        json={"message": "Not Found"}))
    out = C.collect_repo(gh, "missing.com", slug)
    assert out["ok"] is False
    assert "404" in out["error"]


@respx.mock
def test_collect_repo_empty_branch_for_missing_main(gh):
    """A repo with no 'main' (commits 404) still returns ok with null commit."""
    slug = "bourneash/x"
    respx.get(f"{BASE}/repos/{slug}").mock(return_value=httpx.Response(
        200, json={"default_branch": "master", "visibility": "private"}))
    respx.get(f"{BASE}/repos/{slug}/branches").mock(return_value=httpx.Response(
        200, json=[{"name": "master"}]))
    respx.get(f"{BASE}/repos/{slug}/commits").mock(return_value=httpx.Response(
        409, json={"message": "Git Repository is empty."}))
    respx.get(f"{BASE}/repos/{slug}/pulls").mock(return_value=httpx.Response(
        200, json=[]))
    out = C.collect_repo(gh, "x.com", slug)
    assert out["ok"] is True
    assert out["last_main_commit"] is None
    assert out["open_pr_count"] == 0
