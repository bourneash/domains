"""Dynamic `/go/<id>` cloak discovery — no per-site list, no central tracking.

Three independent sources exist across the fleet and none of them is
universal, so all three are read and **unioned** rather than tried in
first-hit order:

  1. `site/public/_redirects` — the original Cloudflare `_redirects` cloak.
  2. `site/src/pages/go/<id>.astro` — the static interstitial several sites
     migrated to, because `_redirects`-based `/go/` 404s on Workers (a known
     fleet gotcha).
  3. the product registry itself — the only complete list on sites where the
     cloak is generated at build time from `affiliate.ts`.

The predecessor script used first-hit order, which silently under-checked any
site midway through the `_redirects` -> interstitial migration: it would find
a stale `_redirects`, report "12/12 healthy", and never look at the 20 live
interstitial routes. Unioning is what makes "links added later are picked up
automatically" actually true.
"""
from __future__ import annotations

import re
from pathlib import Path


def _from_redirects(site_root: Path, go_prefix: str) -> set[str]:
    path = site_root / "site" / "public" / "_redirects"
    if not path.is_file():
        return set()
    ids: set[str] = set()
    prefix = go_prefix.rstrip("/")
    pattern = re.compile(rf"^{re.escape(prefix)}/([^\s/*]+)")
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = pattern.match(line)
        if m:
            ids.add(m.group(1))
    return ids


def _from_pages(site_root: Path, go_prefix: str) -> set[str]:
    d = site_root / "site" / "src" / "pages" / go_prefix.strip("/")
    if not d.is_dir():
        return set()
    ids: set[str] = set()
    for f in d.iterdir():
        if f.suffix not in {".astro", ".md", ".ts", ".mdx"}:
            continue
        stem = f.stem
        # `[id].astro` is the dynamic catch-all that renders every cloak from
        # the registry — it is a route template, not a product.
        if stem.startswith("[") or stem == "index":
            continue
        ids.add(stem)
    return ids


def detect_go_prefix(site_root: Path) -> str:
    """Return the site's cloak prefix, defaulting to the fleet standard `/go/`.

    Only overridden when a site has no `/go/` anywhere but does have exactly
    one plausible alternative directory under `src/pages`.
    """
    pages = site_root / "site" / "src" / "pages"
    if (pages / "go").is_dir():
        return "/go/"
    redirects = site_root / "site" / "public" / "_redirects"
    if redirects.is_file():
        text = redirects.read_text(encoding="utf-8", errors="replace")
        m = re.search(r"^(/[a-z0-9-]+)/[^\s/*]+\s+https?://(?:www\.)?amazon\.", text, re.M)
        if m:
            return m.group(1) + "/"
    return "/go/"


def has_cloak(site_root: Path, go_prefix: str) -> bool:
    """Does this site route `/go/<id>` at all?

    Not every site cloaks. Some link straight to Amazon from a helper, so their
    registry ids are product keys, not routes — feeding those to the cloak
    check invents URLs that were never supposed to exist and reports the
    resulting 404s as breakage (0xroulette, a Vite SPA with no cloak, produced
    13 such phantom failures).

    A `[id]` dynamic route counts: it is exactly how the sites that generate
    their cloak from the registry at build time expose every product id.
    """
    if _from_redirects(site_root, go_prefix):
        return True
    d = site_root / "site" / "src" / "pages" / go_prefix.strip("/")
    if d.is_dir() and any(d.iterdir()):
        return True
    return False


def go_ids(site_root: Path, go_prefix: str, registry_ids: set[str]) -> tuple[set[str], list[str]]:
    """Union of every cloak id this site exposes, plus which sources supplied them."""
    sources: list[str] = []
    ids: set[str] = set()

    from_redirects = _from_redirects(site_root, go_prefix)
    from_pages = _from_pages(site_root, go_prefix)
    # Registry ids are routes only where a cloak actually exists.
    from_registry = set(registry_ids) if has_cloak(site_root, go_prefix) else set()

    for label, found in (
        ("_redirects", from_redirects),
        (f"src/pages{go_prefix}", from_pages),
        ("affiliate.ts", from_registry),
    ):
        if found:
            sources.append(f"{label}({len(found)})")
            ids |= found

    return ids, sources
