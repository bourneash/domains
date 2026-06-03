# Developer Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Grafana "Developer" dashboard showing, per site, a last-deployment log, GitHub state (branches, last commit to `main`, open PRs), and a commit→deploy DRIFT flag.

**Architecture:** Reuse the existing cf-stats → cf-grafana pattern. Extend cf-stats with a deployments collector; add a sibling `gh-stats` tool that mirrors cf-stats and reads `tools/site-tracker/sites.yml` for the domain→repo map; extend `cf-grafana/ingest.py` with new SQLite tables; add a provisioned `developer.json` dashboard. No new runtime stack; Grafana stays at `:4741`.

**Tech Stack:** Python 3.12, httpx, click, python-dotenv (collectors); pytest + respx + freezegun (tests); SQLite + frser-sqlite-datasource + Grafana 10.4 (dashboard); Docker Compose + supercronic (scheduling).

---

## Verified facts (do not re-discover)

- **CF deployments API:** `GET /accounts/{acct}/workers/scripts/{name}/deployments` returns
  `{"result": {"deployments": [{created_on, source, author_email, annotations: {"workers/triggered_by": ...}, versions: [{version_id, percentage}]}]}, "success": true}`.
  Confirmed against worker `aliencouncil`. All current deploys show `source: "wrangler"`.
- **Worker names drift** from domain (`aliencouncil.com` → worker `aliencouncil`; `xxxtea.com` → `xxxtea-com`). The mapping is already in cf-stats `latest.json` under `worker_domains.domains[].{zone_name, service}`. Use that; never hardcode.
- **GitHub repo slugs** are in `tools/site-tracker/sites.yml` under `sites.<domain>.github` (e.g. `bourneash/aliencouncil`, `bourneash/xxxtea.com`). `GITHUB_TOKEN` is in `/home/jesse/projects/domains/.env` with `repo` scope.
- **cf-stats has no test dir yet.** This plan adds `[project.optional-dependencies].dev` and a `tests/` dir to it (Task 1), matching site-tracker's respx+freezegun style.
- **CFClient** (`tools/cf-stats/src/cf_stats/api.py`) already has `.get(path)`, `.paginate()`, `.account_id`, and raises `CFError(status, message)`. Collectors return `{"ok": bool, ...}` and never raise (see `_err()` in collectors.py).
- **Grafana provisioning** auto-loads any `*.json` in `cf-grafana/grafana/dashboards/` (file provider, 30s interval). Datasource uid is `cf-stats`, type `frser-sqlite-datasource`.

---

## File structure

**Modify:**
- `tools/cf-stats/src/cf_stats/collectors.py` — add `collect_deployments()`
- `tools/cf-stats/src/cf_stats/cli.py` — wire `deployments` into snapshot
- `tools/cf-stats/pyproject.toml` — add `dev` optional-deps
- `tools/cf-grafana/ingest.py` — new tables: `deployments`, `zone_worker`, `gh_repos`, `gh_prs`
- `tools/cf-grafana/docker-compose.yml` — bind-mount gh-stats `out/`

**Create (cf-stats tests):**
- `tools/cf-stats/tests/__init__.py`
- `tools/cf-stats/tests/conftest.py`
- `tools/cf-stats/tests/test_collect_deployments.py`

**Create (gh-stats tool):**
- `tools/gh-stats/pyproject.toml`
- `tools/gh-stats/src/gh_stats/__init__.py`
- `tools/gh-stats/src/gh_stats/api.py`
- `tools/gh-stats/src/gh_stats/registry.py`
- `tools/gh-stats/src/gh_stats/collectors.py`
- `tools/gh-stats/src/gh_stats/cli.py`
- `tools/gh-stats/tests/__init__.py`
- `tools/gh-stats/tests/conftest.py`
- `tools/gh-stats/tests/test_collectors.py`
- `tools/gh-stats/Dockerfile`
- `tools/gh-stats/docker-compose.yml`
- `tools/gh-stats/entrypoint.sh`
- `tools/gh-stats/crontab.docker`
- `tools/gh-stats/.gitignore`
- `tools/gh-stats/.dockerignore`
- `tools/gh-stats/README.md`

**Create (dashboard):**
- `tools/cf-grafana/grafana/dashboards/developer.json`

---

## Task 1: cf-stats — deployments collector

**Files:**
- Modify: `tools/cf-stats/pyproject.toml`
- Create: `tools/cf-stats/tests/__init__.py`, `tools/cf-stats/tests/conftest.py`, `tools/cf-stats/tests/test_collect_deployments.py`
- Modify: `tools/cf-stats/src/cf_stats/collectors.py`
- Modify: `tools/cf-stats/src/cf_stats/cli.py`

- [ ] **Step 1: Add dev deps to pyproject**

In `tools/cf-stats/pyproject.toml`, after the `[project.scripts]` block and before `[build-system]`, insert:

```toml
[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "respx>=0.21",
    "freezegun>=1.5",
]
```

- [ ] **Step 2: Create empty test package init**

Create `tools/cf-stats/tests/__init__.py` with no content (empty file).

- [ ] **Step 3: Create conftest with a CFClient factory**

Create `tools/cf-stats/tests/conftest.py`:

```python
"""Shared fixtures for cf-stats tests."""
from __future__ import annotations

import pytest

from cf_stats.api import CFClient


@pytest.fixture
def cf() -> CFClient:
    # account id is arbitrary in tests; respx intercepts all HTTP.
    return CFClient(token="test-token", account_id="acct123")
```

- [ ] **Step 4: Write the failing test**

Create `tools/cf-stats/tests/test_collect_deployments.py`:

```python
"""Tests for collectors.collect_deployments."""
from __future__ import annotations

import httpx
import respx

from cf_stats import collectors as C

BASE = "https://api.cloudflare.com/client/v4"


def _workers(*names: str) -> dict:
    return {"ok": True, "count": len(names),
            "scripts": [{"id": n} for n in names]}


def _dep_payload(created_on: str, source: str, version_id: str) -> dict:
    return {
        "result": {"deployments": [{
            "id": "dep-" + version_id,
            "source": source,
            "author_email": "jessetamburino@hotmail.com",
            "annotations": {"workers/triggered_by": "deployment"},
            "versions": [{"version_id": version_id, "percentage": 100}],
            "created_on": created_on,
        }]},
        "success": True, "errors": [], "messages": [],
    }


@respx.mock
def test_collects_latest_deploy_per_worker(cf):
    respx.get(f"{BASE}/accounts/acct123/workers/scripts/aliencouncil/deployments").mock(
        return_value=httpx.Response(200, json=_dep_payload(
            "2026-05-22T12:37:46Z", "wrangler", "a365"))
    )
    out = C.collect_deployments(cf, {"ok": True, "scripts": [{"id": "aliencouncil"}]})
    assert out["ok"] is True
    rows = out["per_worker"]["aliencouncil"]
    assert rows[0]["source"] == "wrangler"
    assert rows[0]["version_id"] == "a365"
    assert rows[0]["created_on"] == "2026-05-22T12:37:46Z"
    assert rows[0]["triggered_by"] == "deployment"


@respx.mock
def test_one_worker_error_does_not_abort(cf):
    respx.get(f"{BASE}/accounts/acct123/workers/scripts/good/deployments").mock(
        return_value=httpx.Response(200, json=_dep_payload(
            "2026-05-22T12:00:00Z", "wrangler", "v1"))
    )
    respx.get(f"{BASE}/accounts/acct123/workers/scripts/bad/deployments").mock(
        return_value=httpx.Response(404, json={"success": False,
            "errors": [{"message": "not found"}]})
    )
    workers = {"ok": True, "scripts": [{"id": "good"}, {"id": "bad"}]}
    out = C.collect_deployments(cf, workers)
    assert out["ok"] is True
    assert "good" in out["per_worker"]
    assert "bad" in out["errors"]
    assert "bad" not in out["per_worker"]


def test_skips_when_workers_unavailable(cf):
    out = C.collect_deployments(cf, {"ok": False})
    assert out["ok"] is False
```

- [ ] **Step 5: Install dev deps and run test to verify it fails**

Run:
```bash
cd /home/jesse/projects/domains/tools/cf-stats
python3 -m venv .venv 2>/dev/null; .venv/bin/pip install -q -e '.[dev]'
.venv/bin/pytest tests/test_collect_deployments.py -q
```
Expected: FAIL — `AttributeError: module 'cf_stats.collectors' has no attribute 'collect_deployments'`.

- [ ] **Step 6: Implement collect_deployments**

In `tools/cf-stats/src/cf_stats/collectors.py`, add this function at the end of the file (it uses the existing `_err` helper and `CFClient.get`):

```python
def collect_deployments(cf: CFClient, workers: dict, limit: int = 5) -> dict:
    """Latest deployments per worker script. Best-effort: a worker that errors
    records its error string and never aborts the snapshot."""
    if not workers.get("ok"):
        return {"ok": False, "error": "workers unavailable"}
    per_worker: dict[str, list] = {}
    errors: dict[str, str] = {}
    for s in workers.get("scripts") or []:
        name = s.get("id")
        if not name:
            continue
        try:
            body = cf.get(
                f"/accounts/{cf.account_id}/workers/scripts/{name}/deployments"
            )
            result = body.get("result") or {}
            deps = result.get("deployments") if isinstance(result, dict) else result
            rows = []
            for d in (deps or [])[:limit]:
                versions = d.get("versions") or []
                rows.append({
                    "created_on": d.get("created_on"),
                    "source": d.get("source"),
                    "version_id": versions[0].get("version_id") if versions else None,
                    "triggered_by": (d.get("annotations") or {}).get("workers/triggered_by"),
                    "author": d.get("author_email"),
                })
            per_worker[name] = rows
        except Exception as e:
            errors[name] = str(e)
    return {"ok": True, "limit": limit, "per_worker": per_worker, "errors": errors}
```

- [ ] **Step 7: Run test to verify it passes**

Run:
```bash
cd /home/jesse/projects/domains/tools/cf-stats
.venv/bin/pytest tests/test_collect_deployments.py -q
```
Expected: PASS (3 passed).

- [ ] **Step 8: Wire deployments into the snapshot**

In `tools/cf-stats/src/cf_stats/cli.py`, inside `collect()`'s `with CFClient(...) as cf:` block, add a line immediately after the `snap["workers"] = C.collect_workers(cf)` line:

```python
        snap["deployments"] = C.collect_deployments(cf, snap["workers"])
```

- [ ] **Step 9: Add a deploys count to the summary line**

In `tools/cf-stats/src/cf_stats/cli.py`, in `_summary_line()`, after the `f"workers={s('workers', 'count')}",` entry in the `parts` list, add:

```python
        f"deploys={sum(len(v) for v in (snap.get('deployments') or {}).get('per_worker', {}).values())}",
```

- [ ] **Step 10: Smoke the real collector end-to-end**

Run:
```bash
cd /home/jesse/projects/domains/tools/cf-stats
.venv/bin/cf-stats collect --out-dir /tmp/cfsmoke --quiet
python3 -c "import json;d=json.load(open('/tmp/cfsmoke/latest.json'));dp=d['deployments'];print('ok',dp['ok'],'workers',len(dp['per_worker']));import itertools;k=next(iter(dp['per_worker']));print('sample',k,dp['per_worker'][k][:1])"
```
Expected: `ok True workers <N>` and a sample deployment row with `source`, `version_id`, `created_on`.

- [ ] **Step 11: Commit**

```bash
cd /home/jesse/projects/domains
git -C tools/cf-stats add pyproject.toml src/cf_stats/collectors.py src/cf_stats/cli.py tests/
git -C tools/cf-stats commit -m "cf-stats: add deployments collector (per-worker deploy log)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: gh-stats — package scaffold + GitHub API client

**Files:**
- Create: `tools/gh-stats/pyproject.toml`, `tools/gh-stats/.gitignore`, `tools/gh-stats/.dockerignore`
- Create: `tools/gh-stats/src/gh_stats/__init__.py`, `tools/gh-stats/src/gh_stats/api.py`
- Create: `tools/gh-stats/tests/__init__.py`, `tools/gh-stats/tests/conftest.py`, `tools/gh-stats/tests/test_collectors.py`

- [ ] **Step 1: Create pyproject**

Create `tools/gh-stats/pyproject.toml`:

```toml
[project]
name = "gh-stats"
version = "0.1.0"
description = "GitHub per-repo snapshot collector — branches, last main commit, open PRs, for the Developer dashboard"
requires-python = ">=3.10"
dependencies = [
    "httpx>=0.27",
    "click>=8.1",
    "python-dotenv>=1.0",
    "pyyaml>=6.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "respx>=0.21",
    "freezegun>=1.5",
]

[project.scripts]
gh-stats = "gh_stats.cli:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/gh_stats"]
```

- [ ] **Step 2: Create .gitignore and .dockerignore**

Create `tools/gh-stats/.gitignore`:
```
.venv/
__pycache__/
*.egg-info/
out/
.pytest_cache/
```

Create `tools/gh-stats/.dockerignore`:
```
.venv/
__pycache__/
*.egg-info/
out/
.pytest_cache/
tests/
```

- [ ] **Step 3: Create package version**

Create `tools/gh-stats/src/gh_stats/__init__.py`:
```python
__version__ = "0.1.0"
```

- [ ] **Step 4: Create empty tests init**

Create `tools/gh-stats/tests/__init__.py` (empty file).

- [ ] **Step 5: Write the api client**

Create `tools/gh-stats/src/gh_stats/api.py`:

```python
"""Thin GitHub REST client. Returns parsed JSON; raises GHError on non-2xx
so collectors can degrade per-repo without aborting the snapshot."""
from __future__ import annotations

import time
from typing import Any

import httpx

API_BASE = "https://api.github.com"


class GHError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"{status}: {message}")
        self.status = status
        self.message = message


class GHClient:
    def __init__(self, token: str, timeout: float = 15.0):
        headers = {"Accept": "application/vnd.github+json",
                   "X-GitHub-Api-Version": "2022-11-28"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._client = httpx.Client(base_url=API_BASE, headers=headers, timeout=timeout)

    def close(self) -> None:
        self._client.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def get(self, path: str, params: dict | None = None) -> Any:
        retries = 3
        backoff = 1.0
        for attempt in range(retries):
            try:
                r = self._client.get(path, params=params)
            except httpx.HTTPError as e:
                if attempt == retries - 1:
                    raise GHError(0, f"transport: {e}") from e
                time.sleep(backoff * (2 ** attempt))
                continue
            if r.status_code in (429, 502, 503) and attempt < retries - 1:
                time.sleep(backoff * (2 ** attempt))
                continue
            if r.status_code >= 400:
                msg = r.text[:200]
                try:
                    msg = r.json().get("message", msg)
                except Exception:
                    pass
                raise GHError(r.status_code, msg)
            return r.json()
        raise GHError(0, "exhausted retries")
```

- [ ] **Step 6: Create conftest with a GHClient fixture**

Create `tools/gh-stats/tests/conftest.py`:
```python
"""Shared fixtures for gh-stats tests."""
from __future__ import annotations

import pytest

from gh_stats.api import GHClient


@pytest.fixture
def gh() -> GHClient:
    return GHClient(token="test-pat")
```

- [ ] **Step 7: Install and verify the package imports**

Run:
```bash
cd /home/jesse/projects/domains/tools/gh-stats
python3 -m venv .venv; .venv/bin/pip install -q -e '.[dev]'
.venv/bin/python -c "from gh_stats.api import GHClient, GHError; print('import OK')"
```
Expected: `import OK`.

- [ ] **Step 8: Commit**

```bash
cd /home/jesse/projects/domains/tools/gh-stats
git init -q 2>/dev/null || true
git -C /home/jesse/projects/domains add tools/gh-stats/pyproject.toml tools/gh-stats/.gitignore tools/gh-stats/.dockerignore tools/gh-stats/src/gh_stats/__init__.py tools/gh-stats/src/gh_stats/api.py tools/gh-stats/tests/__init__.py tools/gh-stats/tests/conftest.py
git -C /home/jesse/projects/domains commit -m "gh-stats: scaffold package + GitHub REST client

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: gh-stats — registry loader + per-repo collector

**Files:**
- Create: `tools/gh-stats/src/gh_stats/registry.py`, `tools/gh-stats/src/gh_stats/collectors.py`
- Create: `tools/gh-stats/tests/test_collectors.py`

- [ ] **Step 1: Write the registry loader**

Create `tools/gh-stats/src/gh_stats/registry.py`:

```python
"""Load the site→repo map from tools/site-tracker/sites.yml.

We treat site-tracker's sites.yml as the single source of truth for the
domain → GitHub slug mapping (it already encodes the TLD-drift slugs like
bourneash/xxxtea.com vs bourneash/aliencouncil)."""
from __future__ import annotations

from pathlib import Path

import yaml

DEFAULT_PATHS = (
    Path("/work/tools/site-tracker/sites.yml"),
    Path(__file__).resolve().parents[3] / "site-tracker" / "sites.yml",
)


def load_sites(path: Path | None = None) -> dict[str, str]:
    """Return {domain: github_slug} for active sites that declare a repo."""
    if path is None:
        for cand in DEFAULT_PATHS:
            if cand.exists():
                path = cand
                break
    if path is None or not Path(path).exists():
        return {}
    with open(path) as f:
        data = yaml.safe_load(f) or {}
    out: dict[str, str] = {}
    for domain, cfg in (data.get("sites") or {}).items():
        if not cfg.get("active"):
            continue
        slug = cfg.get("github")
        if slug:
            out[domain] = slug
    return out
```

- [ ] **Step 2: Write the failing collector test**

Create `tools/gh-stats/tests/test_collectors.py`:

```python
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
```

- [ ] **Step 3: Run test to verify it fails**

Run:
```bash
cd /home/jesse/projects/domains/tools/gh-stats
.venv/bin/pytest tests/test_collectors.py -q
```
Expected: FAIL — `ModuleNotFoundError: No module named 'gh_stats.collectors'`.

- [ ] **Step 4: Write the collector**

Create `tools/gh-stats/src/gh_stats/collectors.py`:

```python
"""Per-repo GitHub collectors. Each returns a dict with `ok: bool`; on failure
it records the error string and never raises, so one bad repo doesn't kill the
snapshot. Mirrors cf-stats' collector contract."""
from __future__ import annotations

from .api import GHClient, GHError


def _err(e: Exception) -> dict:
    if isinstance(e, GHError):
        return {"ok": False, "status": e.status, "error": f"{e.status}: {e.message}"}
    return {"ok": False, "status": 0, "error": str(e)}


def _last_main_commit(gh: GHClient, slug: str, default_branch: str) -> dict | None:
    """Last commit on the repo's main branch. Returns None if the branch is
    empty/absent (409/404) rather than raising."""
    branch = "main" if default_branch in (None, "") else default_branch
    try:
        commits = gh.get(f"/repos/{slug}/commits", params={"sha": "main", "per_page": 1})
    except GHError as e:
        if e.status in (404, 409, 422):
            # 'main' may not exist; fall back to the default branch once.
            if branch != "main":
                try:
                    commits = gh.get(f"/repos/{slug}/commits",
                                     params={"sha": branch, "per_page": 1})
                except GHError:
                    return None
            else:
                return None
        else:
            raise
    if not commits:
        return None
    c = commits[0]
    return {
        "sha": (c.get("sha") or "")[:7],
        "date": ((c.get("commit") or {}).get("committer") or {}).get("date"),
        "message": ((c.get("commit") or {}).get("message") or "").splitlines()[0][:120],
    }


def collect_repo(gh: GHClient, domain: str, slug: str) -> dict:
    """Snapshot one repo: default branch, branches, last main commit, open PRs."""
    try:
        meta = gh.get(f"/repos/{slug}")
    except Exception as e:
        return {**_err(e), "slug": slug}

    default_branch = meta.get("default_branch")
    try:
        branches = [b.get("name") for b in gh.get(
            f"/repos/{slug}/branches", params={"per_page": 100}) if b.get("name")]
    except Exception:
        branches = []

    try:
        last_commit = _last_main_commit(gh, slug, default_branch)
    except Exception:
        last_commit = None

    try:
        pulls = gh.get(f"/repos/{slug}/pulls",
                       params={"state": "open", "per_page": 50})
        open_prs = [{"number": p.get("number"), "title": (p.get("title") or "")[:120],
                     "head": (p.get("head") or {}).get("ref")} for p in pulls]
    except Exception:
        open_prs = []

    return {
        "ok": True,
        "slug": slug,
        "default_branch": default_branch,
        "visibility": meta.get("visibility"),
        "branches": branches,
        "branch_count": len(branches),
        "last_main_commit": last_commit,
        "open_prs": open_prs,
        "open_pr_count": len(open_prs),
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
cd /home/jesse/projects/domains/tools/gh-stats
.venv/bin/pytest tests/test_collectors.py -q
```
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git -C /home/jesse/projects/domains add tools/gh-stats/src/gh_stats/registry.py tools/gh-stats/src/gh_stats/collectors.py tools/gh-stats/tests/test_collectors.py
git -C /home/jesse/projects/domains commit -m "gh-stats: registry loader + per-repo collector

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: gh-stats — CLI snapshot

**Files:**
- Create: `tools/gh-stats/src/gh_stats/cli.py`

- [ ] **Step 1: Write the CLI**

Create `tools/gh-stats/src/gh_stats/cli.py`:

```python
"""gh-stats CLI: snapshot every active repo from site-tracker's sites.yml,
append JSONL + refresh latest.json. Mirrors cf-stats' CLI shape."""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import click
from dotenv import load_dotenv

from . import __version__
from .api import GHClient
from . import collectors as C
from . import registry


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _load_env(env_file: Path | None) -> str:
    if env_file:
        load_dotenv(env_file, override=False)
    else:
        for cand in (Path.cwd() / ".env",
                     Path("/work/.env.shared"),
                     Path("/home/jesse/projects/domains/.env")):
            if cand.exists():
                load_dotenv(cand, override=False)
                break
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        click.echo("ERROR: GITHUB_TOKEN (or GH_TOKEN) required", err=True)
        sys.exit(2)
    return token


def _summary_line(snap: dict) -> str:
    repos = snap.get("repos") or {}
    ok = sum(1 for r in repos.values() if r.get("ok"))
    prs = sum(r.get("open_pr_count", 0) for r in repos.values() if r.get("ok"))
    return (f"[{snap['timestamp']}] gh-stats repos={len(repos)} ok={ok} "
            f"open_prs={prs} {snap['duration_seconds']}s")


@click.group()
@click.version_option(__version__)
def main() -> None:
    """GitHub per-repo snapshot collector."""


@main.command()
@click.option("--out-dir", "out_dir", type=click.Path(path_type=Path), default=Path("out"))
@click.option("--env-file", type=click.Path(exists=True, path_type=Path), default=None)
@click.option("--sites-file", type=click.Path(path_type=Path), default=None,
              help="Override path to site-tracker sites.yml.")
@click.option("--quiet", is_flag=True)
def collect(out_dir: Path, env_file: Path | None, sites_file: Path | None, quiet: bool) -> None:
    """Snapshot all active repos, write JSONL + latest.json, print summary."""
    token = _load_env(env_file)
    out_dir.mkdir(parents=True, exist_ok=True)

    started = time.monotonic()
    ts = _now_iso()
    sites = registry.load_sites(sites_file)
    snap: dict = {"timestamp": ts, "version": __version__, "repos": {}}
    if not sites:
        snap["note"] = "no sites.yml found or no active repos"

    with GHClient(token) as gh:
        for domain, slug in sites.items():
            snap["repos"][domain] = C.collect_repo(gh, domain, slug)

    snap["duration_seconds"] = round(time.monotonic() - started, 2)

    day = ts[:10]
    with (out_dir / f"gh-stats-{day}.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(snap, separators=(",", ":")) + "\n")
    (out_dir / "latest.json").write_text(json.dumps(snap, indent=2) + "\n", encoding="utf-8")

    if not quiet:
        click.echo(_summary_line(snap))


@main.command()
@click.option("--env-file", type=click.Path(exists=True, path_type=Path), default=None)
def verify(env_file: Path | None) -> None:
    """Verify the token works (GET /user). Exit 0 on success."""
    token = _load_env(env_file)
    with GHClient(token) as gh:
        try:
            who = gh.get("/user")
        except Exception as e:
            click.echo(f"FAIL: {e}", err=True)
            sys.exit(1)
    click.echo(f"OK login={who.get('login')}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Reinstall (new entry point) and verify token**

Run:
```bash
cd /home/jesse/projects/domains/tools/gh-stats
.venv/bin/pip install -q -e '.[dev]'
.venv/bin/gh-stats verify --env-file /home/jesse/projects/domains/.env
```
Expected: `OK login=bourneash`.

- [ ] **Step 3: Smoke a real snapshot against the real account**

Run:
```bash
cd /home/jesse/projects/domains/tools/gh-stats
.venv/bin/gh-stats collect --out-dir /tmp/ghsmoke --env-file /home/jesse/projects/domains/.env
python3 -c "import json;d=json.load(open('/tmp/ghsmoke/latest.json'));r=d['repos']['aliencouncil.com'];print('ok',r['ok'],'branches',r['branch_count'],'prs',r['open_pr_count'],'last',r['last_main_commit'] and r['last_main_commit']['sha'])"
```
Expected: `ok True branches 3 prs 2 last <sha>` (values may differ as repos evolve; key is `ok True` and non-error fields).

- [ ] **Step 4: Run the full test suite**

Run:
```bash
cd /home/jesse/projects/domains/tools/gh-stats
.venv/bin/pytest -q
```
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git -C /home/jesse/projects/domains add tools/gh-stats/src/gh_stats/cli.py
git -C /home/jesse/projects/domains commit -m "gh-stats: CLI snapshot (collect + verify)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: gh-stats — Docker packaging (hourly supercronic)

**Files:**
- Create: `tools/gh-stats/Dockerfile`, `tools/gh-stats/docker-compose.yml`, `tools/gh-stats/entrypoint.sh`, `tools/gh-stats/crontab.docker`, `tools/gh-stats/README.md`

- [ ] **Step 1: Create the Dockerfile**

Create `tools/gh-stats/Dockerfile` (mirrors cf-stats, adds a read-only mount of site-tracker for sites.yml at runtime — see compose):

```dockerfile
# gh-stats collector — long-running supercronic container.
# Mirrors tools/cf-stats/Dockerfile: supercronic + non-root UID 1000,
# package installed into the image, hourly `gh-stats collect`.

FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /usr/local/bin/supercronic \
       https://github.com/aptible/supercronic/releases/download/v0.2.34/supercronic-linux-amd64 \
    && chmod +x /usr/local/bin/supercronic

ENV TZ=UTC \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN groupadd -g 1000 ops && \
    useradd -u 1000 -g ops -m -s /bin/sh ops

WORKDIR /opt/gh-stats
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

COPY crontab.docker /etc/crontab.docker
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER ops
WORKDIR /work

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

- [ ] **Step 2: Create the entrypoint**

Create `tools/gh-stats/entrypoint.sh`:

```sh
#!/bin/sh
# gh-stats container entrypoint. Mirrors cf-stats/entrypoint.sh.
# 1. Source /work/.env.shared for GITHUB_TOKEN.
# 2. Ensure /work/out exists.
# 3. Exec supercronic (absolute path required — see cf-stats entrypoint note).
set -e

echo "[$(date -Iseconds)] gh-stats container starting"

ENV_SHARED="/work/.env.shared"
if [ -f "$ENV_SHARED" ]; then
  set -a; . "$ENV_SHARED"; set +a
  echo "[$(date -Iseconds)] loaded .env.shared"
else
  echo "[$(date -Iseconds)] WARNING: $ENV_SHARED missing — GitHub API calls will fail"
fi

mkdir -p /work/out

gh-stats verify || echo "[$(date -Iseconds)] WARNING: token verify failed"

exec /usr/local/bin/supercronic -passthrough-logs /etc/crontab.docker
```

- [ ] **Step 3: Create the crontab**

Create `tools/gh-stats/crontab.docker`:

```
# gh-stats schedule (supercronic, TZ=UTC).
# Hourly at :37 — offset from cf-stats (:23) so they don't bunch up.
# The collect command reads sites.yml from the bind-mounted site-tracker dir.

37 * * * * gh-stats collect --out-dir /work/out --sites-file /work/tools/site-tracker/sites.yml 2>&1 | tee -a /work/out/cron.log
```

- [ ] **Step 4: Create the compose file**

Create `tools/gh-stats/docker-compose.yml` (bind-mounts the shared `.env` and the parent domains repo so `sites.yml` is readable at `/work/tools/site-tracker/sites.yml`):

```yaml
# gh-stats — GitHub per-repo snapshot collector, containerized.
# Mirrors tools/cf-stats/docker-compose.yml.
#
# Bring up:    docker compose up -d
# Watch logs:  docker compose logs -f
# Force run:   docker compose exec collector gh-stats collect --out-dir /work/out --sites-file /work/tools/site-tracker/sites.yml
# Stop:        docker compose down

name: gh-stats

services:
  collector:
    build:
      context: .
      dockerfile: Dockerfile
    image: gh-stats:latest
    container_name: gh-stats
    restart: unless-stopped
    environment:
      TZ: UTC
    volumes:
      - ${HOME:-/home/jesse}/projects/domains/.env:/work/.env.shared:ro
      # Read sites.yml (domain→repo map) from the live site-tracker config.
      - ${HOME:-/home/jesse}/projects/domains/tools/site-tracker/sites.yml:/work/tools/site-tracker/sites.yml:ro
      # Snapshot output — read by cf-grafana's ingest.
      - ./out:/work/out
```

- [ ] **Step 5: Create the README**

Create `tools/gh-stats/README.md`:

```markdown
# gh-stats

Hourly per-repo GitHub snapshot collector for the **Developer** Grafana
dashboard. Sibling to `tools/cf-stats`. Reads the domain→repo map from
`tools/site-tracker/sites.yml` (single source of truth) and the `GITHUB_TOKEN`
from `/home/jesse/projects/domains/.env`.

## What it collects (per active repo)

| Field | Source |
|---|---|
| default branch, visibility | `GET /repos/{slug}` |
| branch list + count | `GET /repos/{slug}/branches` |
| last commit to main (sha, date, subject) | `GET /repos/{slug}/commits?sha=main` |
| open PRs (number, title, head branch) | `GET /repos/{slug}/pulls?state=open` |

Each repo degrades to `{"ok": false, "error": ...}` on failure instead of
aborting the snapshot.

## Output

`out/` (gitignored): `gh-stats-YYYY-MM-DD.jsonl` (one snapshot/run) and
`latest.json` (most recent, pretty). `cf-grafana/ingest.py` reads these.

## Run (container)

```bash
cd /home/jesse/projects/domains/tools/gh-stats
docker compose up -d
docker compose logs -f
docker compose exec collector gh-stats collect --out-dir /work/out --sites-file /work/tools/site-tracker/sites.yml
docker compose down
```

## Run manually

```bash
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/gh-stats verify --env-file /home/jesse/projects/domains/.env
.venv/bin/gh-stats collect --out-dir out --env-file /home/jesse/projects/domains/.env
```

## Schedule

`crontab.docker` — hourly at `:37 UTC`, offset from cf-stats' `:23`.
```

- [ ] **Step 6: Build the image and run one in-container collect**

Run:
```bash
cd /home/jesse/projects/domains/tools/gh-stats
docker compose build
docker compose run --rm collector gh-stats collect --out-dir /work/out --sites-file /work/tools/site-tracker/sites.yml --quiet
ls -1 out/ && python3 -c "import json;d=json.load(open('out/latest.json'));print('repos',len(d['repos']),'first-ok',next(iter(d['repos'].values()))['ok'])"
```
Expected: `latest.json` present; `repos <N> first-ok True`.

- [ ] **Step 7: Bring the collector up**

Run:
```bash
cd /home/jesse/projects/domains/tools/gh-stats
docker compose up -d
docker compose ps
```
Expected: container `gh-stats` is `Up`.

- [ ] **Step 8: Commit**

```bash
git -C /home/jesse/projects/domains add tools/gh-stats/Dockerfile tools/gh-stats/docker-compose.yml tools/gh-stats/entrypoint.sh tools/gh-stats/crontab.docker tools/gh-stats/README.md
git -C /home/jesse/projects/domains commit -m "gh-stats: docker packaging (hourly supercronic collector)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: cf-grafana ingest — deployments + zone_worker tables

**Files:**
- Modify: `tools/cf-grafana/ingest.py`

- [ ] **Step 1: Add new tables to init()**

In `tools/cf-grafana/ingest.py`, inside `init()`'s `executescript`, add these table definitions before the closing `"""` (after the `workers` table and its indexes):

```sql
        CREATE TABLE IF NOT EXISTS deployments (
            worker       TEXT NOT NULL,
            created_on   TEXT NOT NULL,
            source       TEXT,
            version_id   TEXT,
            triggered_by TEXT,
            author       TEXT,
            PRIMARY KEY (worker, created_on)
        );
        CREATE TABLE IF NOT EXISTS zone_worker (
            zone   TEXT PRIMARY KEY,
            worker TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_deploy_created ON deployments(created_on);
```

- [ ] **Step 2: Ingest deployments + zone_worker in ingest_snapshot()**

In `tools/cf-grafana/ingest.py`, at the end of `ingest_snapshot()` (after the `workers_analytics_24h` loop), add:

```python
    dep = snap.get("deployments") or {}
    for worker, rows in (dep.get("per_worker") or {}).items():
        for d in rows:
            created = d.get("created_on")
            if not created:
                continue
            conn.execute(
                "INSERT OR REPLACE INTO deployments VALUES (?,?,?,?,?,?)",
                (worker, created, d.get("source"), d.get("version_id"),
                 d.get("triggered_by"), d.get("author")),
            )

    wd = snap.get("worker_domains") or {}
    for d in (wd.get("domains") or []):
        zone = d.get("zone_name")
        worker = d.get("service")
        if zone and worker:
            conn.execute(
                "INSERT OR REPLACE INTO zone_worker VALUES (?,?)", (zone, worker))
```

- [ ] **Step 3: Run ingest against the captured cf-stats output**

Run (uses the smoke output from Task 1 if present, else the live out dir):
```bash
cd /home/jesse/projects/domains/tools/cf-grafana
CF_STATS_OUT=/tmp/cfsmoke CF_STATS_DB=/tmp/devdash.db python3 ingest.py 2>&1 | tail -3 || \
  CF_STATS_OUT=../cf-stats/out CF_STATS_DB=/tmp/devdash.db python3 ingest.py 2>&1 | tail -3
```
Expected: `Done: N snapshots ingested`.

- [ ] **Step 4: Verify deployments + zone_worker rows exist**

Run:
```bash
python3 -c "import sqlite3;c=sqlite3.connect('/tmp/devdash.db');print('deployments',c.execute('SELECT COUNT(*) FROM deployments').fetchone()[0]);print('zone_worker',c.execute('SELECT COUNT(*) FROM zone_worker').fetchone()[0]);print('sample',c.execute('SELECT zone,worker FROM zone_worker LIMIT 3').fetchall())"
```
Expected: non-zero counts for both; `zone_worker` sample shows e.g. `('aliencouncil.com','aliencouncil')`.

- [ ] **Step 5: Commit**

```bash
git -C /home/jesse/projects/domains add tools/cf-grafana/ingest.py
git -C /home/jesse/projects/domains commit -m "cf-grafana: ingest deployments + zone_worker tables

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: cf-grafana ingest — GitHub tables + compose mount

**Files:**
- Modify: `tools/cf-grafana/ingest.py`
- Modify: `tools/cf-grafana/docker-compose.yml`

- [ ] **Step 1: Add gh tables to init()**

In `tools/cf-grafana/ingest.py`, inside `init()`'s `executescript`, add after the `deployments`/`zone_worker` definitions from Task 6:

```sql
        CREATE TABLE IF NOT EXISTS gh_repos (
            ts               TEXT NOT NULL,
            site             TEXT NOT NULL,
            slug             TEXT,
            default_branch   TEXT,
            branch_count     INTEGER DEFAULT 0,
            branches         TEXT,
            last_commit_sha  TEXT,
            last_commit_date TEXT,
            last_commit_msg  TEXT,
            open_pr_count    INTEGER DEFAULT 0,
            PRIMARY KEY (ts, site)
        );
        CREATE TABLE IF NOT EXISTS gh_prs (
            ts     TEXT NOT NULL,
            site   TEXT NOT NULL,
            number INTEGER NOT NULL,
            title  TEXT,
            head   TEXT,
            PRIMARY KEY (ts, site, number)
        );
        CREATE INDEX IF NOT EXISTS idx_gh_repos_ts ON gh_repos(ts);
        CREATE INDEX IF NOT EXISTS idx_gh_prs_ts   ON gh_prs(ts);
```

- [ ] **Step 2: Add a GH_STATS_OUT path constant**

In `tools/cf-grafana/ingest.py`, after the `DB_PATH = ...` line near the top, add:

```python
GH_STATS_OUT = Path(os.environ.get("GH_STATS_OUT", Path(__file__).parent.parent / "gh-stats" / "out"))
```

- [ ] **Step 3: Write the gh ingest function**

In `tools/cf-grafana/ingest.py`, add this function after `ingest_snapshot()`:

```python
def ingest_gh_snapshot(conn: sqlite3.Connection, snap: dict) -> None:
    ts = snap.get("timestamp", "")
    if not ts:
        return
    for site, r in (snap.get("repos") or {}).items():
        if not r.get("ok"):
            continue
        lc = r.get("last_main_commit") or {}
        conn.execute(
            "INSERT OR REPLACE INTO gh_repos VALUES (?,?,?,?,?,?,?,?,?,?)",
            (ts, site, r.get("slug"), r.get("default_branch"),
             r.get("branch_count", 0), json.dumps(r.get("branches") or []),
             lc.get("sha"), lc.get("date"), lc.get("message"),
             r.get("open_pr_count", 0)),
        )
        for pr in (r.get("open_prs") or []):
            if pr.get("number") is None:
                continue
            conn.execute(
                "INSERT OR REPLACE INTO gh_prs VALUES (?,?,?,?,?)",
                (ts, site, pr.get("number"), pr.get("title"), pr.get("head")),
            )
```

- [ ] **Step 4: Call gh ingest from main()**

In `tools/cf-grafana/ingest.py`, in `main()`, after the cf-stats `for path in sorted(OUT_DIR.glob(...))` loop and before `conn.commit()`, add:

```python
    gh_total = 0
    for path in sorted(GH_STATS_OUT.glob("gh-stats-*.jsonl")):
        n = 0
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ingest_gh_snapshot(conn, json.loads(line))
                    n += 1
                except Exception as e:
                    print(f"  warn {path.name}: {e}", file=sys.stderr)
        print(f"  {path.name}: {n} gh snapshots")
        gh_total += n
    print(f"  gh-stats: {gh_total} snapshots")
```

- [ ] **Step 5: Add the gh-stats out mount to compose**

In `tools/cf-grafana/docker-compose.yml`, in the `ingest` service's `volumes:` list, after the `- ../cf-stats/out:/cf-stats-out:ro` line add:

```yaml
      - ../gh-stats/out:/gh-stats-out:ro
```

And in the `ingest` service's `environment:` block, after the `CF_STATS_DB: ...` line add:

```yaml
      GH_STATS_OUT: /gh-stats-out
```

- [ ] **Step 6: Run ingest against both real out dirs**

Run:
```bash
cd /home/jesse/projects/domains/tools/cf-grafana
CF_STATS_OUT=../cf-stats/out GH_STATS_OUT=/tmp/ghsmoke CF_STATS_DB=/tmp/devdash.db python3 ingest.py 2>&1 | tail -4
python3 -c "import sqlite3;c=sqlite3.connect('/tmp/devdash.db');print('gh_repos',c.execute('SELECT COUNT(*) FROM gh_repos').fetchone()[0]);print('gh_prs',c.execute('SELECT COUNT(*) FROM gh_prs').fetchone()[0])"
```
Expected: `gh_repos` and `gh_prs` non-zero (gh_prs depends on there being open PRs; aliencouncil had 2).

- [ ] **Step 7: Verify the drift join produces a sensible result**

Run (this is the core dashboard query — last commit vs last deploy per site):
```bash
python3 - <<'PY'
import sqlite3
c = sqlite3.connect('/tmp/devdash.db')
q = """
SELECT g.site, g.last_commit_date, MAX(d.created_on) AS last_deploy,
       CASE WHEN g.last_commit_date > MAX(d.created_on) THEN 'DRIFT' ELSE 'ok' END AS state
FROM gh_repos g
JOIN zone_worker zw ON zw.zone = g.site
LEFT JOIN deployments d ON d.worker = zw.worker
WHERE g.ts = (SELECT MAX(ts) FROM gh_repos)
GROUP BY g.site
ORDER BY g.site
"""
for row in c.execute(q):
    print(row)
PY
```
Expected: one row per site with a `last_commit_date`, a `last_deploy`, and a `DRIFT`/`ok` flag. (Some sites may show NULL deploy if their zone→worker name isn't in `zone_worker`; that is expected and handled as "unknown" in the dashboard.)

- [ ] **Step 8: Commit**

```bash
git -C /home/jesse/projects/domains add tools/cf-grafana/ingest.py tools/cf-grafana/docker-compose.yml
git -C /home/jesse/projects/domains commit -m "cf-grafana: ingest gh-stats repos/PRs + mount gh-stats out

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: cf-grafana — developer.json dashboard

**Files:**
- Create: `tools/cf-grafana/grafana/dashboards/developer.json`

- [ ] **Step 1: Create the dashboard JSON**

Create `tools/cf-grafana/grafana/dashboards/developer.json`. Every panel uses the `frser-sqlite-datasource` uid `cf-stats`, `format: "table"`, `queryType: "table"`:

```json
{
  "id": null,
  "uid": "developer",
  "title": "Developer — Git & Deploys",
  "schemaVersion": 39,
  "version": 1,
  "refresh": "5m",
  "time": { "from": "now-7d", "to": "now" },
  "timepicker": {},
  "templating": { "list": [] },
  "annotations": { "list": [] },
  "panels": [
    {
      "id": 1, "type": "stat", "title": "Sites in drift",
      "datasource": { "type": "frser-sqlite-datasource", "uid": "cf-stats" },
      "targets": [ { "refId": "A", "rawQuery": true, "queryType": "table", "format": "table",
        "rawQueryText": "SELECT COUNT(*) FROM (SELECT g.site FROM gh_repos g JOIN zone_worker zw ON zw.zone=g.site LEFT JOIN deployments d ON d.worker=zw.worker WHERE g.ts=(SELECT MAX(ts) FROM gh_repos) GROUP BY g.site HAVING g.last_commit_date > MAX(d.created_on))" } ],
      "gridPos": { "h": 4, "w": 6, "x": 0, "y": 0 },
      "fieldConfig": { "defaults": { "color": { "mode": "thresholds" }, "thresholds": { "mode": "absolute", "steps": [ { "color": "green", "value": null }, { "color": "red", "value": 1 } ] } }, "overrides": [] },
      "options": { "reduceOptions": { "values": false, "calcs": ["lastNotNull"], "fields": "" }, "colorMode": "background", "graphMode": "none", "textMode": "auto", "justifyMode": "auto", "orientation": "auto" }
    },
    {
      "id": 2, "type": "stat", "title": "Open PRs",
      "datasource": { "type": "frser-sqlite-datasource", "uid": "cf-stats" },
      "targets": [ { "refId": "A", "rawQuery": true, "queryType": "table", "format": "table",
        "rawQueryText": "SELECT COUNT(*) FROM gh_prs WHERE ts=(SELECT MAX(ts) FROM gh_prs)" } ],
      "gridPos": { "h": 4, "w": 6, "x": 6, "y": 0 },
      "fieldConfig": { "defaults": { "color": { "mode": "thresholds" }, "thresholds": { "mode": "absolute", "steps": [ { "color": "blue", "value": null } ] } }, "overrides": [] },
      "options": { "reduceOptions": { "values": false, "calcs": ["lastNotNull"], "fields": "" }, "colorMode": "background", "graphMode": "none", "textMode": "auto", "justifyMode": "auto", "orientation": "auto" }
    },
    {
      "id": 3, "type": "stat", "title": "Deploys (24h)",
      "datasource": { "type": "frser-sqlite-datasource", "uid": "cf-stats" },
      "targets": [ { "refId": "A", "rawQuery": true, "queryType": "table", "format": "table",
        "rawQueryText": "SELECT COUNT(*) FROM deployments WHERE created_on >= datetime('now','-24 hours')" } ],
      "gridPos": { "h": 4, "w": 6, "x": 12, "y": 0 },
      "fieldConfig": { "defaults": { "color": { "mode": "thresholds" }, "thresholds": { "mode": "absolute", "steps": [ { "color": "green", "value": null } ] } }, "overrides": [] },
      "options": { "reduceOptions": { "values": false, "calcs": ["lastNotNull"], "fields": "" }, "colorMode": "background", "graphMode": "none", "textMode": "auto", "justifyMode": "auto", "orientation": "auto" }
    },
    {
      "id": 4, "type": "stat", "title": "Deploys (7d)",
      "datasource": { "type": "frser-sqlite-datasource", "uid": "cf-stats" },
      "targets": [ { "refId": "A", "rawQuery": true, "queryType": "table", "format": "table",
        "rawQueryText": "SELECT COUNT(*) FROM deployments WHERE created_on >= datetime('now','-7 days')" } ],
      "gridPos": { "h": 4, "w": 6, "x": 18, "y": 0 },
      "fieldConfig": { "defaults": { "color": { "mode": "thresholds" }, "thresholds": { "mode": "absolute", "steps": [ { "color": "purple", "value": null } ] } }, "overrides": [] },
      "options": { "reduceOptions": { "values": false, "calcs": ["lastNotNull"], "fields": "" }, "colorMode": "background", "graphMode": "none", "textMode": "auto", "justifyMode": "auto", "orientation": "auto" }
    },
    {
      "id": 5, "type": "table", "title": "Pipeline status — commit vs deploy",
      "datasource": { "type": "frser-sqlite-datasource", "uid": "cf-stats" },
      "targets": [ { "refId": "A", "rawQuery": true, "queryType": "table", "format": "table",
        "rawQueryText": "SELECT g.site AS \"Site\", substr(g.last_commit_sha,1,7) AS \"Main @\", g.last_commit_date AS \"Last commit\", MAX(d.created_on) AS \"Last deploy\", CASE WHEN MAX(d.created_on) IS NULL THEN '?' WHEN g.last_commit_date > MAX(d.created_on) THEN 'DRIFT' ELSE 'ok' END AS \"Drift\" FROM gh_repos g JOIN zone_worker zw ON zw.zone=g.site LEFT JOIN deployments d ON d.worker=zw.worker WHERE g.ts=(SELECT MAX(ts) FROM gh_repos) GROUP BY g.site ORDER BY g.site" } ],
      "gridPos": { "h": 11, "w": 24, "x": 0, "y": 4 },
      "fieldConfig": { "defaults": {}, "overrides": [
        { "matcher": { "id": "byName", "options": "Drift" }, "properties": [
          { "id": "custom.displayMode", "value": "color-background" },
          { "id": "mappings", "value": [
            { "type": "value", "options": { "DRIFT": { "color": "red", "index": 0 }, "ok": { "color": "green", "index": 1 }, "?": { "color": "yellow", "index": 2 } } } ] } ] } ] },
      "options": { "sortBy": [ { "displayName": "Drift", "desc": true } ] }
    },
    {
      "id": 6, "type": "table", "title": "Deploy log — newest first",
      "datasource": { "type": "frser-sqlite-datasource", "uid": "cf-stats" },
      "targets": [ { "refId": "A", "rawQuery": true, "queryType": "table", "format": "table",
        "rawQueryText": "SELECT d.created_on AS \"Time\", COALESCE(zw.zone, d.worker) AS \"Site\", d.source AS \"Source\", substr(d.version_id,1,8) AS \"Version\", d.author AS \"Author\" FROM deployments d LEFT JOIN zone_worker zw ON zw.worker=d.worker ORDER BY d.created_on DESC LIMIT 100" } ],
      "gridPos": { "h": 12, "w": 24, "x": 0, "y": 15 },
      "fieldConfig": { "defaults": {}, "overrides": [
        { "matcher": { "id": "byName", "options": "Source" }, "properties": [
          { "id": "custom.displayMode", "value": "color-background" },
          { "id": "mappings", "value": [
            { "type": "value", "options": { "wrangler": { "color": "blue", "index": 0 }, "ci": { "color": "green", "index": 1 } } } ] } ] } ] },
      "options": { "sortBy": [ { "displayName": "Time", "desc": true } ] }
    },
    {
      "id": 7, "type": "table", "title": "Branches per repo",
      "datasource": { "type": "frser-sqlite-datasource", "uid": "cf-stats" },
      "targets": [ { "refId": "A", "rawQuery": true, "queryType": "table", "format": "table",
        "rawQueryText": "SELECT site AS \"Site\", branch_count AS \"Branches\", branches AS \"Names\" FROM gh_repos WHERE ts=(SELECT MAX(ts) FROM gh_repos) ORDER BY branch_count DESC, site" } ],
      "gridPos": { "h": 10, "w": 12, "x": 0, "y": 27 },
      "fieldConfig": { "defaults": {}, "overrides": [
        { "matcher": { "id": "byName", "options": "Branches" }, "properties": [
          { "id": "custom.displayMode", "value": "color-background" },
          { "id": "thresholds", "value": { "mode": "absolute", "steps": [ { "color": "green", "value": null }, { "color": "yellow", "value": 2 }, { "color": "orange", "value": 4 } ] } } ] } ] },
      "options": { "sortBy": [ { "displayName": "Branches", "desc": true } ] }
    },
    {
      "id": 8, "type": "table", "title": "Open pull requests",
      "datasource": { "type": "frser-sqlite-datasource", "uid": "cf-stats" },
      "targets": [ { "refId": "A", "rawQuery": true, "queryType": "table", "format": "table",
        "rawQueryText": "SELECT site AS \"Site\", number AS \"#\", title AS \"Title\", head AS \"Branch\" FROM gh_prs WHERE ts=(SELECT MAX(ts) FROM gh_prs) ORDER BY site, number" } ],
      "gridPos": { "h": 10, "w": 12, "x": 12, "y": 27 },
      "fieldConfig": { "defaults": {}, "overrides": [] },
      "options": {}
    }
  ]
}
```

- [ ] **Step 2: Validate the JSON parses**

Run:
```bash
python3 -c "import json;json.load(open('/home/jesse/projects/domains/tools/cf-grafana/grafana/dashboards/developer.json'));print('JSON OK')"
```
Expected: `JSON OK`.

- [ ] **Step 3: Restart the grafana stack so the new dashboard + mounts load**

Run:
```bash
cd /home/jesse/projects/domains/tools/cf-grafana
docker compose up -d --build
docker compose ps
```
Expected: `grafana` and `ingest` both `Up`. (The ingest container now also mounts `../gh-stats/out`.)

- [ ] **Step 4: Wait for ingest, then verify the dashboard API serves it**

Run:
```bash
sleep 20
curl -s "http://localhost:4741/api/search?query=Developer" | python3 -c "import sys,json;d=json.load(sys.stdin);print([x['title'] for x in d])"
```
Expected: `['Developer — Git & Deploys']`.

- [ ] **Step 5: Verify the pipeline-status query returns rows through Grafana's datasource**

Run:
```bash
curl -s "http://localhost:4741/api/health" | python3 -c "import sys,json;print('grafana',json.load(sys.stdin)['database'])"
python3 -c "import sqlite3;c=sqlite3.connect('/home/jesse/projects/domains/tools/cf-grafana/data/cf-stats.db');print('pipeline rows',len(c.execute(\"SELECT g.site FROM gh_repos g WHERE g.ts=(SELECT MAX(ts) FROM gh_repos)\").fetchall()))"
```
Expected: `grafana ok` and `pipeline rows <N>` (N = number of active repos). If `pipeline rows 0`, the live ingest hasn't run yet — wait and re-run, or run `docker compose exec ingest python /app/ingest.py`.

- [ ] **Step 6: Eyeball the dashboard in the browser**

Open `http://localhost:4741/d/developer` and confirm: Pipeline status table shows one row per site with a colored Drift cell; Deploy log lists recent deploys with a colored Source tag; Branches and Open PRs tables are populated. Note: at the current moment all deploys read `wrangler` (blue) — that is correct and is the "push-to-deploy not wired / shipped via wrangler" signal.

- [ ] **Step 7: Commit**

```bash
git -C /home/jesse/projects/domains add tools/cf-grafana/grafana/dashboards/developer.json
git -C /home/jesse/projects/domains commit -m "cf-grafana: add Developer dashboard (pipeline status, deploy log, branches, PRs)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run all tests**

```bash
cd /home/jesse/projects/domains/tools/cf-stats && .venv/bin/pytest -q
cd /home/jesse/projects/domains/tools/gh-stats && .venv/bin/pytest -q
```
Expected: all green.

- [ ] **Confirm both collectors are scheduled and the dashboard is live**

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'cf-stats|gh-stats|cf-grafana|grafana'
curl -s "http://localhost:4741/api/search?query=Developer" | python3 -c "import sys,json;print('dashboard:', [x['title'] for x in json.load(sys.stdin)])"
```
Expected: `gh-stats` Up, `cf-stats` Up, grafana + ingest Up, and the Developer dashboard listed.

- [ ] **Update the dashboard backlog**

In `tools/DASHBOARD_BACKLOG.md`, under "Tier 3 (CF analytics) — shipped differently", append a note that the Developer dashboard (git+deploy pipeline) shipped via `tools/gh-stats` + `cf-grafana/developer.json` on 2026-05-31. Commit:

```bash
git -C /home/jesse/projects/domains add tools/DASHBOARD_BACKLOG.md
git -C /home/jesse/projects/domains commit -m "docs: note Developer dashboard shipped in DASHBOARD_BACKLOG

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **Best-effort contract is sacred.** Every collector returns `{"ok": bool, ...}` and never raises out to the snapshot loop. If you add a field, keep that contract.
- **Never hardcode the domain↔worker or domain↔repo maps.** Worker names come from cf-stats `worker_domains` (→ `zone_worker` table); repo slugs come from `site-tracker/sites.yml`. Both drift (TLD stripping); the data already encodes the truth.
- **The `source` column is a feature, not noise.** All-`wrangler` today means sites ship via wrangler, not CF push-to-deploy CI. If a row ever shows a CI source, push-to-deploy is wired for that worker.
- **Workers Builds CI telemetry (build pass/fail/duration/logs) is NOT available** to our token (`No route for that URI`). Do not add a collector for it; the deployments API is the substitute.
- **domain-developer session activity is out of scope** for this plan (no metric stream exists yet).
