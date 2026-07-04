#!/usr/bin/env python3
"""
Pull Amazon Creator Connections campaign data — list cards, campaign detail
pages, and /dp/ product pages. Replaces the one-off scripts written per site;
always writes results to a file first (never prints large JSON — piping big
payloads through e.g. `| tail` can hit BlockingIOError and lose the data).

Usage:
    # list every active Affiliate+ campaign (all sites combined — filter after)
    python pull.py list --out cards.json

    # search a keyword within a status (e.g. confirm nothing is hiding under "vac")
    python pull.py list --status active --keyword vac --out vac_cards.json

    # pull campaign-detail + /dp/ product-page facts for specific campaigns
    # (adId:campaignId pairs, comma-separated — copy from a `list` result)
    python pull.py details --pairs AD1:CID1,AD2:CID2 --out details.json

Requires: cloakbrowser (portfolio CloakBrowser), VISIBLE browser window. If it
lands on Amazon sign-in, log in as Jesse Tamburino in that window — the
profile at /tmp/cloak-driver/profile persists so login is usually already in
place.
"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import cc_lib  # noqa: E402


def cmd_list(args):
    ctx, page = cc_lib.launch()
    url = cc_lib.list_url(status=args.status, type_=args.type, keyword=args.keyword)
    page.goto(url, wait_until="domcontentloaded", timeout=70000)
    time.sleep(4)
    cc_lib.handle_login_if_needed(page, url)
    page.mouse.wheel(0, 20000)
    time.sleep(2)
    cards = cc_lib.extract_campaign_cards(page)
    page.screenshot(path=f"{cc_lib.SCREENSHOTS}/cc-pull-list.png")
    ctx.close()

    cc_lib.dump_json(args.out, cards)
    print(f"{len(cards)} campaign card(s) -> {args.out}")


def cmd_details(args):
    pairs = []
    for chunk in args.pairs.split(","):
        ad, cid = chunk.split(":")
        pairs.append((ad.strip(), cid.strip()))

    ctx, page = cc_lib.launch()
    list_page_url = cc_lib.list_url()
    page.goto(list_page_url, wait_until="domcontentloaded", timeout=70000)
    time.sleep(4)
    cc_lib.handle_login_if_needed(page, list_page_url)

    results = []
    for i, (ad, cid) in enumerate(pairs):
        entry = {"adId": ad, "campaignId": cid}
        try:
            body = cc_lib.open_detail_resilient(page, ad, cid)
            dp_link = page.evaluate(
                "() => { const a = [...document.querySelectorAll('a')].find(a => /\\/dp\\//.test(a.href)); return a ? a.href : null; }"
            )
            entry["campaign_body"] = body[:2500]
            entry["dp_link"] = dp_link
            if dp_link and args.dp:
                entry.update(cc_lib.pull_product_page_info(page, dp_link))
            page.screenshot(path=f"{cc_lib.SCREENSHOTS}/cc-pull-detail-{i}.png")
        except Exception as e:
            entry["error"] = str(e)
        results.append(entry)
        cc_lib.dump_json(args.out, results)  # write after every item, not just at the end

    ctx.close()
    print(f"{len(results)} detail(s) -> {args.out}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list", help="pull campaign cards from a list page")
    p_list.add_argument("--status", default="active", help="active | completed | omit for New Opportunities")
    p_list.add_argument("--type", default="affiliate-plus")
    p_list.add_argument("--keyword", default="")
    p_list.add_argument("--out", required=True)
    p_list.set_defaults(func=cmd_list)

    p_details = sub.add_parser("details", help="pull campaign-detail + /dp/ product facts")
    p_details.add_argument("--pairs", required=True, help="adId:campaignId,adId:campaignId,...")
    p_details.add_argument("--dp", action="store_true", help="also visit each /dp/ product page")
    p_details.add_argument("--out", required=True)
    p_details.set_defaults(func=cmd_details)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
