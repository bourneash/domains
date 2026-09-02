#!/usr/bin/env python3
"""Issue each site its cf-broker token.

    issue-tokens.py --all [--dry-run]
    issue-tokens.py --site xxxtea.com [--rotate]

The broker derives a caller's site FROM this token, so it is an identity, not
just a password: two sites sharing one would be able to read each other's build
logs. Existing tokens are left alone unless --rotate, because reissuing one a
container still holds means that container 401s until it is restarted.
"""
import argparse
import json
import os
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "env-broker"))
import env_broker as eb  # noqa: E402

KEY = "CF_BROKER_TOKEN"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--site")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--rotate", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if not (args.site or args.all):
        ap.error("need --site or --all")

    policy, slack = eb.load_policy(), eb.slack_env_names()
    existing = eb.site_values(policy)
    targets = [args.site] if args.site else [
        d for d in eb.consumers() if KEY in eb.granted_keys(d, policy, slack)]

    issued = skipped = 0
    seen = {v.get(KEY) for v in existing.values() if v.get(KEY)}
    for domain in targets:
        if existing.get(domain, {}).get(KEY) and not args.rotate:
            skipped += 1
            continue
        token = secrets.token_urlsafe(32)
        while token in seen:                       # identity, so never collide
            token = secrets.token_urlsafe(32)
        seen.add(token)
        if args.dry_run:
            print(f"{domain:26s} would issue")
            issued += 1
            continue
        item = f"{eb.SITE_ITEM_PREFIX}{domain}"
        fields = {}
        try:
            fields = eb._vault_read(item)
        except Exception:
            pass
        fields[KEY] = token
        eb._vault_write(item, fields)
        if eb._vault_read(item).get(KEY) != token:
            sys.exit(f"{domain}: vault write did not read back")
        print(f"{domain:26s} issued")
        issued += 1

    print(f"\n{issued} issued, {skipped} already had one "
          f"(--rotate to replace)")

    if not args.dry_run:
        write_token_map(policy)
    if issued and not args.dry_run:
        print("Now: env_broker.py render --all, then restart those containers.")
    return 0


def write_token_map(policy: dict) -> None:
    """Rewrite the broker's token -> site map from the vault.

    The broker reads only this file, never the vault and never env-broker's
    rendered/ directory — mounting that would hand a process that answers four
    GETs every site's Slack and Cloudflare credentials.

    Written whole every time and mode 0400: a stale entry is a revoked token
    that still works, which is the failure this file must not have.
    """
    out = {}
    for domain, fields in eb.site_values(policy).items():
        tok = fields.get(KEY)
        if tok:
            out[tok] = domain
    path = Path(__file__).resolve().parent / "tokens.json"
    tmp = path.with_suffix(".json.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o400)
    with os.fdopen(fd, "w") as fh:
        json.dump(out, fh, indent=2, sort_keys=True)
    os.replace(tmp, path)
    print(f"token map: {len(out)} site(s) -> {path.name}")


if __name__ == "__main__":
    sys.exit(main())
