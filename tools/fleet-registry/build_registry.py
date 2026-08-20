#!/usr/bin/env python3
"""Seed / refresh registry/fleet.yaml by merging every existing site roster.

Phase 1 of the fleet-registry consolidation. Today a site has to be added to
~14 hand-maintained lists; each list drifted independently. This script reads
all of them plus the filesystem, merges them into one canonical file, and
reports what disagreed.

Two modes:

    build_registry.py --report        # merge + print the drift report (no writes)
    build_registry.py --write         # also (re)write registry/fleet.yaml

`--write` is safe to re-run: hand-curated fields in an existing fleet.yaml are
preserved (see PRESERVED_KEYS) — only derived facts are refreshed. The file is
meant to be edited by humans afterwards; this script never clobbers those edits.

Invariant this enforces: the filesystem is truth for *existence* (a directory
under sites/ with an ops/ or site/ dir is a site, full stop); the registry is
truth for *policy* (status, which tools apply, ids). A sites/ dir with no
registry entry is drift, and so is a registry entry with no sites/ dir.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - operator convenience
    sys.exit("PyYAML required: pip install pyyaml")

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "registry" / "fleet.yaml"
REPORT = Path(__file__).resolve().parent / "MERGE_REPORT.md"

# Fields a human owns once the file exists — never overwritten by a re-run.
PRESERVED_KEYS = {"status", "tags", "notes", "capabilities_override", "analytics_external"}

# Directories under sites/ that are not domains.
NOT_A_SITE = {"example.com"}


# --------------------------------------------------------------------------
# sources
# --------------------------------------------------------------------------

def scan_disk() -> dict[str, dict]:
    """Filesystem evidence — the only source that cannot silently omit a site."""
    out: dict[str, dict] = {}
    sites_dir = ROOT / "sites"
    for entry in sorted(sites_dir.iterdir()):
        if not entry.is_dir() or entry.name.startswith(".") or entry.name.startswith("DISABLED-"):
            continue
        if entry.name in NOT_A_SITE:
            continue
        site = entry / "site"
        ops = entry / "ops"
        out[entry.name] = {
            "has_repo": (entry / ".git").exists(),
            "has_site": site.is_dir(),
            "has_ops": ops.is_dir(),
            "has_cron": (ops / "docker").is_dir(),
            "has_smoke": (ops / "smoke.yaml").exists(),
            "has_board": (ops / "board").is_dir(),
            "has_affiliate": (site / "src" / "lib" / "affiliate.ts").exists(),
            "worker": read_worker_name(site),
        }
    return out


def read_worker_name(site: Path) -> str | None:
    """Worker name straight from the deploy config — the authoritative value."""
    for name in ("wrangler.jsonc", "wrangler.json"):
        path = site / name
        if not path.exists():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            return None
        # jsonc: strip // and /* */ comments before parsing.
        text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
        text = re.sub(r"(?m)^\s*//.*$", "", text)
        try:
            return json.loads(text).get("name")
        except json.JSONDecodeError:
            match = re.search(r'"name"\s*:\s*"([^"]+)"', text)
            return match.group(1) if match else None
    return None


def read_gitmodules() -> dict[str, str]:
    """path -> owner/repo, from .gitmodules."""
    out: dict[str, str] = {}
    path = ROOT / ".gitmodules"
    if not path.exists():
        return out
    current = None
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("path ="):
            current = line.split("=", 1)[1].strip().removeprefix("sites/")
        elif line.startswith("url =") and current:
            url = line.split("=", 1)[1].strip()
            slug = url.rsplit(":", 1)[-1].removesuffix(".git")
            out[current] = slug
            current = None
    return out


def read_yaml(rel: str, key: str | None = None) -> dict:
    path = ROOT / rel
    if not path.exists():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return (data.get(key) or {}) if key else data


def read_domains_index() -> dict[str, str]:
    """domain -> section bucket (active / coming-soon / parked)."""
    path = ROOT / "DOMAINS_INDEX.md"
    if not path.exists():
        return {}
    section, out = None, {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## Active"):
            section = "active"
        elif line.startswith("## Coming Soon"):
            section = "coming-soon"
        elif line.startswith("## Parked"):
            section = "parked"
        elif line.startswith("## "):
            section = None
        elif section and line.startswith("|"):
            cell = line.split("|")[1].strip()
            if re.match(r"^[a-z0-9][a-z0-9.-]*\.[a-z]+$", cell):
                out[cell] = section
    return out


def read_social() -> dict[str, dict]:
    path = ROOT / "tools" / "social-setup" / "registry" / "social.json"
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return data.get("siteMeta") or {}


def read_slack_channels() -> dict[str, str]:
    """SLACK_CHANNEL_* env var names, matched back to domains by squashed name.

    The env keys were coined ad hoc (SLACK_CHANNEL_RC9, _SAVE_US_FARMS,
    _AMPUTEENEWS_COM), so match on the alphanumeric squash of both sides.
    """
    path = ROOT / ".env"
    if not path.exists():
        return {}
    keys = re.findall(r"^(SLACK_CHANNEL_[A-Z0-9_]+)=", path.read_text(encoding="utf-8"), re.M)
    return {re.sub(r"[^a-z0-9]", "", k.removeprefix("SLACK_CHANNEL_").lower()): k for k in keys}


def match_slack(domain: str, squashed: dict[str, str]) -> str | None:
    base = re.sub(r"[^a-z0-9]", "", domain.rsplit(".", 1)[0].lower())
    full = re.sub(r"[^a-z0-9]", "", domain.lower())
    return squashed.get(base) or squashed.get(full)


# --------------------------------------------------------------------------
# merge
# --------------------------------------------------------------------------

def derive_status(disk: dict, index_bucket: str | None) -> str:
    """Disk evidence outranks DOMAINS_INDEX — the index is provably stale."""
    if not disk["has_site"] and not disk["has_ops"]:
        return "redirect"
    if disk["has_cron"] or disk["has_smoke"]:
        return "live"
    if disk["has_site"]:
        return "scaffold"
    return "parked"


def capabilities(domain: str, disk: dict, src: dict) -> list[str]:
    caps = []
    if disk["has_site"]:
        caps.append("site")
    if disk["has_ops"]:
        caps.append("ops")
    if disk["has_cron"]:
        caps.append("cron")
    if disk["has_smoke"]:
        caps.append("smoke")
    if disk["has_board"]:
        caps.append("tasks")
    if disk["has_affiliate"]:
        caps.append("affiliate")
    if domain in src["analytics"]:
        caps.append("analytics")
    if domain in src["social"]:
        caps.append("social")
    if domain in src["datahub"]:
        caps.append("data-hub")
    if domain in src["productfeed"]:
        caps.append("product-feed")
    return caps


def build() -> tuple[dict, dict, dict]:
    disk = scan_disk()
    src = {
        "tracker": read_yaml("tools/site-tracker/sites.yml", "sites"),
        "analytics": read_yaml("tools/data-hub/registry/sites-analytics.yaml", "sites"),
        "datahub": read_yaml("tools/data-hub/registry/subscriptions.yaml", "subscriptions"),
        "productfeed": read_yaml("tools/product-feed/registry/subscriptions.yaml"),
        "index": read_domains_index(),
        "social": read_social(),
        "modules": read_gitmodules(),
        "slack": read_slack_channels(),
    }

    sites: dict[str, dict] = {}
    for domain in sorted(disk):
        d = disk[domain]
        tracker = src["tracker"].get(domain) or {}
        analytics = src["analytics"].get(domain) or {}
        entry = {
            "status": derive_status(d, src["index"].get(domain)),
            "repo": src["modules"].get(domain) or tracker.get("github"),
            "worker": d["worker"],
            "cf_zone": tracker.get("cf_zone") or domain,
            "slack_channel_env": match_slack(domain, src["slack"]),
            "capabilities": capabilities(domain, d, src),
            "analytics": {
                "ga4_property_id": analytics.get("ga4_property_id"),
                "ga4_measurement_id": analytics.get("ga4_measurement_id"),
                "gsc_property": analytics.get("gsc_property"),
                "consent_gated": analytics.get("consent_gated"),
            } if analytics else None,
            "smoke_string": tracker.get("smoke_string"),
            "registered_in": sorted(
                name for name, key in (
                    ("site-tracker", "tracker"), ("analytics", "analytics"),
                    ("data-hub", "datahub"), ("product-feed", "productfeed"),
                    ("domains-index", "index"), ("social", "social"),
                ) if domain in src[key]
            ),
        }
        sites[domain] = {k: v for k, v in entry.items() if v not in (None, [], {})}

    return sites, disk, src


def merge_preserved(new: dict) -> dict:
    """Keep human-owned fields from an existing registry across a rebuild."""
    if not OUT.exists():
        return new
    old = (yaml.safe_load(OUT.read_text(encoding="utf-8")) or {}).get("sites") or {}
    for domain, entry in new.items():
        for key in PRESERVED_KEYS:
            if domain in old and key in old[domain]:
                entry[key] = old[domain][key]
    for domain, entry in old.items():
        if domain not in new:  # registry entry with no sites/ dir — keep, flag in report
            entry["orphaned"] = True
            new[domain] = entry
    return dict(sorted(new.items()))


# --------------------------------------------------------------------------
# report
# --------------------------------------------------------------------------

def report(sites: dict, disk: dict, src: dict) -> str:
    lines = ["# Fleet registry — merge report", ""]
    total = len(sites)
    live = [d for d, e in sites.items() if e.get("status") == "live"]
    lines += [
        f"`sites/` directories merged: **{total}** "
        f"(live {len(live)}, scaffold {sum(1 for e in sites.values() if e.get('status') == 'scaffold')}, "
        f"parked {sum(1 for e in sites.values() if e.get('status') == 'parked')}, "
        f"redirect {sum(1 for e in sites.values() if e.get('status') == 'redirect')})",
        "",
        "## Coverage per roster",
        "",
        "Fleet-wide rosters are expected to list every live site — anything in the",
        "last column is a real gap. Opt-in rosters (subscriptions) are listed for",
        "provenance only; absence there is a choice, not drift.",
        "",
        "| Roster | Kind | Covers | Missing live sites |",
        "|---|---|---|---|",
    ]
    rosters = [
        ("site-tracker/sites.yml", "tracker", "fleet-wide"),
        ("data-hub/sites-analytics.yaml", "analytics", "fleet-wide"),
        ("DOMAINS_INDEX.md", "index", "fleet-wide"),
        ("social registry", "social", "fleet-wide"),
        ("data-hub/subscriptions.yaml", "datahub", "opt-in"),
        ("product-feed/subscriptions.yaml", "productfeed", "opt-in"),
    ]
    for label, key, kind in rosters:
        known = set(src[key])
        missing_live = sorted(set(live) - known) if kind == "fleet-wide" else []
        cell = ", ".join(missing_live) if missing_live else ("—" if kind == "fleet-wide" else "n/a")
        lines.append(f"| `{label}` | {kind} | {len(known & set(sites))}/{total} | {cell} |")

    smoke = [d for d, e in sites.items() if "smoke" in e.get("capabilities", [])]
    slackless = [d for d in live if "slack_channel_env" not in sites[d]]
    workerless = [d for d in live if "worker" not in sites[d]]
    lines += [
        "",
        "## Gaps on live sites",
        "",
        f"- No `ops/smoke.yaml` (invisible to fleet-gatus): {', '.join(sorted(set(live) - set(smoke))) or '—'}",
        f"- No Slack channel env: {', '.join(slackless) or '—'}",
        f"- No worker name in wrangler config: {', '.join(workerless) or '—'}",
        "",
        "## Stale DOMAINS_INDEX buckets",
        "",
        "Sites the index files under a bucket that contradicts disk evidence:",
        "",
    ]
    for domain in sorted(sites):
        bucket = src["index"].get(domain)
        status = sites[domain].get("status")
        if bucket == "parked" and status in ("live", "scaffold"):
            lines.append(f"- `{domain}` — indexed **parked**, actually **{status}**")
        elif bucket is None and status in ("live", "scaffold"):
            lines.append(f"- `{domain}` — **absent** from the index, actually **{status}**")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--write", action="store_true", help="write registry/fleet.yaml")
    ap.add_argument("--report", action="store_true", help="print the drift report")
    args = ap.parse_args()

    sites, disk, src = build()
    text = report(sites, disk, src)

    if args.write:
        sites = merge_preserved(sites)
        OUT.parent.mkdir(parents=True, exist_ok=True)
        header = (
            "# Canonical fleet registry — one entry per domain.\n"
            "#\n"
            "# Truth model: the filesystem owns *existence* (a dir under sites/ with\n"
            "# ops/ or site/ is a site); this file owns *policy* (status, ids, which\n"
            "# tools apply). Consumers read this instead of keeping their own roster.\n"
            "#\n"
            "# Derived fields are refreshed by tools/fleet-registry/build_registry.py\n"
            "# --write. Hand-owned fields (status, tags, notes, capabilities_override)\n"
            "# survive a rebuild — edit those here freely.\n"
        )
        OUT.write_text(
            header + yaml.safe_dump({"sites": sites}, sort_keys=False, width=100, allow_unicode=True),
            encoding="utf-8",
        )
        REPORT.write_text(text, encoding="utf-8")
        print(f"wrote {OUT.relative_to(ROOT)} ({len(sites)} sites)")
        print(f"wrote {REPORT.relative_to(ROOT)}")

    if args.report or not args.write:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
