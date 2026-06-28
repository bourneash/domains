import os
from datetime import datetime, timedelta, timezone
from fastapi import FastAPI, HTTPException
from .config import Settings, Source, Subscription, load_sources, load_subscriptions
from . import store
from .vpn import probe_exit_ip


def _csv(v: str | None) -> list[str]:
    return [x.strip() for x in (v or "").split(",") if x.strip()]


def create_app(settings: Settings, *, conn=None, sources: list[Source] | None = None,
               subscriptions: dict[str, Subscription] | None = None, vpn_client=None) -> FastAPI:
    app = FastAPI(title="datahub", version="0.1.0")

    if conn is None:
        conn = store.connect(settings.db_path)
        store.init_schema(conn)
    if sources is None:
        sources = load_sources(os.path.join(settings.registry_dir, "sources.yaml"))
    if subscriptions is None:
        subscriptions = load_subscriptions(os.path.join(settings.registry_dir, "subscriptions.yaml"))
    source_by_id = {s.id: s for s in sources}

    @app.get("/items")
    def items(tags: str | None = None, match: str = "any", sources: str | None = None,
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
        return {"items": rows}

    @app.get("/subscriptions/{site}/items")
    def subscription_items(site: str):
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
    def datasets_detail(key: str, since: str | None = None, limit: int = 50):
        return {"records": store.query_datasets(conn, key, since_iso=since, limit=limit)}

    @app.get("/egress")
    def egress(since: str | None = None, limit: int = 200, policy: str | None = None):
        return {"events": store.query_egress(conn, since_iso=since, limit=limit, policy=policy)}

    @app.get("/sources")
    def sources_list():
        state = {s["source_id"]: s for s in store.get_sources_state(conn)}
        return {"sources": [
            {"id": s.id, "type": s.type, "tags": s.tags, "policy": s.policy,
             "exit": s.exit, "state": state.get(s.id)}
            for s in source_by_id.values()
        ]}

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

    return app
