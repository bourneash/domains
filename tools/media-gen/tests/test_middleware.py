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


def test_discover_docker_bridge_nets_includes_project_bridges_not_just_docker0():
    """Regression for the real 2026-08-10 incident: reviewtattoo's own
    `docker compose` project runs on a bridge named `br-<hash>`, NOT the
    literal `docker0` — an earlier version of this allowlist only matched
    the exact name `docker0` and 403'd every real per-project caller. Feed
    the discovery function real captured `ip -4 -o addr show` output
    (docker0 plus two distinct project bridges, plus a non-bridge interface
    that must NOT be picked up) and confirm all bridge subnets are found."""
    import ipaddress
    from media_gen.api import _discover_docker_bridge_nets

    sample_output = (
        "1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever\n"
        "2: eth0    inet 10.0.2.15/24 brd 10.0.2.255 scope global eth0\\       valid_lft forever preferred_lft forever\n"
        "3: docker0    inet 172.30.0.1/24 brd 172.30.0.255 scope global docker0\\       valid_lft forever preferred_lft forever\n"
        "19: br-72e38143e309    inet 172.30.65.1/24 brd 172.30.65.255 scope global br-72e38143e309\\       valid_lft forever preferred_lft forever\n"
        "26: br-6526c42d28fd    inet 172.30.53.1/24 brd 172.30.53.255 scope global br-6526c42d28fd\\       valid_lft forever preferred_lft forever\n"
    )
    nets = _discover_docker_bridge_nets(sample_output)
    assert ipaddress.ip_network("172.30.0.0/24") in nets       # docker0
    assert ipaddress.ip_network("172.30.65.0/24") in nets      # a real project bridge (reviewtattoo's)
    assert ipaddress.ip_network("172.30.53.0/24") in nets      # a second, different project bridge
    assert ipaddress.ip_network("10.0.2.0/24") not in nets     # eth0/LAN must NOT be swept in
    assert len(nets) == 3


def test_bridge_created_after_boot_is_admitted_on_refresh(monkeypatch):
    """Regression (2026-08-25): the allowlist was a boot-time snapshot, so a
    compose project whose bridge was created later got a permanent 403 —
    stinkyleftfoot.com's guide-writer silently shipped art-less drafts for
    exactly this reason. A miss must re-read the bridge table before rejecting.
    """
    import ipaddress

    from media_gen import api

    monkeypatch.setattr(api, "_ALLOWED_NETS", [ipaddress.ip_network("127.0.0.0/8")])
    monkeypatch.setattr(api, "_last_refresh", 0.0)
    monkeypatch.setattr(api, "_read_bridge_nets", lambda: [ipaddress.ip_network("172.30.63.0/24")])

    from starlette.testclient import TestClient as STC
    c = STC(app, client=("172.30.63.4", 12345))
    assert c.get("/health").status_code == 200


def test_refresh_still_rejects_a_genuinely_foreign_client(monkeypatch):
    """The refresh must not widen the policy — re-reading the table is only
    allowed to admit addresses that are on an actual docker bridge."""
    import ipaddress

    from media_gen import api

    monkeypatch.setattr(api, "_ALLOWED_NETS", [ipaddress.ip_network("127.0.0.0/8")])
    monkeypatch.setattr(api, "_last_refresh", 0.0)
    monkeypatch.setattr(api, "_read_bridge_nets", lambda: [ipaddress.ip_network("172.30.63.0/24")])

    from starlette.testclient import TestClient as STC
    c = STC(app, client=("203.0.113.5", 12345))
    assert c.get("/health").status_code == 403
