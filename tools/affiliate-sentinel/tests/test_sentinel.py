#!/usr/bin/env python3
"""Tests for tools/affiliate-sentinel.

Run: python3 tools/affiliate-sentinel/tests/test_sentinel.py

Focused on the behaviours that can silently ship a wrong product to a live
site, since healing now writes to `affiliate.ts` and queues a deploy:
the registry editor's surgical guarantees, the model-output validation that
stops a hallucinated ASIN, the build-gate revert, and the cloak classifier's
false-positive guards.
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cloak  # noqa: E402
import discover  # noqa: E402
import heal as heal_mod  # noqa: E402
import registry as registry_mod  # noqa: E402
import sentinel  # noqa: E402
import state as state_mod  # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILURES.append(name)


SAMPLE_REGISTRY = """// Registry with a hand-written comment that must survive editing.
export const AMAZON_TAG = 'example-20';

export const PRODUCTS: AffiliateProduct[] = [
  {
    id: 'alpha',
    name: 'Alpha Thing',
    brand: 'AlphaCo',
    category: 'care',
    price: '$10.00',
    asin: 'B000000001',
    searchQuery: 'alpha thing',
    image: '/products/alpha.jpg',
    blurb:
      'A blurb with a { brace } and an apostrophe-free body.',
    rating: 4.1,
    reviewCount: 100,
    pros: ['One', 'Two'],
    cons: ['Three'],
  },
  {
    id: 'beta-search-only',
    name: 'Beta Thing',
    category: 'care',
    searchQuery: 'beta thing',
    blurb: 'No ASIN — search-URL entry.',
  },
];
"""


def test_registry_parse():
    print("registry.parse")
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "affiliate.ts"
        p.write_text(SAMPLE_REGISTRY)
        prods = registry_mod.parse(p)
        check("finds both entries", len(prods) == 2, f"got {len(prods)}")
        a, b = prods
        check("ids in source order", (a.id, b.id) == ("alpha", "beta-search-only"))
        check("asin parsed", a.asin == "B000000001")
        check("brace inside a blurb does not break brace matching", a.text.rstrip().endswith("}"))
        check("search-only entry has no asin", b.asin is None)
        check("is_asin_backed distinguishes the two", a.is_asin_backed and not b.is_asin_backed)
        check("search_seed prefers searchQuery", a.search_seed() == "alpha thing")


def test_registry_apply_updates():
    print("registry.apply_updates")
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "affiliate.ts"
        p.write_text(SAMPLE_REGISTRY)
        prods = registry_mod.parse(p)
        alpha = prods[0]
        new = registry_mod.apply_updates(
            p, alpha,
            {"asin": "B000000009", "price": "$12.34", "rating": 4.8,
             "pros": ["Fresh", "New"], "name": "Alpha Two"},
        )
        check("asin replaced", "asin: 'B000000009'" in new)
        check("old asin gone", "B000000001" not in new)
        check("price replaced", "price: '$12.34'" in new)
        check("numeric written unquoted", "rating: 4.8" in new)
        check("array written as TS array", "pros: ['Fresh', 'New']" in new)
        check("hand-written comment preserved", "must survive editing" in new)
        check("sibling entry untouched", "id: 'beta-search-only'" in new)
        check("unrelated field untouched", "reviewCount: 100" in new)

        # A field the entry does not declare must not be invented — the site's
        # TS type would reject it and the build gate would fail on our own edit.
        check("unknown_keys flags undeclared field",
              registry_mod.unknown_keys(prods[1], {"asin": "X", "rating": 1}) == ["asin", "rating"])
        after = registry_mod.apply_updates(p, prods[1], {"rating": 5.0})
        check("undeclared field is not injected", "rating: 5.0" not in after)


def test_registry_stale_guard():
    print("registry stale-parse guard")
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "affiliate.ts"
        p.write_text(SAMPLE_REGISTRY)
        alpha = registry_mod.parse(p)[0]
        p.write_text("// file changed underneath us\n" + SAMPLE_REGISTRY)
        try:
            registry_mod.apply_updates(p, alpha, {"asin": "B000000009"})
            check("refuses to edit a changed file", False, "no exception raised")
        except ValueError:
            check("refuses to edit a changed file", True)


DOUBLE_QUOTED_REGISTRY = """
export interface Book { id: string; asin: string; title: string; }

export const SHELVES = [
  { id: "probability", title: "Probability", tagline: "no asin here" },
];

export const BOOKS: Book[] = [
  { id: "knuth", asin: "0201896842", title: "TAOCP", image: "/p/knuth.jpg" },
];
"""


def test_registry_double_quotes_and_non_products():
    print("registry: double quotes + non-product objects")
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "affiliate.ts"
        p.write_text(DOUBLE_QUOTED_REGISTRY)
        prods = registry_mod.parse(p)
        by_id = {x.id: x for x in prods}
        check("double-quoted ids parsed", "knuth" in by_id and "probability" in by_id, f"got {list(by_id)}")
        check("double-quoted asin parsed", by_id["knuth"].asin == "0201896842")
        check("interface declaration is not a product", "string" not in by_id)
        check("shelf is not a product", not by_id["probability"].is_product)
        check("book is a product", by_id["knuth"].is_product)

        new = registry_mod.apply_updates(p, by_id["knuth"], {"asin": "B000000009"})
        check("double-quoted value can be rewritten", "asin: 'B000000009'" in new)
        check("old double-quoted asin gone", "0201896842" not in new)


ALIAS_REGISTRY = """
export const PRODUCTS = [
  { slug: 'urn', url: 'https://www.amazon.com/dp/B0BPF23C8D', network: 'amazon',
    label: 'Rosewood Urn' },
  { id: 'book', kind: 'amazon', name: 'A Book', searchOrAsin: 'B000000001' },
  { id: 'phrase', kind: 'amazon', name: 'Some Thing', searchOrAsin: 'some thing' },
  { id: 'partner', kind: 'partner', name: 'Partner', url: 'https://partner.example/ref/x' },
];
"""


def test_registry_field_aliases():
    print("registry: field aliases across fleet shapes")
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "affiliates.ts"
        p.write_text(ALIAS_REGISTRY)
        by_id = {x.id: x for x in registry_mod.parse(p)}
        check("slug works as an id", "urn" in by_id, f"got {list(by_id)}")
        check("ASIN recovered from a /dp/ url", by_id["urn"].asin == "B0BPF23C8D")
        check("label works as a name", by_id["urn"].name == "Rosewood Urn")
        check("searchOrAsin read as an ASIN when it looks like one",
              by_id["book"].asin == "B000000001")
        check("searchOrAsin read as a query when it does not",
              by_id["phrase"].asin is None and by_id["phrase"].search_query == "some thing")
        check("partner entry keeps its url", by_id["partner"].url == "https://partner.example/ref/x")
        check("partner entry counts as a product", by_id["partner"].is_product)


def test_find_registry_locates_non_standard_paths():
    print("registry.find_registry")
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        (root / "site" / "src" / "data").mkdir(parents=True)
        (root / "site" / "src" / "lib").mkdir(parents=True)
        (root / "site" / "src" / "data" / "affiliates.ts").write_text(ALIAS_REGISTRY)
        found = registry_mod.find_registry(root)
        check("finds a registry under data/", found is not None and found.name == "affiliates.ts")

        # A test file next door must never win.
        (root / "site" / "src" / "lib" / "affiliate.test.ts").write_text(SAMPLE_REGISTRY)
        found = registry_mod.find_registry(root)
        check("ignores *.test.ts", found is not None and "test" not in found.name)

        check("returns None when there is no registry at all",
              registry_mod.find_registry(Path(d) / "nope") is None)


def test_partner_cloak_is_not_flagged():
    print("cloak: non-Amazon partner destinations")
    partner = "https://partner.example/ref/x"
    r = cloak.check(_Client(_Resp(302, {"location": "https://partner.example/ref/x?u=1"})),
                    "https://example.com", "/go/", "p", None, "x-20", expected_url=partner)
    check("partner link to the declared host is healthy", r.ok)

    r = cloak.check(_Client(_Resp(302, {"location": "https://somewhere-else.example/"})),
                    "https://example.com", "/go/", "p", None, "x-20", expected_url=partner)
    check("partner link to the wrong host is a failure", not r.ok)


def test_has_cloak():
    print("discover.has_cloak")
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        (root / "site" / "src" / "pages").mkdir(parents=True)
        (root / "site" / "public").mkdir(parents=True)
        check("no cloak mechanism at all", not discover.has_cloak(root, "/go/"))
        ids, _ = discover.go_ids(root, "/go/", {"a", "b"})
        check("registry ids are NOT routes without a cloak", ids == set(), f"got {ids}")

        go = root / "site" / "src" / "pages" / "go"
        go.mkdir()
        (go / "[id].astro").write_text("x")
        check("a dynamic [id] route counts as a cloak", discover.has_cloak(root, "/go/"))
        ids, _ = discover.go_ids(root, "/go/", {"a", "b"})
        check("registry ids ARE routes behind a dynamic route", ids == {"a", "b"}, f"got {ids}")


def test_discover_unions_sources():
    print("discover.go_ids")
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        (root / "site" / "public").mkdir(parents=True)
        (root / "site" / "src" / "pages" / "go").mkdir(parents=True)
        (root / "site" / "public" / "_redirects").write_text(
            "# comment\n/go/from-redirects  https://www.amazon.com/dp/B1?tag=x-20  302\n"
        )
        (root / "site" / "src" / "pages" / "go" / "from-pages.astro").write_text("x")
        (root / "site" / "src" / "pages" / "go" / "[id].astro").write_text("x")
        (root / "site" / "src" / "pages" / "go" / "index.astro").write_text("x")

        ids, sources = discover.go_ids(root, "/go/", {"from-registry"})
        check("unions all three sources",
              ids == {"from-redirects", "from-pages", "from-registry"}, f"got {ids}")
        check("dynamic [id] route excluded", "[id]" not in ids)
        check("index route excluded", "index" not in ids)
        check("reports every source", len(sources) == 3, f"got {sources}")


class _Resp:
    def __init__(self, status, headers=None, text=""):
        self.status_code = status
        self.headers = headers or {}
        self.text = text


class _Client:
    def __init__(self, resp):
        self._resp = resp

    def get(self, url, follow_redirects=False):
        return self._resp


def test_cloak_classification():
    print("cloak.check")
    base, pre = "https://example.com", "/go/"

    r = cloak.check(_Client(_Resp(302, {"location": "https://www.amazon.com/dp/B1?tag=x-20"})),
                    base, pre, "p", "B1", "x-20")
    check("healthy 302 to the right ASIN", r.ok and not r.retired)

    r = cloak.check(_Client(_Resp(404)), base, pre, "p", "B1", "x-20")
    check("404 is a failure", not r.ok and r.is_infra_failure)

    r = cloak.check(_Client(_Resp(301, {"location": "/guides/best-thing/"})),
                    base, pre, "p", None, "x-20")
    check("301 back into the site is RETIRED, not a failure", r.ok and r.retired)

    r = cloak.check(_Client(_Resp(302, {"location": "https://www.amazon.com/dp/B1"})),
                    base, pre, "p", "B1", "x-20")
    check("missing affiliate tag is a failure", not r.ok)

    r = cloak.check(_Client(_Resp(302, {"location": "https://www.amazon.com/dp/B9?tag=x-20"})),
                    base, pre, "p", "B1", "x-20")
    check("wrong ASIN is a failure", not r.ok)

    r = cloak.check(_Client(_Resp(302, {"location": "https://www.amazon.com/s?k=thing&tag=x-20"})),
                    base, pre, "p", "B1", "x-20")
    check("search-URL target accepted", r.ok)

    body = '<meta http-equiv="refresh" content="0;url=https://www.amazon.com/dp/B1?tag=x-20">'
    r = cloak.check(_Client(_Resp(200, {}, body)), base, pre, "p", "B1", "x-20")
    check("static interstitial meta-refresh understood", r.ok)

    body = 'window.location.replace("https://www.amazon.com/dp/B1?tag=x-20")'
    r = cloak.check(_Client(_Resp(200, {}, body)), base, pre, "p", "B1", "x-20")
    check("static interstitial JS bounce understood", r.ok)

    r = cloak.check(_Client(_Resp(200, {}, "<html>nothing here</html>")), base, pre, "p", "B1", "x-20")
    check("200 with no redirect target is a failure", not r.ok)

    # An unencoded apostrophe inside the href used to truncate the URL right
    # there, chopping the tag off and reporting a good link as a revenue leak.
    body = (
        """<a href="https://www.amazon.com/s?k=griot's garage&amp;tag=x-20">go</a>"""
    )
    r = cloak.check(_Client(_Resp(200, {}, body)), base, pre, "p", None, "x-20")
    check("apostrophe inside the href does not truncate the URL", r.ok, f"target={r.target}")
    check("HTML entities are unescaped", r.target and "&amp;" not in r.target)

    body = """<a href='https://www.amazon.com/dp/B1?tag=x-20'>go</a>"""
    r = cloak.check(_Client(_Resp(200, {}, body)), base, pre, "p", "B1", "x-20")
    check("single-quoted href works too", r.ok)


def test_state_streaks():
    print("state streaks")
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        st = state_mod.load(root)
        check("fresh state starts empty", st["streaks"] == {})
        check("first observation is 1", state_mod.bump(st, "dead:a") == 1)
        check("second observation is 2", state_mod.bump(st, "dead:a") == 2)
        state_mod.bump(st, "dead:b")
        recovered = state_mod.reconcile(st, {"dead:a"})
        check("unobserved streak is cleared", recovered == ["dead:b"] and "dead:b" not in st["streaks"])
        check("observed streak survives", st["streaks"]["dead:a"] == 2)
        state_mod.save(root, st)
        check("round-trips through disk", state_mod.load(root)["streaks"]["dead:a"] == 2)

        bad = state_mod.path_for(root)
        bad.write_text("{ not json")
        check("corrupt state file does not wedge the run", state_mod.load(root)["streaks"] == {})


def test_redirects_rewrite_is_precise():
    print("heal.update_redirects")
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        (root / "site" / "public").mkdir(parents=True)
        rp = root / "site" / "public" / "_redirects"
        rp.write_text(
            "# header\n"
            "/go/balm        https://www.amazon.com/dp/BDEAD00001?tag=x-20  302\n"
            "/go/balm/       https://www.amazon.com/dp/BDEAD00001?tag=x-20  302\n"
            "/go/balm-stick  https://www.amazon.com/dp/BDEAD00001?tag=x-20  302\n"
        )
        heal_mod.update_redirects(root, "balm", "BDEAD00001", "BNEW000001", lambda m: None)
        text = rp.read_text()
        check("both /go/balm lines rewritten", text.count("/dp/BNEW000001") == 2)
        check("sibling /go/balm-stick left alone",
              "/go/balm-stick  https://www.amazon.com/dp/BDEAD00001" in text)
        check("comment header preserved", text.startswith("# header"))


class _StubHealth:
    def __init__(self, asin, price="$9.99"):
        self.asin, self.status, self.price = asin, "OK", price
        self.title, self.brand = "Stub Product", "StubCo"
        self.rating = self.review_count = None
        self.image_url = None


def _heal_harness(monkey_decision, build_ok):
    """Run heal_product against stubs; return (result, registry_text_after)."""
    import types

    d = tempfile.mkdtemp()
    root = Path(d)
    (root / "site" / "src" / "lib").mkdir(parents=True)
    rp = root / "site" / "src" / "lib" / "affiliate.ts"
    rp.write_text(SAMPLE_REGISTRY)
    product = registry_mod.parse(rp)[0]

    stub_amz = types.ModuleType("amz")
    stub_amz.OK = "OK"
    stub_amz.search_replacements = lambda cl, kw, exclude: [_StubHealth("BNEW000001"), _StubHealth("BNEW000002")]
    stub_amz.check_health = lambda cl, asins: {a: _StubHealth(a) for a in asins}
    sys.modules["amz"] = stub_amz

    orig_ask, orig_build = heal_mod._ask_model, heal_mod.build_gate
    heal_mod._ask_model = lambda *a, **k: monkey_decision
    heal_mod.build_gate = lambda *a, **k: build_ok
    try:
        res = heal_mod.heal_product(
            site_root=root, registry_path=rp, product=product, dead_asin="B000000001",
            cl=None, site_brand="Stub", model="m", dry_run=False, log=lambda m: None,
        )
    finally:
        heal_mod._ask_model, heal_mod.build_gate = orig_ask, orig_build
        sys.modules.pop("amz", None)
    return res, rp.read_text()


def test_heal_validation_and_revert():
    print("heal validation + build gate")
    good = {"choice": 0, "name": "New Thing", "brand": "StubCo", "blurb": "Fresh.",
            "pros": ["a"], "cons": ["b"], "reason": "fits"}

    res, text = _heal_harness(good, build_ok=True)
    check("healthy heal applies", res.healed and res.new_asin == "BNEW000001")
    check("registry actually written", "BNEW000001" in text)
    check("unverifiable fields reported",
          set(res.unverified) == {"rating", "reviewCount"}, f"got {res.unverified}")

    res, text = _heal_harness(good, build_ok=False)
    check("build-gate failure blocks the heal", not res.healed)
    check("registry reverted on build failure", "B000000001" in text and "BNEW000001" not in text)
    check("revert is reported as the reason", "build gate" in res.reason.lower())

    # The model must never be able to introduce an ASIN of its own.
    for bad, label in (
        ({"choice": 99}, "out-of-range index"),
        ({"choice": "BHACKED0001"}, "an ASIN string instead of an index"),
        ({"choice": None, "reason": "none fit"}, "an explicit no-fit"),
        ({"choice": -1}, "a negative index"),
    ):
        res, text = _heal_harness(bad, build_ok=True)
        check(f"rejects {label}", not res.healed)
        check(f"registry untouched after {label}", "B000000001" in text)

    res, _ = _heal_harness(None, build_ok=True)
    check("model failure does not heal", not res.healed)


def test_content_collection_registry():
    """The shape that made allthingsmasonic (429 products) report ZERO.

    Its affiliate.ts deliberately holds no product array — the Astro content
    collection is the registry — so a TS-only parser hard-failed the whole
    site as unmonitored.
    """
    print("registry content collection")
    import json

    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        lib = root / "site" / "src" / "lib"
        lib.mkdir(parents=True)
        # A registry file with the tag and helpers but NO product array.
        (lib / "affiliate.ts").write_text(
            "export const AMAZON_TAG = 'example-20';\n"
            "export function goPath(id: string): string { return `/go/${id}/`; }\n"
        )
        coll = root / "site" / "src" / "content" / "products"
        coll.mkdir(parents=True)
        (coll / "gamma.json").write_text(json.dumps({
            "slug": "gamma", "name": "Gamma Thing", "brand": "GammaCo",
            "asin": "B000000003", "searchQuery": "gamma thing",
            "category": "regalia", "price": "$9.99", "rating": 4.4,
            "image": "/images/products/gamma.webp",
        }, indent=2) + "\n")
        (coll / "delta.json").write_text(json.dumps({
            "slug": "delta", "name": "Delta Thing", "searchQuery": "delta thing",
        }, indent=2) + "\n")

        reg = registry_mod.find_registry(root)
        prods = registry_mod.parse_all(root, reg)
        check("collection entries parsed", len(prods) == 2, f"got {len(prods)}")
        by_id = {p.id: p for p in prods}
        check("keyed on slug", set(by_id) == {"gamma", "delta"})
        gamma = by_id["gamma"]
        check("asin parsed from json", gamma.asin == "B000000003")
        check("json entry counts as a product", gamma.is_product and gamma.is_asin_backed)
        check("entry knows its own file", gamma.source.name == "gamma.json")
        check("has_field sees json keys", registry_mod.has_field(gamma, "price"))
        check("unknown_keys flags absent json key",
              registry_mod.unknown_keys(gamma, {"price": 1, "nope": 2}) == ["nope"])

        # Edits land in the product's own JSON file, still valid JSON.
        target = registry_mod.target_path(gamma, reg)
        check("edit targets the json file", target == gamma.source)
        out = registry_mod.apply_updates(reg, gamma, {"asin": "B000000009", "rating": 4.9, "nope": "x"})
        data = json.loads(out)
        check("asin replaced in json", data["asin"] == "B000000009")
        check("numeric stays numeric", data["rating"] == 4.9)
        check("undeclared key not injected", "nope" not in data)
        check("unrelated field untouched", data["brand"] == "GammaCo")
        check("registry ts left alone", "B000000009" not in (lib / "affiliate.ts").read_text())

        # A cloak generated by [id].astro over the collection must be seen.
        pages = root / "site" / "src" / "pages" / "go"
        pages.mkdir(parents=True)
        (pages / "[id].astro").write_text("---\n// dynamic cloak\n---\n")
        ids, sources = discover.go_ids(root, "/go/", {p.id for p in prods if p.is_product})
        check("dynamic route exposes collection ids", ids == {"gamma", "delta"}, f"got {ids}")
        check("source attributed to the registry", any("affiliate.ts" in s for s in sources))


def test_markdown_frontmatter_collection_registry():
    """The shape that made shoptopless.com (82 products) report ZERO.

    Its collection is Astro's markdown-frontmatter flavor rather than JSON,
    and the ASIN lives under `amazonAsin`, not `asin` — a parser that only
    globs `*.json` and a healer hardcoded to the key `asin` both silently
    treat this site as empty.
    """
    print("registry markdown frontmatter collection")
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        lib = root / "site" / "src" / "lib"
        lib.mkdir(parents=True)
        (lib / "affiliate.ts").write_text(
            "export const AMAZON_TAG = 'example-20';\n"
            "export function goPath(id: string): string { return `/go/${id}/`; }\n"
        )
        coll = root / "site" / "src" / "content" / "products"
        coll.mkdir(parents=True)
        (coll / "epsilon-widget.md").write_text(
            "---\n"
            "name: \"Epsilon Widget\"\n"
            "brand: \"EpsilonCo\"\n"
            "category: gadgets\n"
            "amazonAsin: B000000005\n"
            "price: 24.99\n"
            "featured: false\n"
            "---\n"
            "Body prose that is not part of the frontmatter at all.\n"
        )
        (coll / "zeta-widget.md").write_text(
            "---\nname: \"Zeta Widget\"\nurl: https://www.amazon.com/dp/B000000006?tag=x\n---\n"
        )

        reg = registry_mod.find_registry(root)
        prods = registry_mod.parse_all(root, reg)
        check("markdown entries parsed", len(prods) == 2, f"got {len(prods)}")
        by_id = {p.id: p for p in prods}
        check("keyed on filename stem", set(by_id) == {"epsilon-widget", "zeta-widget"})
        eps = by_id["epsilon-widget"]
        check("asin read from amazonAsin alias", eps.asin == "B000000005")
        check("markdown entry counts as a product", eps.is_product and eps.is_asin_backed)
        check("asin_key records the alias", eps.asin_key == "amazonAsin")
        check("has_field resolves through the alias", registry_mod.has_field(eps, "asin"))
        zeta = by_id["zeta-widget"]
        check("asin recovered from /dp/ url", zeta.asin == "B000000006")
        check("url-recovered asin has no writable key", zeta.asin_key is None)

        # Healing writes under "asin" — must land in `amazonAsin`, not be dropped.
        out = registry_mod.apply_updates(reg, eps, {"asin": "B0NEWNEWNEW", "nope": "x"})
        check("amazonAsin key rewritten via alias", "amazonAsin: B0NEWNEWNEW" in out)
        check("undeclared key not injected", "nope" not in out)
        check("body prose preserved byte-for-byte",
              out.endswith("Body prose that is not part of the frontmatter at all.\n"))
        check("registry ts left alone", "B0NEWNEWNEW" not in (lib / "affiliate.ts").read_text())
        check("unknown_keys flags a field the frontmatter never declared",
              registry_mod.unknown_keys(eps, {"asin": "x", "nope": "y"}) == ["nope"])


def test_collection_field_aliases_heal_correctly():
    """Same silent-no-op class of bug as the ASIN alias, generalised: a
    collection entry can also rename `name` (label/title) or `searchQuery`
    (query/searchTerm/search/q), but heal_product always writes updates back
    under the literal `name`/`searchQuery` keys. Without resolving through
    the alias, those two fields would silently fail to heal while the ASIN
    fix made it look like the whole class of bug was closed.
    """
    print("registry: name/searchQuery aliases heal through, not just asin")
    import json

    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        lib = root / "site" / "src" / "lib"
        lib.mkdir(parents=True)
        (lib / "affiliate.ts").write_text("export const AMAZON_TAG = 'example-20';\n")
        coll = root / "site" / "src" / "content" / "products"
        coll.mkdir(parents=True)
        (coll / "theta.json").write_text(json.dumps({
            "slug": "theta", "label": "Theta Thing", "asin": "B000000007",
            "query": "theta thing",
        }, indent=2) + "\n")
        (coll / "iota.md").write_text(
            "---\ntitle: \"Iota Thing\"\namazonAsin: B000000008\nsearchTerm: iota thing\n---\n"
        )

        reg = registry_mod.find_registry(root)
        prods = registry_mod.parse_all(root, reg)
        by_id = {p.id: p for p in prods}
        theta, iota = by_id["theta"], by_id["iota"]
        check("json: name read through label alias", theta.name == "Theta Thing")
        check("json: field_aliases records it", theta.field_aliases.get("name") == "label")
        check("json: searchQuery read through query alias", theta.search_query == "theta thing")
        check("json: field_aliases records it", theta.field_aliases.get("searchQuery") == "query")
        check("md: name read through title alias", iota.name == "Iota Thing")
        check("md: field_aliases records it", iota.field_aliases.get("name") == "title")
        check("md: searchQuery read through searchTerm alias", iota.search_query == "iota thing")
        check("md: field_aliases records it", iota.field_aliases.get("searchQuery") == "searchTerm")

        out_theta = json.loads(registry_mod.apply_updates(reg, theta, {"name": "New Theta", "searchQuery": "new theta"}))
        check("json: heal lands in label, not a phantom name key",
              out_theta.get("label") == "New Theta" and "name" not in out_theta)
        check("json: heal lands in query, not a phantom searchQuery key",
              out_theta.get("query") == "new theta" and "searchQuery" not in out_theta)

        out_iota = registry_mod.apply_updates(reg, iota, {"name": "New Iota", "searchQuery": "new iota"})
        check("md: heal lands in title, not a phantom name key",
              "title: New Iota" in out_iota and "\nname:" not in out_iota)
        check("md: heal lands in searchTerm, not a phantom searchQuery key",
              "searchTerm: new iota" in out_iota and "\nsearchQuery:" not in out_iota)


def test_unregistered_cloak_is_unverified_not_broken():
    """rc-9 routes /go/ from its worker with no registry file anywhere.

    Every id is then unknown, so "not an Amazon URL" is an assertion nothing
    licensed us to make — but a route that resolves nowhere still is a fault.
    """
    print("cloak: unregistered destinations on a cloak-only site")
    ext = _Resp(302, {"location": "https://partner.example/portal"})
    r = cloak.check(_Client(ext), "https://example.com", "/go/", "p", None, None,
                    registry_known=False)
    check("external destination is healthy-but-unverified", r.ok)
    check("reason says why it could not be verified", "unverified" in r.reason)

    r = cloak.check(_Client(ext), "https://example.com", "/go/", "p", None, None)
    check("the same target still fails when a registry exists", not r.ok)

    r = cloak.check(_Client(_Resp(404, {})), "https://example.com", "/go/", "p", None, None,
                    registry_known=False)
    check("a dead route is still a failure", not r.ok)


def test_tag_detection_ignores_lookalike_strings():
    """`'under-25'` in a price-band union read as the Associates tag once.

    Every one of allthingsmasonic's 429 cloaks then failed with "missing the
    affiliate tag" — a fleet-scale false alarm out of one loose regex.
    """
    print("detect_tag: lookalikes")
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        lib = root / "site" / "src" / "lib"
        lib.mkdir(parents=True)
        bands = lib / "catalog.ts"
        bands.write_text(
            "export function priceBand(p: Product): 'under-25' | '25-50' {\n"
            "  return 'under-25';\n}\n"
        )
        check("a price band is not mistaken for a tag", sentinel._tag_in(bands) is None)

        (lib / "affiliate.ts").write_text("export const AMAZON_TAG = 'example-20';\n")
        check("the real tag is still found",
              sentinel.detect_tag(root, bands) == "example-20")

        # The loose fallback stays available where the file really is about
        # Amazon links but spells the constant differently.
        odd = lib / "links.ts"
        odd.write_text("const T = 'other-20';\nconst u = `https://www.amazon.com/dp/X?tag=${T}`;\n")
        check("loose fallback still works in an Amazon-link file",
              sentinel._tag_in(odd) == "other-20")


def test_a_run_that_checks_nothing_exits_5():
    """The last shape that could still look green.

    A site whose registry parses but has no ASINs and no `/go/` routes probes
    nothing and verifies nothing, and used to exit 0 into a clean sweep line.
    """
    print("sentinel: vacuous run")
    with tempfile.TemporaryDirectory() as d:
        root = Path(d) / "example.com"
        (root / "ops").mkdir(parents=True)
        lib = root / "site" / "src" / "lib"
        lib.mkdir(parents=True)
        (lib / "affiliate.ts").write_text(
            "export const AMAZON_TAG = 'example-20';\n"
            "export const PRODUCTS = [\n"
            "  { id: 'alpha', name: 'Alpha', searchQuery: 'alpha thing' },\n"
            "];\n"
        )
        argv = sys.argv
        sys.argv = ["sentinel.py", "--site-root", str(root), "--dry-run", "--no-heal"]
        try:
            rc = sentinel.main()
        finally:
            sys.argv = argv
        check("exits 5, not 0", rc == 5, f"got {rc}")

        log = (root / "ops" / "logs").glob("affiliate-sentinel-*.log")
        text = "\n".join(f.read_text() for f in log)
        check("says it checked nothing", "checked NOTHING" in text)
        check("names the site as unmonitored", "UNMONITORED" in text)
        check("says why", "no /go/ routes were discovered" in text)


def main() -> int:
    for fn in (
        test_registry_parse,
        test_content_collection_registry,
        test_markdown_frontmatter_collection_registry,
        test_collection_field_aliases_heal_correctly,
        test_registry_double_quotes_and_non_products,
        test_registry_field_aliases,
        test_find_registry_locates_non_standard_paths,
        test_partner_cloak_is_not_flagged,
        test_unregistered_cloak_is_unverified_not_broken,
        test_tag_detection_ignores_lookalike_strings,
        test_has_cloak,
        test_registry_apply_updates,
        test_registry_stale_guard,
        test_discover_unions_sources,
        test_cloak_classification,
        test_state_streaks,
        test_a_run_that_checks_nothing_exits_5,
        test_redirects_rewrite_is_precise,
        test_heal_validation_and_revert,
    ):
        fn()
    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
