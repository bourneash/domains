#!/usr/bin/env python3
"""link-sweep.py — fleet-wide broken-link sweep. Zero AI.

Why this exists
---------------
The fleet already checks two narrow slices of its links and nothing else:

  tools/affiliate-link-check   — /go/<id> affiliate cloaks only
  domains-audit-article-images — <img> sources, per site, one site at a time

Nothing checks the ordinary links: a nav item pointing at a page that was
renamed, an editorial outbound reference that died, a cross-site link to a
sister property whose slug changed, or a chain of redirects that costs a
round trip on every hit. Across 27 live sites those rot continuously and
silently — an internal 404 is both an SEO cost (crawl budget spent on dead
ends, orphaned pages) and a trust cost, and it is trivially machine-detectable.
There is no reason a human or an AI role should be the thing that finds one.

No AI runs here, ever. Detection is HTTP plus a regex over anchors — same
contract as the lint sweep and the affiliate check.

What it checks
--------------
  internal    — a link to the same host. The link target must resolve. This is
                the signal that matters most and costs least: the page set
                comes from the site's own sitemap, so a hit is authoritative.
  cross-site  — a link to another domain in the fleet. Checked the same way as
                internal, and reported separately, because a fleet-internal 404
                is a link WE broke and can fix, unlike a third party's.
  outbound    — everything else. OFF by default (--outbound): it is slow, it
                hits third parties, and its failures are frequently transient
                or bot-blocked rather than genuinely rotten.

Redirect chains are reported wherever they appear: a 200 reached through two
or more hops is not broken, but it is a fixable cost, and it is how a link
quietly becomes broken later.

Usage
-----
    python3 tools/link-rot/link-sweep.py                     # table, all live sites
    python3 tools/link-rot/link-sweep.py --json
    python3 tools/link-rot/link-sweep.py --site 0daynews.com
    python3 tools/link-rot/link-sweep.py --outbound          # include third parties
    python3 tools/link-rot/link-sweep.py --fail-on-new       # cron/CI gate
    python3 tools/link-rot/link-sweep.py --max-pages 50

Every run writes reports/latest.json and appends reports/history.jsonl, so
"what broke since last time" is computed from real history, not guessed.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import gzip
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parent
ROOT = TOOL_DIR.parent.parent
REPORTS = TOOL_DIR / "reports"
REGISTRY = ROOT / "registry" / "fleet.yaml"

UA = "fleet-link-sweep/1.0 (+https://github.com/bourneash; portfolio self-check)"
TIMEOUT = 15

# Anchors only. <img>/<script>/<link rel> are deliberately out of scope: images
# already have their own auditor (domains-audit-article-images) and assets fail
# loudly in the build. Duplicating them here would mean two tools disagreeing.
A_HREF = re.compile(rb"""<a\b[^>]*?\bhref\s*=\s*["']([^"'>]+)["']""", re.I)

# Inline <script>/<style> bodies are stripped before anchors are matched. A
# client-side renderer that builds markup from a template string puts a literal
# `<a href="${item.href}">` in the page source; minified, that reads
# `${t.href}`, and the anchor regex above happily reports it as a broken link
# to /articles/${t.href}. It was the first false positive this sweep produced
# (saveusfarms.com, 2026-09-01). Those anchors are not links until the script
# runs, and what they resolve to is not knowable from the HTML.
SCRIPT_STYLE = re.compile(rb"(?is)<(script|style)\b.*?</\1\s*>")
SITEMAP_LOC = re.compile(rb"<loc>\s*([^<\s]+)\s*</loc>", re.I)

# Schemes that are not web links and must never be reported as broken.
SKIP_SCHEMES = ("mailto:", "tel:", "javascript:", "data:", "sms:", "#")

# A link the fleet cloaks on purpose. /go/* is the affiliate redirector and is
# owned end-to-end by tools/affiliate-link-check, which knows about ASINs, OOS
# markers and Amazon's anti-bot pages. Checking it here would produce a second,
# dumber verdict on the same URL and train people to ignore both.
OWNED_ELSEWHERE = re.compile(r"^/go/")


def log(msg: str) -> None:
    print(f"[link-sweep] {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------- registry


def load_live_sites(only: list[str] | None) -> list[str]:
    """Live domains from the canonical registry. Parsed with a narrow reader
    rather than PyYAML so this tool has no dependency to install on a host or
    in a container — the registry's shape is machine-generated and stable
    (see tools/fleet-registry/build_registry.py)."""
    if not REGISTRY.exists():
        log(f"no registry at {REGISTRY}")
        return []
    sites: list[str] = []
    current: str | None = None
    in_sites = False
    for raw in REGISTRY.read_text(encoding="utf-8").splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if raw.startswith("sites:"):
            in_sites = True
            continue
        if not in_sites:
            continue
        if raw.startswith("  ") and not raw.startswith("    ") and raw.rstrip().endswith(":"):
            current = raw.strip().rstrip(":")
            continue
        if current and raw.strip() == "status: live":
            sites.append(current)
    if only:
        want = set(only)
        missing = want - set(sites)
        if missing:
            log(f"not live in the registry, skipping: {', '.join(sorted(missing))}")
        sites = [s for s in sites if s in want]
    return sorted(sites)


# ---------------------------------------------------------------- http


def fetch(url: str, method: str = "GET", max_hops: int = 6):
    """Fetch, following redirects by hand so the chain is observable.

    Returns (status, final_url, hops, body_bytes_or_None, error_or_None).
    urllib's default opener follows redirects silently, which would hide
    exactly the thing we want to report.
    """
    hops: list[str] = []
    seen: set[str] = set()
    cur = url
    for _ in range(max_hops):
        if cur in seen:
            return (None, cur, hops, None, "redirect loop")
        seen.add(cur)
        req = urllib.request.Request(cur, method=method, headers={"User-Agent": UA})
        try:
            opener = urllib.request.build_opener(_NoRedirect)
            with opener.open(req, timeout=TIMEOUT) as resp:
                body = resp.read() if method == "GET" else None
                return (resp.status, cur, hops, body, None)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308):
                loc = e.headers.get("Location")
                if not loc:
                    return (e.code, cur, hops, None, "redirect with no Location")
                nxt = urllib.parse.urljoin(cur, loc)
                hops.append(nxt)
                cur = nxt
                continue
            # A HEAD rejected as 405/403 is a server preference, not a dead
            # link. Say so rather than reporting a false break.
            return (e.code, cur, hops, None, None)
        except Exception as e:  # noqa: BLE001 — network, DNS, TLS, timeouts all read the same here
            return (None, cur, hops, None, type(e).__name__)
    return (None, cur, hops, None, f"more than {max_hops} redirects")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kw):
        return None


def sitemap_urls(base: str, cap: int) -> list[str]:
    """URLs from the site's sitemap, following a sitemap index one level.

    The sitemap is the right page universe: it is what the site claims to
    publish, it is what search engines crawl, and it costs one request. A
    breadth-first crawl would find orphaned pages too — but an orphan is a
    different finding for a different tool, and crawling 27 sites unbounded is
    how a "cheap check" becomes a thing nobody runs.
    """
    out: list[str] = []
    queue = [urllib.parse.urljoin(base, "/sitemap-index.xml"), urllib.parse.urljoin(base, "/sitemap.xml")]
    seen_maps: set[str] = set()
    while queue and len(out) < cap:
        sm = queue.pop(0)
        if sm in seen_maps:
            continue
        seen_maps.add(sm)
        status, _final, _hops, body, _err = fetch(sm)
        if status != 200 or not body:
            continue
        if sm.endswith(".gz"):
            try:
                body = gzip.decompress(body)
            except Exception:  # noqa: BLE001
                continue
        locs = [m.group(1).decode("utf-8", "replace") for m in SITEMAP_LOC.finditer(body)]
        for loc in locs:
            if loc.endswith(".xml") or loc.endswith(".xml.gz"):
                if len(seen_maps) < 25:
                    queue.append(loc)
            else:
                out.append(loc)
        if out:
            break  # a sitemap that yielded pages is the one; don't also read the fallback
    # Deduplicate while preserving order, then cap.
    seen: set[str] = set()
    uniq = [u for u in out if not (u in seen or seen.add(u))]
    return uniq[:cap]


# ---------------------------------------------------------------- classify


def classify(link: str, page: str, host: str, fleet_hosts: set[str]) -> tuple[str, str] | None:
    """(kind, absolute_url) or None when the link is not ours to judge."""
    link = link.strip()
    if not link or link.startswith(SKIP_SCHEMES):
        return None
    absolute = urllib.parse.urljoin(page, link)
    parsed = urllib.parse.urlparse(absolute)
    if parsed.scheme not in ("http", "https"):
        return None
    # Drop the fragment: /a#b and /a are the same request.
    absolute = urllib.parse.urlunparse(parsed._replace(fragment=""))
    lhost = parsed.netloc.lower().removeprefix("www.")
    if lhost == host:
        if OWNED_ELSEWHERE.match(parsed.path):
            return None
        return ("internal", absolute)
    if lhost in fleet_hosts:
        return ("cross-site", absolute)
    return ("outbound", absolute)


# ---------------------------------------------------------------- sweep


def sweep_site(domain: str, fleet_hosts: set[str], *, max_pages: int, outbound: bool, workers: int) -> dict:
    base = f"https://{domain}"
    t0 = time.time()
    pages = sitemap_urls(base, max_pages)
    if not pages:
        # No sitemap is itself worth saying out loud — it means this sweep is
        # blind here AND that search engines are working harder than they need
        # to. Report it instead of silently scoring the site clean.
        return {
            "site": domain,
            "error": "no sitemap (or it returned no page URLs)",
            "pages_scanned": 0,
            "links_checked": 0,
            "findings": [],
            "duration_s": round(time.time() - t0, 1),
        }

    # page -> [(kind, url)]
    refs: dict[str, list[tuple[str, str]]] = {}

    def load(page: str):
        status, final, _hops, body, err = fetch(page)
        if status != 200 or not body:
            return page, [], (status, err)
        # A page that redirects OFF this host is not this site's page any more.
        # The /go/* affiliate interstitials 302 to Amazon, so following them
        # meant parsing Amazon's search results and resolving ITS relative
        # hrefs against the shoppinkflamingo.com base — 1,599 imaginary broken
        # links in one sweep (2026-09-01). Whatever is at the far end belongs to
        # someone else and is not ours to audit.
        if urllib.parse.urlparse(final).netloc.lower().removeprefix("www.") != domain:
            return page, [], None
        found = []
        for m in A_HREF.finditer(SCRIPT_STYLE.sub(b"", body)):
            href = m.group(1).decode("utf-8", "replace")
            # Resolve against the URL the content actually came from, not the
            # one requested: with an on-host redirect (/a -> /a/) those differ,
            # and a relative href resolved against the pre-redirect path lands
            # one directory too high.
            c = classify(href, final, domain, fleet_hosts)
            if c:
                found.append(c)
        return page, found, None

    unreachable_pages = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        for page, found, bad in ex.map(load, pages):
            if bad:
                unreachable_pages.append({"page": page, "status": bad[0], "error": bad[1]})
                continue
            refs[page] = found

    # One check per distinct URL, not per occurrence: a nav link appears on
    # every page, and checking it 150 times would make the sweep's cost scale
    # with the site's size for no extra information.
    targets: dict[str, tuple[str, list[str]]] = {}
    for page, found in refs.items():
        for kind, url in found:
            if kind == "outbound" and not outbound:
                continue
            if url not in targets:
                targets[url] = (kind, [])
            if len(targets[url][1]) < 5:  # keep a few examples, not every referrer
                targets[url][1].append(page)

    def check(url: str):
        kind, _srcs = targets[url]
        # HEAD first — cheap. Cloudflare and most CDNs answer it correctly; a
        # server that refuses it gets a GET rather than a false "broken".
        status, final, hops, _b, err = fetch(url, method="HEAD")
        if status in (403, 405, 501) or status is None:
            status, final, hops, _b, err = fetch(url, method="GET")
        return url, status, final, hops, err

    findings: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        for url, status, final, hops, err in ex.map(check, list(targets)):
            kind, srcs = targets[url]
            if status is None:
                findings.append(
                    {"kind": kind, "issue": "unreachable", "url": url, "detail": err or "no response", "on": srcs}
                )
            elif status >= 400:
                findings.append(
                    {"kind": kind, "issue": "broken", "url": url, "status": status, "on": srcs}
                )
            elif len(hops) >= 2:
                findings.append(
                    {
                        "kind": kind,
                        "issue": "redirect-chain",
                        "url": url,
                        "status": status,
                        "hops": len(hops),
                        "final": final,
                        "on": srcs,
                    }
                )

    for u in unreachable_pages:
        findings.append(
            {
                "kind": "internal",
                "issue": "page-unreachable",
                "url": u["page"],
                "status": u["status"],
                "detail": u["error"],
                "on": ["<sitemap>"],
            }
        )

    # Broken before redirect-chain, internal before outbound: severity order,
    # so the top of the list is always the thing worth fixing first.
    sev = {"broken": 0, "unreachable": 1, "page-unreachable": 1, "redirect-chain": 2}
    kindord = {"internal": 0, "cross-site": 1, "outbound": 2}
    findings.sort(key=lambda f: (sev.get(f["issue"], 9), kindord.get(f["kind"], 9), f["url"]))

    return {
        "site": domain,
        "error": None,
        "pages_scanned": len(refs),
        "links_checked": len(targets),
        # The exact URLs this run put a request behind. Without it, a run with a
        # smaller --max-pages looks like a run where links got fixed: it simply
        # never re-checked them. Any consumer computing "fixed since last time"
        # (see tools/scripts/link-sweep-cron.sh) must intersect with this set
        # before claiming anything cleared.
        "checked": sorted(targets),
        "findings": findings,
        "duration_s": round(time.time() - t0, 1),
    }


# ---------------------------------------------------------------- reporting


def counts(findings: list[dict]) -> dict:
    c: dict[str, int] = defaultdict(int)
    for f in findings:
        c[f["issue"]] += 1
        if f["issue"] in ("broken", "unreachable", "page-unreachable"):
            c[f"{f['kind']}_dead"] += 1
    return dict(c)


def load_previous() -> dict:
    p = REPORTS / "latest.json"
    if not p.exists():
        return {}
    try:
        prev = json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}
    out = {}
    for s in prev.get("sites", []):
        out[s["site"]] = {(f["issue"], f["url"]) for f in s.get("findings", [])}
    return out


def write_reports(payload: dict) -> None:
    REPORTS.mkdir(parents=True, exist_ok=True)
    tmp = REPORTS / "latest.json.tmp"
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(REPORTS / "latest.json")  # atomic: never a half-written report
    summary = {
        "at": payload["at"],
        "sites": len(payload["sites"]),
        "dead": payload["totals"]["dead"],
        "chains": payload["totals"]["redirect_chains"],
    }
    with (REPORTS / "history.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(summary) + "\n")


def table(payload: dict, show_new: set) -> None:
    print(f"{'site':<26} {'pages':>5} {'links':>6} {'dead':>5} {'chain':>5}  worst")
    print("-" * 78)
    for s in payload["sites"]:
        if s["error"]:
            print(f"{s['site']:<26} {'-':>5} {'-':>6} {'-':>5} {'-':>5}  {s['error']}")
            continue
        c = counts(s["findings"])
        dead = c.get("broken", 0) + c.get("unreachable", 0) + c.get("page-unreachable", 0)
        chain = c.get("redirect-chain", 0)
        worst = ""
        for f in s["findings"]:
            if f["issue"] != "redirect-chain":
                worst = f"{f['kind']} {f['issue']}: {f['url'][:44]}"
                break
        print(f"{s['site']:<26} {s['pages_scanned']:>5} {s['links_checked']:>6} {dead:>5} {chain:>5}  {worst}")
    t = payload["totals"]
    print("-" * 78)
    print(
        f"{len(payload['sites'])} sites · {t['dead']} dead link(s) "
        f"({t['internal_dead']} internal, {t['cross_site_dead']} cross-site, {t['outbound_dead']} outbound) · "
        f"{t['redirect_chains']} redirect chain(s)"
    )
    if show_new:
        print(f"\nNEW since the last run: {len(show_new)}")
        for site, issue, url in sorted(show_new)[:20]:
            print(f"  {site:<24} {issue:<16} {url}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", action="append", help="limit to this domain (repeatable)")
    ap.add_argument("--max-pages", type=int, default=150, help="pages per site to read (default 150)")
    ap.add_argument("--workers", type=int, default=8, help="parallel requests (default 8)")
    ap.add_argument("--outbound", action="store_true", help="also check third-party links (slow)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument(
        "--fail-on-new",
        action="store_true",
        help="exit 1 only when a finding appeared that was not in the previous run",
    )
    ap.add_argument("--no-write", action="store_true", help="do not touch reports/")
    args = ap.parse_args()

    sites = load_live_sites(args.site)
    if not sites:
        log("no live sites to sweep")
        return 0
    fleet_hosts = {s.lower().removeprefix("www.") for s in load_live_sites(None)}

    previous = load_previous()
    results = []
    for d in sites:
        log(f"sweeping {d} …")
        results.append(
            sweep_site(d, fleet_hosts, max_pages=args.max_pages, outbound=args.outbound, workers=args.workers)
        )

    totals = {"dead": 0, "internal_dead": 0, "cross_site_dead": 0, "outbound_dead": 0, "redirect_chains": 0}
    new: set[tuple[str, str, str]] = set()
    for s in results:
        c = counts(s["findings"])
        totals["dead"] += c.get("broken", 0) + c.get("unreachable", 0) + c.get("page-unreachable", 0)
        totals["internal_dead"] += c.get("internal_dead", 0)
        totals["cross_site_dead"] += c.get("cross-site_dead", 0)
        totals["outbound_dead"] += c.get("outbound_dead", 0)
        totals["redirect_chains"] += c.get("redirect-chain", 0)
        was = previous.get(s["site"])
        if was is not None:  # a site with no history is not "all new"
            for f in s["findings"]:
                if (f["issue"], f["url"]) not in was:
                    new.add((s["site"], f["issue"], f["url"]))

    payload = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "outbound_checked": args.outbound,
        "max_pages": args.max_pages,
        "totals": totals,
        "sites": results,
    }

    if not args.no_write:
        write_reports(payload)

    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        table(payload, new)

    if args.fail_on_new:
        return 1 if new else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
