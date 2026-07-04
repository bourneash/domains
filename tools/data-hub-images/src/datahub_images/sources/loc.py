"""Library of Congress Prints & Photographs search adapter — keyless, public domain."""
from urllib.parse import urlencode

from . import _get_json

BASE = "https://www.loc.gov/photos/"


def search(query: str, limit: int, proxy: str | None, client=None) -> list[dict]:
    params = {"q": query, "fo": "json", "c": str(limit)}
    url = f"{BASE}?{urlencode(params)}"
    data = _get_json(url, proxy=proxy, client=client)

    results = []
    for item in data.get("results") or []:
        if len(results) >= limit:
            break

        image_url = item.get("image_url")
        if isinstance(image_url, list):
            image_url = image_url[-1] if image_url else None
        if not image_url:
            continue

        item_url = item.get("id") or "https://www.loc.gov"

        results.append({
            "source_image_key": item_url,
            "url": image_url,
            "width": int(item.get("width") or 0),
            "height": int(item.get("height") or 0),
            "license": "Library of Congress",
            "credit": {
                "source": "Library of Congress",
                "photographer": "Library of Congress",
                "license": "Library of Congress",
                "url": item_url,
            },
            "tags": [t for t in (item.get("subject") or []) if isinstance(t, str)],
        })

    return results
