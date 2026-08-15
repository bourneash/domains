"""Amazon discovery collector for the shared product inventory.

Search pages are used only to discover ASINs. Every candidate is opened on
its canonical ``/dp/<ASIN>`` page and must expose a real product title before
it is stored. The API derives and persists the untagged product URL; consumers
append their own Associates tag later.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .config import load_source_queries, load_subscriptions


SEARCH_JS = r"""
() => Array.from(document.querySelectorAll('div[data-component-type="s-search-result"]'))
  .map(card => {
    const asin = card.getAttribute('data-asin');
    const title = card.querySelector('h2')?.textContent?.trim();
    const ratingText = card.querySelector('span.a-icon-alt')?.textContent?.trim();
    const reviewsText = card.querySelector('a[href*="customerReviews"] span')?.textContent?.trim();
    return {
      asin,
      title,
      rating: ratingText ? parseFloat(ratingText) : null,
      review_count: reviewsText ? parseInt(reviewsText.replace(/[^0-9]/g, ''), 10) : 0,
    };
  })
  .filter(item => item.asin && /^[A-Z0-9]{10}$/.test(item.asin) && item.title)
"""


PRODUCT_JS = r"""
() => {
  const title = document.querySelector('#productTitle')?.textContent?.trim();
  const price = document.querySelector('.a-price .a-offscreen')?.textContent?.trim()
    || document.querySelector('#priceblock_ourprice, #priceblock_dealprice')?.textContent?.trim();
  const ratingText = document.querySelector('#acrPopover')?.getAttribute('title')
    || document.querySelector('[data-hook="rating-out-of-text"]')?.textContent?.trim();
  const reviewText = document.querySelector('#acrCustomerReviewText')?.textContent?.trim();
  const image = document.querySelector('#landingImage');
  return {
    title,
    price,
    rating: ratingText ? parseFloat(ratingText) : null,
    review_count: reviewText ? parseInt(reviewText.replace(/[^0-9]/g, ''), 10) : null,
    image_url: image?.getAttribute('data-old-hires') || image?.getAttribute('src') || null,
  };
}
"""


def _api_json(base_url: str, path: str, *, body: dict | None = None, timeout: int = 15) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}{path}",
        data=data,
        method="POST" if body is not None else "GET",
        headers={"Content-Type": "application/json"} if body is not None else {},
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _load_state(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return {"next_query_index": 0, "query_pages": {}}


def _save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2) + "\n")


def _launch_browser():
    from cloakbrowser import launch_persistent_context

    proxy_url = os.environ.get("VPN_PROXY_URL_US")
    if not proxy_url:
        raise RuntimeError("VPN_PROXY_URL_US is required; Amazon collection must use the VPN proxy")
    profile = os.environ.get("PRODUCTFEED_BROWSER_PROFILE", "/home/collector/.product-feed/browser-profile")
    context = launch_persistent_context(
        profile,
        headless=True,
        humanize=True,
        viewport={"width": 1280, "height": 900},
        proxy={"server": proxy_url},
    )
    page = context.pages[-1] if context.pages else context.new_page()
    return context, page


def _challenge_visible(page) -> bool:
    body = (page.locator("body").inner_text(timeout=5000) or "").lower()
    return any(
        marker in body
        for marker in (
            "enter the characters you see below",
            "sorry, we just need to make sure you're not a robot",
            "automated access to amazon data",
        )
    )


def _deficient_sites(api_url: str, subscriptions: dict) -> dict[str, int]:
    deficits = {}
    for site, subscription in subscriptions.items():
        depth = _api_json(api_url, f"/subscriptions/{urllib.parse.quote(site)}/inventory-depth")
        deficit = max(0, subscription.target_available_depth - int(depth.get("available", 0)))
        if deficit:
            deficits[site] = deficit
    return deficits


def collect_once() -> int:
    api_url = os.environ.get("PRODUCTFEED_API", "http://api:4761")
    registry_dir = Path(os.environ.get("PRODUCTFEED_REGISTRY_DIR", "/app/registry"))
    state_path = Path(
        os.environ.get(
            "PRODUCTFEED_COLLECTOR_STATE", "/home/collector/.product-feed/collector-state.json"
        )
    )
    subscriptions = load_subscriptions(str(registry_dir / "subscriptions.yaml"))
    queries = load_source_queries(str(registry_dir / "sources.yaml"))
    if not subscriptions or not queries:
        print("[collector] no subscriptions or source queries configured")
        return 1

    try:
        deficits = _deficient_sites(api_url, subscriptions)
    except Exception as exc:
        print(f"[collector] product-feed API unavailable: {exc}")
        return 1
    if not deficits:
        print("[collector] inventory targets satisfied; no Amazon requests needed")
        return 0

    needed_tags = set()
    for site in deficits:
        needed_tags.update(subscriptions[site].tags_any)
    eligible_queries = [query for query in queries if set(query.tags) & needed_tags]
    if not eligible_queries:
        print(f"[collector] no discovery queries match deficient sites: {sorted(deficits)}")
        return 1

    state = _load_state(state_path)
    max_queries = max(1, int(os.environ.get("PRODUCTFEED_MAX_QUERIES_PER_RUN", "4")))
    configured_product_limit = max(
        1, int(os.environ.get("PRODUCTFEED_MAX_PRODUCTS_PER_RUN", "16"))
    )
    # Do not browse sixteen product pages to repair a three-product deficit.
    # The sum is used (instead of only the largest deficit) because sites may
    # subscribe to disjoint tag sets and need different products.
    max_products = min(configured_product_limit, sum(deficits.values()))
    min_rating = float(os.environ.get("PRODUCTFEED_MIN_RATING", "3.8"))
    min_reviews = int(os.environ.get("PRODUCTFEED_MIN_REVIEWS", "10"))
    max_search_pages = max(1, int(os.environ.get("PRODUCTFEED_MAX_SEARCH_PAGES", "5")))

    existing = {
        product["asin"]
        for product in _api_json(api_url, "/products?limit=500").get("items", [])
    }
    stored = 0
    attempted_queries = 0
    context, page = _launch_browser()
    try:
        while attempted_queries < max_queries and stored < max_products:
            index = int(state.get("next_query_index", 0)) % len(eligible_queries)
            query = eligible_queries[index]
            state["next_query_index"] = (index + 1) % len(eligible_queries)
            page_number = int(state.setdefault("query_pages", {}).get(query.id, 1))
            state["query_pages"][query.id] = (page_number % max_search_pages) + 1
            _save_state(state_path, state)
            attempted_queries += 1

            url = (
                "https://www.amazon.com/s?k="
                f"{urllib.parse.quote_plus(query.query)}&page={page_number}"
            )
            print(
                f"[collector] query={query.id!r} page={page_number} "
                f"deficits={deficits}"
            )
            page.goto(url, wait_until="domcontentloaded", timeout=45_000)
            time.sleep(2)
            if _challenge_visible(page):
                print("[collector] Amazon challenge detected; stopping without bypass attempt")
                return 2

            cards = page.evaluate(SEARCH_JS) or []
            cards = [
                card
                for card in cards
                if card["asin"] not in existing
                and (card.get("rating") or 0) >= min_rating
                and (card.get("review_count") or 0) >= min_reviews
            ]
            cards.sort(key=lambda card: card.get("review_count") or 0, reverse=True)

            for card in cards:
                if stored >= max_products:
                    break
                asin = card["asin"]
                # Amazon can render the same ASIN more than once in a result
                # page (for example, an organic card plus a carousel card).
                # ``cards`` was filtered before this loop, so re-check after
                # each successful insert as well.
                if asin in existing:
                    continue
                page.goto(
                    f"https://www.amazon.com/dp/{asin}",
                    wait_until="domcontentloaded",
                    timeout=45_000,
                )
                time.sleep(1.5)
                if _challenge_visible(page):
                    print("[collector] Amazon challenge detected during product verification; stopping")
                    return 2
                verified = page.evaluate(PRODUCT_JS) or {}
                if not verified.get("title"):
                    print(f"[collector] ASIN {asin} failed /dp/ verification")
                    continue
                payload = {
                    "asin": asin,
                    "title": verified["title"],
                    "price": verified.get("price"),
                    "rating": verified.get("rating") or card.get("rating"),
                    "review_count": verified.get("review_count") or card.get("review_count"),
                    "image_url": verified.get("image_url"),
                    "tags": query.tags,
                    "source_query": query.id,
                    "source": "amazon",
                    "metadata": {"discovery_query": query.query, "search_page": page_number},
                }
                result = _api_json(api_url, "/products", body=payload)
                product = result["product"]
                if product["amazon_url"] != f"https://www.amazon.com/dp/{asin}":
                    raise RuntimeError(f"feed returned non-canonical URL for {asin}")
                existing.add(asin)
                stored += 1
                print(f"[collector] stored {asin}: {verified['title']}")
    finally:
        context.close()

    print(f"[collector] complete: stored {stored} verified product(s)")
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(argv or sys.argv[1:])
    loop = "--loop" in argv
    interval = max(300, int(os.environ.get("PRODUCTFEED_COLLECT_INTERVAL_SECONDS", "3600")))
    while True:
        try:
            result = collect_once()
        except (urllib.error.URLError, OSError, RuntimeError) as exc:
            print(f"[collector] failed: {exc}")
            result = 1
        if not loop:
            return result
        # Retry ordinary startup/network failures promptly. An Amazon
        # challenge is intentionally not retried until the normal interval;
        # the collector never attempts to bypass it.
        time.sleep(60 if result == 1 else interval)


if __name__ == "__main__":
    raise SystemExit(main())
