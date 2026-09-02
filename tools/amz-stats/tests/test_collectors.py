"""Tests for amz_stats.collectors — harvest, catalog, and summary."""
from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
import respx

from amz_stats.api import AMZClient, TOKEN_URL, API_BASE
from amz_stats.collectors import harvest_asins, collect_catalog, build_summary


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

TOKEN_RESPONSE = {
    "access_token": "test-bearer-token",
    "token_type": "bearer",
    "expires_in": 3600,
}


def _make_item(asin: str, title: str, *, oos: bool = False, no_offers: bool = False) -> dict:
    """Build a minimal API item dict for testing."""
    item: dict = {
        "asin": asin,
        "detailPageURL": f"https://amazon.com/dp/{asin}",
        "parentASIN": f"P{asin[1:]}",
        "itemInfo": {
            "title": {"displayValue": title},
            "byLineInfo": {"brand": {"displayValue": "TestBrand"}},
        },
        "images": {
            "primary": {
                "medium": {"url": f"https://images.amazon.com/{asin}.jpg"},
            }
        },
        "customerReviews": {
            "starRating": {"value": 4.5},
            "count": 1000,
        },
    }
    if no_offers:
        # offersV2 absent — UNKNOWN availability
        pass
    elif oos:
        # offersV2 present, listings empty — OOS
        item["offersV2"] = {"listings": []}
    else:
        # In stock
        item["offersV2"] = {
            "listings": [
                {"price": {"displayAmount": "$19.99"}}
            ]
        }
    return item


def _items_response(asins: list[str], oos_asins: frozenset[str] = frozenset(),
                    no_offers_asins: frozenset[str] = frozenset()) -> dict:
    items = []
    for a in asins:
        items.append(_make_item(
            a,
            f"Product {a}",
            oos=a in oos_asins,
            no_offers=a in no_offers_asins,
        ))
    return {"itemsResult": {"items": items}}


@pytest.fixture
def cache_file(tmp_path: Path) -> Path:
    return tmp_path / "out" / ".token_cache.json"


@pytest.fixture
def client(cache_file: Path) -> AMZClient:
    return AMZClient(
        key_id="test-key",
        key_secret="test-secret",
        store_id="mystore-20",
        cache_file=cache_file,
    )


# ---------------------------------------------------------------------------
# test_harvest_asins
# ---------------------------------------------------------------------------

def _write_affiliate_ts(path: Path, asins: list[str]) -> None:
    """Write a minimal affiliate.ts-like file with the given ASINs."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    for a in asins:
        lines.append(f"  asin: '{a}',")
    path.write_text("\n".join(lines) + "\n")


def test_harvest_asins(tmp_path: Path):
    # Site A: 3 ASINs
    site_a = tmp_path / "sites" / "site-a.com" / "site" / "src" / "lib"
    _write_affiliate_ts(site_a / "affiliate.ts", ["B001AAAAAA", "B002BBBBBB", "B003CCCCCC"])

    # Site B: 1 ASIN
    site_b = tmp_path / "sites" / "site-b.com" / "site" / "src" / "lib"
    _write_affiliate_ts(site_b / "affiliate.ts", ["B004DDDDDD"])

    # Site C: no affiliate.ts at all — must be silently skipped
    (tmp_path / "sites" / "site-c.com" / "site" / "src" / "lib").mkdir(parents=True)

    result = harvest_asins(tmp_path)

    assert set(result.keys()) == {"site-a.com", "site-b.com"}
    assert sorted(result["site-a.com"]) == sorted(["B001AAAAAA", "B002BBBBBB", "B003CCCCCC"])
    assert result["site-b.com"] == ["B004DDDDDD"]
    # site-c.com must NOT appear
    assert "site-c.com" not in result


def test_harvest_asins_no_sites(tmp_path: Path):
    """No sites dir at all → empty dict."""
    result = harvest_asins(tmp_path)
    assert result == {}


def test_harvest_asins_deduplicates_within_site(tmp_path: Path):
    """Same ASIN appearing twice in one file → deduplicated."""
    site = tmp_path / "sites" / "dup.com" / "site" / "src" / "lib"
    ts = site / "affiliate.ts"
    site.mkdir(parents=True)
    ts.write_text('  asin: "B001AAAAAA",\n  asin: "B001AAAAAA",\n  asin: "B002BBBBBB",\n')

    result = harvest_asins(tmp_path)
    assert sorted(result["dup.com"]) == ["B001AAAAAA", "B002BBBBBB"]


# ---------------------------------------------------------------------------
# test_collect_catalog
# ---------------------------------------------------------------------------

@respx.mock
def test_collect_catalog(client: AMZClient, cache_file: Path):
    """Single batch of 2 items; verify all parsed fields."""
    respx.post(TOKEN_URL).mock(return_value=httpx.Response(200, json=TOKEN_RESPONSE))

    batch_asins = ["B001AAAAAA", "B002BBBBBB"]
    respx.post(f"{API_BASE}/catalog/v1/getItems").mock(
        return_value=httpx.Response(200, json=_items_response(batch_asins))
    )

    asins_by_site = {"site-a.com": batch_asins}

    with client:
        result = collect_catalog(client, asins_by_site)

    assert result["ok"] is True
    assert result["errors"] == []
    assert result["batch_count"] == 1

    a1 = result["asins"]["B001AAAAAA"]
    assert a1["title"] == "Product B001AAAAAA"
    assert a1["brand"] == "TestBrand"
    assert a1["price"] == "$19.99"
    assert a1["availability"] == "IN_STOCK"
    assert a1["rating"] == 4.5
    assert a1["review_count"] == 1000
    assert a1["image_url"] == "https://images.amazon.com/B001AAAAAA.jpg"
    assert a1["detail_page_url"] == "https://amazon.com/dp/B001AAAAAA"
    assert a1["parent_asin"] == "P001AAAAAA"


@respx.mock
def test_collect_catalog_oos_and_unknown(client: AMZClient, cache_file: Path):
    """OOS item + item with no offersV2 → correct availability strings."""
    respx.post(TOKEN_URL).mock(return_value=httpx.Response(200, json=TOKEN_RESPONSE))

    respx.post(f"{API_BASE}/catalog/v1/getItems").mock(
        return_value=httpx.Response(
            200,
            json=_items_response(
                ["B001AAAAAA", "B002BBBBBB"],
                oos_asins=frozenset(["B001AAAAAA"]),
                no_offers_asins=frozenset(["B002BBBBBB"]),
            ),
        )
    )

    asins_by_site = {"site-a.com": ["B001AAAAAA", "B002BBBBBB"]}

    with client:
        result = collect_catalog(client, asins_by_site)

    assert result["asins"]["B001AAAAAA"]["availability"] == "OOS"
    assert result["asins"]["B002BBBBBB"]["availability"] == "UNKNOWN"


@respx.mock
def test_collect_catalog_batch_error_continues(client: AMZClient, cache_file: Path):
    """AMZError on a batch → ASINs added to errors, ok still True, other batches succeed."""
    from amz_stats.api import AMZError

    respx.post(TOKEN_URL).mock(return_value=httpx.Response(200, json=TOKEN_RESPONSE))

    call_count = 0

    def batch_handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        body = json.loads(request.content)
        if "B001AAAAAA" in body["itemIds"]:
            return httpx.Response(500, json={"message": "Internal error"})
        return httpx.Response(200, json=_items_response(body["itemIds"]))

    respx.post(f"{API_BASE}/catalog/v1/getItems").mock(side_effect=batch_handler)

    # 11 ASINs → 2 batches: first batch (10) fails, second (1) succeeds
    # Ensure all are 10-char uppercase+digit
    failing_asins = ["B001AAAAAA"] + [f"B{str(i).zfill(9)}" for i in range(1, 10)]
    good_asin = "B099GGGGGG"
    all_asins = failing_asins + [good_asin]

    asins_by_site = {"site-a.com": all_asins}

    with client:
        result = collect_catalog(client, asins_by_site)

    assert result["ok"] is True
    assert good_asin in result["asins"]
    # All 10 failing batch ASINs should be in errors
    for a in failing_asins:
        assert a in result["errors"]
    assert result["batch_count"] == 2


@respx.mock
def test_collect_catalog_deduplicates_across_sites(client: AMZClient, cache_file: Path):
    """Same ASIN on two sites → only 1 API call for it, 1 batch."""
    respx.post(TOKEN_URL).mock(return_value=httpx.Response(200, json=TOKEN_RESPONSE))

    captured_bodies: list[dict] = []

    def capture(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured_bodies.append(body)
        return httpx.Response(200, json=_items_response(body["itemIds"]))

    respx.post(f"{API_BASE}/catalog/v1/getItems").mock(side_effect=capture)

    shared_asin = "B001AAAAAA"
    asins_by_site = {
        "site-a.com": [shared_asin, "B002BBBBBB"],
        "site-b.com": [shared_asin, "B003CCCCCC"],
    }

    with client:
        result = collect_catalog(client, asins_by_site)

    all_requested = [a for b in captured_bodies for a in b["itemIds"]]
    # shared_asin should appear only once across all requests
    assert all_requested.count(shared_asin) == 1
    assert result["batch_count"] == 1  # 3 unique ASINs → single batch


# ---------------------------------------------------------------------------
# test_build_summary
# ---------------------------------------------------------------------------

def _mock_catalog(asins_by_site: dict[str, list[str]],
                  oos_asins: frozenset[str] = frozenset(),
                  unknown_asins: frozenset[str] = frozenset(),
                  error_asins: frozenset[str] = frozenset()) -> dict:
    """Build a catalog dict matching collect_catalog's return shape."""
    all_asins = {a for site_asins in asins_by_site.values() for a in site_asins}
    items: dict[str, dict] = {}
    for a in all_asins:
        if a in error_asins:
            continue
        if a in oos_asins:
            avail = "OOS"
        elif a in unknown_asins:
            avail = "UNKNOWN"
        else:
            avail = "IN_STOCK"
        items[a] = {
            "title": f"Product {a}",
            "brand": "TestBrand",
            "price": "$9.99",
            "availability": avail,
            "rating": 4.0,
            "review_count": 100,
            "image_url": None,
            "detail_page_url": f"https://amazon.com/dp/{a}",
            "parent_asin": None,
        }
    return {
        "ok": True,
        "asins": items,
        "errors": sorted(error_asins),
        "batch_count": 1,
    }


def test_build_summary_basic():
    asins_by_site = {
        "site-a.com": ["B001AAAAAA", "B002BBBBBB"],
        "site-b.com": ["B003CCCCCC"],
    }
    catalog = _mock_catalog(asins_by_site)
    summary = build_summary(asins_by_site, catalog)

    assert summary["totals"]["site_count"] == 2
    assert summary["totals"]["asin_count"] == 3   # sum of per-site counts
    assert summary["totals"]["unique_asin_count"] == 3
    assert summary["totals"]["oos_count"] == 0
    assert summary["totals"]["delisted_count"] == 0
    assert summary["totals"]["unknown_count"] == 0
    assert summary["totals"]["error_count"] == 0

    assert summary["per_site"]["site-a.com"]["asin_count"] == 2
    assert summary["per_site"]["site-b.com"]["asin_count"] == 1
    assert sorted(summary["per_site"]["site-a.com"]["asins"]) == ["B001AAAAAA", "B002BBBBBB"]


def test_build_summary_with_oos_and_unknown():
    asins_by_site = {
        "site-a.com": ["B001AAAAAA", "B002BBBBBB", "B003CCCCCC"],
    }
    catalog = _mock_catalog(
        asins_by_site,
        oos_asins=frozenset(["B001AAAAAA"]),
        unknown_asins=frozenset(["B002BBBBBB"]),
    )
    summary = build_summary(asins_by_site, catalog)

    assert summary["per_site"]["site-a.com"]["oos_count"] == 1
    assert summary["per_site"]["site-a.com"]["unknown_count"] == 1
    assert summary["per_site"]["site-a.com"]["delisted_count"] == 0
    assert summary["totals"]["oos_count"] == 1
    assert summary["totals"]["unknown_count"] == 1


def test_build_summary_with_api_errors():
    """An ASIN whose API call FAILED is unchecked, not delisted.

    This test previously asserted the opposite. That assertion encoded the bug:
    on 2026-07-30 a transient PA-API 403 put all 412 ASINs into `errors` and the
    run reported "delisted=412" — an Amazon hiccup rendered as a catalog-wide
    product wipe. A failed call carries no information about the product.
    """
    asins_by_site = {
        "site-a.com": ["B001AAAAAA", "B002BBBBBB"],
    }
    catalog = _mock_catalog(
        asins_by_site,
        error_asins=frozenset(["B002BBBBBB"]),
    )
    summary = build_summary(asins_by_site, catalog)

    assert summary["per_site"]["site-a.com"]["unchecked_count"] == 1
    assert summary["per_site"]["site-a.com"]["delisted_count"] == 0
    assert summary["per_site"]["site-a.com"]["asin_count"] == 2
    assert summary["totals"]["unchecked_count"] == 1
    assert summary["totals"]["delisted_count"] == 0
    assert summary["totals"]["error_count"] == 1


def test_build_summary_shared_asin_across_sites():
    """Same ASIN on 2 sites → unique_asin_count counts it once, asin_count counts it per-site."""
    shared = "B001SHARED0"
    asins_by_site = {
        "site-a.com": [shared, "B002BBBBBB"],
        "site-b.com": [shared],
    }
    catalog = _mock_catalog(asins_by_site)
    summary = build_summary(asins_by_site, catalog)

    assert summary["totals"]["asin_count"] == 3       # 2 + 1
    assert summary["totals"]["unique_asin_count"] == 2  # B001SHARED0 + B002BBBBBB


def test_build_summary_missing_asin():
    """ASIN in asins_by_site but in neither catalog["asins"] nor catalog["errors"] → missing_count incremented."""
    asins_by_site = {
        "site-a.com": ["B001MISSING"],
    }
    # Catalog is empty — no ASINs collected, no errors
    catalog = _mock_catalog(asins_by_site, error_asins=frozenset())
    # Manually empty out the asins dict to simulate a true missing ASIN
    catalog["asins"] = {}

    summary = build_summary(asins_by_site, catalog)

    assert summary["per_site"]["site-a.com"]["missing_count"] == 1
    assert summary["totals"]["missing_count"] == 1
