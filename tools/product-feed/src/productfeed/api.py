"""HTTP API for shared verified products and per-site selection queues."""
import re

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

    @app.post("/products", status_code=201)
    def add_product(body: dict):
        """Insert or refresh one verified Amazon product.

        The feed derives the canonical ``/dp/<ASIN>`` URL itself. A producer
        cannot accidentally turn a discovery search URL into a destination.
        """
        asin = str(body.get("asin") or "").strip().upper()
        title = str(body.get("title") or "").strip()
        tags = body.get("tags")
        if not re.fullmatch(r"[A-Z0-9]{10}", asin):
            raise HTTPException(422, "asin must be exactly 10 uppercase letters/digits")
        if not title or not isinstance(tags, list) or not tags:
            raise HTTPException(422, "title and a non-empty tags list are required")
        product, created = store.upsert_product(
            conn,
            asin=asin,
            title=title,
            tags=tags,
            price=body.get("price"),
            rating=body.get("rating"),
            review_count=body.get("review_count"),
            image_url=body.get("image_url"),
            source_query=body.get("source_query"),
            source=body.get("source") or "amazon",
            metadata=body.get("metadata") or {},
        )
        return {"created": created, "product": product}

    @app.get("/products")
    def list_products(tag: str | None = None, limit: int = 100):
        return {"items": store.list_products(conn, tag=tag, limit=min(max(limit, 1), 500))}

    @app.get("/products/{asin}")
    def get_product(asin: str):
        product = store.get_product(conn, asin.upper())
        if product is None:
            raise HTTPException(404, "no such product")
        return product

    @app.post("/subscriptions/{site}/products/next-review")
    def next_product_for_review(site: str):
        sub = _subscription(site)
        item = store.claim_product_for_review(conn, site=site, tags_any=sub.tags_any)
        return {"item": item}

    @app.post("/subscriptions/{site}/products/{asin}/queue")
    def queue_product_for_site(site: str, asin: str, body: dict):
        _subscription(site)
        decision = body.get("decision")
        if not isinstance(decision, dict) or not decision.get("fits"):
            raise HTTPException(422, "an accepted site decision is required")
        if not store.set_site_product_status(
            conn, site=site, asin=asin.upper(), status="queued", decision=decision
        ):
            raise HTTPException(404, "product is not claimed for this site")
        return {"site": site, "asin": asin.upper(), "status": "queued"}

    @app.post("/subscriptions/{site}/products/{asin}/reject")
    def reject_product_for_site(site: str, asin: str, body: dict):
        _subscription(site)
        reason = str(body.get("reason") or "site rejected product")
        if not store.set_site_product_status(
            conn, site=site, asin=asin.upper(), status="rejected", reason=reason
        ):
            raise HTTPException(404, "product is not claimed for this site")
        return {"site": site, "asin": asin.upper(), "status": "rejected"}

    @app.post("/subscriptions/{site}/products/{asin}/review-release")
    def release_product_review(site: str, asin: str):
        _subscription(site)
        if not store.release_site_product_review(conn, site=site, asin=asin.upper()):
            raise HTTPException(404, "product is not currently under review for this site")
        return {"site": site, "asin": asin.upper(), "status": "available"}

    @app.post("/subscriptions/{site}/products/publish-next")
    def next_product_to_publish(site: str):
        _subscription(site)
        item = store.claim_queued_product_for_publish(conn, site=site)
        return {"item": item}

    @app.post("/subscriptions/{site}/products/{asin}/published")
    def mark_site_product_published(site: str, asin: str):
        _subscription(site)
        if not store.set_site_product_status(
            conn, site=site, asin=asin.upper(), status="published"
        ):
            raise HTTPException(404, "product is not queued for this site")
        return {"site": site, "asin": asin.upper(), "status": "published"}

    @app.post("/subscriptions/{site}/products/{asin}/publish-release")
    def release_site_product_publish(site: str, asin: str):
        _subscription(site)
        if not store.set_site_product_status(
            conn, site=site, asin=asin.upper(), status="queued"
        ):
            raise HTTPException(404, "product is not queued for this site")
        return {"site": site, "asin": asin.upper(), "status": "queued"}

    @app.get("/subscriptions/{site}/products/queue")
    def site_product_queue(site: str, limit: int = 100):
        _subscription(site)
        return {"items": store.list_site_queue(conn, site=site, limit=min(max(limit, 1), 500))}

    @app.get("/subscriptions/{site}/inventory-depth")
    def inventory_depth_for_site(site: str):
        sub = _subscription(site)
        depth = store.inventory_depth(conn, site=site, tags_any=sub.tags_any)
        return {
            "site": site,
            **depth,
            "target_available_depth": sub.target_available_depth,
            "review_batch_size": sub.review_batch_size,
        }

    @app.get("/inventory/stats")
    def inventory_stats():
        return store.product_inventory_stats(conn)

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
