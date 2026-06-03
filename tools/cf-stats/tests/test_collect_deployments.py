"""Tests for collectors.collect_deployments."""
from __future__ import annotations

import httpx
import respx

from cf_stats import collectors as C

BASE = "https://api.cloudflare.com/client/v4"


def _workers(*names: str) -> dict:
    return {"ok": True, "count": len(names),
            "scripts": [{"id": n} for n in names]}


def _dep_payload(created_on: str, source: str, version_id: str) -> dict:
    return {
        "result": {"deployments": [{
            "id": "dep-" + version_id,
            "source": source,
            "author_email": "jessetamburino@hotmail.com",
            "annotations": {"workers/triggered_by": "deployment"},
            "versions": [{"version_id": version_id, "percentage": 100}],
            "created_on": created_on,
        }]},
        "success": True, "errors": [], "messages": [],
    }


@respx.mock
def test_collects_latest_deploy_per_worker(cf):
    respx.get(f"{BASE}/accounts/acct123/workers/scripts/aliencouncil/deployments").mock(
        return_value=httpx.Response(200, json=_dep_payload(
            "2026-05-22T12:37:46Z", "wrangler", "a365"))
    )
    out = C.collect_deployments(cf, {"ok": True, "scripts": [{"id": "aliencouncil"}]})
    assert out["ok"] is True
    rows = out["per_worker"]["aliencouncil"]
    assert rows[0]["source"] == "wrangler"
    assert rows[0]["version_id"] == "a365"
    assert rows[0]["created_on"] == "2026-05-22T12:37:46Z"
    assert rows[0]["triggered_by"] == "deployment"


@respx.mock
def test_one_worker_error_does_not_abort(cf):
    respx.get(f"{BASE}/accounts/acct123/workers/scripts/good/deployments").mock(
        return_value=httpx.Response(200, json=_dep_payload(
            "2026-05-22T12:00:00Z", "wrangler", "v1"))
    )
    respx.get(f"{BASE}/accounts/acct123/workers/scripts/bad/deployments").mock(
        return_value=httpx.Response(404, json={"success": False,
            "errors": [{"message": "not found"}]})
    )
    workers = {"ok": True, "scripts": [{"id": "good"}, {"id": "bad"}]}
    out = C.collect_deployments(cf, workers)
    assert out["ok"] is True
    assert "good" in out["per_worker"]
    assert "bad" in out["errors"]
    assert "bad" not in out["per_worker"]


def test_skips_when_workers_unavailable(cf):
    out = C.collect_deployments(cf, {"ok": False})
    assert out["ok"] is False
