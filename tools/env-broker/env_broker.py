#!/usr/bin/env python3
"""env-broker — render each site container a minimal .env instead of the fleet's.

THE PROBLEM
Every site cron container mounted the shared fleet `.env`: 60 keys, including
CLOUDFLARE_API_TOKEN, GITHUB_TOKEN, SLACK_BOT_TOKEN, the Amazon Creators
secret, the PIA password, and FD_TOKEN — the Fleet Dashboard operator token,
i.e. the credential that is supposed to gate the thing that can push to 48
repos and restart the fleet. Those containers run `claude -p` over
attacker-influenced input. Measured against the ops trees, a typical site
actually references FOUR of the 60; 25 are referenced by no site at all.

THE SHAPE OF THE FIX: RENDER, NOT FETCH
Containers do not talk to the vault. A host-side broker (this) holds the one
vault credential, renders a per-site file containing only that site's allowed
keys, and compose mounts that instead. The alternative — `bw` inside every
container — trades 60 keys for one vault password that unlocks *more* than the
60 did (there is no per-item token in Bitwarden's model; `bw` authenticates as
a user), and makes Vaultwarden a hard runtime dependency of every cron role.

Vaultwarden is the source of truth; the shared .env remains a bootstrap and
an offline fallback, so a vault outage cannot stop a render.

USAGE
    env_broker.py --check                 # policy vs. what ops/ really uses
    env_broker.py render --all            # write rendered/<domain>.env, 0400
    env_broker.py render --site xxxtea.com --stdout
    env_broker.py import-to-vault         # push .env into the Fleet Env items
    env_broker.py --check --source vault  # verify the vault has every key

EXIT CODES
    0 ok   1 error   2 policy drift (--check only)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

import yaml

TOOL_DIR = Path(__file__).resolve().parent
ROOT = TOOL_DIR.parent.parent
ENV_FILE = ROOT / ".env"
REGISTRY = ROOT / "registry" / "fleet.yaml"
RENDER_DIR = TOOL_DIR / "rendered"

ENV_LINE = re.compile(r"^([A-Z0-9_]+)=(.*)$")
# Directories whose contents are output, not source — scanning them produces
# phantom "references" from logged command lines.
SKIP_PARTS = ("/logs/", "/node_modules/", "/.venv/", "/board/", "/__pycache__/", "/out/")


def load_env_file(path: Path | None = None) -> dict[str, str]:
    # Resolved at call time, not bound as a default: a default argument is
    # evaluated once at import, which freezes ENV_FILE and makes the function
    # untestable (and unaffected by any later override of the module global).
    path = path or ENV_FILE
    if not path.exists():
        return {}
    out = {}
    for line in path.read_text().splitlines():
        m = ENV_LINE.match(line.strip())
        if m:
            out[m.group(1)] = m.group(2)
    return out


def load_policy() -> dict:
    return yaml.safe_load((TOOL_DIR / "policy.yaml").read_text())


def slack_env_names() -> dict[str, str]:
    """domain -> its SLACK_CHANNEL_* var, from the canonical registry.

    The names are irregular (SLACK_CHANNEL_RC9, SLACK_CHANNEL_AMERICA_STRIKES,
    SLACK_CHANNEL_AMPUTEENEWS_COM). Deriving them from the domain would get
    several wrong; the registry already records the mapping.
    """
    if not REGISTRY.exists():
        return {}
    reg = yaml.safe_load(REGISTRY.read_text()) or {}
    return {d: v["slack_channel_env"] for d, v in (reg.get("sites") or {}).items()
            if v.get("slack_channel_env")}


def sites_with_ops() -> list[str]:
    return sorted(p.name for p in (ROOT / "sites").iterdir() if (p / "ops").is_dir())


def consumers() -> list[str]:
    """Sites that actually receive a fleet env — i.e. whose compose mounts one.

    Deliberately read off the filesystem rather than the registry: 21 of the 49
    registry entries are unbuilt scaffolds that have an `ops/` directory and no
    container, and granting them credentials for a container that does not
    exist is exactly the needless exposure this tool is removing. Matches both
    the pre-cutover mount (the shared .env) and the post-cutover one (a file
    from rendered/), so this list does not change shape mid-migration.
    """
    out = []
    for compose in sorted((ROOT / "sites").glob("*/docker-compose.yml")):
        try:
            text = compose.read_text(errors="ignore")
        except OSError:
            continue
        if "domains/.env:" in text or "env-broker/rendered/" in text:
            out.append(compose.parent.name)
    return out


def granted_keys(domain: str, policy: dict, slack: dict[str, str]) -> list[str]:
    site = (policy.get("sites") or {}).get(domain) or {}
    keys = set(policy["defaults"]["keys"])
    if domain in slack:
        keys.add(slack[domain])
    keys |= set(site.get("extra_keys") or [])
    keys -= set(site.get("deny_keys") or [])
    keys -= set(policy.get("never_grant") or [])
    return sorted(keys)


def referenced_keys(domain: str, all_keys: list[str]) -> set[str]:
    """Which fleet keys this site's ops/ actually mentions."""
    if not all_keys:
        return set()
    pat = re.compile(r"\b(" + "|".join(sorted(all_keys, key=len, reverse=True)) + r")\b")
    found: set[str] = set()
    for f in (ROOT / "sites" / domain / "ops").rglob("*"):
        if not f.is_file() or any(p in str(f) for p in SKIP_PARTS):
            continue
        try:
            if f.stat().st_size > 2_000_000:
                continue
            found |= set(pat.findall(f.read_text(errors="ignore")))
        except OSError:
            continue
    return found


# --- vault ------------------------------------------------------------------

# The "Fleet Env" collection in the "Domain Fleet" org. Deliberately NOT the
# "Social Media" collection that social_lib.vault_store writes to: keeping env
# secrets in their own collection is what makes per-collection access grants
# possible later (a `bw` user can be given one collection and not the other).
ENV_COLLECTION_ID = os.environ.get(
    "ENV_BROKER_COLLECTION_ID", "5745ce4f-e72a-4227-b1aa-6467484c0ef3"
)


def _vault():
    """Reuse social_lib.vault_store's session/auth plumbing, not its collection.

    That module already solves `bw` login, unlock, and on-disk session caching
    across the many short-lived processes this fleet spawns; re-implementing it
    here would mean two copies of the trickiest code in the credential path.
    """
    sys.path.insert(0, str(ROOT / "tools" / "social-lib" / "src"))
    from social_lib import vault_store  # noqa: E402
    return vault_store


def _vault_write(name: str, data: dict[str, str]) -> None:
    v = _vault()
    v._ensure_unlocked()
    fields = [{"name": k, "value": val,
               "type": 1 if any(t in k for t in ("PASSWORD", "SECRET", "TOKEN", "KEY")) else 0}
              for k, val in data.items()]
    body = {
        "organizationId": v.ORG_ID,
        "collectionIds": [ENV_COLLECTION_ID],
        "type": 1,
        "name": name,
        "login": {"username": "", "password": "", "uris": []},
        "fields": fields,
    }
    existing = v._find_item_by_name(name) if hasattr(v, "_find_item_by_name") else None
    if existing is None:
        items = json.loads(v._bw(["list", "items", "--search", name]))
        existing = next((i for i in items if i["name"] == name), None)
    if existing:
        v._bw(["edit", "item", existing["id"], v._encode(body)])
    else:
        v._bw(["create", "item", v._encode(body)])


def _vault_read(name: str) -> dict[str, str]:
    v = _vault()
    v._ensure_unlocked()
    items = json.loads(v._bw(["list", "items", "--search", name]))
    item = next((i for i in items if i["name"] == name), None)
    if not item:
        return {}
    return {f["name"]: f.get("value", "") for f in item.get("fields", [])}


def group_for(key: str, groups: dict[str, list[str]]) -> str:
    for name, prefixes in groups.items():
        if any(key.startswith(p) or key == p for p in prefixes):
            return name
    return "misc"


def load_env_vault(policy: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    for group in list(policy["vault"]["groups"]) + ["misc"]:
        out.update(_vault_read(f"fleet — env-{group}"))
    return out


def import_to_vault(policy: dict, dry_run: bool) -> int:
    env = load_env_file()
    if not env:
        print(f"nothing to import — {ENV_FILE} is empty or missing", file=sys.stderr)
        return 1
    groups: dict[str, dict[str, str]] = {}
    for k, val in env.items():
        groups.setdefault(group_for(k, policy["vault"]["groups"]), {})[k] = val
    for name, data in sorted(groups.items()):
        print(f"{'would write' if dry_run else 'writing'} vault item "
              f"'fleet — env-{name}' ({len(data)} keys)")
        if not dry_run:
            _vault_write(f"fleet — env-{name}", data)
    return 0


# --- render -----------------------------------------------------------------

def render(domain: str, keys: list[str], values: dict[str, str]) -> tuple[str, list[str]]:
    missing = [k for k in keys if k not in values]
    lines = [
        f"# Rendered by tools/env-broker for {domain} — DO NOT EDIT, DO NOT COMMIT.",
        "# Only the keys this site's ops/ actually uses. Everything else in the",
        "# fleet .env is deliberately absent; see tools/env-broker/policy.yaml.",
    ]
    lines += [f"{k}={values[k]}" for k in keys if k in values]
    return "\n".join(lines) + "\n", missing


def cmd_render(args, policy, slack) -> int:
    values = load_env_vault(policy) if args.source == "vault" else load_env_file()
    if args.source == "vault":
        # A partial vault read would silently render a site an env missing the
        # key its role needs, which shows up as a confusing runtime failure
        # hours later. Fall back loudly instead.
        file_values = load_env_file()
        if len(values) < len(file_values):
            print(f"warning: vault returned {len(values)} keys, .env has "
                  f"{len(file_values)} — filling the gap from .env", file=sys.stderr)
            values = {**file_values, **values}

    targets = [args.site] if args.site else consumers()
    rc = 0
    RENDER_DIR.mkdir(exist_ok=True)
    for domain in targets:
        keys = granted_keys(domain, policy, slack)
        body, missing = render(domain, keys, values)
        if missing:
            print(f"{domain}: no value for {', '.join(missing)}", file=sys.stderr)
            rc = 1
        if args.stdout:
            print(f"--- {domain} ({len(keys)} keys) ---")
            print(body, end="")
            continue
        out = RENDER_DIR / f"{domain}.env"
        # Write via a private temp file: a 0644 window between create and
        # chmod is all an attacker needs on a shared box.
        tmp = out.with_suffix(".env.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o400)
        with os.fdopen(fd, "w") as fh:
            fh.write(body)
        os.replace(tmp, out)
        try:
            shown = out.relative_to(ROOT)
        except ValueError:      # RENDER_DIR moved outside the repo
            shown = out
        print(f"{domain:26s} {len(keys):2d} keys -> {shown}")
    return rc


def cmd_check(args, policy, slack) -> int:
    values = load_env_vault(policy) if args.source == "vault" else load_env_file()
    all_keys = sorted(set(load_env_file()) | set(values))
    never = set(policy.get("never_grant") or [])
    drift = False

    for domain in consumers():
        keys = set(granted_keys(domain, policy, slack))
        used = referenced_keys(domain, all_keys)
        needed_not_granted = sorted(used - keys - never)
        granted_unused = sorted(keys - used)
        used_but_forbidden = sorted(used & never)

        if used_but_forbidden:
            drift = True
            print(f"FORBIDDEN {domain}: ops references never_grant key(s) "
                  f"{', '.join(used_but_forbidden)} — fix the script or the policy")
        if needed_not_granted:
            drift = True
            print(f"MISSING   {domain}: uses {', '.join(needed_not_granted)} "
                  f"but policy does not grant it — its role will break")
        if granted_unused:
            drift = True
            print(f"EXTRA     {domain}: granted {', '.join(granted_unused)} "
                  f"but ops/ never references it — needless exposure")

    missing_values = sorted(k for d in consumers()
                            for k in granted_keys(d, policy, slack) if k not in values)
    if missing_values:
        drift = True
        print(f"NOVALUE   source '{args.source}' has no value for: "
              f"{', '.join(sorted(set(missing_values)))}")

    if not drift:
        n = len(consumers())
        total = sum(len(granted_keys(d, policy, slack)) for d in consumers())
        print(f"policy ok — {n} sites, {total / n:.1f} keys each on average "
              f"(the shared .env has {len(load_env_file())})")
    return 2 if drift else 0


# --- cutover -----------------------------------------------------------------

# Every compose mount of the fleet envfile ends with this, whatever variable
# form the prefix takes (${HOME}, ${HOME:-/home/jesse}, or a literal path) and
# whatever the target is (/work/.env.shared, ${PWD}/.env.shared, /secrets/.env).
# Rewriting only the suffix leaves prefix and target untouched, so one rule
# covers all four mount styles in the fleet.
FLEET_ENV_SUFFIX = "projects/domains/.env:"
RENDERED_SUFFIX = "projects/domains/tools/env-broker/rendered/{domain}.env:"


def cmd_cutover(args, policy, slack) -> int:
    rc = 0
    targets = [args.site] if args.site else consumers()
    for domain in targets:
        compose = ROOT / "sites" / domain / "docker-compose.yml"
        if not compose.exists():
            print(f"{domain}: no docker-compose.yml", file=sys.stderr)
            rc = 1
            continue
        text = compose.read_text()
        rendered = RENDERED_SUFFIX.format(domain=domain)
        if args.revert:
            before, after = rendered, FLEET_ENV_SUFFIX
        else:
            before, after = FLEET_ENV_SUFFIX, rendered
            if not (RENDER_DIR / f"{domain}.env").exists():
                print(f"{domain}: refusing — rendered/{domain}.env does not exist "
                      f"yet (the container would start with no credentials)",
                      file=sys.stderr)
                rc = 1
                continue
        n = text.count(before)
        if n == 0:
            print(f"{domain:26s} already done (0 mounts to change)")
            continue
        if args.dry_run:
            print(f"{domain:26s} would rewrite {n} mount(s)")
            continue
        compose.write_text(text.replace(before, after))
        print(f"{domain:26s} rewrote {n} mount(s) -> "
              f"{'fleet .env' if args.revert else 'rendered/' + domain + '.env'}")
    return rc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--source", choices=["file", "vault"], default="file",
                    help="where values come from (default: the shared .env)")
    sub = ap.add_subparsers(dest="cmd")

    r = sub.add_parser("render", help="write per-site env files")
    r.add_argument("--site")
    r.add_argument("--all", action="store_true")
    r.add_argument("--stdout", action="store_true")

    c = sub.add_parser("cutover", help="point a site's compose at its rendered env")
    c.add_argument("--site")
    c.add_argument("--all", action="store_true")
    c.add_argument("--revert", action="store_true", help="back to the shared fleet .env")
    c.add_argument("--dry-run", action="store_true")

    iv = sub.add_parser("import-to-vault", help="push the shared .env into Fleet Env items")
    iv.add_argument("--dry-run", action="store_true")
    ap.add_argument("--check", action="store_true", help="policy/usage drift check")

    args = ap.parse_args()
    policy, slack = load_policy(), slack_env_names()

    if args.check or args.cmd is None:
        return cmd_check(args, policy, slack)
    if args.cmd == "render":
        if not (args.site or args.all or args.stdout):
            ap.error("render needs --site or --all")
        return cmd_render(args, policy, slack)
    if args.cmd == "cutover":
        if not (args.site or args.all):
            ap.error("cutover needs --site or --all")
        return cmd_cutover(args, policy, slack)
    if args.cmd == "import-to-vault":
        return import_to_vault(policy, args.dry_run)
    return 1


if __name__ == "__main__":
    sys.exit(main())
