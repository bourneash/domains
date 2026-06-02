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


@respx.mock
def test_collect_repo_falls_back_to_default_branch(gh):
    """When 'main' is absent but the default branch has commits, the fallback
    returns the default branch's last commit (not None)."""
    slug = "bourneash/y"
    respx.get(f"{BASE}/repos/{slug}").mock(return_value=httpx.Response(
        200, json={"default_branch": "master", "visibility": "private"}))
    respx.get(f"{BASE}/repos/{slug}/branches").mock(return_value=httpx.Response(
        200, json=[{"name": "master"}]))
    # First /commits call (sha=main) 404s; the fallback (sha=master) succeeds.
    respx.get(f"{BASE}/repos/{slug}/commits").mock(side_effect=[
        httpx.Response(404, json={"message": "No commit found for main"}),
        httpx.Response(200, json=[{"sha": "deadbee1234", "commit": {
            "committer": {"date": "2026-05-01T00:00:00Z"},
            "message": "initial"}}]),
    ])
    respx.get(f"{BASE}/repos/{slug}/pulls").mock(return_value=httpx.Response(
        200, json=[]))
    out = C.collect_repo(gh, "y.com", slug)
    assert out["ok"] is True
    assert out["last_main_commit"]["sha"] == "deadbee"
    assert out["last_main_commit"]["message"] == "initial"


@respx.mock
def test_collect_repo_empty_commit_message(gh):
    """An empty commit message must not crash; it degrades to an empty string
    while still returning the commit (regression for splitlines()[0])."""
    slug = "bourneash/z"
    respx.get(f"{BASE}/repos/{slug}").mock(return_value=httpx.Response(
        200, json={"default_branch": "main", "visibility": "private"}))
    respx.get(f"{BASE}/repos/{slug}/branches").mock(return_value=httpx.Response(
        200, json=[{"name": "main"}]))
    respx.get(f"{BASE}/repos/{slug}/commits").mock(return_value=httpx.Response(
        200, json=[{"sha": "abc1234def", "commit": {
            "committer": {"date": "2026-05-02T00:00:00Z"}, "message": ""}}]))
    respx.get(f"{BASE}/repos/{slug}/pulls").mock(return_value=httpx.Response(
        200, json=[]))
    out = C.collect_repo(gh, "z.com", slug)
    assert out["ok"] is True
    assert out["last_main_commit"]["sha"] == "abc1234"
    assert out["last_main_commit"]["message"] == ""
