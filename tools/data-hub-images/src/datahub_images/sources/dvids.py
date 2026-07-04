"""DVIDS Hub search adapter — keyed (DVIDS_API_KEY). Public-domain DoD imagery.

Ported from site/scripts/image-pipeline/dvids.mjs. Two-step: /search returns
lightweight hits (id + thumbnail only, no full-resolution URL); the
downloadable image + credit come from /asset?id=. We search then enrich each
hit via /asset to get the real image URL, same as the JS pipeline.
"""
import os
from urllib.parse import urlencode

from . import SourceUnavailable, _get_json

BASE = "https://api.dvidshub.net"
RELEASED = ("released", "public release", "cleared")


def _normalize_credit(c) -> str:
    if not c:
        return ""
    if isinstance(c, str):
        return c

    def one(v):
        if isinstance(v, dict):
            return " ".join(filter(None, [v.get("rank"), v.get("name")]))
        return str(v or "")

    if isinstance(c, list):
        return ", ".join(filter(None, (one(v) for v in c)))
    return one(c)


def _build_credit(asset: dict, hit: dict) -> str:
    credit = _normalize_credit(asset.get("credit"))
    unit = asset.get("unit_name") or hit.get("unit_name") or asset.get("branch") or hit.get("branch") or ""
    parts = [p for p in (credit, unit) if p]
    return f"{' / '.join(parts)} / DVIDS" if parts else "DVIDS"


def search(query: str, limit: int, proxy: str | None, client=None) -> list[dict]:
    key = os.environ.get("DVIDS_API_KEY")
    if not key:
        raise SourceUnavailable("no-api-key")

    search_params = {
        "api_key": key,
        "q": query,
        "type": "image",
        "max_results": str(max(limit * 3, 24)),
        "sort": "publishdate",
    }
    search_url = f"{BASE}/search?{urlencode(search_params)}"
    sdata = _get_json(search_url, proxy=proxy, client=client)
    hits = [h for h in (sdata.get("results") or []) if h.get("type") == "image" and h.get("id")]

    results = []
    for hit in hits:
        if len(results) >= limit:
            break

        asset_url = f"{BASE}/asset?{urlencode({'api_key': key, 'id': hit['id']})}"
        try:
            adata = _get_json(asset_url, proxy=proxy, client=client)
        except Exception:
            continue
        asset = adata.get("results") or adata
        image_url = asset.get("image")
        if not image_url:
            continue

        release = (asset.get("release_status") or hit.get("release_status") or "").lower()
        if release and not any(s in release for s in RELEASED):
            continue

        source_url = hit.get("url") or asset.get("url") or image_url

        results.append({
            "source_image_key": source_url,
            "url": image_url,
            "width": int(asset.get("image_width") or hit.get("width") or 0),
            "height": int(asset.get("image_height") or hit.get("height") or 0),
            "license": "Public Domain (US Government work)",
            "credit": {
                "source": "DVIDS",
                "photographer": _build_credit(asset, hit),
                "license": "Public Domain (US Government work)",
                "url": source_url,
            },
            "tags": [],
        })

    return results
