"""Auto-file backlog tasks for ASINs confirmed dead across consecutive collect runs.

Detection-only, no auto-replace: this module never edits affiliate.ts or picks a
replacement product. It just turns a persistent PA-API "missing" signal into a
task file a human or the site's news-writer role can act on — same posture as
the existing curl-based affiliate-editor cron role, just driven by PA-API data
instead of scraping /go/ links.

A single "missing" result is not proof of delisting (PA-API's getItems silently
omits items for several transient reasons — see reference_affiliate_product_sourcing
memory). Requiring CONSECUTIVE_THRESHOLD consecutive daily misses before filing
matches the existing human-authored precedent (americastrikes.com's
water-filter-lifestraw task cited "2 consecutive affiliate audit runs").
"""
from __future__ import annotations

import json
import logging
import re
import subprocess
from pathlib import Path
from typing import Callable

import httpx

log = logging.getLogger(__name__)

CONSECUTIVE_THRESHOLD = 2

_HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}
_DEAD_MARKER_RE = re.compile(
    r"Looking for something\?|couldn.?t find that page|Page Not Found", re.I
)


def http_confirms_dead(asin: str, timeout: float = 15.0) -> bool | None:
    """Direct-fetch /dp/<asin> as a second signal, independent of PA-API.

    PA-API's getItems has been observed to *persistently* omit certain live
    ASINs (see reference_affiliate_product_sourcing memory — likely a
    category/resource restriction, not delisting) — its "missing" signal
    alone is not trustworthy enough to auto-file a task. This mirrors the
    manual verification step: HTTP 404 + soft-404 marker = dead; a real
    product page = alive; anything else (bot wall, network error) = unknown,
    so callers should NOT file a task on `None`.

    Returns True (confirmed dead), False (confirmed alive), or None
    (inconclusive).
    """
    try:
        with httpx.Client(headers=_HTTP_HEADERS, timeout=timeout, follow_redirects=True) as c:
            r = c.get(f"https://www.amazon.com/dp/{asin}")
    except httpx.HTTPError as exc:
        log.warning("taskfiler: http_confirms_dead(%s) network error: %s", asin, exc)
        return None

    text = r.text
    if r.status_code == 404 and _DEAD_MARKER_RE.search(text):
        return True
    if "productTitle" in text:
        return False
    return None  # captcha wall or unrecognized page shape — don't guess

# Captures (id, asin) pairs from affiliate.ts-style objects: `id: '...'`
# followed (within the same object, i.e. before the next `},` line or `{`)
# by `asin: '...'`. Order in source matches the fleet convention: id first.
_ID_ASIN_RE = re.compile(
    r"id:\s*'([^']+)'(?:(?!\{|\n\s*\},).)*?asin:\s*'([A-Z0-9]{9,10})'",
    re.S,
)


def load_state(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        log.warning("taskfiler: could not read state file %s, starting fresh", path)
        return {}


def save_state(path: Path, state: dict) -> None:
    path.write_text(json.dumps(state, indent=2, sort_keys=True))


def build_id_asin_map(domains_root: Path) -> dict[str, dict[str, str]]:
    """Return {site: {asin: product_id}} parsed from each site's affiliate.ts."""
    result: dict[str, dict[str, str]] = {}
    for ts_file in sorted(domains_root.glob("sites/*/site/src/lib/affiliate.ts")):
        site_name = ts_file.parts[-5]
        try:
            text = ts_file.read_text(encoding="utf-8")
        except OSError:
            continue
        pairs = _ID_ASIN_RE.findall(text)
        if pairs:
            result[site_name] = {asin: pid for pid, asin in pairs}
    return result


def _existing_task_mentions(site_root: Path, asin: str) -> bool:
    """True if any backlog/in-progress/done task already references this ASIN."""
    tasks_dir = site_root / "ops" / "tasks"
    if not tasks_dir.exists():
        return False
    for sub in ("backlog", "in-progress", "done"):
        d = tasks_dir / sub
        if not d.exists():
            continue
        for f in d.glob("*.md"):
            try:
                if asin in f.read_text(encoding="utf-8"):
                    return True
            except OSError:
                continue
    return False


def _run_git(args: list[str], cwd: Path) -> bool:
    try:
        subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True, timeout=60)
        return True
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
        detail = exc.stderr if isinstance(exc, subprocess.CalledProcessError) else str(exc)
        log.error("taskfiler: git %s failed in %s: %s", " ".join(args), cwd, detail)
        return False


def _write_task(site_root: Path, site: str, product_id: str, asin: str, consecutive: int, today: str) -> Path:
    tasks_dir = site_root / "ops" / "tasks" / "backlog"
    tasks_dir.mkdir(parents=True, exist_ok=True)
    fname = f"{today}-broken-affiliate-{product_id}.md"
    path = tasks_dir / fname
    path.write_text(
        f"""---
type: content
assigned_role: human
created: {today}
source: amz-stats (PA-API automated detection)
---

# Dead affiliate link: {product_id} ({asin})

## What happened

Amazon's Product Advertising API (`getItems`, via the Creators API) has not
returned data for ASIN `{asin}` on {consecutive} consecutive daily
`amz-stats` collection runs. This is the same signal a soft-404 would give —
the product has very likely been de-listed from Amazon.

## Details

- **Site:** {site}
- **Product ID:** `{product_id}` (in `site/src/lib/affiliate.ts`)
- **ASIN:** `{asin}`
- **Amazon URL:** https://www.amazon.com/dp/{asin}

## Recommended action

1. Confirm at `https://www.amazon.com/dp/{asin}` (a PA-API miss is a strong
   signal but not 100% — verify before touching the catalog).
2. Find a live, in-stock replacement — `amz-stats`'s Creators API client
   supports `searchItems`, or search Amazon directly.
3. Update the `{product_id}` entry's `asin` (and `name`/`blurb` if the
   product itself changed) in `site/src/lib/affiliate.ts`.
4. Re-verify the new ASIN with `getItems` before deploying.
5. Build, deploy.

## Checked by

amz-stats automated PA-API sweep — {today}
""",
        encoding="utf-8",
    )
    return path


def process(
    domains_root: Path,
    asins_by_site: dict[str, list[str]],
    catalog: dict,
    today: str,
    state_path: Path,
    push: bool = True,
    http_confirm: Callable[[str], bool | None] = http_confirms_dead,
) -> list[str]:
    """Update consecutive-miss state and file/commit/push tasks for newly-confirmed dead ASINs.

    Returns a list of "site:product_id (asin)" strings for tasks filed this run.
    """
    catalog_items: set[str] = set((catalog.get("asins") or {}).keys())
    error_set: set[str] = set(catalog.get("errors") or [])

    state = load_state(state_path)
    id_map = build_id_asin_map(domains_root)
    filed: list[str] = []

    for site, site_asins in asins_by_site.items():
        for asin in site_asins:
            key = f"{site}:{asin}"
            entry = state.get(key, {"consecutive_missing": 0, "task_filed": False})

            # "missing" = a successful batch returned data but omitted this ASIN.
            # Batch-level errors (rate limits, transient failures) are NOT counted —
            # they say nothing about whether the product is actually delisted.
            is_missing = asin not in catalog_items and asin not in error_set
            is_error = asin in error_set

            if is_missing:
                entry["consecutive_missing"] = entry.get("consecutive_missing", 0) + 1
            elif not is_error:
                # Confirmed present (with data) — fully reset.
                entry["consecutive_missing"] = 0
                entry["task_filed"] = False
            # else: batch error this run — leave streak untouched either way.

            if (
                entry["consecutive_missing"] >= CONSECUTIVE_THRESHOLD
                and not entry.get("task_filed")
            ):
                product_id = id_map.get(site, {}).get(asin)
                site_root = domains_root / "sites" / site
                if not product_id:
                    log.warning(
                        "taskfiler: %s missing %d runs but no id mapping found in affiliate.ts — skipping",
                        key, entry["consecutive_missing"],
                    )
                    entry["task_filed"] = True  # don't retry every run on an unmappable ASIN
                elif _existing_task_mentions(site_root, asin):
                    # A human or an earlier run already filed something for this ASIN.
                    entry["task_filed"] = True
                else:
                    verdict = http_confirm(asin)
                    if verdict is False:
                        # PA-API's "missing" was wrong for this ASIN — reset and move on.
                        # (Observed: getItems persistently omits certain live ASINs,
                        # likely a category/resource restriction, not delisting.)
                        entry["consecutive_missing"] = 0
                        entry["task_filed"] = False
                        state[key] = entry
                        continue
                    if verdict is None:
                        # Inconclusive (bot wall / network error) — try again next run,
                        # don't file blind and don't reset the streak.
                        state[key] = entry
                        continue
                    try:
                        path = _write_task(
                            site_root, site, product_id, asin, entry["consecutive_missing"], today
                        )
                        rel = path.relative_to(site_root)
                        ok = _run_git(["add", str(rel)], site_root)
                        if ok:
                            ok = _run_git(
                                ["commit", "-m",
                                 f"chore(affiliate): file dead-ASIN task ({product_id})\n\n"
                                 f"Automated: amz-stats confirmed ASIN {asin} missing from PA-API "
                                 f"getItems on {entry['consecutive_missing']} consecutive daily runs.\n\n"
                                 f"Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"],
                                site_root,
                            )
                        if ok and push:
                            ok = _run_git(["push"], site_root)
                        if ok:
                            filed.append(f"{site}:{product_id} ({asin})")
                        entry["task_filed"] = True
                    except OSError as exc:
                        log.error("taskfiler: failed to write task for %s: %s", key, exc)

            state[key] = entry

    save_state(state_path, state)
    return filed
