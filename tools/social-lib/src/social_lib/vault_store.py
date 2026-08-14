"""Vaultwarden-backed credential store — replaces the old flat-file
ops/social/.<platform>-creds pattern.

All social platform creds live as vault items ("<domain> — <platform>") in the
"Domain Fleet" organization's "Social Media" collection (self-hosted
Vaultwarden, https://localhost:9280 — see /mnt/encrypted/projects/credential-vault/).
Written by the "Fleet Automation" account, but shared into the org so Jesse's
own personal vault account sees every item too — that's the whole point of
using an org instead of a personal vault only automation can read. Every
original key=value pair is preserved as a custom field so read_creds() is a
lossless round-trip regardless of each platform's naming (BLUESKY_PASSWORD vs
X_PASSWORD, etc). login.username/login.password are also set (best-effort,
first *_USERNAME/*_HANDLE and *_PASSWORD-suffixed field) purely so the item
looks sane in the Bitwarden UI — read_creds() ignores them and reads only the
`fields` array as the source of truth.

Requires the `bw` CLI (npm i -g @bitwarden/cli) and the automation account's
credentials at /mnt/encrypted/projects/credential-vault/automation-account.env.
The vault's TLS cert is self-signed (loopback-only service), so instead of
disabling verification we point Node at that specific CA via
NODE_EXTRA_CA_CERTS — trust is scoped to this one cert, not "accept anything".
"""

from __future__ import annotations

import base64
import json
import os
import subprocess

VAULT_ENV_FILE = "/mnt/encrypted/projects/credential-vault/automation-account.env"
VAULT_CA_CERT = "/mnt/encrypted/projects/credential-vault/ssl/cert.pem"
VAULT_SERVER = "https://localhost:9280"
ORG_ID = "a04180d3-c861-4f21-a410-02ac919e80dc"          # "Domain Fleet"
COLLECTION_ID = "cacd4253-453d-4d5b-a039-2e6cd18118aa"    # "Social Media"
SESSION_CACHE_FILE = "/mnt/encrypted/projects/credential-vault/.session_cache"

_session_key: str | None = None


def _load_automation_creds() -> dict[str, str]:
    creds = {}
    for line in open(VAULT_ENV_FILE):
        line = line.strip()
        if not line or "=" not in line:
            continue
        k, _, v = line.partition("=")
        creds[k.strip()] = v.strip()
    return creds


def _bw(args: list[str], input_text: str | None = None) -> str:
    env = os.environ.copy()
    env["NODE_EXTRA_CA_CERTS"] = VAULT_CA_CERT
    if _session_key:
        env["BW_SESSION"] = _session_key
    proc = subprocess.run(
        ["bw"] + args, capture_output=True, text=True, env=env, input=input_text
    )
    if proc.returncode != 0:
        raise RuntimeError(f"bw {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout.strip()


def _ensure_unlocked() -> None:
    """Log in + unlock the automation account. Caches the session key both
    in-process AND on disk (SESSION_CACHE_FILE) so the many short-lived
    scripts/subprocesses this fleet spawns don't each pay a full login+unlock
    round trip — that was slow and occasionally flaked into an interactive
    master-password prompt when called back-to-back in a loop."""
    global _session_key
    if _session_key:
        return

    env = os.environ.copy()
    env["NODE_EXTRA_CA_CERTS"] = VAULT_CA_CERT
    subprocess.run(["bw", "config", "server", VAULT_SERVER], capture_output=True, env=env)

    # Try the cached session first — cheap, and covers the common case of
    # many processes running within the same unlocked window.
    cached = None
    if os.path.exists(SESSION_CACHE_FILE):
        cached = open(SESSION_CACHE_FILE).read().strip()
    if cached:
        check_env = dict(env)
        check_env["BW_SESSION"] = cached
        status = json.loads(subprocess.run(
            ["bw", "status"], capture_output=True, text=True, env=check_env
        ).stdout or "{}")
        if status.get("status") == "unlocked":
            _session_key = cached
            return

    creds = _load_automation_creds()
    # Password goes in via env + --passwordenv, never argv — argv is world-readable
    # via /proc/*/cmdline (and `ps`) on a shared box, env of another user's process isn't.
    env["BW_PASSWORD"] = creds["AUTOMATION_PASSWORD"]

    status = json.loads(subprocess.run(
        ["bw", "status"], capture_output=True, text=True, env=env
    ).stdout or "{}")

    if status.get("status") == "unauthenticated":
        subprocess.run(
            ["bw", "login", creds["AUTOMATION_EMAIL"], "--passwordenv", "BW_PASSWORD", "--raw"],
            capture_output=True, text=True, env=env,
        )

    unlock = subprocess.run(
        ["bw", "unlock", "--passwordenv", "BW_PASSWORD", "--raw"],
        capture_output=True, text=True, env=env,
    )
    if unlock.returncode != 0 or not unlock.stdout.strip():
        raise RuntimeError(f"vault unlock failed: {unlock.stderr.strip()}")
    _session_key = unlock.stdout.strip()
    del env["BW_PASSWORD"]

    with open(SESSION_CACHE_FILE, "w") as f:
        f.write(_session_key)
    os.chmod(SESSION_CACHE_FILE, 0o600)


def _encode(obj: dict) -> str:
    return base64.b64encode(json.dumps(obj).encode()).decode()


def _find_item(domain: str, platform: str) -> dict | None:
    _ensure_unlocked()
    name = f"{domain} — {platform}"
    items = json.loads(_bw(["list", "items", "--search", name]))
    for it in items:
        if it["name"] == name:
            return it
    return None


def write_creds(domain: str, platform: str, data: dict) -> None:
    """Create or update the vault item for domain/platform with `data` as the
    complete, lossless field set. Always lands in the shared org collection —
    every item is visible from Jesse's personal vault, not just automation's."""
    _ensure_unlocked()

    username = next(
        (v for k, v in data.items() if "USERNAME" in k or "HANDLE" in k), ""
    )
    password = next((v for k, v in data.items() if "PASSWORD" in k), "")
    fields = [
        {"name": k, "value": v, "type": 1 if any(s in k for s in ("PASSWORD", "SECRET", "TOKEN")) else 0}
        for k, v in data.items()
    ]

    item_body = {
        "organizationId": ORG_ID,
        "collectionIds": [COLLECTION_ID],
        "type": 1,  # login
        "name": f"{domain} — {platform}",
        "login": {"username": username, "password": password, "uris": []},
        "fields": fields,
    }

    existing = _find_item(domain, platform)
    encoded = _encode(item_body)
    if existing:
        _bw(["edit", "item", existing["id"], encoded])
    else:
        _bw(["create", "item", encoded])


def read_creds(domain: str, platform: str) -> dict:
    item = _find_item(domain, platform)
    if not item:
        return {}
    return {f["name"]: f.get("value", "") for f in item.get("fields", [])}


def has_creds(domain: str, platform: str) -> bool:
    return _find_item(domain, platform) is not None


def write_stub(domain: str, platform: str) -> None:
    if not has_creds(domain, platform):
        write_creds(domain, platform, {"STATUS": "deferred"})
