#!/usr/bin/env python3
"""Fill out a Bluesky account's profile — displayName, bio, avatar, link —
via the AT Protocol API (no browser, no captcha; works against any account
with working login creds already in the vault).

Run this as the last step of provisioning every new Bluesky account (brand
or persona) — see §5 of the social-setup skill. It's also what backfilled
the 2026-08-27 fleet sweep of accounts that had never had this done.

Usage:
    bsky_fill_profile.py <domain> --display-name "..." --bio "..." \
        [--website https://domain] [--persona persona-slug] \
        [--avatar /path/to/square.png] [--favicon-fallback]

If neither --avatar nor --favicon-fallback is given, no avatar is touched.
--favicon-fallback rasterizes sites/<domain>/site/public/favicon.svg (or
/favicon.svg for sites without a site/ subdir) to a 512x512 PNG and uses that
— good enough as a professional-looking square mark for brand accounts that
don't have a dedicated logo file. Pass --avatar explicitly instead when a
real logo (or a persona headshot) exists — see e.g.
sites/americastrikes.com/site/public/authors/<slug>.png,
sites/americastrikes.com/site/public/logo-square.png.

Only fills fields that are currently blank on the live profile unless
--overwrite is passed — safe to re-run.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools/social-lib/src"))

from social_lib.bluesky_profile import fill_profile  # noqa: E402


def rasterize_favicon(domain: str, size: int = 512) -> str:
    import cairosvg

    candidates = [
        REPO_ROOT / "sites" / domain / "site" / "public" / "favicon.svg",
        REPO_ROOT / "sites" / domain / "site" / "favicon.svg",
        REPO_ROOT / "sites" / domain / "public" / "favicon.svg",
    ]
    svg_path = next((p for p in candidates if p.exists()), None)
    if not svg_path:
        raise FileNotFoundError(f"no favicon.svg found for {domain} (checked {candidates})")
    out_path = Path("/tmp") / f"bsky-avatar-{domain}.png"
    cairosvg.svg2png(url=str(svg_path), write_to=str(out_path), output_width=size, output_height=size)
    return str(out_path)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("domain")
    ap.add_argument("--display-name", required=True)
    ap.add_argument("--bio", required=True)
    ap.add_argument("--website")
    ap.add_argument("--persona", help="vault sub-key, e.g. 'chris-donovan' (omit for brand account)")
    ap.add_argument("--avatar", help="path to a square image to use as the avatar")
    ap.add_argument("--banner", help="path to a banner image")
    ap.add_argument("--favicon-fallback", action="store_true", help="rasterize the site's favicon.svg as avatar")
    ap.add_argument("--overwrite", action="store_true", help="replace fields even if already set")
    args = ap.parse_args()

    avatar_path = args.avatar
    if not avatar_path and args.favicon_fallback:
        avatar_path = rasterize_favicon(args.domain)
        print(f"rasterized favicon -> {avatar_path}")

    result = fill_profile(
        domain=args.domain,
        persona=args.persona,
        display_name=args.display_name,
        bio=args.bio,
        website=args.website,
        avatar_path=avatar_path,
        banner_path=args.banner,
        overwrite=args.overwrite,
    )
    print(f"handle={result.handle} changed={result.changed} skipped={result.skipped}")


if __name__ == "__main__":
    main()
