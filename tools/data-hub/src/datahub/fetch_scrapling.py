"""Permissioned, public HTML collection through Scrapling.

This adapter uses Scrapling's ordinary HTTP fetcher by default. An explicit
``fetch_mode: stealth`` opt-in may use Scrapling's browser fetcher for a public
page, but never supplies login credentials, cookies, or session state. A source
must be explicitly enabled and its robots.txt must allow the configured URL.
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from pathlib import PurePosixPath
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

from .config import Source


class ScraplingPolicyError(RuntimeError):
    """Raised when a source is not eligible for public HTML collection."""


def _text(node) -> str:
    value = node.get() if hasattr(node, "get") else node
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _selector_value(node, selector: str, *, attr: str | None = None) -> str:
    if not selector:
        return ""
    selected = node.css(selector)
    if not selected:
        return ""
    target = selected[0]
    if attr:
        return _text(target.attrib.get(attr, ""))
    return _text(target)


def _allowed_by_robots(url: str, user_agent: str, timeout: float) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ScraplingPolicyError("scrapling source URL must be http(s) with a hostname")
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    parser = RobotFileParser()
    parser.set_url(robots_url)
    try:
        # RobotFileParser has no timeout parameter; use Scrapling only for the
        # target page and fail closed if the policy document cannot be read.
        from scrapling.fetchers import Fetcher

        robots = Fetcher.get(robots_url, timeout=timeout, headers={"User-Agent": user_agent})
        parser.parse(robots.body.decode("utf-8", errors="replace").splitlines())
    except Exception as exc:
        raise ScraplingPolicyError(f"robots.txt unavailable: {exc}") from exc
    if not parser.can_fetch(user_agent, url):
        raise ScraplingPolicyError("robots.txt disallows this URL")
    return True


def fetch_html(source: Source, *, proxy: str | None = None) -> list[dict]:
    """Fetch configured public HTML cards and normalize them as news items.

    ``source.fetch`` supports ``item_selector`` plus field selectors:
    ``title_selector``, ``url_selector``, ``summary_selector``, and optional
    ``published_selector``. URL selectors may set ``url_attr`` (default
    ``href``). ``proxy`` is accepted to match the collector interface but is
    intentionally rejected: this adapter is direct-only until a source owner
    documents an approved egress path.
    """
    if proxy:
        raise ScraplingPolicyError("scrapling sources do not use collector proxies")
    if not source.url:
        raise ScraplingPolicyError("scrapling source has no URL")

    cfg = source.fetch
    user_agent = cfg.get("user_agent", "SaltwaterNewsBot/1.0 (+https://saltwaternews.com/sources/)")
    timeout = float(cfg.get("timeout_seconds", 20))
    if not cfg.get("robots_txt_obey", True):
        raise ScraplingPolicyError("robots_txt_obey must remain enabled for Scrapling sources")
    _allowed_by_robots(source.url, user_agent, timeout)

    fetch_mode = str(cfg.get("fetch_mode", "http")).lower()
    if fetch_mode not in {"http", "stealth"}:
        raise ScraplingPolicyError("fetch_mode must be http or stealth")
    try:
        if fetch_mode == "stealth":
            from scrapling.fetchers import StealthyFetcher as Fetcher
        else:
            from scrapling.fetchers import Fetcher
    except ImportError as exc:
        raise RuntimeError("scrapling fetchers are not installed") from exc

    if fetch_mode == "stealth":
        page = Fetcher.fetch(
            source.url,
            headless=True,
            network_idle=True,
            timeout=int(timeout * 1000),
            google_search=False,
        )
    else:
        page = Fetcher.get(source.url, timeout=timeout, headers={"User-Agent": user_agent})
    item_selector = cfg.get("item_selector", "article")
    title_selector = cfg.get("title_selector", "h1, h2, h3")
    url_selector = cfg.get("url_selector", "a[href]")
    summary_selector = cfg.get("summary_selector", "p")
    published_selector = cfg.get("published_selector", "time")
    url_attr = cfg.get("url_attr", "href")
    max_items = max(1, min(int(cfg.get("max_items", 20)), 100))

    items: list[dict] = []
    now = datetime.now(timezone.utc).isoformat()
    for node in page.css(item_selector)[:max_items]:
        title = _selector_value(node, title_selector)
        href = _selector_value(node, url_selector, attr=url_attr)
        if not title or not href:
            continue
        item_url = urljoin(source.url, href)
        if urlparse(item_url).hostname != urlparse(source.url).hostname:
            continue
        summary = _selector_value(node, summary_selector)[:500]
        published = _selector_value(node, published_selector, attr="datetime") or _selector_value(node, published_selector)
        external_id = hashlib.sha256(item_url.encode("utf-8")).hexdigest()[:24]
        items.append({
            "title": title[:300],
            "url": item_url,
            "summary": summary,
            "published_iso": published or now,
            "source_id": source.id,
            "source_name": cfg.get("source_name", source.id),
            "tags": list(source.tags),
            "external_id": external_id,
            "raw": {"collector": "scrapling", "source_path": PurePosixPath(urlparse(item_url).path).as_posix()},
        })
    return items
