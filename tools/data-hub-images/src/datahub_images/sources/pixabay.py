"""Pixabay search adapter — keyed (PIXABAY_API_KEY)."""
import os
from urllib.parse import urlencode

from . import SourceUnavailable, _get_json

BASE = "https://pixabay.com/api/"


def search(query: str, limit: int, proxy: str | None, client=None) -> list[dict]:
    key = os.environ.get("PIXABAY_API_KEY")
    if not key:
        raise SourceUnavailable("no-api-key")

    params = {
        "key": key,
        "q": query,
        "image_type": "photo",
        "min_width": "1200",
        "per_page": str(limit),
    }
    url = f"{BASE}?{urlencode(params)}"
    data = _get_json(url, proxy=proxy, client=client)

    results = []
    for h in data.get("hits") or []:
        image_url = h.get("largeImageURL")
        if not image_url:
            continue

        page_url = h.get("pageURL") or "https://pixabay.com"
        tags = [t.strip() for t in (h.get("tags") or "").split(",") if t.strip()]

        results.append({
            "source_image_key": page_url,
            "url": image_url,
            "width": int(h.get("imageWidth") or 0),
            "height": int(h.get("imageHeight") or 0),
            "license": "Pixabay License",
            "credit": {
                "source": "Pixabay",
                "photographer": h.get("user") or "Pixabay contributor",
                "license": "Pixabay License",
                "url": page_url,
            },
            "tags": tags,
        })
        if len(results) >= limit:
            break

    return results
