"""Unsplash search adapter — keyed (UNSPLASH_ACCESS_KEY).

Ported from site/scripts/image-pipeline/unsplash.mjs. Unsplash's API terms
require pinging the photo's `download_location` when we actually use it
(counts as a "download" for the photographer's stats); we preserve that via
`track_download()` below, and stash `download_location` on each candidate so
a caller can invoke it later without a second search round-trip.
"""
import os
from urllib.parse import urlencode

from . import SourceUnavailable, _get_json

BASE = "https://api.unsplash.com"


def search(query: str, limit: int, proxy: str | None, client=None) -> list[dict]:
    key = os.environ.get("UNSPLASH_ACCESS_KEY")
    if not key:
        raise SourceUnavailable("no-api-key")

    params = {
        "query": query,
        "per_page": str(limit),
        "orientation": "landscape",
        "content_filter": "high",
    }
    url = f"{BASE}/search/photos?{urlencode(params)}"
    data = _get_json(url, proxy=proxy, headers={"Authorization": f"Client-ID {key}"}, client=client)

    results = []
    for item in data.get("results") or []:
        urls = item.get("urls") or {}
        image_url = urls.get("full") or urls.get("regular")
        if not image_url:
            continue

        user = item.get("user") or {}
        links = item.get("links") or {}
        source_url = links.get("html") or "https://unsplash.com"

        results.append({
            "source_image_key": source_url,
            "url": image_url,
            "width": int(item.get("width") or 0),
            "height": int(item.get("height") or 0),
            "license": "Unsplash License",
            "credit": {
                "source": "Unsplash",
                "photographer": user.get("name") or "Unsplash photographer",
                "license": "Unsplash License",
                "url": source_url,
            },
            "tags": [t.get("title") for t in (item.get("tags") or []) if t.get("title")],
            # Free-text description Unsplash's own tags rarely cover — used
            # by scoring.has_topical_overlap as a relevance backstop so an
            # off-topic photo (Unsplash's search is fuzzy/conceptual, not a
            # keyword match) can be rejected instead of accepted outright.
            "description": " ".join(
                filter(None, [item.get("description"), item.get("alt_description")])
            ),
            "download_location": links.get("download_location"),
        })
        if len(results) >= limit:
            break

    return results


def track_download(download_location: str | None, proxy: str | None = None, client=None) -> None:
    """Ping Unsplash's download endpoint. Required by ToS when a photo is actually
    used. Failure is non-fatal — caller should not block image use on this."""
    key = os.environ.get("UNSPLASH_ACCESS_KEY")
    if not key or not download_location:
        return
    try:
        _get_json(download_location, proxy=proxy, headers={"Authorization": f"Client-ID {key}"}, client=client)
    except Exception:
        pass
