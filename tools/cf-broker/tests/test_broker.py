"""cf-broker tests.

This process holds the ACCOUNT-scoped Cloudflare token that site containers are
losing, and answers requests from containers running `claude -p` over scraped
input. Two properties are the whole point, and both are tested adversarially:

  1. A caller cannot ask about a site other than its own — the site comes from
     the token, and there is no request field that names a site.
  2. A caller cannot steer the upstream URL. If it could, the broker would be an
     open proxy for the very credential it exists to hold.
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

MODULE = Path(__file__).resolve().parents[1] / "broker.py"
spec = importlib.util.spec_from_file_location("broker", MODULE)
broker = importlib.util.module_from_spec(spec)
sys.modules["broker"] = broker
spec.loader.exec_module(broker)


class FakeFleet:
    def __init__(self):
        self.by_token = {"tok-a": "a.com", "tok-b": "b.com"}
        self.worker = {"a.com": "a-com", "b.com": "b-com"}
        self.account = "ACC"
        self.cf_token = "FLEET"

    def site_for(self, token):
        return self.by_token.get(token) if token else None


class FakeHandler(broker.Handler):
    """Exercises do_GET without a socket."""

    def __init__(self, path, token, upstream):
        self.path = path
        self.headers = {"Authorization": f"Bearer {token}"} if token else {}
        self.fleet = FakeFleet()
        self.sent = []
        self.upstream = upstream
        self.requested = []

    def _send(self, code, body, ctype="application/json"):
        self.sent.append((code, body))

    def log_message(self, *a):
        pass

    def address_string(self):
        return "test"


@pytest.fixture
def run(monkeypatch):
    def _run(path, token="tok-a", upstream=None):
        upstream = upstream or {}
        h = FakeHandler(path, token, upstream)

        def fake_get(p, tok):
            h.requested.append((p, tok))
            return upstream.get(p, (200, b'{"success":true,"result":[]}'))
        monkeypatch.setattr(broker, "cf_get", fake_get)
        h.do_GET()
        return h
    return _run


def test_the_site_comes_from_the_token_not_the_request(run):
    # b.com's worker must be unreachable no matter what a.com asks for.
    h = run("/v1/worker?site=b.com", token="tok-a")
    assert h.sent[0][0] == 200
    assert h.requested[0][0] == "/accounts/ACC/workers/services/a-com"
    assert "b-com" not in h.requested[0][0]


def test_an_unknown_token_is_indistinguishable_from_no_token(run):
    a = run("/v1/worker", token="")
    b = run("/v1/worker", token="revoked-yesterday")
    assert a.sent[0] == b.sent[0] == (401, a.sent[0][1])
    assert b"unauthorized" in b.sent[0][1]


def test_the_caller_never_steers_the_upstream_path(run):
    # If any part of the request reached the URL, this would escape the account.
    h = run("/v1/worker/../../../user/tokens", token="tok-a")
    assert h.sent[0][0] == 404
    assert not h.requested, "an unrouted path must not reach Cloudflare at all"


SERVICE_OK = (200, json.dumps(
    {"result": {"default_environment": {"script": {"tag": "TAG-A"}}}}).encode())
BUILDS_PATH = "/accounts/ACC/builds/workers/TAG-A/builds?per_page=10"
SERVICE_PATH = "/accounts/ACC/workers/services/a-com"


def test_builds_are_keyed_by_the_script_tag_the_broker_resolves_itself(run):
    # Cloudflare keys builds by script TAG, not worker name. A caller-supplied
    # tag would be a caller-chosen worker — the exact cross-site read this
    # service exists to prevent — so the broker resolves it server-side.
    h = run("/v1/builds", token="tok-a",
            upstream={SERVICE_PATH: SERVICE_OK,
                      BUILDS_PATH: (200, b'{"result":[]}')})
    assert h.sent[0][0] == 200
    assert [p for p, _ in h.requested] == [SERVICE_PATH, BUILDS_PATH]


def test_builds_fail_closed_when_the_script_tag_cannot_be_resolved(run):
    h = run("/v1/builds", token="tok-a", upstream={SERVICE_PATH: (500, b"nope")})
    assert h.sent[0][0] == 502
    assert all("builds" not in p for p, _ in h.requested)


def test_build_logs_require_the_build_to_belong_to_this_site(run):
    builds = (200, json.dumps({"result": [{"build_uuid": "aaaabbbb"}]}).encode())
    h = run("/v1/builds/ccccdddd/logs", token="tok-a",
            upstream={SERVICE_PATH: SERVICE_OK, BUILDS_PATH: builds})
    assert h.sent[0][0] == 403
    assert all("/logs" not in p for p, _ in h.requested)


def test_build_logs_are_served_for_this_sites_own_build(run):
    builds = (200, json.dumps({"result": [{"build_uuid": "aaaabbbb"}]}).encode())
    h = run("/v1/builds/aaaabbbb/logs", token="tok-a",
            upstream={SERVICE_PATH: SERVICE_OK, BUILDS_PATH: builds})
    assert h.sent[0][0] == 200
    assert ("/accounts/ACC/builds/builds/aaaabbbb/logs", "FLEET") in h.requested


def test_ownership_check_fails_closed_when_the_builds_list_is_unavailable(run):
    # A Cloudflare hiccup must not become "sure, here are the logs".
    h = run("/v1/builds/aaaabbbb/logs", token="tok-a",
            upstream={SERVICE_PATH: SERVICE_OK, BUILDS_PATH: (500, b"nope")})
    assert h.sent[0][0] == 403


def test_a_malformed_build_id_is_rejected_before_any_upstream_call(run):
    h = run("/v1/builds/..%2Fsecrets/logs", token="tok-a")
    assert h.sent[0][0] == 400
    assert not h.requested


def test_healthz_needs_no_token(run):
    h = run("/healthz", token="")
    assert h.sent[0][0] == 200


def test_upstream_status_is_passed_through_not_flattened(run):
    h = run("/v1/script", token="tok-a",
            upstream={"/accounts/ACC/workers/scripts/a-com": (404, b'{"e":1}')})
    assert h.sent[0][0] == 404, "a 404 reported as 200 would break deploy verification"


def test_every_route_uses_the_brokers_own_credential(run):
    for path in ("/v1/worker", "/v1/script"):
        h = run(path, token="tok-b")
        assert h.requested[0][1] == "FLEET"
        assert "b-com" in h.requested[0][0]
