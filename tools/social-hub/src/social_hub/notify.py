"""Slack notifications — optional, best-effort, never fatal.

Uses the fleet's existing shared bot (`SLACK_BOT_TOKEN` in `domains/.env`) and
each site's own channel (`SLACK_CHANNEL_<SITE>`), the same convention as
[[reference_slack_integration]]. Nothing here is allowed to fail a tick: a
Slack outage must not stop posts from going out.

Healthy runs are silent. The hub speaks up for three things only: a post
failed, replies are waiting for a human, and (once per day) a digest of what
is queued. Anything more and the channel gets muted, which is worse than no
alerting at all.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from social_hub.config import domains_root

_env_loaded = False


def _load_fleet_env() -> None:
    global _env_loaded
    if _env_loaded:
        return
    _env_loaded = True
    env_file = domains_root() / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def channel_for(site: str) -> str:
    _load_fleet_env()
    slug = re.sub(r"[^A-Z0-9]+", "_", site.upper().replace(".COM", "").replace(".ORG", ""))
    for key in (f"SLACK_CHANNEL_{slug}", f"SLACK_CHANNEL_{slug}_COM"):
        if os.environ.get(key):
            return os.environ[key]
    # Fall back to a fuzzy match: channel vars are not named uniformly
    # (SLACK_CHANNEL_AMERICA_STRIKES vs SLACK_CHANNEL_ALIENCOUNCIL).
    compact = slug.replace("_", "")
    for key, value in os.environ.items():
        if key.startswith("SLACK_CHANNEL_") and key[14:].replace("_", "") == compact:
            return value
    return ""


def post_message(site: str, text: str, blocks: list | None = None) -> bool:
    _load_fleet_env()
    token = os.environ.get("SLACK_BOT_TOKEN")
    channel = channel_for(site)
    if not token or not channel or os.environ.get("SOCIAL_HUB_NO_SLACK"):
        return False
    try:
        import httpx

        resp = httpx.post(
            "https://slack.com/api/chat.postMessage",
            headers={"Authorization": f"Bearer {token}"},
            json={"channel": channel, "text": text, **({"blocks": blocks} if blocks else {})},
            timeout=15,
        )
        return bool(resp.json().get("ok"))
    except Exception:
        return False


def notify_failure(site: str, platform: str, post_id: int, error: str) -> None:
    post_message(
        site,
        f":rotating_light: social-hub: {platform} post #{post_id} failed for {site}\n"
        f"```{error[:400]}```",
    )


def notify_needs_review(site: str, drafts: int, replies: int, url: str) -> None:
    bits = []
    if drafts:
        bits.append(f"{drafts} draft post{'s' if drafts != 1 else ''}")
    if replies:
        bits.append(f"{replies} repl{'ies' if replies != 1 else 'y'}")
    if not bits:
        return
    post_message(site, f":inbox_tray: social-hub: {' and '.join(bits)} awaiting review — {url}")
