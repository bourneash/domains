import httpx
import pytest
from datahub.config import Source, Settings
from datahub import vpn


def _settings():
    return Settings(
        db_path=":memory:", home_ips={"24.55.143.75"},
        proxy_us="http://h:8181", proxy_eu="http://h:8182",
        control_us="http://h:9281", control_eu="http://h:9282",
        registry_dir="/x",
    )


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_direct_source_is_allowed_without_proxy():
    src = Source(id="fred", type="dataset", fetcher="fred", tags=["economy"], policy="direct", exit="us")
    plan = vpn.plan_fetch(src, _settings(), client=_client(lambda r: httpx.Response(200)))
    assert plan.allowed is True
    assert plan.proxy is None
    assert plan.exit_node == "direct"


def test_vpn_source_allowed_when_exit_ip_is_not_home():
    src = Source(id="reuters", type="rss", url="https://e/r.rss", tags=["world"], exit="us")

    def handler(req):
        return httpx.Response(200, content=b"185.0.0.9")

    plan = vpn.plan_fetch(src, _settings(), client=_client(handler))
    assert plan.allowed is True
    assert plan.proxy == "http://h:8181"
    assert plan.exit_node == "us"
    assert plan.exit_ip == "185.0.0.9"


def test_vpn_source_blocked_when_node_down():
    src = Source(id="reuters", type="rss", url="https://e/r.rss", tags=["world"], exit="eu")

    def handler(req):
        raise httpx.ConnectError("refused")

    plan = vpn.plan_fetch(src, _settings(), client=_client(handler))
    assert plan.allowed is False
    assert plan.reason == "vpn-down"


def test_vpn_source_blocked_on_leak():
    src = Source(id="reuters", type="rss", url="https://e/r.rss", tags=["world"], exit="us")

    def handler(req):
        return httpx.Response(200, content=b"24.55.143.75")  # home IP

    plan = vpn.plan_fetch(src, _settings(), client=_client(handler))
    assert plan.allowed is False
    assert plan.reason == "leak-detected"
    assert plan.proxy is None
