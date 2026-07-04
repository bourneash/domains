"""U.S. National Archives (NARA) catalog search adapter — keyless, public domain."""
from urllib.parse import urlencode

from . import _get_json

BASE = "https://catalog.archives.gov/api/v2/records/search"


def search(query: str, limit: int, proxy: str | None, client=None) -> list[dict]:
    params = {"q": query, "limit": str(limit)}
    url = f"{BASE}?{urlencode(params)}"
    data = _get_json(url, proxy=proxy, client=client)

    hits = (((data.get("body") or {}).get("hits") or {}).get("hits")) or []

    results = []
    for hit in hits:
        if len(results) >= limit:
            break

        record = (hit.get("_source") or {}).get("record") or {}
        digital_objects = record.get("digitalObjects") or []
        na_id = record.get("naId")
        record_url = f"https://catalog.archives.gov/id/{na_id}" if na_id else None

        for obj in digital_objects:
            if len(results) >= limit:
                break

            image_url = obj.get("objectUrl")
            if not image_url:
                continue

            source_key = record_url or image_url

            results.append({
                "source_image_key": source_key,
                "url": image_url,
                "width": int(obj.get("objectWidth") or 0),
                "height": int(obj.get("objectHeight") or 0),
                "license": "Public Domain",
                "credit": {
                    "source": "U.S. National Archives",
                    "photographer": "U.S. National Archives",
                    "license": "Public Domain",
                    "url": source_key,
                },
                "tags": [],
            })

    return results
