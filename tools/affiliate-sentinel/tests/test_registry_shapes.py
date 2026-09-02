"""Registry shapes that used to parse to zero products, or to the wrong ones.

Every case here is a site that was silently UNMONITORED in production, not a
hypothetical. The sentinel's whole value is that adding a product anywhere in
the fleet is picked up with no configuration, so a shape it cannot read is a
monitoring outage, not a cosmetic gap.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import registry  # noqa: E402


def _write(root: Path, rel: str, text: str) -> Path:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


CATALOG_SECTION = """
import type {{ Item }} from '../types';

export const {const}: Item[] = [
  {{
    id: '{pid}',
    stage: 'hook',
    name: '{pid} name',
    brand: 'Acme',
    price: 7,
    q: '{pid} search phrase',
    tier: 'value',
    hook: {{
      // A nested spec, not a product. It has no id, but it does carry braces.
      sizes: ['#8', '5/0'],
      style: 'octopus',
    }},
  }},
];
"""


def test_split_catalog_directory_is_parsed_whole(tmp_path: Path):
    """fishhooklabs: catalog split across three files behind a barrel index."""
    site = tmp_path / "fishhooklabs.com"
    for const, pid in (("TERMINAL", "octopus-hook"), ("PLATFORM", "spinning-reel"), ("FIELD", "tackle-box")):
        _write(site, f"site/src/data/catalog/{const.lower()}.ts", CATALOG_SECTION.format(const=const, pid=pid))
    # The barrel re-exports and declares no products; it must not win.
    _write(site, "site/src/data/catalog/index.ts", "export const CATALOG = [...TERMINAL];\n")
    _write(site, "site/src/lib/affiliate.ts", "export const AMAZON_TAG = 'fishhooklabs-20';\n")

    files = registry.find_registries(site)
    assert [f.name for f in files] == ["field.ts", "platform.ts", "terminal.ts"]

    products = registry.parse_all(site, registry.find_registry(site))
    assert {p.id for p in products} == {"octopus-hook", "spinning-reel", "tackle-box"}
    # `q` is a search phrase like any other: without it these are not products
    # at all and every one of their /go/ links goes unchecked.
    assert all(p.is_product and p.search_query and not p.is_asin_backed for p in products)
    # Each product knows the file it lives in, so a heal edits the right one.
    assert {p.source.name for p in products} == {"field.ts", "platform.ts", "terminal.ts"}


def test_nested_entries_do_not_masquerade_as_their_parent(tmp_path: Path):
    """arttogogh: each painting wraps three buy-links in an `orders` array."""
    site = tmp_path / "arttogogh.com"
    _write(
        site,
        "site/src/lib/catalog.ts",
        """
export const BOARD = [
  {
    slug: 'starry-night',
    title: 'The Starry Night',
    image: '/img/starry-night.jpg',
    orders: [
      { id: 'starry-night-print', label: 'The print', price: '~$19', search: 'starry night matte poster' },
      { id: 'starry-night-book', label: 'The book', price: '~$25', search: 'van gogh book' },
    ],
  },
];
""",
    )
    products = {p.id: p for p in registry.parse(site / "site/src/lib/catalog.ts")}

    # The buy-links are the products, and both of them — reading the parent's
    # first nested id found one "product" per painting and missed the rest.
    assert {p.id for p in products.values() if p.is_product} == {
        "starry-night-print",
        "starry-night-book",
    }
    assert products["starry-night-print"].search_query == "starry night matte poster"
    # The painting owns the links; it is not a fourth link. Cloaking it would
    # invent /go/starry-night, a route the site never generates.
    assert products["starry-night"].is_container
    assert not products["starry-night"].is_product


def test_nested_specs_do_not_leak_into_the_parent(tmp_path: Path):
    """A nested `{...}` must not donate its fields to the entry that owns it."""
    site = tmp_path / "example.com"
    path = _write(
        site,
        "site/src/lib/affiliate.ts",
        """
export const PRODUCTS = [
  { id: 'rod', name: 'Rod', asin: 'B000000001', specs: { url: 'https://example.com/not-the-product' } },
];
""",
    )
    (product,) = registry.parse(path)
    assert product.asin == "B000000001"
    assert product.url is None


@pytest.mark.parametrize("rel", ["site/src/lib/affiliate.ts", "site/src/data/affiliate.ts"])
def test_single_file_registry_still_wins(tmp_path: Path, rel: str):
    site = tmp_path / "classic.com"
    _write(
        site,
        rel,
        """
export const PRODUCTS = [
  { id: 'a', name: 'A', asin: 'B000000001' },
  { id: 'b', name: 'B', asin: 'B000000002' },
];
""",
    )
    assert registry.find_registry(site) == site / rel
    assert len(registry.parse_all(site, registry.find_registry(site))) == 2


def test_json_array_registry_under_data(tmp_path: Path):
    """seedstosauce: 67 products in `site/src/data/products.json`.

    Not an `affiliate*.ts` and not a one-file-per-product directory, so both
    discovery paths missed it and the site alerted as UNMONITORED nightly.
    """
    site = tmp_path / "seedstosauce.com"
    _write(
        site,
        "site/src/data/products.json",
        """[
  {"id": "garlic-bulbs", "name": "Seed Garlic", "asin": "B0D3C243MT", "searchQuery": "hardneck seed garlic"},
  {"id": "canning-jars", "name": "Canning Jars", "asin": "B0D3C243MU", "searchQuery": "wide mouth canning jars"}
]
""",
    )
    _write(site, "site/src/lib/affiliate.ts", "export const AMAZON_TAG = 'seedstosauce-20';\n")

    products = registry.parse_all(site, registry.find_registry(site))
    assert {p.id for p in products} == {"garlic-bulbs", "canning-jars"}
    assert all(p.is_asin_backed for p in products)


def test_ts_array_registry_under_data(tmp_path: Path):
    """shoppinkflamingo: products in `data/products.ts`, keyed on `slug`."""
    site = tmp_path / "shoppinkflamingo.com"
    _write(
        site,
        "site/src/data/products.ts",
        """
export const categories = [
  { slug: 'yard', name: 'Yard & Garden', icon: '✦', desc: 'Make the neighbors wonder.' },
];
export const products = [
  { slug: 'classic-yard-flamingo', name: 'The Classic', image: '/a.webp', search: 'pink flamingo lawn ornament' },
  { slug: 'flamingo-pool-float', name: 'Pool Float', image: '/b.webp', search: 'flamingo pool float giant' },
];
""",
    )
    products = {p.id: p for p in registry.parse_all(site, registry.find_registry(site))}
    assert {p.id for p in products.values() if p.is_product} == {
        "classic-yard-flamingo",
        "flamingo-pool-float",
    }
    # A category is navigation, not a buy-link: it has an id and a name, and
    # cloaking it would invent /go/yard.
    assert not products["yard"].is_product
