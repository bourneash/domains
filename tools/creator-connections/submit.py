#!/usr/bin/env python3
"""
Submit (or resume submitting) Amazon Creator Connections content URLs for a
site's ops/campaigns/creator-connections.json manifest. Idempotent: skips
campaigns already marked submitted, detects Amazon-maintenance pages and
aborts cleanly, retries a flaky content-type dropdown via a raw JS click
before giving up, and saves the manifest after every campaign (not just at
the end) so a crash mid-run doesn't lose already-submitted progress.

Usage:
    python submit.py --manifest /path/to/site/ops/campaigns/creator-connections.json
    python submit.py --manifest ... --only potuinom-110pc-gold-discs,hzxbgf-80grit-black-roll

Requires: cloakbrowser (portfolio CloakBrowser). Opens a VISIBLE browser; if
it lands on the Amazon sign-in page, log in as Jesse Tamburino in that window
and the script continues. Profile persists at /tmp/cloak-driver/profile so
login is usually already in place.

Manifest shape (see any site's ops/campaigns/creator-connections.json):
    {"campaigns": [{"productId", "adId", "campaignId", "contentUrl",
                     "submitted": bool, "contentType"}, ...]}
"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import cc_lib  # noqa: E402


def main(manifest_path=None, only=None):
    if manifest_path is None:
        parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
        parser.add_argument("--manifest", required=True)
        parser.add_argument("--only", default=None, help="comma-separated productIds to limit this run to")
        args = parser.parse_args()
        manifest_path = args.manifest
        only = args.only.split(",") if args.only else None

    data = cc_lib.load_manifest(manifest_path)
    pending = [c for c in data["campaigns"] if not c.get("submitted")]
    if only:
        pending = [c for c in pending if c["productId"] in only]
    if not pending:
        print("No pending campaigns to submit.")
        return
    print(f"{len(pending)} campaign(s) pending submission.")

    ctx, page = cc_lib.launch(viewport={"width": 1360, "height": 940})
    list_page_url = cc_lib.list_url()
    page.goto(list_page_url, wait_until="domcontentloaded", timeout=70000)
    time.sleep(7)
    cc_lib.handle_login_if_needed(page, list_page_url)

    for c in pending:
        label = c["productId"]
        body = cc_lib.open_detail_resilient(page, c["adId"], c["campaignId"])

        if cc_lib.is_maintenance_or_empty(body):
            print("Amazon Associates is UNAVAILABLE / in maintenance — aborting, rerun later.")
            break

        if cc_lib.link_already_stored(body, c["contentUrl"]):
            print(f"{label}: already has this link stored — marking submitted.")
            c["submitted"] = True
            cc_lib.save_manifest(manifest_path, data)
            continue

        try:
            ok = cc_lib.submit_content_link(
                page,
                c["contentUrl"],
                content_type=c.get("contentType", "Article or blog post"),
                screenshot_path=f"{cc_lib.SCREENSHOTS}/cc-submit-{label}.png",
            )
            if ok:
                c["submitted"] = True
                cc_lib.save_manifest(manifest_path, data)
                print(f"{label}: SUBMITTED ✓")
            else:
                print(f"{label}: submit not confirmed — check {cc_lib.SCREENSHOTS}/cc-submit-{label}.png")
        except Exception as e:
            print(f"{label}: ERROR {e}")

    try:
        ctx.close()
    except Exception:
        pass

    done = sum(1 for c in data["campaigns"] if c.get("submitted"))
    print(f"Done. {done}/{len(data['campaigns'])} campaigns submitted.")


if __name__ == "__main__":
    main()
