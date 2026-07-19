# Fleet Analytics — Plan 1: Auth & Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a service account unattended read access to all 16 GA4 properties and verified ownership of all 16 Search Console domains, so later plans can pull metrics with no human in the loop.

**Architecture:** A shared Python credential library (`tools/google-auth/`) hands out scoped Google API clients from the existing service-account key. One interactive OAuth-as-Jesse tool (`tools/ga4-provision/`) discovers GA4 property IDs, writes the canonical site registry, and grants the service account Viewer on every property — the GA4 Admin API allows granting, but a service account cannot grant itself. A second tool (`tools/gsc-verify/`) has the service account verify each domain *itself* via a Cloudflare-written DNS TXT record, because the Search Console API has no permissions endpoint at all — successful DNS verification makes the verifying identity a verified owner, sidestepping the missing grant path.

**Tech Stack:** Python 3.11+, `google-auth`, `google-auth-oauthlib`, `google-api-python-client`, `google-analytics-admin`, `httpx`, `PyYAML`, `pytest`. Mirrors `tools/data-hub`'s packaging (setuptools + `src/` layout + `pythonpath` pytest config).

## Global Constraints

- Python `>=3.11`, matching `tools/data-hub/pyproject.toml`.
- Service-account key lives at `/home/jesse/projects/domains/.gcp/service-account.json` (project `domains-ops`, gitignored via `.gitignore:7`). **Never** copy, log, or print its `private_key`.
- OAuth client at `/home/jesse/projects/domains/.gcp/oauth-client.json`, `installed` type.
- Cloudflare credentials come from `/home/jesse/projects/domains/.env` as `CLOUDFLARE_API_TOKEN` (a `CF_API_TOKEN` alias also exists; prefer `CLOUDFLARE_API_TOKEN`, matching `tools/site-tracker/src/site_tracker/collectors/cloudflare.py:25`).
- All tools are **idempotent and re-runnable**. Every one reports a per-domain result table and never fails the whole run because one domain failed.
- **Absence is never zero.** A skipped, unauthorized, or failed target reports an explicit status — never a fabricated success or a zero value.
- No secrets in committed files, test fixtures, or log output.
- Every tool is Python. `google-auth-library` is removed from root `package.json`; no Node in this pipeline.

---

## File Structure

**`tools/google-auth/`** — shared credential library, the only place credentials are read.
- `src/google_auth_fleet/creds.py` — loads the service-account key, validates shape.
- `src/google_auth_fleet/clients.py` — scoped client factory (GA4 Data, GA4 Admin, Search Console, Site Verification).
- `src/google_auth_fleet/errors.py` — typed failures so callers distinguish "no key" from "wrong scope".

**`tools/ga4-provision/`** — one-time interactive tool.
- `src/ga4_provision/oauth.py` — installed-app OAuth flow (ports `tools/auth-google/setup.mjs`).
- `src/ga4_provision/discover.py` — `properties.list` → authoritative property IDs.
- `src/ga4_provision/registry.py` — writes `tools/data-hub/registry/sites-analytics.yaml`.
- `src/ga4_provision/grant.py` — `accessBindings.create`, idempotent.
- `src/ga4_provision/cli.py` — orchestrator.

**`tools/gsc-verify/`** — idempotent verification tool.
- `src/gsc_verify/cloudflare.py` — TXT record read/write/delete.
- `src/gsc_verify/verification.py` — Site Verification API token + verify.
- `src/gsc_verify/console.py` — `sites.add` + sitemap submit.
- `src/gsc_verify/cli.py` — orchestrator with per-domain state machine.

---

## Task 1: Credential loader

**Files:**
- Create: `tools/google-auth/pyproject.toml`
- Create: `tools/google-auth/requirements.txt`
- Create: `tools/google-auth/src/google_auth_fleet/__init__.py`
- Create: `tools/google-auth/src/google_auth_fleet/errors.py`
- Create: `tools/google-auth/src/google_auth_fleet/creds.py`
- Test: `tools/google-auth/tests/test_creds.py`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `load_service_account(path: Path | None = None) -> service_account.Credentials`; `DEFAULT_KEY_PATH: Path`; exceptions `CredentialsMissing`, `CredentialsMalformed`, `ScopeUnauthorized` (all subclass `GoogleAuthFleetError`).

- [ ] **Step 1: Create the package scaffold**

`tools/google-auth/pyproject.toml`:

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "google-auth-fleet"
version = "0.1.0"
requires-python = ">=3.11"

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
pythonpath = ["src"]
testpaths = ["tests"]
```

`tools/google-auth/requirements.txt`:

```
google-auth==2.35.0
google-auth-oauthlib==1.2.1
google-api-python-client==2.149.0
google-analytics-admin==0.23.0
google-analytics-data==0.18.16
PyYAML==6.0.2
pytest==8.3.3
```

`tools/google-auth/src/google_auth_fleet/__init__.py`:

```python
"""Shared Google API credentials for the domains fleet."""
```

- [ ] **Step 2: Write the failing test**

`tools/google-auth/tests/test_creds.py`:

```python
import json
import pytest

from google_auth_fleet import creds
from google_auth_fleet.errors import CredentialsMissing, CredentialsMalformed


def test_missing_key_raises_credentials_missing(tmp_path):
    with pytest.raises(CredentialsMissing) as exc:
        creds.load_service_account(tmp_path / "nope.json")
    assert "nope.json" in str(exc.value)


def test_malformed_key_raises_credentials_malformed(tmp_path):
    bad = tmp_path / "sa.json"
    bad.write_text(json.dumps({"type": "service_account"}))
    with pytest.raises(CredentialsMalformed) as exc:
        creds.load_service_account(bad)
    assert "private_key" in str(exc.value)


def test_wrong_type_raises_credentials_malformed(tmp_path):
    bad = tmp_path / "sa.json"
    bad.write_text(json.dumps({"type": "authorized_user", "private_key": "x"}))
    with pytest.raises(CredentialsMalformed):
        creds.load_service_account(bad)
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd tools/google-auth && python -m pytest tests/test_creds.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'google_auth_fleet.creds'`

- [ ] **Step 4: Write the errors module**

`tools/google-auth/src/google_auth_fleet/errors.py`:

```python
"""Typed failures so callers distinguish missing creds from bad scopes."""


class GoogleAuthFleetError(Exception):
    """Base for all credential/client failures."""


class CredentialsMissing(GoogleAuthFleetError):
    """The service-account key file does not exist."""


class CredentialsMalformed(GoogleAuthFleetError):
    """The key file exists but is not a usable service-account key."""


class ScopeUnauthorized(GoogleAuthFleetError):
    """Credentials are valid but lack the scope the caller needs."""
```

- [ ] **Step 5: Write the credential loader**

`tools/google-auth/src/google_auth_fleet/creds.py`:

```python
"""Load the fleet service-account key. Never logs or returns the private key."""
from __future__ import annotations

import json
from pathlib import Path

from google.oauth2 import service_account

from .errors import CredentialsMalformed, CredentialsMissing

DEFAULT_KEY_PATH = Path("/home/jesse/projects/domains/.gcp/service-account.json")

REQUIRED_FIELDS = ("type", "private_key", "client_email", "project_id", "token_uri")


def load_service_account(path: Path | None = None, *, scopes: list[str] | None = None):
    """Return service-account Credentials, optionally scoped.

    Raises CredentialsMissing / CredentialsMalformed with an actionable message.
    """
    key_path = Path(path) if path else DEFAULT_KEY_PATH
    if not key_path.exists():
        raise CredentialsMissing(
            f"Service-account key not found at {key_path}. "
            "Expected the gitignored .gcp/service-account.json."
        )

    try:
        data = json.loads(key_path.read_text())
    except json.JSONDecodeError as exc:
        raise CredentialsMalformed(f"{key_path} is not valid JSON: {exc}") from exc

    if data.get("type") != "service_account":
        raise CredentialsMalformed(
            f"{key_path} has type={data.get('type')!r}, expected 'service_account'."
        )

    missing = [f for f in REQUIRED_FIELDS if not data.get(f)]
    if missing:
        raise CredentialsMalformed(
            f"{key_path} is missing required field(s): {', '.join(missing)}"
        )

    return service_account.Credentials.from_service_account_info(data, scopes=scopes)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd tools/google-auth && python -m pytest tests/test_creds.py -v`
Expected: PASS (3 passed)

- [ ] **Step 7: Commit**

```bash
git add tools/google-auth/pyproject.toml tools/google-auth/requirements.txt \
        tools/google-auth/src/google_auth_fleet/__init__.py \
        tools/google-auth/src/google_auth_fleet/errors.py \
        tools/google-auth/src/google_auth_fleet/creds.py \
        tools/google-auth/tests/test_creds.py
git commit -m "feat(google-auth): service-account credential loader with typed errors"
```

---

## Task 2: Scoped client factory

**Files:**
- Create: `tools/google-auth/src/google_auth_fleet/clients.py`
- Test: `tools/google-auth/tests/test_clients.py`

**Interfaces:**
- Consumes: `creds.load_service_account(path, scopes=...)` from Task 1.
- Produces: `SCOPES: dict[str, list[str]]`; `search_console(path=None)`, `site_verification(path=None)`, `ga4_admin(path=None)`, `ga4_data(path=None)` — each returning a ready client.

- [ ] **Step 1: Write the failing test**

`tools/google-auth/tests/test_clients.py`:

```python
from google_auth_fleet import clients


def test_scopes_are_readonly_where_possible():
    assert clients.SCOPES["ga4_data"] == [
        "https://www.googleapis.com/auth/analytics.readonly"
    ]
    assert clients.SCOPES["search_console"] == [
        "https://www.googleapis.com/auth/webmasters.readonly"
    ]


def test_site_verification_scope_is_write_capable():
    # Verification necessarily mutates ownership state, so it cannot be readonly.
    assert clients.SCOPES["site_verification"] == [
        "https://www.googleapis.com/auth/siteverification"
    ]


def test_search_console_builds_client(monkeypatch):
    captured = {}

    def fake_load(path=None, *, scopes=None):
        captured["scopes"] = scopes
        return object()

    def fake_build(name, version, credentials=None, cache_discovery=False):
        captured["service"] = (name, version)
        return "CLIENT"

    monkeypatch.setattr(clients.creds, "load_service_account", fake_load)
    monkeypatch.setattr(clients, "build", fake_build)

    assert clients.search_console() == "CLIENT"
    assert captured["service"] == ("searchconsole", "v1")
    assert captured["scopes"] == clients.SCOPES["search_console"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/google-auth && python -m pytest tests/test_clients.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'google_auth_fleet.clients'`

- [ ] **Step 3: Write the client factory**

`tools/google-auth/src/google_auth_fleet/clients.py`:

```python
"""Scoped Google API clients built from the fleet service account.

Scopes are least-privilege: readonly everywhere except site verification,
which necessarily mutates ownership state.
"""
from __future__ import annotations

from pathlib import Path

from googleapiclient.discovery import build

from . import creds

SCOPES: dict[str, list[str]] = {
    "ga4_data": ["https://www.googleapis.com/auth/analytics.readonly"],
    "ga4_admin": ["https://www.googleapis.com/auth/analytics.readonly"],
    "search_console": ["https://www.googleapis.com/auth/webmasters.readonly"],
    "site_verification": ["https://www.googleapis.com/auth/siteverification"],
}


def _client(service: str, version: str, scope_key: str, path: Path | None):
    credentials = creds.load_service_account(path, scopes=SCOPES[scope_key])
    return build(service, version, credentials=credentials, cache_discovery=False)


def search_console(path: Path | None = None):
    """Search Analytics + sitemaps. NOTE: this API has no permissions endpoint."""
    return _client("searchconsole", "v1", "search_console", path)


def site_verification(path: Path | None = None):
    """Site Verification API — the service account verifies domains itself."""
    return _client("siteVerification", "v1", "site_verification", path)


def ga4_admin(path: Path | None = None):
    """GA4 Admin API — property discovery and access bindings."""
    return _client("analyticsadmin", "v1beta", "ga4_admin", path)


def ga4_data(path: Path | None = None):
    """GA4 Data API — metric reporting (consumed by Plan 2)."""
    return _client("analyticsdata", "v1beta", "ga4_data", path)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd tools/google-auth && python -m pytest tests/ -v`
Expected: PASS (6 passed)

- [ ] **Step 5: Verify against the real key (no network mutation)**

Run:

```bash
cd tools/google-auth && python -c "
from google_auth_fleet import creds
c = creds.load_service_account()
print('loaded ok, project:', c.project_id)
"
```

Expected: `loaded ok, project: domains-ops`

- [ ] **Step 6: Commit**

```bash
git add tools/google-auth/src/google_auth_fleet/clients.py tools/google-auth/tests/test_clients.py
git commit -m "feat(google-auth): least-privilege scoped client factory"
```

---

## Task 3: OAuth-as-Jesse flow

**Files:**
- Create: `tools/ga4-provision/pyproject.toml`
- Create: `tools/ga4-provision/src/ga4_provision/__init__.py`
- Create: `tools/ga4-provision/src/ga4_provision/oauth.py`
- Test: `tools/ga4-provision/tests/test_oauth.py`

**Interfaces:**
- Consumes: nothing from prior tasks (parallel auth path — this authenticates as a human, not the SA).
- Produces: `user_credentials(client_path: Path | None = None, token_path: Path | None = None)`; `OAUTH_CLIENT_PATH: Path`; `TOKEN_CACHE_PATH: Path`; `USER_SCOPES: list[str]`.

**Why this exists:** the GA4 Admin API exposes `accessBindings.create`, but a service account cannot grant itself access to properties it cannot see. This runs once, interactively, as Jesse. It ports the flow from the abandoned `tools/auth-google/setup.mjs` (whose scopes at `:21-22` were already correct) from Node to Python.

- [ ] **Step 1: Create the package scaffold**

`tools/ga4-provision/pyproject.toml`:

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "ga4-provision"
version = "0.1.0"
requires-python = ">=3.11"

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
pythonpath = ["src"]
testpaths = ["tests"]
```

`tools/ga4-provision/src/ga4_provision/__init__.py`:

```python
"""One-time GA4 provisioning: discover properties, grant the service account."""
```

- [ ] **Step 2: Write the failing test**

`tools/ga4-provision/tests/test_oauth.py`:

```python
import json
import pytest

from ga4_provision import oauth


def test_scopes_include_analytics_edit():
    # accessBindings.create requires edit, not readonly.
    assert "https://www.googleapis.com/auth/analytics.manage.users" in oauth.USER_SCOPES
    assert "https://www.googleapis.com/auth/analytics.readonly" in oauth.USER_SCOPES


def test_missing_client_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError) as exc:
        oauth.user_credentials(client_path=tmp_path / "absent.json")
    assert "absent.json" in str(exc.value)


def test_cached_token_is_reused_without_prompting(tmp_path, monkeypatch):
    token = tmp_path / "token.json"
    token.write_text(json.dumps({"token": "cached"}))

    calls = {"flow": 0}

    class FakeCreds:
        valid = True

    def fake_from_file(path, scopes):
        assert str(path) == str(token)
        return FakeCreds()

    def fake_flow(*a, **kw):
        calls["flow"] += 1
        raise AssertionError("must not prompt when a valid token is cached")

    monkeypatch.setattr(oauth.Credentials, "from_authorized_user_file", staticmethod(fake_from_file))
    monkeypatch.setattr(oauth.InstalledAppFlow, "from_client_secrets_file", staticmethod(fake_flow))

    result = oauth.user_credentials(
        client_path=tmp_path / "client.json", token_path=token
    )
    assert isinstance(result, FakeCreds)
    assert calls["flow"] == 0
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd tools/ga4-provision && python -m pytest tests/test_oauth.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ga4_provision.oauth'`

- [ ] **Step 4: Write the OAuth module**

`tools/ga4-provision/src/ga4_provision/oauth.py`:

```python
"""Interactive OAuth as Jesse. Runs once; the service account does the rest.

Ports tools/auth-google/setup.mjs (Node) to Python. The cached token is a
convenience for re-runs when onboarding new sites — nothing recurring depends
on it, so its expiry is never a production concern.
"""
from __future__ import annotations

from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

OAUTH_CLIENT_PATH = Path("/home/jesse/projects/domains/.gcp/oauth-client.json")
TOKEN_CACHE_PATH = Path("/home/jesse/projects/domains/.gcp/ga4-provision-token.json")

# accessBindings.create needs manage.users; readonly is for property discovery.
USER_SCOPES = [
    "https://www.googleapis.com/auth/analytics.readonly",
    "https://www.googleapis.com/auth/analytics.manage.users",
]


def user_credentials(
    client_path: Path | None = None, token_path: Path | None = None
) -> Credentials:
    """Return user credentials, prompting in a browser only when necessary."""
    client_path = Path(client_path) if client_path else OAUTH_CLIENT_PATH
    token_path = Path(token_path) if token_path else TOKEN_CACHE_PATH

    creds = None
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(token_path, USER_SCOPES)

    if creds and creds.valid:
        return creds

    if creds and getattr(creds, "expired", False) and getattr(creds, "refresh_token", None):
        creds.refresh(Request())
    else:
        if not client_path.exists():
            raise FileNotFoundError(
                f"OAuth client not found at {client_path}. "
                "Expected the gitignored .gcp/oauth-client.json (installed type)."
            )
        flow = InstalledAppFlow.from_client_secrets_file(str(client_path), USER_SCOPES)
        creds = flow.run_local_server(port=0)

    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(creds.to_json())
    token_path.chmod(0o600)
    return creds
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd tools/ga4-provision && python -m pytest tests/test_oauth.py -v`
Expected: PASS (3 passed)

- [ ] **Step 6: Confirm the token cache is gitignored**

Run: `cd /home/jesse/projects/domains && git check-ignore -v .gcp/ga4-provision-token.json`
Expected: output naming `.gitignore:7` (`.gcp/`). If it prints nothing, STOP and add `.gcp/` to `.gitignore` before continuing — the token must never be committed.

- [ ] **Step 7: Commit**

```bash
git add tools/ga4-provision/pyproject.toml \
        tools/ga4-provision/src/ga4_provision/__init__.py \
        tools/ga4-provision/src/ga4_provision/oauth.py \
        tools/ga4-provision/tests/test_oauth.py
git commit -m "feat(ga4-provision): port interactive OAuth flow from Node to Python"
```

---

## Task 4: GA4 property discovery

**Files:**
- Create: `tools/ga4-provision/src/ga4_provision/discover.py`
- Test: `tools/ga4-provision/tests/test_discover.py`

**Interfaces:**
- Consumes: `oauth.user_credentials()` from Task 3.
- Produces: `discover_properties(client) -> list[Property]` where `Property` is a dataclass with fields `property_id: str`, `display_name: str`, `measurement_ids: list[str]`, `account_id: str`.

**Why this exists:** the two hardcoded property lists in the repo disagree and are both stale — `domain-seo-check-stats/scripts/ga-seo-audit.py:30-46` has 13 entries, `domains-google-analytics-ga4-admin/SKILL.md:113-133` has 15, and there are 16 live sites. Neither can be trusted as a source; the Admin API is authoritative.

- [ ] **Step 1: Write the failing test**

`tools/ga4-provision/tests/test_discover.py`:

```python
from ga4_provision import discover


class FakeList:
    def __init__(self, pages):
        self._pages = pages
        self._i = 0

    def execute(self):
        return self._pages[self._i]


class FakeProperties:
    def __init__(self, pages):
        self._pages = pages
        self._i = 0

    def list(self, **kw):
        page = self._pages[self._i]
        self._i += 1
        return type("R", (), {"execute": lambda _s: page})()

    def list_next(self, request, response):
        return None if self._i >= len(self._pages) else object()


def test_discover_returns_properties():
    pages = [{
        "properties": [
            {"name": "properties/123", "displayName": "saveusfarms.com",
             "parent": "accounts/396394354"},
            {"name": "properties/456", "displayName": "xxxtea.com",
             "parent": "accounts/396394354"},
        ]
    }]
    client = type("C", (), {"properties": lambda _s: FakeProperties(pages)})()
    result = discover.discover_properties(client)
    assert [p.property_id for p in result] == ["123", "456"]
    assert result[0].display_name == "saveusfarms.com"
    assert result[0].account_id == "396394354"


def test_empty_account_returns_empty_list():
    client = type("C", (), {"properties": lambda _s: FakeProperties([{}])})()
    assert discover.discover_properties(client) == []
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/ga4-provision && python -m pytest tests/test_discover.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ga4_provision.discover'`

- [ ] **Step 3: Write the discovery module**

`tools/ga4-provision/src/ga4_provision/discover.py`:

```python
"""Authoritative GA4 property discovery via the Admin API.

The two hardcoded property lists in this repo disagree with each other and
with reality. This is the only trustworthy source.
"""
from __future__ import annotations

from dataclasses import dataclass, field

ACCOUNT_ID = "396394354"  # "Domain Portfolio"


@dataclass
class Property:
    property_id: str
    display_name: str
    account_id: str
    measurement_ids: list[str] = field(default_factory=list)


def discover_properties(client, account_id: str = ACCOUNT_ID) -> list[Property]:
    """List every GA4 property under the account, following pagination."""
    props: list[Property] = []
    api = client.properties()
    request = api.list(filter=f"parent:accounts/{account_id}", pageSize=200)

    while request is not None:
        response = request.execute()
        for p in response.get("properties", []):
            props.append(
                Property(
                    property_id=p["name"].split("/")[-1],
                    display_name=p.get("displayName", ""),
                    account_id=p.get("parent", "").split("/")[-1],
                )
            )
        request = api.list_next(request, response)

    return props
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd tools/ga4-provision && python -m pytest tests/test_discover.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add tools/ga4-provision/src/ga4_provision/discover.py tools/ga4-provision/tests/test_discover.py
git commit -m "feat(ga4-provision): authoritative property discovery via Admin API"
```

---

## Task 5: Write the canonical site registry

**Files:**
- Create: `tools/ga4-provision/src/ga4_provision/registry.py`
- Test: `tools/ga4-provision/tests/test_registry.py`

**Interfaces:**
- Consumes: `discover.Property` from Task 4.
- Produces: `build_registry(properties, measurement_map, consent_gated) -> dict`; `write_registry(data, path) -> None`; `REGISTRY_PATH: Path`; `CONSENT_GATED: set[str]`.

**Output shape** (consumed by Plan 2's collector):

```yaml
sites:
  saveusfarms.com:
    ga4_property_id: "123456789"
    ga4_measurement_id: G-GDYX2GPMMJ
    gsc_property: "sc-domain:saveusfarms.com"
    consent_gated: true
```

- [ ] **Step 1: Write the failing test**

`tools/ga4-provision/tests/test_registry.py`:

```python
import yaml

from ga4_provision import registry
from ga4_provision.discover import Property


def test_build_registry_maps_sites():
    props = [Property("123", "saveusfarms.com", "396394354")]
    data = registry.build_registry(props, {"saveusfarms.com": "G-GDYX2GPMMJ"})
    entry = data["sites"]["saveusfarms.com"]
    assert entry["ga4_property_id"] == "123"
    assert entry["ga4_measurement_id"] == "G-GDYX2GPMMJ"
    assert entry["gsc_property"] == "sc-domain:saveusfarms.com"


def test_consent_gated_sites_are_flagged():
    props = [
        Property("1", "saveusfarms.com", "396394354"),
        Property("2", "xxxtea.com", "396394354"),
    ]
    data = registry.build_registry(props, {})
    assert data["sites"]["saveusfarms.com"]["consent_gated"] is True
    assert data["sites"]["xxxtea.com"]["consent_gated"] is False


def test_unknown_measurement_id_is_null_not_empty_string():
    # Absence must be distinguishable from a real value.
    props = [Property("1", "newsite.com", "396394354")]
    data = registry.build_registry(props, {})
    assert data["sites"]["newsite.com"]["ga4_measurement_id"] is None


def test_write_registry_roundtrips(tmp_path):
    path = tmp_path / "sites-analytics.yaml"
    props = [Property("123", "saveusfarms.com", "396394354")]
    data = registry.build_registry(props, {"saveusfarms.com": "G-GDYX2GPMMJ"})
    registry.write_registry(data, path)
    loaded = yaml.safe_load(path.read_text())
    assert loaded["sites"]["saveusfarms.com"]["ga4_property_id"] == "123"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/ga4-provision && python -m pytest tests/test_registry.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ga4_provision.registry'`

- [ ] **Step 3: Write the registry module**

`tools/ga4-provision/src/ga4_provision/registry.py`:

```python
"""Writes the canonical site→property mapping consumed by the data-hub collector."""
from __future__ import annotations

from pathlib import Path

import yaml

from .discover import Property

REGISTRY_PATH = Path(
    "/home/jesse/projects/domains/tools/data-hub/registry/sites-analytics.yaml"
)

# GA4 loads only after explicit consent on these sites, so their numbers
# undercount real traffic and must never be ranked against ungated sites.
CONSENT_GATED = {"saveusfarms.com", "weapontester.com"}

HEADER = (
    "# Canonical site -> GA4 property / GSC property mapping.\n"
    "# Generated by tools/ga4-provision. Do not hand-edit.\n"
    "# consent_gated sites report only consented traffic (undercount).\n"
)


def build_registry(
    properties: list[Property],
    measurement_map: dict[str, str],
    consent_gated: set[str] | None = None,
) -> dict:
    """Map discovered properties to the registry shape.

    A site with no known measurement ID gets None, not "" — absence must stay
    distinguishable from a real value.
    """
    gated = CONSENT_GATED if consent_gated is None else consent_gated
    sites: dict[str, dict] = {}

    for prop in sorted(properties, key=lambda p: p.display_name):
        site = prop.display_name.strip()
        if not site:
            continue
        sites[site] = {
            "ga4_property_id": prop.property_id,
            "ga4_measurement_id": measurement_map.get(site) or None,
            "gsc_property": f"sc-domain:{site}",
            "consent_gated": site in gated,
        }

    return {"sites": sites}


def write_registry(data: dict, path: Path | None = None) -> None:
    """Write the registry YAML, creating parent dirs as needed."""
    target = Path(path) if path else REGISTRY_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    body = yaml.safe_dump(data, sort_keys=False, default_flow_style=False)
    target.write_text(HEADER + body)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd tools/ga4-provision && python -m pytest tests/test_registry.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add tools/ga4-provision/src/ga4_provision/registry.py tools/ga4-provision/tests/test_registry.py
git commit -m "feat(ga4-provision): canonical sites-analytics registry writer"
```

---

## Task 6: Grant the service account Viewer

**Files:**
- Create: `tools/ga4-provision/src/ga4_provision/grant.py`
- Test: `tools/ga4-provision/tests/test_grant.py`

**Interfaces:**
- Consumes: `discover.Property` from Task 4.
- Produces: `grant_viewer(client, property_id, sa_email) -> str` returning one of `"granted"`, `"already"`, `"failed:<reason>"`; `service_account_email(key_path=None) -> str`.

- [ ] **Step 1: Write the failing test**

`tools/ga4-provision/tests/test_grant.py`:

```python
import pytest
from googleapiclient.errors import HttpError

from ga4_provision import grant


class FakeBindings:
    def __init__(self, existing=None, error=None):
        self.existing = existing or []
        self.error = error
        self.created = []

    def list(self, parent=None, **kw):
        bindings = [{"user": e} for e in self.existing]
        return type("R", (), {"execute": lambda _s: {"accessBindings": bindings}})()

    def list_next(self, request, response):
        return None

    def create(self, parent=None, body=None):
        if self.error:
            raise self.error
        self.created.append((parent, body))
        return type("R", (), {"execute": lambda _s: {"name": "ok"}})()


def _client(bindings):
    return type("C", (), {"properties": lambda _s: type(
        "P", (), {"accessBindings": lambda _p: bindings})()})()


def test_grant_creates_binding_when_absent():
    b = FakeBindings()
    result = grant.grant_viewer(_client(b), "123", "sa@domains-ops.iam.gserviceaccount.com")
    assert result == "granted"
    assert b.created[0][0] == "properties/123"
    assert b.created[0][1]["roles"] == ["predefinedRoles/viewer"]


def test_grant_is_idempotent():
    b = FakeBindings(existing=["sa@domains-ops.iam.gserviceaccount.com"])
    result = grant.grant_viewer(_client(b), "123", "sa@domains-ops.iam.gserviceaccount.com")
    assert result == "already"
    assert b.created == []


def test_grant_failure_is_reported_not_raised():
    err = HttpError(type("R", (), {"status": 403, "reason": "Forbidden"})(), b"denied")
    b = FakeBindings(error=err)
    result = grant.grant_viewer(_client(b), "123", "sa@domains-ops.iam.gserviceaccount.com")
    assert result.startswith("failed:")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/ga4-provision && python -m pytest tests/test_grant.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ga4_provision.grant'`

- [ ] **Step 3: Write the grant module**

`tools/ga4-provision/src/ga4_provision/grant.py`:

```python
"""Grant the service account Viewer on GA4 properties.

A service account cannot grant itself, so this runs under Jesse's OAuth
credentials. One failure never aborts the fleet run.
"""
from __future__ import annotations

import json
from pathlib import Path

from googleapiclient.errors import HttpError

DEFAULT_KEY_PATH = Path("/home/jesse/projects/domains/.gcp/service-account.json")
VIEWER_ROLE = "predefinedRoles/viewer"


def service_account_email(key_path: Path | None = None) -> str:
    """Read the SA's client_email. Never touches the private key."""
    path = Path(key_path) if key_path else DEFAULT_KEY_PATH
    return json.loads(path.read_text())["client_email"]


def _existing_users(client, property_id: str) -> set[str]:
    api = client.properties().accessBindings()
    users: set[str] = set()
    request = api.list(parent=f"properties/{property_id}")
    while request is not None:
        response = request.execute()
        for binding in response.get("accessBindings", []):
            if binding.get("user"):
                users.add(binding["user"])
        request = api.list_next(request, response)
    return users


def grant_viewer(client, property_id: str, sa_email: str) -> str:
    """Return 'granted', 'already', or 'failed:<reason>'. Never raises."""
    try:
        if sa_email in _existing_users(client, property_id):
            return "already"
        client.properties().accessBindings().create(
            parent=f"properties/{property_id}",
            body={"user": sa_email, "roles": [VIEWER_ROLE]},
        ).execute()
        return "granted"
    except HttpError as exc:
        return f"failed:http-{getattr(exc.resp, 'status', '?')}"
    except Exception as exc:  # noqa: BLE001 - one property must not abort the fleet
        return f"failed:{type(exc).__name__}"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd tools/ga4-provision && python -m pytest tests/test_grant.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add tools/ga4-provision/src/ga4_provision/grant.py tools/ga4-provision/tests/test_grant.py
git commit -m "feat(ga4-provision): idempotent Viewer grant for the service account"
```

---

## Task 7: ga4-provision orchestrator CLI

**Files:**
- Create: `tools/ga4-provision/src/ga4_provision/cli.py`
- Create: `tools/ga4-provision/README.md`
- Test: `tools/ga4-provision/tests/test_cli.py`

**Interfaces:**
- Consumes: `oauth.user_credentials`, `discover.discover_properties`, `registry.build_registry`/`write_registry`, `grant.grant_viewer`/`service_account_email`.
- Produces: `main(argv=None) -> int`; `measurement_ids_from_sites(sites_dir) -> dict[str, str]`.

- [ ] **Step 1: Write the failing test**

`tools/ga4-provision/tests/test_cli.py`:

```python
from ga4_provision import cli


def test_measurement_ids_scraped_from_site_sources(tmp_path):
    site = tmp_path / "example.com" / "site" / "src" / "lib"
    site.mkdir(parents=True)
    (site / "analytics.ts").write_text("export const GA_ID = 'G-ABC12345';")
    result = cli.measurement_ids_from_sites(tmp_path)
    assert result["example.com"] == "G-ABC12345"


def test_placeholder_measurement_ids_are_ignored(tmp_path):
    site = tmp_path / "example.com" / "site" / "src" / "lib"
    site.mkdir(parents=True)
    (site / "analytics.ts").write_text("export const GA_ID = 'G-PLACEHOLDER';")
    assert cli.measurement_ids_from_sites(tmp_path) == {}


def test_dry_run_makes_no_grants(monkeypatch, tmp_path, capsys):
    from ga4_provision.discover import Property

    monkeypatch.setattr(cli.oauth, "user_credentials", lambda: object())
    monkeypatch.setattr(cli, "build", lambda *a, **kw: object())
    monkeypatch.setattr(cli.discover, "discover_properties",
                        lambda c: [Property("123", "example.com", "396394354")])
    monkeypatch.setattr(cli.grant, "service_account_email", lambda: "sa@x.iam.gserviceaccount.com")

    def boom(*a, **kw):
        raise AssertionError("dry run must not grant")

    monkeypatch.setattr(cli.grant, "grant_viewer", boom)
    monkeypatch.setattr(cli.registry, "REGISTRY_PATH", tmp_path / "out.yaml")

    assert cli.main(["--dry-run"]) == 0
    assert "dry-run" in capsys.readouterr().out.lower()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/ga4-provision && python -m pytest tests/test_cli.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ga4_provision.cli'`

- [ ] **Step 3: Write the CLI**

`tools/ga4-provision/src/ga4_provision/cli.py`:

```python
"""One-time GA4 provisioning: discover -> write registry -> grant the SA."""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from googleapiclient.discovery import build

from . import discover, grant, oauth, registry

SITES_DIR = Path("/home/jesse/projects/domains/sites")
GA_ID_RE = re.compile(r"G-[A-Z0-9]{8,}")
PLACEHOLDERS = {"G-PLACEHOLDER", "G-XXXXXXXXXX"}

# Both wiring patterns in the fleet: a lib module and an inline layout tag.
SEARCH_GLOBS = (
    "site/src/lib/analytics.ts",
    "site/src/layouts/*.astro",
    "site/src/components/*.astro",
)


def measurement_ids_from_sites(sites_dir: Path | None = None) -> dict[str, str]:
    """Scrape real G- IDs out of site sources, skipping placeholder guards."""
    root = Path(sites_dir) if sites_dir else SITES_DIR
    found: dict[str, str] = {}

    for site_path in sorted(p for p in root.iterdir() if p.is_dir()):
        site = site_path.name
        if site.startswith("DISABLED-"):
            continue
        for pattern in SEARCH_GLOBS:
            for path in sorted(site_path.glob(pattern)):
                try:
                    text = path.read_text(errors="ignore")
                except OSError:
                    continue
                for match in GA_ID_RE.findall(text):
                    if match not in PLACEHOLDERS:
                        found.setdefault(site, match)
            if site in found:
                break

    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="One-time GA4 provisioning.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Discover and report, but grant nothing.")
    args = parser.parse_args(argv)

    creds = oauth.user_credentials()
    client = build("analyticsadmin", "v1beta", credentials=creds, cache_discovery=False)

    properties = discover.discover_properties(client)
    print(f"Discovered {len(properties)} GA4 properties.")

    measurement_map = measurement_ids_from_sites()
    data = registry.build_registry(properties, measurement_map)

    if args.dry_run:
        print("dry-run: no registry written, no grants made.")
        for site, entry in data["sites"].items():
            print(f"  {site:<28} property={entry['ga4_property_id']:<12} "
                  f"ga={entry['ga4_measurement_id'] or '-'}")
        return 0

    registry.write_registry(data)
    print(f"Wrote {registry.REGISTRY_PATH}")

    sa_email = grant.service_account_email()
    failures = 0
    for prop in properties:
        result = grant.grant_viewer(client, prop.property_id, sa_email)
        if result.startswith("failed"):
            failures += 1
        print(f"  {prop.display_name:<28} {result}")

    print(f"\n{len(properties) - failures}/{len(properties)} properties granted.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd tools/ga4-provision && python -m pytest tests/ -v`
Expected: PASS (12 passed — 3 oauth, 2 discover, 4 registry, 3 cli)

- [ ] **Step 5: Write the README**

`tools/ga4-provision/README.md`:

```markdown
# ga4-provision

One-time, interactive. Grants the fleet service account Viewer on every GA4
property and writes the canonical site registry.

Exists because the GA4 Admin API allows granting access, but a service account
cannot grant itself access to properties it cannot see. Run once as Jesse;
everything afterwards is unattended.

## Usage

    pip install -r ../google-auth/requirements.txt
    python -m ga4_provision.cli --dry-run   # discover + report, change nothing
    python -m ga4_provision.cli             # write registry + grant

Opens a browser for Google sign-in on first run. The cached token at
`.gcp/ga4-provision-token.json` is a convenience for re-runs only — nothing
recurring depends on it.

## Output

`tools/data-hub/registry/sites-analytics.yaml` — consumed by the metrics
collector. Do not hand-edit; re-run this tool instead.
```

- [ ] **Step 6: Dry run against the real account**

Run: `cd tools/ga4-provision && python -m pytest tests/ -q && python -m ga4_provision.cli --dry-run`
Expected: browser sign-in on first run, then a table of ~16 properties with IDs. Confirm the count matches the live-site count and that no property shows a placeholder measurement ID.

- [ ] **Step 7: Commit**

```bash
git add tools/ga4-provision/src/ga4_provision/cli.py tools/ga4-provision/README.md \
        tools/ga4-provision/tests/test_cli.py
git commit -m "feat(ga4-provision): orchestrator CLI with dry-run"
```

---

## Task 8: Cloudflare DNS TXT management

**Files:**
- Create: `tools/gsc-verify/pyproject.toml`
- Create: `tools/gsc-verify/src/gsc_verify/__init__.py`
- Create: `tools/gsc-verify/src/gsc_verify/cloudflare.py`
- Test: `tools/gsc-verify/tests/test_cloudflare.py`

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces: `zone_id(client, domain) -> str | None`; `find_txt(client, zone, name, content) -> str | None`; `upsert_txt(client, zone, name, content) -> str`; `cf_client() -> httpx.Client`.

**Pattern source:** `tools/site-tracker/src/site_tracker/collectors/cloudflare.py:22-40` — same base URL, bearer auth, and timeout shape.

- [ ] **Step 1: Create the package scaffold**

`tools/gsc-verify/pyproject.toml`:

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "gsc-verify"
version = "0.1.0"
requires-python = ">=3.11"

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
pythonpath = ["src"]
testpaths = ["tests"]
```

`tools/gsc-verify/src/gsc_verify/__init__.py`:

```python
"""Verify fleet domains in Search Console via Cloudflare-written DNS TXT records."""
```

- [ ] **Step 2: Write the failing test**

`tools/gsc-verify/tests/test_cloudflare.py`:

```python
import httpx
import pytest

from gsc_verify import cloudflare


def _client(handler):
    return httpx.Client(base_url=cloudflare.BASE, transport=httpx.MockTransport(handler))


def test_zone_id_found():
    def handler(request):
        assert request.url.params["name"] == "example.com"
        return httpx.Response(200, json={"success": True, "result": [{"id": "zone123"}]})

    assert cloudflare.zone_id(_client(handler), "example.com") == "zone123"


def test_zone_id_absent_returns_none():
    def handler(request):
        return httpx.Response(200, json={"success": True, "result": []})

    assert cloudflare.zone_id(_client(handler), "nope.com") is None


def test_upsert_txt_skips_when_identical_record_exists():
    calls = {"post": 0}

    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json={
                "success": True,
                "result": [{"id": "rec1", "content": "google-site-verification=TOKEN"}],
            })
        calls["post"] += 1
        return httpx.Response(200, json={"success": True, "result": {"id": "rec2"}})

    result = cloudflare.upsert_txt(
        _client(handler), "zone123", "example.com", "google-site-verification=TOKEN"
    )
    assert result == "rec1"
    assert calls["post"] == 0


def test_upsert_txt_creates_when_absent():
    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json={"success": True, "result": []})
        body = request.read().decode()
        assert "google-site-verification=TOKEN" in body
        return httpx.Response(200, json={"success": True, "result": {"id": "rec2"}})

    result = cloudflare.upsert_txt(
        _client(handler), "zone123", "example.com", "google-site-verification=TOKEN"
    )
    assert result == "rec2"


def test_api_error_raises():
    def handler(request):
        return httpx.Response(403, json={"success": False, "errors": [{"message": "bad token"}]})

    with pytest.raises(cloudflare.CloudflareError):
        cloudflare.zone_id(_client(handler), "example.com")
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd tools/gsc-verify && python -m pytest tests/test_cloudflare.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'gsc_verify.cloudflare'`

- [ ] **Step 4: Write the Cloudflare module**

`tools/gsc-verify/src/gsc_verify/cloudflare.py`:

```python
"""Cloudflare DNS TXT management for Search Console verification.

Follows the auth/timeout pattern in
tools/site-tracker/src/site_tracker/collectors/cloudflare.py:22-40.
"""
from __future__ import annotations

import os

import httpx

BASE = "https://api.cloudflare.com/client/v4"
TIMEOUT = httpx.Timeout(15.0, connect=5.0)


class CloudflareError(RuntimeError):
    """The Cloudflare API rejected a request."""


def cf_client() -> httpx.Client:
    token = os.environ.get("CLOUDFLARE_API_TOKEN") or os.environ.get("CF_API_TOKEN", "")
    if not token:
        raise CloudflareError(
            "CLOUDFLARE_API_TOKEN not set. Expected it in "
            "/home/jesse/projects/domains/.env"
        )
    return httpx.Client(
        base_url=BASE,
        headers={"Authorization": f"Bearer {token}"},
        timeout=TIMEOUT,
    )


def _json(response: httpx.Response) -> dict:
    if response.status_code != 200:
        raise CloudflareError(f"HTTP {response.status_code}: {response.text[:200]}")
    payload = response.json()
    if not payload.get("success"):
        raise CloudflareError(f"API error: {payload.get('errors')}")
    return payload


def zone_id(client: httpx.Client, domain: str) -> str | None:
    """Return the CF zone id for a domain, or None if the zone is absent."""
    result = _json(client.get("/zones", params={"name": domain})).get("result", [])
    return result[0]["id"] if result else None


def find_txt(client: httpx.Client, zone: str, name: str, content: str) -> str | None:
    """Return the id of an existing TXT record with this exact content."""
    payload = _json(
        client.get(f"/zones/{zone}/dns_records", params={"type": "TXT", "name": name})
    )
    for record in payload.get("result", []):
        if record.get("content", "").strip('"') == content:
            return record["id"]
    return None


def upsert_txt(client: httpx.Client, zone: str, name: str, content: str) -> str:
    """Create the TXT record unless an identical one already exists.

    Idempotent: re-running never duplicates a record. Existing unrelated TXT
    records on the same name are left alone, so verifying as the service
    account never disturbs a separate human verification.
    """
    existing = find_txt(client, zone, name, content)
    if existing:
        return existing

    payload = _json(
        client.post(
            f"/zones/{zone}/dns_records",
            json={"type": "TXT", "name": name, "content": content, "ttl": 120},
        )
    )
    return payload["result"]["id"]
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd tools/gsc-verify && python -m pytest tests/test_cloudflare.py -v`
Expected: PASS (5 passed)

- [ ] **Step 6: Commit**

```bash
git add tools/gsc-verify/pyproject.toml tools/gsc-verify/src/gsc_verify/__init__.py \
        tools/gsc-verify/src/gsc_verify/cloudflare.py tools/gsc-verify/tests/test_cloudflare.py
git commit -m "feat(gsc-verify): idempotent Cloudflare DNS TXT management"
```

---

## Task 9: Site Verification API

**Files:**
- Create: `tools/gsc-verify/src/gsc_verify/verification.py`
- Test: `tools/gsc-verify/tests/test_verification.py`

**Interfaces:**
- Consumes: `google_auth_fleet.clients.site_verification` (Task 2).
- Produces: `is_verified(client, domain) -> bool`; `get_token(client, domain) -> str`; `verify(client, domain) -> str` returning `"verified"` / `"failed:<reason>"`; `dns_record_name(domain) -> str`.

**Why the service account verifies:** the Search Console API has no permissions endpoint, so access cannot be granted. A successful DNS verification makes the *verifying identity* a verified owner — the service account grants itself by proving control.

- [ ] **Step 1: Write the failing test**

`tools/gsc-verify/tests/test_verification.py`:

```python
from googleapiclient.errors import HttpError

from gsc_verify import verification


class FakeWebResource:
    def __init__(self, verified=(), error=None):
        self.verified = set(verified)
        self.error = error
        self.inserted = []

    def list(self):
        items = [{"site": {"type": "INET_DOMAIN", "identifier": d}} for d in self.verified]
        return type("R", (), {"execute": lambda _s: {"items": items}})()

    def insert(self, verificationMethod=None, body=None):
        if self.error:
            raise self.error
        self.inserted.append((verificationMethod, body))
        return type("R", (), {"execute": lambda _s: {"id": "dns://example.com"}})()


def _client(web=None):
    resource = web or FakeWebResource()
    return type("C", (), {"webResource": lambda _s: resource})()


def test_get_token_requests_dns_txt_method():
    class TokenResource(FakeWebResource):
        def getToken(self, body=None):
            assert body["verificationMethod"] == "DNS_TXT"
            assert body["site"]["identifier"] == "example.com"
            return type("R", (), {"execute": lambda _s: {"token": "TOKEN123"}})()

    assert verification.get_token(_client(TokenResource()), "example.com") == "TOKEN123"


def test_dns_record_name_is_the_bare_domain():
    assert verification.dns_record_name("example.com") == "example.com"


def test_is_verified_true_when_listed():
    web = FakeWebResource(verified=["example.com"])
    assert verification.is_verified(_client(web), "example.com") is True


def test_is_verified_false_when_absent():
    web = FakeWebResource(verified=["other.com"])
    assert verification.is_verified(_client(web), "example.com") is False


def test_verify_returns_verified_on_success():
    web = FakeWebResource()
    result = verification.verify(_client(web), "example.com")
    assert result == "verified"
    assert web.inserted[0][0] == "DNS_TXT"


def test_verify_failure_is_reported_not_raised():
    err = HttpError(type("R", (), {"status": 400, "reason": "Bad Request"})(), b"no txt")
    web = FakeWebResource(error=err)
    result = verification.verify(_client(web), "example.com")
    assert result.startswith("failed:")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/gsc-verify && python -m pytest tests/test_verification.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'gsc_verify.verification'`

- [ ] **Step 3: Write the verification module**

`tools/gsc-verify/src/gsc_verify/verification.py`:

```python
"""Site Verification API — the service account verifies domains itself.

The Search Console API exposes no permissions endpoint, so access cannot be
granted to the service account. Instead it proves control of the domain via a
DNS TXT record and becomes a verified owner in its own right.
"""
from __future__ import annotations

from googleapiclient.errors import HttpError

DNS_METHOD = "DNS_TXT"
SITE_TYPE = "INET_DOMAIN"


def dns_record_name(domain: str) -> str:
    """Google's DNS_TXT method places the record at the bare domain."""
    return domain


def get_token(client, domain: str) -> str:
    """Request the verification token to publish as a TXT record."""
    response = client.webResource().getToken(
        body={
            "site": {"type": SITE_TYPE, "identifier": domain},
            "verificationMethod": DNS_METHOD,
        }
    ).execute()
    return response["token"]


def is_verified(client, domain: str) -> bool:
    """True when this identity already owns the domain."""
    try:
        response = client.webResource().list().execute()
    except HttpError:
        return False
    for item in response.get("items", []):
        site = item.get("site", {})
        if site.get("type") == SITE_TYPE and site.get("identifier") == domain:
            return True
    return False


def verify(client, domain: str) -> str:
    """Return 'verified' or 'failed:<reason>'. Never raises."""
    try:
        client.webResource().insert(
            verificationMethod=DNS_METHOD,
            body={"site": {"type": SITE_TYPE, "identifier": domain}},
        ).execute()
        return "verified"
    except HttpError as exc:
        return f"failed:http-{getattr(exc.resp, 'status', '?')}"
    except Exception as exc:  # noqa: BLE001 - one domain must not abort the fleet
        return f"failed:{type(exc).__name__}"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd tools/gsc-verify && python -m pytest tests/test_verification.py -v`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add tools/gsc-verify/src/gsc_verify/verification.py tools/gsc-verify/tests/test_verification.py
git commit -m "feat(gsc-verify): Site Verification API token + DNS_TXT verify"
```

---

## Task 10: Search Console site registration

**Files:**
- Create: `tools/gsc-verify/src/gsc_verify/console.py`
- Test: `tools/gsc-verify/tests/test_console.py`

**Interfaces:**
- Consumes: `google_auth_fleet.clients.search_console` (Task 2).
- Produces: `add_site(client, domain) -> str`; `submit_sitemap(client, domain, sitemap_url) -> str`; `sc_property(domain) -> str`.

- [ ] **Step 1: Write the failing test**

`tools/gsc-verify/tests/test_console.py`:

```python
from googleapiclient.errors import HttpError

from gsc_verify import console


class FakeSites:
    def __init__(self, error=None):
        self.error = error
        self.added = []

    def add(self, siteUrl=None):
        if self.error:
            raise self.error
        self.added.append(siteUrl)
        return type("R", (), {"execute": lambda _s: {}})()


class FakeSitemaps:
    def __init__(self):
        self.submitted = []

    def submit(self, siteUrl=None, feedpath=None):
        self.submitted.append((siteUrl, feedpath))
        return type("R", (), {"execute": lambda _s: {}})()


def _client(sites=None, sitemaps=None):
    s, m = sites or FakeSites(), sitemaps or FakeSitemaps()
    return type("C", (), {"sites": lambda _c: s, "sitemaps": lambda _c: m})()


def test_sc_property_uses_domain_prefix():
    assert console.sc_property("example.com") == "sc-domain:example.com"


def test_add_site_uses_domain_property():
    sites = FakeSites()
    assert console.add_site(_client(sites), "example.com") == "added"
    assert sites.added == ["sc-domain:example.com"]


def test_add_site_failure_is_reported_not_raised():
    err = HttpError(type("R", (), {"status": 403, "reason": "Forbidden"})(), b"denied")
    assert console.add_site(_client(FakeSites(error=err)), "example.com").startswith("failed:")


def test_submit_sitemap_defaults_to_site_root():
    sitemaps = FakeSitemaps()
    assert console.submit_sitemap(_client(sitemaps=sitemaps), "example.com") == "submitted"
    assert sitemaps.submitted == [
        ("sc-domain:example.com", "https://example.com/sitemap.xml")
    ]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/gsc-verify && python -m pytest tests/test_console.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'gsc_verify.console'`

- [ ] **Step 3: Write the console module**

`tools/gsc-verify/src/gsc_verify/console.py`:

```python
"""Register verified domains as Search Console properties and submit sitemaps."""
from __future__ import annotations

from googleapiclient.errors import HttpError


def sc_property(domain: str) -> str:
    """Domain properties cover every subdomain and protocol."""
    return f"sc-domain:{domain}"


def add_site(client, domain: str) -> str:
    """Return 'added' or 'failed:<reason>'. Never raises."""
    try:
        client.sites().add(siteUrl=sc_property(domain)).execute()
        return "added"
    except HttpError as exc:
        return f"failed:http-{getattr(exc.resp, 'status', '?')}"
    except Exception as exc:  # noqa: BLE001
        return f"failed:{type(exc).__name__}"


def submit_sitemap(client, domain: str, sitemap_url: str | None = None) -> str:
    """Return 'submitted' or 'failed:<reason>'. Never raises."""
    feedpath = sitemap_url or f"https://{domain}/sitemap.xml"
    try:
        client.sitemaps().submit(siteUrl=sc_property(domain), feedpath=feedpath).execute()
        return "submitted"
    except HttpError as exc:
        return f"failed:http-{getattr(exc.resp, 'status', '?')}"
    except Exception as exc:  # noqa: BLE001
        return f"failed:{type(exc).__name__}"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd tools/gsc-verify && python -m pytest tests/test_console.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add tools/gsc-verify/src/gsc_verify/console.py tools/gsc-verify/tests/test_console.py
git commit -m "feat(gsc-verify): domain-property registration and sitemap submit"
```

---

## Task 11: gsc-verify orchestrator CLI

**Files:**
- Create: `tools/gsc-verify/src/gsc_verify/cli.py`
- Create: `tools/gsc-verify/README.md`
- Create: `tools/gsc-verify/requirements.txt`
- Test: `tools/gsc-verify/tests/test_cli.py`

**Interfaces:**
- Consumes: every module from Tasks 8-10.
- Produces: `verify_domain(...) -> str` (per-domain state machine); `wait_for_txt(domain, content, timeout, interval) -> bool`; `main(argv=None) -> int`.

**Per-domain state machine:** already-verified → skip. Otherwise: get token → find CF zone → upsert TXT → poll DNS → verify → `sites.add` → submit sitemap. Any step failing reports that domain's status and moves to the next domain. The TXT record is deliberately left in place on failure so a re-run resumes rather than restarts.

- [ ] **Step 1: Write the failing test**

`tools/gsc-verify/tests/test_cli.py`:

```python
from gsc_verify import cli


def test_already_verified_domain_is_skipped(monkeypatch):
    monkeypatch.setattr(cli.verification, "is_verified", lambda c, d: True)

    def boom(*a, **kw):
        raise AssertionError("must not touch DNS for a verified domain")

    monkeypatch.setattr(cli.cloudflare, "zone_id", boom)
    assert cli.verify_domain(None, None, None, "example.com") == "already-verified"


def test_missing_zone_reports_and_does_not_raise(monkeypatch):
    monkeypatch.setattr(cli.verification, "is_verified", lambda c, d: False)
    monkeypatch.setattr(cli.verification, "get_token", lambda c, d: "TOKEN")
    monkeypatch.setattr(cli.cloudflare, "zone_id", lambda c, d: None)
    result = cli.verify_domain(None, None, None, "notincf.com")
    assert result == "failed:no-cf-zone"


def test_dns_timeout_leaves_record_for_resume(monkeypatch):
    monkeypatch.setattr(cli.verification, "is_verified", lambda c, d: False)
    monkeypatch.setattr(cli.verification, "get_token", lambda c, d: "TOKEN")
    monkeypatch.setattr(cli.cloudflare, "zone_id", lambda c, d: "zone1")
    monkeypatch.setattr(cli.cloudflare, "upsert_txt", lambda c, z, n, v: "rec1")
    monkeypatch.setattr(cli, "wait_for_txt", lambda *a, **kw: False)

    deleted = []
    monkeypatch.setattr(cli.cloudflare, "find_txt", lambda *a, **kw: deleted.append(1))
    result = cli.verify_domain(None, None, None, "slow.com")
    assert result == "pending:dns-propagation"
    assert deleted == []  # record intentionally retained


def test_happy_path_runs_full_sequence(monkeypatch):
    monkeypatch.setattr(cli.verification, "is_verified", lambda c, d: False)
    monkeypatch.setattr(cli.verification, "get_token", lambda c, d: "TOKEN")
    monkeypatch.setattr(cli.cloudflare, "zone_id", lambda c, d: "zone1")
    monkeypatch.setattr(cli.cloudflare, "upsert_txt", lambda c, z, n, v: "rec1")
    monkeypatch.setattr(cli, "wait_for_txt", lambda *a, **kw: True)
    monkeypatch.setattr(cli.verification, "verify", lambda c, d: "verified")
    monkeypatch.setattr(cli.console, "add_site", lambda c, d: "added")
    monkeypatch.setattr(cli.console, "submit_sitemap", lambda c, d: "submitted")
    assert cli.verify_domain(None, None, None, "good.com") == "verified"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/gsc-verify && python -m pytest tests/test_cli.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'gsc_verify.cli'`

- [ ] **Step 3: Write the CLI**

`tools/gsc-verify/src/gsc_verify/cli.py`:

```python
"""Verify fleet domains in Search Console. Idempotent and re-runnable."""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

import yaml

from google_auth_fleet import clients

from . import cloudflare, console, verification

REGISTRY_PATH = Path(
    "/home/jesse/projects/domains/tools/data-hub/registry/sites-analytics.yaml"
)
DNS_TIMEOUT_SECONDS = 300
DNS_POLL_INTERVAL = 15


def load_domains(path: Path | None = None) -> list[str]:
    """Read site names from the registry ga4-provision wrote."""
    target = Path(path) if path else REGISTRY_PATH
    if not target.exists():
        raise FileNotFoundError(
            f"{target} not found. Run tools/ga4-provision first — it writes the registry."
        )
    data = yaml.safe_load(target.read_text()) or {}
    return sorted((data.get("sites") or {}).keys())


def wait_for_txt(
    domain: str,
    content: str,
    timeout: int = DNS_TIMEOUT_SECONDS,
    interval: int = DNS_POLL_INTERVAL,
) -> bool:
    """Poll public DNS until the TXT record resolves, or time out."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            out = subprocess.run(
                ["dig", "+short", "TXT", domain, "@8.8.8.8"],
                capture_output=True, text=True, timeout=20,
            ).stdout
            if content in out.replace('"', ""):
                return True
        except (subprocess.SubprocessError, OSError):
            pass
        time.sleep(interval)
    return False


def verify_domain(sv_client, sc_client, cf, domain: str) -> str:
    """Run the per-domain state machine. Returns a status string, never raises."""
    if verification.is_verified(sv_client, domain):
        return "already-verified"

    try:
        token = verification.get_token(sv_client, domain)
    except Exception as exc:  # noqa: BLE001
        return f"failed:token-{type(exc).__name__}"

    zone = cloudflare.zone_id(cf, domain)
    if not zone:
        return "failed:no-cf-zone"

    cloudflare.upsert_txt(cf, zone, domain, token)

    if not wait_for_txt(domain, token):
        # Record intentionally retained so a re-run resumes instead of restarting.
        return "pending:dns-propagation"

    result = verification.verify(sv_client, domain)
    if result != "verified":
        return result

    console.add_site(sc_client, domain)
    console.submit_sitemap(sc_client, domain)
    return "verified"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify fleet domains in Search Console.")
    parser.add_argument("--domain", action="append",
                        help="Limit to specific domain(s). Repeatable.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report current verification state, change nothing.")
    args = parser.parse_args(argv)

    domains = args.domain or load_domains()
    sv_client = clients.site_verification()
    sc_client = clients.search_console()

    if args.dry_run:
        print("dry-run: reporting verification state only.")
        for domain in domains:
            state = "verified" if verification.is_verified(sv_client, domain) else "unverified"
            print(f"  {domain:<28} {state}")
        return 0

    failures = 0
    with cloudflare.cf_client() as cf:
        for domain in domains:
            result = verify_domain(sv_client, sc_client, cf, domain)
            if result.startswith(("failed", "pending")):
                failures += 1
            print(f"  {domain:<28} {result}")

    print(f"\n{len(domains) - failures}/{len(domains)} domains verified.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
```

`tools/gsc-verify/requirements.txt`:

```
httpx==0.27.2
PyYAML==6.0.2
google-auth==2.35.0
google-api-python-client==2.149.0
pytest==8.3.3
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd tools/gsc-verify && python -m pytest tests/ -v`
Expected: PASS (19 passed — 5 cloudflare, 6 verification, 4 console, 4 cli)

- [ ] **Step 5: Write the README**

`tools/gsc-verify/README.md`:

```markdown
# gsc-verify

Verifies fleet domains in Google Search Console by writing a DNS TXT record
via the Cloudflare API, then verifying **as the service account**.

The Search Console API has no permissions endpoint — access cannot be granted
to a service account. A successful DNS verification instead makes the
verifying identity a verified owner. Multiple TXT records coexist, so Jesse
verifying separately for web-UI access does not conflict with this.

This clears a blocker open since 2026-05-06.

## Usage

    pip install -r requirements.txt
    python -m gsc_verify.cli --dry-run                    # report state only
    python -m gsc_verify.cli --domain xxxtea.com          # single domain
    python -m gsc_verify.cli                              # whole fleet

Requires `tools/data-hub/registry/sites-analytics.yaml` (written by
`tools/ga4-provision`) and `CLOUDFLARE_API_TOKEN` in the root `.env`.

## Behaviour

Idempotent. Already-verified domains are skipped without touching DNS.
A domain whose TXT record has not propagated within 5 minutes reports
`pending:dns-propagation` and keeps its record, so re-running resumes.
One domain failing never aborts the run.
```

- [ ] **Step 6: Dry run, then verify one real domain**

Run:

```bash
cd tools/gsc-verify
set -a && . /home/jesse/projects/domains/.env && set +a
python -m gsc_verify.cli --dry-run
python -m gsc_verify.cli --domain xxxtea.com
```

Expected: dry run lists every domain as `unverified`; the single-domain run ends `verified`. Confirm in the Search Console UI that `sc-domain:xxxtea.com` now exists. **Stop here and inspect before running the full fleet** — this is the first real mutation of external state in the plan.

- [ ] **Step 7: Commit**

```bash
git add tools/gsc-verify/src/gsc_verify/cli.py tools/gsc-verify/README.md \
        tools/gsc-verify/requirements.txt tools/gsc-verify/tests/test_cli.py
git commit -m "feat(gsc-verify): orchestrator CLI with per-domain state machine"
```

---

## Task 12: Fleet run and handoff

**Files:**
- Modify: `docs/superpowers/specs/2026-07-18-fleet-analytics-pipeline-design.md` (mark Plan 1 complete)
- Create: `tools/gsc-verify/RESULTS.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a verified fleet and `tools/data-hub/registry/sites-analytics.yaml` populated with 16 sites — the input Plan 2 builds on.

- [ ] **Step 1: Run ga4-provision for real**

```bash
cd tools/ga4-provision
python -m ga4_provision.cli
```

Expected: registry written, every property reporting `granted` or `already`. Any `failed:` line must be resolved before continuing — Plan 2 cannot read a property the SA cannot see.

- [ ] **Step 2: Confirm the registry looks right**

Run: `python -c "import yaml,sys; d=yaml.safe_load(open('/home/jesse/projects/domains/tools/data-hub/registry/sites-analytics.yaml')); print(len(d['sites']),'sites'); [print(' ',k,v['ga4_property_id'],v['ga4_measurement_id']) for k,v in d['sites'].items()]"`

Expected: 16 sites, every one with a numeric property ID. Sites showing `None` for `ga4_measurement_id` need investigating — either the site isn't wired or the scrape missed its pattern.

- [ ] **Step 3: Verify the remaining fleet**

```bash
cd tools/gsc-verify
set -a && . /home/jesse/projects/domains/.env && set +a
python -m gsc_verify.cli
```

Expected: every domain `verified` or `already-verified`. Re-run once for any `pending:dns-propagation` — propagation often completes between runs.

- [ ] **Step 4: Record the outcome**

Write `tools/gsc-verify/RESULTS.md` with the date, the final per-domain status table from Step 3, and any domain still unresolved with its reason. This is the evidence that a 10-week blocker is closed.

- [ ] **Step 5: Confirm the SA can actually read GSC data**

```bash
cd tools/gsc-verify && python -c "
from google_auth_fleet import clients
c = clients.search_console()
print([s['siteUrl'] for s in c.sites().list().execute().get('siteEntry', [])])
"
```

Expected: a list of `sc-domain:` entries matching the verified fleet. **This is the real gate for Plan 2** — if this returns empty, the pipeline has nothing to collect and Plan 2 must not start.

- [ ] **Step 6: Commit**

```bash
git add tools/gsc-verify/RESULTS.md tools/data-hub/registry/sites-analytics.yaml \
        docs/superpowers/specs/2026-07-18-fleet-analytics-pipeline-design.md
git commit -m "chore(analytics): complete Plan 1 — GA4 access granted, GSC fleet verified"
```

---

## Deferred to Later Plans

Not in this plan, tracked so nothing is lost:

- **Plan 2 (capture):** `ga4_metrics` / `gsc_metrics` tables, the two data-hub fetchers, `/metrics/*` endpoints, 7-day trailing re-pull upsert, retention carve-out from `DATAHUB_RETENTION_DAYS`, `policy: direct` egress, daily staggered cron, GA4 16-month backfill.
- **Plan 3 (consumers):** Fleet Dashboard Analytics tab, `seo-analyst` rewire + re-enable on 6 sites, dead-code removal (`tools/auth-google/`, `site-tracker/collectors/search_consoles.py`, `google-auth-library` from root `package.json`).
