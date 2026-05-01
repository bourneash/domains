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


_ZONE_AGG_GQL = """
query ZoneAgg($zoneTags: [String!]!, $startDate: Date!, $endDate: Date!) {
  viewer {
    zones(filter: { zoneTag_in: $zoneTags }) {
      zoneTag
      httpRequests1dGroups(limit: 1000, filter: { date_geq: $startDate, date_leq: $endDate }) {
        dimensions { date }
        sum { requests pageViews bytes threats cachedRequests cachedBytes }
        uniq { uniques }
      }
    }
  }
}
"""


_ZONE_DETAIL_GQL = """
query ZoneDetail($zid: String!, $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag: $zid }) {
      byCountry: httpRequestsAdaptiveGroups(
        limit: 15, filter: { datetime_geq: $start, datetime_leq: $end }, orderBy: [count_DESC]
      ) {
        count
        dimensions { clientCountryName }
      }
      byPath: httpRequestsAdaptiveGroups(
        limit: 25, filter: { datetime_geq: $start, datetime_leq: $end }, orderBy: [count_DESC]
      ) {
        count
        dimensions { clientRequestPath }
      }
      byStatus: httpRequestsAdaptiveGroups(
        limit: 15, filter: { datetime_geq: $start, datetime_leq: $end }, orderBy: [count_DESC]
      ) {
        count
        dimensions { edgeResponseStatus }
      }
      blocked: httpRequestsAdaptiveGroups(
        limit: 15,
        filter: { datetime_geq: $start, datetime_leq: $end, edgeResponseStatus_in: [403, 429] },
        orderBy: [count_DESC]
      ) {
        count
        dimensions { clientCountryName clientRequestPath }
      }
    }
  }
}
"""


_RUM_GQL = """
query RumStats($acct: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $acct }) {
      byReferer: rumPageloadEventsAdaptiveGroups(
        limit: 50,
        filter: { datetime_geq: $start, datetime_leq: $end },
        orderBy: [count_DESC]
      ) {
        count
        dimensions { requestHost refererHost }
      }
      byCountry: rumPageloadEventsAdaptiveGroups(
        limit: 50,
        filter: { datetime_geq: $start, datetime_leq: $end },
        orderBy: [count_DESC]
      ) {
        count
        dimensions { requestHost countryName }
      }
      byPath: rumPageloadEventsAdaptiveGroups(
        limit: 100,
        filter: { datetime_geq: $start, datetime_leq: $end },
        orderBy: [count_DESC]
      ) {
        count
        dimensions { requestHost requestPath }
      }
      byDevice: rumPageloadEventsAdaptiveGroups(
        limit: 30,
        filter: { datetime_geq: $start, datetime_leq: $end },
        orderBy: [count_DESC]
      ) {
        count
        dimensions { requestHost deviceType }
      }
    }
  }
}
"""


def collect_rum_analytics(cf: CFClient, hours: int = 168) -> dict:
    """Cloudflare Web Analytics (RUM beacon) data across all sites.
    Pulls referers, countries, top paths, device types at account level.
    hours=168 = 7 days (default)."""
    end = datetime.now(timezone.utc).replace(microsecond=0)
    start = end - timedelta(hours=hours)
    fmt = lambda d: d.isoformat().replace("+00:00", "Z")
    try:
        data = cf.graphql(_RUM_GQL, {
            "acct": cf.account_id,
            "start": fmt(start),
            "end": fmt(end),
        })
        accts = (data.get("viewer") or {}).get("accounts") or []
        a = accts[0] if accts else {}

        per_site: dict[str, dict] = {}
        totals: dict[str, int] = {}

        def agg(rows: list, key: str, dim_key: str) -> None:
            for r in rows:
                host = r["dimensions"].get("requestHost") or "unknown"
                site = per_site.setdefault(host, {})
                bucket = site.setdefault(key, [])
                bucket.append({dim_key: r["dimensions"].get(dim_key), "count": r["count"]})
                totals[host] = totals.get(host, 0) + (r["count"] if key == "by_referer" else 0)

        agg(a.get("byReferer") or [], "by_referer", "refererHost")
        agg(a.get("byCountry") or [], "by_country", "countryName")
        agg(a.get("byPath") or [], "by_path", "requestPath")
        agg(a.get("byDevice") or [], "by_device", "deviceType")

        return {
            "ok": True,
            "window_hours": hours,
            "start": fmt(start),
            "end": fmt(end),
            "total_pageloads": sum(totals.values()),
            "per_site": per_site,
        }
    except Exception as e:
        return _err(e)


def collect_zone_analytics(cf: CFClient, zones: dict, lookback_days: int = 7,
                           detail_hours: int = 24, only_zones: list[str] | None = None) -> dict:
    """Per-zone HTTP analytics: 7d aggregates (pageviews, uniques, bytes, threats)
    in one batched GraphQL call, plus per-zone 24h drill-down (top countries,
    paths, status mix, blocked traffic). Free plan limits adaptive groups to a
    1-day window, so detail queries run per-zone over the last 24h."""
    if not zones.get("ok"):
        return {"ok": False, "error": "zones unavailable"}

    zone_index = zones["_zone_index"]
    if only_zones:
        zone_index = {n: i for n, i in zone_index.items() if n in only_zones}
    if not zone_index:
        return {"ok": True, "lookback_days": lookback_days, "per_zone": {}, "totals": {}}

    end = datetime.now(timezone.utc).replace(microsecond=0)
    start_d = (end - timedelta(days=lookback_days)).date()
    end_d = end.date()
    detail_start = end - timedelta(hours=detail_hours)
    fmt_t = lambda d: d.isoformat().replace("+00:00", "Z")

    per_zone: dict[str, dict] = {}
    errors: dict[str, str] = {}

    # --- 7d aggregate: batched calls (CF caps zoneTag_in around ~10) ---
    name_by_id = {zid: name for name, zid in zone_index.items()}
    all_ids = list(zone_index.values())
    BATCH = 10
    for i in range(0, len(all_ids), BATCH):
        batch_ids = all_ids[i:i + BATCH]
        try:
            data = cf.graphql(_ZONE_AGG_GQL, {
                "zoneTags": batch_ids,
                "startDate": start_d.isoformat(),
                "endDate": end_d.isoformat(),
            })
            for z in (data.get("viewer") or {}).get("zones", []):
                name = name_by_id.get(z.get("zoneTag"))
                if not name:
                    continue
                days = z.get("httpRequests1dGroups") or []
                agg = {
                    "requests": sum(d["sum"]["requests"] for d in days),
                    "pageViews": sum(d["sum"]["pageViews"] for d in days),
                    "uniques": sum(d["uniq"]["uniques"] for d in days),
                    "bytes": sum(d["sum"]["bytes"] for d in days),
                    "threats": sum(d["sum"]["threats"] for d in days),
                    "cachedRequests": sum(d["sum"]["cachedRequests"] for d in days),
                    "cachedBytes": sum(d["sum"]["cachedBytes"] for d in days),
                }
                per_zone.setdefault(name, {})["window_days"] = lookback_days
                per_zone[name]["totals"] = agg
                per_zone[name]["daily"] = [
                    {
                        "date": d["dimensions"]["date"],
                        "requests": d["sum"]["requests"],
                        "pageViews": d["sum"]["pageViews"],
                        "uniques": d["uniq"]["uniques"],
                        "bytes": d["sum"]["bytes"],
                        "threats": d["sum"]["threats"],
                    }
                    for d in sorted(days, key=lambda r: r["dimensions"]["date"])
                ]
        except Exception as e:
            errors[f"__aggregate_batch_{i}__"] = str(e)

    # --- 24h per-zone drill-down ---
    for name, zid in zone_index.items():
        try:
            data = cf.graphql(_ZONE_DETAIL_GQL, {
                "zid": zid,
                "start": fmt_t(detail_start),
                "end": fmt_t(end),
            })
            zlist = (data.get("viewer") or {}).get("zones") or []
            z = zlist[0] if zlist else {}
            detail = {
                "window_hours": detail_hours,
                "by_country": [
                    {"country": r["dimensions"]["clientCountryName"], "count": r["count"]}
                    for r in z.get("byCountry") or []
                ],
                "by_path": [
                    {"path": r["dimensions"]["clientRequestPath"], "count": r["count"]}
                    for r in z.get("byPath") or []
                ],
                "by_status": {
                    str(r["dimensions"]["edgeResponseStatus"]): r["count"]
                    for r in z.get("byStatus") or []
                },
                "blocked": [
                    {
                        "country": r["dimensions"]["clientCountryName"],
                        "path": r["dimensions"]["clientRequestPath"],
                        "count": r["count"],
                    }
                    for r in z.get("blocked") or []
                ],
            }
            per_zone.setdefault(name, {})["recent"] = detail
        except Exception as e:
            errors[name] = str(e)

    # portfolio totals (over lookback window)
    portfolio = {"requests": 0, "pageViews": 0, "uniques": 0, "bytes": 0, "threats": 0}
    for z in per_zone.values():
        t = z.get("totals") or {}
        for k in portfolio:
            portfolio[k] += t.get(k, 0)

    return {
        "ok": True,
        "lookback_days": lookback_days,
        "detail_hours": detail_hours,
        "zone_count": len(zone_index),
        "totals": portfolio,
        "per_zone": per_zone,
        "errors": errors,
    }


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
