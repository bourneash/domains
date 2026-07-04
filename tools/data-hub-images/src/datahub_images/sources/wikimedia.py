"""Wikimedia Commons image search adapter — no API key required.

Ported from site/scripts/image-pipeline/wikimedia.mjs, collapsed to a single
generator=search + prop=imageinfo request (vs. the two-step JS search+lookup),
normalized to the shared candidate contract.
"""
import re
from urllib.parse import urlencode

from . import _get_json

API_URL = "https://commons.wikimedia.org/w/api.php"
UA = "AmericaStrikesBot/1.0 (https://americastrikes.com; tips@americastrikes.com)"

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_REJECT_LICENSE_RE = re.compile(r"all\s*rights|fair\s*use|copyrighted", re.I)


def _strip_html(s) -> str:
    return re.sub(r"\s+", " ", _HTML_TAG_RE.sub("", str(s or ""))).strip()


def search(query: str, limit: int, proxy: str | None, client=None) -> list[dict]:
    params = {
        "action": "query",
        "format": "json",
        "generator": "search",
        "gsrsearch": f"{query} filetype:bitmap -intitle:diagram -intitle:icon -intitle:logo",
        "gsrlimit": str(limit * 2),  # overfetch, we filter below
        "gsrnamespace": "6",  # File: namespace
        "prop": "imageinfo",
        "iiprop": "url|size|mime|extmetadata",
        "iiurlwidth": "1600",
        "origin": "*",
    }
    url = f"{API_URL}?{urlencode(params)}"
    data = _get_json(url, proxy=proxy, headers={"User-Agent": UA}, client=client)

    pages = (data.get("query") or {}).get("pages") or {}

    results = []
    for page in pages.values():
        infos = page.get("imageinfo") or []
        if not infos:
            continue
        info = infos[0]

        meta = info.get("extmetadata") or {}
        license_ = (meta.get("LicenseShortName") or {}).get("value") \
            or (meta.get("License") or {}).get("value") \
            or "unknown"
        if _REJECT_LICENSE_RE.search(license_):
            continue
        author = _strip_html((meta.get("Artist") or {}).get("value")
                              or (meta.get("Credit") or {}).get("value")
                              or "Unknown") or "Unknown"

        title = page.get("title", "")
        source_url = info.get("descriptionurl") or f"https://commons.wikimedia.org/wiki/{title}"
        image_url = info.get("thumburl") or info.get("url")

        results.append({
            "source_image_key": source_url,
            "url": image_url,
            "width": int(info.get("thumbwidth") or info.get("width") or 0),
            "height": int(info.get("thumbheight") or info.get("height") or 0),
            "license": license_,
            "credit": {
                "source": "Wikimedia Commons",
                "photographer": author,
                "license": license_,
                "url": source_url,
            },
            "tags": [],
        })
        if len(results) >= limit:
            break

    return results
