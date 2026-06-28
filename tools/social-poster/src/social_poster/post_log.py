# tools/social-poster/src/social_poster/post_log.py
from __future__ import annotations
import json
from datetime import datetime, timezone
from pathlib import Path
from social_lib.credentials import site_root


def _log_path(domain: str) -> Path:
    return site_root(domain) / "ops" / "social" / "post-log.jsonl"


def already_posted(domain: str, slug: str, platform: str) -> bool:
    path = _log_path(domain)
    if not path.exists():
        return False
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)
        if entry.get("article_slug") == slug and entry.get("platform") == platform:
            return True
    return False


def record_post(domain: str, slug: str, platform: str, post_url: str) -> None:
    path = _log_path(domain)
    path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "article_slug": slug,
        "platform": platform,
        "post_url": post_url,
        "posted_at": datetime.now(timezone.utc).isoformat(),
    }
    with path.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def recent_posts(domain: str, limit: int = 50) -> list[dict]:
    path = _log_path(domain)
    if not path.exists():
        return []
    lines = [l for l in path.read_text().splitlines() if l.strip()]
    return [json.loads(l) for l in lines[-limit:]]
