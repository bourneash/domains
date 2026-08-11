#!/usr/bin/env python3
"""deployer-status — read-only drift audit of the Deployer cron role across
every site under sites/. Answers "which sites are on the tools/cron-roles
deployer archetype, and how far behind the current template is each one?"

Usage:
    python3 tools/deployer-fleet/deployer-status.py            # table
    python3 tools/deployer-fleet/deployer-status.py --json     # machine-readable
    python3 tools/deployer-fleet/deployer-status.py --drift    # only non-aligned sites

Model: same as tools/engineer-fleet/engineer-status.py — the archetype at
tools/cron-roles/archetypes/deployer/ is stamp-once (see
tools/cron-roles/README.md: "Improving an archetype here does NOT propagate
to already-installed sites"). This script only *detects* drift by checking
for feature markers introduced to the template over time; it never writes to
a site. Rolling a fix out is a deliberate, reviewed, per-site edit — canary
one site, verify a real deploy cycle, then the rest — never an auto fan-out.
See feedback_no_auto_rollout_tool.

Feature markers (each a distinct incident/hardening fix landed on the
template at some point — see archetypes/deployer/meta.yml history):
    B  branch guard            — refuse to deploy off a non-main working tree
    A  audit-gate existence    — security:audit:prod, block on high+ in prod deps
    D  musl/glibc auto-defer   — self-diagnose workerd relocation failures
    I  emit_incident wrapper   — every failure branch feeds the watchdog
    T  .deploy-needed trigger  — thread trigger_role/trigger_summary into Slack
    C  CF Workers Build poll   — confirm the async build, not just curl+sleep
    W  .wrangler/state clear   — stale workerd sqlite state after adapter bumps
                                 (added 2026-08-11, shoptopless.com incident)

`wrangler_direct` sites (see meta.yml known_variants — 0xroulette.com,
rc-9.com as of this writing) legitimately skip C: they `wrangler deploy`
synchronously and have no async build gap to poll for. They're excluded from
the C requirement, not flagged as drifted for lacking it.
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]           # tools/deployer-fleet/ -> repo root
SITES = ROOT / "sites"

SIGNATURE = "zero-AI bash deployer"                    # marks a site as archetype-family
WRANGLER_DIRECT_VARIANT = {"0xroulette.com", "rc-9.com"}  # meta.yml known_variants

MARKERS = [
    ("B", "not 'main' — refusing to deploy"),
    ("A", "security:audit:prod"),
    ("D", "BUILD_DEFERRED"),
    ("I", "emit_incident"),
    ("T", "TRIGGER_ROLE"),
    ("C", "build_outcome"),
    ("W", "rm -rf .wrangler/state"),
]


def read(p):
    try:
        return p.read_text(errors="replace")
    except Exception:
        return ""


def audit_site(site_dir):
    slug = site_dir.name
    deploy = site_dir / "ops" / "scripts" / "deploy.sh"
    r = {"site": slug, "has_deploy": deploy.exists(), "archetype": False,
         "tier": "none", "features": {}, "missing": [], "path": None}
    if not deploy.exists():
        return r
    r["path"] = str(deploy.relative_to(ROOT))
    src = read(deploy)
    r["archetype"] = SIGNATURE in src
    if not r["archetype"]:
        r["tier"] = "custom"          # has a deployer, but never migrated to this archetype
        return r

    required = [k for k, _ in MARKERS]
    if slug in WRANGLER_DIRECT_VARIANT:
        required = [k for k in required if k != "C"]

    for key, needle in MARKERS:
        r["features"][key] = needle in src
    r["missing"] = [k for k in required if not r["features"].get(k)]
    r["tier"] = "aligned" if not r["missing"] else "PARTIAL"
    return r


def feature_str(r):
    return "[" + "".join(k if r["features"].get(k) else "·" for k, _ in MARKERS) + "]"


def main():
    args = set(sys.argv[1:])
    rows = [audit_site(d) for d in sorted(p for p in SITES.iterdir()
            if p.is_dir() and not p.name.startswith("DISABLED-"))]

    if "--json" in args:
        print(json.dumps(rows, indent=2))
        return

    show = [r for r in rows if r["has_deploy"]]     # skip sites with no deployer at all — noise
    if "--drift" in args:
        show = [r for r in rows if r["archetype"] and r["tier"] != "aligned"]
        if not show:
            print("✓ No drift — every archetype-family deployer matches the current template.")
            return

    hdr = f'{"SITE":22} {"TIER":8} {"FEATURES":10} {"MISSING"}'
    print(hdr)
    print("-" * len(hdr))
    for r in show:
        if not r["has_deploy"]:
            print(f'{r["site"]:22} {"none":8} {"—":10} —')
            continue
        if not r["archetype"]:
            print(f'{r["site"]:22} {"custom":8} {"—":10} (not on tools/cron-roles archetype)')
            continue
        print(f'{r["site"]:22} {r["tier"]:8} {feature_str(r):10} {" ".join(r["missing"]) or "—"}')

    print("-" * len(hdr))
    fam = [r for r in rows if r["archetype"]]
    tiers = {}
    for r in fam:
        tiers[r["tier"]] = tiers.get(r["tier"], 0) + 1
    print(f'{len(fam)} archetype-family deployers — ' + ", ".join(f"{k}={v}" for k, v in sorted(tiers.items())))
    print("FEATURES key: B=branch-guard A=audit-gate D=musl-auto-defer I=emit-incident "
          "T=deploy-needed-trigger C=cf-build-poll W=wrangler-state-clear")
    print("Drift here does NOT auto-fix — this is detection only. Roll a fix out deliberately:")
    print("  edit tools/cron-roles/archetypes/deployer/scripts/deploy.sh.tmpl, then patch")
    print("  each PARTIAL site's ops/scripts/deploy.sh by hand (canary one, verify, then rest).")


if __name__ == "__main__":
    main()
