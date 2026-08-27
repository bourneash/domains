"""Fill out a Bluesky account's profile (displayName / bio / avatar / banner)
via the AT Protocol API — no browser, no captcha, works against any account
that already has working login creds (brand or `domain::persona-slug`).

Why this exists: `bsky_signup.py` only gets an account to "exists and can log
in" — display name, bio, and avatar were left blank on most of the fleet's
accounts (2026-08-27 backfill). This is the reusable piece; call it right
after signup for new accounts too instead of leaving profiles bare.

Usage as a library:

    from social_lib.bluesky_profile import fill_profile
    fill_profile(
        domain="reviewtattoo.com",
        display_name="ReviewTattoo",
        bio="Tattoo style guides and artist discovery. reviewtattoo.com",
        website="https://reviewtattoo.com",
        avatar_path="/path/to/square-avatar.png",   # or avatar_bytes=...
    )

`persona` (vault sub-key suffix, e.g. "chris-donovan") is optional — omit for
the brand/site-level account.

Idempotent-ish: pass `overwrite=False` (default) to only fill fields that are
currently empty on the live profile; pass `overwrite=True` to replace
whatever's there. Either way this never touches posts/follows, only the
`app.bsky.actor.profile` record.
"""

from __future__ import annotations

from dataclasses import dataclass

from atproto import Client, models

from social_lib.credentials import read_creds

BLUESKY_BIO_MAX = 256
BLUESKY_NAME_MAX = 64


@dataclass
class FillResult:
    handle: str
    did: str
    changed: list[str]
    skipped: list[str]


def _vault_key(domain: str, persona: str | None) -> str:
    return f"{domain}::{persona}" if persona else domain


def _client_for(domain: str, persona: str | None) -> Client:
    creds = read_creds(_vault_key(domain, persona), "bluesky")
    if not creds or not creds.get("BLUESKY_HANDLE") or not creds.get("BLUESKY_PASSWORD"):
        raise RuntimeError(
            f"no usable bluesky creds for {_vault_key(domain, persona)} "
            f"(have keys: {sorted(creds.keys()) if creds else '[]'})"
        )
    client = Client()
    client.login(creds["BLUESKY_HANDLE"], creds["BLUESKY_PASSWORD"])
    return client


def _build_bio(bio: str, website: str | None) -> str:
    bio = (bio or "").strip()
    if website and website not in bio:
        # Bluesky auto-links bare URLs in bios; keep it on its own line so it
        # reads cleanly rather than getting run into the last sentence.
        candidate = f"{bio}\n\n{website}" if bio else website
        if len(candidate) <= BLUESKY_BIO_MAX:
            bio = candidate
    return bio[:BLUESKY_BIO_MAX]


def fill_profile(
    domain: str,
    display_name: str,
    bio: str,
    website: str | None = None,
    avatar_path: str | None = None,
    avatar_bytes: bytes | None = None,
    banner_path: str | None = None,
    banner_bytes: bytes | None = None,
    persona: str | None = None,
    overwrite: bool = False,
) -> FillResult:
    client = _client_for(domain, persona)
    # get_profile() (the app-view) only returns avatar/banner as display CDN
    # URL strings, not usable blob refs for a re-PUT — get_record() returns
    # the actual repo record, with real BlobRef objects (or None if unset).
    # RecordNotFound means the account has never had a profile record at
    # all, which is the "everything's blank" case.
    try:
        existing = client.com.atproto.repo.get_record(
            {"repo": client.me.did, "collection": "app.bsky.actor.profile", "rkey": "self"}
        ).value
    except Exception:
        existing = None

    changed: list[str] = []
    skipped: list[str] = []

    new_display_name = (getattr(existing, "display_name", None) or "").strip()
    if overwrite or not new_display_name:
        new_display_name = display_name.strip()[:BLUESKY_NAME_MAX]
        changed.append("displayName")
    else:
        skipped.append("displayName")

    new_description = (getattr(existing, "description", None) or "").strip()
    if overwrite or not new_description:
        new_description = _build_bio(bio, website)
        changed.append("description")
    else:
        skipped.append("description")

    existing_avatar = getattr(existing, "avatar", None)
    avatar_blob = existing_avatar  # stays untouched by default
    if avatar_path or avatar_bytes:
        if overwrite or not existing_avatar:
            data = avatar_bytes if avatar_bytes is not None else open(avatar_path, "rb").read()
            upload = client.upload_blob(data)
            avatar_blob = upload.blob
            changed.append("avatar")
        else:
            skipped.append("avatar")

    existing_banner = getattr(existing, "banner", None)
    banner_blob = existing_banner
    if banner_path or banner_bytes:
        if overwrite or not existing_banner:
            data = banner_bytes if banner_bytes is not None else open(banner_path, "rb").read()
            upload = client.upload_blob(data)
            banner_blob = upload.blob
            changed.append("banner")
        else:
            skipped.append("banner")

    if changed:
        record = models.AppBskyActorProfile.Record(
            display_name=new_display_name or None,
            description=new_description or None,
            avatar=avatar_blob,
            banner=banner_blob,
        )
        client.com.atproto.repo.put_record(
            models.ComAtprotoRepoPutRecord.Data(
                repo=client.me.did,
                collection="app.bsky.actor.profile",
                rkey="self",
                record=record,
            )
        )

    return FillResult(handle=client.me.handle, did=client.me.did, changed=changed, skipped=skipped)
