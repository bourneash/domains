"""One-time GA4 provisioning: discover -> write registry -> grant the SA."""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from googleapiclient.discovery import build

from . import discover, grant, oauth, registry

SITES_DIR = Path("/home/jesse/projects/domains/sites")
GA_ID_RE = re.compile(r"G-[A-Z0-9]{8,}")
PLACEHOLDERS = {"G-PLACEHOLDER", "G-XXXXXXXXXX"}

# Both wiring patterns in the fleet: a lib module and an inline layout tag.
SEARCH_GLOBS = (
    "site/src/lib/analytics.ts",
    "site/src/layouts/*.astro",
    "site/src/components/*.astro",
)


def measurement_ids_from_sites(sites_dir: Path | None = None) -> dict[str, str]:
    """Scrape real G- IDs out of site sources, skipping placeholder guards."""
    root = Path(sites_dir) if sites_dir else SITES_DIR
    found: dict[str, str] = {}

    for site_path in sorted(p for p in root.iterdir() if p.is_dir()):
        site = site_path.name
        if site.startswith("DISABLED-"):
            continue
        for pattern in SEARCH_GLOBS:
            for path in sorted(site_path.glob(pattern)):
                try:
                    text = path.read_text(errors="ignore")
                except OSError:
                    continue
                for match in GA_ID_RE.findall(text):
                    if match not in PLACEHOLDERS:
                        found.setdefault(site, match)
            if site in found:
                break

    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="One-time GA4 provisioning.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Discover and report, but grant nothing.")
    args = parser.parse_args(argv)

    creds = oauth.user_credentials()
    client = build("analyticsadmin", "v1beta", credentials=creds, cache_discovery=False)

    try:
        properties = discover.discover_properties(client)
    except (KeyError, ValueError) as exc:
        print(f"error: discovery failed, aborting before touching the registry: {exc}",
              file=sys.stderr)
        return 1
    print(f"Discovered {len(properties)} GA4 properties.")

    measurement_map = measurement_ids_from_sites()
    data = registry.build_registry(properties, measurement_map)

    if args.dry_run:
        print("dry-run: no registry written, no grants made.")
        for site, entry in data["sites"].items():
            print(f"  {site:<28} property={entry['ga4_property_id']:<12} "
                  f"ga={entry['ga4_measurement_id'] or '-'}")
        return 0

    registry.write_registry(data)
    print(f"Wrote {registry.REGISTRY_PATH}")

    sa_email = grant.service_account_email()
    failures = 0
    for prop in properties:
        result = grant.grant_viewer(client, prop.property_id, sa_email)
        if result.startswith("failed"):
            failures += 1
        print(f"  {prop.display_name:<28} {result}")

    print(f"\n{len(properties) - failures}/{len(properties)} properties granted.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
