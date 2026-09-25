import importlib.util
from pathlib import Path


_CHECK_PATH = Path(__file__).parents[1] / "monitor" / "check.py"
_SPEC = importlib.util.spec_from_file_location("datahub_images_monitor_check", _CHECK_PATH)
check = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(check)


def test_integrity_accepts_eu_fallback_when_us_is_down(monkeypatch):
    def fake_echo(proxy=None):
        if proxy == check.PROXY_US:
            return None
        if proxy == check.PROXY_EU:
            return "203.0.113.20"
        return "198.51.100.10"

    monkeypatch.setattr(check, "_echo_ip", fake_echo)

    findings = check._vpn_integrity_findings(
        "198.51.100.10", {"us": None, "eu": "203.0.113.20"}
    )

    assert not any(severity == check.CRITICAL for severity, _ in findings)


def test_integrity_is_critical_when_no_exit_is_usable(monkeypatch):
    monkeypatch.setattr(check, "_echo_ip", lambda proxy=None: None if proxy else "198.51.100.10")

    findings = check._vpn_integrity_findings("198.51.100.10", {"us": None, "eu": None})

    assert any(severity == check.CRITICAL and "VPN egress dead" in message
               for severity, message in findings)


def test_integrity_rejects_bypass_on_any_exit(monkeypatch):
    def fake_echo(proxy=None):
        return "198.51.100.10" if proxy == check.PROXY_EU else "203.0.113.20"

    monkeypatch.setattr(check, "_echo_ip", fake_echo)

    findings = check._vpn_integrity_findings(
        "198.51.100.10", {"us": "203.0.113.20", "eu": "198.51.100.10"}
    )

    assert any(severity == check.CRITICAL and "proxied eu" in message
               for severity, message in findings)


def test_slow_health_probe_keeps_local_readiness_and_egress_checks(monkeypatch):
    def fake_get(url, proxy=None, timeout=12, raw=False):
        if url.endswith("/ready"):
            return {"db": True, "last_cycle_at": "2026-09-25T00:00:00Z"}
        if url.endswith("/health"):
            raise TimeoutError("VPN echo timed out")
        if "/egress?" in url:
            return {"events": []}
        if "/images?" in url:
            return {"images": [{"id": "abc"}]}
        if url.endswith("/image/abc"):
            return b"x" * 1001, {"content-type": "image/jpeg"}
        raise AssertionError(url)

    monkeypatch.setattr(check, "_get", fake_get)
    monkeypatch.setattr(check, "_echo_ip", lambda proxy=None: "198.51.100.10" if proxy is None else "203.0.113.20")
    findings = check.run_checks()
    assert any(s == check.WARNING and "VPN status probe unavailable" in m for s, m in findings)
    assert not any("API /health unreachable" in m or "no VPN exit is up" in m for _, m in findings)


def test_warning_requires_two_ticks_but_critical_pages_immediately(tmp_path, monkeypatch):
    monkeypatch.setattr(check, "STATE_PATH", str(tmp_path / "state.json"))
    monkeypatch.setattr(check.sys, "argv", ["check.py"])
    posts = []
    monkeypatch.setattr(check, "post_slack", lambda msg: posts.append(msg) or True)
    result = [(check.WARNING, "one exit slow")]
    monkeypatch.setattr(check, "run_checks", lambda: result)

    check.main()
    assert posts == []
    result[:] = []
    check.main()
    assert posts == []  # transient warning cleared before confirmation
    result[:] = [(check.WARNING, "one exit slow")]
    check.main()
    assert posts == []
    check.main()
    assert len(posts) == 1
    result[:] = [(check.CRITICAL, "VPN BYPASS/LEAK")]
    check.main()
    assert len(posts) == 2
    assert "CRITICAL" in posts[-1]
