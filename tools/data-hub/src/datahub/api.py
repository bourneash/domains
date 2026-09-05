import os
from datetime import datetime, timedelta, timezone
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from .config import Settings, Source, Subscription, load_sources, load_subscriptions
from . import store
from .vpn import probe_exit_ip


class EnabledBody(BaseModel):
    enabled: bool


def _client_ip(request: Request) -> str:
    return request.client.host if request and request.client else ""


def _csv(v: str | None) -> list[str]:
    return [x.strip() for x in (v or "").split(",") if x.strip()]


def _cisa_kev_to_items(records: list[dict]) -> list[dict]:
    out = []
    for r in records:
        p = r["payload"]
        title = f"{p.get('vendor_project', '')} {p.get('product', '')}: {p.get('vulnerability_name', '')}".strip(": ").strip()
        out.append({
            "title": title or p.get("vulnerability_name") or "",
            "url": p.get("notes") or "",
            "summary": p.get("short_description") or "",
            "published_iso": r["observed_at"],
            "source": "CISA KEV",
            "cve_id": p.get("cve_id") or "",
            "tags": r.get("tags", []),
        })
    return out


def _nvd_cve_to_items(records: list[dict]) -> list[dict]:
    out = []
    for r in records:
        p = r["payload"]
        cve_id = p.get("cve_id") or ""
        severity = p.get("severity") or ""
        score = p.get("cvss_score")
        title = f"{cve_id}" + (f" ({severity}, CVSS {score})" if severity else "")
        out.append({
            "title": title,
            "url": p.get("url") or "",
            "summary": p.get("summary") or "",
            "published_iso": r["observed_at"],
            "source": "NVD",
            "cve_id": cve_id,
            "tags": r.get("tags", []),
        })
    return out


# Maps a subscription's `datasets:` key to a function that reshapes raw
# dataset records (source_id/dataset_key/observed_at/payload/tags) into the
# same item shape /items and /subscriptions/{site}/items already return
# (title/url/summary/published_iso/source/cve_id). Keys with no adapter here
# are silently skipped in subscription_items() rather than emitting a
# malformed item — safe no-op until an adapter is added for that dataset.
_DATASET_ITEM_ADAPTERS = {
    "cisa-kev": _cisa_kev_to_items,
    "nvd-cve": _nvd_cve_to_items,
}


def create_app(settings: Settings, *, conn=None, sources: list[Source] | None = None,
               subscriptions: dict[str, Subscription] | None = None, vpn_client=None,
               analytics_sites: dict | None = None) -> FastAPI:
    app = FastAPI(title="datahub", version="0.1.0")

    if conn is None:
        conn = store.connect(settings.db_path)
        store.init_schema(conn)
    if sources is None:
        sources = load_sources(os.path.join(settings.registry_dir, "sources.yaml"))
    if subscriptions is None:
        subscriptions = load_subscriptions(os.path.join(settings.registry_dir, "subscriptions.yaml"))
    source_by_id = {s.id: s for s in sources}
    if analytics_sites is None:
        from .config import load_analytics_registry
        analytics_sites = load_analytics_registry(os.path.join(settings.registry_dir, "sites-analytics.yaml"))

    @app.get("/items")
    def items(request: Request, tags: str | None = None, match: str = "any", sources: str | None = None,
              exclude: str | None = None, since: str | None = None, limit: int = 200):
        taglist = _csv(tags)
        rows = store.query_items(
            conn,
            tags_any=(taglist or None) if match == "any" else None,
            tags_all=(taglist or None) if match == "all" else None,
            include_sources=_csv(sources) or None,
            exclude_sources=_csv(exclude) or None,
            since_iso=since, limit=limit,
        )
        store.record_pull(conn, endpoint="items", item_count=len(rows), client_ip=_client_ip(request))
        return {"items": rows}

    @app.get("/subscriptions/{site}/items")
    def subscription_items(site: str, request: Request):
        sub = subscriptions.get(site)
        if not sub:
            raise HTTPException(404, f"no subscription for {site}")
        q = sub.items
        since = None
        if q.window_hours:
            since = (datetime.now(timezone.utc) - timedelta(hours=q.window_hours)).isoformat()
        rows = store.query_items(
            conn,
            tags_any=q.tags_any or None, tags_all=q.tags_all or None,
            include_sources=q.include_sources or None, exclude_sources=q.exclude_sources or None,
            since_iso=since, limit=q.limit,
        )
        # `datasets:` in this subscription's config (e.g. cisa-kev, nvd-cve) was
        # previously declared but never actually queried here — this site's
        # puller only ever saw tagged RSS items, never its structured dataset
        # feeds. Merge in any dataset with a registered item-shape adapter.
        for key in sub.datasets:
            adapter = _DATASET_ITEM_ADAPTERS.get(key)
            if adapter is None:
                continue
            records = store.query_datasets(conn, key, since_iso=since, limit=q.limit)
            rows.extend(adapter(records))
        rows.sort(key=lambda r: r.get("published_iso") or "", reverse=True)
        store.record_pull(conn, site=site, endpoint=f"subscriptions/{site}/items",
                          item_count=len(rows), client_ip=_client_ip(request))
        return {"items": rows}

    @app.get("/subscriptions/{site}")
    def subscription(site: str):
        sub = subscriptions.get(site)
        if not sub:
            raise HTTPException(404, f"no subscription for {site}")
        return sub.model_dump()

    @app.get("/datasets")
    def datasets_index():
        return {"datasets": store.dataset_keys(conn)}

    @app.get("/datasets/{key}")
    def datasets_detail(key: str, request: Request, since: str | None = None, limit: int = 50):
        recs = store.query_datasets(conn, key, since_iso=since, limit=limit)
        store.record_pull(conn, endpoint=f"datasets/{key}", item_count=len(recs), client_ip=_client_ip(request))
        return {"records": recs}

    @app.get("/egress")
    def egress(since: str | None = None, limit: int = 200, policy: str | None = None):
        return {"events": store.query_egress(conn, since_iso=since, limit=limit, policy=policy)}

    @app.get("/pulls")
    def pulls(since: str | None = None, limit: int = 200, site: str | None = None):
        return {"pulls": store.query_pulls(conn, since_iso=since, limit=limit, site=site)}

    @app.get("/sources")
    def sources_list():
        state = {s["source_id"]: s for s in store.get_sources_state(conn)}
        overrides = store.get_source_overrides(conn)
        return {"sources": [
            {"id": s.id, "type": s.type, "tags": s.tags, "policy": s.policy,
             "exit": s.exit,
             "enabled": overrides.get(s.id, s.enabled),   # effective state
             "registry_default": s.enabled,
             "overridden": s.id in overrides,
             "state": state.get(s.id)}
            for s in source_by_id.values()
        ]}

    @app.post("/sources/{source_id}/enabled")
    def set_source_enabled(source_id: str, body: EnabledBody):
        s = source_by_id.get(source_id)
        if s is None:
            raise HTTPException(status_code=404, detail="unknown source")
        # If the desired state matches the registry default, clear the override
        # so "overridden" stays meaningful (= diverges from the registry).
        if body.enabled == s.enabled:
            store.clear_source_override(conn, source_id=source_id)
            overridden = False
        else:
            store.set_source_override(conn, source_id=source_id, enabled=body.enabled)
            overridden = True
        return {"id": source_id, "enabled": body.enabled,
                "registry_default": s.enabled, "overridden": overridden}

    @app.get("/health")
    def health():
        us = probe_exit_ip(settings.proxy_us, client=vpn_client)
        eu = probe_exit_ip(settings.proxy_eu, client=vpn_client)
        states = store.get_sources_state(conn)
        item_count = conn.execute("SELECT COUNT(*) AS n FROM items").fetchone()["n"]
        skipped = [s for s in states if (s["status"] or "").startswith("skipped")]
        return {
            "ok": bool(us or eu),
            "nodes": {"us": us, "eu": eu},
            "sources": states,
            "counts": {"items": item_count, "skipped": len(skipped)},
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }

    @app.get("/metrics/ga4")
    def metrics_ga4(request: Request, site: str, since: str | None = None, until: str | None = None,
                    grain: str = "site", limit: int = 400):
        rows = store.query_ga4_metrics(conn, site, grain=grain, since=since, until=until, limit=limit)
        store.record_pull(conn, site=site, endpoint="metrics/ga4", item_count=len(rows),
                          client_ip=_client_ip(request))
        return {"records": rows}

    @app.get("/metrics/gsc")
    def metrics_gsc(request: Request, site: str, since: str | None = None, until: str | None = None,
                    grain: str = "site", limit: int = 400):
        rows = store.query_gsc_metrics(conn, site, grain=grain, since=since, until=until, limit=limit)
        store.record_pull(conn, site=site, endpoint="metrics/gsc", item_count=len(rows),
                          client_ip=_client_ip(request))
        return {"records": rows}

    @app.get("/metrics/gsc-query-pages")
    def metrics_gsc_query_pages(request: Request, site: str, since: str | None = None,
                                until: str | None = None, limit: int = 5000):
        rows = store.query_gsc_query_page_metrics(
            conn, site, since=since, until=until, limit=limit)
        store.record_pull(conn, site=site, endpoint="metrics/gsc-query-pages",
                          item_count=len(rows), client_ip=_client_ip(request))
        return {"records": rows}

    @app.get("/metrics/summary")
    def metrics_summary(request: Request, site: str, window: int = 28):
        since = (datetime.now(timezone.utc) - timedelta(days=window)).date().isoformat()
        ga4_rows = store.query_ga4_metrics(conn, site, grain="site", since=since, limit=window + 1)
        gsc_rows = store.query_gsc_metrics(conn, site, grain="site", since=since, limit=window + 1)
        if not ga4_rows and not gsc_rows:
            return {"site": site, "window_days": window, "has_data": False}
        out = {"site": site, "window_days": window, "has_data": True}
        # Only populate a source's keys when that source actually has rows for
        # the window — an absent source (e.g. GSC onboarded later than GA4)
        # must contribute NO keys, not fabricated zero-valued ones. Absence is
        # not zero.
        if ga4_rows:
            for key in ("sessions", "users", "new_users", "views", "conversions"):
                out[key] = sum(r[key] or 0 for r in ga4_rows)
        if gsc_rows:
            for key in ("clicks", "impressions"):
                out[key] = sum(r[key] or 0 for r in gsc_rows)
        store.record_pull(conn, site=site, endpoint="metrics/summary", item_count=1,
                          client_ip=_client_ip(request))
        return out

    # A bogus metric name must 422, not silently rank everything at a fabricated
    # 0 via r.get(metric) — same "absence is not zero" family as /metrics/summary.
    _TOP_METRICS = {
        "ga4": {"sessions", "users", "new_users", "views", "engaged_sessions",
                "engagement_rate", "avg_session_duration", "conversions"},
        "gsc": {"clicks", "impressions", "ctr", "position"},
    }

    @app.get("/metrics/top")
    def metrics_top(request: Request, site: str, source: str, metric: str, window: int = 28, limit: int = 10):
        since = (datetime.now(timezone.utc) - timedelta(days=window)).date().isoformat()
        if source == "ga4":
            rows = store.query_ga4_metrics(conn, site, grain="page", since=since, limit=5000)
        elif source == "gsc":
            rows = store.query_gsc_metrics(conn, site, grain="query", since=since, limit=5000)
        else:
            raise HTTPException(422, "source must be 'ga4' or 'gsc'")
        if metric not in _TOP_METRICS[source]:
            raise HTTPException(422, f"metric must be one of {sorted(_TOP_METRICS[source])}")
        totals: dict[str, float] = {}
        for r in rows:
            totals[r["dim_key"]] = totals.get(r["dim_key"], 0) + (r.get(metric) or 0)
        ranked = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)[:limit]
        top = [{"dim_key": k, metric: v} for k, v in ranked]
        store.record_pull(conn, site=site, endpoint="metrics/top", item_count=len(top),
                          client_ip=_client_ip(request))
        return {"top": top}

    @app.get("/metrics/health")
    def metrics_health(request: Request):
        states = {s["source_id"]: s for s in store.get_sources_state(conn)}
        out = {}
        for site, cfg in analytics_sites.items():
            out[site] = {
                "consent_gated": cfg.consent_gated,
                "ga4": states.get(f"ga4:{site}"),
                "gsc": states.get(f"gsc:{site}"),
            }
        store.record_pull(conn, endpoint="metrics/health", item_count=len(out),
                          client_ip=_client_ip(request))
        return {"sites": out, "generated_at": datetime.now(timezone.utc).isoformat()}

    return app
