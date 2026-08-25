"""Channels — the hub's view of "an account we can post from".

A channel is (site, platform, persona-or-brand). The authoritative inventory
already exists in the social registry (`tools/social-setup/registry/social.json`,
[[project_social_registry]]) and the secrets already live in Vaultwarden
([[project_social_media_vault_rollout_2026-08]]). The hub owns neither — it
mirrors the registry into its own `channels` table so scheduling has something
cheap and local to join against, and pulls creds from the vault on demand.

Two deliberate consequences:
  * Marking an account `suspended` in the registry (the fleet's existing way to
    say "this got spam-banned") disables its channel here on the next sync. One
    kill switch, not two.
  * `bw` shells out and is slow, so vault reads are cached in-process with a
    TTL. A tick that publishes ten posts pays one unlock, not ten.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from social_hub import db
from social_hub.config import domains_root

REGISTRY_FILE = Path(
    os.environ.get(
        "SOCIAL_HUB_REGISTRY",
        str(domains_root() / "tools" / "social-setup" / "registry" / "social.json"),
    )
)

#: registry statuses that mean "usable for posting right now"
LIVE_STATUSES = {"active"}
#: statuses for channels this tool created itself from config, which the
#: registry has never heard of and must never disable
LOCAL_STATUSES = {"local", "unprovisioned"}

_creds_cache: dict[tuple[str, str], tuple[float, dict]] = {}
_items_cache: dict[str, dict[str, dict]] = {}
CREDS_TTL_SECONDS = 300


# --------------------------------------------------------------------------
# registry -> channels
# --------------------------------------------------------------------------
def read_registry() -> dict:
    if not REGISTRY_FILE.exists():
        return {"accounts": [], "personas": [], "siteMeta": {}}
    try:
        return json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))
    except ValueError:
        return {"accounts": [], "personas": [], "siteMeta": {}}


def sync_channels(sites: list[str] | None = None) -> dict:
    """Upsert channels for *sites* (default: every site in the registry).

    Never deletes: a channel that vanishes from the registry is disabled, not
    dropped, so its post history keeps its foreign key.
    """
    registry = read_registry()
    personas = {p["id"]: p for p in registry.get("personas", [])}
    accounts = registry.get("accounts", [])
    if sites is not None:
        wanted = set(sites)
        accounts = [a for a in accounts if a.get("site") in wanted]

    seen: set[tuple[str, str, str]] = set()
    created = updated = 0
    now = db.utcnow()

    for acc in accounts:
        site = acc.get("site")
        platform = acc.get("platform")
        if not site or not platform:
            continue
        persona_name = ""
        if acc.get("scope") == "persona" and acc.get("personaId"):
            persona_name = (personas.get(acc["personaId"]) or {}).get("name", "")
        key = (site, platform, persona_name)
        seen.add(key)

        status = acc.get("status", "unknown")
        row = db.one(
            "SELECT * FROM channels WHERE site = ? AND platform = ? AND persona = ?",
            (site, platform, persona_name),
        )
        payload: dict[str, Any] = {
            "handle": acc.get("handle") or "",
            "status": status,
            "has_creds": 1 if acc.get("credsInVault") else 0,
            "note": acc.get("statusNote") or "",
        }
        if row is None:
            db.insert(
                "channels",
                {
                    "site": site,
                    "platform": platform,
                    "persona": persona_name,
                    "enabled": 1 if status in LIVE_STATUSES else 0,
                    "created_at": now,
                    "updated_at": now,
                    **payload,
                },
            )
            created += 1
        else:
            # `enabled` is the operator's switch and is preserved — except when
            # the registry says the account is no longer live, which always wins.
            if status not in LIVE_STATUSES:
                payload["enabled"] = 0
            db.update("channels", row["id"], payload)
            updated += 1

    # Disable channels the registry no longer lists for the synced sites.
    scope = "" if sites is None else " AND site IN (%s)" % ",".join("?" * len(sites))
    params = tuple(sites or ())
    stale = 0
    for row in db.query(f"SELECT * FROM channels WHERE 1=1{scope}", params):
        if row["status"] in LOCAL_STATUSES:
            continue  # config-declared channel (e.g. console) — not registry-backed
        if (row["site"], row["platform"], row["persona"] or "") not in seen and row["enabled"]:
            db.update("channels", row["id"], {"enabled": 0, "note": "not in registry"})
            stale += 1

    db.log_event(
        "channels.sync",
        message=f"{created} created, {updated} updated, {stale} disabled",
        data={"sites": sites or "all"},
    )
    return {"created": created, "updated": updated, "disabled": stale}



def ensure_config_channels(site: str, platforms: list[str]) -> int:
    """Create channels for configured platforms the registry doesn't know about.

    The registry tracks *provisioned social accounts*. Some channels aren't
    that — `console` is a local outbox with no account behind it — and a site
    can also be configured for a platform before its account exists. Both get a
    row here so the queue has somewhere to hang posts:

      * needs no credentials (console)  -> enabled, ready to use
      * needs credentials, none on file -> created disabled, with a note saying
        why, so it shows up in the UI as work-to-do instead of silently missing.
    """
    from social_hub.platforms import adapter_class

    created = 0
    now = db.utcnow()
    for platform in platforms:
        if get_channel(site, platform, ""):
            continue
        try:
            needs_creds = bool(adapter_class(platform).required_creds)
        except KeyError:
            continue
        db.insert(
            "channels",
            {
                "site": site,
                "platform": platform,
                "persona": "",
                "handle": "",
                "status": "local" if not needs_creds else "unprovisioned",
                "enabled": 0 if needs_creds else 1,
                "has_creds": 0,
                "note": "" if not needs_creds else "no account in the social registry",
                "created_at": now,
                "updated_at": now,
            },
        )
        created += 1
    return created

# --------------------------------------------------------------------------
# lookups
# --------------------------------------------------------------------------
def list_channels(site: str | None = None, platform: str | None = None) -> list[dict]:
    sql = "SELECT * FROM channels WHERE 1=1"
    params: list[Any] = []
    if site:
        sql += " AND site = ?"
        params.append(site)
    if platform:
        sql += " AND platform = ?"
        params.append(platform)
    sql += " ORDER BY site, platform, persona"
    return db.rows_to_dicts(db.query(sql, tuple(params)))


def get_channel(site: str, platform: str, persona: str = "") -> dict | None:
    return db.row_to_dict(
        db.one(
            "SELECT * FROM channels WHERE site = ? AND platform = ? AND persona = ?",
            (site, platform, persona),
        )
    )


def pick_channel(site: str, platform: str, persona: str | None = None) -> dict | None:
    """The channel to post through: the named persona if given and enabled,
    else the brand channel, else any enabled channel on that platform."""
    if persona:
        chan = get_channel(site, platform, persona)
        if chan and chan["enabled"]:
            return chan
    brand = get_channel(site, platform, "")
    if brand and brand["enabled"]:
        return brand
    rows = db.query(
        "SELECT * FROM channels WHERE site = ? AND platform = ? AND enabled = 1 LIMIT 1",
        (site, platform),
    )
    return db.row_to_dict(rows[0]) if rows else None


# --------------------------------------------------------------------------
# credentials
# --------------------------------------------------------------------------
def creds_keys(platform: str, persona: str = "") -> list[str]:
    """Vault item suffixes to try, most specific first. Persona accounts were
    provisioned under a few different naming conventions across the fleet, so
    resolution is tolerant rather than assuming one shape."""
    if not persona:
        return [platform]
    return [f"{platform}:{persona}", f"{platform}-{persona}", f"{persona}-{platform}", platform]


def _vault_items(site: str) -> dict[str, dict]:
    """Every vault item for *site*, keyed by the suffix after the em dash.

    One `bw list` call per site instead of one per (channel, naming-convention)
    guess. That matters: `bw` shells out and takes seconds, and a site with a
    five-persona roster was costing dozens of round trips per tick — enough to
    push a single poll past two minutes. Cached for the life of the process.
    """
    cached = _items_cache.get(site)
    if cached is not None:
        return cached

    items: dict[str, dict] = {}
    try:
        from social_lib import vault_store

        vault_store._ensure_unlocked()
        raw = json.loads(vault_store._bw(["list", "items", "--search", site]))
    except Exception as exc:
        db.log_event("creds.error", site=site, message=f"vault list failed: {exc}")
        raw = []

    for item in raw:
        name = item.get("name", "")
        if not name.startswith(site):
            continue
        # Items are named "<domain> — <platform[:persona]>"
        suffix = name[len(site):].lstrip(" —-").strip()
        if suffix:
            items[suffix] = item

    _items_cache[site] = items
    return items


def _creds_from_item(item: dict, platform: str) -> dict:
    """Fields are the source of truth; the login object fills in a missing
    username/password. Some accounts (Bluesky, notably) were provisioned with
    the password only in the item's native login object, so a fields-only read
    sees a handle and no way in."""
    creds = {f["name"]: f.get("value", "") for f in item.get("fields", []) or []}
    login = item.get("login") or {}
    prefix = platform.upper()
    if login.get("password") and not any("PASSWORD" in key for key in creds):
        creds[f"{prefix}_PASSWORD"] = login["password"]
    if login.get("username") and not any(
        key.endswith(("_USERNAME", "_HANDLE")) for key in creds
    ):
        creds[f"{prefix}_USERNAME"] = login["username"]
    return creds


def read_channel_creds(channel: dict, *, refresh: bool = False) -> dict:
    site, platform = channel["site"], channel["platform"]
    persona = channel.get("persona") or ""
    cache_key = (site, f"{platform}:{persona}")
    hit = _creds_cache.get(cache_key)
    if hit and not refresh and time.time() - hit[0] < CREDS_TTL_SECONDS:
        return hit[1]

    if os.environ.get("SOCIAL_HUB_NO_VAULT"):
        # Escape hatch for tests and for dry-run environments with no vault:
        # channels resolve to empty creds, so adapters requiring creds skip
        # cleanly instead of the whole tick dying on a missing `bw` binary.
        return {}

    if refresh:
        _items_cache.pop(site, None)
    items = _vault_items(site)
    creds: dict = {}
    for key in creds_keys(platform, persona):
        item = items.get(key)
        if item:
            creds = _creds_from_item(item, platform)
            break

    _creds_cache[cache_key] = (time.time(), creds)
    return creds


def clear_creds_cache() -> None:
    _creds_cache.clear()
    _items_cache.clear()


def verify_channel(channel: dict) -> dict:
    """Live auth check against the platform; records the result on the channel."""
    from social_hub.platforms import get_adapter

    creds = read_channel_creds(channel, refresh=True)
    try:
        adapter = get_adapter(channel["platform"], creds)
    except KeyError as exc:
        return {"ok": False, "error": str(exc)}
    result = adapter.verify()
    payload: dict[str, Any] = {"has_creds": 1 if creds else 0}
    if result.get("ok") and result.get("handle") and not channel.get("handle"):
        payload["handle"] = result["handle"]
    if not result.get("ok"):
        payload["note"] = str(result.get("error", ""))[:400]
    db.update("channels", channel["id"], payload)
    return result
