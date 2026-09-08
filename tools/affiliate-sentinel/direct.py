"""Verify search-backed Amazon links rendered directly on a live site.

Some fleet sites deliberately do not use ``/go/`` cloaks and do not pin an
ASIN: their catalog entries carry search phrases and render tagged Amazon
search URLs directly.  Those links still need a revenue-path assertion.  This
module checks the site's own HTML (never Amazon) and verifies that every such
registry entry appears with the expected Associates tag.
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urljoin, urlparse


_ANCHOR_RE = re.compile(r"<a\b[^>]*\bhref=(['\"])(.*?)\1", re.I | re.S)


@dataclass
class DirectResult:
    id: str
    ok: bool
    url: str | None
    reason: str


def _anchors(body: str) -> list[str]:
    return [html.unescape(m.group(2)) for m in _ANCHOR_RE.finditer(body)]


def _amazon_search(url: str) -> tuple[str | None, str | None]:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if not (host == "amazon.com" or host == "www.amazon.com" or host.endswith(".amazon.com")):
        return None, None
    params = parse_qs(parsed.query)
    query = (params.get("k") or [None])[0]
    tag = (params.get("tag") or [None])[0]
    return query, tag


def check(client, base_url: str, products: list, expected_tag: str | None,
          max_pages: int = 25) -> tuple[list[DirectResult], int, list[str]]:
    """Return per-product results, pages fetched, and request errors.

    ``/shop/`` is the conventional fleet catalog route and catches the whole
    ShopPinkFlamingo registry in one request.  A small same-origin crawl from
    it and the homepage covers sites that spread products over category pages
    without turning this daily check into a general-purpose crawler.
    """
    wanted = {
        p.id: p.search_query
        for p in products
        if p.is_product and p.search_query and not p.asin
    }
    if not wanted or not base_url:
        return [], 0, []

    origin = urlparse(base_url)
    queue = [urljoin(base_url.rstrip("/") + "/", path) for path in ("shop/", "")]
    seen: set[str] = set()
    found: dict[str, list[tuple[str, str | None]]] = {pid: [] for pid in wanted}
    errors: list[str] = []
    pages = 0

    while queue and pages < max_pages and any(not links for links in found.values()):
        page_url = queue.pop(0)
        if page_url in seen:
            continue
        seen.add(page_url)
        try:
            response = client.get(page_url, follow_redirects=True)
        except Exception as exc:
            errors.append(f"{page_url}: {type(exc).__name__}")
            continue
        if response.status_code >= 400:
            errors.append(f"{page_url}: HTTP {response.status_code}")
            continue
        pages += 1

        for href in _anchors(response.text):
            query, tag = _amazon_search(href)
            if query is not None:
                for pid, expected_query in wanted.items():
                    if query == expected_query:
                        found[pid].append((href, tag))
                continue

            absolute = urljoin(page_url, href)
            parsed = urlparse(absolute)
            if (
                parsed.scheme in ("http", "https")
                and parsed.netloc == origin.netloc
                and not parsed.query
                and absolute not in seen
                and absolute not in queue
            ):
                queue.append(absolute)

    results: list[DirectResult] = []
    if pages == 0:
        return results, 0, errors
    for pid, links in found.items():
        if not links:
            results.append(DirectResult(pid, False, None, "no matching Amazon search link found on the live site"))
            continue
        good = next((url for url, tag in links if expected_tag and tag == expected_tag), None)
        if good:
            results.append(DirectResult(pid, True, good, ""))
            continue
        url, observed_tag = links[0]
        if not expected_tag:
            reason = "Associates tag is unknown, so the direct link cannot be revenue-verified"
        elif observed_tag:
            reason = f"direct link has affiliate tag {observed_tag}, expected {expected_tag}"
        else:
            reason = f"direct link is missing the affiliate tag ({expected_tag}) — earns no commission"
        results.append(DirectResult(pid, False, url, reason))
    return results, pages, errors
