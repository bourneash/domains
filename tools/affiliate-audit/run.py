#!/usr/bin/env python3
"""Orchestrator entrypoint: discover -> check -> classify -> state -> resolve
-> notify. One entrypoint, one site per invocation.

Usage:
    python3 run.py --site totaljerks.com [--dry-run]
"""
import argparse
import json
import subprocess
import sys
from datetime import date, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import checker  # noqa: E402
import classify  # noqa: E402
import config  # noqa: E402
import resolve  # noqa: E402
import state  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]  # .../domains
AUDIT_DIR = Path(__file__).resolve().parent


def discover_products(site_dir: Path) -> list[dict]:
    affiliate_ts = site_dir / "site" / "src" / "lib" / "affiliate.ts"
    result = subprocess.run(
        ["npx", "tsx", str(AUDIT_DIR / "discover.mjs"), str(affiliate_ts)],
        cwd=str(site_dir / "site"),
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(f"discover.mjs failed: {result.stderr}")
    return json.loads(result.stdout)


def notify_summary(site_dir: Path, site_domain: str, cfg: dict, counts: dict) -> None:
    channel_env = cfg["slack"]["channel_env"]
    channel_default = cfg["slack"].get("channel_default") or f"domain-{site_domain.split('.')[0]}-com"
    line = (
        f"\U0001f440 {site_domain} affiliate audit — {counts['healthy']} healthy, "
        f"{counts['flagged']} flagged ({counts['resolving']} sent to resolution)."
    )
    subprocess.run(
        [
            "bash",
            str(site_dir / "ops" / "scripts" / "notify-slack.sh"),
            f"${{{channel_env}:-{channel_default}}}",
            line,
        ],
        cwd=str(site_dir),
        check=False,
    )


def run_once(site_dir: Path, site_domain: str, cfg: dict, dry_run: bool, today: str | None = None) -> None:
    if today is None:
        today = date.today().isoformat()

    products = discover_products(site_dir)
    ctx, page = checker.launch_browser()

    st = state.load_state(site_dir)
    counts = {"healthy": 0, "flagged": 0, "resolving": 0}

    try:
        for i, product in enumerate(products):
            evidence = checker.check_product(page, f"https://{site_domain}", product, cfg["pacing"])
            verdict = classify.classify(evidence, cfg["checks"])
            st, actionable = state.update_state(st, product["id"], verdict, today, cfg["checks"])

            if verdict in ("ok", "inconclusive"):
                counts["healthy"] += 1
            else:
                counts["flagged"] += 1

            if actionable and not dry_run:
                counts["resolving"] += 1
                log_path = site_dir / "ops" / "logs" / f"affiliate-audit-resolve-{product['id']}-{today}.log"
                resolve.resolve_product(
                    product, evidence, verdict, cfg["resolution"], site_dir, site_domain, log_path
                )
            elif actionable and dry_run:
                counts["resolving"] += 1
                print(f"[dry-run] would resolve {product['id']} ({verdict})")

            if i < len(products) - 1:
                checker.pace(cfg["pacing"])
    finally:
        ctx.close()

    state.save_state(site_dir, st)
    notify_summary(site_dir, site_domain, cfg, counts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", required=True, help="domain, e.g. totaljerks.com")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    site_dir = ROOT / "sites" / args.site
    if not site_dir.is_dir():
        print(f"no such site dir: {site_dir}", file=sys.stderr)
        sys.exit(1)

    cfg = config.load_config(site_dir)
    run_once(site_dir, args.site, cfg, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
