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


def main() -> int:
    for fn in (
        test_registry_parse,
        test_registry_double_quotes_and_non_products,
        test_has_cloak,
        test_registry_apply_updates,
        test_registry_stale_guard,
        test_discover_unions_sources,
        test_cloak_classification,
        test_state_streaks,
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
