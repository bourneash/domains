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

import re
from dataclasses import dataclass, field
from pathlib import Path

# A TS string value in either quote style, allowing escaped quotes.
# Both are in active use across the fleet — 0xroulette's registry is entirely
# double-quoted, and a single-quote-only pattern silently parsed it as ZERO
# products: no error, no warning, just a site that looked like it had nothing
# to check while amz-stats was reporting 13 live ASINs for it.
_STR = r"""(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")"""

_ID_RE = re.compile(r"\bid:\s*" + _STR)


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
    fields: dict[str, str] = field(default_factory=dict)

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
        return bool(self.asin or self.search_query or self.image)

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


def _scalar(obj_text: str, key: str) -> str | None:
    m = re.search(rf"\b{re.escape(key)}:\s*" + _STR, obj_text)
    return _first_group(m) if m else None


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
        # An interface/type declaration (`id: string;`) also contains `id:` but
        # no string literal, so _scalar returns None and the block is skipped —
        # which is what keeps type blocks out of the product list.
        pid = _scalar(obj, "id")
        if not pid:
            continue
        products.append(
            Product(
                id=pid,
                start=start,
                end=end,
                text=obj,
                asin=_scalar(obj, "asin"),
                name=_scalar(obj, "name"),
                brand=_scalar(obj, "brand"),
                category=_scalar(obj, "category"),
                search_query=_scalar(obj, "searchQuery"),
                image=_scalar(obj, "image"),
            )
        )

    products.sort(key=lambda p: p.start)
    return products


def _ts_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _render(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_render(v) for v in value) + "]"
    return _ts_string(str(value))


def apply_updates(registry_path: Path, product: Product, updates: dict) -> str:
    """Rewrite `key: value` pairs inside one product literal; return new file text.

    Only keys already present in the literal are rewritten — a replacement
    must not invent registry fields that this site's TypeScript type does not
    declare, or the build gate fails on something the sentinel itself caused.
    Unknown keys are reported by the caller rather than silently dropped.

    Does not write to disk; the caller writes only after the build gate passes,
    so a failed heal leaves the working tree untouched.
    """
    text = registry_path.read_text(encoding="utf-8")
    if text[product.start : product.end] != product.text:
        raise ValueError(
            "registry changed on disk since it was parsed — refusing to edit "
            "(re-run the sentinel)"
        )

    obj = product.text
    for key, value in updates.items():
        pattern = re.compile(
            rf"(\b{re.escape(key)}:\s*)(?:" + _STR + r"|\[[^\]]*\]|[^,\n]+)(?=\s*,|\s*\n\s*\})"
        )
        if not pattern.search(obj):
            continue
        obj = pattern.sub(lambda m: m.group(1) + _render(value), obj, count=1)

    return text[: product.start] + obj + text[product.end :]


def unknown_keys(product: Product, updates: dict) -> list[str]:
    """Keys in `updates` that the literal does not already declare."""
    return [
        k
        for k in updates
        if not re.search(rf"\b{re.escape(k)}:\s*", product.text)
    ]
