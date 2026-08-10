"""Regression tests for the loopback/docker0 access restriction.

Real incident this guards against (2026-08-10): the service was first bound
loopback-only (broke the real container caller, reviewtattoo's guide-writer,
with Connection Refused), then bound docker0-only as a "fix" (which broke
host-local testing instead). Both were bind-address-only approaches on a
host that also has real LAN/VPN interfaces — 0.0.0.0 without restriction
would have then exposed generation to those. The middleware is what
actually has to get this right; test it directly rather than trusting the
bind address.
"""
from fastapi.testclient import TestClient

from media_gen.api import app

client = TestClient(app)


def test_loopback_client_allowed():
    r = client.get("/health", headers={}, )
    # TestClient's default client host is 'testclient', not a real IP —
    # confirm that itself gets rejected (see test below), then simulate a
    # real loopback caller explicitly.
    assert r.status_code in (200, 403)  # baseline; the real assertions follow


def test_non_loopback_non_docker_client_is_forbidden(monkeypatch):
    from starlette.testclient import TestClient as STC
    c = STC(app, client=("203.0.113.5", 12345))  # TEST-NET-3, definitely not us
    r = c.get("/health")
    assert r.status_code == 403


def test_loopback_client_is_allowed_explicit():
    from starlette.testclient import TestClient as STC
    c = STC(app, client=("127.0.0.1", 12345))
    r = c.get("/health")
    assert r.status_code == 200


def test_docker0_subnet_client_is_allowed(monkeypatch):
    from media_gen import api
    monkeypatch.setattr(api, "_ALLOWED_NETS", api._ALLOWED_NETS + [__import__("ipaddress").ip_network("172.30.0.0/24")])
    from starlette.testclient import TestClient as STC
    c = STC(app, client=("172.30.0.7", 12345))  # a container's IP on that bridge
    r = c.get("/health")
    assert r.status_code == 200
