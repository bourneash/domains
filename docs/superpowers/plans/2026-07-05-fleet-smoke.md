# Fleet Smoke — Centralized Domain Health Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-off, per-site, LLM-driven `smoke-tester` role (built for xxxtea.com) with a single centralized tool — `tools/fleet-smoke/` — that reads a lightweight `ops/smoke.yaml` config from every site, runs deterministic HTTP checks, posts a rich Slack status message (✅ healthy / 🔧 recovered / 🆘 attention), and is driven by ONE fleet-wide cron container instead of N per-site LLM roles.

**Architecture:** Pure-Python check engine (`tools/fleet-smoke/lib/`) with dependency-injected I/O (curl subprocess, DNS-over-HTTPS resolution, Slack POST) so every unit is testable without real network calls. A single entrypoint (`run_fleet_smoke.py`) discovers `sites/*/ops/smoke.yaml`, skips any site missing the file or with `enabled: false`, runs each site's configured checks, computes a status icon by comparing this run's failure count against the last run's (state file, not the LLM), and staggers with a sleep between sites. Packaged as one lightweight Docker container (`docker-compose.yml` + supercronic) living in `tools/fleet-smoke/`, bind-mounting `sites/` **read-only** so per-site config edits take effect on the next tick with no rebuild — only changes to the tool's own code/schedule require a rebuild. Each site's config is data-only (routes + toggles); adding a new check *type* is a one-time change to the central `lib/checks.py`, after which every site can opt in by referencing that `type` in its own YAML.

**Tech Stack:** Python 3.12 (stdlib only + PyYAML), pytest for unit tests, curl (subprocess) for HTTP checks, Alpine + supercronic for the cron container, Slack Web API (`chat.postMessage`) via `urllib`.

## Global Constraints

- No new runtime dependency beyond `pyyaml` — everything else is Python stdlib + `curl`.
- Every I/O boundary (curl subprocess, DNS-over-HTTPS lookup, Slack POST, filesystem) must be dependency-injectable so tests never touch the network.
- Per-site config is the **only** thing that varies between sites — no per-site code, no per-site scripts, no per-site Dockerfiles.
- A site with no `ops/smoke.yaml` is silently skipped — this tool must never require a site to have opted in.
- The Slack bit-flip (`slack.enabled`) is a plain per-site boolean; default `true` in new configs, but must be respected as `false` for sites without a Slack channel yet.
- Reuses the existing shared secrets file `/home/jesse/projects/domains/.env` (`SLACK_BOT_TOKEN` + `SLACK_CHANNEL_*` vars) — no new secrets.
- xxxtea.com's existing bespoke smoke-tester (LLM role + `smoke.sh` + `notify-smoke.sh`) is retired entirely in favor of this tool, so there is exactly one code path fleet-wide.

---

## File Structure

```
tools/fleet-smoke/
├── lib/
│   ├── __init__.py
│   ├── config.py        # discover_configs(), load_config()
│   ├── checks.py         # resolve_apex_ip(), run_http_check(), run_checks()
│   ├── status.py         # load_state(), save_state(), compute_status()
│   └── slack.py          # format_message(), post_message()
├── run_fleet_smoke.py    # CLI entrypoint — orchestrates the fleet loop
├── tests/
│   ├── conftest.py
│   ├── test_config.py
│   ├── test_checks.py
│   ├── test_status.py
│   ├── test_slack.py
│   └── test_run_fleet_smoke.py
├── state/
│   └── .gitkeep          # per-site last-run fail counts, JSON, gitignored
├── docker/
│   ├── Dockerfile
│   └── crontab
├── docker-compose.yml
├── .gitignore
└── README.md

sites/<domain>/ops/smoke.yaml   # one per participating site (data-only config)
```

---

## Task 1: Config loader

**Files:**
- Create: `tools/fleet-smoke/lib/__init__.py` (empty)
- Create: `tools/fleet-smoke/lib/config.py`
- Test: `tools/fleet-smoke/tests/conftest.py`
- Test: `tools/fleet-smoke/tests/test_config.py`

**Interfaces:**
- Produces: `discover_configs(sites_dir: str) -> list[tuple[str, str]]` — list of `(site_dir, config_path)` for every `sites/*/ops/smoke.yaml` that exists, sorted by site dir.
- Produces: `load_config(config_path: str) -> dict` — parsed YAML with defaults filled in (`enabled=True`, `dns_over_https=True`, `slack={"enabled": True}`, `checks=[]`).

- [ ] **Step 1: Write the failing tests**

```python
# tools/fleet-smoke/tests/conftest.py
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
```

```python
# tools/fleet-smoke/tests/test_config.py
import os
import textwrap

from lib.config import discover_configs, load_config


def test_discover_configs_finds_only_sites_with_smoke_yaml(tmp_path):
    sites_dir = tmp_path / "sites"
    (sites_dir / "has-config.com" / "ops").mkdir(parents=True)
    (sites_dir / "has-config.com" / "ops" / "smoke.yaml").write_text("apex: has-config.com\nchecks: []\n")
    (sites_dir / "no-config.com" / "ops").mkdir(parents=True)

    found = discover_configs(str(sites_dir))

    assert len(found) == 1
    site_dir, config_path = found[0]
    assert site_dir.endswith("has-config.com")
    assert config_path.endswith("smoke.yaml")


def test_load_config_fills_defaults(tmp_path):
    config_path = tmp_path / "smoke.yaml"
    config_path.write_text(textwrap.dedent("""\
        apex: example.com
        checks:
          - path: /
            expect: 200
            label: Homepage
    """))

    config = load_config(str(config_path))

    assert config["enabled"] is True
    assert config["dns_over_https"] is True
    assert config["slack"] == {"enabled": True}
    assert config["checks"] == [{"path": "/", "expect": 200, "label": "Homepage"}]


def test_load_config_respects_explicit_values(tmp_path):
    config_path = tmp_path / "smoke.yaml"
    config_path.write_text(textwrap.dedent("""\
        apex: example.com
        enabled: false
        dns_over_https: false
        slack:
          enabled: false
        checks: []
    """))

    config = load_config(str(config_path))

    assert config["enabled"] is False
    assert config["dns_over_https"] is False
    assert config["slack"] == {"enabled": False}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/jesse/projects/domains/tools/fleet-smoke && python3 -m pytest tests/test_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'lib'` (or `lib.config`)

- [ ] **Step 3: Implement `lib/config.py`**

```python
# tools/fleet-smoke/lib/config.py
"""Discover and load per-site smoke.yaml configs."""
import glob
import os

import yaml


def discover_configs(sites_dir):
    """Return sorted [(site_dir, config_path), ...] for every sites/*/ops/smoke.yaml."""
    pattern = os.path.join(sites_dir, "*", "ops", "smoke.yaml")
    paths = sorted(glob.glob(pattern))
    return [(os.path.dirname(os.path.dirname(p)), p) for p in paths]


def load_config(config_path):
    """Load one site's smoke.yaml, filling in defaults for omitted keys."""
    with open(config_path) as f:
        data = yaml.safe_load(f) or {}

    data.setdefault("enabled", True)
    data.setdefault("dns_over_https", True)
    data.setdefault("slack", {})
    data["slack"].setdefault("enabled", True)
    data.setdefault("checks", [])
    return data
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/jesse/projects/domains/tools/fleet-smoke && python3 -m pytest tests/test_config.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/fleet-smoke/lib/__init__.py tools/fleet-smoke/lib/config.py tools/fleet-smoke/tests/conftest.py tools/fleet-smoke/tests/test_config.py
git commit -m "fleet-smoke: config discovery + loader"
```

---

## Task 2: HTTP check engine

**Files:**
- Create: `tools/fleet-smoke/lib/checks.py`
- Test: `tools/fleet-smoke/tests/test_checks.py`

**Interfaces:**
- Consumes: nothing from Task 1 directly (pure function module).
- Produces: `resolve_apex_ip(apex: str, http_get=None) -> str`, `run_http_check(apex: str, ip: str, check: dict, run_curl=None) -> dict` (keys: `label`, `path`, `expect`, `actual`, `ok`), `run_checks(config: dict, run_curl=None, http_get=None) -> list[dict]` (list of the above check-result dicts). These `run_curl`/`http_get` injection points are what Task 5's tests and this task's tests use to avoid real network calls.

- [ ] **Step 1: Write the failing tests**

```python
# tools/fleet-smoke/tests/test_checks.py
import json

from lib.checks import resolve_apex_ip, run_http_check, run_checks


def test_resolve_apex_ip_parses_doh_response():
    fake_body = json.dumps({"Answer": [{"data": "203.0.113.10"}]})

    def fake_http_get(url, headers=None):
        assert "example.com" in url
        return fake_body

    ip = resolve_apex_ip("example.com", http_get=fake_http_get)

    assert ip == "203.0.113.10"


def test_run_http_check_pass():
    check = {"path": "/", "expect": 200, "label": "Homepage"}

    def fake_run_curl(apex, ip, path):
        assert apex == "example.com"
        assert ip == "203.0.113.10"
        assert path == "/"
        return "200"

    result = run_http_check("example.com", "203.0.113.10", check, run_curl=fake_run_curl)

    assert result == {
        "label": "Homepage",
        "path": "/",
        "expect": 200,
        "actual": "200",
        "ok": True,
    }


def test_run_http_check_fail():
    check = {"path": "/go/x", "expect": 302, "label": "Affiliate redirect"}

    def fake_run_curl(apex, ip, path):
        return "503"

    result = run_http_check("example.com", "203.0.113.10", check, run_curl=fake_run_curl)

    assert result["ok"] is False
    assert result["actual"] == "503"


def test_run_checks_resolves_once_and_runs_every_check():
    config = {
        "apex": "example.com",
        "dns_over_https": True,
        "checks": [
            {"path": "/", "expect": 200, "label": "Homepage"},
            {"path": "/go/x", "expect": 302, "label": "Redirect"},
        ],
    }
    resolve_calls = []
    curl_calls = []

    def fake_http_get(url, headers=None):
        resolve_calls.append(url)
        return json.dumps({"Answer": [{"data": "203.0.113.10"}]})

    def fake_run_curl(apex, ip, path):
        curl_calls.append(path)
        return "200" if path == "/" else "302"

    results = run_checks(config, run_curl=fake_run_curl, http_get=fake_http_get)

    assert len(resolve_calls) == 1  # resolved once, reused for every check
    assert curl_calls == ["/", "/go/x"]
    assert [r["ok"] for r in results] == [True, True]


def test_run_checks_skips_dns_lookup_when_disabled():
    config = {
        "apex": "127.0.0.1",
        "dns_over_https": False,
        "checks": [{"path": "/", "expect": 200, "label": "Homepage"}],
    }

    def fake_run_curl(apex, ip, path):
        assert ip == "127.0.0.1"  # apex used directly, no DoH call
        return "200"

    def fake_http_get(url, headers=None):
        raise AssertionError("should not be called when dns_over_https is False")

    results = run_checks(config, run_curl=fake_run_curl, http_get=fake_http_get)

    assert results[0]["ok"] is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/jesse/projects/domains/tools/fleet-smoke && python3 -m pytest tests/test_checks.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'lib.checks'`

- [ ] **Step 3: Implement `lib/checks.py`**

```python
# tools/fleet-smoke/lib/checks.py
"""Deterministic HTTP checks. All network I/O is dependency-injected so this
module is fully unit-testable without touching the network."""
import json
import subprocess
import urllib.request


def _default_http_get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.read().decode()


def resolve_apex_ip(apex, http_get=None):
    """Resolve apex's A record via Cloudflare DNS-over-HTTPS — bypasses any
    local resolver/proxy quirks, matching the proven xxxtea.com smoke.sh
    technique."""
    if http_get is None:
        http_get = _default_http_get
    url = f"https://cloudflare-dns.com/dns-query?name={apex}&type=A"
    body = http_get(url, headers={"accept": "application/dns-json"})
    data = json.loads(body)
    return data["Answer"][0]["data"]


def _default_run_curl(apex, ip, path):
    result = subprocess.run(
        [
            "curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}",
            "--resolve", f"{apex}:443:{ip}", "--max-time", "15",
            f"https://{apex}{path}",
        ],
        capture_output=True, text=True, timeout=20,
    )
    return result.stdout.strip()


def run_http_check(apex, ip, check, run_curl=None):
    """Run one check dict ({path, expect, label}) and return the result."""
    if run_curl is None:
        run_curl = _default_run_curl
    path = check["path"]
    expect = check["expect"]
    label = check.get("label", path)
    actual = run_curl(apex, ip, path)
    return {
        "label": label,
        "path": path,
        "expect": expect,
        "actual": actual,
        "ok": actual == str(expect),
    }


def run_checks(config, run_curl=None, http_get=None):
    """Run every check in config['checks'] against config['apex']. Resolves
    the apex IP once (unless dns_over_https is False) and reuses it for every
    check — one DoH lookup per site, not per route."""
    apex = config["apex"]
    if config.get("dns_over_https", True):
        ip = resolve_apex_ip(apex, http_get=http_get)
    else:
        ip = apex

    results = []
    for check in config["checks"]:
        check_type = check.get("type", "http_status")
        if check_type != "http_status":
            raise ValueError(f"unknown check type: {check_type!r}")
        results.append(run_http_check(apex, ip, check, run_curl=run_curl))
    return results
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/jesse/projects/domains/tools/fleet-smoke && python3 -m pytest tests/test_checks.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/fleet-smoke/lib/checks.py tools/fleet-smoke/tests/test_checks.py
git commit -m "fleet-smoke: deterministic HTTP check engine"
```

---

## Task 3: Status/state (healthy vs. recovered vs. attention)

**Files:**
- Create: `tools/fleet-smoke/lib/status.py`
- Test: `tools/fleet-smoke/tests/test_status.py`

**Interfaces:**
- Produces: `load_state(state_dir: str, site_name: str) -> dict` (`{"fail": int}`, defaults to `{"fail": 0}` if no state file yet), `save_state(state_dir: str, site_name: str, fail_count: int) -> None`, `compute_status(fail_count: int, prev_fail_count: int) -> tuple[str, str, str]` (`icon`, Slack attachment `color`, `headline_word` — one of `"healthy"`, `"recovered"`, `"attention"`). `headline_word` is consumed by Task 4's `format_message`.

- [ ] **Step 1: Write the failing tests**

```python
# tools/fleet-smoke/tests/test_status.py
import json
import os

from lib.status import load_state, save_state, compute_status


def test_load_state_defaults_when_missing(tmp_path):
    state = load_state(str(tmp_path), "example.com")
    assert state == {"fail": 0}


def test_save_then_load_state_roundtrips(tmp_path):
    save_state(str(tmp_path), "example.com", 3)
    state = load_state(str(tmp_path), "example.com")
    assert state == {"fail": 3}

    # written under a per-site filename, not clobbering other sites
    save_state(str(tmp_path), "other.com", 0)
    assert load_state(str(tmp_path), "example.com") == {"fail": 3}
    assert load_state(str(tmp_path), "other.com") == {"fail": 0}


def test_compute_status_healthy():
    icon, color, word = compute_status(fail_count=0, prev_fail_count=0)
    assert (icon, color, word) == (":white_check_mark:", "good", "healthy")


def test_compute_status_recovered():
    icon, color, word = compute_status(fail_count=0, prev_fail_count=2)
    assert (icon, color, word) == (":wrench:", "warning", "recovered")


def test_compute_status_attention():
    icon, color, word = compute_status(fail_count=1, prev_fail_count=0)
    assert (icon, color, word) == (":sos:", "danger", "attention")


def test_compute_status_still_failing_stays_attention():
    icon, color, word = compute_status(fail_count=2, prev_fail_count=2)
    assert word == "attention"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/jesse/projects/domains/tools/fleet-smoke && python3 -m pytest tests/test_status.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'lib.status'`

- [ ] **Step 3: Implement `lib/status.py`**

```python
# tools/fleet-smoke/lib/status.py
"""Per-site last-run state, and the healthy/recovered/attention decision."""
import json
import os


def _state_path(state_dir, site_name):
    return os.path.join(state_dir, f"{site_name}.json")


def load_state(state_dir, site_name):
    path = _state_path(state_dir, site_name)
    if not os.path.exists(path):
        return {"fail": 0}
    with open(path) as f:
        return json.load(f)


def save_state(state_dir, site_name, fail_count):
    os.makedirs(state_dir, exist_ok=True)
    path = _state_path(state_dir, site_name)
    with open(path, "w") as f:
        json.dump({"fail": fail_count}, f)


def compute_status(fail_count, prev_fail_count):
    """Icon/color/word for this run, based on this run's fail count vs. the
    last run's. 'recovered' means the fleet self-healed between two ticks —
    no LLM diagnosis required, just a before/after comparison."""
    if fail_count == 0 and prev_fail_count > 0:
        return (":wrench:", "warning", "recovered")
    if fail_count == 0:
        return (":white_check_mark:", "good", "healthy")
    return (":sos:", "danger", "attention")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/jesse/projects/domains/tools/fleet-smoke && python3 -m pytest tests/test_status.py -v`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/fleet-smoke/lib/status.py tools/fleet-smoke/tests/test_status.py
git commit -m "fleet-smoke: last-run state + status icon decision"
```

---

## Task 4: Slack formatting + posting

**Files:**
- Create: `tools/fleet-smoke/lib/slack.py`
- Test: `tools/fleet-smoke/tests/test_slack.py`

**Interfaces:**
- Consumes: check-result dicts from Task 2 (`{label, path, expect, actual, ok}`), `(icon, color, headline_word)` from Task 3.
- Produces: `format_message(site_name: str, results: list[dict], icon: str, headline_word: str) -> str`, `post_message(channel: str, text: str, color: str, token: str, post_fn=None) -> bool`.

- [ ] **Step 1: Write the failing tests**

```python
# tools/fleet-smoke/tests/test_slack.py
from lib.slack import format_message, post_message


def test_format_message_healthy():
    results = [
        {"label": "Homepage", "path": "/", "expect": 200, "actual": "200", "ok": True},
        {"label": "Sitemap", "path": "/sitemap-index.xml", "expect": 200, "actual": "200", "ok": True},
    ]
    msg = format_message("xxxtea.com", results, ":white_check_mark:", "healthy")

    assert msg.startswith(":white_check_mark: *xxxtea.com is healthy — 2/2 checks green*")
    assert "• Homepage (`/`) — 200 👍" in msg
    assert "• Sitemap (`/sitemap-index.xml`) — 200 👍" in msg


def test_format_message_attention_marks_failures():
    results = [
        {"label": "Homepage", "path": "/", "expect": 200, "actual": "200", "ok": True},
        {"label": "Redirect", "path": "/go/x", "expect": 302, "actual": "503", "ok": False},
    ]
    msg = format_message("xxxtea.com", results, ":sos:", "attention")

    assert "needs attention — 1/2 check(s) failing" in msg
    assert "• Redirect (`/go/x`) — 503 ⚠️" in msg


def test_format_message_recovered_headline():
    results = [{"label": "Homepage", "path": "/", "expect": 200, "actual": "200", "ok": True}]
    msg = format_message("xxxtea.com", results, ":wrench:", "recovered")

    assert "recovered — 1/1 checks green" in msg


def test_post_message_returns_false_without_token():
    assert post_message("chan", "text", "good", token="") is False


def test_post_message_builds_expected_payload():
    captured = {}

    def fake_post_fn(payload, token):
        captured["payload"] = payload
        captured["token"] = token
        return True

    ok = post_message("domain-xxxtea-com", "hello", "good", token="xoxb-fake", post_fn=fake_post_fn)

    assert ok is True
    assert captured["token"] == "xoxb-fake"
    import json
    body = json.loads(captured["payload"])
    assert body["channel"] == "domain-xxxtea-com"
    assert body["attachments"][0]["color"] == "good"
    assert body["attachments"][0]["text"] == "hello"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/jesse/projects/domains/tools/fleet-smoke && python3 -m pytest tests/test_slack.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'lib.slack'`

- [ ] **Step 3: Implement `lib/slack.py`**

```python
# tools/fleet-smoke/lib/slack.py
"""Format the fleet-smoke status message and post it to Slack."""
import json
import urllib.request


def format_message(site_name, results, icon, headline_word):
    total = len(results)
    pass_count = sum(1 for r in results if r["ok"])
    fail_count = total - pass_count

    if headline_word == "healthy":
        headline = f"{site_name} is healthy — {pass_count}/{total} checks green"
    elif headline_word == "recovered":
        headline = f"{site_name} recovered — {pass_count}/{total} checks green"
    else:
        headline = f"{site_name} needs attention — {fail_count}/{total} check(s) failing"

    bullets = []
    for r in results:
        mark = "👍" if r["ok"] else "⚠️"
        bullets.append(f"• {r['label']} (`{r['path']}`) — {r['actual']} {mark}")

    return f"{icon} *{headline}*\n" + "\n".join(bullets)


def _default_post_fn(payload, token):
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read().decode())
            return bool(body.get("ok", False))
    except Exception:
        return False


def post_message(channel, text, color, token, post_fn=None):
    """POST one Slack message. Returns False (silent no-op) if token is empty."""
    if not token:
        return False
    if post_fn is None:
        post_fn = _default_post_fn
    payload = json.dumps({
        "channel": channel,
        "attachments": [{"color": color, "text": text, "mrkdwn_in": ["text"]}],
    }).encode()
    return post_fn(payload, token)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/jesse/projects/domains/tools/fleet-smoke && python3 -m pytest tests/test_slack.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/fleet-smoke/lib/slack.py tools/fleet-smoke/tests/test_slack.py
git commit -m "fleet-smoke: Slack message formatting + posting"
```

---

## Task 5: Fleet runner CLI

**Files:**
- Create: `tools/fleet-smoke/run_fleet_smoke.py`
- Test: `tools/fleet-smoke/tests/test_run_fleet_smoke.py`

**Interfaces:**
- Consumes: `discover_configs`/`load_config` (Task 1), `run_checks` (Task 2), `load_state`/`save_state`/`compute_status` (Task 3), `format_message`/`post_message` (Task 4).
- Produces: `check_one_site(site_dir, config_path, state_dir, slack_token, run_checks_fn=run_checks, post_fn=None) -> bool` (True iff all checks passed), a `main(argv=None) -> int` CLI entrypoint. `run_checks_fn`/`post_fn` injection lets this task's tests fake both the HTTP layer and Slack without going through Task 2/4's own injection points twice — keeps the test focused on orchestration, not on re-testing the check engine.

- [ ] **Step 1: Write the failing tests**

```python
# tools/fleet-smoke/tests/test_run_fleet_smoke.py
import os
import textwrap

from run_fleet_smoke import check_one_site, main


def _write_config(tmp_path, site, body):
    ops_dir = tmp_path / "sites" / site / "ops"
    ops_dir.mkdir(parents=True)
    (ops_dir / "smoke.yaml").write_text(textwrap.dedent(body))
    return str(tmp_path / "sites" / site), str(ops_dir / "smoke.yaml")


def test_check_one_site_skips_when_disabled(tmp_path, capsys):
    site_dir, config_path = _write_config(tmp_path, "off.com", """\
        apex: off.com
        enabled: false
        checks: []
    """)

    ok = check_one_site(site_dir, config_path, str(tmp_path / "state"), slack_token="")

    assert ok is True
    assert "disabled" in capsys.readouterr().out


def test_check_one_site_posts_slack_when_enabled(tmp_path):
    site_dir, config_path = _write_config(tmp_path, "xxxtea.com", """\
        apex: xxxtea.com
        slack:
          enabled: true
          channel_env: SLACK_CHANNEL_TEST
        checks:
          - path: /
            expect: 200
            label: Homepage
    """)
    os.environ["SLACK_CHANNEL_TEST"] = "domain-xxxtea-com"
    posted = []

    def fake_run_checks(config, run_curl=None, http_get=None):
        return [{"label": "Homepage", "path": "/", "expect": 200, "actual": "200", "ok": True}]

    def fake_post(channel, text, color, token, post_fn=None):
        posted.append((channel, color))
        return True

    ok = check_one_site(
        site_dir, config_path, str(tmp_path / "state"),
        slack_token="xoxb-fake", run_checks_fn=fake_run_checks, post_fn=fake_post,
    )

    assert ok is True
    assert posted == [("domain-xxxtea-com", "good")]


def test_check_one_site_respects_slack_bit_flip(tmp_path):
    site_dir, config_path = _write_config(tmp_path, "quiet.com", """\
        apex: quiet.com
        slack:
          enabled: false
        checks:
          - path: /
            expect: 200
            label: Homepage
    """)
    posted = []

    def fake_run_checks(config, run_curl=None, http_get=None):
        return [{"label": "Homepage", "path": "/", "expect": 200, "actual": "200", "ok": True}]

    def fake_post(channel, text, color, token, post_fn=None):
        posted.append(channel)
        return True

    check_one_site(
        site_dir, config_path, str(tmp_path / "state"),
        slack_token="xoxb-fake", run_checks_fn=fake_run_checks, post_fn=fake_post,
    )

    assert posted == []


def test_check_one_site_returns_false_on_failing_check(tmp_path):
    site_dir, config_path = _write_config(tmp_path, "broken.com", """\
        apex: broken.com
        slack:
          enabled: false
        checks:
          - path: /
            expect: 200
            label: Homepage
    """)

    def fake_run_checks(config, run_curl=None, http_get=None):
        return [{"label": "Homepage", "path": "/", "expect": 200, "actual": "500", "ok": False}]

    ok = check_one_site(
        site_dir, config_path, str(tmp_path / "state"),
        slack_token="", run_checks_fn=fake_run_checks,
    )

    assert ok is False


def test_main_reports_no_sites_found(tmp_path, capsys):
    exit_code = main(["--sites-dir", str(tmp_path / "empty"), "--state-dir", str(tmp_path / "state")])
    assert exit_code == 0
    assert "nothing to do" in capsys.readouterr().out
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/jesse/projects/domains/tools/fleet-smoke && python3 -m pytest tests/test_run_fleet_smoke.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'run_fleet_smoke'`

- [ ] **Step 3: Implement `run_fleet_smoke.py`**

```python
#!/usr/bin/env python3
"""Fleet-wide smoke test runner.

Discovers sites/*/ops/smoke.yaml, runs each site's configured checks, posts a
formatted Slack status message (unless that site's config disables it), and
staggers between sites so checks don't all fire in the same second.

Usage:
    python3 run_fleet_smoke.py [--sites-dir DIR] [--state-dir DIR]
                                [--stagger-seconds N] [--only SITE]
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.config import discover_configs, load_config
from lib.checks import run_checks as _run_checks
from lib.status import load_state, save_state, compute_status
from lib.slack import format_message, post_message as _post_message

DEFAULT_SITES_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sites")
)
DEFAULT_STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state")


def check_one_site(site_dir, config_path, state_dir, slack_token,
                    run_checks_fn=_run_checks, post_fn=_post_message):
    site_name = os.path.basename(site_dir)
    config = load_config(config_path)

    if not config.get("enabled", True):
        print(f"[{site_name}] disabled — skipping")
        return True

    try:
        results = run_checks_fn(config)
    except Exception as exc:
        print(f"[{site_name}] ERROR running checks: {exc}")
        return False

    fail_count = sum(1 for r in results if not r["ok"])
    prev = load_state(state_dir, site_name)
    icon, color, headline_word = compute_status(fail_count, prev.get("fail", 0))
    save_state(state_dir, site_name, fail_count)

    for r in results:
        mark = "PASS" if r["ok"] else "FAIL"
        print(f"[{site_name}]   {mark} {r['actual']} (want {r['expect']}) {r['path']}")
    print(f"[{site_name}] {headline_word}: {len(results) - fail_count}/{len(results)} passing")

    slack_cfg = config.get("slack", {})
    if slack_cfg.get("enabled", True):
        channel = os.environ.get(slack_cfg.get("channel_env", ""), slack_cfg.get("channel"))
        if channel:
            message = format_message(site_name, results, icon, headline_word)
            post_fn(channel, message, color, slack_token)
        else:
            print(f"[{site_name}] WARNING: slack enabled but no channel resolved "
                  f"(checked env var {slack_cfg.get('channel_env')!r})")

    return fail_count == 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sites-dir", default=DEFAULT_SITES_DIR)
    parser.add_argument("--state-dir", default=DEFAULT_STATE_DIR)
    parser.add_argument(
        "--stagger-seconds", type=int,
        default=int(os.environ.get("FLEET_SMOKE_STAGGER_SECONDS", "20")),
    )
    parser.add_argument("--only", default=None, help="only run this one site's slug")
    args = parser.parse_args(argv)

    slack_token = os.environ.get("SLACK_BOT_TOKEN", "")

    configs = discover_configs(args.sites_dir)
    if args.only:
        configs = [(d, p) for d, p in configs if os.path.basename(d) == args.only]

    if not configs:
        print("fleet-smoke: no sites/*/ops/smoke.yaml found — nothing to do")
        return 0

    print(f"fleet-smoke: {len(configs)} site(s) configured")
    all_ok = True
    for i, (site_dir, config_path) in enumerate(configs):
        ok = check_one_site(site_dir, config_path, args.state_dir, slack_token)
        all_ok = all_ok and ok
        if i < len(configs) - 1:
            time.sleep(args.stagger_seconds)

    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/jesse/projects/domains/tools/fleet-smoke && python3 -m pytest tests/test_run_fleet_smoke.py -v`
Expected: 5 passed

- [ ] **Step 5: Run the full test suite together**

Run: `cd /home/jesse/projects/domains/tools/fleet-smoke && python3 -m pytest -v`
Expected: 24 passed

- [ ] **Step 6: Commit**

```bash
cd /home/jesse/projects/domains
chmod +x tools/fleet-smoke/run_fleet_smoke.py
git add tools/fleet-smoke/run_fleet_smoke.py tools/fleet-smoke/tests/test_run_fleet_smoke.py
git commit -m "fleet-smoke: CLI entrypoint orchestrating the staggered fleet loop"
```

---

## Task 6: Docker packaging (the fleet cron container)

**Files:**
- Create: `tools/fleet-smoke/docker/Dockerfile`
- Create: `tools/fleet-smoke/docker/crontab`
- Create: `tools/fleet-smoke/docker-compose.yml`
- Create: `tools/fleet-smoke/.gitignore`
- Create: `tools/fleet-smoke/state/.gitkeep`
- Create: `tools/fleet-smoke/requirements.txt`

**Interfaces:**
- Consumes: `run_fleet_smoke.py` (Task 5) as the container's entrypoint payload.
- Produces: a running `fleet-smoke-cron` container, verified in Task 8.

- [ ] **Step 1: Pin the Python dependency**

```
# tools/fleet-smoke/requirements.txt
PyYAML==6.0.3
```

- [ ] **Step 2: Write the Dockerfile**

```dockerfile
# tools/fleet-smoke/docker/Dockerfile
# Long-running cron driver for the centralized fleet-wide smoke checks.
# Uses supercronic (cron designed for containers — logs to stdout, no syslog),
# same pattern as every per-site ops/docker/Dockerfile.cron in this repo.

FROM python:3.12-alpine

RUN apk add --no-cache bash curl tzdata ca-certificates

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

RUN wget -O /usr/local/bin/supercronic \
    https://github.com/aptible/supercronic/releases/download/v0.2.34/supercronic-linux-amd64 \
    && echo "a51b340a83c5bd035742f0d7191555f9663876405e494dbf824537d64f3e39c6  /usr/local/bin/supercronic" | sha256sum -c \
    && chmod +x /usr/local/bin/supercronic

ENV TZ=America/New_York
WORKDIR /fleet

# Non-root user matching host UID 1000 (jesse) — the ./state bind mount is
# written by this container and must stay owned by jesse on the host.
RUN addgroup -g 1000 fleet && \
    adduser -u 1000 -G fleet -h /home/fleet -s /bin/sh -D fleet

COPY lib/ /fleet/lib/
COPY run_fleet_smoke.py /fleet/run_fleet_smoke.py
COPY docker/crontab /etc/crontab.docker

RUN chown -R fleet:fleet /fleet
USER fleet

ENTRYPOINT ["supercronic", "/etc/crontab.docker"]
```

- [ ] **Step 3: Write the crontab**

```
# tools/fleet-smoke/docker/crontab (supercronic format, NOT host cron)
# TZ=America/New_York (set in the Dockerfile).
#
# One daily fleet-wide pass, 07:00 ET. Internally staggers between sites
# (FLEET_SMOKE_STAGGER_SECONDS, default 20s) so 11+ sites' checks don't all
# fire in the same second — see run_fleet_smoke.py.
#
# Config changes (sites/*/ops/smoke.yaml) are a READ-ONLY bind mount — they
# take effect on the next tick with NO rebuild. Only changes to this tool's
# own code or to this schedule require `docker compose build && up -d
# --force-recreate` (this file is baked into the image at build time).
0 7 * * *   cd /fleet && python3 run_fleet_smoke.py --sites-dir /fleet-sites --state-dir /fleet/state
```

- [ ] **Step 4: Write `docker-compose.yml`**

```yaml
# tools/fleet-smoke/docker-compose.yml
services:
  fleet-smoke-cron:
    build:
      context: .
      dockerfile: docker/Dockerfile
    image: fleet-smoke-cron:latest
    container_name: fleet-smoke-cron
    restart: unless-stopped
    env_file:
      - ../../.env
    environment:
      - TZ=America/New_York
    volumes:
      # Every site's ops/smoke.yaml, read-only — the fleet tool never writes
      # into a site's own repo.
      - ../../sites:/fleet-sites:ro
      # Per-site last-run fail counts — the only writable state, and it lives
      # here (not in any site's repo).
      - ./state:/fleet/state
```

- [ ] **Step 5: gitignore the runtime state**

```
# tools/fleet-smoke/.gitignore
state/*.json
__pycache__/
*.pyc
.pytest_cache/
```

```bash
mkdir -p /home/jesse/projects/domains/tools/fleet-smoke/state
touch /home/jesse/projects/domains/tools/fleet-smoke/state/.gitkeep
```

- [ ] **Step 6: Build and smoke the container itself (no sites configured yet)**

Run:
```bash
cd /home/jesse/projects/domains/tools/fleet-smoke
docker compose build fleet-smoke-cron
docker compose up -d fleet-smoke-cron
sleep 3
docker inspect --format '{{.State.Status}}' fleet-smoke-cron
```
Expected: `running` (Task 7/8 add real site configs and a manual dry run; this step only proves the image builds and the container stays up under supercronic with zero configs present).

- [ ] **Step 7: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/fleet-smoke/docker/ tools/fleet-smoke/docker-compose.yml tools/fleet-smoke/.gitignore tools/fleet-smoke/state/.gitkeep tools/fleet-smoke/requirements.txt
git commit -m "fleet-smoke: package as one lightweight cron container"
```

---

## Task 7: Migrate xxxtea.com onto fleet-smoke, retire its bespoke smoke-tester

**Files:**
- Create: `sites/xxxtea.com/ops/smoke.yaml`
- Delete: `sites/xxxtea.com/ops/roles/smoke-tester.md`
- Delete: `sites/xxxtea.com/ops/scripts/smoke.sh`
- Delete: `sites/xxxtea.com/ops/scripts/notify-smoke.sh`
- Modify: `sites/xxxtea.com/ops/docker/crontab.docker`
- Modify: `sites/xxxtea.com/ops/scripts/run-role.sh`

**Interfaces:**
- Produces: a config `run_fleet_smoke.py --only xxxtea.com` can execute end-to-end (verified in Task 8).

- [ ] **Step 1: Write `sites/xxxtea.com/ops/smoke.yaml`** (the 14 routes ported 1:1 from the retired `smoke.sh`)

```yaml
# sites/xxxtea.com/ops/smoke.yaml
# Consumed by tools/fleet-smoke/run_fleet_smoke.py — see
# tools/fleet-smoke/README.md for the schema. Editing this file takes effect
# on the fleet cron's next tick; no rebuild needed.
apex: xxxtea.com
enabled: true
slack:
  enabled: true
  channel_env: SLACK_CHANNEL_XXXTEA
  channel: domain-xxxtea-com   # fallback if the env var is ever unset
checks:
  - path: /
    expect: 200
    label: Homepage
  - path: /reviews/
    expect: 200
    label: Reviews index
  - path: /reviews/vahdam-imperial-earl-grey/
    expect: 200
    label: Sample review page
  - path: /leaves/black/
    expect: 200
    label: Varietal page (black tea)
  - path: /vessels/kettle/
    expect: 200
    label: Vessel page (kettle)
  - path: /brewing/
    expect: 200
    label: Brewing guide (cornerstone)
  - path: /gallery/
    expect: 200
    label: Gallery page
  - path: /vs/
    expect: 200
    label: Comparison index
  - path: /vs/fellow-stagg-ekg-vs-bonavita-gooseneck-kettle/
    expect: 200
    label: Sample comparison page
  - path: /privacy/
    expect: 200
    label: Privacy policy
  - path: /terms/
    expect: 200
    label: Terms page
  - path: /sitemap-index.xml
    expect: 200
    label: Sitemap
  - path: /go/fellow-stagg-ekg
    expect: 302
    label: Affiliate redirect (kettle)
  - path: /go/dragonwell-longjing
    expect: 302
    label: Affiliate redirect (tea)
```

- [ ] **Step 2: Retire the bespoke smoke-tester role and scripts**

```bash
cd /home/jesse/projects/domains/sites/xxxtea.com
git rm ops/roles/smoke-tester.md ops/scripts/smoke.sh ops/scripts/notify-smoke.sh
rm -f ops/.locks/smoke-tester.lock
```

- [ ] **Step 3: Remove the smoke-tester cron line from `ops/docker/crontab.docker`**

Delete these two lines (the comment header + the schedule line):
```
# Smoke — daily 6:08am ET. Verifies key routes return expected status.
# Slots between americastrikes update (:00) and aliencouncil news-desk (:18).
8 6 * * *     bash ops/scripts/run-worker.sh smoke-tester
```

- [ ] **Step 4: Remove the smoke-tester special case from `ops/scripts/run-role.sh`**

Find the case block added in the prior smoke-tester Slack-formatting work:

```bash
  case "$ROLE" in
    smoke-tester)
      # notify-smoke.sh (run by the role itself as its last step) already
      # posted a formatted status message — don't double-post here.
      ;;
    deployer|content-writer|affiliate-ops|planner)
```

Replace with the original generic allowlist (smoke-tester no longer exists as a role at all, so it needs no entry — neither an exclusion nor an inclusion):

```bash
  case "$ROLE" in
    deployer|content-writer|affiliate-ops|planner)
```

- [ ] **Step 5: Rebuild xxxtea.com's own cron container** (its `crontab.docker` changed — the "sinderella guard": a stale image would keep firing the now-deleted `smoke-tester` role)

Run:
```bash
cd /home/jesse/projects/domains/sites/xxxtea.com
docker compose build cron
docker compose up -d --force-recreate cron
sleep 3
docker inspect --format '{{.State.Status}}' xxxtea-cron
```
Expected: `running`

- [ ] **Step 6: Commit**

```bash
cd /home/jesse/projects/domains/sites/xxxtea.com
git add ops/smoke.yaml ops/docker/crontab.docker ops/scripts/run-role.sh
git commit -m "xxxtea: retire bespoke smoke-tester role in favor of fleet-smoke"
git push origin main
```

---

## Task 8: Roll out minimal configs to the other 10 live sites

**Files:**
- Create: `sites/0xroulette.com/ops/smoke.yaml`
- Create: `sites/3boobs.com/ops/smoke.yaml`
- Create: `sites/aliencouncil.com/ops/smoke.yaml`
- Create: `sites/americastrikes.com/ops/smoke.yaml`
- Create: `sites/oventoheaven.com/ops/smoke.yaml`
- Create: `sites/rc-9.com/ops/smoke.yaml`
- Create: `sites/reviewtattoo.com/ops/smoke.yaml`
- Create: `sites/sinderella.org/ops/smoke.yaml`
- Create: `sites/ultrarough.com/ops/smoke.yaml`
- Create: `sites/weapontester.com/ops/smoke.yaml`

Each gets a minimal, safe default (homepage 200) — richer per-site route lists are a follow-up any of these sites can add later (that's exactly what the Task 9 skill documents). `oventoheaven.com` has no ops/ automation and no Slack channel yet, so its Slack bit-flip starts `false`; flip it once a channel exists.

- [ ] **Step 1: `sites/0xroulette.com/ops/smoke.yaml`**

```yaml
apex: 0xroulette.com
enabled: true
slack:
  enabled: true
  channel_env: SLACK_CHANNEL_0XROULETTE
  channel: domain-0xroulette-com
checks:
  - path: /
    expect: 200
    label: Homepage
```

- [ ] **Step 2: `sites/3boobs.com/ops/smoke.yaml`**

```yaml
apex: 3boobs.com
enabled: true
slack:
  enabled: true
  channel_env: SLACK_CHANNEL_3BOOBS
  channel: domain-3boobs-com
checks:
  - path: /
    expect: 200
    label: Homepage
```

- [ ] **Step 3: `sites/aliencouncil.com/ops/smoke.yaml`**

```yaml
apex: aliencouncil.com
enabled: true
slack:
  enabled: true
  channel_env: SLACK_CHANNEL_ALIENCOUNCIL
  channel: domain-aliencouncil-com
checks:
  - path: /
    expect: 200
    label: Homepage
```

- [ ] **Step 4: `sites/americastrikes.com/ops/smoke.yaml`**

```yaml
apex: americastrikes.com
enabled: true
slack:
  enabled: true
  channel_env: SLACK_CHANNEL_AMERICA_STRIKES
  channel: domain-americastrikes-com
checks:
  - path: /
    expect: 200
    label: Homepage
```

- [ ] **Step 5: `sites/oventoheaven.com/ops/smoke.yaml`**

```yaml
apex: oventoheaven.com
enabled: true
slack:
  # No Slack channel exists for this site yet (positioning still TBD — see
  # DOMAINS_INDEX.md). Flip to true and add channel_env once one is created.
  enabled: false
checks:
  - path: /
    expect: 200
    label: Homepage
```

- [ ] **Step 6: `sites/rc-9.com/ops/smoke.yaml`**

```yaml
apex: rc-9.com
enabled: true
slack:
  enabled: true
  channel_env: SLACK_CHANNEL_RC9
  channel: domain-rc-9-com
checks:
  - path: /
    expect: 200
    label: Homepage
```

- [ ] **Step 7: `sites/reviewtattoo.com/ops/smoke.yaml`**

```yaml
apex: reviewtattoo.com
enabled: true
slack:
  enabled: true
  channel_env: SLACK_CHANNEL_REVIEWTATTOO
  channel: domain-reviewtattoo-com
checks:
  - path: /
    expect: 200
    label: Homepage
```

- [ ] **Step 8: `sites/sinderella.org/ops/smoke.yaml`**

```yaml
apex: sinderella.org
enabled: true
slack:
  enabled: true
  channel_env: SLACK_CHANNEL_SINDERELLA
  channel: domain-sinderella-org
checks:
  - path: /
    expect: 200
    label: Homepage
```

- [ ] **Step 9: `sites/ultrarough.com/ops/smoke.yaml`**

```yaml
apex: ultrarough.com
enabled: true
slack:
  enabled: true
  channel_env: SLACK_CHANNEL_ULTRAROUGH
  channel: domain-ultrarough-com
checks:
  - path: /
    expect: 200
    label: Homepage
```

- [ ] **Step 10: `sites/weapontester.com/ops/smoke.yaml`**

```yaml
apex: weapontester.com
enabled: true
slack:
  enabled: true
  channel_env: SLACK_CHANNEL_WEAPONTESTER
  channel: domain-weapontester-com
checks:
  - path: /
    expect: 200
    label: Homepage
```

- [ ] **Step 11: Commit each site's config in its own repo** (these are separate git repos under `sites/`)

```bash
cd /home/jesse/projects/domains
for s in 0xroulette.com 3boobs.com aliencouncil.com americastrikes.com oventoheaven.com \
         rc-9.com reviewtattoo.com sinderella.org ultrarough.com weapontester.com; do
  (cd "sites/$s" && git add ops/smoke.yaml && \
   git commit -m "ops: add fleet-smoke config (centralized health check)" && \
   git push origin main)
done
```

---

## Task 9: Dry-run the full fleet and bring the cron container up for real

**Files:** none (verification only)

- [ ] **Step 1: Dry-run every configured site once, on the host, before trusting the cron container**

Run:
```bash
cd /home/jesse/projects/domains/tools/fleet-smoke
python3 run_fleet_smoke.py --stagger-seconds 2
```
Expected: one `fleet-smoke: 11 site(s) configured` line, then per-site PASS/FAIL lines for every check, ending in a `healthy`/`recovered`/`attention` summary line per site. Exit code `0` if every site's checks passed.

- [ ] **Step 2: Confirm Slack landed correctly**

Check the `domain-xxxtea-com` channel (and one or two others) for the new-format message: icon + headline + bulleted per-check line with 👍/⚠️. Confirm `domain-oventoheaven-com`-equivalent (there is none) received **no** message — proving the bit-flip works.

- [ ] **Step 3: Confirm the state files were written**

Run: `ls tools/fleet-smoke/state/`
Expected: one `<site>.json` per site that ran (not `oventoheaven.com` if it stayed disabled — disabled sites never reach the state write).

- [ ] **Step 4: Rebuild and bring up the real cron container with all 11 configs mounted**

```bash
cd /home/jesse/projects/domains/tools/fleet-smoke
docker compose build fleet-smoke-cron
docker compose up -d --force-recreate fleet-smoke-cron
sleep 3
docker inspect --format '{{.State.Status}}' fleet-smoke-cron
docker exec fleet-smoke-cron ls /fleet-sites | wc -l   # sanity: sees every site dir
```
Expected: `running`, and the site count matches `ls sites/ | wc -l` on the host.

- [ ] **Step 5: Verify a config-only edit takes effect without a rebuild**

```bash
# flip oventoheaven's bit on temporarily, confirm the container sees it without rebuilding
sed -i 's/enabled: false/enabled: true/' /home/jesse/projects/domains/sites/oventoheaven.com/ops/smoke.yaml
docker exec fleet-smoke-cron cat /fleet-sites/oventoheaven.com/ops/smoke.yaml | grep enabled
# revert — no Slack channel actually exists for this site yet
sed -i 's/enabled: true/enabled: false/' /home/jesse/projects/domains/sites/oventoheaven.com/ops/smoke.yaml
```
Expected: the `cat` inside the container shows `enabled: true` immediately (read-only bind mount, no rebuild) — confirms the "config is live, code is baked" architecture claim.

---

## Task 10: The continued-development skill

**Files:**
- Create: `/home/jesse/.claude/skills/skill-domains-dev-smoke-tester-checks/SKILL.md`

- [ ] **Step 1: Write the skill**

```markdown
---
name: skill-domains-dev-smoke-tester-checks
description: Use when adding a new site to fleet-smoke, adding/editing routes in a site's ops/smoke.yaml, adding a new check type, debugging the fleet-smoke-cron container, or answering questions about how the portfolio's centralized health-check system works
---

# Fleet Smoke — Centralized Domain Health Checks

## Overview

One tool, `tools/fleet-smoke/`, runs deterministic health checks (currently:
HTTP status on a set of routes) against every domain in the portfolio that
opts in, on a single daily cron tick, and posts one Slack message per site
with a ✅ healthy / 🔧 recovered / 🆘 attention icon plus a bulleted
per-check breakdown. It replaced the old pattern of one bespoke LLM
"smoke-tester" role per site (that pattern only ever shipped for xxxtea.com;
see git history on `sites/xxxtea.com/ops/roles/` if you need the old design).

**Golden rule: config is data, checks are code.** A site's `ops/smoke.yaml`
only ever lists WHAT to check (routes, expected codes, the Slack bit-flip).
It never contains logic. New check behavior always goes in
`tools/fleet-smoke/lib/checks.py`, once, and every site's config can then
reference it.

## Architecture

```
tools/fleet-smoke/
├── lib/config.py     — discover_configs(), load_config()
├── lib/checks.py      — resolve_apex_ip(), run_http_check(), run_checks()
├── lib/status.py      — load_state(), save_state(), compute_status()
├── lib/slack.py       — format_message(), post_message()
├── run_fleet_smoke.py — CLI entrypoint, the staggered site loop
├── state/<site>.json  — last run's fail count per site (NOT in git)
├── docker/            — Dockerfile + supercronic crontab
└── docker-compose.yml — the fleet-smoke-cron container

sites/<domain>/ops/smoke.yaml   — one per participating site
```

Every I/O boundary in `lib/` is dependency-injected (`run_curl`, `http_get`,
`post_fn`) specifically so `tests/` never touches the network. Keep that
property when you extend it.

## Config schema (`sites/<domain>/ops/smoke.yaml`)

```yaml
apex: example.com          # required — bare domain, no scheme
enabled: true               # optional, default true — the whole-site kill switch
dns_over_https: true         # optional, default true — resolves via Cloudflare
                             # DoH before curling, bypassing local DNS/proxy quirks
slack:
  enabled: true              # the bit-flip — off during onboarding, on once a
                              # Slack channel exists for the site
  channel_env: SLACK_CHANNEL_EXAMPLE   # var name to read from the shared .env
  channel: domain-example-com          # literal fallback if the env var is unset
checks:
  - type: http_status        # optional, default (and only current) type
    path: /reviews/
    expect: 200
    label: Reviews index      # shown in the Slack bullet
```

A site with **no** `ops/smoke.yaml` is silently skipped — never required.

## Common tasks

### Add a site to the fleet

1. Create `sites/<domain>/ops/smoke.yaml` following the schema above. Start
   with just a homepage check if you don't know the site's key routes yet.
2. Find the site's Slack channel var: `grep SLACK_CHANNEL_ /home/jesse/projects/domains/.env`.
   If none exists, set `slack.enabled: false` and leave a comment — flip it
   on once the channel is created.
3. Commit + push **in that site's own repo** (`sites/<domain>/` is a separate
   git repo from `domains/`). No fleet-smoke code change needed — the next
   cron tick picks it up automatically (read-only bind mount, no rebuild).

### Add or edit routes for an existing site

Just edit that site's `ops/smoke.yaml` and commit in the site's own repo.
Takes effect on the next tick. No rebuild, no restart.

### Add a new check type (e.g. SSL cert expiry, DNS record check)

1. Add a function to `tools/fleet-smoke/lib/checks.py` following the shape of
   `run_http_check` — same dependency-injection discipline (accept an
   injectable callable for whatever I/O it does).
2. Dispatch on `check.get("type")` inside `run_checks()` — add a new branch
   next to the existing `if check_type != "http_status": raise ...` check.
3. Write unit tests in `tools/fleet-smoke/tests/test_checks.py` mirroring the
   existing `run_http_check` tests — inject fakes, no real network.
4. **Rebuild the container** (code changed, not just a config):
   ```bash
   cd /home/jesse/projects/domains/tools/fleet-smoke
   docker compose build fleet-smoke-cron
   docker compose up -d --force-recreate fleet-smoke-cron
   ```
5. Any site can now opt in by adding `type: <your-new-type>` to a check entry
   in its own `ops/smoke.yaml` — no further code changes anywhere.

### Debug a site that isn't getting checked

```bash
cd /home/jesse/projects/domains/tools/fleet-smoke
python3 run_fleet_smoke.py --only <domain> --stagger-seconds 0
```
Runs just that one site, prints every check's PASS/FAIL, and shows the
`disabled — skipping` line if `enabled: false` is the reason. If the site
prints nothing at all, its `ops/smoke.yaml` doesn't exist or the YAML failed
to parse — check `python3 -c "import yaml; yaml.safe_load(open('sites/<domain>/ops/smoke.yaml'))"`.

### Rebuild vs. no-rebuild — the one thing to get right

- **Config changes** (`sites/*/ops/smoke.yaml`) — bind-mounted read-only into
  the container. Take effect on the very next cron tick. Never rebuild for these.
- **Code/schedule changes** (anything under `tools/fleet-smoke/lib/`,
  `run_fleet_smoke.py`, or `docker/crontab`) — baked into the image at build
  time (`COPY`). A stale image silently keeps running the old code/schedule
  forever. Always:
  ```bash
  cd /home/jesse/projects/domains/tools/fleet-smoke
  docker compose build fleet-smoke-cron
  docker compose up -d --force-recreate fleet-smoke-cron
  ```
  This is the same trap documented as the "sinderella guard" for per-site
  cron containers elsewhere in this repo — it applies here too.

### Run the test suite

```bash
cd /home/jesse/projects/domains/tools/fleet-smoke
python3 -m pytest -v
```
Every test fakes its I/O (curl, DNS-over-HTTPS, Slack POST) via the injection
points in `lib/`. If you add a new function that touches the network or
filesystem, give it the same `some_io=None, default=_default_impl` shape so it
stays testable.

## Gotchas

- **Staggering is a sleep, not a schedule offset.** All sites share one
  `0 7 * * *` cron line; `run_fleet_smoke.py` sleeps
  `FLEET_SMOKE_STAGGER_SECONDS` (default 20s, override via that env var or
  `--stagger-seconds`) between sites inside the same run. Don't try to give
  each site its own cron time — that reintroduces the per-site scheduling
  mess this tool replaced.
- **State lives in `tools/fleet-smoke/state/`, never in a site's own repo.**
  This is what makes "recovered" (🔧) possible without any per-site
  diagnosis logic — it's purely this run's fail count vs. last run's,
  compared in `lib/status.py`.
- **`oventoheaven.com` has no `ops/` automation at all** (no `run-role.sh`,
  no `notify-slack.sh`) — and that's fine. fleet-smoke doesn't depend on a
  site's own ops scaffold; it only needs `ops/smoke.yaml` to exist.
```

- [ ] **Step 2: Verify the skill file is well-formed** (frontmatter parses, no unresolved placeholders)

Run: `python3 -c "import yaml; f=open('/home/jesse/.claude/skills/skill-domains-dev-smoke-tester-checks/SKILL.md'); content=f.read(); fm=content.split('---')[1]; yaml.safe_load(fm); print('frontmatter OK')"`
Expected: `frontmatter OK`

- [ ] **Step 3: Commit**

The skill lives outside any git repo under version control here (`~/.claude/skills/`) — no commit step; confirm it appears in the skills list on the next turn instead (`ls ~/.claude/skills/skill-domains-dev-smoke-tester-checks/`).

---

## Task 11: README for the tool itself

**Files:**
- Create: `tools/fleet-smoke/README.md`

- [ ] **Step 1: Write the README**

```markdown
# fleet-smoke

Centralized, deterministic health checks for every domain in the portfolio.
One daily cron tick, staggered per-site, config-driven, Slack-notified.

Full architecture + how-to: see the `skill-domains-dev-smoke-tester-checks`
Claude skill (`~/.claude/skills/skill-domains-dev-smoke-tester-checks/SKILL.md`).

## Quick start

```bash
# run everything once, right now, on the host (no Docker needed)
cd tools/fleet-smoke
python3 -m pip install -r requirements.txt
python3 run_fleet_smoke.py

# just one site, no stagger delay
python3 run_fleet_smoke.py --only xxxtea.com --stagger-seconds 0

# tests
python3 -m pytest -v

# bring up the real cron container (daily 07:00 ET)
docker compose build fleet-smoke-cron
docker compose up -d fleet-smoke-cron
```

Add a site: create `sites/<domain>/ops/smoke.yaml` (schema in the skill doc
above) and commit it in that site's own repo. No fleet-smoke code change,
no rebuild — the next cron tick picks it up.
```

- [ ] **Step 2: Commit**

```bash
cd /home/jesse/projects/domains
git add tools/fleet-smoke/README.md
git commit -m "fleet-smoke: README"
```

---

## Errata (found during execution)

- **Task 9 Step 5's revert `sed`** (`sed -i 's/enabled: true/enabled: false/' .../oventoheaven.com/ops/smoke.yaml`) is unscoped and matches the FIRST `enabled: true` in the file, which is the site-level key, not `slack.enabled`. Running it as written silently disables the whole site instead of just re-muting Slack. Scope any future edit to the `slack:` block specifically (e.g. a YAML-aware edit, or a sed anchored past the `slack:` line) rather than a bare string match.

## Self-Review Notes

- **Spec coverage:** bit-flip → `slack.enabled` (Task 1/5/8). Centralized checks, per-site config → `lib/checks.py` + `ops/smoke.yaml` schema (Tasks 1-5, 7-8). Cron + staggering → Task 6/9 (`FLEET_SMOKE_STAGGER_SECONDS` sleep between sites). Domain Fleet control (one central container, skip-if-missing, walks every site dir) → Task 6/9. Skill for continued dev → Task 10.
- **Type consistency:** `run_checks_fn`/`post_fn` injection names in Task 5's `check_one_site` match the parameter names defined in Tasks 2 and 4 (`run_checks`, `post_message`) — same call shape, just renamed at the call site to make the orchestration test's intent obvious.
- **No placeholders:** every step ships complete, runnable code — including all 11 site YAMLs and the full skill body.
