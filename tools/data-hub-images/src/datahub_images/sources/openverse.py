"""Openverse search adapter — keyless, commercial-use-only license filter."""
from urllib.parse import urlencode

from . import _get_json

BASE = "https://api.openverse.org/v1/images/"


def search(query: str, limit: int, proxy: str | None, client=None) -> list[dict]:
    params = {
        "q": query,
        "license_type": "commercial",
        "page_size": str(limit),
    }
    url = f"{BASE}?{urlencode(params)}"
    data = _get_json(url, proxy=proxy, client=client)

    results = []
    for r in data.get("results") or []:
        image_url = r.get("url")
        if not image_url:
            continue

        source_key = r.get("foreign_landing_url") or r.get("id") or image_url
        license_ = r.get("license") or "unknown"

        results.append({
            "source_image_key": source_key,
            "url": image_url,
            "width": int(r.get("width") or 0),
            "height": int(r.get("height") or 0),
            "license": license_,
            "credit": {
                "source": "Openverse",
                "photographer": r.get("creator") or "Unknown",
                "license": license_,
                "url": source_key,
            },
            "tags": [t.get("name") for t in (r.get("tags") or []) if t.get("name")],
        })
        if len(results) >= limit:
            break

    return results
