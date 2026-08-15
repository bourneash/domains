"""Regenerate the analytics registry using the service account alone.

`cli.py` needs interactive user OAuth because it *grants* the service account
access per property. As of 2026-08-15 the SA holds **account-level Viewer** on
Domain Portfolio (396394354), so it sees every property — present and future —
without any grant step. That makes the common case (a new site appeared; refresh
the registry) a read-only operation the SA can do unattended.

This matters: the OAuth client (`domains-ops`, Testing publishing status) expires
refresh tokens after 7 days, and when it broke on 2026-07-21 nobody could
regenerate the registry for three weeks. Seven live sites collected GA4 data that
never reached the pipeline. Nothing here can hit that failure mode.

    python -m ga4_provision.refresh --dry-run
    python -m ga4_provision.refresh

Use `cli.py` only when a property genuinely needs a per-property grant.
"""

from __future__ import annotations

import argparse
import sys

from google.oauth2 import service_account
from googleapiclient.discovery import build

from . import discover, registry
from .cli import measurement_ids_from_sites

SA_PATH = "/home/jesse/projects/domains/.gcp/service-account.json"
SCOPES = ["https://www.googleapis.com/auth/analytics.readonly"]


def client():
    creds = service_account.Credentials.from_service_account_file(SA_PATH, scopes=SCOPES)
    return build("analyticsadmin", "v1beta", credentials=creds, cache_discovery=False)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="report, write nothing")
    args = parser.parse_args(argv)

    try:
        properties = discover.discover_properties(client())
    except Exception as exc:  # noqa: BLE001 - report cleanly, never half-write
        print(f"error: discovery failed, registry untouched: {exc}", file=sys.stderr)
        return 1

    print(f"Discovered {len(properties)} GA4 properties via the service account.")
    data = registry.build_registry(properties, measurement_ids_from_sites())

    # A property whose display name isn't a domain (someone renamed it in the UI,
    # which has happened twice) would land in the registry as a bogus site key and
    # silently never collect. Surface it instead of writing it.
    odd = [s for s in data["sites"] if "." not in s]
    for site in odd:
        del data["sites"][site]
    if odd:
        print(f"warning: skipped {len(odd)} property with a non-domain display name: {odd}",
              file=sys.stderr)
        print("         rename it in GA4 admin (or trash it if it's an orphan) — as-is it can",
              file=sys.stderr)
        print("         never match a site, and left in the registry it would collect nothing.",
              file=sys.stderr)

    if args.dry_run:
        for site, entry in data["sites"].items():
            print(f"  {site:<28} property={entry['ga4_property_id']:<12} "
                  f"ga={entry['ga4_measurement_id'] or '-'}")
        print("dry-run: nothing written.")
        return 0

    registry.write_registry(data)
    print(f"Wrote {registry.REGISTRY_PATH} ({len(data['sites'])} sites)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
