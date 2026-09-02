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
