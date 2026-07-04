import httpx
from datahub_images.config import Source, Settings
from datahub_images.vpn import plan_fetch, FetchPlan

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
