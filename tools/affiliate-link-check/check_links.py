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


def parse_products_frontmatter_dir(products_dir: Path):
    """shoptopless.com-style registry: one markdown file per product at
    <dir>/<slug>.md, filename stem is the id, ASIN in `amazonAsin:` frontmatter."""
    products = []
    for f in sorted(products_dir.glob("*.md")):
        text = f.read_text(encoding="utf-8", errors="ignore")
        asin_m = re.search(r"""amazonAsin:\s*["']?([A-Z0-9]{10})["']?""", text)
        products.append({
            "id": f.stem,
            "asin": asin_m.group(1) if asin_m else None,
            "searchQuery": None,
        })
    return products


def parse_products(affiliate_ts: Path):
    """Extract id/asin/searchQuery per product from the registry via regex.
    Good enough for the fixed object-literal shapes used across the fleet
    (TS array-of-objects, TS `Record<string, X>` objects e.g.
    weapontester.com's AFFILIATE_LINKS, and plain JSON e.g.
    broadwayshowgirls.com's ops/affiliate/products.json) — not a general
    TS/JSON parser."""
    if affiliate_ts.is_dir():
        return parse_products_frontmatter_dir(affiliate_ts)
    text = affiliate_ts.read_text(encoding="utf-8")
    # Anchor on each `id: '...'` field and take a fixed window of following
    # text as "the rest of this object" to search asin/searchQuery in. Avoids
    # needing to correctly locate the enclosing `{` (which varies: `{` alone
    # on its own line in a PRODUCTS array, vs. `'key': {` on one line in a
    # `Record<string, X>` object, e.g. weapontester.com's AFFILIATE_LINKS).
    products = []
    WINDOW = 600
    for id_m in re.finditer(r"""["']?\bid["']?\s*:\s*['"]([^'"]+)['"]""", text):
        block = text[id_m.end():id_m.end() + WINDOW]
        asin_m = re.search(r"""["']?asin["']?\s*:\s*['"]([^'"]+)['"]""", block)
        search_m = re.search(r"""searchQuery:\s*['"]([^'"]+)['"]""", block)
        products.append({
            "id": id_m.group(1),
            "asin": asin_m.group(1) if asin_m else None,
            "searchQuery": search_m.group(1) if search_m else None,
        })
    return products


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # never auto-follow — we need to classify each hop separately


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect)
_UA = {"User-Agent": "Mozilla/5.0 (affiliate-link-check)"}


def _classify_landing_body(land_status: int, body: str):
    """Shared final classification step: given a landing-page HTTP status and
    body, decide dead / oos / inconclusive / healthy. Used both after a /go/
    cloak resolves (check_link) and for direct-link sites with no cloak hop
    at all (check_link_direct) — same Amazon-side failure modes either way,
    so the classification logic shouldn't be duplicated per site shape."""
    if land_status != 200:
        # Amazon-side error (rate-limit, 5xx, etc.) — not our infra's fault.
        return {"classification": "inconclusive", "detail": f"landing page HTTP {land_status}"}
    body_lower = body.lower()
    if any(m in body_lower for m in ANTI_BOT_MARKERS):
        return {"classification": "inconclusive", "detail": "anti-bot wall"}
    if OOS_MARKER in body_lower:
        return {"classification": "oos", "detail": OOS_MARKER}
    for marker in SOFT_404_MARKERS:
        if marker.lower() in body_lower:
            return {"classification": "dead", "detail": marker}
    return {"classification": "healthy", "detail": None}


def check_link_direct(url: str, timeout: int):
    """For sites with NO local cloak/redirect (e.g. broadwayshowgirls.com's
    direct `https://www.amazon.com/dp/<ASIN>/?tag=...` links, per its
    affiliate-editor.md: "This site uses DIRECT affiliate links — there is
    NO /go/ cloaking"). One fetch, classified the same way a resolved /go/
    redirect's landing page would be — there's no "our infra broke the
    redirect" failure mode to distinguish here, since there's no redirect."""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=_UA), timeout=timeout) as resp:
            status = resp.status
            body = resp.read(200_000).decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        status = e.code
        body = e.read(200_000).decode("utf-8", errors="ignore") if e.fp else ""
    except Exception as e:
        return {"classification": "inconclusive", "detail": f"request failed: {e}"}
    return _classify_landing_body(status, body)


def check_link(go_url: str, timeout: int):
    """Two-hop check, classified by WHO owns the failure:
    - our /go/<id> cloak not resolving to a redirect at all -> broken-redirect
      (our infra, file an engineering task)
    - the redirect resolves fine but the landing page (Amazon) errors,
      rate-limits, or anti-bot-walls us -> inconclusive (not our infra, never
      file a task for this — was the root cause of a 2026-07-22 false positive
      on americastrikes.com: a transient Amazon 503 got misread as our cloak
      being broken when curl -IL against the same URL showed a clean 302)
    - the redirect resolves and the landing page loads (200) -> classify by
      body markers as today (dead / oos / healthy)
    """
    req = urllib.request.Request(go_url, headers=_UA)
    own_body = ""
    try:
        resp = _NO_REDIRECT_OPENER.open(req, timeout=timeout)
        status, location = resp.status, resp.headers.get("Location")
        if status not in (301, 302, 303, 307, 308):
            own_body = resp.read(200_000).decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            status, location = e.code, e.headers.get("Location")
        else:
            return {"classification": "broken-redirect", "detail": f"cloak returned HTTP {e.code}"}
    except Exception as e:
        return {"classification": "broken-redirect", "detail": f"cloak request failed: {e}"}

    if status not in (301, 302, 303, 307, 308):
        # Some sites (e.g. ultrarough.com) cloak via a static HTTP-200 page with a
        # meta-refresh / JS redirect instead of a real HTTP 3xx. Extract the target
        # from the body and treat it exactly like a real redirect below — otherwise
        # a dead ASIN behind one of these pages would be invisible to this check.
        m = re.search(r'''url\s*=\s*["']?(https://[^"'\s>]+)''', own_body, re.IGNORECASE)
        if m:
            location = m.group(1)
        else:
            # No redirect target found in the body at all — either this cloak
            # genuinely serves content directly, or it's broken. Check the body
            # itself for soft-404/anti-bot markers rather than assuming healthy.
            body_lower = own_body.lower()
            if any(mk in body_lower for mk in ANTI_BOT_MARKERS):
                return {"classification": "inconclusive", "detail": "anti-bot wall"}
            for marker in SOFT_404_MARKERS:
                if marker.lower() in body_lower:
                    return {"classification": "dead", "detail": marker}
            return {"classification": "healthy", "detail": "cloak returned 2xx directly (no redirect target found)"}
    if not location:
        return {"classification": "broken-redirect", "detail": f"HTTP {status} with no Location header"}

    try:
        with urllib.request.urlopen(urllib.request.Request(location, headers=_UA), timeout=timeout) as resp2:
            land_status = resp2.status
            body = resp2.read(200_000).decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e2:
        land_status = e2.code
        body = e2.read(200_000).decode("utf-8", errors="ignore") if e2.fp else ""
    except Exception as e2:
        return {"classification": "inconclusive", "detail": f"landing page request failed: {e2}"}

    return _classify_landing_body(land_status, body)


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


def grep_referencing_pages_direct(repo_root: Path, asin: str):
    """Direct-link sites (no /go/<id>/ cloak) don't reference products by id
    in content — they render from the registry via productUrl(asin). Grep
    the whole repo for the ASIN itself instead, same spirit as the role
    doc's own instruction ("grep site/src/ and ops/affiliate/products.json
    for the asin")."""
    if not asin:
        return []
    try:
        out = subprocess.run(
            ["grep", "-rl", asin, str(repo_root / "site" / "src")],
            capture_output=True, text=True, timeout=10,
        )
        return [line.strip() for line in out.stdout.splitlines() if line.strip()]
    except Exception:
        return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-root", required=True)
    ap.add_argument("--base-url", required=False, default="",
                     help="required unless --direct (direct-link sites check "
                          "https://www.amazon.com/dp/<asin>/ directly, no local base URL involved)")
    ap.add_argument("--direct", action="store_true",
                     help="no /go/<id>/ cloak — check the ASIN's Amazon URL directly "
                          "(e.g. broadwayshowgirls.com: 'DIRECT affiliate links — there is "
                          "NO /go/ cloaking' per its affiliate-editor.md). Requires --tag.")
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
    ap.add_argument("--delay", type=float, default=0.75,
                     help="seconds to sleep between checks — Amazon rate-limits rapid "
                          "back-to-back requests from one IP, which shows up as false "
                          "'inconclusive' (not false 'broken', so it fails safe, but a "
                          "small delay keeps the fleet's real weekly detection rate high)")
    args = ap.parse_args()

    if args.direct and not args.tag:
        log("--direct requires --tag (used to build the direct Amazon URL) — exiting")
        sys.exit(2)
    if not args.direct and not args.base_url:
        log("--base-url is required unless --direct is set — exiting")
        sys.exit(2)

    repo_root = Path(args.repo_root)
    registry = repo_root / args.affiliate_registry
    if not registry.is_file() and not registry.is_dir():
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

    import time
    results = {}
    for i, p in enumerate(products):
        if i > 0 and args.delay > 0:
            time.sleep(args.delay)
        if args.direct:
            if not p.get("asin"):
                results[p["id"]] = {**p, "url": None, "classification": "broken-redirect",
                                     "detail": "no asin in registry"}
                log(f"{p['id']}: broken-redirect (no asin in registry)")
                continue
            url = f"https://www.amazon.com/dp/{p['asin']}/?tag={args.tag}"
            results[p["id"]] = {**p, "url": url, **check_link_direct(url, args.timeout)}
        else:
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
    state_changed = new_state != oos_state
    state_path.write_text(json.dumps(new_state, indent=2, sort_keys=True) + "\n")

    needs_ai = bool(dead or broken or oos_to_file)

    if state_changed and not needs_ai:
        # On the dirty path, the state file is left staged-but-uncommitted —
        # the Claude invocation that follows commits it alongside whatever
        # task file(s) it files, in one commit, per the role's existing spec.
        # On the clean path there's no Claude turn to do that, so commit it
        # here (best-effort — never fail the run over a git hiccup).
        try:
            subprocess.run(["git", "add", str(args.state_file)], cwd=str(repo_root), check=True, capture_output=True)
            subprocess.run(
                ["git", "commit", "-m", f"affiliate: update OOS watch-state ({today})"],
                cwd=str(repo_root), check=True, capture_output=True,
            )
            subprocess.run(["git", "push"], cwd=str(repo_root), check=True, capture_output=True, timeout=30)
            log("committed + pushed OOS watch-state change")
        except Exception as e:
            log(f"warning: could not commit/push OOS state change: {e}")

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

    def _referencing_pages(pid, r):
        if args.direct:
            return grep_referencing_pages_direct(repo_root, r.get("asin"))
        return grep_referencing_pages(repo_root / args.content_path, args.go_prefix, pid)

    findings = {
        "generated_at": today,
        "dead": {
            pid: {
                **r,
                "referencing_pages": _referencing_pages(pid, r),
            }
            for pid, r in dead.items()
        },
        "oos_to_file": {
            pid: {
                **results[pid],
                "referencing_pages": _referencing_pages(pid, results[pid]),
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
