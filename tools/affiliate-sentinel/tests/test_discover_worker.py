"""Cloak routes that live in the Worker rather than in a file the crawler reads.

weapontester.com keeps `public/_redirects` deliberately EMPTY — the
static-assets binding would otherwise intercept `/go/*` and serve stale
targets before the worker runs — and routes all 31 links from a map inside
`site/worker/index.js`. Neither file-based source saw them, so the sentinel
reported "0 cloaks OK": the shape of green that means nothing was checked.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import discover  # noqa: E402


def _write(root: Path, rel: str, text: str) -> Path:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


WORKER = """
// /go/<id> affiliate redirect (302), handled here and not in _redirects.
function buildAffiliateRedirects(tag) {
  const dp = asin => `https://www.amazon.com/dp/${asin}?tag=${tag}`;
  return {
    'vortex-strike-eagle': dp('B0CPW7P78R'),
    'tikka-t3x': 'https://www.tikka.fi/rifles/t3x/t3x-lite',
  };
}

export default {
  async fetch(request, env) {
    if (url.pathname.startsWith('/go/')) {
      const target = buildAffiliateRedirects(env.AMAZON_TAG)[id];
    }
  },
};
"""


def test_worker_routed_cloaks_are_discovered(tmp_path: Path):
    site = tmp_path / "weapontester.com"
    _write(site, "site/worker/index.js", WORKER)
    _write(site, "site/public/_redirects", "# intentionally empty\n")

    assert discover.has_cloak(site, "/go/")
    ids, sources = discover.go_ids(site, "/go/", registry_ids=set())
    assert ids == {"vortex-strike-eagle", "tikka-t3x"}
    assert any(s.startswith("worker(") for s in sources)


def test_worker_that_builds_its_map_from_the_registry_still_counts(tmp_path: Path):
    """trainingsharks: `new Map(PRODUCTS.map(...))` — the registry IS the routes.

    The worker lists no ids of its own, so id extraction finds nothing; the
    site still routes the prefix, and dropping it lost all seven live cloaks.
    """
    site = tmp_path / "trainingsharks.com"
    _write(
        site,
        "site/src/worker/index.ts",
        """
const GO: Map<string, string> = new Map(PRODUCTS.map(p => [p.id, amazonUrl(p.asin)]));
if (url.pathname.startsWith('/go/')) { const dest = GO.get(id); }
""",
    )
    assert discover.has_cloak(site, "/go/")
    ids, sources = discover.go_ids(site, "/go/", registry_ids={"a", "b"})
    assert ids == {"a", "b"}


def test_a_worker_that_does_not_route_the_prefix_donates_nothing(tmp_path: Path):
    site = tmp_path / "plain.com"
    _write(
        site,
        "site/worker/index.js",
        "const HEADERS = { 'content-security-policy': \"default-src 'self'\" };\n",
    )
    assert not discover.has_cloak(site, "/go/")
    assert discover.go_ids(site, "/go/", registry_ids={"a"}) == (set(), [])
