#!/usr/bin/env python3
"""affiliate-link-check — deterministic detection half of the affiliate-editor
cron role, shared across the fleet (mounted read-only at .monorepo-tools on
every site, same pattern as tools/task-budget).

Root cause this exists for: affiliate-editor invoked a full Claude session
every week to do nothing but curl ~20 /go/<id> links and confirm they're all
fine — the vast majority of runs (see 2026-07-22 audit) find zero issues.
This script does the exact curl+grep sweep the role's prompt already
documents (tools/cron-roles/archetypes/affiliate-editor/role.md.tmpl) with no
model involved, and does the fully mechanical parts of "what to do with
results" itself: OOS state tracking and, when nothing needs judgment, even
the Slack notify. It only asks for a Claude turn when something was actually
filed that needs the role's existing task-writing behavior.

Usage:
  check_links.py --repo-root <path> --base-url https://example.com
                  [--go-prefix /go/] [--content-path site/src/content]
                  [--tag SITE-20] [--slack-channel domain-example-com]
                  [--notify-script ops/scripts/notify-slack.sh]
                  [--site-brand "Example"]

Exit codes:
  0 — clean run, nothing to file. Already posted the Slack "all clear" line
      itself (unless SLACK_BOT_TOKEN is unset, in which case notify-slack.sh
      no-ops silently, same as everywhere else in the fleet). No Claude turn
      needed.
  1 — something needs filing. Writes ops/cache/affiliate-check-findings.json
      with everything the role prompt needs (id, ASIN, marker matched,
      referencing content pages, suggested redirect target) so the Claude
      invocation that follows does NOT need to re-run its own curl sweep —
      it just needs to write the task file(s), update state, and notify.
"""
import argparse
import datetime
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

SOFT_404_MARKERS = [
    "Sorry! We couldn't find that page",
    "Looking for something",
    "dog of the day",
    "404 Not Found",
]
OOS_MARKER = "currently unavailable"
ANTI_BOT_MARKERS = ["captcha", "robot check"]


def log(msg):
    print(f"[affiliate-link-check] {msg}", file=sys.stderr, flush=True)


def parse_products(affiliate_ts: Path):
    """Extract id/asin/searchQuery per product from the TS registry via regex.
    Good enough for the fixed object-literal shape used across the fleet —
    not a general TS parser."""
    text = affiliate_ts.read_text(encoding="utf-8")
    # Split on each product object boundary inside PRODUCTS: [...]. Objects
    # are always `{ id: '...', ... },` at one nesting level — split on lines
    # starting a new object via the `id:` field as the anchor.
    products = []
    for block in re.split(r"\n\s*\{\s*\n", text)[1:]:
        id_m = re.search(r"""id:\s*['"]([^'"]+)['"]""", block)
        if not id_m:
            continue
        asin_m = re.search(r"""asin:\s*['"]([^'"]+)['"]""", block)
        search_m = re.search(r"""searchQuery:\s*['"]([^'"]+)['"]""", block)
        products.append({
            "id": id_m.group(1),
            "asin": asin_m.group(1) if asin_m else None,
            "searchQuery": search_m.group(1) if search_m else None,
        })
    return products


def check_link(url: str, timeout: int):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (affiliate-link-check)"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.status
            body = resp.read(200_000).decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        status = e.code
        body = e.read(200_000).decode("utf-8", errors="ignore") if e.fp else ""
    except Exception as e:
        return {"classification": "broken-redirect", "detail": f"request failed: {e}"}

    if status < 200 or status >= 300:
        # urllib follows redirects itself, so a non-2xx here means the final
        # hop (often the /go/<id> cloak path itself) is broken.
        return {"classification": "broken-redirect", "detail": f"HTTP {status}"}

    body_lower = body.lower()
    if any(m in body_lower for m in ANTI_BOT_MARKERS):
        return {"classification": "inconclusive", "detail": "anti-bot wall"}
    if OOS_MARKER in body_lower:
        return {"classification": "oos", "detail": OOS_MARKER}
    for marker in SOFT_404_MARKERS:
        if marker.lower() in body_lower:
            return {"classification": "dead", "detail": marker}
    return {"classification": "healthy", "detail": None}


def grep_referencing_pages(content_path: Path, go_prefix: str, product_id: str):
    if not content_path.is_dir():
        return []
    try:
        out = subprocess.run(
            ["grep", "-rl", f"{go_prefix}{product_id}/", str(content_path)],
            capture_output=True, text=True, timeout=10,
        )
        return [line.strip() for line in out.stdout.splitlines() if line.strip()]
    except Exception:
        return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-root", required=True)
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--go-prefix", default="/go/")
    ap.add_argument("--content-path", default="site/src/content")
    ap.add_argument("--affiliate-registry", default="site/src/lib/affiliate.ts")
    ap.add_argument("--tag", default="")
    ap.add_argument("--site-brand", default="")
    ap.add_argument("--slack-channel", default="")
    ap.add_argument("--notify-script", default="ops/scripts/notify-slack.sh")
    ap.add_argument("--state-file", default="ops/state/affiliate-oos.json")
    ap.add_argument("--findings-file", default="ops/cache/affiliate-check-findings.json")
    ap.add_argument("--timeout", type=int, default=15)
    args = ap.parse_args()

    repo_root = Path(args.repo_root)
    registry = repo_root / args.affiliate_registry
    if not registry.is_file():
        log(f"registry not found at {registry} — cannot run, treating as clean (fail open)")
        sys.exit(0)

    products = parse_products(registry)
    if not products:
        log("no products parsed from registry — treating as clean (fail open)")
        sys.exit(0)

    today = datetime.date.today().isoformat()
    state_path = repo_root / args.state_file
    try:
        oos_state = json.loads(state_path.read_text()) if state_path.is_file() else {}
    except Exception:
        oos_state = {}

    results = {}
    for p in products:
        url = f"{args.base_url.rstrip('/')}{args.go_prefix}{p['id']}/"
        results[p["id"]] = {**p, "url": url, **check_link(url, args.timeout)}
        log(f"{p['id']}: {results[p['id']]['classification']} ({results[p['id']]['detail']})")

    seen_oos_ids = {pid for pid, r in results.items() if r["classification"] == "oos"}
    new_state = {}
    oos_to_file = []
    for pid in seen_oos_ids:
        if pid in oos_state:
            oos_to_file.append(pid)  # 2nd+ consecutive run — file it, drop from watch state
        else:
            new_state[pid] = today  # first sighting — just watch
    # anything previously watched but not OOS this run has restocked — dropped implicitly

    dead = {pid: r for pid, r in results.items() if r["classification"] == "dead"}
    broken = {pid: r for pid, r in results.items() if r["classification"] == "broken-redirect"}
    inconclusive = {pid: r for pid, r in results.items() if r["classification"] == "inconclusive"}
    healthy_count = sum(1 for r in results.values() if r["classification"] == "healthy")

    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(new_state, indent=2, sort_keys=True) + "\n")

    needs_ai = bool(dead or broken or oos_to_file)

    if not needs_ai:
        summary = (
            f"{healthy_count}/{len(products)} resolved "
            f"({len(inconclusive)} inconclusive anti-bot walls, 0 dead)."
        )
        log(f"clean run — {summary}")
        if args.slack_channel:
            notify = repo_root / args.notify_script
            if notify.is_file():
                text = f"✅ {args.site_brand} affiliate audit — {today}: {summary}".strip()
                subprocess.run(["bash", str(notify), args.slack_channel, text], cwd=str(repo_root))
        sys.exit(0)

    findings = {
        "generated_at": today,
        "dead": {
            pid: {
                **r,
                "referencing_pages": grep_referencing_pages(repo_root / args.content_path, args.go_prefix, pid),
            }
            for pid, r in dead.items()
        },
        "oos_to_file": {
            pid: {
                **results[pid],
                "referencing_pages": grep_referencing_pages(repo_root / args.content_path, args.go_prefix, pid),
            }
            for pid in oos_to_file
        },
        "broken_redirect": {
            pid: {
                **r,
                "suggested_target": (
                    f"https://www.amazon.com/dp/{r['asin']}?tag={args.tag}" if r.get("asin") and args.tag else None
                ),
            }
            for pid, r in broken.items()
        },
        "inconclusive_count": len(inconclusive),
        "healthy_count": healthy_count,
        "total_checked": len(products),
    }
    findings_path = repo_root / args.findings_file
    findings_path.parent.mkdir(parents=True, exist_ok=True)
    findings_path.write_text(json.dumps(findings, indent=2, sort_keys=True) + "\n")
    log(f"needs filing — {len(dead)} dead, {len(broken)} broken redirect, {len(oos_to_file)} OOS threshold hit")
    sys.exit(1)


if __name__ == "__main__":
    main()
