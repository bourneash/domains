import os
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

from . import blob, reuse, store, vpn
from .config import Settings, Source, Topic, load_sources

CONTENT_TYPES = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "webp": "image/webp", "gif": "image/gif",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _client_ip(request: Request) -> str:
    return request.client.host if request and request.client else ""


def _image_out(img: dict) -> dict:
    return {
        "id": img["id"], "url": f"/image/{img['id']}", "credit": img.get("credit"),
        "license": img.get("license"), "width": img.get("width"), "height": img.get("height"),
    }


def _default_registry_dir() -> str:
    # tools/data-hub-images/src/datahub_images/api.py -> tools/data-hub-images/registry
    here = os.path.dirname(os.path.abspath(__file__))
    return os.environ.get(
        "DATAHUB_IMAGES_REGISTRY_DIR",
        os.path.normpath(os.path.join(here, "..", "..", "registry")),
    )


class RequestBody(BaseModel):
    site: str
    topic: str
    keywords: list[str] | None = None
    count: int = 1
    slug: str | None = None


class EnabledBody(BaseModel):
    enabled: bool


def create_app(settings: Settings, *, conn=None, sources: list[Source] | None = None,
               vpn_client=None) -> FastAPI:
    app = FastAPI(title="datahub-images", version="0.1.0")

    if conn is None:
        conn = store.connect(settings.db_path)
        store.init_schema(conn)
    if sources is None:
        sources_path = os.path.join(_default_registry_dir(), "sources.yaml")
        sources = load_sources(sources_path) if os.path.exists(sources_path) else []
    source_by_id = {s.id: s for s in sources}

    @app.post("/request")
    def create_request(body: RequestBody, request: Request):
        now = _now()
        topic = Topic(id=body.topic, queries=[])
        count = max(1, body.count)
        images: list[dict] = []
        for _ in range(count):
            img = reuse.select_image(conn, topic, body.site, body.slug, settings, now)
            if img is None:
                break
            store.record_assignment(conn, img["id"], body.site, body.slug, topic.id, now)
            store.set_last_used(conn, img["id"], now)
            images.append(img)

        store.record_pull(conn, site=body.site, endpoint="request",
                           item_count=len(images), client_ip=_client_ip(request))

        if images:
            return {"images": [_image_out(i) for i in images]}

        request_id = store.create_request(
            conn, body.site, body.topic, body.keywords or [], body.count, now,
            _client_ip(request), slug=body.slug,
        )
        return {"status": "pending", "request_id": request_id}

    @app.get("/request/{request_id}")
    def request_status(request_id: int):
        req = store.get_request(conn, request_id)
        if req is None:
            raise HTTPException(404, "unknown request")
        return req

    @app.get("/image/{image_id}")
    def get_image(image_id: str, request: Request):
        img = store.get_image(conn, image_id)
        if img is None or not img.get("blob_path"):
            raise HTTPException(404, "unknown image")
        try:
            data = blob.read_blob(img["blob_path"])
        except OSError:
            raise HTTPException(404, "blob missing")
        ext = img["blob_path"].rsplit(".", 1)[-1].lower()
        store.record_pull(conn, site="", endpoint=f"/image/{image_id}",
                           item_count=1, client_ip=_client_ip(request))
        return Response(content=data, media_type=CONTENT_TYPES.get(ext, "application/octet-stream"))

    @app.get("/images")
    def list_images(request: Request, topic: str | None = None, site: str | None = None,
                     status: str | None = None, limit: int = 100):
        images = store.list_images(conn, topic=topic, status=status, limit=limit)
        if site:
            assigned_ids = {a["image_id"] for a in
                            store.site_recent_assignments(conn, site, "0000-01-01T00:00:00")}
            images = [i for i in images if i["id"] in assigned_ids]
        store.record_pull(conn, site=site or "", endpoint="/images",
                           item_count=len(images), client_ip=_client_ip(request))
        return {"images": images}

    @app.get("/stats")
    def stats():
        topic_rows = conn.execute(
            "SELECT DISTINCT value AS topic FROM images, json_each(images.topics_json)"
        ).fetchall()
        by_topic = {r["topic"]: store.pool_depth(conn, r["topic"]) for r in topic_rows}
        by_source = {r["source_id"]: r["n"] for r in conn.execute(
            "SELECT source_id, COUNT(*) AS n FROM images WHERE status = 'active' GROUP BY source_id"
        ).fetchall()}
        by_license = {r["license"]: r["n"] for r in conn.execute(
            "SELECT license, COUNT(*) AS n FROM images WHERE status = 'active' GROUP BY license"
        ).fetchall()}
        by_request_status = {r["status"]: r["n"] for r in conn.execute(
            "SELECT status, COUNT(*) AS n FROM requests GROUP BY status"
        ).fetchall()}
        return {
            "pool_by_topic": by_topic,
            "pool_by_source": by_source,
            "pool_by_license": by_license,
            "requests_by_status": by_request_status,
        }

    def _probe(proxy_url: str | None) -> str | None:
        if not proxy_url:
            return None
        try:
            return vpn.probe_exit_ip(proxy_url, client=vpn_client)
        except Exception:
            return None

    @app.get("/health")
    def health():
        us = _probe(settings.proxy_us)
        eu = _probe(settings.proxy_eu)
        try:
            conn.execute("SELECT 1")
            db_ok = True
        except Exception:
            db_ok = False
        return {
            "ok": db_ok and bool(us or eu),
            "vpn": {"us": us, "eu": eu},
            "db": db_ok,
            "generated_at": _now(),
        }

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
            {"id": s.id, "kind": s.kind, "policy": s.policy, "exit": s.exit,
             "enabled": overrides.get(s.id, s.enabled),
             "registry_default": s.enabled,
             "overridden": s.id in overrides,
             "state": state.get(s.id)}
            for s in source_by_id.values()
        ]}

    @app.post("/sources/{source_id}/enabled")
    def set_source_enabled(source_id: str, body: EnabledBody):
        s = source_by_id.get(source_id)
        if s is None:
            raise HTTPException(404, "unknown source")
        if body.enabled == s.enabled:
            store.clear_source_override(conn, source_id=source_id)
            overridden = False
        else:
            store.set_source_override(conn, source_id=source_id, enabled=body.enabled)
            overridden = True
        return {"id": source_id, "enabled": body.enabled,
                "registry_default": s.enabled, "overridden": overridden}

    @app.post("/images/{image_id}/blacklist")
    def blacklist(image_id: str):
        img = store.get_image(conn, image_id)
        if img is None:
            raise HTTPException(404, "unknown image")
        store.blacklist_image(conn, image_id)
        return {"id": image_id, "status": "blacklisted"}

    @app.post("/images/{image_id}/reject")
    def reject(image_id: str):
        img = store.get_image(conn, image_id)
        if img is None:
            raise HTTPException(404, "unknown image")
        store.delete_image(conn, image_id)
        return {"id": image_id, "status": "deleted"}

    return app
