# Social Setup Extensions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing `tools/social-setup/` with VPN injection, TOTP enrollment after every signup, LinkedIn as a new platform, and Facebook/Instagram as disabled stubs. Wire social-lib as the shared primitive layer.

**Architecture:** Minimal changes to existing code — add VPN to `cloak_driver.py`, add TOTP enrollment step to each platform's flow, add `linkedin.py`, update `cli.py` for `--include-meta` flag, add `facebook.py`/`instagram.py` stubs.

**Tech Stack:** Existing stack (Playwright/CloakBrowser, click, httpx, rich) + social-lib dependency

**Prerequisite:** `tools/social-lib/` must be installed (`pip install -e tools/social-lib/`)

## Global Constraints

- Do NOT rewrite existing platform flows — add VPN + TOTP as incremental changes
- LinkedIn follows the same `platforms/` pattern as existing modules
- Facebook + Instagram raise `PlatformDeferred` unless `--include-meta` CLI flag is passed
- TOTP secret stored as `TOTP_SECRET` field in existing cred file format
- VPN proxy: `http://127.0.0.1:8181` (US, default for all signups)
- All browser sessions go through VPN — no exceptions

---

## File Map

```
tools/social-setup/src/social_setup/
  cloak_driver.py          ← MODIFY: inject VPN proxy into every launch
  platforms/
    base.py               ← MODIFY: add enroll_totp() hook + call after signup
    linkedin.py           ← CREATE: LinkedIn provisioner
    facebook.py           ← CREATE: PlatformDeferred stub
    instagram.py          ← CREATE: PlatformDeferred stub
  cli.py                  ← MODIFY: add --include-meta flag, add linkedin to default list
  exceptions.py           ← CREATE: PlatformDeferred exception
tests/
  test_linkedin_flow.py   ← CREATE
  test_meta_stubs.py      ← CREATE
```

---

### Task 1: exceptions + PlatformDeferred

**Files:**
- Create: `tools/social-setup/src/social_setup/exceptions.py`
- Create: `tools/social-setup/tests/test_meta_stubs.py`

**Interfaces:**
- Produces: `PlatformDeferred(message: str)` — exception raised by Facebook/Instagram stubs

- [ ] **Step 1: Write failing test**

```python
# tools/social-setup/tests/test_meta_stubs.py
import pytest
from social_setup.exceptions import PlatformDeferred
from social_setup.platforms.facebook import FacebookPlatform
from social_setup.platforms.instagram import InstagramPlatform


def test_facebook_raises_deferred():
    p = FacebookPlatform()
    with pytest.raises(PlatformDeferred, match="--include-meta"):
        p.provision("example.com", brand=None, browser=None)


def test_instagram_raises_deferred():
    p = InstagramPlatform()
    with pytest.raises(PlatformDeferred, match="--include-meta"):
        p.provision("example.com", brand=None, browser=None)
```

- [ ] **Step 2: Run — expect ImportError**

```bash
cd tools/social-setup && pytest tests/test_meta_stubs.py -v
```

- [ ] **Step 3: Create exceptions.py**

```python
# tools/social-setup/src/social_setup/exceptions.py


class PlatformDeferred(Exception):
    """Raised when a platform is intentionally disabled pending a future phase."""
```

- [ ] **Step 4: Create facebook.py stub**

```python
# tools/social-setup/src/social_setup/platforms/facebook.py
from social_setup.exceptions import PlatformDeferred
from social_lib.credentials import write_stub


class FacebookPlatform:
    name = "facebook"

    def provision(self, domain: str, brand, browser) -> dict:
        write_stub(domain, "facebook")
        raise PlatformDeferred(
            "Facebook provisioning deferred — run with --include-meta when ready"
        )
```

- [ ] **Step 5: Create instagram.py stub**

```python
# tools/social-setup/src/social_setup/platforms/instagram.py
from social_setup.exceptions import PlatformDeferred
from social_lib.credentials import write_stub


class InstagramPlatform:
    name = "instagram"

    def provision(self, domain: str, brand, browser) -> dict:
        write_stub(domain, "instagram")
        raise PlatformDeferred(
            "Instagram provisioning deferred — run with --include-meta when ready"
        )
```

- [ ] **Step 6: Run — expect pass**

```bash
pytest tests/test_meta_stubs.py -v
```
Expected: 2 passed

- [ ] **Step 7: Commit**

```bash
git add src/social_setup/exceptions.py src/social_setup/platforms/facebook.py src/social_setup/platforms/instagram.py tests/test_meta_stubs.py
git commit -m "feat(social-setup): PlatformDeferred + Facebook/Instagram stubs"
```

---

### Task 2: Wire VPN into cloak_driver

**Files:**
- Modify: `tools/social-setup/src/social_setup/cloak_driver.py`

**Interfaces:**
- Consumes: `social_lib.vpn_session.get_proxy_url(region="us") -> str`
- Produces: no API change — every CloakBrowser instance now receives `--proxy-server=http://127.0.0.1:8181` automatically

- [ ] **Step 1: Read existing cloak_driver.py**

```bash
cat tools/social-setup/src/social_setup/cloak_driver.py
```
Find the line(s) where the browser is launched — look for `playwright.chromium.launch(` or similar.

- [ ] **Step 2: Add social-lib dependency to pyproject.toml**

Open `tools/social-setup/pyproject.toml`. In `[project] dependencies`, add:
```
"social-lib @ file:///home/jesse/projects/domains/tools/social-lib",
```
Then reinstall: `pip install -e tools/social-setup/`

- [ ] **Step 3: Inject proxy into launch call**

Find the browser launch in `cloak_driver.py`. It will look something like:
```python
browser = playwright.chromium.launch(headless=False, ...)
```

Change to:
```python
from social_lib.vpn_session import get_proxy_url

proxy_url = get_proxy_url("us")
browser = playwright.chromium.launch(
    headless=False,
    proxy={"server": proxy_url},
    ...  # existing args unchanged
)
```

If the launch uses `args=[]`, add `f"--proxy-server={proxy_url}"` to the args list instead — whichever pattern the existing code uses.

- [ ] **Step 4: Manual smoke test**

```bash
cd tools/social-setup
python -c "
from social_setup.cloak_driver import CloakDriver
print('Import OK — VPN will be injected at launch')
"
```
Expected: no ImportError

- [ ] **Step 5: Commit**

```bash
git add src/social_setup/cloak_driver.py pyproject.toml
git commit -m "feat(social-setup): inject VPN proxy into every CloakBrowser session"
```

---

### Task 3: TOTP enrollment in base platform

**Files:**
- Modify: `tools/social-setup/src/social_setup/platforms/base.py`
- Create: `tools/social-setup/tests/test_totp_enrollment.py`

**Interfaces:**
- Consumes: `social_lib.totp.generate_secret() -> str`, `social_lib.totp.current_code(secret) -> str`
- Produces: `BasePlatform.generate_and_store_totp(domain: str, platform: str) -> str` — generates secret, stores it in cred file as `TOTP_SECRET`, returns secret

- [ ] **Step 1: Read existing base.py**

```bash
cat tools/social-setup/src/social_setup/platforms/base.py
```

- [ ] **Step 2: Write failing test**

```python
# tools/social-setup/tests/test_totp_enrollment.py
import os
import pytest
from social_setup.platforms.base import BasePlatform
from social_lib.credentials import read_creds


@pytest.fixture
def fake_root(tmp_path, monkeypatch):
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    return tmp_path


def test_generate_and_store_totp_writes_secret(fake_root):
    # Ensure the social/ dir and a cred stub exist first
    cred_dir = fake_root / "sites" / "example.com" / "ops" / "social"
    cred_dir.mkdir(parents=True)
    (cred_dir / ".bluesky-creds").write_text("HANDLE=test\n")
    (cred_dir / ".bluesky-creds").chmod(0o600)

    platform = BasePlatform()
    secret = platform.generate_and_store_totp("example.com", "bluesky")

    assert len(secret) == 32
    creds = read_creds("example.com", "bluesky")
    assert creds["TOTP_SECRET"] == secret


def test_generate_and_store_totp_returns_valid_code(fake_root):
    import re
    from social_lib.totp import current_code

    cred_dir = fake_root / "sites" / "example.com" / "ops" / "social"
    cred_dir.mkdir(parents=True)
    (cred_dir / ".reddit-creds").write_text("USER=test\n")
    (cred_dir / ".reddit-creds").chmod(0o600)

    platform = BasePlatform()
    secret = platform.generate_and_store_totp("example.com", "reddit")
    code = current_code(secret)
    assert re.match(r"^\d{6}$", code)
```

- [ ] **Step 3: Run — expect failure**

```bash
pytest tests/test_totp_enrollment.py -v
```

- [ ] **Step 4: Add generate_and_store_totp to BasePlatform**

In `platforms/base.py`, add this method to `BasePlatform`:

```python
from social_lib.totp import generate_secret
from social_lib.credentials import read_creds, write_creds

def generate_and_store_totp(self, domain: str, platform_name: str) -> str:
    """Generate TOTP secret, append to existing cred file, return secret."""
    secret = generate_secret()
    existing = read_creds(domain, platform_name)
    existing["TOTP_SECRET"] = secret
    write_creds(domain, platform_name, existing)
    return secret
```

- [ ] **Step 5: Run — expect pass**

```bash
pytest tests/test_totp_enrollment.py -v
```
Expected: 2 passed

- [ ] **Step 6: Commit**

```bash
git add src/social_setup/platforms/base.py tests/test_totp_enrollment.py
git commit -m "feat(social-setup): generate_and_store_totp on BasePlatform"
```

---

### Task 4: LinkedIn platform

**Files:**
- Create: `tools/social-setup/src/social_setup/platforms/linkedin.py`
- Create: `tools/social-setup/tests/test_linkedin_flow.py`

**Interfaces:**
- Consumes:
  - `BasePlatform.generate_and_store_totp(domain, "linkedin") -> str`
  - `social_lib.email_client.EmailClient.wait_for_message(to_addr, subject_contains, timeout) -> dict`
  - `social_lib.sms_gate.manual_gate(gate_name, number) -> str`
  - `social_lib.credentials.write_creds(domain, "linkedin", data) -> None`
- Produces: `LinkedInPlatform.provision(domain, brand, page) -> dict` — returns `{"username": ..., "url": ...}`

- [ ] **Step 1: Write failing test (mocked — no real browser)**

```python
# tools/social-setup/tests/test_linkedin_flow.py
from unittest.mock import MagicMock, patch
from social_setup.platforms.linkedin import LinkedInPlatform


def test_linkedin_platform_has_name():
    assert LinkedInPlatform.name == "linkedin"


def test_linkedin_provision_returns_dict():
    platform = LinkedInPlatform()
    brand = MagicMock()
    brand.name = "America Strikes"
    brand.bio_short = "Defense and geopolitics news."
    brand.url = "https://americastrikes.com"
    brand.avatar_path = None

    mock_page = MagicMock()
    mock_page.url = "https://www.linkedin.com/in/test-user/"

    with patch.object(platform, "_do_signup", return_value={"username": "test@example.com", "url": "https://www.linkedin.com/in/test-user/"}):
        result = platform.provision("example.com", brand, mock_page)

    assert "username" in result
    assert "linkedin.com" in result["url"]
```

- [ ] **Step 2: Run — expect ImportError**

```bash
pytest tests/test_linkedin_flow.py -v
```

- [ ] **Step 3: Implement linkedin.py**

```python
# tools/social-setup/src/social_setup/platforms/linkedin.py
from __future__ import annotations
import os
from social_setup.platforms.base import BasePlatform
from social_lib.credentials import write_creds
from social_lib.email_client import EmailClient
from social_lib.sms_gate import manual_gate
from social_lib.totp import generate_secret


class LinkedInPlatform(BasePlatform):
    name = "linkedin"

    def provision(self, domain: str, brand, page) -> dict:
        email = f"social@{domain}"
        password = self._generate_password()

        result = self._do_signup(domain, brand, page, email, password)

        totp_secret = self.generate_and_store_totp(domain, "linkedin")
        write_creds(domain, "linkedin", {
            "LI_USERNAME": email,
            "LI_PASSWORD": password,
            "LI_PROFILE_URL": result.get("url", ""),
            "TOTP_SECRET": totp_secret,
        })
        return result

    def _do_signup(self, domain: str, brand, page, email: str, password: str) -> dict:
        """Drive CloakBrowser through LinkedIn signup. Returns {"username", "url"}."""
        # 1. Navigate to signup
        page.goto("https://www.linkedin.com/signup")
        page.wait_for_load_state("networkidle")

        # 2. Fill email + continue
        page.fill('input[id="email-address"]', email)
        page.click('button[data-id="sign-up-cta"]')
        page.wait_for_timeout(1500)

        # 3. Fill password
        page.fill('input[id="password"]', password)
        page.click('button[data-id="sign-up-submit"]')
        page.wait_for_timeout(2000)

        # 4. Fill first/last name (use brand name split or persona name)
        name_parts = brand.name.split(" ", 1) if brand else ["Social", "Editor"]
        page.fill('input[id="first-name"]', name_parts[0])
        page.fill('input[id="last-name"]', name_parts[1] if len(name_parts) > 1 else "Desk")
        page.click('button[type="submit"]')
        page.wait_for_timeout(2000)

        # 5. Email verification — auto-read from email-client
        mailbox = os.environ.get("HOTMAIL_ADDRESS", "jessetamburino@hotmail.com")
        api_key = os.environ.get("EMAIL_API_KEY")
        client = EmailClient(mailbox, api_key=api_key)
        msg = client.wait_for_message(to_addr=email, subject_contains="email", timeout=120)
        # Extract 6-digit code from body
        import re
        match = re.search(r"\b(\d{6})\b", msg.get("body_text", ""))
        if match:
            code = match.group(1)
            page.fill('input[autocomplete="one-time-code"]', code)
            page.click('button[type="submit"]')
            page.wait_for_timeout(2000)

        # 6. SMS verify gate (if triggered)
        if "phone" in page.url or page.query_selector('input[name="phoneNumber"]'):
            code = manual_gate(f"linkedin-sms-{domain}")
            page.fill('input[name="phoneNumber"]', code)
            page.click('button[type="submit"]')
            page.wait_for_timeout(2000)

        # 7. Fill profile
        if brand:
            # Skip LinkedIn's onboarding wizard steps
            for _ in range(5):
                skip = page.query_selector('button:has-text("Skip")')
                if skip:
                    skip.click()
                    page.wait_for_timeout(1000)

        profile_url = page.url
        return {"username": email, "url": profile_url}

    def _generate_password(self) -> str:
        from social_setup.passwords import generate
        return generate()
```

- [ ] **Step 4: Run tests**

```bash
pytest tests/test_linkedin_flow.py -v
```
Expected: 2 passed

- [ ] **Step 5: Register LinkedIn in platforms __init__**

Open `tools/social-setup/src/social_setup/platforms/__init__.py`. Add `LinkedInPlatform` to the `PLATFORMS` dict or list (follow existing pattern for Bluesky, Reddit, etc.).

- [ ] **Step 6: Commit**

```bash
git add src/social_setup/platforms/linkedin.py src/social_setup/platforms/__init__.py tests/test_linkedin_flow.py
git commit -m "feat(social-setup): LinkedIn platform provisioner"
```

---

### Task 5: CLI --include-meta flag + linkedin in default list

**Files:**
- Modify: `tools/social-setup/src/social_setup/cli.py`

**Interfaces:**
- Produces: `social-setup provision <domain> [--include-meta]` — when `--include-meta` absent, Facebook + Instagram raise `PlatformDeferred` which is caught and printed as a skip notice (not an error); LinkedIn included in default platform list

- [ ] **Step 1: Read existing cli.py**

```bash
cat tools/social-setup/src/social_setup/cli.py
```
Find where platforms are iterated and where errors are caught.

- [ ] **Step 2: Add --include-meta option**

In the `provision` command, add:
```python
@click.option("--include-meta", is_flag=True, default=False,
              help="Include Facebook and Instagram (requires SMSPool creds)")
```

- [ ] **Step 3: Add LinkedIn to default platforms list**

Find the `DEFAULT_PLATFORMS` list or equivalent. Add `"linkedin"` after `"tiktok"`.

- [ ] **Step 4: Handle PlatformDeferred gracefully**

In the platform iteration loop, catch `PlatformDeferred`:
```python
from social_setup.exceptions import PlatformDeferred

try:
    result = platform.provision(domain, brand, page)
    console.print(f"[green]✓ {platform.name}[/green]")
except PlatformDeferred as e:
    console.print(f"[yellow]⏸ {platform.name}: {e}[/yellow]")
    continue
except Exception as e:
    console.print(f"[red]✗ {platform.name}: {e}[/red]")
    continue
```

- [ ] **Step 5: When --include-meta absent, skip Meta platforms**

Before calling provision on Facebook/Instagram, check the flag:
```python
if platform.name in ("facebook", "instagram") and not include_meta:
    # PlatformDeferred will be raised automatically by the stub — no extra check needed
    pass
```
(The stub raises PlatformDeferred regardless — the handler above catches it.)

- [ ] **Step 6: Manual smoke test**

```bash
social-setup --help
social-setup provision --help
```
Expected: `--include-meta` appears in help output

- [ ] **Step 7: Commit**

```bash
git add src/social_setup/cli.py
git commit -m "feat(social-setup): --include-meta flag + linkedin in default list"
```

---

### Task 6: social-status.json writer

**Files:**
- Create: `tools/social-setup/src/social_setup/status.py`
- Create: `tools/social-setup/tests/test_status.py`

**Interfaces:**
- Produces:
  - `write_social_status(domain: str, platform_results: dict) -> None` — writes `ops/social/social-status.json`
  - `read_social_status(domain: str) -> dict`
  - Format: `{"bluesky": {"state": "provisioned", "provisioned_at": "2026-06-28T..."}, "facebook": {"state": "deferred"}, ...}`

- [ ] **Step 1: Write failing tests**

```python
# tools/social-setup/tests/test_status.py
import json
import os
import pytest
from social_setup.status import write_social_status, read_social_status


@pytest.fixture
def fake_root(tmp_path, monkeypatch):
    monkeypatch.setenv("DOMAINS_ROOT", str(tmp_path))
    return tmp_path


def test_write_read_roundtrip(fake_root):
    results = {
        "bluesky": {"state": "provisioned"},
        "facebook": {"state": "deferred"},
    }
    write_social_status("example.com", results)
    status = read_social_status("example.com")
    assert status["bluesky"]["state"] == "provisioned"
    assert status["facebook"]["state"] == "deferred"


def test_write_adds_timestamp(fake_root):
    write_social_status("example.com", {"reddit": {"state": "provisioned"}})
    status = read_social_status("example.com")
    assert "provisioned_at" in status["reddit"]


def test_read_returns_empty_when_missing(fake_root):
    assert read_social_status("no-such-domain.com") == {}
```

- [ ] **Step 2: Implement status.py**

```python
# tools/social-setup/src/social_setup/status.py
from __future__ import annotations
import json
from datetime import datetime, timezone
from pathlib import Path
from social_lib.credentials import site_root


def _status_path(domain: str) -> Path:
    return site_root(domain) / "ops" / "social" / "social-status.json"


def write_social_status(domain: str, platform_results: dict) -> None:
    path = _status_path(domain)
    path.parent.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()
    enriched = {}
    for platform, data in platform_results.items():
        entry = dict(data)
        if entry.get("state") == "provisioned" and "provisioned_at" not in entry:
            entry["provisioned_at"] = now
        enriched[platform] = entry
    path.write_text(json.dumps(enriched, indent=2))


def read_social_status(domain: str) -> dict:
    path = _status_path(domain)
    if not path.exists():
        return {}
    return json.loads(path.read_text())
```

- [ ] **Step 3: Run — expect pass**

```bash
pytest tests/test_status.py -v
```
Expected: 3 passed

- [ ] **Step 4: Run full test suite**

```bash
pytest -v
```
Expected: all tests passing

- [ ] **Step 5: Commit**

```bash
git add src/social_setup/status.py tests/test_status.py
git commit -m "feat(social-setup): social-status.json writer + reader"
```
