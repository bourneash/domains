"""Deterministic pre-review checks that must never spend model tokens."""

from __future__ import annotations

import re
from urllib.parse import urlparse

from social_hub import db
from social_hub.config import SiteConfig
from social_hub.platforms import capabilities

PLACEHOLDER_RE = re.compile(r"\{[a-zA-Z_][^{}]{0,80}\}")
WS_RE = re.compile(r"\s+")
TOKEN_RE = re.compile(r"[a-z0-9']+")

FEEDBACK_CATEGORIES = {
    "fallback_generation",
    "template_leak",
    "truncated_copy",
    "bare_title",
    "wrong_voice",
    "weak_hook",
    "unsupported_claim",
    "too_promotional",
    "platform_mismatch",
    "duplicate_copy",
    "unsafe_or_private",
    "bad_link",
    "other",
}


def _norm(value: str | None) -> str:
    return WS_RE.sub(" ", (value or "").strip()).casefold()


def findings(post: dict, source: dict | None = None, cfg: SiteConfig | None = None) -> list[dict]:
    """Return only high-confidence defects suitable for automatic quarantine."""
    source = source or {}
    body = (post.get("body") or "").strip()
    link = (post.get("link") or source.get("url") or "").strip()
    out: list[dict] = []

    # `fake` is the deterministic test/dry-run adapter. Its intentionally plain
    # fixture copy exists to exercise lifecycle code, not editorial quality.
    dry_run = post.get("ai_model") == "fake"

    if post.get("ai_model") == "fallback" and not (cfg and cfg.get("quality.allow_fallback", False)):
        out.append({"category": "fallback_generation", "reason": "AI drafting failed; rewrite this deterministic fallback before review."})
    if PLACEHOLDER_RE.search(body) or PLACEHOLDER_RE.search(link):
        out.append({"category": "template_leak", "reason": "Resolve the template placeholder before review."})
    if not body or len(body) < 20:
        out.append({"category": "weak_hook", "reason": "Post is empty or too short to deliver a useful idea."})

    title = _norm(source.get("title"))
    summary = _norm(source.get("summary"))
    normalized = _norm(body)
    if title and normalized == title and not dry_run:
        out.append({"category": "bare_title", "reason": "Turn the source title into an on-brand standalone post."})
    if summary and not dry_run and normalized in {summary, _norm(f"{source.get('title', '')} — {source.get('summary', '')}")}:
        out.append({"category": "weak_hook", "reason": "Rewrite the raw source summary as social copy with an on-brand hook."})

    max_chars = capabilities(post.get("platform") or "console").max_chars
    if len(body) > max_chars:
        out.append({"category": "platform_mismatch", "reason": f"Copy exceeds the {max_chars}-character platform limit."})
    if post.get("ai_model") == "fallback" and len(body) >= int(max_chars * 0.82) and body[-1:].isalnum():
        out.append({"category": "truncated_copy", "reason": "Copy appears to end mid-sentence or mid-word; rewrite it cleanly."})

    if link:
        parsed = urlparse(link)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            out.append({"category": "bad_link", "reason": "Destination link is not a complete HTTP(S) URL."})

    duplicate = db.one(
        "SELECT id FROM posts WHERE site = ? AND platform = ? AND id != ? "
        "AND lower(trim(body)) = lower(trim(?)) AND status IN ('draft','approved','scheduled','posted') LIMIT 1",
        (post.get("site"), post.get("platform"), int(post.get("id") or 0), body),
    )
    if body and duplicate:
        out.append({"category": "duplicate_copy", "reason": f"Exact copy already exists as post {duplicate['id']}."})
    elif body and not dry_run:
        tokens = set(TOKEN_RE.findall(normalized))
        if len(tokens) >= 8:
            candidates = db.query(
                "SELECT id, body FROM posts WHERE site = ? AND platform = ? AND id != ? "
                "AND status IN ('draft','approved','scheduled','posted') ORDER BY id DESC LIMIT 100",
                (post.get("site"), post.get("platform"), int(post.get("id") or 0)),
            )
            for candidate in candidates:
                other = set(TOKEN_RE.findall(_norm(candidate["body"])))
                similarity = len(tokens & other) / max(1, len(tokens | other))
                if similarity >= 0.88:
                    out.append({"category": "duplicate_copy", "reason": f"Copy is too similar to recent post {candidate['id']}."})
                    break

    # Keep one finding per category so downstream feedback remains useful.
    return list({item["category"]: item for item in out}.values())


def inspect_post(post_id: int, cfg: SiteConfig | None = None) -> list[dict]:
    post = db.row_to_dict(db.one("SELECT * FROM posts WHERE id = ?", (post_id,)))
    if not post:
        return [{"category": "other", "reason": "Post does not exist."}]
    source = None
    if post.get("source_id"):
        source = db.row_to_dict(
            db.one(
                "SELECT * FROM sources WHERE site = ? AND source_type = ? AND source_id = ?",
                (post["site"], post.get("source_type") or "article", post["source_id"]),
            )
        )
    return findings(post, source, cfg)
