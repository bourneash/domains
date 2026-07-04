"""Government Flickr photostream adapter — keyed (FLICKR_API_KEY).

Searches a fixed set of official U.S. government Flickr photostreams (White
House, State Department, DoD/Navy) via flickr.photos.search scoped to each
account's user_id, rather than searching all of Flickr. All of these
photostreams publish public-domain U.S. government work.

NOTE: the NSIDs below are best-effort and should be verified against the
live accounts before Task 10's live integration test — Flickr doesn't
expose a documented "official government accounts" registry, so these were
picked from each account's public profile URL.
"""
import os
from urllib.parse import urlencode

from . import SourceUnavailable, _get_json

BASE = "https://api.flickr.com/services/rest/"

# name -> Flickr NSID (user_id), one per configured gov photostream.
GOV_PHOTOSTREAMS = {
    "The White House": "22355218@N04",
    "U.S. Department of State": "35591378@N03",
    "U.S. Navy": "56342495@N05",
    "DoD / Secretary of Defense": "158215334@N06",
}


def search(query: str, limit: int, proxy: str | None, client=None) -> list[dict]:
    key = os.environ.get("FLICKR_API_KEY")
    if not key:
        raise SourceUnavailable("no-api-key")

    results = []
    for owner_label, user_id in GOV_PHOTOSTREAMS.items():
        if len(results) >= limit:
            break

        params = {
            "method": "flickr.photos.search",
            "api_key": key,
            "user_id": user_id,
            "text": query,
            "format": "json",
            "nojsoncallback": "1",
            "extras": "url_l,owner_name,license",
            "per_page": str(limit),
        }
        url = f"{BASE}?{urlencode(params)}"
        try:
            data = _get_json(url, proxy=proxy, client=client)
        except Exception:
            continue

        photos = ((data.get("photos") or {}).get("photo")) or []
        for p in photos:
            if len(results) >= limit:
                break

            image_url = p.get("url_l")
            if not image_url:
                continue

            owner = p.get("owner") or ""
            photo_id = p.get("id") or ""
            owner_name = p.get("ownername") or owner_label
            page_url = f"https://www.flickr.com/photos/{owner}/{photo_id}"

            results.append({
                "source_image_key": page_url,
                "url": image_url,
                "width": int(p.get("width_l") or 0),
                "height": int(p.get("height_l") or 0),
                "license": "Public Domain (U.S. Government work)",
                "credit": {
                    "source": f"Flickr ({owner_name})",
                    "photographer": owner_name,
                    "license": "Public Domain (U.S. Government work)",
                    "url": page_url,
                },
                "tags": [t for t in (p.get("tags") or "").split() if t],
            })

    return results
