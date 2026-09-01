"""cf-tokens tests.

This tool mints credentials and writes them to the vault, and Cloudflare returns
a token's secret exactly once — at creation. So the invariant that matters more
than any other: never create a token whose value we then fail to store. A
mis-stored token is not recoverable, it is a worker that can no longer deploy.
"""
import importlib.util
import sys
from pathlib import Path

import pytest

MODULE = Path(__file__).resolve().parents[1] / "mint.py"
spec = importlib.util.spec_from_file_location("mint", MODULE)
mint = importlib.util.module_from_spec(spec)
sys.modules["mint"] = mint
spec.loader.exec_module(mint)


class FakeAPI:
    """Records calls and replays canned responses, in order, per path prefix."""

    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, path, token, method="GET", body=None):
        self.calls.append((method, path, body))
        for prefix, resp in self.responses:
            if path.startswith(prefix):
                return resp
        return {"success": True, "result": []}


PGS = {name: {"id": f"id-{name}", "name": name}
       for name in mint.ZONE_PERMS + mint.ACCOUNT_PERMS}


def test_zone_permissions_are_scoped_to_that_zone_only(monkeypatch):
    api = FakeAPI([
        ("/zones?name=", {"success": True, "result": [{"id": "ZONE1"}]}),
        ("/user/tokens", {"success": True, "result": {"value": "v", "id": "T1"}}),
    ])
    monkeypatch.setattr(mint, "api", api)
    monkeypatch.setattr(mint, "write_site_value", lambda d, v: None)

    mint.mint("a.com", "prov", "ACC", PGS, {}, {}, dry_run=False)
    body = next(b for m, p, b in api.calls if m == "POST")
    zone_policy = body["policies"][0]
    assert list(zone_policy["resources"]) == ["com.cloudflare.api.account.zone.ZONE1"]
    assert {g["name"] for g in zone_policy["permission_groups"]} == set(mint.ZONE_PERMS)


def test_worker_permissions_are_account_wide_and_that_is_documented(monkeypatch):
    # Not a bug to fix: `Workers Scripts Write` has no per-script scope in
    # Cloudflare's model. This test exists so that if that ever changes, someone
    # is forced to revisit the docstring's claim rather than silently leaving
    # the fleet broader than it needs to be.
    api = FakeAPI([
        ("/zones?name=", {"success": True, "result": [{"id": "ZONE1"}]}),
        ("/user/tokens", {"success": True, "result": {"value": "v", "id": "T1"}}),
    ])
    monkeypatch.setattr(mint, "api", api)
    monkeypatch.setattr(mint, "write_site_value", lambda d, v: None)

    mint.mint("a.com", "prov", "ACC", PGS, {}, {}, dry_run=False)
    body = next(b for m, p, b in api.calls if m == "POST")
    assert list(body["policies"][1]["resources"]) == ["com.cloudflare.api.account.ACC"]


def test_rotation_deletes_the_old_token_before_creating_the_new_one(monkeypatch):
    api = FakeAPI([
        ("/zones?name=", {"success": True, "result": [{"id": "Z"}]}),
        ("/user/tokens", {"success": True, "result": {"value": "v", "id": "T2"}}),
    ])
    monkeypatch.setattr(mint, "api", api)
    monkeypatch.setattr(mint, "write_site_value", lambda d, v: None)

    mint.mint("a.com", "prov", "ACC", PGS, {}, {"site-a.com": "OLD"}, dry_run=False)
    methods = [(m, p) for m, p, _ in api.calls if m in ("DELETE", "POST")]
    assert methods[0] == ("DELETE", "/user/tokens/OLD"), \
        "a leftover same-named token is indistinguishable from the live one"
    assert methods[1][0] == "POST"


def test_dry_run_never_touches_cloudflare_or_the_vault(monkeypatch):
    api = FakeAPI([("/zones?name=", {"success": True, "result": [{"id": "Z"}]})])
    monkeypatch.setattr(mint, "api", api)
    monkeypatch.setattr(mint, "write_site_value",
                        lambda d, v: pytest.fail("dry run wrote to the vault"))

    mint.mint("a.com", "prov", "ACC", PGS, {}, {"site-a.com": "OLD"}, dry_run=True)
    assert [m for m, _, _ in api.calls] == ["GET"]


def test_a_failed_vault_write_is_fatal_not_a_warning(monkeypatch):
    # The token exists at Cloudflare by this point and its value is already
    # unrecoverable. Continuing would leave the site holding nothing.
    monkeypatch.setattr(mint, "_vault_read_or_empty", lambda item: {}, raising=False)
    monkeypatch.setattr(mint.eb, "_vault_read", lambda item: {})
    monkeypatch.setattr(mint.eb, "_vault_write", lambda item, fields: None)
    with pytest.raises(SystemExit) as exc:
        mint.write_site_value("a.com", "the-secret")
    assert "read back" in str(exc.value)
    assert "the-secret" not in str(exc.value), "a failure message must not leak the token"


def test_missing_zone_aborts_before_any_token_is_created(monkeypatch):
    api = FakeAPI([("/zones?name=", {"success": True, "result": []})])
    monkeypatch.setattr(mint, "api", api)
    monkeypatch.setattr(mint, "write_site_value",
                        lambda d, v: pytest.fail("wrote despite no zone"))
    with pytest.raises(SystemExit):
        mint.mint("nozone.com", "prov", "ACC", PGS, {}, {}, dry_run=False)
    assert not [m for m, _, _ in api.calls if m == "POST"]
