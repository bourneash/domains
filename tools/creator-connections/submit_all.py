#!/usr/bin/env python3
"""
Run Creator Connections content-link submission across MULTIPLE sites'
manifests in one command, sequentially — replaces manually invoking
submit.py once per site and babysitting each run. Cleans up the CloakBrowser
profile between sites (the browser gets flaky after heavy churn — many
launch/close cycles in one session — so a fresh cleanup before each site is
cheap insurance, not just a reactive fix), retries a failed site once before
moving on, and prints one final tally across every site instead of N
separate ones.

Usage:
    python submit_all.py sites/americastrikes.com/ops/campaigns/creator-connections.json \\
        sites/totaljerks.com/ops/campaigns/creator-connections.json \\
        sites/ultrarough.com/ops/campaigns/creator-connections.json \\
        sites/reviewtattoo.com/ops/campaigns/creator-connections.json \\
        sites/xxxtea.com/ops/campaigns/creator-connections.json

    # or discover every site under sites/*/ops/campaigns/creator-connections.json
    python submit_all.py --all

Does NOT commit/push — that's still a separate, deliberate step per site.
"""
import argparse
import glob
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import cc_lib  # noqa: E402
import submit  # noqa: E402

DOMAINS_ROOT = Path("/home/jesse/projects/domains")


def discover_all_manifests():
    return sorted(str(p) for p in DOMAINS_ROOT.glob("sites/*/ops/campaigns/creator-connections.json"))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("manifests", nargs="*", help="manifest paths to process, in order")
    parser.add_argument("--all", action="store_true", help="discover every sites/*/ops/campaigns/creator-connections.json")
    args = parser.parse_args()

    manifests = discover_all_manifests() if args.all else args.manifests
    if not manifests:
        parser.error("pass manifest paths, or --all to discover every site's manifest")

    results = {}
    for i, manifest_path in enumerate(manifests):
        site = Path(manifest_path).parts[-4]  # sites/<site>/ops/campaigns/...
        print(f"\n{'=' * 60}\n[{i + 1}/{len(manifests)}] {site}\n{'=' * 60}")

        cc_lib.cleanup_stale_profile()
        try:
            submit.main(manifest_path=manifest_path, retries=1)
        except Exception as e:
            print(f"{site}: GAVE UP after retry — {e}")

        data = cc_lib.load_manifest(manifest_path)
        camps = data["campaigns"]
        done = sum(1 for c in camps if c.get("submitted"))
        results[site] = (done, len(camps))

        if i < len(manifests) - 1:
            time.sleep(2)  # brief pause before the next site's launch

    print(f"\n{'=' * 60}\nFINAL TALLY\n{'=' * 60}")
    total_done = total_all = 0
    for site, (done, total) in results.items():
        flag = "" if done == total else "  <-- INCOMPLETE"
        print(f"  {site}: {done}/{total}{flag}")
        total_done += done
        total_all += total
    print(f"\nGRAND TOTAL: {total_done}/{total_all} campaigns submitted across {len(results)} site(s).")


if __name__ == "__main__":
    main()
