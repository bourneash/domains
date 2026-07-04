"""Collector cycle: pool-fill → request-drain → prune.

Wires together every prior module (vpn, sources, scoring, blob, store, reuse)
into the fetch→pool→serve loop. Mirrors the per-source isolation pattern in
tools/data-hub/src/datahub/collector.py: one broken source or one malformed
candidate is caught, logged via egress_log, and never aborts the cycle.
"""
from urllib.parse import urlparse

import httpx

from . import blob, reuse, scoring, store, vpn
from . import sources as sources_pkg
from .config import Settings, Source, Topic
from .sources import SOURCE_FETCHERS

CANDIDATES_PER_SOURCE = 5


def _host(url: str | None) -> str:
    try:
        return urlparse(url or "").hostname or ""
    except Exception:
        return ""


def _download(url: str, proxy: str | None, http=None) -> tuple[bytes, str]:
    """Fetch image bytes through the given proxy. Returns (bytes, ext)."""
    owns = http is None
    client = http or httpx.Client(proxy=proxy, timeout=20.0)
    try:
        r = client.get(url, timeout=20.0)
        r.raise_for_status()
        ext = (urlparse(url).path.rsplit(".", 1)[-1] or "jpg").lower()
        if not ext.isalnum() or len(ext) > 5:
            ext = "jpg"
        return r.content, ext
    finally:
        if owns:
            client.close()


def fetch_and_store(conn, source: Source, topic: Topic, settings: Settings, now: str, http=None) -> int:
    """Fetch candidates for one source+topic, validate/score/store them.

    Returns the number of new images stored. Never raises — any failure for
    this source (plan_fetch, the fetcher call, a single candidate) is caught,
    recorded to egress_log, and the function returns what it managed so far.
    """
    stored = 0
    # Look up the fetcher via the live module attribute (not the frozen
    # SOURCE_FETCHERS dict, whose values were bound at import time) so that
    # tests/ops can monkeypatch e.g. `datahub_images.sources.wikimedia.search`
    # and have the collector pick up the patched version.
    mod = getattr(sources_pkg, source.kind, None)
    fetcher = getattr(mod, "search", None) if mod else SOURCE_FETCHERS.get(source.kind)
    if fetcher is None:
        store.record_egress(
            conn, source_id=source.id, target_host="", policy=source.policy,
            exit_node="", exit_ip=None, status="error",
            note=f"unknown source kind: {source.kind}",
        )
        return stored

    query = " OR ".join(topic.queries) if topic.queries else topic.id
    plan = None
    try:
        plan = vpn.plan_fetch(source, settings)
        if not plan.allowed:
            store.record_egress(
                conn, source_id=source.id, target_host=_host(source.url),
                policy=source.policy, exit_node=plan.exit_node, exit_ip=plan.exit_ip,
                status="skipped", note=plan.reason,
            )
            return stored

        cands = fetcher(query, CANDIDATES_PER_SOURCE, plan.proxy)
    except Exception as exc:  # per-source isolation
        exit_node = plan.exit_node if plan else ""
        exit_ip = plan.exit_ip if plan else None
        store.record_egress(
            conn, source_id=source.id, target_host=_host(source.url),
            policy=source.policy, exit_node=exit_node, exit_ip=exit_ip,
            status="error", note=str(exc)[:200],
        )
        return stored

    pool_phashes = [img["phash"] for img in store.pool_for_topic(conn, topic.id) if img.get("phash")]

    for cand in cands:
        try:
            key = cand.get("source_image_key")
            if not key or store.seen_source(conn, key):
                continue

            data, ext = _download(cand["url"], plan.proxy, http)

            if not scoring.validate(data):
                continue

            phash = scoring.phash_hex(data)
            if store.is_blacklisted_phash(conn, phash):
                continue
            if any(scoring.is_near_dup(phash, p) for p in pool_phashes):
                continue

            score = scoring.score_candidate(cand, topic)
            sha, path = blob.write_blob(settings.blob_dir, data, ext)
            width, height = scoring.dimensions(data)

            image = {
                "id": sha,
                "source_id": source.id,
                "source_image_key": key,
                "blob_path": path,
                "width": cand.get("width") or width,
                "height": cand.get("height") or height,
                "phash": phash,
                "score": score,
                "license": cand.get("license"),
                "credit": cand.get("credit"),
                "topics": [topic.id],
                "tags": cand.get("tags") or [],
                "entropy": scoring.entropy(data),
                "fetched_at": now,
            }
            inserted = store.upsert_image(conn, image)
            store.mark_seen(conn, key, sha, now)
            if inserted:
                pool_phashes.append(phash)
                stored += 1
        except Exception as exc:  # per-candidate isolation
            store.record_egress(
                conn, source_id=source.id, target_host=_host(cand.get("url") if isinstance(cand, dict) else None),
                policy=source.policy, exit_node=plan.exit_node, exit_ip=plan.exit_ip,
                status="error", note=str(exc)[:200],
            )
            continue

    store.record_egress(
        conn, source_id=source.id, target_host=_host(source.url),
        policy=source.policy, exit_node=plan.exit_node, exit_ip=plan.exit_ip,
        status="ok", item_count=stored,
    )
    return stored


def _topics_by_id(topics: list[Topic]) -> dict:
    return {t.id: t for t in topics}


def run_cycle(settings: Settings, conn, sources: list[Source], topics: list[Topic], now: str, http=None) -> dict:
    counts = {"fetched": 0, "assigned": 0, "requests_done": 0, "pruned": 0}

    # Phase 1: pool fill.
    for topic in topics:
        try:
            depth = store.pool_depth(conn, topic.id)
        except Exception:
            depth = 0
        if depth >= topic.target_depth:
            continue
        for source in sources:
            if not source.enabled:
                continue
            try:
                depth = store.pool_depth(conn, topic.id)
            except Exception:
                depth = 0
            if depth >= topic.target_depth:
                break
            counts["fetched"] += fetch_and_store(conn, source, topic, settings, now, http)

    # Phase 2: request drain.
    tmap = _topics_by_id(topics)
    for req in store.pending_requests(conn):
        topic = tmap.get(req.get("topic"))
        assigned_ids = []
        result_note = None
        if topic is None:
            result_note = f"unknown topic: {req.get('topic')}"
        else:
            wanted = req.get("count") or 1
            for _ in range(wanted):
                img = reuse.select_image(conn, topic, req["site"], req.get("keywords"), settings, now)
                if img is None:
                    # Targeted fetch attempt: try to top up the pool from any
                    # enabled source for this topic, then re-select once.
                    for source in sources:
                        if not source.enabled:
                            continue
                        fetch_and_store(conn, source, topic, settings, now, http)
                    img = reuse.select_image(conn, topic, req["site"], req.get("keywords"), settings, now)
                if img is None:
                    break
                store.record_assignment(conn, img["id"], req["site"], req.get("keywords"), topic.id, now)
                store.set_last_used(conn, img["id"], now)
                assigned_ids.append(img["id"])

        status = "done" if assigned_ids else "failed"
        result = {"image_ids": assigned_ids}
        if result_note:
            result["note"] = result_note
        try:
            store.finish_request(conn, req["id"], status, result, now)
        except Exception:
            continue
        counts["assigned"] += len(assigned_ids)
        counts["requests_done"] += 1

    # Phase 3: prune.
    try:
        pruned = store.prune(conn, settings.pool_ttl_days, settings.retention_days, now)
        counts["pruned"] = sum(pruned.values()) if isinstance(pruned, dict) else int(pruned or 0)
    except Exception:
        counts["pruned"] = 0

    return counts
