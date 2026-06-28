# Social Lib — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `tools/social-lib/` — the shared primitives library used by all social media tools (VPN session, CloakBrowser session, email client, TOTP, SMS gate, credential helpers).

**Architecture:** A standalone Python package with no CLI. Five focused modules, each independently testable. All other social tools declare it as a dependency. No circular deps.

**Tech Stack:** Python 3.11+, pyotp, httpx, pyproject.toml packaging

## Global Constraints

- Python 3.11+ throughout
- No CLI in this package — library only
- All credential files written `chmod 600`
- VPN US exit: `http://127.0.0.1:8181`, EU exit: `http://127.0.0.1:8182`
- Email client API at `http://localhost:9200`
- Jesse's SMS number: `6107378479`
- `DOMAINS_ROOT` env var defaults to `/home/jesse/projects/domains`
- Package name: `social-lib`, import name: `social_lib`

---

## File Map

```
tools/social-lib/
  pyproject.toml
  src/social_lib/
    __init__.py
    vpn_session.py       ← VPN proxy context manager + URL helper
    browser_session.py   ← CloakBrowser launcher with VPN injected
    email_client.py      ← HTTP wrapper around email-client API
    totp.py             ← TOTP secret generation + code generation
    sms_gate.py         ← SMS code acquisition (manual gate + SMSPool stub)
    credentials.py      ← Cred file read/write/stub helpers
  tests/
    conftest.py
    test_vpn_session.py
    test_email_client.py
    test_totp.py
    test_sms_gate.py
    test_credentials.py
```

---

### Task 1: Package scaffold + vpn_session

**Files:**
- Create: `tools/social-lib/pyproject.toml`
- Create: `tools/social-lib/src/social_lib/__init__.py`
- Create: `tools/social-lib/src/social_lib/vpn_session.py`
- Create: `tools/social-lib/tests/conftest.py`
- Create: `tools/social-lib/tests/test_vpn_session.py`

**Interfaces:**
- Produces:
  - `social_lib.vpn_session.get_proxy_url(region="us") -> str`
  - `social_lib.vpn_session.vpn_session(region="us")` — context manager, yields proxy URL string, sets `HTTP_PROXY`/`HTTPS_PROXY` env vars for duration

- [ ] **Step 1: Create pyproject.toml**

```toml
# tools/social-lib/pyproject.toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.backends.legacy:build"

[project]
name = "social-lib"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "pyotp>=2.9",
    "httpx>=0.27",
]

[project.optional-dependencies]
dev = ["pytest>=8", "pytest-httpx>=0.30", "respx>=0.21"]

[tool.setuptools.packages.find]
where = ["src"]
```

- [ ] **Step 2: Create `__init__.py`**

```python
# tools/social-lib/src/social_lib/__init__.py
```

- [ ] **Step 3: Write failing test**

```python
# tools/social-lib/tests/test_vpn_session.py
import os
from social_lib.vpn_session import get_proxy_url, vpn_session


def test_get_proxy_url_us():
    assert get_proxy_url("us") == "http://127.0.0.1:8181"


def test_get_proxy_url_eu():
    assert get_proxy_url("eu") == "http://127.0.0.1:8182"


def test_vpn_session_sets_env():
    with vpn_session("us") as proxy:
        assert proxy == "http://127.0.0.1:8181"
        assert os.environ["HTTP_PROXY"] == "http://127.0.0.1:8181"
        assert os.environ["HTTPS_PROXY"] == "http://127.0.0.1:8181"


def test_vpn_session_restores_env():
    os.environ.pop("HTTP_PROXY", None)
    os.environ.pop("HTTPS_PROXY", None)
    with vpn_session("us"):
        pass
    assert "HTTP_PROXY" not in os.environ
    assert "HTTPS_PROXY" not in os.environ


def test_vpn_session_restores_previous_value():
    os.environ["HTTP_PROXY"] = "http://old-proxy:9999"
    with vpn_session("us"):
        assert os.environ["HTTP_PROXY"] == "http://127.0.0.1:8181"
    assert os.environ["HTTP_PROXY"] == "http://old-proxy:9999"
    del os.environ["HTTP_PROXY"]
```

- [ ] **Step 4: Run tests — expect failure**

```bash
cd tools/social-lib && pip install -e ".[dev]" -q && pytest tests/test_vpn_session.py -v
```
Expected: `ModuleNotFoundError: No module named 'social_lib'`

- [ ] **Step 5: Implement vpn_session.py**

```python
# tools/social-lib/src/social_lib/vpn_session.py
import os
from contextlib import contextmanager

US_PROXY = "http://127.0.0.1:8181"
EU_PROXY = "http://127.0.0.1:8182"
_PROXY_KEYS = ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")


def get_proxy_url(region: str = "us") -> str:
    return EU_PROXY if region == "eu" else US_PROXY


@contextmanager
def vpn_session(region: str = "us"):
    proxy = get_proxy_url(region)
    saved = {k: os.environ.get(k) for k in _PROXY_KEYS}
    for k in _PROXY_KEYS:
        os.environ[k] = proxy
    try:
        yield proxy
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
```

- [ ] **Step 6: Run tests — expect pass**

```bash
pytest tests/test_vpn_session.py -v
```
Expected: 5 passed

- [ ] **Step 7: Commit**

```bash
cd tools/social-lib
git add pyproject.toml src/ tests/conftest.py tests/test_vpn_session.py
git commit -m "feat(social-lib): scaffold + vpn_session module"
```

---

### Task 2: email_client

**Files:**
- Create: `tools/social-lib/src/social_lib/email_client.py`
- Create: `tools/social-lib/tests/test_email_client.py`

**Interfaces:**
- Consumes: nothing from social-lib
- Produces:
  - `EmailClient(mailbox: str, api_key: str | None = None)`
  - `.wait_for_message(to_addr: str, subject_contains: str = "", timeout: int = 120) -> dict` — long-polls `/mailbox/{mailbox}/wait`, raises `httpx.HTTPStatusError` on failure
  - `.ensure_alias(domain: str, local_part: str, cf_token: str, cf_account_id: str) -> bool` — creates CF Email Routing rule; returns True if created, False if already existed

- [ ] **Step 1: Write failing tests**

```python
# tools/social-lib/tests/test_email_client.py
import pytest
import respx
import httpx
from social_lib.email_client import EmailClient


MAILBOX = "jessetamburino@hotmail.com"
API = "http://localhost:9200"


@respx.mock
def test_wait_for_message_returns_message():
    respx.post(f"{API}/mailbox/{MAILBOX}/wait").mock(
        return_value=httpx.Response(200, json={"message": {"id": 1, "body_text": "Your code is 123456", "to": "jane@test.com"}})
    )
    client = EmailClient(MAILBOX)
    msg = client.wait_for_message("jane@test.com", timeout=5)
    assert msg["body_text"] == "Your code is 123456"


@respx.mock
def test_wait_for_message_sends_correct_payload():
    route = respx.post(f"{API}/mailbox/{MAILBOX}/wait").mock(
        return_value=httpx.Response(200, json={"message": {"id": 1, "to": "jane@test.com", "body_text": "code"}})
    )
    client = EmailClient(MAILBOX)
    client.wait_for_message("jane@test.com", subject_contains="verify", timeout=30)
    sent = route.calls[0].request
    import json
    body = json.loads(sent.content)
    assert body["match"]["to"] == "jane@test.com"
    assert body["match"]["subject"] == "verify"
    assert body["timeout_seconds"] == 30


@respx.mock
def test_wait_for_message_raises_on_error():
    respx.post(f"{API}/mailbox/{MAILBOX}/wait").mock(
        return_value=httpx.Response(504, json={"detail": "timeout"})
    )
    client = EmailClient(MAILBOX)
    with pytest.raises(httpx.HTTPStatusError):
        client.wait_for_message("jane@test.com", timeout=1)


@respx.mock
def test_api_key_sent_as_header():
    route = respx.post(f"{API}/mailbox/{MAILBOX}/wait").mock(
        return_value=httpx.Response(200, json={"message": {"id": 1, "to": "x@y.com", "body_text": ""}})
    )
    client = EmailClient(MAILBOX, api_key="secret-key")
    client.wait_for_message("x@y.com", timeout=5)
    assert route.calls[0].request.headers["x-api-key"] == "secret-key"
```

- [ ] **Step 2: Run — expect failure**

```bash
pytest tests/test_email_client.py -v
```
Expected: `ImportError: cannot import name 'EmailClient'`

- [ ] **Step 3: Implement email_client.py**

```python
# tools/social-lib/src/social_lib/email_client.py
from __future__ import annotations
import httpx

EMAIL_API = "http://localhost:9200"


class EmailClient:
    def __init__(self, mailbox: str, api_key: str | None = None):
        self.mailbox = mailbox
        self._headers = {"x-api-key": api_key} if api_key else {}

    def wait_for_message(
        self,
        to_addr: str,
        subject_contains: str = "",
        timeout: int = 120,
    ) -> dict:
        resp = httpx.post(
            f"{EMAIL_API}/mailbox/{self.mailbox}/wait",
            json={
                "match": {"to": to_addr, "subject": subject_contains},
                "timeout_seconds": timeout,
            },
            headers=self._headers,
            timeout=timeout + 15,
        )
        resp.raise_for_status()
        return resp.json()["message"]

    def ensure_alias(
        self,
        domain: str,
        local_part: str,
        cf_token: str,
        cf_zone_id: str,
    ) -> bool:
        """Create CF Email Routing rule local_part@domain → hotmail. Returns True if created."""
        address = f"{local_part}@{domain}"
        headers = {"Authorization": f"Bearer {cf_token}", "Content-Type": "application/json"}
        list_resp = httpx.get(
            f"https://api.cloudflare.com/client/v4/zones/{cf_zone_id}/email/routing/rules",
            headers=headers,
        )
        list_resp.raise_for_status()
        for rule in list_resp.json().get("result", []):
            for matcher in rule.get("matchers", []):
                if matcher.get("value") == address:
                    return False  # already exists
        create_resp = httpx.post(
            f"https://api.cloudflare.com/client/v4/zones/{cf_zone_id}/email/routing/rules",
            headers=headers,
            json={
                "enabled": True,
                "matchers": [{"field": "to", "type": "literal", "value": address}],
                "actions": [{"type": "forward", "value": ["jessetamburino@hotmail.com"]}],
            },
        )
        create_resp.raise_for_status()
        return True
```

- [ ] **Step 4: Run — expect pass**

```bash
pytest tests/test_email_client.py -v
```
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/social_lib/email_client.py tests/test_email_client.py
git commit -m "feat(social-lib): email_client module"
```

---

### Task 3: totp

**Files:**
- Create: `tools/social-lib/src/social_lib/totp.py`
- Create: `tools/social-lib/tests/test_totp.py`

**Interfaces:**
- Produces:
  - `generate_secret() -> str` — returns 32-char base32 string
  - `current_code(secret: str) -> str` — returns 6-digit string
  - `get_uri(secret: str, account: str, issuer: str) -> str` — returns `otpauth://` URI for QR codes

- [ ] **Step 1: Write failing tests**

```python
# tools/social-lib/tests/test_totp.py
import re
from social_lib.totp import generate_secret, current_code, get_uri


def test_generate_secret_is_base32():
    secret = generate_secret()
    assert re.match(r"^[A-Z2-7]+=*$", secret)
    assert len(secret) == 32


def test_current_code_is_six_digits():
    secret = generate_secret()
    code = current_code(secret)
    assert re.match(r"^\d{6}$", code)


def test_current_code_consistent_within_window():
    secret = generate_secret()
    assert current_code(secret) == current_code(secret)


def test_get_uri_format():
    uri = get_uri("ABCDEFGHIJKLMNOP", "jane@example.com", "ExampleApp")
    assert uri.startswith("otpauth://totp/")
    assert "jane%40example.com" in uri or "jane@example.com" in uri
    assert "ExampleApp" in uri
    assert "secret=ABCDEFGHIJKLMNOP" in uri
```

- [ ] **Step 2: Run — expect failure**

```bash
pytest tests/test_totp.py -v
```

- [ ] **Step 3: Implement totp.py**

```python
# tools/social-lib/src/social_lib/totp.py
import pyotp


def generate_secret() -> str:
    return pyotp.random_base32()


def current_code(secret: str) -> str:
    return pyotp.TOTP(secret).now()


def get_uri(secret: str, account: str, issuer: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=account, issuer_name=issuer)
```

- [ ] **Step 4: Run — expect pass**

```bash
pytest tests/test_totp.py -v
```
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/social_lib/totp.py tests/test_totp.py
git commit -m "feat(social-lib): totp module"
```

---

### Task 4: sms_gate

**Files:**
- Create: `tools/social-lib/src/social_lib/sms_gate.py`
- Create: `tools/social-lib/tests/test_sms_gate.py`

**Interfaces:**
- Produces:
  - `MANUAL_NUMBER: str` — `"6107378479"`
  - `manual_gate(gate_name: str, number: str = MANUAL_NUMBER) -> str` — writes gate file, blocks until Jesse writes code to `.continue` file, returns code string
  - `smspool_gate(platform: str, gate_name: str) -> str` — raises `NotImplementedError` (Meta phase stub)

- [ ] **Step 1: Write failing tests**

```python
# tools/social-lib/tests/test_sms_gate.py
import threading
import time
from pathlib import Path
import pytest
from social_lib.sms_gate import MANUAL_NUMBER, manual_gate, smspool_gate

GATE_DIR = Path("/tmp/cloak-gates")


def test_manual_number_is_jesse():
    assert MANUAL_NUMBER == "6107378479"


def test_manual_gate_returns_code(tmp_path, monkeypatch):
    monkeypatch.setattr("social_lib.sms_gate.GATE_DIR", tmp_path)

    def write_code_after_delay():
        time.sleep(0.2)
        (tmp_path / "test-gate.continue").write_text("987654")

    t = threading.Thread(target=write_code_after_delay)
    t.start()
    code = manual_gate("test-gate", number="5550001234")
    t.join()
    assert code == "987654"


def test_manual_gate_cleans_up(tmp_path, monkeypatch):
    monkeypatch.setattr("social_lib.sms_gate.GATE_DIR", tmp_path)

    def write_code():
        time.sleep(0.1)
        (tmp_path / "cleanup-gate.continue").write_text("111222")

    t = threading.Thread(target=write_code)
    t.start()
    manual_gate("cleanup-gate")
    t.join()
    assert not (tmp_path / "cleanup-gate.waiting").exists()
    assert not (tmp_path / "cleanup-gate.continue").exists()


def test_smspool_gate_raises_not_implemented():
    with pytest.raises(NotImplementedError):
        smspool_gate("instagram", "some-gate")
```

- [ ] **Step 2: Run — expect failure**

```bash
pytest tests/test_sms_gate.py -v
```

- [ ] **Step 3: Implement sms_gate.py**

```python
# tools/social-lib/src/social_lib/sms_gate.py
from __future__ import annotations
import json
import time
from pathlib import Path

GATE_DIR = Path("/tmp/cloak-gates")
GATE_DIR.mkdir(parents=True, exist_ok=True)

MANUAL_NUMBER = "6107378479"


def manual_gate(gate_name: str, number: str = MANUAL_NUMBER) -> str:
    """Block until Jesse enters the SMS code. Returns the code string."""
    GATE_DIR.mkdir(parents=True, exist_ok=True)
    waiting = GATE_DIR / f"{gate_name}.waiting"
    continue_file = GATE_DIR / f"{gate_name}.continue"

    continue_file.unlink(missing_ok=True)
    waiting.write_text(json.dumps({
        "message": f"SMS verification needed — check {number} for the code",
        "number": number,
        "gate": gate_name,
    }))
    print(f"\n[SMS GATE] Code sent to {number}. Write it to {continue_file} to continue.")

    while True:
        if continue_file.exists():
            code = continue_file.read_text().strip()
            continue_file.unlink(missing_ok=True)
            waiting.unlink(missing_ok=True)
            return code
        time.sleep(1)


def smspool_gate(platform: str, gate_name: str) -> str:
    """SMSPool API — Meta phase only. Requires SMSPOOL_API_KEY env var."""
    raise NotImplementedError("SMSPool integration not yet implemented — Meta phase")
```

- [ ] **Step 4: Run — expect pass**

```bash
pytest tests/test_sms_gate.py -v
```
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/social_lib/sms_gate.py tests/test_sms_gate.py
git commit -m "feat(social-lib): sms_gate module"
```

---

### Task 5: credentials

**Files:**
- Create: `tools/social-lib/src/social_lib/credentials.py`
- Create: `tools/social-lib/tests/test_credentials.py`

**Interfaces:**
- Produces:
  - `site_root(domain: str) -> Path` — `$DOMAINS_ROOT/sites/<domain>`
  - `cred_path(domain: str, platform: str) -> Path` — `.../ops/social/.<platform>-creds`
  - `write_creds(domain: str, platform: str, data: dict) -> None` — writes KEY=VALUE, chmod 600
  - `read_creds(domain: str, platform: str) -> dict` — parses KEY=VALUE, skips `#` lines
  - `has_creds(domain: str, platform: str) -> bool` — True if file exists and non-empty
  - `write_stub(domain: str, platform: str) -> None` — writes `# deferred\n` stub if not exists

- [ ] **Step 1: Write failing tests**

```python
# tools/social-lib/tests/test_credentials.py
import os
import stat
from pathlib import Path
import pytest
from social_lib.credentials import (
    site_root, cred_path, write_creds, read_creds, has_creds, write_stub
)


@pytest.fixture
def fake_root(tmp_path, monkeypatch):
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    return tmp_path


def test_site_root(fake_root):
    assert site_root("example.com") == fake_root / "sites" / "example.com"


def test_cred_path(fake_root):
    p = cred_path("example.com", "bluesky")
    assert p == fake_root / "sites" / "example.com" / "ops" / "social" / ".bluesky-creds"


def test_write_read_roundtrip(fake_root):
    write_creds("example.com", "bluesky", {"HANDLE": "test.bsky.social", "PASSWORD": "s3cr3t"})
    result = read_creds("example.com", "bluesky")
    assert result["HANDLE"] == "test.bsky.social"
    assert result["PASSWORD"] == "s3cr3t"


def test_write_creds_chmod_600(fake_root):
    write_creds("example.com", "reddit", {"USER": "testuser"})
    path = cred_path("example.com", "reddit")
    mode = stat.S_IMODE(path.stat().st_mode)
    assert mode == 0o600


def test_read_creds_skips_comments(fake_root):
    write_creds("example.com", "x", {"KEY": "value"})
    path = cred_path("example.com", "x")
    path.write_text("# comment\nKEY=value\n# another comment\nOTHER=thing\n")
    result = read_creds("example.com", "x")
    assert "KEY" in result
    assert "OTHER" in result
    assert len(result) == 2


def test_has_creds_false_when_missing(fake_root):
    assert not has_creds("example.com", "tiktok")


def test_has_creds_true_when_written(fake_root):
    write_creds("example.com", "tiktok", {"USER": "x"})
    assert has_creds("example.com", "tiktok")


def test_write_stub_creates_file(fake_root):
    write_stub("example.com", "facebook")
    path = cred_path("example.com", "facebook")
    assert path.exists()
    assert "deferred" in path.read_text()


def test_write_stub_does_not_overwrite(fake_root):
    write_creds("example.com", "instagram", {"USER": "real"})
    write_stub("example.com", "instagram")
    result = read_creds("example.com", "instagram")
    assert result["USER"] == "real"
```

- [ ] **Step 2: Run — expect failure**

```bash
pytest tests/test_credentials.py -v
```

- [ ] **Step 3: Implement credentials.py**

```python
# tools/social-lib/src/social_lib/credentials.py
from __future__ import annotations
import os
from pathlib import Path


def site_root(domain: str) -> Path:
    base = os.environ.get("DOMAINS_ROOT", "/home/jesse/projects/domains")
    return Path(base) / "sites" / domain


def cred_path(domain: str, platform: str) -> Path:
    return site_root(domain) / "ops" / "social" / f".{platform}-creds"


def write_creds(domain: str, platform: str, data: dict) -> None:
    path = cred_path(domain, platform)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(f"{k}={v}" for k, v in data.items()) + "\n")
    path.chmod(0o600)


def read_creds(domain: str, platform: str) -> dict:
    path = cred_path(domain, platform)
    if not path.exists():
        return {}
    result = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        result[k.strip()] = v.strip()
    return result


def has_creds(domain: str, platform: str) -> bool:
    path = cred_path(domain, platform)
    return path.exists() and path.stat().st_size > 0


def write_stub(domain: str, platform: str) -> None:
    path = cred_path(domain, platform)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text("# deferred\n")
        path.chmod(0o600)
```

- [ ] **Step 4: Run — expect pass**

```bash
pytest tests/test_credentials.py -v
```
Expected: 9 passed

- [ ] **Step 5: Run full suite**

```bash
pytest -v
```
Expected: all tests passing across all modules

- [ ] **Step 6: Install into local environment**

```bash
cd /home/jesse/projects/domains/tools/social-lib
pip install -e .
```

- [ ] **Step 7: Commit**

```bash
git add src/social_lib/credentials.py tests/test_credentials.py
git commit -m "feat(social-lib): credentials module + full suite green"
```

---

### Task 6: browser_session

**Files:**
- Create: `tools/social-lib/src/social_lib/browser_session.py`

**Interfaces:**
- Consumes: `vpn_session.get_proxy_url(region) -> str`
- Produces:
  - `cloak_args(region: str = "us") -> list[str]` — returns list of CLI flags to pass to CloakBrowser including `--proxy-server=...`
  - `gate_wait(gate_name: str, message: str) -> None` — writes gate `.waiting` file, blocks until `.continue` or `.skip`
  - `gate_continue(gate_name: str) -> None` — writes `.continue` file to unblock a gate (used by orchestrator)
  - `GATE_DIR: Path`

Note: No automated tests for the actual browser launch (requires display). Tests cover only the gate mechanism and args generation.

- [ ] **Step 1: Write failing tests**

```python
# tools/social-lib/tests/test_browser_session.py
import threading
import time
from pathlib import Path
import pytest
from social_lib.browser_session import cloak_args, gate_wait, gate_continue, GATE_DIR


def test_cloak_args_includes_proxy():
    args = cloak_args("us")
    assert any("127.0.0.1:8181" in a for a in args)


def test_cloak_args_eu_proxy():
    args = cloak_args("eu")
    assert any("127.0.0.1:8182" in a for a in args)


def test_gate_wait_unblocks_on_continue(tmp_path, monkeypatch):
    monkeypatch.setattr("social_lib.browser_session.GATE_DIR", tmp_path)

    def signal():
        time.sleep(0.2)
        gate_continue.__wrapped__ = None  # ensure we test through the module
        (tmp_path / "mygate.continue").write_text("")

    t = threading.Thread(target=signal)
    t.start()
    gate_wait("mygate", "Please do something")
    t.join()
    assert not (tmp_path / "mygate.waiting").exists()
```

- [ ] **Step 2: Implement browser_session.py**

```python
# tools/social-lib/src/social_lib/browser_session.py
from __future__ import annotations
import json
import time
from pathlib import Path
from .vpn_session import get_proxy_url

GATE_DIR = Path("/tmp/cloak-gates")
SCREENSHOT_DIR = Path("/home/jesse/projects/domains/.cloak-screenshots")


def cloak_args(region: str = "us") -> list[str]:
    """CLI args to inject VPN proxy into a CloakBrowser launch."""
    return [f"--proxy-server={get_proxy_url(region)}"]


def gate_wait(gate_name: str, message: str) -> None:
    """Block until orchestrator writes <gate_name>.continue file."""
    GATE_DIR.mkdir(parents=True, exist_ok=True)
    waiting = GATE_DIR / f"{gate_name}.waiting"
    continue_file = GATE_DIR / f"{gate_name}.continue"
    skip_file = GATE_DIR / f"{gate_name}.skip"

    continue_file.unlink(missing_ok=True)
    skip_file.unlink(missing_ok=True)
    waiting.write_text(json.dumps({"message": message, "gate": gate_name}))
    print(f"\n[GATE] {message}\n[GATE] Write to {continue_file} to continue.")

    while True:
        if continue_file.exists() or skip_file.exists():
            for f in (continue_file, skip_file, waiting):
                f.unlink(missing_ok=True)
            return
        time.sleep(1)


def gate_continue(gate_name: str, code: str = "") -> None:
    """Signal a waiting gate to continue (used by orchestrator)."""
    GATE_DIR.mkdir(parents=True, exist_ok=True)
    (GATE_DIR / f"{gate_name}.continue").write_text(code)
```

- [ ] **Step 3: Run tests**

```bash
pytest tests/test_browser_session.py -v
```
Expected: 3 passed

- [ ] **Step 4: Commit**

```bash
git add src/social_lib/browser_session.py tests/test_browser_session.py
git commit -m "feat(social-lib): browser_session module"
```
