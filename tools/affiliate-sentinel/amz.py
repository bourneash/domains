"""Amazon Creators API access for the sentinel — health checks and replacement search.

Deliberately a thin layer over `tools/amz-stats`: that package already owns
the OAuth token cache, the batching/backoff behaviour that was tuned against
real 429s on a 600-ASIN sweep, the item-parsing shape, and — most importantly
— `taskfiler.http_confirms_dead`, the independent HTTP confirmation gate.

That gate is not optional. PA-API `getItems` has been observed to *persistently*
omit live, in-stock ASINs: on 2026-08-22 it reported 31 missing across the
fleet and only 16 were actually dead. A sentinel that auto-swaps products
would have replaced 15 perfectly good listings on the strength of an API
artifact, so "missing from getItems" is only ever a *suspicion* here, never a
verdict.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

_AMZ_STATS_SRC_CANDIDATES = (
    # Host layout: tools/affiliate-sentinel/amz.py -> tools/amz-stats/src
    Path(__file__).resolve().parents[1] / "amz-stats" / "src",
    # Container layout: mounted read-only at /work/.monorepo-tools
    Path("/work/.monorepo-tools/amz-stats/src"),
)


def _ensure_amz_stats_on_path() -> None:
    for p in _AMZ_STATS_SRC_CANDIDATES:
        if p.is_dir() and str(p) not in sys.path:
            sys.path.insert(0, str(p))


# Only what the sentinel actually reasons about. Fewer resources means fewer
# opportunities for a resource-level restriction to make an item look missing.
#
# `customerReviews.starRating` / `.count` are deliberately ABSENT. They are
# valid enum members, so requesting them raises no error — they simply come
# back empty for this account, which is a far worse failure than a rejection:
# it looks like "this product has no reviews" rather than "we are not allowed
# to see them". Rating and review count therefore cannot be sourced from the
# API at all, and heal.py treats them as unverifiable rather than carrying
# the dead product's numbers onto a new one.
HEALTH_RESOURCES = [
    "itemInfo.title",
    "itemInfo.byLineInfo",
    "images.primary.large",
    "images.primary.medium",
    "offersV2.listings.price",
    "offersV2.listings.availability",
]

OK = "OK"
OOS = "OOS"
SUSPECT_MISSING = "SUSPECT_MISSING"  # absent from getItems, NOT yet confirmed
CONFIRMED_DEAD = "CONFIRMED_DEAD"  # absent AND independently HTTP-confirmed
ERROR = "ERROR"


@dataclass
class AsinHealth:
    asin: str
    status: str
    title: str | None = None
    brand: str | None = None
    price: str | None = None
    rating: float | None = None
    review_count: int | None = None
    image_url: str | None = None
    detail_page_url: str | None = None
    note: str = ""


def _env_candidates(site_root: Path, domains_root: Path) -> list[Path]:
    """Every plausible credential file, most-specific first.

    `.env.shared` is what the site containers get mounted; the fleet-root
    `.env` is the host path. Deriving the fleet root by index (`parents[1]`)
    breaks the moment the sentinel runs from anywhere other than
    `sites/<domain>/` — a sandbox, a worktree, a relocated checkout — so the
    root is *found* by walking up for the directory that actually holds both
    `.env` and `tools/`, rather than assumed from depth.
    """
    out = [site_root / ".env.shared", domains_root / ".env"]
    for parent in site_root.resolve().parents:
        if (parent / "tools").is_dir() and (parent / ".env").is_file():
            out.append(parent / ".env")
            break
    return out


def load_env(site_root: Path, domains_root: Path) -> None:
    """Populate credentials from `.env.shared` (container) or the fleet `.env` (host)."""
    for candidate in _env_candidates(site_root, domains_root):
        if not candidate.is_file():
            continue
        try:
            text = candidate.read_text(encoding="utf-8", errors="replace")
        except PermissionError:
            # .env.shared is chmod 400 jesse:jesse on the host by design.
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def token_cache_path() -> Path:
    """Where the OAuth bearer token is cached — deliberately OUTSIDE any site repo.

    The first cut cached it at `<site>/ops/state/.amz-token.json`, which put a
    live credential inside 15 git repos that several fleet jobs run `git add -A`
    over. It was never committed, but the fleet already has a hard rule about
    keeping secrets out of the trees for exactly this reason
    (.env.shared must be gitignored), and one process away from a leak is not a
    margin worth keeping. The token is account-wide, not per-site, so one
    shared file off to the side is also simply correct.
    """
    p = Path(__file__).resolve().parent / ".cache" / "amz-token.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        p.parent.chmod(0o700)
    except OSError:
        pass
    return p


def client(cache_file: Path):
    """Build an AMZClient. Raises RuntimeError with an actionable message if unconfigured."""
    _ensure_amz_stats_on_path()
    try:
        from amz_stats.api import AMZClient
    except ImportError as exc:  # pragma: no cover - environment problem
        raise RuntimeError(f"tools/amz-stats not importable: {exc}") from exc

    missing = [
        k
        for k in ("AMAZON_CREATORS_KEY_ID", "AMAZON_CREATORS_KEY_SECRET", "AMAZON_ASSOCIATES_STORE_ID")
        if not os.environ.get(k)
    ]
    if missing:
        raise RuntimeError(f"missing Amazon Creators credentials: {', '.join(missing)}")

    cache_file.parent.mkdir(parents=True, exist_ok=True)
    return AMZClient(
        os.environ["AMAZON_CREATORS_KEY_ID"],
        os.environ["AMAZON_CREATORS_KEY_SECRET"],
        os.environ["AMAZON_ASSOCIATES_STORE_ID"],
        cache_file,
    )


def _parse(item: dict) -> dict:
    _ensure_amz_stats_on_path()
    from amz_stats.collectors import _parse_item

    parsed = _parse_item(item)
    # amz-stats only ever reads the 160px `medium` thumbnail, which is fine for
    # a stats snapshot but far too small to drop into a product card — writing
    # one over an existing hero is a visible quality regression. Prefer `large`.
    large = ((item.get("images") or {}).get("primary") or {}).get("large") or {}
    if large.get("url"):
        parsed["image_url"] = large["url"]
    return parsed


def check_health(cl, asins: list[str], batch_size: int = 10) -> dict[str, AsinHealth]:
    """getItems every ASIN and classify. Does NOT run the HTTP confirmation gate."""
    _ensure_amz_stats_on_path()
    import time

    from amz_stats.api import AMZError

    out: dict[str, AsinHealth] = {}
    ordered = list(dict.fromkeys(asins))

    for i in range(0, len(ordered), batch_size):
        batch = ordered[i : i + batch_size]
        if i:
            time.sleep(1.0)  # same inter-batch pacing amz-stats needed to stop 429s
        # 429 AND 403 get one retry with backoff. PA-API returns
        # "Your account does not currently meet the eligibility requirements"
        # TRANSIENTLY: on 2026-09-01 the same credentials and partner tag
        # succeeded at 06:17 (691 ASINs, zero errors) and returned 403 for every
        # call at 18:26. Treating it as a standing verdict is what made a whole
        # fleet run look unverifiable — and, in amz-stats, made 412 live products
        # read as delisted.
        resp = None
        last_exc = None
        for attempt in (0, 1):
            try:
                resp = cl.get_items(batch, resources=HEALTH_RESOURCES)
                break
            except AMZError as exc:
                last_exc = exc
                if attempt == 0 and getattr(exc, "status", None) in (429, 403):
                    time.sleep(5.0)
                    continue
                break

        if resp is None:
            # Keep the API's own words. "API error 403" alone is unactionable —
            # a 403 for a revoked account and a 403 for a bad key need completely
            # different responses, and the status code cannot tell them apart.
            detail = str(last_exc).strip().replace("\n", " ")
            if len(detail) > 220:
                detail = detail[:220].rstrip() + "…"
            status = getattr(last_exc, "status", "?")
            for a in batch:
                out[a] = AsinHealth(a, ERROR, note=f"API error {status}: {detail}")
            continue

        items = (resp.get("itemsResult") or {}).get("items") or []
        returned = set()
        for item in items:
            asin = item.get("asin")
            if not asin:
                continue
            returned.add(asin)
            p = _parse(item)
            out[asin] = AsinHealth(
                asin=asin,
                status=OK if p["availability"] == "IN_STOCK" else OOS,
                title=p["title"],
                brand=p["brand"],
                price=p["price"],
                rating=p["rating"],
                review_count=p["review_count"],
                image_url=p["image_url"],
                detail_page_url=p["detail_page_url"],
            )
        for a in batch:
            if a not in returned:
                out[a] = AsinHealth(a, SUSPECT_MISSING, note="absent from getItems response")

    return out


def confirm_dead(asin: str) -> bool | None:
    """Independent HTTP check. True=dead, False=alive, None=inconclusive.

    Reuses amz-stats' implementation rather than re-deriving the soft-404
    markers, so there is exactly one definition of "dead" in the fleet.
    """
    _ensure_amz_stats_on_path()
    from amz_stats.taskfiler import http_confirms_dead

    return http_confirms_dead(asin)


def search_replacements(cl, keywords: str, exclude: set[str], limit: int = 8) -> list[AsinHealth]:
    """Search for in-stock candidate replacements, newest data straight from the API.

    Only IN_STOCK results are returned: proposing an out-of-stock replacement
    for a dead product just re-files the same problem next run.
    """
    _ensure_amz_stats_on_path()
    from amz_stats.api import AMZError

    try:
        resp = cl.search_items(keywords, resources=HEALTH_RESOURCES, item_count=limit)
    except AMZError:
        return []

    items = (resp.get("searchResult") or {}).get("items") or []
    out: list[AsinHealth] = []
    for item in items:
        asin = item.get("asin")
        if not asin or asin in exclude:
            continue
        p = _parse(item)
        if p["availability"] != "IN_STOCK":
            continue
        out.append(
            AsinHealth(
                asin=asin,
                status=OK,
                title=p["title"],
                brand=p["brand"],
                price=p["price"],
                rating=p["rating"],
                review_count=p["review_count"],
                image_url=p["image_url"],
                detail_page_url=p["detail_page_url"],
            )
        )
    return out
