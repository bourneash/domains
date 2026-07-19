"""Verify fleet domains in Search Console. Idempotent and re-runnable."""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

import yaml

from google_auth_fleet import clients

from . import cloudflare, console, verification

REGISTRY_PATH = Path(
    "/home/jesse/projects/domains/tools/data-hub/registry/sites-analytics.yaml"
)
DNS_TIMEOUT_SECONDS = 300
DNS_POLL_INTERVAL = 15


def load_domains(path: Path | None = None) -> list[str]:
    """Read site names from the registry ga4-provision wrote."""
    target = Path(path) if path else REGISTRY_PATH
    if not target.exists():
        raise FileNotFoundError(
            f"{target} not found. Run tools/ga4-provision first — it writes the registry."
        )
    data = yaml.safe_load(target.read_text()) or {}
    return sorted((data.get("sites") or {}).keys())


def wait_for_txt(
    domain: str,
    content: str,
    timeout: int = DNS_TIMEOUT_SECONDS,
    interval: int = DNS_POLL_INTERVAL,
) -> bool:
    """Poll DNS until the TXT record resolves, or time out.

    Uses the system resolver rather than a hardcoded public one (e.g.
    8.8.8.8) — some hosts firewall direct outbound queries to arbitrary
    DNS servers while the local stub resolver works fine.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            out = subprocess.run(
                ["dig", "+short", "TXT", domain],
                capture_output=True, text=True, timeout=20,
            ).stdout
            if content in out.replace('"', ""):
                return True
        except (subprocess.SubprocessError, OSError):
            pass
        time.sleep(interval)
    return False


def verify_domain(sv_client, sc_client, cf, domain: str) -> str:
    """Run the per-domain state machine. Returns a status string, never raises."""
    already_owned = verification.is_verified(sv_client, domain)

    if not already_owned:
        try:
            token = verification.get_token(sv_client, domain)
        except Exception as exc:  # noqa: BLE001
            return f"failed:token-{type(exc).__name__}"

        try:
            zone = cloudflare.zone_id(cf, domain)
        except Exception as exc:  # noqa: BLE001
            return f"failed:cloudflare-{type(exc).__name__}-{str(exc)[:120]}"
        if not zone:
            return "failed:no-cf-zone"

        try:
            cloudflare.upsert_txt(cf, zone, domain, token)
        except Exception as exc:  # noqa: BLE001
            return f"failed:cloudflare-{type(exc).__name__}-{str(exc)[:120]}"

        if not wait_for_txt(domain, token):
            # Record intentionally retained so a re-run resumes instead of restarting.
            return "pending:dns-propagation"

        result = verification.verify(sv_client, domain)
        if result != "verified":
            return result

    # Ownership is established (either already, or just now via DNS_TXT).
    # add_site/submit_sitemap are idempotent PUT-style upserts (see console.py),
    # so always (re)confirm them here — this is what makes a domain that
    # DNS-verified but whose registration partially failed on a prior run
    # retryable. Without this, is_verified() short-circuits every re-run
    # straight to "already-verified" and the registration never gets retried.
    add_result = console.add_site(sc_client, domain)
    sitemap_result = console.submit_sitemap(sc_client, domain)
    clean = "already-verified" if already_owned else "verified"
    if add_result == "added" and sitemap_result == "submitted":
        return clean

    # Registration did not fully complete — never report a fabricated
    # clean status when either write failed.
    problems = []
    if add_result != "added":
        problems.append(f"add-{add_result}")
    if sitemap_result != "submitted":
        problems.append(f"sitemap-{sitemap_result}")
    return f"{clean}:" + ",".join(problems)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify fleet domains in Search Console.")
    parser.add_argument("--domain", action="append",
                        help="Limit to specific domain(s). Repeatable.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report current verification state, change nothing.")
    args = parser.parse_args(argv)

    domains = args.domain or load_domains()
    sv_client = clients.site_verification()
    sc_client = clients.search_console_write()

    if args.dry_run:
        print("dry-run: reporting verification state only.")
        for domain in domains:
            state = "verified" if verification.is_verified(sv_client, domain) else "unverified"
            print(f"  {domain:<28} {state}")
        return 0

    failures = 0
    with cloudflare.cf_client() as cf:
        for domain in domains:
            try:
                result = verify_domain(sv_client, sc_client, cf, domain)
            except Exception as exc:  # noqa: BLE001
                result = f"failed:unexpected-{type(exc).__name__}"
            # Only "verified" and "already-verified" are clean successes.
            # Every other status — failed:*, pending:*, or the
            # "verified:add-failed-..."/"verified:sitemap-failed-..." partial
            # results from verify_domain — must count against the tally so
            # the printed n/n can never overstate success.
            if result not in ("verified", "already-verified"):
                failures += 1
            print(f"  {domain:<28} {result}")

    print(f"\n{len(domains) - failures}/{len(domains)} domains verified.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
