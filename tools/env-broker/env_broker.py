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
import subprocess
import sys
from pathlib import Path

import yaml

TOOL_DIR = Path(__file__).resolve().parent
ROOT = TOOL_DIR.parent.parent
TOOLS_ROOT = ROOT / "tools"
ENV_FILE = ROOT / ".env"
REGISTRY = ROOT / "registry" / "fleet.yaml"
RENDER_DIR = TOOL_DIR / "rendered"

ENV_LINE = re.compile(r"^([A-Z0-9_]+)=(.*)$")
# Directories whose contents are output, not source — scanning them produces
# phantom "references" from logged command lines.
SKIP_PARTS = ("/logs/", "/node_modules/", "/.venv/", "/board/", "/__pycache__/", "/out/")
# Matched as a path-segment prefix, not a substring: catches venv dirs with a
# suffix (ops/.venv-social-poster/) that the /.venv/ literal above misses —
# env_broker --check was flagging their vendored site-packages copies of
# fleet libs (e.g. social_lib/sms_gate.py's SMSPOOL_API_KEY) as if the site's
# own ops/ scripts used the key.
SKIP_PREFIXES = (".venv",)


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
            out[m.group(1)] = _strip_inline_comment(m.group(2))
    return out


def _strip_inline_comment(value: str) -> str:
    """Drop a trailing ` # comment`, the way `source`ing the file would.

    These files are read two ways: shell `set -a; . .env.shared` (which treats
    whitespace-then-# on an unquoted word as a comment) and direct parsers like
    this one (which did not). CLOUDFLARE_ACCOUNT_ID carried
    `   # from dash.cloudflare.com right-sidebar` into 31 rendered files and
    stayed invisible for exactly that reason — every consumer happened to be
    shell. The first non-shell consumer got the comment inside an API resource
    name and Cloudflare rejected it.

    A quoted value is left entirely alone: shell would keep a `#` inside quotes,
    and a credential is perfectly entitled to contain one.
    """
    v = value.strip()
    if v[:1] in ('"', "'"):
        return value
    cut = v.find(" #")
    tab = v.find("\t#")
    if tab != -1 and (cut == -1 or tab < cut):
        cut = tab
    return v[:cut].rstrip() if cut != -1 else value


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


def tool_consumers() -> list[str]:
    """Tool containers under tools/ whose compose mounts a fleet env."""
    out = []
    for compose in sorted(TOOLS_ROOT.glob("*/docker-compose.yml")):
        name = compose.parent.name
        if name == "env-broker":
            continue
        try:
            text = compose.read_text(errors="ignore")
        except OSError:
            continue
        if "domains/.env:" in text or "env-broker/rendered/" in text:
            out.append(name)
    return out


def tool_keys(name: str, policy: dict) -> list[str]:
    spec = (policy.get("tools") or {}).get(name) or {}
    keys = set(spec.get("keys") or [])
    # never_grant does not apply to tools: gh-stats legitimately IS the GitHub
    # collector and amz-stats IS the Amazon one. The point of the list is that
    # no *site* holds a fleet-wide credential, not that nothing may.
    return sorted(keys)


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
    """Which fleet keys this site's ops/ actually mentions.

    Two carve-outs, both surfaced by the 2026-09-04 FORBIDDEN alert firing on
    every site that has run-engineer.sh:
    - `KEY=` with an empty value — the shell idiom `CF_API_TOKEN= CLOUDFLARE_
      API_TOKEN= claude ...` blanks a var so a subprocess (the model pass)
      can't inherit it. That's revoking the key, not referencing it; scoring
      it as "used" made every site FORBIDDEN on the never_grant key it was
      actively defending against.
    - Markdown files. A role doc's prose (e.g. a "Credentials" section
      pointing at `tools/env-broker/rendered/...`) quoting a key name isn't a
      runtime dependency — nothing under ops/ reads env vars out of a .md
      file. (stinkyleftfoot.com/ops/roles/social-poster.md naming FD_TOKEN.)
    """
    if not all_keys:
        return set()
    pat = re.compile(
        r"\b(" + "|".join(sorted(all_keys, key=len, reverse=True)) + r")\b"
        r"(?!=(?=\s|$))"
    )
    found: set[str] = set()
    for f in (ROOT / "sites" / domain / "ops").rglob("*"):
        if not f.is_file() or any(p in str(f) for p in SKIP_PARTS):
            continue
        if any(part.startswith(SKIP_PREFIXES) for part in f.parts):
            continue
        if f.suffix == ".md":
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


SITE_ITEM_PREFIX = "fleet — site-"


def _vault_read_sites() -> dict[str, dict[str, str]]:
    """Every per-site vault item in ONE `bw` call, as {domain: {key: value}}.

    Thirty sequential reads would make `render --all` take minutes, and a slow
    render is a render people skip.
    """
    v = _vault()
    v._ensure_unlocked()
    items = json.loads(v._bw(["list", "items", "--search", SITE_ITEM_PREFIX]))
    out: dict[str, dict[str, str]] = {}
    for item in items:
        name = item.get("name", "")
        if not name.startswith(SITE_ITEM_PREFIX):
            continue
        domain = name[len(SITE_ITEM_PREFIX):]
        out[domain] = {f["name"]: f.get("value", "")
                       for f in item.get("fields", [])}
    return out


def per_site_keys(policy: dict) -> list[str]:
    return list(policy.get("per_site_vault") or [])


def site_values(policy: dict) -> dict[str, dict[str, str]]:
    """Per-site overrides, restricted to the keys policy says are per-site.

    A site item is not a second allowlist: only `per_site_vault` keys are
    honoured, so a stray field in one item can never widen what that site gets.
    """
    wanted = set(per_site_keys(policy))
    if not wanted:
        return {}
    try:
        raw = _vault_read_sites()
    except Exception as exc:
        _fatal_if_missing_binary(exc)
        print(f"warning: per-site vault read failed ({exc}) — falling back to "
              f"the fleet-wide values", file=sys.stderr)
        return {}
    return {d: {k: v for k, v in fields.items() if k in wanted and v}
            for d, fields in raw.items()}

def _fatal_if_missing_binary(exc: Exception) -> None:
    """A missing `bw` binary is a container/host build defect, not a vault
    outage — silently falling back to fleet-wide creds would mask it for as
    long as nobody happens to read stderr. Every other vault error (locked,
    unreachable, auth expired) is transient and keeps the existing
    warn-and-fall-back behavior; this is the one that must stop the run.
    """
    if isinstance(exc, FileNotFoundError):
        print(f"FATAL: bw CLI not found ({exc}) — this is a broken install, "
              f"not a transient vault outage. Falling back would silently "
              f"hand out fleet-wide credentials instead of per-site scoped "
              f"ones. Fix the image/PATH, don't ignore this.", file=sys.stderr)
        sys.exit(1)


def group_for(key: str, groups: dict[str, list[str]]) -> str:
    for name, prefixes in groups.items():
        if any(key.startswith(p) or key == p for p in prefixes):
            return name
    return "misc"


def load_env_vault(policy: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    for group in list(policy["vault"]["groups"]) + ["misc"]:
        # A named policy group is authoritative. During migrations a legacy
        # copy may still exist in `misc`; never let that stale duplicate
        # override the correctly grouped value loaded first.
        for key, value in _vault_read(f"fleet — env-{group}").items():
            out.setdefault(key, value)
    return out


def import_to_vault(policy: dict, dry_run: bool) -> int:
    env = load_env_file()
    if not env:
        print(f"nothing to import — {ENV_FILE} is empty or missing", file=sys.stderr)
        return 1
    groups: dict[str, dict[str, str]] = {}
    for k, val in env.items():
        groups.setdefault(group_for(k, policy["vault"]["groups"]), {})[k] = val
    # _vault_write replaces an item's fields wholesale, and vault-only keys are
    # by definition absent from the .env this import reads — so a plain import
    # would DELETE FD_TOKEN from the vault, its only home. Carry them over.
    vault_only = set(policy.get("vault_only") or [])
    for name, data in sorted(groups.items()):
        preserved = {}
        if vault_only:
            existing = _vault_read(f"fleet — env-{name}")
            preserved = {k: v for k, v in existing.items()
                         if k in vault_only and k not in data}
            data = {**data, **preserved}
        note = f", preserving {', '.join(sorted(preserved))}" if preserved else ""
        print(f"{'would write' if dry_run else 'writing'} vault item "
              f"'fleet — env-{name}' ({len(data)} keys){note}")
        if not dry_run:
            _vault_write(f"fleet — env-{name}", data)
    return 0


def vault_only_keys(policy: dict) -> list[str]:
    return list(policy.get("vault_only") or [])


def merge_vault_only(values: dict[str, str], policy: dict) -> dict[str, str]:
    """Overlay the vault-only keys, whatever --source the caller asked for.

    These keys are deliberately absent from the shared .env (that is the point
    of the list), so a `--source file` run would otherwise report them missing
    and render a file without them. Only the vault groups that actually cover a
    vault-only key are read, so this costs one `bw` call, not a full vault
    load, and a vault outage leaves `values` untouched rather than half-filled.
    """
    wanted = [k for k in vault_only_keys(policy) if k not in values]
    if not wanted:
        return values
    groups = policy["vault"]["groups"]
    for group in sorted({group_for(k, groups) for k in wanted}):
        try:
            found = _vault_read(f"fleet — env-{group}")
        except Exception as exc:                        # vault down / locked
            _fatal_if_missing_binary(exc)
            print(f"warning: vault unreachable for {group}: {exc}", file=sys.stderr)
            continue
        values.update({k: v for k, v in found.items() if k in wanted})
    return values


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


def container_name_for(domain: str, is_tool: bool) -> str | None:
    """The container_name of the compose service that mounts this rendered file.

    Not the compose *project* — a tool compose can define several services
    (data-hub: collector + api), and only one of them mounts the rendered env.
    Restarting the wrong sibling would leave the actually-stale container
    running on the old inode while looking like the fix worked.
    """
    compose = (TOOLS_ROOT / domain / "docker-compose.yml" if is_tool
               else ROOT / "sites" / domain / "docker-compose.yml")
    if not compose.exists():
        return None
    try:
        spec = yaml.safe_load(compose.read_text()) or {}
    except yaml.YAMLError:
        return None
    needle = f"env-broker/rendered/{'tool-' if is_tool else ''}{domain}.env"
    for svc in (spec.get("services") or {}).values():
        # Mounted two different ways across composes: a bind-mounted `volumes:`
        # entry (most sites, most tools) or a compose `env_file:` entry (e.g.
        # tools/cf-broker) — both pin an inode the same way, so both count.
        mounts = list(svc.get("volumes") or []) + list(svc.get("env_file") or [])
        # A rendered file is often referenced by more than one service in the
        # same compose (0daynews.com's `worker` AND `cron` both use it) — skip
        # a match whose service has no container_name rather than stopping on
        # it, so a later sibling that does name one is still found.
        if svc.get("container_name") and any(needle in str(v) for v in mounts):
            return svc.get("container_name")
    return None


def restart_if_running(name: str) -> str:
    """docker restart, but only a container that exists and is running.

    A stopped/cattle container (e.g. tool containers cron spins up on demand)
    will pick up the fresh render on its next start regardless — restarting it
    now would just leave it stopped again, printing false confidence.
    """
    probe = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", name],
        capture_output=True, text=True,
    )
    if probe.returncode != 0:
        return "not running (no such container) — will pick up the new render on next start"
    if probe.stdout.strip() != "true":
        return "not running — will pick up the new render on next start"
    result = subprocess.run(["docker", "restart", name], capture_output=True, text=True)
    if result.returncode != 0:
        return f"RESTART FAILED: {result.stderr.strip()}"
    return "restarted"


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
    values = merge_vault_only(values, policy)
    vault_only = set(vault_only_keys(policy))
    per_site = site_values(policy)

    targets = [args.site] if args.site else consumers()
    tool_targets = [] if args.site else tool_consumers()
    rc = 0
    changed: list[tuple[str, bool]] = []   # (domain, is_tool) whose file content changed
    RENDER_DIR.mkdir(exist_ok=True)
    for domain in [*targets, *(f"tool:{t}" for t in tool_targets)]:
        is_tool = domain.startswith("tool:")
        name = domain[5:] if is_tool else domain
        keys = tool_keys(name, policy) if is_tool else granted_keys(domain, policy, slack)
        domain = name
        # A site's own credential wins over the fleet-wide one. Tools are
        # deliberately excluded: cf-stats and site-tracker aggregate ACROSS the
        # fleet, so an account-scoped token is what they legitimately need.
        vals = values if is_tool else {**values, **per_site.get(domain, {})}
        body, missing = render(domain, keys, vals)
        if missing:
            print(f"{domain}: no value for {', '.join(missing)}", file=sys.stderr)
            rc = 1
        blocked = sorted(set(missing) & vault_only)
        if blocked:
            # Writing a body without these would replace a working credential
            # with nothing — the panel would come back up unauthenticated on
            # the next restart. Leave the last good render in place instead.
            print(f"{domain}: SKIPPED — {', '.join(blocked)} unavailable; "
                  f"the existing rendered file is left untouched",
                  file=sys.stderr)
            continue
        if args.stdout:
            print(f"--- {domain} ({len(keys)} keys) ---")
            print(body, end="")
            continue
        out = RENDER_DIR / (f"tool-{domain}.env" if is_tool else f"{domain}.env")
        try:
            before = out.read_text()
        except OSError:
            before = None
        # Write via a private temp file: a 0644 window between create and
        # chmod is all an attacker needs on a shared box.
        tmp = out.with_suffix(".env.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o400)
        with os.fdopen(fd, "w") as fh:
            fh.write(body)
        os.replace(tmp, out)
        if body != before:
            changed.append((domain, is_tool))
        try:
            shown = out.relative_to(ROOT)
        except ValueError:      # RENDER_DIR moved outside the repo
            shown = out
        print(f"{domain:26s} {len(keys):2d} keys -> {shown}")

    if getattr(args, "restart", False):
        # A bind mount pins the inode a container opened at start — a
        # re-render alone never reaches an already-running process. This is
        # the manual, explicit bounce (never scheduled/automatic — see
        # tools/scripts/env-broker-check-cron.sh) for the one case where
        # skipping it leaves a container running on stale credentials: the
        # file it has open actually changed.
        if not changed:
            print("--restart: no rendered file changed, nothing to bounce")
        for domain, is_tool in changed:
            name = container_name_for(domain, is_tool)
            label = f"tools/{domain}" if is_tool else domain
            if not name:
                print(f"{label:26s} -> no container_name found in its "
                      f"docker-compose.yml, restart it by hand")
                continue
            print(f"{label:26s} -> {name}: {restart_if_running(name)}")
    elif changed:
        names = ", ".join(f"tools/{d}" if t else d for d, t in changed)
        print(f"\n{len(changed)} file(s) changed on disk ({names}) — their "
              f"containers still hold the OLD one open (bind mount pins the "
              f"inode). Re-run with --restart, or restart them by hand.")
    return rc


def cmd_set_secret(args, policy, slack) -> int:
    """Write one key into its vault group, then re-render.

    The vault is the only home for `vault_only` keys, so rotating one means a
    vault write — editing the rendered file directly looks like it worked and is
    reverted by the next render. `bw edit` replaces an item's fields wholesale,
    so the group is read back and rewritten around the single changed key.
    """
    value = sys.stdin.read().strip()
    if not value:
        print("set-secret: no value on stdin", file=sys.stderr)
        return 1

    item = f"fleet — env-{args.group}"
    fields = _vault_read(item)
    if not fields:
        print(f"set-secret: vault item {item!r} not found — refusing to create "
              f"it blind", file=sys.stderr)
        return 1
    if args.key not in fields and not args.create:
        # Default-refuse: a typo'd key would otherwise silently add a second
        # field alongside the real one and rotate nothing (cf. CF_SECRETE_ACCESS_KEY).
        print(f"set-secret: {args.key} is not a field of {item!r}; the group is "
              f"probably wrong (has: {', '.join(sorted(fields))}). Pass --create "
              f"if you really are adding a new key.", file=sys.stderr)
        return 1

    fields[args.key] = value
    _vault_write(item, fields)
    if _vault_read(item).get(args.key) != value:
        print("set-secret: vault write did not read back — NOT rotated",
              file=sys.stderr)
        return 1
    print(f"{item}: {args.key} updated")

    # A rotated secret is exactly the case a bind mount hides from a running
    # container, so bounce whatever the re-render actually changes — that is
    # the whole point of rotating it.
    args.site, args.all, args.stdout, args.source, args.restart = (
        None, True, False, "file", True)
    return cmd_render(args, policy, slack)


def rendered_drift(name: str, keys: list[str], values: dict[str, str],
                   is_tool: bool = False) -> str | None:
    """Does the file on disk still match what policy would render today?

    `--check` verified policy-vs-usage and the file's existence and mode, but
    never its contents — so a site whose policy was corrected but whose file was
    never re-rendered reported "policy ok" while its container ran without the
    key. That is the silent failure this tool exists to prevent, and it happened
    (arttogogh.com, 2026-09-01). Values are compared but NEVER printed.
    """
    out = RENDER_DIR / (f"tool-{name}.env" if is_tool else f"{name}.env")
    try:
        on_disk = {k: v for k, v in (
            line.split("=", 1) for line in out.read_text().splitlines()
            if "=" in line and not line.startswith("#"))}
    except OSError:
        return None                     # existence is the cron script's job

    expected = {k: values[k] for k in keys if k in values}
    added = sorted(set(expected) - set(on_disk))
    dropped = sorted(set(on_disk) - set(expected))
    changed = sorted(k for k in set(expected) & set(on_disk)
                     if expected[k] != on_disk[k])
    if not (added or dropped or changed):
        return None

    parts = []
    if added:
        parts.append(f"missing {', '.join(added)} — its role will break")
    if dropped:
        parts.append(f"still holds {', '.join(dropped)}")
    if changed:
        parts.append(f"stale value for {', '.join(changed)}")
    return "; ".join(parts)

def cmd_check(args, policy, slack) -> int:
    values = load_env_vault(policy) if args.source == "vault" else load_env_file()
    values = merge_vault_only(values, policy)
    per_site = site_values(policy)
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

        own = per_site.get(domain, {})
        shared = sorted(k for k in per_site_keys(policy) if k in keys and k not in own)
        if shared:
            print(f"FLEETWIDE {domain}: still on the shared "
                  f"{', '.join(shared)} — mint a scoped one "
                  f"(tools/cf-tokens/mint.py --site {domain})")

        stale = rendered_drift(domain, sorted(keys), {**values, **own})
        if stale:
            drift = True
            print(f"STALE     {domain}: rendered file {stale} — re-render, then "
                  f"RESTART its container (a file bind mount pins the old inode, "
                  f"so a running container never sees a re-render)")

    for name in tool_consumers():
        keys = set(tool_keys(name, policy))
        if not keys:
            drift = True
            print(f"UNLISTED  tools/{name}: mounts a fleet env but has no entry "
                  f"under `tools:` in policy.yaml — it would render an EMPTY file")
        gone = sorted(k for k in keys if k not in values)
        if gone:
            drift = True
            print(f"NOVALUE   tools/{name}: no value for {', '.join(gone)}")

        stale = rendered_drift(name, sorted(keys), values, is_tool=True)
        if stale:
            drift = True
            print(f"STALE     tools/{name}: rendered file {stale} — re-render, "
                  f"then RESTART the container")

    missing_values = sorted(k for d in consumers()
                            for k in granted_keys(d, policy, slack) if k not in values)
    if missing_values:
        drift = True
        print(f"NOVALUE   source '{args.source}' has no value for: "
              f"{', '.join(sorted(set(missing_values)))}")

    if not drift:
        n = len(consumers())
        total = sum(len(granted_keys(d, policy, slack)) for d in consumers())
        tn = len(tool_consumers())
        ttotal = sum(len(tool_keys(t, policy)) for t in tool_consumers())
        print(f"policy ok — {n} sites, {total / n:.1f} keys each on average; "
              f"{tn} tools, {ttotal} keys total "
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
    r.add_argument("--restart", action="store_true",
                   help="also `docker restart` any container whose rendered "
                        "file actually changed (a bind mount pins the old "
                        "inode, so a running container never sees a "
                        "re-render on its own). Manual and explicit only — "
                        "never run from cron; see env-broker-check-cron.sh.")

    c = sub.add_parser("cutover", help="point a site's compose at its rendered env")
    c.add_argument("--site")
    c.add_argument("--all", action="store_true")
    c.add_argument("--revert", action="store_true", help="back to the shared fleet .env")
    c.add_argument("--dry-run", action="store_true")

    iv = sub.add_parser("import-to-vault", help="push the shared .env into Fleet Env items")
    iv.add_argument("--dry-run", action="store_true")

    ss = sub.add_parser("set-secret",
                        help="write one key (value on stdin) to its vault group, then re-render")
    ss.add_argument("--group", required=True, help="vault group, e.g. dashboard")
    ss.add_argument("--key", required=True, help="key name, e.g. FD_TOKEN")
    ss.add_argument("--create", action="store_true",
                    help="allow adding a key the group does not have yet")
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
    if args.cmd == "set-secret":
        return cmd_set_secret(args, policy, slack)
    return 1


if __name__ == "__main__":
    sys.exit(main())
