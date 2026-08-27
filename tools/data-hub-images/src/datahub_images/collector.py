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

# On-demand source preference. For a news/geopolitics use-case, government and
# public-domain *documentary* imagery (an actual photo of the subject) is more
# editorially relevant than commercial *stock* (a staged/generic photo). Because
# fetch_on_demand stops at the first source that yields a usable image, we try
# documentary sources first and fall back to stock only when none has a match.
# openverse is a CC-aggregator (stock-like), so it is NOT documentary.
# Preferred documentary: operational government imagery (DoD combat-camera) — a
# real photo of the actual subject, consistently on-point. Ranks ABOVE stock.
PREFERRED_DOCUMENTARY_KINDS = frozenset({"dvids"})
# Archival documentary: public-domain archives (Commons, NARA, LoC, gov Flickr).
# On-theme but often dated/weak, so ranked BELOW stock — a last resort used only
# when neither the preferred documentary source nor stock has a match.
ARCHIVAL_DOCUMENTARY_KINDS = frozenset({"wikimedia", "nara", "loc", "govflickr"})
# All documentary sources use the query-ladder: they return nothing for a long
# full-keyword join, so a short entity query is what surfaces them.
DOCUMENTARY_KINDS = PREFERRED_DOCUMENTARY_KINDS | ARCHIVAL_DOCUMENTARY_KINDS


def _source_rank(kind: str) -> int:
    if kind in PREFERRED_DOCUMENTARY_KINDS:
        return 0  # operational documentary — best
    if kind in ARCHIVAL_DOCUMENTARY_KINDS:
        return 2  # archival documentary — last resort, below stock
    return 1      # stock


def _ranked_sources(sources: list[Source]) -> list[Source]:
    """Stable 3-tier sort: preferred documentary (dvids) → stock → archival
    documentary (wikimedia/nara/loc/govflickr). Only the preferred documentary
    tier outranks stock; archival sits below stock as a fallback. Registry
    relative order is preserved within each tier (Python's sort is stable)."""
    return sorted(sources, key=lambda s: _source_rank(s.kind))


def _query_ladder(keywords: list[str]) -> list[str]:
    """Strong queries only, tried in order: the full keyword join, then the
    first-two-keyword join. Documentary archives (dvids/wikimedia/...) return
    nothing for a long full-join but match well on a short entity query — so we
    ladder DOWN to first-two. We deliberately STOP there and never fall to a
    single lone keyword: that is the relevance guard. A lone weak token (e.g.
    "OPEC") fuzzy-matches junk in a military archive (a Navy ceremony), so a
    documentary hit is only trusted when it came from a strong (>=2-term) query.
    Returns [] for empty input; de-duplicates (full == first-two when 2 kw)."""
    if not keywords:
        return []
    ladder = [" ".join(keywords)]
    if len(keywords) >= 2:
        ladder.append(" ".join(keywords[:2]))
    seen: set[str] = set()
    return [q for q in ladder if not (q in seen or seen.add(q))]

# Bounded retry on 403/429 for image-byte downloads (Wikimedia in particular
# rate-limits bulk downloads even with a good UA). Mirrors the pattern in
# datahub_images.sources._get_json: a patchable module-level sleep seam so
# tests never actually sleep.
_DOWNLOAD_MAX_RETRIES = 2
_DOWNLOAD_RETRY_BACKOFF = (1, 2)
_sleep = time.sleep

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
        attempt = 0
        while True:
            r = client.get(url, headers={"User-Agent": USER_AGENT}, timeout=20.0)
            if r.status_code in (403, 429) and attempt < _DOWNLOAD_MAX_RETRIES:
                _sleep(_DOWNLOAD_RETRY_BACKOFF[attempt])
                attempt += 1
                continue
            r.raise_for_status()
            break
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

        # Relevance gate — stock sources only. Documentary sources (dvids,
        # wikimedia, ...) already get a relevance guard via the query ladder
        # in fetch_on_demand (_query_ladder never falls to a lone weak
        # keyword). Stock search has no such guard: it's relevance-ranked
        # full-text, and its top hit can be confidently off-topic (e.g. a
        # "tanker attack" query returning an aquarium photo). Reject rather
        # than accept whatever the API ranked first.
        if source.kind not in DOCUMENTARY_KINDS and not scoring.has_topical_overlap(cand, topic):
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

    for source in _ranked_sources(sources):
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

            # Documentary sources get the strong-query ladder (full → first-two);
            # stock keeps the single full query it already matches on. See
            # _query_ladder for the relevance guard (no single-keyword fallback).
            if source.kind in DOCUMENTARY_KINDS:
                queries = _query_ladder(keywords) or [query]
            else:
                queries = [query]

            try:
                source_stored = 0
                for q in queries:
                    if time.monotonic() >= deadline or len(stored_ids) >= want:
                        break
                    cands = fetcher(q, per_source_limit, plan.proxy)
                    cands = cands if isinstance(cands, list) else []
                    for cand in cands:
                        if time.monotonic() >= deadline or len(stored_ids) >= want:
                            break
                        image_id = _process_candidate(conn, source, topic, settings, now, plan, cand, pool_phashes, http)
                        if image_id:
                            stored_ids.append(image_id)
                            source_stored += 1
                    if source_stored:
                        break  # got an image from this source; stop laddering
            except SourceUnavailable as exc:
                store.record_egress(
                    conn, source_id=source.id, target_host=_host(source.url),
                    policy=source.policy, exit_node=plan.exit_node, exit_ip=plan.exit_ip,
                    status="skipped", note=_redacted_note(exc), ts=now,
                )
                continue

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
        bucket = req.get("topic")
        registered = tmap.get(bucket)
        keywords = req.get("keywords") or (registered.queries if registered else [])
        lookup_topic = registered or Topic(id=bucket, queries=keywords, tags=[])

        assigned_ids = []
        wanted = req.get("count") or 1
        for _ in range(wanted):
            img = reuse.select_image(conn, lookup_topic, req["site"], req.get("slug"), settings, now)
            if img is None:
                fetched = fetch_on_demand(
                    conn, keywords, bucket, settings, sources, now,
                    want=1, per_source_limit=settings.on_demand_per_source_limit, http=http,
                )
                counts["fetched"] += len(fetched)
                img = reuse.select_image(conn, lookup_topic, req["site"], req.get("slug"), settings, now)
            if img is None:
                break
            store.record_assignment(conn, img["id"], req["site"], req.get("slug"), bucket, now)
            store.set_last_used(conn, img["id"], now)
            assigned_ids.append(img["id"])

        status = "done" if assigned_ids else "failed"
        result = {"image_ids": assigned_ids}
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

    # Heartbeat: record that this cycle ran to completion, regardless of
    # whether any source was actually fetched. Pools sitting at
    # target_depth are the common case and legitimately fetch nothing (no
    # egress_log rows), so egress recency alone can't tell a healthy idle
    # collector from a wedged one.
    try:
        store.record_heartbeat(conn, now)
    except Exception:
        pass

    return counts
