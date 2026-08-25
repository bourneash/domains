"""Verify each `/go/<id>` cloak on the LIVE site resolves to the right Amazon URL.

This is the half the Amazon API fundamentally cannot answer: whether *our own*
redirect works. It is also where the fleet's worst affiliate bug lived —
`_redirects`-based `/go/` silently 404s on Cloudflare Workers, so every
affiliate link on a site could be dead while every ASIN behind them was
perfectly healthy.

Critically, this never fetches amazon.com. The old curl sweep followed the
redirect all the way to Amazon and grepped the landed HTML for soft-404
markers, which meant Amazon's anti-bot wall produced a large permanent class
of "inconclusive" results that no one could act on. Product liveness is now
the API's job; this check stops at the redirect target and is therefore
deterministic — no captchas, no soft-404 string matching, no false positives.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import httpx

_UA = "Mozilla/5.0 (compatible; affiliate-sentinel/1.0; +fleet-ops)"

# The interstitial pattern: a static page that bounces via meta-refresh and/or
# a JS location assignment. Both are matched because sites differ in which
# they emit, and some emit only one with the other as a plain <a> fallback.
_META_REFRESH_RE = re.compile(
    r"""<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*?url=([^"'\s>]+)""",
    re.I,
)
_JS_LOCATION_RE = re.compile(
    r"""(?:location(?:\.href)?\s*=\s*|location\.replace\(\s*)["']([^"']+)["']""",
    re.I,
)
_ANCHOR_RE = re.compile(r"""<a[^>]+href=["'](https?://(?:www\.)?amazon\.[^"']+)["']""", re.I)


@dataclass
class CloakResult:
    id: str
    ok: bool
    status: int | None
    target: str | None
    reason: str  # "" when ok
    retired: bool = False  # deliberately pointed back into the site, not broken

    @property
    def is_infra_failure(self) -> bool:
        """True when the site's own redirect is broken (an engineering problem)."""
        return not self.ok and not self.retired


def _extract_target(status: int, headers, body: str) -> str | None:
    if 300 <= status < 400:
        return headers.get("location")
    for rx in (_META_REFRESH_RE, _JS_LOCATION_RE, _ANCHOR_RE):
        m = rx.search(body)
        if m:
            return m.group(1)
    return None


def _host(url: str) -> str:
    m = re.match(r"https?://([^/]+)", url or "")
    return (m.group(1) if m else "").removeprefix("www.").lower()


def check(
    client: httpx.Client,
    base_url: str,
    go_prefix: str,
    product_id: str,
    expected_asin: str | None,
    expected_tag: str | None,
    expected_url: str | None = None,
) -> CloakResult:
    """`expected_url` is the destination the registry itself declares.

    Not every cloak points at Amazon — rodhat mixes Amazon picks with direct
    partner-program links in one registry. Asserting "must be an Amazon URL"
    against those would report every partner link as broken forever, so when the
    registry names a non-Amazon destination we assert against THAT host instead.
    """
    url = f"{base_url.rstrip('/')}{go_prefix}{product_id}/"
    try:
        # No redirect following: the Location header IS the assertion, and
        # following it would put us back on amazon.com and reintroduce the
        # anti-bot class this design exists to remove.
        r = client.get(url, follow_redirects=False)
    except httpx.HTTPError as exc:
        return CloakResult(product_id, False, None, None, f"request failed: {type(exc).__name__}")

    status = r.status_code
    if status == 404:
        return CloakResult(product_id, False, status, None, "cloak route 404s on the live site")
    if status >= 400:
        return CloakResult(product_id, False, status, None, f"cloak returned HTTP {status}")

    body = r.text if status < 300 else ""
    target = _extract_target(status, r.headers, body)
    if not target:
        return CloakResult(
            product_id, False, status, None,
            f"HTTP {status} but no redirect target found (no Location, meta-refresh, or JS bounce)",
        )

    # A registry-declared non-Amazon destination: check it goes where the
    # registry says, and skip the Amazon-specific tag/ASIN assertions below.
    if expected_url and "amazon." not in expected_url:
        want = _host(expected_url)
        if want and _host(target) == want:
            return CloakResult(product_id, True, status, target, "")
        return CloakResult(
            product_id, False, status, target,
            f"redirect target does not go to the declared partner host ({want or expected_url})",
        )

    if "amazon." not in target:
        # A permanent redirect back into our own site is the fleet's established
        # way of retiring a cloak whose product is gone for good (reviewtattoo's
        # cicatricure entry, delisted 2026-07-08, is the reference case). It is a
        # deliberate editorial decision, not a fault — flagging it would hand the
        # operator the same false positive every single day until they gave up
        # reading the report, which is how a daily check stops being read at all.
        internal = target.startswith("/") or (
            base_url and target.startswith(base_url.rstrip("/"))
        )
        if internal and status == 301:
            return CloakResult(
                product_id, True, status, target,
                "", retired=True,
            )
        return CloakResult(product_id, False, status, target, "redirect target is not an Amazon URL")

    if expected_tag and f"tag={expected_tag}" not in target:
        # Untagged links still work for the visitor but earn nothing, which is
        # a silent revenue leak rather than a visible breakage — exactly the
        # kind of thing only an automated check ever catches.
        return CloakResult(
            product_id, False, status, target,
            f"redirect target is missing the affiliate tag ({expected_tag}) — earns no commission",
        )

    if expected_asin and f"/dp/{expected_asin}" not in target and "/s?k=" not in target:
        return CloakResult(
            product_id, False, status, target,
            f"redirect target does not point at the registry ASIN {expected_asin}",
        )

    return CloakResult(product_id, True, status, target, "")


def make_client(timeout: float = 20.0) -> httpx.Client:
    return httpx.Client(headers={"User-Agent": _UA}, timeout=timeout, follow_redirects=False)
