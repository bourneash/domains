#!/usr/bin/env python3
"""collect_registrar.py — pull domain renewal facts from Cloudflare Registrar.

Why this exists
---------------
The portfolio's single largest recurring hard cost is domain renewals, and
until now nothing in the project knew when any of them fell due. The parked
inventory view (F51) had a "Renewal" column that read "unknown" for all 23
scaffolds because there was nowhere to read it from — the registry's
`registrar_expires` is hand-owned and nobody hand-owns it.

Cloudflare is the registrar for these domains and already answers the question
over an API this repo has a token for. So: collect it, cache it, and let the
dashboard and the cron read the cache.

DESIGN NOTES
------------
* **Cache to disk, never live in a request.** The dashboard must not depend on
  a third-party API being up to render a tab, and the API must not be hit once
  per page view. Same division of labour as cf-stats and the lint sweep: a
  scheduled collector owns the network call, everything else reads the file.
* **A domain absent from Cloudflare is reported, not assumed.** Some domains in
  the registry may be registered elsewhere; saying "unknown" is correct, and
  silently treating them as fine is not.
* **auto_renew is part of the answer.** An expiry date 40 days out means
  something completely different depending on whether it renews itself. A
  domain with auto_renew off IS the alert.
* Zero AI, no writes to the registry. This tool only produces a cache file.

Usage
-----
    python3 tools/registrar/collect_registrar.py            # refresh cache, table
    python3 tools/registrar/collect_registrar.py --json
    python3 tools/registrar/collect_registrar.py --days 90  # what's due inside 90d
    python3 tools/registrar/collect_registrar.py --check    # exit 1 if anything needs attention
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parent
ROOT = TOOL_DIR.parent.parent
CACHE = TOOL_DIR / "cache"
REGISTRY = ROOT / "registry" / "fleet.yaml"
LAPSING = TOOL_DIR / "lapsing.yaml"
API = "https://api.cloudflare.com/client/v4"

# Renewal windows. 90 days is the "start thinking about it" horizon for a
# domain you might sunset (F2); 30 is the "this is happening" one.
WARN_DAYS = 90
URGENT_DAYS = 30


def log(msg: str) -> None:
    print(f"[registrar] {msg}", file=sys.stderr, flush=True)


def env_from_dotenv(name: str) -> str | None:
    """Read a var from the process env, falling back to the repo .env.

    The .env is chmod 400 and not exported into every shell, so a cron or a
    hand-run may legitimately not have it loaded.
    """
    if os.environ.get(name):
        return os.environ[name]
    envf = ROOT / ".env"
    if not envf.exists():
        return None
    try:
        for line in envf.read_text(encoding="utf-8").splitlines():
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1].strip().strip("'\"")
    except PermissionError:
        return None
    return None


def registry_domains() -> dict[str, str]:
    """domain -> status, from the canonical registry. Narrow reader, no PyYAML
    dependency (same rationale as tools/link-rot/link-sweep.py)."""
    out: dict[str, str] = {}
    if not REGISTRY.exists():
        return out
    current = None
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
        s = raw.strip()
        if current and s.startswith("status:"):
            out[current] = s.split(":", 1)[1].strip()
    return out


def lapsing_domains() -> set[str]:
    """Domains deliberately left to expire — see lapsing.yaml. Narrow reader,
    same rationale as registry_domains(): no PyYAML dependency for a two-level
    map of `domain: { since, note }`."""
    out: set[str] = set()
    if not LAPSING.exists():
        return out
    in_domains = False
    for raw in LAPSING.read_text(encoding="utf-8").splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if raw.startswith("domains:"):
            in_domains = True
            continue
        if not in_domains:
            continue
        if raw.startswith("  ") and not raw.startswith("    "):
            name = raw.strip().split(":", 1)[0].strip()
            if name:
                out.add(name)
    return out


def fetch_registrar(account: str, token: str) -> tuple[list[dict], int | None]:
    """Every domain Cloudflare Registrar will actually hand over, plus the count
    it CLAIMS to have.

    The registrar endpoint is erratic about paging and it matters:

      per_page=100 -> 0 rows          (silently empty)
      per_page=50  -> 16 rows         (short, and not the first 50 alphabetically)
      per_page=10  -> 10 rows/page, honestly, until it runs out
      one page past the end -> HTTP 400, not an empty result

    It also reports total_count=66 while only ever yielding 56 distinct domains
    — the remainder are presumably in a state the list endpoint omits. So this
    returns BOTH the rows it got and the claimed total, and the caller surfaces
    the discrepancy. A collector that quietly reported 16 of 66 as the whole
    picture is exactly the failure this guards against; the first version of
    this function did that.
    """
    seen: dict[str, dict] = {}
    claimed: int | None = None
    empty_pages = 0
    for page in range(1, 41):  # hard cap: 400 domains, never an unbounded loop
        url = f"{API}/accounts/{account}/registrar/domains?per_page=10&page={page}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code == 400:
                break  # walked off the end; this is how the API says "done"
            raise
        if not body.get("success"):
            raise RuntimeError(f"Cloudflare API error: {body.get('errors')}")
        info = body.get("result_info") or {}
        if info.get("total_count") is not None:
            claimed = info["total_count"]
        batch = body.get("result") or []
        for d in batch:
            if d.get("name"):
                seen[d["name"]] = d
        if not batch:
            empty_pages += 1
            if empty_pages >= 2:
                break
        else:
            empty_pages = 0
        if claimed and len(seen) >= claimed:
            break
    return list(seen.values()), claimed


def days_until(iso: str | None) -> int | None:
    if not iso:
        return None
    try:
        # Cloudflare returns e.g. 2027-06-29T04:20:12.000Z
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (dt - datetime.now(timezone.utc)).days


def build(account: str, token: str) -> dict:
    raw, claimed = fetch_registrar(account, token)
    reg = registry_domains()
    lapsing = lapsing_domains()

    rows = []
    by_name = {}
    for d in raw:
        name = d.get("name")
        if not name:
            continue
        expires = d.get("expires_at")
        row = {
            "domain": name,
            "expires_at": expires,
            "days_to_renewal": days_until(expires),
            "auto_renew": bool(d.get("auto_renew")),
            "locked": bool(d.get("locked")),
            "registry_status": reg.get(name),           # live / scaffold / absent
            "in_fleet_registry": name in reg,
        }
        # An expiry inside the window is only a problem if nothing renews it
        # automatically. Say which of the two situations this is, rather than
        # colouring every upcoming date red and training people to ignore it.
        if name in lapsing:
            # A decision already made, not one pending — don't alert on it,
            # but say so rather than making the domain look clean.
            row["attention"] = None
            row["lapsing"] = True
        elif row["days_to_renewal"] is None:
            row["attention"] = "no expiry date returned"
        elif not row["auto_renew"] and row["days_to_renewal"] <= WARN_DAYS:
            row["attention"] = "auto-renew OFF and renewal due"
        elif row["days_to_renewal"] <= URGENT_DAYS and not row["auto_renew"]:
            row["attention"] = "expires soon, auto-renew OFF"
        else:
            row["attention"] = None
        row.setdefault("lapsing", False)
        rows.append(row)
        by_name[name] = row

    # Registry entries Cloudflare does not hold. Not an error — a domain can be
    # registered elsewhere — but it IS the set nothing can answer for.
    unknown = sorted(d for d in reg if d not in by_name)

    rows.sort(key=lambda r: (r["days_to_renewal"] is None, r["days_to_renewal"]))
    return {
        "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S%z"),
        "source": "cloudflare-registrar",
        "totals": {
            "domains": len(rows),
            "auto_renew_off": sum(1 for r in rows if not r["auto_renew"]),
            "due_90d": sum(1 for r in rows if (r["days_to_renewal"] or 9999) <= WARN_DAYS),
            "due_30d": sum(1 for r in rows if (r["days_to_renewal"] or 9999) <= URGENT_DAYS),
            "needs_attention": sum(1 for r in rows if r["attention"]),
            "in_registry_not_at_cloudflare": len(unknown),
            # What the API says it has vs what it actually handed over. These
            # differ (66 vs 56) and the gap must stay visible: a renewal we
            # cannot see is exactly the one that bites.
            "claimed_by_cloudflare": claimed,
            "retrieved": len(rows),
            "unretrievable": (claimed - len(rows)) if claimed else None,
        },
        "domains": rows,
        "not_at_cloudflare": unknown,
    }


def write_cache(payload: dict) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    tmp = CACHE / "latest.json.tmp"
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    out = CACHE / "latest.json"
    tmp.replace(out)  # atomic: never a half-written cache
    return out


def table(p: dict, days: int | None) -> None:
    t = p["totals"]
    print(f"{'domain':<28} {'expires':<12} {'in':>6}  auto  status")
    print("-" * 72)
    for r in p["domains"]:
        if days is not None and (r["days_to_renewal"] or 9999) > days:
            continue
        exp = (r["expires_at"] or "")[:10] or "-"
        dd = "-" if r["days_to_renewal"] is None else f"{r['days_to_renewal']}d"
        auto = "yes" if r["auto_renew"] else "NO"
        flag = r["attention"] or ("lapsing (intentional)" if r["lapsing"] else (r["registry_status"] or "not in registry"))
        print(f"{r['domain']:<28} {exp:<12} {dd:>6}  {auto:<4}  {flag}")
    print("-" * 72)
    print(
        f"{t['domains']} domains · {t['due_90d']} due in 90d · {t['due_30d']} in 30d · "
        f"{t['auto_renew_off']} with auto-renew OFF · {t['needs_attention']} need attention"
    )
    if t.get("unretrievable"):
        print(
            f"\nNOTE: Cloudflare reports {t['claimed_by_cloudflare']} domains on this account but "
            f"only returns {t['retrieved']}. {t['unretrievable']} are not retrievable via the list "
            f"endpoint and have NO renewal data here."
        )
    if p["not_at_cloudflare"]:
        print(f"\nIn the fleet registry but NOT at Cloudflare Registrar ({len(p['not_at_cloudflare'])}):")
        print("  " + ", ".join(p["not_at_cloudflare"]))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--days", type=int, help="only show domains renewing within N days")
    ap.add_argument("--check", action="store_true", help="exit 1 if any domain needs attention")
    ap.add_argument("--no-write", action="store_true", help="do not update the cache")
    args = ap.parse_args()

    account = env_from_dotenv("CF_ACCOUNT_ID") or env_from_dotenv("CLOUDFLARE_ACCOUNT_ID")
    token = env_from_dotenv("CF_API_TOKEN") or env_from_dotenv("CLOUDFLARE_API_TOKEN")
    if not account or not token:
        log("CF_ACCOUNT_ID / CF_API_TOKEN not available (repo .env is chmod 400 — run as jesse)")
        return 2

    try:
        payload = build(account, token)
    except Exception as e:  # noqa: BLE001
        log(f"collection failed: {e}")
        return 2

    if not args.no_write:
        write_cache(payload)

    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        table(payload, args.days)

    if args.check and payload["totals"]["needs_attention"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
