"""Image loading for posts with a picture.

A link card with a real image gets meaningfully more reach than a bare link on
every network that supports one, and every article in the fleet already ships a
cover image in its frontmatter. This module turns that frontmatter reference
into bytes an adapter can upload.

Local file first, HTTP second: the cover usually lives in the site checkout
right next to the article, and reading it off disk is faster, works before the
site has deployed the new image, and cannot be rate-limited. The HTTP path
exists for sources whose images are already remote.

Everything here degrades to `None` rather than raising. A missing or oversized
image must cost the post its picture, never its publication.
"""

from __future__ import annotations

import io
import os
from pathlib import Path

from social_hub.config import site_root

#: Bluesky rejects blobs over ~1MB; Mastodon and Pinterest are more generous.
#: One conservative ceiling keeps the resize logic in one place.
MAX_BYTES = 950_000
MAX_EDGE = 1600


def _candidate_paths(site: str, ref: str) -> list[Path]:
    """Where a site-absolute image reference could live on disk.

    Fleet sites are not uniform: most are `sites/<domain>/site/public/...`
    (Astro inside a `site/` subdir), a few are `sites/<domain>/public/...`.
    Try both rather than encoding a per-site map.
    """
    rel = ref.lstrip("/")
    root = site_root(site)
    return [
        root / "site" / "public" / rel,
        root / "public" / rel,
        root / "site" / "dist" / "client" / rel,
    ]


def _shrink(data: bytes) -> bytes | None:
    """Re-encode an oversized image to fit the ceiling, or None if we can't."""
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        original = Image.open(io.BytesIO(data)).convert("RGB")
        # Walk both knobs — dimensions first, then quality. Quality alone often
        # can't rescue a very large image, and a smaller-but-clean picture
        # beats a full-size smeared one.
        for edge in (MAX_EDGE, 1200, 900, 600):
            img = original.copy()
            img.thumbnail((edge, edge))
            for quality in (85, 70, 55, 40):
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=quality, optimize=True)
                if buf.tell() <= MAX_BYTES:
                    return buf.getvalue()
    except Exception:
        return None
    return None


def load_image(ref: str, site: str = "") -> bytes | None:
    """Bytes for *ref* (a site-absolute path or an http(s) URL), or None."""
    if not ref or os.environ.get("SOCIAL_HUB_NO_MEDIA"):
        return None

    data: bytes | None = None
    if ref.startswith("http://") or ref.startswith("https://"):
        # A URL on the site's own domain is very likely also a local file —
        # prefer the checkout and skip the round trip.
        if site and f"//{site}/" in ref:
            data = _read_local(site, ref.split(f"//{site}", 1)[1])
        if data is None:
            data = _fetch(ref)
    else:
        data = _read_local(site, ref)

    if data is None:
        return None
    if len(data) > MAX_BYTES:
        return _shrink(data)
    return data


def _read_local(site: str, ref: str) -> bytes | None:
    if not site:
        return None
    for path in _candidate_paths(site, ref):
        try:
            if path.is_file():
                return path.read_bytes()
        except OSError:
            continue
    return None


def _fetch(url: str) -> bytes | None:
    try:
        import httpx

        resp = httpx.get(url, timeout=20, follow_redirects=True)
        if resp.status_code >= 400:
            return None
        return resp.content
    except Exception:
        return None


def alt_text(title: str) -> str:
    """Alt text for a cover image. The article title is a genuinely useful
    description of its own cover, and shipping no alt text at all is worse for
    the people who need it than shipping an imperfect one."""
    return (title or "").strip()[:290]
