"""Collector cycle: pool-fill → request-drain → prune.

Wires together every prior module (vpn, sources, scoring, blob, store, reuse)
into the fetch→pool→serve loop. Mirrors the per-source isolation pattern in
tools/data-hub/src/datahub/collector.py: one broken source or one malformed
candidate is caught, logged via egress_log, and never aborts the cycle.
"""
import os
import time
from urllib.parse import urlparse

import httpx

from . import blob, reuse, scoring, store, vpn
from . import sources as sources_pkg
from .config import Settings, Source, Topic
from .sources import SOURCE_FETCHERS, USER_AGENT, SourceUnavailable, _redact

CANDIDATES_PER_SOURCE = 5

# Env vars that may hold API keys embedded in a keyed source's URL/query
# string. Any of these values found in an exception message get redacted
# before the message is ever persisted to egress_log (which GET /egress
# serves verbatim).
_SECRET_ENV_VARS = (
    "UNSPLASH_ACCESS_KEY",
    "PEXELS_API_KEY",
    "PIXABAY_API_KEY",
    "DVIDS_API_KEY",
    "FLICKR_API_KEY",
)


def _secret_values() -> list[str]:
    return [v for v in (os.environ.get(name) for name in _SECRET_ENV_VARS) if v]


def _redacted_note(exc: BaseException) -> str:
    return _redact(str(exc), *_secret_values())[:200]


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
        r = client.get(url, headers={"User-Agent": USER_AGENT}, timeout=20.0)
        r.raise_for_status()
        ext = (urlparse(url).path.rsplit(".", 1)[-1] or "jpg").lower()
        if not ext.isalnum() or len(ext) > 5:
            ext = "jpg"
        return r.content, ext
    finally:
        if owns:
            client.close()


def _process_candidate(
    conn, source: Source, topic: Topic, settings: Settings, now: str,
    plan, cand: dict, pool_phashes: list, http=None,
) -> str | None:
    """Validate/dedup/score/store one fetch candidate.

    Mutates `pool_phashes` in place (appends the new phash) and touches
    the DB (seen_sources, images) when the candidate is stored. Returns
    the new image's id if a new image was inserted, otherwise None
    (duplicate/already-seen/invalid, or a caught exception — recorded to
    egress_log as status="error" and swallowed). Never raises.
    """
    try:
        key = cand.get("source_image_key")
        if not key or store.seen_source(conn, key):
            return None

        data, ext = _download(cand["url"], plan.proxy, http)

        if not scoring.validate(data):
            return None

        phash = scoring.phash_hex(data)
        if store.is_blacklisted_phash(conn, phash):
            return None
        if any(scoring.is_near_dup(phash, p) for p in pool_phashes):
            return None

        # Score on REAL, downloaded dimensions — not provider-claimed
        # ones, which are often 0/absent and would otherwise trigger a
        # spurious small/portrait penalty.
        width, height = scoring.dimensions(data)
        cand["width"], cand["height"] = width, height
        score = scoring.score_candidate(cand, topic)
        sha, path = blob.write_blob(settings.blob_dir, data, ext)

        image = {
            "id": sha,
            "source_id": source.id,
            "source_image_key": key,
            "blob_path": path,
            "width": width,
            "height": height,
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
            return sha
        return None
    except Exception as exc:  # per-candidate isolation
        store.record_egress(
            conn, source_id=source.id,
            target_host=_host(cand.get("url") if isinstance(cand, dict) else None),
            policy=source.policy, exit_node=plan.exit_node, exit_ip=plan.exit_ip,
            status="error", note=_redacted_note(exc), ts=now,
        )
        return None


def fetch_and_store(conn, source: Source, topic: Topic, settings: Settings, now: str, http=None) -> int:
    """Fetch candidates for one source+topic, validate/score/store them.

    Returns the number of new images stored. Never raises — any failure for
    this source (plan_fetch, the fetcher call, a single candidate) is caught,
    recorded to egress_log, and the function returns what it managed so far.
    """
    stored = 0
    plan = None
    try:
        # Look up the fetcher via the live module attribute (not the frozen
        # SOURCE_FETCHERS dict, whose values were bound at import time) so
        # that tests/ops can monkeypatch e.g.
        # `datahub_images.sources.wikimedia.search` and have the collector
        # pick up the patched version.
        mod = getattr(sources_pkg, source.kind, None)
        fetcher = getattr(mod, "search", None) if mod else SOURCE_FETCHERS.get(source.kind)
        if fetcher is None:
            store.record_egress(
                conn, source_id=source.id, target_host="", policy=source.policy,
                exit_node="", exit_ip=None, status="error",
                note=f"unknown source kind: {source.kind}", ts=now,
            )
            return stored

        query = " OR ".join(topic.queries) if topic.queries else topic.id
        plan = vpn.plan_fetch(source, settings)
        if not plan.allowed:
            store.record_egress(
                conn, source_id=source.id, target_host=_host(source.url),
                policy=source.policy, exit_node=plan.exit_node, exit_ip=plan.exit_ip,
                status="skipped", note=plan.reason, ts=now,
            )
            return stored

        try:
            cands = fetcher(query, CANDIDATES_PER_SOURCE, plan.proxy)
        except SourceUnavailable as exc:
            # keyed adapter with no key configured — expected, not a failure
            store.record_egress(
                conn, source_id=source.id, target_host=_host(source.url),
                policy=source.policy, exit_node=plan.exit_node, exit_ip=plan.exit_ip,
                status="skipped", note=_redacted_note(exc), ts=now,
            )
            return stored

        # A misbehaving fetcher may return None or something non-iterable;
        # never let that raise TypeError out of this function.
        cands = cands or []
        if not isinstance(cands, list):
            cands = []

        pool_phashes = [img["phash"] for img in store.pool_for_topic(conn, topic.id) if img.get("phash")]

        for cand in cands:
            if _process_candidate(conn, source, topic, settings, now, plan, cand, pool_phashes, http):
                stored += 1

        store.record_egress(
            conn, source_id=source.id, target_host=_host(source.url),
            policy=source.policy, exit_node=plan.exit_node, exit_ip=plan.exit_ip,
            status="ok", item_count=stored, ts=now,
        )
        return stored
    except Exception as exc:  # whole-function isolation — this must never raise
        exit_node = plan.exit_node if plan else ""
        exit_ip = plan.exit_ip if plan else None
        try:
            store.record_egress(
                conn, source_id=source.id, target_host=_host(source.url),
                policy=source.policy, exit_node=exit_node, exit_ip=exit_ip,
                status="error", note=_redacted_note(exc), ts=now,
            )
        except Exception:
            pass
        return stored


def fetch_on_demand(
    conn, keywords: list[str], bucket: str, settings: Settings,
    sources: list[Source], now: str, want: int, per_source_limit: int,
    http=None, timeout_s: float | None = None,
) -> list[str]:
    """Fetch up to `want` new images matching `keywords`, tagged with
    `bucket`, from enabled sources — bounded by a wall-clock timeout so a
    synchronous caller can never hang. VPN-gated exactly like
    fetch_and_store (fail-closed). Never raises. Returns the list of
    newly stored image ids (may be shorter than `want`, including empty).
    """
    deadline = time.monotonic() + (timeout_s if timeout_s is not None else settings.on_demand_timeout_s)
    query = " ".join(keywords) if keywords else bucket
    topic = Topic(id=bucket, queries=keywords, tags=[])
    pool_phashes = [img["phash"] for img in store.pool_for_topic(conn, bucket) if img.get("phash")]
    stored_ids: list[str] = []

    for source in sources:
        if time.monotonic() >= deadline or len(stored_ids) >= want:
            break
        if not source.enabled:
            continue

        plan = None
        try:
            mod = getattr(sources_pkg, source.kind, None)
            fetcher = getattr(mod, "search", None) if mod else SOURCE_FETCHERS.get(source.kind)
            if fetcher is None:
                store.record_egress(
                    conn, source_id=source.id, target_host="", policy=source.policy,
                    exit_node="", exit_ip=None, status="error",
                    note=f"unknown source kind: {source.kind}", ts=now,
                )
                continue

            plan = vpn.plan_fetch(source, settings)
            if not plan.allowed:
                store.record_egress(
                    conn, source_id=source.id, target_host=_host(source.url),
                    policy=source.policy, exit_node=plan.exit_node, exit_ip=plan.exit_ip,
                    status="skipped", note=plan.reason, ts=now,
                )
                continue

            try:
                cands = fetcher(query, per_source_limit, plan.proxy)
            except SourceUnavailable as exc:
                store.record_egress(
                    conn, source_id=source.id, target_host=_host(source.url),
                    policy=source.policy, exit_node=plan.exit_node, exit_ip=plan.exit_ip,
                    status="skipped", note=_redacted_note(exc), ts=now,
                )
                continue

            cands = cands or []
            if not isinstance(cands, list):
                cands = []

            source_stored = 0
            for cand in cands:
                if time.monotonic() >= deadline or len(stored_ids) >= want:
                    break
                image_id = _process_candidate(conn, source, topic, settings, now, plan, cand, pool_phashes, http)
                if image_id:
                    stored_ids.append(image_id)
                    source_stored += 1

            store.record_egress(
                conn, source_id=source.id, target_host=_host(source.url),
                policy=source.policy, exit_node=plan.exit_node, exit_ip=plan.exit_ip,
                status="ok", item_count=source_stored, ts=now,
            )
        except Exception as exc:  # per-source isolation — one dead source must not abort the broker
            exit_node = plan.exit_node if plan else ""
            exit_ip = plan.exit_ip if plan else None
            try:
                store.record_egress(
                    conn, source_id=source.id, target_host=_host(source.url),
                    policy=source.policy, exit_node=exit_node, exit_ip=exit_ip,
                    status="error", note=_redacted_note(exc), ts=now,
                )
            except Exception:
                pass
            continue

    return stored_ids


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
            try:
                counts["fetched"] += fetch_and_store(conn, source, topic, settings, now, http)
            except Exception:
                # fetch_and_store is documented never to raise, but this is
                # the last line of defense: one broken source must never
                # abort the topic loop or the cycle.
                continue

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
                img = reuse.select_image(conn, topic, req["site"], req.get("slug"), settings, now)
                if img is None:
                    # Targeted fetch attempt: try to top up the pool from any
                    # enabled source for this topic, then re-select once.
                    for source in sources:
                        if not source.enabled:
                            continue
                        fetch_and_store(conn, source, topic, settings, now, http)
                    img = reuse.select_image(conn, topic, req["site"], req.get("slug"), settings, now)
                if img is None:
                    break
                store.record_assignment(conn, img["id"], req["site"], req.get("slug"), topic.id, now)
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
