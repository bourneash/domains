#!/usr/bin/env python3
"""Fill out an X (Twitter) account's profile — display name, bio, avatar —
via the browser, using the same persistent CloakBrowser profile the account
was signed up with (already logged in, no captcha needed to edit your own
profile).

Browser-driven rather than API-driven on purpose: filling a profile needs
no elevated API access, and this account has no Developer App / API keys
yet (see x_signup.py's docstring and the social-setup skill's X section).
Once API keys exist this could move to v1.1's account/update_profile* the
way Bluesky's fill_profile() uses AT Protocol directly — not worth building
until keys are actually in hand.

Usage:
    x_fill_profile.py <domain> --display-name "..." --bio "..." \
        [--website https://domain] [--persona persona-slug] \
        [--avatar /path/to/square.png] [--favicon-fallback] [--overwrite]

Idempotent by default (--overwrite required to replace non-blank fields) —
same discipline as bsky_fill_profile.py, so re-running is always safe.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools/social-setup/src"))
sys.path.insert(0, str(REPO_ROOT / "tools/social-lib/src"))

from social_setup.browser import launch_browser  # noqa: E402
from social_lib.credentials import read_creds  # noqa: E402


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
    out_path = Path("/tmp") / f"x-avatar-{domain}.png"
    cairosvg.svg2png(url=str(svg_path), write_to=str(out_path), output_width=size, output_height=size)
    return str(out_path)


def dialog_scope(page):
    try:
        dlg = page.get_by_role("dialog")
        if dlg.count() > 0:
            return dlg.last
    except Exception:
        pass
    return page


def click_text(page, *texts, timeout=5000):
    scope = dialog_scope(page)
    for text in texts:
        for exact in (True, False):
            try:
                loc = scope.get_by_text(text, exact=exact)
                for i in range(loc.count()):
                    cand = loc.nth(i)
                    if not cand.is_visible():
                        continue
                    try:
                        if not cand.is_enabled():
                            continue
                    except Exception:
                        pass
                    cand.click(timeout=timeout)
                    time.sleep(1)
                    return True
            except Exception:
                pass
    return False


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("domain")
    ap.add_argument("--display-name", required=True)
    ap.add_argument("--bio", required=True)
    ap.add_argument("--website")
    ap.add_argument("--persona", help="vault sub-key, e.g. 'chris-donovan' (omit for brand account)")
    ap.add_argument("--avatar", help="path to a square image to use as the avatar")
    ap.add_argument("--favicon-fallback", action="store_true", help="rasterize the site's favicon.svg as avatar")
    ap.add_argument("--overwrite", action="store_true", help="replace fields even if already set")
    args = ap.parse_args()

    vault_key = f"{args.domain}::{args.persona}" if args.persona else args.domain
    creds = read_creds(vault_key, "x")
    if not creds or not creds.get("X_HANDLE"):
        print(f"STATUS no X creds found in vault for {vault_key} — run x_signup.py first", flush=True)
        sys.exit(1)
    handle = creds["X_HANDLE"]

    avatar_path = args.avatar
    if not avatar_path and args.favicon_fallback:
        avatar_path = rasterize_favicon(args.domain)
        print(f"rasterized favicon -> {avatar_path}", flush=True)

    context, page = launch_browser(vault_key, "x")
    try:
        # Brand-new accounts show a "Set up profile" button (from the
        # onboarding checklist) on the profile page instead of the usual
        # "Edit profile" — confirmed live it opens a different, flaky
        # wizard widget ("Something went wrong. Try reloading.") rather
        # than the real edit-profile form. Go straight to the settings
        # route instead, which reliably opens the standard dialog.
        page.goto("https://x.com/settings/profile", wait_until="domcontentloaded", timeout=30000)
        time.sleep(3)

        scope = dialog_scope(page)
        # /settings/profile may render the form inline (no dialog wrapper)
        # rather than as a modal — dialog_scope() falls back to the full
        # page in that case, which is fine; the field selectors below
        # match either way.

        name_input = scope.locator('input[name="displayName"], input[name="name"]')
        if name_input.count():
            current = name_input.first.input_value()
            if args.overwrite or not current.strip():
                name_input.first.fill(args.display_name)
                print(f"set display name -> {args.display_name}", flush=True)

        bio_input = scope.locator('textarea[name="description"], textarea[name="bio"]')
        if bio_input.count():
            current = bio_input.first.input_value()
            if args.overwrite or not current.strip():
                bio_text = args.bio
                if args.website:
                    bio_text = f"{bio_text}\n{args.website}"
                bio_input.first.fill(bio_text)
                print("set bio", flush=True)

        website_input = scope.locator('input[name="website"], input[name="url"]')
        if args.website and website_input.count():
            current = website_input.first.input_value()
            if args.overwrite or not current.strip():
                website_input.first.fill(args.website)
                print(f"set website -> {args.website}", flush=True)

        if avatar_path:
            # The edit-profile dialog has 3 file inputs sharing identical
            # accept attrs, so they can't be told apart by selector alone:
            # [0] banner/header photo, [1] avatar photo, [2] the post
            # composer sitting underneath the dialog (unrelated). Confirmed
            # live 2026-08-29 — `.first` silently uploaded to the banner
            # instead of the avatar on the first attempt (no error, avatar
            # just stayed a gray placeholder after Save). Index 1 is the
            # avatar input.
            file_inputs = scope.locator('input[type="file"]')
            if file_inputs.count() >= 2:
                file_inputs.nth(1).set_input_files(avatar_path)
                time.sleep(2)
                # Avatar upload opens its own crop dialog with an "Apply"/
                # "Save" confirm step before it counts as attached.
                click_text(page, "Apply", "Save")
                time.sleep(1.5)
                print(f"set avatar <- {avatar_path}", flush=True)
            else:
                print("STATUS fewer than 2 file inputs found in edit-profile dialog", flush=True)

        page.screenshot(path=f"/tmp/x-profile-fill-{args.domain}-before-save.png")
        if not click_text(page, "Save"):
            print("STATUS could not find Save button on edit-profile dialog", flush=True)
            sys.exit(1)
        time.sleep(2)
        page.screenshot(path=f"/tmp/x-profile-fill-{args.domain}-after-save.png")
        print("STATUS profile saved", flush=True)
    finally:
        context.close()


if __name__ == "__main__":
    main()
