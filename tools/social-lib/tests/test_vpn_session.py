# tools/social-lib/tests/test_vpn_session.py
import os
from social_lib.vpn_session import get_proxy_url, vpn_session


def test_get_proxy_url_us():
    assert get_proxy_url("us") == "http://127.0.0.1:8181"


def test_get_proxy_url_eu():
    assert get_proxy_url("eu") == "http://127.0.0.1:8182"


def test_get_proxy_url_us_env_override():
    os.environ["VPN_PROXY_URL_US"] = "http://vpn-us:8888"
    try:
        assert get_proxy_url("us") == "http://vpn-us:8888"
    finally:
        del os.environ["VPN_PROXY_URL_US"]


def test_get_proxy_url_eu_env_override():
    os.environ["VPN_PROXY_URL_EU"] = "http://vpn-eu:8888"
    try:
        assert get_proxy_url("eu") == "http://vpn-eu:8888"
    finally:
        del os.environ["VPN_PROXY_URL_EU"]


def test_get_proxy_url_falls_back_without_override():
    os.environ.pop("VPN_PROXY_URL_US", None)
    assert get_proxy_url("us") == "http://127.0.0.1:8181"


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
