"""Registry of v1 fact keys, their families (for applies_to gating), source, and TTL.

A fact's `family` controls whether a site's row in the matrix renders that cell:
the cell shows iff the family appears in the site's `applies_to` list.

Each fact's `state_from_value(value, site)` returns 'green' | 'yellow' | 'red'
| 'unknown' | 'n_a'. Collectors call this AFTER they have a value; manual edits
bypass it and accept the human's verdict (always 'green' on save).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class FactSpec:
    key: str
    family: str
    source: str
    ttl_hours: int
    describe: str
    state_from_value: Callable[[Any, dict], str]


def _bool_green_red(v: Any, _site: dict) -> str:
    if v is True:
        return "green"
    if v is False:
        return "red"
    return "unknown"


def _bool_green_yellow(v: Any, _site: dict) -> str:
    """For optional-but-recommended facts: missing = yellow, not red."""
    if v is True:
        return "green"
    if v is False:
        return "yellow"
    return "unknown"


def _tls_expiry(days: Any, _site: dict) -> str:
    if days is None:
        return "unknown"
    if days < 7:
        return "red"
    if days < 30:
        return "yellow"
    return "green"


def _commit_age(hours: Any, site: dict) -> str:
    if hours is None:
        return "unknown"
    # Active sites should ship at least weekly; parked sites are static.
    if not site.get("active", False):
        return "green"
    if hours < 24 * 7:
        return "green"
    if hours < 24 * 30:
        return "yellow"
    return "red"


def _ops_board_age(hours: Any, _site: dict) -> str:
    if hours is None:
        return "unknown"
    if hours < 25:
        return "green"
    if hours < 24 * 3:
        return "yellow"
    return "red"


def _push_age(hours: Any, _site: dict) -> str:
    if hours is None:
        return "unknown"
    if hours < 24 * 7:
        return "green"
    if hours < 24 * 30:
        return "yellow"
    return "red"


def _commits_ahead(n: Any, _site: dict) -> str:
    if n is None:
        return "unknown"
    if n == 0:
        return "green"
    if n < 5:
        return "yellow"
    return "red"


FACTS: dict[str, FactSpec] = {
    # Cloudflare
    "cf.zone_active":         FactSpec("cf.zone_active",         "cf",      "cf_api",      6,  "Zone active in Cloudflare",              _bool_green_red),
    "cf.worker_bound":        FactSpec("cf.worker_bound",        "cf",      "cf_api",      6,  "Worker bound to zone",                   _bool_green_yellow),
    "cf.email_routing":       FactSpec("cf.email_routing",       "cf",      "cf_api",      24, "Email routing configured",               _bool_green_yellow),

    # HTTP scrape
    "http.ga4_present":       FactSpec("http.ga4_present",       "http",    "http_scrape", 24, "GA4 tag in <head>",                      _bool_green_yellow),
    "http.adsense_present":   FactSpec("http.adsense_present",   "http",    "http_scrape", 24, "AdSense tag in <head>",                  _bool_green_yellow),
    "http.meta_pixel_present":FactSpec("http.meta_pixel_present","http",    "http_scrape", 24, "Meta Pixel in <head>",                   _bool_green_yellow),
    "http.gtm_present":       FactSpec("http.gtm_present",       "http",    "http_scrape", 24, "GTM tag in <head>",                      _bool_green_yellow),
    "http.sitemap_200":       FactSpec("http.sitemap_200",       "sitemap", "http_scrape", 24, "GET /sitemap.xml returns 200",           _bool_green_red),
    "http.robots_present":    FactSpec("http.robots_present",    "sitemap", "http_scrape", 24, "GET /robots.txt returns 200",            _bool_green_yellow),
    "http.tls_expiry_days":   FactSpec("http.tls_expiry_days",   "tls",     "http_scrape", 24, "Days until TLS cert expires",            _tls_expiry),

    # Filesystem
    "fs.last_commit_age_hours":FactSpec("fs.last_commit_age_hours","git",   "filesystem",  1,  "Hours since last commit on main",        _commit_age),
    "fs.ops_board_last_run_age_hours":FactSpec("fs.ops_board_last_run_age_hours","ops","filesystem",1,"Hours since latest ops/board/last-run.json",_ops_board_age),

    # GitHub
    "github.commits_ahead":   FactSpec("github.commits_ahead",   "github",  "github_api",  24, "Local commits not on origin",            _commits_ahead),
    "github.last_push_age_hours":FactSpec("github.last_push_age_hours","github","github_api",24,"Hours since last push to origin",        _push_age),
}


def keys_for_family(family: str) -> list[str]:
    return [k for k, spec in FACTS.items() if spec.family == family]


def families() -> list[str]:
    """Canonical column order for the matrix."""
    return ["cf", "http", "sitemap", "tls", "git", "ops", "github", "manual"]
