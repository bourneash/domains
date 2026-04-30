"""Each collector returns a dict that always has an `ok: bool`. On failure it
records the error string but never raises — so one inaccessible scope (Pages,
Analytics, KV, R2, D1) doesn't kill the whole snapshot."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

from .api import CFClient, CFError


def _err(e: Exception) -> dict:
    if isinstance(e, CFError):
        return {"ok": False, "status": e.status, "error": e.message}
    return {"ok": False, "status": 0, "error": str(e)}


def collect_token(cf: CFClient) -> dict:
    try:
        body = cf.get("/user/tokens/verify")
        result = body.get("result") or {}
        out: dict[str, Any] = {
            "ok": True,
            "status": result.get("status"),
            "id": result.get("id"),
            "expires_on": result.get("expires_on"),
            "not_before": result.get("not_before"),
        }
        if result.get("expires_on"):
            try:
                exp = datetime.fromisoformat(result["expires_on"].replace("Z", "+00:00"))
                out["days_until_expiry"] = (exp - datetime.now(timezone.utc)).days
            except Exception:
                pass
        return out
    except Exception as e:
        return _err(e)


def collect_zones(cf: CFClient) -> dict:
    try:
        zones = cf.paginate("/zones")
        by_status = Counter(z.get("status") for z in zones)
        by_plan = Counter((z.get("plan") or {}).get("name") for z in zones)
        names = sorted(z["name"] for z in zones if z.get("name"))
        return {
            "ok": True,
            "count": len(zones),
            "by_status": dict(by_status),
            "by_plan": dict(by_plan),
            "names": names,
            "_zone_index": {z["name"]: z["id"] for z in zones if z.get("id")},
        }
    except Exception as e:
        return _err(e)


def collect_dns(cf: CFClient, zones: dict) -> dict:
    if not zones.get("ok"):
        return {"ok": False, "error": "zones unavailable"}
    by_zone: dict[str, int] = {}
    by_type: Counter = Counter()
    errors: dict[str, str] = {}
    for name, zid in zones["_zone_index"].items():
        try:
            body = cf.get(f"/zones/{zid}/dns_records", params={"per_page": 1})
            total = (body.get("result_info") or {}).get("total_count", 0)
            by_zone[name] = total
            try:
                full = cf.paginate(f"/zones/{zid}/dns_records", per_page=100)
                for r in full:
                    by_type[r.get("type", "?")] += 1
            except Exception:
                pass
        except Exception as e:
            errors[name] = str(e)
    return {
        "ok": True,
        "total_records": sum(by_zone.values()),
        "by_zone": by_zone,
        "by_type": dict(by_type),
        "errors": errors,
    }


def collect_workers(cf: CFClient) -> dict:
    try:
        scripts = cf.paginate(f"/accounts/{cf.account_id}/workers/scripts")
        out_scripts = []
        for s in scripts:
            out_scripts.append({
                "id": s.get("id"),
                "modified_on": s.get("modified_on"),
                "created_on": s.get("created_on"),
                "etag": s.get("etag"),
                "has_assets": s.get("has_assets"),
                "logpush": s.get("logpush"),
                "usage_model": s.get("usage_model"),
            })
        return {
            "ok": True,
            "count": len(scripts),
            "scripts": out_scripts,
        }
    except Exception as e:
        return _err(e)


def collect_worker_domains(cf: CFClient) -> dict:
    try:
        domains = cf.paginate(f"/accounts/{cf.account_id}/workers/domains")
        by_zone: Counter = Counter()
        by_service: Counter = Counter()
        for d in domains:
            if d.get("zone_name"):
                by_zone[d["zone_name"]] += 1
            if d.get("service"):
                by_service[d["service"]] += 1
        return {
            "ok": True,
            "count": len(domains),
            "by_zone": dict(by_zone),
            "by_service": dict(by_service),
            "domains": [
                {
                    "hostname": d.get("hostname"),
                    "service": d.get("service"),
                    "environment": d.get("environment"),
                    "zone_name": d.get("zone_name"),
                }
                for d in domains
            ],
        }
    except Exception as e:
        return _err(e)


def collect_workers_subdomain(cf: CFClient) -> dict:
    try:
        body = cf.get(f"/accounts/{cf.account_id}/workers/subdomain")
        return {"ok": True, "subdomain": (body.get("result") or {}).get("subdomain")}
    except Exception as e:
        return _err(e)


def collect_email_routing(cf: CFClient, zones: dict) -> dict:
    if not zones.get("ok"):
        return {"ok": False, "error": "zones unavailable"}
    enabled: list[str] = []
    by_zone: dict[str, dict] = {}
    errors: dict[str, str] = {}
    for name, zid in zones["_zone_index"].items():
        try:
            body = cf.get(f"/zones/{zid}/email/routing")
            r = body.get("result") or {}
            status = r.get("status")
            by_zone[name] = {
                "status": status,
                "enabled": r.get("enabled", False),
                "name": r.get("name"),
            }
            if r.get("enabled"):
                enabled.append(name)
        except CFError as e:
            if e.status in (400, 404):
                by_zone[name] = {"status": "not_configured"}
            else:
                errors[name] = str(e)
        except Exception as e:
            errors[name] = str(e)
    return {
        "ok": True,
        "enabled_count": len(enabled),
        "enabled_zones": enabled,
        "by_zone": by_zone,
        "errors": errors,
    }


def collect_kv(cf: CFClient) -> dict:
    try:
        ns = cf.paginate(f"/accounts/{cf.account_id}/storage/kv/namespaces")
        return {
            "ok": True,
            "count": len(ns),
            "namespaces": [{"id": n.get("id"), "title": n.get("title")} for n in ns],
        }
    except Exception as e:
        return _err(e)


def collect_r2(cf: CFClient) -> dict:
    try:
        body = cf.get(f"/accounts/{cf.account_id}/r2/buckets")
        buckets = (body.get("result") or {}).get("buckets") or []
        return {
            "ok": True,
            "count": len(buckets),
            "buckets": [{"name": b.get("name"), "creation_date": b.get("creation_date")} for b in buckets],
        }
    except Exception as e:
        return _err(e)


def collect_d1(cf: CFClient) -> dict:
    try:
        dbs = cf.paginate(f"/accounts/{cf.account_id}/d1/database")
        return {
            "ok": True,
            "count": len(dbs),
            "databases": [
                {
                    "name": d.get("name"),
                    "uuid": d.get("uuid"),
                    "version": d.get("version"),
                    "num_tables": d.get("num_tables"),
                    "file_size": d.get("file_size"),
                }
                for d in dbs
            ],
        }
    except Exception as e:
        return _err(e)


def collect_queues(cf: CFClient) -> dict:
    try:
        qs = cf.paginate(f"/accounts/{cf.account_id}/queues")
        return {
            "ok": True,
            "count": len(qs),
            "queues": [{"name": q.get("queue_name"), "id": q.get("queue_id")} for q in qs],
        }
    except Exception as e:
        return _err(e)


_WORKER_GQL = """
query WorkerStats($accountTag: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(
        filter: {datetime_geq: $start, datetime_leq: $end}
        limit: 10000
      ) {
        sum { requests errors subrequests responseBodySize }
        quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99 }
        dimensions { scriptName status }
      }
    }
  }
}
"""


def collect_workers_analytics(cf: CFClient, hours: int = 24) -> dict:
    end = datetime.now(timezone.utc).replace(microsecond=0)
    start = end - timedelta(hours=hours)
    try:
        data = cf.graphql(
            _WORKER_GQL,
            {
                "accountTag": cf.account_id,
                "start": start.isoformat().replace("+00:00", "Z"),
                "end": end.isoformat().replace("+00:00", "Z"),
            },
        )
        accts = (data.get("viewer") or {}).get("accounts") or []
        rows = accts[0].get("workersInvocationsAdaptive", []) if accts else []
        per_script: dict[str, dict] = {}
        totals = {"requests": 0, "errors": 0, "subrequests": 0}
        for row in rows:
            dim = row.get("dimensions") or {}
            s = dim.get("scriptName") or "?"
            sm = row.get("sum") or {}
            agg = per_script.setdefault(s, {"requests": 0, "errors": 0, "subrequests": 0})
            agg["requests"] += sm.get("requests", 0) or 0
            agg["errors"] += sm.get("errors", 0) or 0
            agg["subrequests"] += sm.get("subrequests", 0) or 0
            totals["requests"] += sm.get("requests", 0) or 0
            totals["errors"] += sm.get("errors", 0) or 0
            totals["subrequests"] += sm.get("subrequests", 0) or 0
        return {
            "ok": True,
            "window_hours": hours,
            "start": start.isoformat().replace("+00:00", "Z"),
            "end": end.isoformat().replace("+00:00", "Z"),
            "totals": totals,
            "per_script": per_script,
            "row_count": len(rows),
        }
    except Exception as e:
        return _err(e)
