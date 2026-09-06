"""Slack notifications — optional, best-effort, never fatal.

Uses the fleet's existing shared bot (`SLACK_BOT_TOKEN` in `domains/.env`) and
each site's own channel (`SLACK_CHANNEL_<SITE>`), the same convention as
[[reference_slack_integration]]. Nothing here is allowed to fail a tick: a
Slack outage must not stop posts from going out.

The hub speaks up for failures, items awaiting review, and successful public
posts. Review alerts are rate-limited to one digest per site per day; publish
alerts are sent once, after the post has been recorded as posted.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from urllib.parse import urlencode, urlparse

from social_hub.config import domains_root

_env_loaded = False
_fleet_env: dict[str, str] = {}
DEFAULT_DASHBOARD_URL = "http://127.0.0.1:4754/"


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
        key = key.strip()
        # This compatibility read predates env-broker. Retain only the Slack
        # routing values and dashboard URL needed here; never import the
        # fleet's unrelated provider credentials into this process.
        if key.startswith("SLACK_") or key == "SOCIAL_HUB_UI_URL":
            _fleet_env[key] = value.strip().strip('"').strip("'")


def _env(key: str, default: str = "") -> str:
    _load_fleet_env()
    return os.environ.get(key) or _fleet_env.get(key) or default


def channel_for(site: str) -> str:
    _load_fleet_env()
    slug = re.sub(r"[^A-Z0-9]+", "_", site.upper().replace(".COM", "").replace(".ORG", ""))
    for key in (f"SLACK_CHANNEL_{slug}", f"SLACK_CHANNEL_{slug}_COM"):
        value = _env(key)
        if value:
            return value
    # Fall back to a fuzzy match: channel vars are not named uniformly
    # (SLACK_CHANNEL_AMERICA_STRIKES vs SLACK_CHANNEL_ALIENCOUNCIL).
    compact = slug.replace("_", "")
    values = {**_fleet_env, **os.environ}
    for key, value in values.items():
        if key.startswith("SLACK_CHANNEL_") and key[14:].replace("_", "") == compact:
            return value
    return ""


def post_message(site: str, text: str, blocks: list | None = None) -> bool:
    _load_fleet_env()
    token = _env("SLACK_BOT_TOKEN")
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


def _dashboard_url(params: dict[str, str]) -> str:
    """Build a Fleet Dashboard Social Hub deep link.

    Reading the base URL at call time lets an installation override localhost
    in domains/.env with SOCIAL_HUB_UI_URL without restarting an importing
    process first.
    """
    _load_fleet_env()
    base = _env("SOCIAL_HUB_UI_URL", DEFAULT_DASHBOARD_URL).split("#", 1)[0]
    return f"{base.rstrip('/')}/#socialhub?{urlencode(params)}"


def review_url(site: str, *, kind: str = "") -> str:
    params = {
        "tab": "queue",
        "status": "draft",
        "site": site,
        # Console is an internal preview sink. Keep the Slack count and the
        # resulting dashboard view aligned with the UI's public-only default.
        "platform": "__public__",
    }
    if kind:
        params["kind"] = kind
    return _dashboard_url(params)


def _http_url(value: object) -> str:
    url = str(value or "").strip()
    if not url or any(char in url for char in "<>|"):
        return ""
    parsed = urlparse(url)
    return url if parsed.scheme in ("http", "https") and parsed.netloc else ""


def _slack_escape(value: object) -> str:
    return str(value or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _slack_link(url: str, label: str) -> str:
    safe = _http_url(url)
    return f"<{safe}|{_slack_escape(label)}>" if safe else ""


def notify_needs_review(site: str, drafts: int, replies: int) -> None:
    bits = []
    if drafts:
        bits.append(f"{drafts} draft post{'s' if drafts != 1 else ''}")
    if replies:
        bits.append(f"{replies} repl{'ies' if replies != 1 else 'y'}")
    if not bits:
        return
    kind = "post" if drafts and not replies else "reply" if replies and not drafts else ""
    url = review_url(site, kind=kind)
    summary = f"{' and '.join(bits)} awaiting review"
    text = f"social-hub: {summary} for {site} — {url}"
    blocks = [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": (
                    f":inbox_tray: *social-hub*: {_slack_escape(summary)} for "
                    f"*{_slack_escape(site)}*\n{_slack_link(url, 'Review filtered queue')}"
                ),
            },
        }
    ]
    post_message(site, text, blocks)


def notify_published(post: dict) -> bool:
    """Notify the site's Slack channel after a public feed post succeeds.

    Replies can be frequent and Console is only a local preview target, so
    neither creates a publish alert. The remote platform URL is primary, with
    the linked site page and filtered dashboard history included when useful.
    """
    platform = str(post.get("platform") or "")
    if platform == "console" or (post.get("kind") or "post") != "post":
        return False

    site = str(post.get("site") or "")
    label = platform.replace("_", " ").title() or "Social"
    remote_url = _http_url(post.get("remote_url"))
    source_url = _http_url(post.get("link"))
    dashboard_url = _dashboard_url(
        {
            "tab": "queue",
            "status": "posted",
            "site": site,
            "platform": platform,
            "kind": "post",
        }
    )
    primary_url = remote_url or source_url or dashboard_url
    text = f"social-hub: {label} post published for {site} — {primary_url}"

    links = []
    if remote_url:
        links.append(_slack_link(remote_url, f"View on {label}"))
    if source_url and source_url != remote_url:
        links.append(_slack_link(source_url, "Open linked page"))
    links.append(_slack_link(dashboard_url, "View published queue"))

    preview = re.sub(r"\s+", " ", str(post.get("body") or "")).strip()
    if len(preview) > 280:
        preview = preview[:279].rstrip() + "…"
    block_text = (
        f":white_check_mark: *{_slack_escape(label)} post published* for "
        f"*{_slack_escape(site)}*"
    )
    if preview:
        block_text += f"\n>{_slack_escape(preview)}"
    block_text += f"\n{' · '.join(link for link in links if link)}"
    return post_message(
        site,
        text,
        [{"type": "section", "text": {"type": "mrkdwn", "text": block_text}}],
    )
