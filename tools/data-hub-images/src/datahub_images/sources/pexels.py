"""Pexels search adapter — keyed (PEXELS_API_KEY).

Ported from site/scripts/image-pipeline/pexels.mjs. No attribution required
by Pexels' license, but we credit the photographer anyway.
"""
import os
from urllib.parse import urlencode

from . import SourceUnavailable, _get_json

BASE = "https://api.pexels.com/v1"


def search(query: str, limit: int, proxy: str | None, client=None) -> list[dict]:
    key = os.environ.get("PEXELS_API_KEY")
    if not key:
        raise SourceUnavailable("no-api-key")

    params = {
        "query": query,
        "per_page": str(limit),
        "orientation": "landscape",
        "size": "large",
    }
    url = f"{BASE}/search?{urlencode(params)}"
    data = _get_json(url, proxy=proxy, headers={"Authorization": key}, client=client)

    results = []
    for p in data.get("photos") or []:
        src = p.get("src") or {}
        image_url = src.get("large2x") or src.get("original")
        if not image_url:
            continue

        source_url = p.get("url") or "https://www.pexels.com"

        results.append({
            "source_image_key": source_url,
            "url": image_url,
            "width": int(p.get("width") or 0),
            "height": int(p.get("height") or 0),
            "license": "Pexels License",
            "credit": {
                "source": "Pexels",
                "photographer": p.get("photographer") or "Pexels photographer",
                "license": "Pexels License",
                "url": p.get("photographer_url") or source_url,
            },
            # Pexels never returns tags, but its "alt" field carries a short
            # accessibility description — used by scoring.has_topical_overlap
            # as a relevance backstop instead of leaving Pexels candidates
            # with zero topical signal (see americastrikes image incident:
            # a "tanker attack" query returned an aquarium fish-tank photo).
            "tags": [],
            "description": p.get("alt") or "",
        })
        if len(results) >= limit:
            break

    return results
