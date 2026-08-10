"""product-feed HTTP API — FastAPI app, mirrors tools/data-hub's create_app()
shape (a factory taking Settings + optional injected conn/subscriptions for
tests) so this reads like a sibling of that service, not a new pattern.
"""
from fastapi import FastAPI, HTTPException

from . import store
from .config import Settings, Subscription, load_subscriptions


class CandidateIn:
    """Plain dict body (not a pydantic model) — the payload shapes
    (candidate/decision) are owned by each site's own scout/judge pipeline
    and deliberately opaque to the hub; validating their internals here
    would just duplicate each site's own schema and break the moment a site
    adds a field. The hub only cares about site_origin/asin/tags."""


def create_app(settings: Settings | None = None, *, conn=None, subscriptions: dict[str, Subscription] | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    app = FastAPI(title="product-feed", version="0.1.0")

    if conn is None:
        conn = store.connect(settings.db_path)
        store.init_schema(conn)
    if subscriptions is None:
        import os

        subscriptions = load_subscriptions(os.path.join(settings.registry_dir, "subscriptions.yaml"))

    def _subscription(site: str) -> Subscription:
        sub = subscriptions.get(site)
        if sub is None:
            raise HTTPException(404, f"no subscription registered for {site!r} — add it to registry/subscriptions.yaml")
        return sub

    @app.get("/health")
    def health():
        return {"ok": True, "subscriptions": list(subscriptions.keys())}

    @app.post("/candidates", status_code=201)
    def add_candidate(body: dict):
        site_origin = body.get("site_origin")
        tags = body.get("tags")
        candidate = body.get("candidate")
        decision = body.get("decision")
        if not site_origin or not tags or not candidate or not decision:
            raise HTTPException(422, "site_origin, tags, candidate, and decision are all required")
        candidate_id = store.add_candidate(
            conn,
            site_origin=site_origin,
            asin=candidate.get("asin"),
            tags=tags,
            candidate=candidate,
            decision=decision,
        )
        return {"id": candidate_id, "status": "queued"}

    @app.get("/candidates/{candidate_id}")
    def get_candidate(candidate_id: int):
        row = store.get_candidate(conn, candidate_id)
        if row is None:
            raise HTTPException(404, "no such candidate")
        return row

    @app.get("/candidates")
    def list_candidates(status: str | None = None, site_origin: str | None = None, tag: str | None = None, limit: int = 100):
        return {"items": store.list_candidates(conn, status=status, site_origin=site_origin, tag=tag, limit=limit)}

    @app.post("/candidates/{candidate_id}/published")
    def mark_published(candidate_id: int):
        if not store.mark_status(conn, candidate_id, "published"):
            raise HTTPException(404, "no such candidate")
        return {"id": candidate_id, "status": "published"}

    @app.post("/candidates/{candidate_id}/release")
    def release_candidate(candidate_id: int):
        """Publish attempt failed downstream (build/commit/push) — put the
        item back in the queue for a future publish tick instead of losing
        it. Mirrors the old local run-product-publish.sh behavior of
        leaving a failed item in place for retry/inspection."""
        if not store.mark_status(conn, candidate_id, "queued"):
            raise HTTPException(404, "no such candidate")
        return {"id": candidate_id, "status": "queued"}

    @app.get("/subscriptions/{site}/next")
    def next_for_site(site: str):
        sub = _subscription(site)
        claimed = store.claim_next(conn, tags_any=sub.tags_any, site_origin_allow=sub.site_origin_allow, claimed_by=site)
        if claimed is None:
            return {"item": None}
        return {"item": claimed}

    @app.get("/subscriptions/{site}/depth")
    def depth_for_site(site: str):
        sub = _subscription(site)
        n = store.active_depth(conn, tags_any=sub.tags_any)
        return {"site": site, "depth": n, "max_queue_depth": sub.max_queue_depth}

    @app.get("/stats")
    def stats():
        return store.stats(conn)

    return app
