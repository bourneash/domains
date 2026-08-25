#!/usr/bin/env python3
"""check_pins.py — fleet-wide dependency-pin drift detector. Zero AI.

Why this exists
---------------
Every site builds with `npm ci`, so a caret range does NOT float at build time.
It floats at *lock-refresh* time, independently per site. That is quieter and
worse: on 2026-08-25 the fleet was simultaneously running four different
@astrojs/cloudflare builds (14.1.7, 14.2.0, 14.2.1, 14.2.3) and six different
astro builds, with nothing anywhere reporting it. A deploy-breaking adapter
change would have hit an arbitrary subset of sites and looked like a per-site
mystery rather than one dependency bump.

This checks two different things, because they fail differently:

  declared  — package.json must carry the EXACT pinned version, no range. A
              range here is how drift gets reintroduced.
  resolved  — package-lock.json must actually resolve to it. A matching
              declaration with a stale lock still ships the old build.

Exit 0 = fleet is on the pins. Exit 1 = at least one site drifted.
"""
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PINS_FILE = os.path.join(os.path.dirname(__file__), "pins.json")


def load_pins():
    with open(PINS_FILE) as f:
        cfg = json.load(f)
    return cfg["pins"], cfg.get("exempt", {})


def site_deps(pkg_path):
    try:
        with open(pkg_path) as f:
            p = json.load(f)
    except (OSError, ValueError):
        return None
    return {**p.get("dependencies", {}), **p.get("devDependencies", {})}


def locked_version(lock_path, name):
    try:
        with open(lock_path) as f:
            lock = json.load(f)
    except (OSError, ValueError):
        return None
    entry = lock.get("packages", {}).get("node_modules/" + name)
    return entry.get("version") if entry else None


def scan():
    pins, exempt = load_pins()
    findings = []
    sites_dir = os.path.join(ROOT, "sites")
    for slug in sorted(os.listdir(sites_dir)):
        if slug in exempt:
            continue
        site = os.path.join(sites_dir, slug, "site")
        pkg = os.path.join(site, "package.json")
        deps = site_deps(pkg)
        if deps is None:
            continue
        for name, want in pins.items():
            declared = deps.get(name)
            if declared is None:
                continue  # the site genuinely does not use it
            if declared != want:
                findings.append(
                    {
                        "site": slug,
                        "dep": name,
                        "kind": "declared",
                        "found": declared,
                        "want": want,
                    }
                )
            got = locked_version(os.path.join(site, "package-lock.json"), name)
            if got is not None and got != want:
                findings.append(
                    {"site": slug, "dep": name, "kind": "resolved", "found": got, "want": want}
                )
    return findings


def main():
    findings = scan()
    if "--json" in sys.argv:
        print(json.dumps({"ok": not findings, "findings": findings}, indent=2))
    elif not findings:
        print("all sites are on the pinned versions")
    else:
        print(f"{len(findings)} pin drift(s):\n")
        for f in findings:
            print(f"  {f['site']:<26} {f['dep']:<22} {f['kind']:<9} {f['found']} != {f['want']}")
        print("\nFix: set the exact version in the site's site/package.json, then `npm install`")
        print("in that site/ to refresh its lock. Bumping the fleet target = edit pins.json.")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
