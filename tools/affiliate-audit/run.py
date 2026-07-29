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


def discover_products(site_dir: Path, registry_path: str = "site/src/lib/affiliate.ts") -> list[dict]:
    registry = site_dir / registry_path
    result = subprocess.run(
        ["npx", "tsx", str(AUDIT_DIR / "discover.mjs"), str(registry)],
        cwd=str(site_dir / "site"),
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(f"discover.mjs failed: {result.stderr}")
    return json.loads(result.stdout)


DEAD_VERDICTS = {"dead"}
COLOR_CLEAR = "#2eb67d"
COLOR_WARN = "#daa038"
COLOR_CRITICAL = "#e01e5a"


def notify_summary(
    site_dir: Path, site_domain: str, cfg: dict, counts: dict, flagged_items: list[dict]
) -> None:
    channel_env = cfg["slack"]["channel_env"]
    channel_default = cfg["slack"].get("channel_default") or f"domain-{site_domain.split('.')[0]}-com"

    if not flagged_items:
        emoji, color = "✅", COLOR_CLEAR
    elif any(item["verdict"] in DEAD_VERDICTS for item in flagged_items):
        emoji, color = "\U0001f6a8", COLOR_CRITICAL
    else:
        emoji, color = "⚠️", COLOR_WARN

    header = (
        f"{emoji} {site_domain} affiliate audit — "
        f"{counts['healthy']}/{counts['healthy'] + counts['flagged']} healthy, "
        f"{counts['flagged']} flagged, {counts['resolving']} sent to resolution."
    )
    bullets = "\n".join(
        f"• *{item['verdict']}*: <{item['go_url']}|{item['id']}>"
        + (f" — filed `{item['task_path']}`" if item.get("task_path") else "")
        for item in flagged_items
    )
    text = header if not bullets else f"{header}\n{bullets}"

    subprocess.run(
        [
            "bash",
            str(site_dir / "ops" / "scripts" / "notify-slack.sh"),
            f"${{{channel_env}:-{channel_default}}}",
            text,
            color,
        ],
        cwd=str(site_dir),
        check=False,
    )


def _commit_and_push(site_dir: Path, message: str, paths: list[str]) -> None:
    try:
        status = subprocess.run(
            ["git", "status", "--porcelain", "--"] + paths,
            cwd=str(site_dir),
            capture_output=True,
            text=True,
        )
        if not status.stdout.strip():
            return
        subprocess.run(["git", "add", "--"] + paths, cwd=str(site_dir), check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", message], cwd=str(site_dir), check=True, capture_output=True
        )
        subprocess.run(["git", "push"], cwd=str(site_dir), check=True, capture_output=True, timeout=30)
    except Exception as e:
        print(f"warning: could not commit/push affiliate-audit state: {e}", file=sys.stderr)


def run_once(site_dir: Path, site_domain: str, cfg: dict, dry_run: bool, today: str | None = None) -> None:
    if today is None:
        today = date.today().isoformat()

    products = discover_products(site_dir, cfg.get("registry", {}).get("path", "site/src/lib/affiliate.ts"))
    ctx, page = checker.launch_browser()

    first_pass = []
    try:
        for i, product in enumerate(products):
            evidence = checker.check_product(page, f"https://{site_domain}", product, cfg["pacing"])
            verdict = classify.classify(evidence, cfg["checks"])
            first_pass.append((product, evidence, verdict))
            if i < len(products) - 1:
                checker.pace(cfg["pacing"])
    finally:
        ctx.close()

    st = state.load_state(site_dir)
    counts = {"healthy": 0, "flagged": 0, "resolving": 0}
    flagged_items = []
    filed_task_paths = []

    for product, evidence, verdict in first_pass:
        if verdict != "ok":
            # Recheck EVERY non-ok verdict, including inconclusive (anti-bot
            # wall / Amazon 5xx) — a fresh browser context rules out a
            # transient blip before it's trusted, rather than only rechecking
            # verdicts that were already going to be actionable.
            evidence = checker.recheck_product(product, f"https://{site_domain}", cfg["pacing"])
            verdict = classify.classify(evidence, cfg["checks"])

        st, actionable = state.update_state(st, product["id"], verdict, today, cfg["checks"])

        if verdict == "ok" or (verdict == "inconclusive" and not actionable):
            counts["healthy"] += 1
        else:
            counts["flagged"] += 1
            item = {"id": product["id"], "verdict": verdict, "go_url": evidence.get("go_url")}
            flagged_items.append(item)

            if actionable:
                counts["resolving"] += 1
                if dry_run:
                    print(f"[dry-run] would resolve {product['id']} ({verdict})")
                elif verdict == "inconclusive":
                    # No LLM judgment needed here — there's no replacement
                    # decision to make, just a "this needs human eyes" signal.
                    task_path = resolve.file_persistent_inconclusive(
                        product, evidence, cfg["checks"], site_dir, today
                    )
                    filed_task_paths.append(task_path)
                    item["task_path"] = str(task_path.relative_to(site_dir))
                else:
                    log_path = (
                        site_dir / "ops" / "logs" / f"affiliate-audit-resolve-{product['id']}-{today}.log"
                    )
                    exit_code = resolve.resolve_product(
                        product, evidence, verdict, cfg["resolution"], site_dir, site_domain, log_path
                    )
                    if exit_code != 0:
                        # The agent crashed, hit its turn cap, or otherwise
                        # exited abnormally before reaching (or finishing)
                        # its own step-4 file+commit+push path. Without this,
                        # a flagged product just silently vanishes — no
                        # task, no commit, no Slack line. File (idempotent —
                        # leaves it alone if the agent got as far as writing
                        # the file, just didn't commit it) and sweep it into
                        # this run's own commit below.
                        task_path = resolve.file_fallback_unresolved(
                            product, evidence, verdict, site_dir, today
                        )
                        filed_task_paths.append(task_path)
                        item["task_path"] = str(task_path.relative_to(site_dir))

    state.save_state(site_dir, st)

    if not dry_run:
        commit_paths = ["ops/state/affiliate-audit.json"] + [
            str(p.relative_to(site_dir)) for p in filed_task_paths
        ]
        if filed_task_paths:
            message = f"affiliate-audit: flag {len(filed_task_paths)} product(s) needing attention ({today})"
        else:
            message = f"affiliate-audit: state update ({today})"
        _commit_and_push(site_dir, message, commit_paths)

    notify_summary(site_dir, site_domain, cfg, counts, flagged_items)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", required=True, help="domain, e.g. totaljerks.com")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    # Two invocation shapes: (1) on the host, from anywhere, with the full
    # domains monorepo on disk -> ROOT/sites/<site> exists; (2) inside a
    # per-site container where only that site's own repo (plus tools/
    # bind-mounted read-only at .monorepo-tools) is mounted -> ROOT/sites/<site>
    # can't exist because "sites/" itself isn't mounted, so fall back to the
    # cwd, matching the convention every other in-container role script uses.
    site_dir = ROOT / "sites" / args.site
    if not site_dir.is_dir():
        site_dir = Path.cwd()
    if not site_dir.is_dir() or not (site_dir / "site").is_dir():
        print(f"no such site dir: {site_dir}", file=sys.stderr)
        sys.exit(1)

    cfg = config.load_config(site_dir)
    run_once(site_dir, args.site, cfg, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
