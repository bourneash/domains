#!/usr/bin/env python3
"""Mint per-site Cloudflare API tokens, one zone each.

    mint.py --audit                 # who holds a scoped token, who is on the fleet one
    mint.py --site xxxtea.com       # mint (or rotate) one site
    mint.py --all                   # every site the policy grants a CF token
    mint.py --revoke xxxtea.com     # delete the CF token and the vault field

Every site container used to hold the FLEET Cloudflare token: one credential
that could rewrite DNS for all 66 zones and deploy all 57 workers. Those
containers run `claude -p` over scraped feeds and product pages, so one prompt
injection reached the whole account (B1).

What this actually buys, measured rather than assumed (2026-09-01, against all
395 permission groups):

  * `Zone Read` / `DNS Write` / `Workers Routes Write` are zone-scopeable, so a
    scoped token gets 403 on another site's DNS. That half is real.
  * `Workers Scripts Write` exists ONLY at `com.cloudflare.api.account` scope.
    There is no per-script resource. A scoped token still lists all 57 workers
    and can deploy any of them.

So this is a blast-radius reduction, NOT isolation. The fix for the Workers half
is to stop containers holding a Cloudflare credential at all — a host-side
deploy broker, the same shape as tools/env-broker. Do not write this up as
closing B1.

The minted token's value is returned by Cloudflare exactly once, at creation, so
it goes straight into that site's vault item and is never held anywhere else.
"""
import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "env-broker"))
import env_broker as eb  # noqa: E402

API = "https://api.cloudflare.com/client/v4"
TOKEN_NAME = "site-{domain}"
KEY = "CLOUDFLARE_API_TOKEN"

# Zone-scoped: the half Cloudflare lets us actually confine.
ZONE_PERMS = ["Zone Read", "DNS Write", "Workers Routes Write"]
# Account-scoped because Cloudflare offers nothing narrower. See the docstring.
ACCOUNT_PERMS = ["Workers Scripts Write", "Workers CI Read"]


def die(msg: str) -> None:
    sys.exit(f"cf-tokens: {msg}")


def api(path: str, token: str, method: str = "GET", body: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req) as fh:
            return json.loads(fh.read().decode())
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode()
        try:
            return json.loads(payload)
        except ValueError:
            return {"success": False, "errors": [{"message": f"HTTP {exc.code}: {payload[:200]}"}]}


def ok(resp: dict, what: str) -> dict:
    if not resp.get("success"):
        die(f"{what} failed: {resp.get('errors')}")
    return resp


def provision_token() -> str:
    """The minting credential. vault_only — deliberately not in the .env."""
    tok = eb._vault_read("fleet — env-cloudflare").get("CLOUDFLARE_PROVISION_TOKEN")
    if not tok:
        die("CLOUDFLARE_PROVISION_TOKEN not in the vault (group: cloudflare). "
            "It needs User:API Tokens:Edit plus the permissions it hands out.")
    return tok


def account_id() -> str:
    acc = eb.load_env_file().get("CLOUDFLARE_ACCOUNT_ID")
    return acc or die("CLOUDFLARE_ACCOUNT_ID missing from the shared .env")


def registry() -> dict:
    import yaml
    return (yaml.safe_load((ROOT / "registry" / "fleet.yaml").read_text()) or {}).get("sites") or {}


def sites_needing_a_token() -> list[str]:
    policy, slack = eb.load_policy(), eb.slack_env_names()
    return [d for d in eb.consumers()
            if KEY in eb.granted_keys(d, policy, slack)]


def permission_groups(token: str) -> dict[str, dict]:
    resp = ok(api("/user/tokens/permission_groups?per_page=300", token),
              "listing permission groups")
    return {g["name"]: {"id": g["id"], "name": g["name"]} for g in resp["result"]}


def zone_id(domain: str, token: str, reg: dict) -> str:
    zone = (reg.get(domain) or {}).get("cf_zone") or domain
    resp = ok(api(f"/zones?name={zone}", token), f"looking up zone {zone}")
    result = resp.get("result") or []
    if not result:
        die(f"{domain}: no Cloudflare zone named {zone}")
    return result[0]["id"]


def existing_tokens(token: str) -> dict[str, str]:
    resp = ok(api("/user/tokens?per_page=100", token), "listing tokens")
    return {t["name"]: t["id"] for t in resp["result"]}


def vault_site_values() -> dict[str, dict[str, str]]:
    return eb.site_values(eb.load_policy())


def write_site_value(domain: str, value: str) -> None:
    item = f"{eb.SITE_ITEM_PREFIX}{domain}"
    fields = {}
    try:
        fields = eb._vault_read(item)
    except Exception:
        pass
    fields[KEY] = value
    eb._vault_write(item, fields)
    if eb._vault_read(item).get(KEY) != value:
        die(f"{domain}: vault write did not read back — the minted token would "
            f"be lost (Cloudflare returns its value only once)")


def mint(domain: str, prov: str, acc: str, pgs: dict, reg: dict,
         existing: dict[str, str], dry_run: bool) -> bool:
    name = TOKEN_NAME.format(domain=domain)
    zid = zone_id(domain, prov, reg)

    if dry_run:
        print(f"{domain:26s} would mint {name} (zone {zid[:8]}…)")
        return True

    # Cloudflare returns a token's secret only at creation, so rotating means
    # delete-then-create. Do it in that order: a stale token left behind under
    # the same name is indistinguishable from the live one in the CF UI.
    if name in existing:
        ok(api(f"/user/tokens/{existing[name]}", prov, method="DELETE"),
           f"{domain}: deleting the previous {name}")

    body = {
        "name": name,
        "policies": [
            {"effect": "allow",
             "permission_groups": [pgs[p] for p in ZONE_PERMS],
             "resources": {f"com.cloudflare.api.account.zone.{zid}": "*"}},
            {"effect": "allow",
             "permission_groups": [pgs[p] for p in ACCOUNT_PERMS],
             "resources": {f"com.cloudflare.api.account.{acc}": "*"}},
        ],
    }
    resp = ok(api("/user/tokens", prov, method="POST", body=body),
              f"{domain}: creating {name}")
    write_site_value(domain, resp["result"]["value"])
    print(f"{domain:26s} minted + stored (zone {zid[:8]}…)")
    return True


def cmd_audit(prov: str, reg: dict) -> int:
    owned = vault_site_values()
    existing = existing_tokens(prov)
    scoped = shared = 0
    for domain in sites_needing_a_token():
        has_vault = KEY in (owned.get(domain) or {})
        has_cf = TOKEN_NAME.format(domain=domain) in existing
        if has_vault and has_cf:
            state, scoped = "scoped", scoped + 1
        elif has_vault or has_cf:
            # Half a migration is worse than none: the vault value may name a
            # token Cloudflare no longer has, so deploys fail at the API call.
            state, shared = "INCONSISTENT", shared + 1
        else:
            state, shared = "fleet-wide", shared + 1
        print(f"{domain:26s} {state}"
              f"{'' if state != 'INCONSISTENT' else f'  (vault={has_vault} cloudflare={has_cf})'}")
    print(f"\n{scoped} scoped, {shared} still sharing the fleet token")
    return 0 if shared == 0 else 1


def cmd_revoke(domain: str, prov: str) -> int:
    name = TOKEN_NAME.format(domain=domain)
    existing = existing_tokens(prov)
    if name in existing:
        ok(api(f"/user/tokens/{existing[name]}", prov, method="DELETE"),
           f"deleting {name}")
        print(f"{domain}: Cloudflare token deleted")
    item = f"{eb.SITE_ITEM_PREFIX}{domain}"
    fields = eb._vault_read(item)
    if KEY in fields:
        del fields[KEY]
        eb._vault_write(item, fields)
        print(f"{domain}: vault field removed — falls back to the fleet token")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--site")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--audit", action="store_true")
    ap.add_argument("--revoke")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    prov, reg = provision_token(), registry()

    if args.audit:
        return cmd_audit(prov, reg)
    if args.revoke:
        return cmd_revoke(args.revoke, prov)
    if not (args.site or args.all):
        ap.error("need --site, --all, --audit or --revoke")

    if args.site:
        # Deliberately NOT gated on being a current env-broker consumer: at
        # bootstrap time a new site has no docker-compose.yml yet, so it is not
        # one. Minting early is right — the token lands in the vault and the
        # first render after ops wiring picks it up. A zone is the real
        # precondition, and zone_id() enforces that.
        targets = [args.site]
        if args.site not in reg:
            die(f"{args.site} is not in registry/fleet.yaml — add it first")
    else:
        targets = sites_needing_a_token()

    acc, pgs = account_id(), permission_groups(prov)
    missing_perms = [p for p in ZONE_PERMS + ACCOUNT_PERMS if p not in pgs]
    if missing_perms:
        die(f"Cloudflare no longer offers: {', '.join(missing_perms)}")
    existing = existing_tokens(prov)

    for domain in targets:
        mint(domain, prov, acc, pgs, reg, existing, args.dry_run)

    if not args.dry_run:
        print("\nRe-render and restart the affected containers:")
        print("  tools/env-broker/env_broker.py render --all")
        print("  # a file bind mount pins the old inode — a running container "
              "never sees a re-render")
    return 0


if __name__ == "__main__":
    sys.exit(main())
