import httpx
from datahub_images.config import Source, Settings, DEFAULT_HOME_IPS
from datahub_images.vpn import plan_fetch, FetchPlan, _is_home_ip

def _settings():
    return Settings(db_path=":memory:", blob_dir="/tmp/b", proxy_us="http://p:8888",
        proxy_eu="http://p:8888", home_ips={"9.9.9.9"}, pool_ttl_days=45, retention_days=14,
        reuse_global_days=30, reuse_same_site_days=14, api_host="0.0.0.0", api_port=4770)

def test_direct_policy_bypasses(monkeypatch):
    s = Source(id="x", kind="loc", policy="direct")
    plan = plan_fetch(s, _settings())
    assert plan.allowed and plan.proxy is None and plan.reason == "direct"

def test_fail_closed_when_probe_none(monkeypatch):
    monkeypatch.setattr("datahub_images.vpn.probe_exit_ip", lambda *a, **k: None)
    plan = plan_fetch(Source(id="x", kind="wikimedia"), _settings())
    assert not plan.allowed and plan.reason == "vpn-down"

def test_leak_detected_when_home_ip(monkeypatch):
    monkeypatch.setattr("datahub_images.vpn.probe_exit_ip", lambda *a, **k: "9.9.9.9")
    plan = plan_fetch(Source(id="x", kind="wikimedia"), _settings())
    assert not plan.allowed and plan.reason == "leak-detected"


def test_leak_detected_when_home_ip_drifts_within_cidr(monkeypatch):
    # Home egress drifted within the same /24 as its last-known IP; the
    # CIDR-aware settings.home_ips (a /24 network entry) must still catch it.
    s = Settings(
        db_path=":memory:", blob_dir="/tmp/b", proxy_us="http://p:8888",
        proxy_eu="http://p:8888", home_ips={"9.9.9.0/24"}, pool_ttl_days=45,
        retention_days=14, reuse_global_days=30, reuse_same_site_days=14,
        api_host="0.0.0.0", api_port=4770,
    )
    monkeypatch.setattr("datahub_images.vpn.probe_exit_ip", lambda *a, **k: "9.9.9.200")
    plan = plan_fetch(Source(id="x", kind="wikimedia"), s)
    assert not plan.allowed and plan.reason == "leak-detected"


def test_is_home_ip_catches_drifted_egress_ip():
    # The concrete regression: 158.173.25.38 drifted off the old exact
    # DEFAULT_HOME_IPS entry (158.173.25.169) but is in the same /24.
    assert _is_home_ip("158.173.25.38", DEFAULT_HOME_IPS) is True


def test_is_home_ip_does_not_flag_live_vpn_exit_nodes():
    # CRITICAL safety property: real PIA VPN exit IPs must never be flagged
    # as home. A false positive here would deny ALL fetches.
    assert _is_home_ip("158.173.3.15", DEFAULT_HOME_IPS) is False
    assert _is_home_ip("212.56.54.39", DEFAULT_HOME_IPS) is False


def test_is_home_ip_exact_plain_ip_entry_still_matches():
    assert _is_home_ip("5.5.5.5", {"5.5.5.5"}) is True
    assert _is_home_ip("5.5.5.6", {"5.5.5.5"}) is False


def test_is_home_ip_malformed_entry_does_not_crash():
    home_ips = {"not-an-ip-or-cidr", "24.55.143.0/24"}
    assert _is_home_ip("24.55.143.50", home_ips) is True
    assert _is_home_ip("1.2.3.4", home_ips) is False
