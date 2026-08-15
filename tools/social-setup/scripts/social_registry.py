#!/usr/bin/env python3
"""Thin CLI over the Fleet Dashboard social registry API.

This is the read/write surface the social-setup skill and the signup scripts
use instead of hand-editing a markdown table. The registry itself lives at
tools/social-setup/registry/social.json and is served by the Fleet Dashboard
(http://127.0.0.1:4754/api/social); this wrapper exists so callers don't have
to know about FD_TOKEN, JSON bodies, or persona ids.

Examples
--------
    # What needs doing, fleet-wide (the entry point — read this first)
    social_registry.py worklist

    # Record a successful signup
    social_registry.py set americastrikes.com bluesky \\
        --status active --handle americastrikes.bsky.social --creds

    # Report an account the platform killed
    social_registry.py set newmomshop.com instagram \\
        --status suspended --note "closed for spam 2026-08-15"

    # Persona account
    social_registry.py set saveusfarms.com pinterest \\
        --persona "Mara Okafor" --status stuck --note "silent submit failure"

Everything accepts --json to get the raw API response instead of the
human-readable rendering.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
BASE = os.environ.get("FD_URL", "http://127.0.0.1:4754")
ACTOR = os.environ.get("SOCIAL_REGISTRY_ACTOR", "social-setup")

TONE = {
    "green": "\033[32m", "yellow": "\033[33m", "orange": "\033[33m",
    "red": "\033[31m", "blue": "\033[36m", "gray": "\033[90m",
}
RESET = "\033[0m"


def _token():
    """FD_TOKEN from the environment, else the shared repo .env."""
    tok = os.environ.get("FD_TOKEN")
    if tok:
        return tok
    try:
        with open(os.path.join(REPO, ".env"), encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("FD_TOKEN="):
                    return line.split("=", 1)[1].strip().strip("'\"")
    except OSError:
        pass
    return None


def call(method, path, body=None, **params):
    qs = urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, "", False)})
    url = f"{BASE}{path}" + (f"?{qs}" if qs else "")
    data = None
    headers = {}
    tok = _token()
    if tok:
        headers["x-fd-token"] = tok
    if body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        try:
            detail = json.loads(detail).get("error", detail)
        except ValueError:
            pass
        sys.exit(f"error: {method} {path} -> HTTP {e.code}: {detail}")
    except urllib.error.URLError as e:
        sys.exit(
            f"error: cannot reach the fleet dashboard at {BASE} ({e.reason}).\n"
            "  Is it up?  cd tools/fleet-dashboard && docker compose --env-file ../../.env up -d"
        )


def color(tone, text):
    if not sys.stdout.isatty():
        return text
    return f"{TONE.get(tone, '')}{text}{RESET}"


def find_persona(site, name, create=False):
    """Resolve a persona name to its id, optionally creating it."""
    for p in call("GET", "/api/social/personas", site=site)["personas"]:
        if p["name"].lower() == name.lower():
            return p["id"]
    if not create:
        sys.exit(
            f"error: no persona named {name!r} on {site}. "
            f"Add it with:  social_registry.py add-persona {site} {name!r}   (or pass --create-persona)"
        )
    return call("POST", "/api/social/personas", {"site": site, "name": name, "actor": ACTOR})["persona"]["id"]


def fmt_account(a, show_site=True):
    who = a.get("personaName") or "brand"
    head = f"{a['site']}  " if show_site else ""
    handle = a.get("handle") or "-"
    note = a.get("statusNote") or ""
    line = (
        f"  {head}{a['platform']:<10} {who:<20} "
        f"{color(a.get('tone', 'gray'), a['status']):<20} {handle}"
    )
    if note:
        line += f"\n      └ {note}"
    return line


# ---- commands -------------------------------------------------------------
def cmd_worklist(args):
    w = call("GET", "/api/social/worklist")
    if args.json:
        print(json.dumps(w, indent=2))
        return
    s = w["summary"]
    print(f"{s['accounts']} accounts · {s['live']} live · "
          f"{color('red', str(s['needsAttention']) + ' need attention')} · "
          f"{s['personas']} personas across {s['eligibleSites']} eligible sites\n")
    if w["attention"]:
        print("NEEDS ATTENTION (broken accounts):")
        for r in w["attention"]:
            who = r.get("persona") or "brand"
            print(f"  [{r['action']}] {r['site']} {r['platform']} ({who}) — {r['status']}")
            if r.get("note"):
                print(f"      └ {r['note']}")
    else:
        print("NEEDS ATTENTION: none")
    print()
    if w["missing"]:
        print(f"NEVER ATTEMPTED ({len(w['missing'])} brand slots):")
        by_site = {}
        for r in w["missing"]:
            by_site.setdefault(r["site"], []).append(r["platform"])
        for site, plats in sorted(by_site.items()):
            print(f"  {site}: {', '.join(sorted(plats))}")
    else:
        print("NEVER ATTEMPTED: none — every eligible site has brand coverage")


def cmd_list(args):
    res = call(
        "GET", "/api/social/accounts",
        site=args.site, platform=args.platform, status=args.status, scope=args.scope,
        q=args.q, needsAttention="1" if args.needs_attention else None,
        live="1" if args.live else None,
    )
    if args.json:
        print(json.dumps(res, indent=2))
        return
    accounts = res["accounts"]
    if not accounts:
        print("(no matching accounts)")
        return
    site = None
    for a in accounts:
        if a["site"] != site:
            site = a["site"]
            print(f"\n{site}")
        print(fmt_account(a, show_site=False))
    print(f"\n{len(accounts)} account(s)")


def cmd_show(args):
    res = call("GET", "/api/social/accounts", site=args.site, platform=args.platform)
    accounts = res["accounts"]
    if args.persona:
        accounts = [a for a in accounts if (a.get("personaName") or "").lower() == args.persona.lower()]
    if args.json:
        print(json.dumps(accounts, indent=2))
        return
    if not accounts:
        print("(not recorded — nothing has been attempted for this slot)")
        return
    for a in accounts:
        print(json.dumps({k: a[k] for k in (
            "id", "site", "platform", "scope", "personaName", "handle", "profileUrl",
            "status", "statusNote", "credsInVault", "action", "updatedAt")}, indent=2))


def cmd_set(args):
    body = {
        "site": args.site, "platform": args.platform, "actor": ACTOR,
        "scope": "persona" if args.persona else "brand",
    }
    if args.persona:
        body["personaId"] = find_persona(args.site, args.persona, create=args.create_persona)
    if args.status:
        body["status"] = args.status
    if args.handle is not None:
        body["handle"] = args.handle
    if args.url is not None:
        body["profileUrl"] = args.url
    if args.note is not None:
        body["statusNote"] = args.note
    if args.notes is not None:
        body["notes"] = args.notes
    if args.creds:
        body["credsInVault"] = True
    if args.no_creds:
        body["credsInVault"] = False
    res = call("POST", "/api/social/accounts", body)
    if args.json:
        print(json.dumps(res, indent=2))
        return
    a = res["account"]
    print(f"ok  {a['site']} {a['platform']} ({a.get('personaName') or 'brand'}) -> "
          f"{color(a.get('tone', 'gray'), a['status'])}"
          + (f"   [{a['action']} needed]" if a.get("action") else ""))


def cmd_delete(args):
    res = call("GET", "/api/social/accounts", site=args.site, platform=args.platform)
    accounts = [a for a in res["accounts"]
                if (a.get("personaName") or "").lower() == (args.persona or "").lower()]
    if not accounts:
        sys.exit("error: no such account row")
    for a in accounts:
        call("DELETE", f"/api/social/accounts/{a['id']}", actor=ACTOR)
        print(f"deleted {a['site']} {a['platform']} ({a.get('personaName') or 'brand'})")


def cmd_personas(args):
    res = call("GET", "/api/social/personas", site=args.site)
    if args.json:
        print(json.dumps(res, indent=2))
        return
    for p in res["personas"]:
        flag = " (real person)" if p.get("realPerson") else ""
        print(f"  {p['site']:<26} {p['name']:<22} {p.get('beat', ''):<40} {p['accounts']} account(s){flag}")


def cmd_add_persona(args):
    res = call("POST", "/api/social/personas",
               {"site": args.site, "name": args.name, "beat": args.beat or "",
                "realPerson": args.real_person, "actor": ACTOR})
    print(f"ok  persona {res['persona']['name']} on {res['persona']['site']} ({res['persona']['id']})")


def cmd_site_meta(args):
    res = call("PUT", f"/api/social/sites/{urllib.parse.quote(args.site)}/meta",
               {"category": args.category, "note": args.note or "", "actor": ACTOR})
    print(f"ok  {args.site} -> {res['meta']['category']}")


def cmd_events(args):
    res = call("GET", "/api/social/events", limit=args.limit, site=args.site)
    if args.json:
        print(json.dumps(res, indent=2))
        return
    for e in res["events"]:
        who = f" by {e['actor']}" if e.get("actor") else ""
        move = f" {e.get('from', '?')} -> {e['to']}" if e.get("to") else ""
        print(f"  {e['at'][:19]}  {e['kind']:<18} {e.get('site', '') or '':<26}{move}{who}")
        if e.get("note"):
            print(f"      └ {e['note']}")


def cmd_summary(args):
    s = call("GET", "/api/social/summary")
    if args.json:
        print(json.dumps(s, indent=2))
        return
    print(f"sites {s['sites']} ({s['eligibleSites']} eligible) · accounts {s['accounts']} "
          f"· live {s['live']} · needs attention {s['needsAttention']} · personas {s['personas']}")
    for plat, row in sorted(s["byPlatform"].items()):
        print(f"  {plat:<12} {row['live']}/{row['total']} live"
              + (f"  ({row['attention']} need attention)" if row["attention"] else ""))


STATUSES = ["active", "pending", "stuck", "blocked", "suspended", "closed", "not_started", "excluded"]
CATEGORIES = ["active", "positioning_tbd", "adult_excluded", "retired"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true", help="raw JSON output")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("worklist", help="what needs doing fleet-wide (start here)").set_defaults(fn=cmd_worklist)
    sub.add_parser("summary", help="one-line rollup").set_defaults(fn=cmd_summary)

    p = sub.add_parser("list", help="list account rows")
    p.add_argument("--site")
    p.add_argument("--platform")
    p.add_argument("--status", choices=STATUSES)
    p.add_argument("--scope", choices=["brand", "persona"])
    p.add_argument("-q", "--q", help="free-text search over site/handle/persona/notes")
    p.add_argument("--needs-attention", action="store_true")
    p.add_argument("--live", action="store_true")
    p.set_defaults(fn=cmd_list)

    p = sub.add_parser("show", help="show one slot in full")
    p.add_argument("site")
    p.add_argument("platform")
    p.add_argument("--persona")
    p.set_defaults(fn=cmd_show)

    p = sub.add_parser("set", help="create or update an account row (upsert)")
    p.add_argument("site")
    p.add_argument("platform")
    p.add_argument("--status", choices=STATUSES)
    p.add_argument("--handle")
    p.add_argument("--url", help="profile URL (derived from the handle when omitted)")
    p.add_argument("--note", help="status note — WHY it is in this state")
    p.add_argument("--notes", help="long-lived notes about the account itself")
    p.add_argument("--persona", help="persona name; omit for the brand account")
    p.add_argument("--create-persona", action="store_true", help="create the persona if it does not exist")
    p.add_argument("--creds", action="store_true", help="mark credentials as present in the vault")
    p.add_argument("--no-creds", action="store_true")
    p.set_defaults(fn=cmd_set)

    p = sub.add_parser("delete", help="remove an account row")
    p.add_argument("site")
    p.add_argument("platform")
    p.add_argument("--persona", default="")
    p.set_defaults(fn=cmd_delete)

    p = sub.add_parser("personas", help="list personas")
    p.add_argument("--site")
    p.set_defaults(fn=cmd_personas)

    p = sub.add_parser("add-persona", help="register a named byline")
    p.add_argument("site")
    p.add_argument("name")
    p.add_argument("--beat")
    p.add_argument("--real-person", action="store_true")
    p.set_defaults(fn=cmd_add_persona)

    p = sub.add_parser("site-meta", help="set a site's bucket")
    p.add_argument("site")
    p.add_argument("category", choices=CATEGORIES)
    p.add_argument("--note")
    p.set_defaults(fn=cmd_site_meta)

    p = sub.add_parser("events", help="recent registry changes")
    p.add_argument("--limit", type=int, default=40)
    p.add_argument("--site")
    p.set_defaults(fn=cmd_events)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
