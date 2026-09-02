"""Parse and surgically edit a site's `site/src/lib/affiliate.ts` product registry.

The registry is the one path that is genuinely consistent across the whole
portfolio, so it is the sentinel's anchor: every product id, ASIN, and the
metadata needed to source a replacement come from here. Nothing is tracked
centrally — add a product to the registry and the next sentinel run picks it
up with no configuration anywhere.

Two shapes exist in the fleet and both must work:

  * **ASIN registries** — entries carry `asin: 'B0...'`. These can rot (Amazon
    de-lists the SKU) and are what the API check is for.
  * **Search-URL registries** — entries carry only `searchQuery`, and the site
    links to `/s?k=...`. These are rot-proof by construction (a search never
    404s), so there is nothing for the API to check; only their `/go/` cloak
    is verified. Roughly a third of the fleet is deliberately built this way.

Editing is deliberately *surgical* — we rewrite individual `key: value` lines
inside one object literal and never re-serialise the file. These registries
carry hand-written comments, provenance notes, and per-site helper functions
that a parse/re-emit round-trip would destroy.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

# A TS string value in either quote style, allowing escaped quotes.
# Both are in active use across the fleet — 0xroulette's registry is entirely
# double-quoted, and a single-quote-only pattern silently parsed it as ZERO
# products: no error, no warning, just a site that looked like it had nothing
# to check while amz-stats was reporting 13 live ASINs for it.
_STR = r"""(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")"""

# Field names are NOT uniform across the fleet — these registries were written
# by hand over months. Every alias below is in live use:
#   id      | slug                      (oventoheaven keys on slug)
#   asin    | searchOrAsin | url        (rodhat overloads one field for both;
#                                        oventoheaven only stores a full URL)
#   name    | label | title
#   image   | imageUrl
# Assuming the reviewtattoo shape made two sites parse to zero products while
# their /go/ cloaks were live, so the parser matches on meaning, not on one
# spelling.
_ID_KEYS = ("id", "slug")
# searchQuery | query | q  (fishhooklabs' catalog names the Amazon search
# phrase `q`; keyed off `searchQuery` only, all 101 of its entries looked like
# non-products and the whole site parsed to zero).
_QUERY_KEYS = ("searchQuery", "query", "searchTerm", "search", "q")
_NAME_KEYS = ("name", "label", "title")
_IMAGE_KEYS = ("image", "imageUrl")
_ASIN_RE = re.compile(r"^[A-Z0-9]{10}$")
_DP_RE = re.compile(r"/dp/([A-Z0-9]{10})")

# `\"?` before the colon makes this tolerate quoted JSON keys (`"id": "..."`)
# as well as bare TS ones (`id: '...'`) — broadwayshowgirls keeps its whole
# catalog as a JSON array (`ops/affiliate/products.json`) imported into
# affiliate.ts rather than a TS object literal, and the unquoted-only pattern
# silently parsed it to zero products with no error.
_ID_RE = re.compile(r"\b(?:" + "|".join(_ID_KEYS) + r")\"?:\s*" + _STR)


def _first_group(m: re.Match) -> str | None:
    """Return whichever quote-style alternative actually matched."""
    for g in m.groups():
        if g is not None:
            return g
    return None


@dataclass
class Product:
    """One entry in the registry, plus the byte span it occupies in the file."""

    id: str
    start: int  # index of the opening `{` of the object literal
    end: int  # index just past the matching `}`
    text: str  # the raw object literal source
    asin: str | None = None
    name: str | None = None
    brand: str | None = None
    category: str | None = None
    search_query: str | None = None
    image: str | None = None
    url: str | None = None
    fields: dict[str, str] = field(default_factory=dict)
    # Set only for collection-backed products: the decoded contents of the JSON
    # file this entry IS. TS-literal entries leave it None and are addressed by
    # (start, end) inside their `source` file instead.
    data: dict | None = None
    # The actual key `self.asin` was read from in `data` (e.g. shoptopless's
    # `amazonAsin`). `apply_updates` always receives a healed value under the
    # literal key "asin" — without this, writing it back would look for an
    # "asin" key that isn't there, `if key in data` would be False, and a
    # heal would silently no-op: the dead ASIN stays live on the page while
    # the run reports success.
    asin_key: str | None = None
    # The TS file this literal lives in. A registry can be split across
    # several files (fishhooklabs' catalog is terminal/platform/field), so the
    # file to edit is a property of the product, not of the run.
    source: Path | None = None
    # True when this literal encloses other parsed entries — a painting that
    # owns three buy-links, not a fourth buy-link.
    is_container: bool = False

    @property
    def is_asin_backed(self) -> bool:
        return bool(self.asin)

    @property
    def is_product(self) -> bool:
        """Distinguish a product from a non-product object that also has an `id`.

        Registries commonly declare sibling collections in the same file —
        0xroulette's `SHELVES` (id/title/tagline) sit next to its `Book`
        entries. Treating a shelf as a product invented four `/go/` links that
        were never meant to exist and reported them as broken.
        """
        if self.is_container:
            # A container's own fields (a title, a hero image) look exactly
            # like a product's, so shape alone cannot tell them apart. It owns
            # the real entries; cloaking it invents a /go/ route that no site
            # ever generated (arttogogh's 24 paintings, each wrapping three
            # actual buy-links).
            return False
        return bool(self.asin or self.search_query or self.image or self.url)

    def search_seed(self) -> str:
        """Best available keyword string for sourcing a replacement.

        `searchQuery` is what the site author already chose as the canonical
        way to describe this product, so it wins. Falling back to
        brand + name would re-search for the exact dead SKU, which is
        pointless, so brand is dropped from the fallback and only the
        generic product name + category are used.
        """
        if self.search_query:
            return self.search_query
        parts = [p for p in (self.name, self.category) if p]
        return " ".join(parts) if parts else self.id.replace("-", " ")


def _own_text(obj_text: str) -> str:
    """The literal's own key/value lines, with nested objects and arrays cut out.

    Entries nest: fishhooklabs items carry a `hook: {...}` spec, arttogogh's
    paintings carry an `orders: [{ id, search }, ...]` list. A flat regex over
    the whole span reads the FIRST nested `id:` as the entry's own id, which
    made every arttogogh painting masquerade as its first order — right id
    shape, wrong entry, and the other two orders per painting never checked.
    """
    out: list[str] = []
    depth = 0
    quote: str | None = None
    i = 0
    n = len(obj_text)
    while i < n:
        ch = obj_text[i]
        if quote:
            if ch == "\\":
                if depth <= 1:
                    out.append(obj_text[i : i + 2])
                i += 2
                continue
            if ch == quote:
                quote = None
            if depth <= 1:
                out.append(ch)
            i += 1
            continue
        if ch in "'\"`":
            quote = ch
            if depth <= 1:
                out.append(ch)
        elif ch in "{[":
            depth += 1
            if depth <= 1:
                out.append(ch)
        elif ch in "}]":
            if depth <= 1:
                out.append(ch)
            depth -= 1
        elif depth <= 1:
            out.append(ch)
        i += 1
    return "".join(out)


def _scalar(obj_text: str, key: str) -> str | None:
    # `\"?` tolerates a quoted JSON key (`"asin": "..."`) as well as a bare TS
    # one (`asin: '...'`) — see the note on `_ID_RE`.
    m = re.search(rf"\b{re.escape(key)}\"?:\s*" + _STR, obj_text)
    return _first_group(m) if m else None


def _first_of(obj_text: str, keys: tuple[str, ...]) -> str | None:
    for k in keys:
        v = _scalar(obj_text, k)
        if v:
            return v
    return None


def _match_brace(text: str, open_idx: int) -> int:
    """Return the index just past the `}` matching the `{` at `open_idx`.

    String-aware so a brace inside a blurb (`"a { of sorts"`) does not throw
    the depth count off. Template literals are treated as strings too.
    """
    depth = 0
    i = open_idx
    n = len(text)
    quote: str | None = None
    while i < n:
        ch = text[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in "'\"`":
            quote = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise ValueError(f"unbalanced braces starting at offset {open_idx}")


# Ordered by how canonical the location is. `lib/affiliate.ts` is the fleet
# standard (23 of 25 sites), but two sites keep theirs under `data/` — and a
# hardcoded path meant the sentinel silently reported "no registry, nothing to
# check" for them while their /go/ cloaks were live and unmonitored. Searching
# rather than assuming is the same principle as everything else here: discover
# it from the site, don't keep a list.
_REGISTRY_GLOBS = (
    "site/src/lib/affiliate.ts",
    "site/src/data/affiliate.ts",
    "site/src/data/affiliates.ts",
    "site/src/lib/affiliate*.ts",
    "site/src/data/affiliate*.ts",
    "site/src/**/affiliate*.ts",
    # Some sites call the product registry a catalog and split it across a
    # directory of files by section. Nothing about the sentinel needs it to be
    # one file — only that every product is seen.
    "site/src/data/catalog.ts",
    "site/src/data/catalog/*.ts",
    "site/src/**/catalog*.ts",
    "site/src/**/catalog/*.ts",
    # broadwayshowgirls keeps its whole catalog as one JSON array under `ops/`
    # (its per-writer picks are ops-owned data, imported into the site via
    # `with { type: 'json' }`), rather than a TS literal or a per-product
    # collection dir. `parse()` handles JSON text fine (see `_ID_RE`) — it
    # just needs to be found.
    # A single JSON or TS array under `data/`, which is neither a hand-written
    # `affiliate.ts` nor a one-file-per-product collection directory
    # (seedstosauce keeps 67 products in data/products.json; shoppinkflamingo
    # keeps 10 in data/products.ts). Both sites alerted as UNMONITORED nightly
    # because the globs only ever looked for the word "affiliate".
    "site/src/data/products.ts",
    "site/src/data/products.json",
    "site/src/data/catalog.json",
    "site/src/lib/products.ts",
    "ops/affiliate/products.json",
    "ops/affiliate/*.json",
)

# Test files sit right next to the real thing and parse to zero products, but
# there is no reason to even open them.
_NOT_A_REGISTRY = (".test.", ".spec.", "__tests__", "/node_modules/", "/.claude/")


def _registry_candidates(site_root: Path) -> list[Path]:
    seen: list[Path] = []
    for pattern in _REGISTRY_GLOBS:
        for candidate in sorted(site_root.glob(pattern)):
            if not candidate.is_file():
                continue
            posix = candidate.as_posix()
            if any(bad in posix for bad in _NOT_A_REGISTRY):
                continue
            if candidate not in seen:
                seen.append(candidate)
    return seen


def find_registries(site_root: Path) -> list[Path]:
    """Every file that makes up this site's registry, in canonical order.

    A registry is not always one file. fishhooklabs splits its catalog across
    `data/catalog/{terminal,platform,field}.ts` behind a barrel `index.ts`
    that only re-exports; picking the single best-scoring file would have
    monitored a third of that site and reported it as the whole thing.

    Files are grouped by directory and the highest-scoring directory wins, so
    a stray helper next to the real registry still loses, and the barrel file
    (zero products) is dropped for free.
    """
    by_dir: dict[Path, list[tuple[Path, int]]] = {}
    for candidate in _registry_candidates(site_root):
        try:
            n = len(parse(candidate))
        except (OSError, UnicodeDecodeError):
            continue
        if n:
            by_dir.setdefault(candidate.parent, []).append((candidate, n))
    if not by_dir:
        return []
    # First directory wins ties, preserving the canonical-path ordering above.
    best_dir = max(by_dir, key=lambda d: sum(n for _f, n in by_dir[d]))
    return [f for f, _n in by_dir[best_dir]]


def find_registry(site_root: Path) -> Path | None:
    """The single most canonical registry file — the one that carries the tag.

    Prefer `find_registries` for anything that needs every product.
    """
    files = find_registries(site_root)
    if files:
        return files[0]
    # Nothing parsed, but a registry file may still exist (an all-computed
    # registry). Returning it is what makes the "exists but parsed to ZERO"
    # alarm fire instead of a silent "no registry, nothing to check".
    candidates = _registry_candidates(site_root)
    return candidates[0] if candidates else None


# Sites past a few dozen products stop keeping a TS array at all: the catalog
# becomes an Astro content collection, one JSON file per product, and
# `affiliate.ts` keeps only the tag + helpers (allthingsmasonic has 429 of
# these and its affiliate.ts documents, at length, why the array is absent).
# The parser used to read only the TS file, find no array, and hard-fail the
# whole site as "parsed to ZERO products" — i.e. the largest catalog in the
# fleet went completely unmonitored while looking like a parser bug.
_COLLECTION_GLOBS = (
    "site/src/content/products",
    "site/src/content/product",
    "site/src/data/products",
)

# shoptopless.com's shape: same one-file-per-product collection, but each file
# is markdown with YAML frontmatter (Astro's other native content-collection
# format) instead of JSON. `amazonAsin` and `hero` are the fleet-specific
# aliases this site uses; see tools/affiliate-link-check/check_links.py's
# `parse_products_frontmatter_dir`, which already had to solve this same shape
# for the same site.
_MD_FRONTMATTER_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?", re.DOTALL)
_MD_ASIN_KEYS = ("amazonAsin", "asin")
_MD_IMAGE_KEYS = ("hero", *_IMAGE_KEYS)


def _product_from_markdown(path: Path) -> Product | None:
    raw = path.read_text(encoding="utf-8", errors="ignore")
    m = _MD_FRONTMATTER_RE.match(raw)
    if not m:
        return None
    try:
        data = yaml.safe_load(m.group(1))
    except yaml.YAMLError:
        return None
    if not isinstance(data, dict):
        return None

    def pick(keys: tuple[str, ...]) -> str | None:
        for k in keys:
            v = data.get(k)
            if isinstance(v, str) and v:
                return v
        return None

    asin_key = next((k for k in _MD_ASIN_KEYS if isinstance(data.get(k), str) and data[k]), None)
    asin = data.get(asin_key) if asin_key else None
    url = pick(("url",))
    if not asin and url:
        m_dp = _DP_RE.search(url)
        if m_dp:
            asin = m_dp.group(1)
            asin_key = None  # recovered from `url`, not a dedicated field

    return Product(
        id=path.stem,
        # Same as a JSON collection entry: the whole file is the span, and
        # `data` (not this text) is what edits are made against.
        start=0,
        end=len(raw),
        text=raw,
        asin=asin,
        name=pick(_NAME_KEYS),
        brand=pick(("brand",)),
        category=pick(("category",)),
        search_query=pick(_QUERY_KEYS),
        image=pick(_MD_IMAGE_KEYS),
        url=url,
        source=path,
        data=data,
        asin_key=asin_key,
    )


def _product_from_json(path: Path) -> Product | None:
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None

    def pick(keys: tuple[str, ...]) -> str | None:
        for k in keys:
            v = data.get(k)
            if isinstance(v, str) and v:
                return v
        return None

    pid = pick(_ID_KEYS) or path.stem
    url = pick(("url",))
    combo = pick(("searchOrAsin",))
    asin = pick(("asin",))
    # Only a literal `asin` key is writable by `apply_updates`; an ASIN
    # recovered from `searchOrAsin` or a `/dp/` URL below has no dedicated
    # field to heal into, so `asin_key` stays unset for those.
    asin_key = "asin" if asin else None
    if not asin and combo and _ASIN_RE.match(combo):
        asin = combo
    if not asin and url:
        m_dp = _DP_RE.search(url)
        if m_dp:
            asin = m_dp.group(1)
    search_query = pick(("searchQuery", "query"))
    if not search_query and combo and not _ASIN_RE.match(combo):
        search_query = combo

    return Product(
        id=pid,
        # A collection entry IS its file, so the whole file is the span. That
        # keeps the same "did it change under us?" check working for edits.
        start=0,
        end=len(raw),
        text=raw,
        asin=asin,
        name=pick(_NAME_KEYS),
        brand=pick(("brand",)),
        category=pick(("category",)),
        search_query=search_query,
        image=pick(_IMAGE_KEYS),
        url=url,
        source=path,
        data=data,
        asin_key=asin_key,
    )


def find_collection(site_root: Path) -> Path | None:
    """The per-product JSON or markdown-frontmatter collection directory, if
    this site uses one."""
    for rel in _COLLECTION_GLOBS:
        d = site_root / rel
        if d.is_dir() and (any(d.glob("*.json")) or any(d.glob("*.md"))):
            return d
    return None


def parse_collection(collection_dir: Path) -> list[Product]:
    products = [_product_from_json(f) for f in sorted(collection_dir.glob("*.json"))]
    products += [_product_from_markdown(f) for f in sorted(collection_dir.glob("*.md"))]
    return [p for p in products if p is not None]


def parse_all(site_root: Path, registry_path: Path | None) -> list[Product]:
    """Every product this site declares, from both registry shapes.

    Unioned rather than first-hit for the same reason cloak discovery is: a
    site can legitimately carry a handful of hand-written TS entries *and* a
    generated collection, and checking only whichever was found first
    under-monitors the rest. Collection entries win id collisions — the
    collection is the generated source of truth on the sites that have one.
    """
    files = find_registries(site_root)
    if registry_path and registry_path not in files:
        files = [registry_path, *files]
    products: list[Product] = []
    for f in files:
        products.extend(parse(f))
    collection_dir = find_collection(site_root)
    if collection_dir:
        from_ts = {p.id: p for p in products}
        for p in parse_collection(collection_dir):
            from_ts.pop(p.id, None)
            products.append(p)
        products = [p for p in products if p.data is not None or from_ts.get(p.id) is p]
    return products


def parse(registry_path: Path) -> list[Product]:
    """Extract every product object literal that carries an `id:` field.

    Deliberately structural rather than a full TS parse: find each `id:`, walk
    back to the object literal that contains it, brace-match forward. That
    survives the wide formatting variation across ~23 hand-maintained
    registries without needing a TS toolchain in the container.
    """
    text = registry_path.read_text(encoding="utf-8")
    products: list[Product] = []
    seen_spans: set[tuple[int, int]] = set()

    for m in _ID_RE.finditer(text):
        # Walk back to the nearest unmatched `{` — the start of this literal.
        depth = 0
        start = -1
        for i in range(m.start(), -1, -1):
            ch = text[i]
            if ch == "}":
                depth += 1
            elif ch == "{":
                if depth == 0:
                    start = i
                    break
                depth -= 1
        if start < 0:
            continue
        try:
            end = _match_brace(text, start)
        except ValueError:
            continue
        if (start, end) in seen_spans:
            continue
        seen_spans.add((start, end))

        obj = text[start:end]
        own = _own_text(obj)
        # An interface/type declaration (`id: string;`) also contains `id:` but
        # no string literal, so _scalar returns None and the block is skipped —
        # which is what keeps type blocks out of the product list.
        pid = _first_of(own, _ID_KEYS)
        if not pid:
            continue
        url = _scalar(own, "url")
        # searchOrAsin is one field doing two jobs: an ASIN if it looks like
        # one, otherwise a search phrase. A URL can also carry the ASIN.
        combo = _scalar(own, "searchOrAsin")
        asin = _scalar(own, "asin")
        if not asin and combo and _ASIN_RE.match(combo):
            asin = combo
        if not asin and url:
            m_dp = _DP_RE.search(url)
            if m_dp:
                asin = m_dp.group(1)

        search_query = _first_of(own, _QUERY_KEYS)
        if not search_query and combo and not _ASIN_RE.match(combo):
            search_query = combo

        products.append(
            Product(
                id=pid,
                start=start,
                end=end,
                text=obj,
                asin=asin,
                name=_first_of(own, _NAME_KEYS),
                brand=_scalar(own, "brand"),
                category=_scalar(own, "category"),
                search_query=search_query,
                image=_first_of(own, _IMAGE_KEYS),
                url=url,
                source=registry_path,
            )
        )

    products.sort(key=lambda p: p.start)
    for i, outer in enumerate(products):
        outer.is_container = any(
            inner.start > outer.start and inner.end <= outer.end
            for inner in products[i + 1 :]
            if inner.start < outer.end
        )
    return products


def _ts_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _render(value, json_mode: bool = False) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_render(v, json_mode) for v in value) + "]"
    if json_mode:
        # A JSON-array registry (broadwayshowgirls' `products.json`) still
        # goes through this text-surgical path, not the dict-based one below —
        # it is one file holding *many* products, so `product.data` covers
        # only the single-file-per-product collection shape. Emitting a
        # single-quoted TS string here would break the file as JSON.
        return json.dumps(str(value), ensure_ascii=False)
    return _ts_string(str(value))


def target_path(product: Product, registry_path: Path) -> Path:
    """The file an edit to this product actually lands in."""
    return product.source or registry_path


def apply_updates(registry_path: Path, product: Product, updates: dict) -> str:
    """Rewrite `key: value` pairs for one product; return the new text of the
    file that entry lives in (`target_path`, which is the product's own JSON
    file for collection-backed entries, not the registry).

    Only keys already present in the literal are rewritten — a replacement
    must not invent registry fields that this site's TypeScript type does not
    declare, or the build gate fails on something the sentinel itself caused.
    Unknown keys are reported by the caller rather than silently dropped.

    Does not write to disk; the caller writes only after the build gate passes,
    so a failed heal leaves the working tree untouched.
    """
    target = target_path(product, registry_path)
    text = target.read_text(encoding="utf-8")
    if text[product.start : product.end] != product.text:
        raise ValueError(
            "registry changed on disk since it was parsed — refusing to edit "
            "(re-run the sentinel)"
        )

    # A collection entry is JSON, not a TS literal: rewriting it as text would
    # emit `price: '$9.99'` into a .json file and break the content-collection
    # schema at build time. Edit the decoded object and re-serialise instead —
    # there are no hand-written comments in a generated JSON file to preserve,
    # which is the only reason the TS path is surgical.
    if product.data is not None:
        data = dict(product.data)
        for key, value in updates.items():
            key = _resolve_key(product, key)
            if key in data:
                data[key] = value
        if target.suffix == ".md":
            # A frontmatter entry's body (prose below the `---` fence) has no
            # equivalent in `data` — re-serialising just the YAML and keeping
            # the original body byte-for-byte is what keeps this surgical, the
            # same guarantee the TS path gets from never re-emitting the file.
            m = _MD_FRONTMATTER_RE.match(text)
            body = text[m.end() :] if m else ""
            frontmatter = yaml.safe_dump(
                data, default_flow_style=False, sort_keys=False, allow_unicode=True
            )
            return f"---\n{frontmatter}---\n{body}"
        trailing = "\n" if text.endswith("\n") else ""
        return json.dumps(data, indent=2, ensure_ascii=False) + trailing

    json_mode = target.suffix == ".json"
    obj = product.text
    for key, value in updates.items():
        pattern = re.compile(
            rf"(\b{re.escape(key)}\"?:\s*)(?:" + _STR + r"|\[[^\]]*\]|[^,\n]+)(?=\s*,|\s*\n\s*\})"
        )
        if not pattern.search(obj):
            continue
        obj = pattern.sub(lambda m: m.group(1) + _render(value, json_mode), obj, count=1)

    return text[: product.start] + obj + text[product.end :]


def _resolve_key(product: Product, key: str) -> str:
    """Translate a heal's field name to the key it's actually stored under.

    `heal_product` always builds `updates` with the literal key "asin" — the
    one name every TS registry shape uses. A collection entry can store it
    under something else (shoptopless's `amazonAsin`); without this, `key in
    data` is False and the write silently no-ops, leaving the dead ASIN live
    on the page while the run reports success.
    """
    if key == "asin" and product.asin_key:
        return product.asin_key
    return key


def has_field(product: Product, key: str) -> bool:
    """Does this entry already declare `key`?

    Shape-agnostic on purpose: a JSON collection entry writes `"price": 9.99`,
    which the TS-shaped `\bprice:` probe never matches, so asking the text
    directly would report every field as absent and silently skip every edit.
    """
    if product.data is not None:
        return _resolve_key(product, key) in product.data
    return bool(re.search(rf"\b{re.escape(key)}\"?:\s*", product.text))


def unknown_keys(product: Product, updates: dict) -> list[str]:
    """Keys in `updates` that the entry does not already declare."""
    return [k for k in updates if not has_field(product, k)]
