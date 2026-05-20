"""Tests for collectors.cloudflare."""
from __future__ import annotations

import os

import httpx
import pytest
import respx

from site_tracker import registry, store
from site_tracker.collectors import cloudflare as cf


@pytest.fixture(autouse=True)
def _cf_env(monkeypatch):
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "test-token")
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acct-id")


@pytest.fixture
def reg() -> registry.Registry:
    return registry.Registry(
        config={},
        sites={
            "alpha.test": {"active": True, "cf_zone": "alpha.test", "applies_to": ["cf"]},
        },
    )


def _zone_response(active: bool):
    return {
        "result": [{
            "id": "zone-id",
            "name": "alpha.test",
            "status": "active" if active else "pending",
        }],
        "success": True,
    }


@respx.mock
def test_collects_zone_active(db, reg):
    respx.get("https://api.cloudflare.com/client/v4/zones",
              params={"name": "alpha.test"}).mock(
        return_value=httpx.Response(200, json=_zone_response(True))
    )
    respx.get("https://api.cloudflare.com/client/v4/zones/zone-id/workers/routes").mock(
        return_value=httpx.Response(200, json={"result": [{"pattern": "alpha.test/*"}], "success": True})
    )
    respx.get("https://api.cloudflare.com/client/v4/zones/zone-id/email/routing").mock(
        return_value=httpx.Response(200, json={"result": {"enabled": True}, "success": True})
    )
    cf.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["cf.zone_active"]["value"] is True
    assert facts["cf.worker_bound"]["value"] is True
    assert facts["cf.email_routing"]["value"] is True


@respx.mock
def test_zone_pending_marks_red(db, reg):
    respx.get("https://api.cloudflare.com/client/v4/zones",
              params={"name": "alpha.test"}).mock(
        return_value=httpx.Response(200, json=_zone_response(False))
    )
    respx.get("https://api.cloudflare.com/client/v4/zones/zone-id/workers/routes").mock(
        return_value=httpx.Response(200, json={"result": [], "success": True})
    )
    respx.get("https://api.cloudflare.com/client/v4/zones/zone-id/email/routing").mock(
        return_value=httpx.Response(200, json={"result": {"enabled": False}, "success": True})
    )
    cf.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["cf.zone_active"]["state"] == "red"


@respx.mock
def test_api_error_marks_unknown(db, reg):
    respx.get("https://api.cloudflare.com/client/v4/zones",
              params={"name": "alpha.test"}).mock(
        return_value=httpx.Response(500, json={"success": False})
    )
    cf.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["cf.zone_active"]["state"] == "unknown"


@respx.mock
def test_zone_not_in_cf_marks_false(db, reg):
    respx.get("https://api.cloudflare.com/client/v4/zones",
              params={"name": "alpha.test"}).mock(
        return_value=httpx.Response(200, json={"result": [], "success": True})
    )
    cf.run(reg, db)
    facts = store.get_site_facts(db, "alpha.test")
    assert facts["cf.zone_active"]["value"] is False
    assert facts["cf.worker_bound"]["value"] is False
    assert facts["cf.email_routing"]["value"] is False
