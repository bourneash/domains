"""Associates Central earnings scraper — Playwright session-based."""
from __future__ import annotations

import csv
import io
import re
import time
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

ASSOC_CENTRAL = "https://affiliate-program.amazon.com"
REPORTS_URL = f"{ASSOC_CENTRAL}/home/reports"
LOGIN_PATTERNS = ("/ap/signin", "/ap/login")


class SessionExpiredError(Exception):
    """Raised when session file is missing or Associates Central redirects to login."""


class BlockedError(Exception):
    """Raised when Associates Central serves a WAF/bot-detection block page."""


class ScrapeStructureError(Exception):
    """Raised when an expected report-page element isn't found — the page layout
    changed, or the report genuinely couldn't be produced. Never silently
    swallowed into an empty result: an empty result must mean 'zero rows',
    never 'the scraper broke'."""


_BLOCK_MARKERS = ("Access Denied", "Request blocked", "automated access")


def _check_blocked(page) -> None:
    body_text = page.inner_text("body")
    for marker in _BLOCK_MARKERS:
        if marker in body_text:
            raise BlockedError(
                f"Associates Central returned a block page ({marker!r} found at {page.url}) — "
                "likely bot/automation fingerprinting, not a session or account issue."
            )


def _to_snake(name: str) -> str:
    """Convert a column header string to snake_case."""
    # Replace spaces, slashes, and other separators with underscores
    s = re.sub(r"[\s/\-\.]+", "_", name.strip())
    # Remove any non-alphanumeric/underscore chars
    s = re.sub(r"[^\w]", "", s)
    # Collapse multiple underscores
    s = re.sub(r"_+", "_", s).strip("_").lower()
    return s


def _coerce_value(raw: str) -> int | float | str:
    """Convert a string value to int, float, or leave as str."""
    v = raw.strip().lstrip("$").replace(",", "")
    if not v:
        return 0
    try:
        as_int = int(v)
        return as_int
    except ValueError:
        pass
    try:
        as_float = float(v)
        return as_float
    except ValueError:
        pass
    return raw.strip()


def _parse_date(raw: str) -> str:
    """Return ISO date YYYY-MM-DD; pass through if already ISO, else try common formats."""
    raw = raw.strip()
    # Already ISO
    if re.match(r"^\d{4}-\d{2}-\d{2}$", raw):
        return raw
    for fmt in ("%m/%d/%Y", "%B %d, %Y", "%b %d, %Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    # Return as-is if unparseable
    return raw


def _extract_csv_text(path: Path) -> str:
    """Return CSV text from a downloaded report file — Associates Central's
    CSV export downloads as a .zip containing exactly one .csv member
    (observed live: `Tracking-Id-<date>-<time>.zip` -> one `*-CSV.csv`
    inside), not a raw CSV. Reads the raw file directly if it isn't a zip,
    so this keeps working if Amazon ever serves CSV unwrapped.
    """
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as zf:
            names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
            if not names:
                raise ScrapeStructureError(
                    f"Downloaded zip {path} has no .csv member (found: {zf.namelist()})"
                )
            return zf.read(names[0]).decode("utf-8-sig")
    return path.read_text(encoding="utf-8-sig")


def parse_earnings_csv(csv_text: str) -> list[dict]:
    """Parse Associates Central earnings CSV export.

    Normalises column names to snake_case, converts date columns to ISO format
    (YYYY-MM-DD), and coerces numeric strings to int/float.
    Returns a list of dicts, one per row.
    """
    reader = csv.DictReader(io.StringIO(csv_text))
    if reader.fieldnames is None:
        return []

    # Build mapping original_name -> snake_case key
    key_map = {orig: _to_snake(orig) for orig in reader.fieldnames}

    rows: list[dict] = []
    for raw_row in reader:
        row: dict = {}
        for orig_key, value in raw_row.items():
            snake_key = key_map.get(orig_key, _to_snake(orig_key))
            # Detect date columns
            if "date" in snake_key:
                row[snake_key] = _parse_date(value)
            else:
                row[snake_key] = _coerce_value(value)
        rows.append(row)
    return rows


REPORT_GENERATE_TIMEOUT_S = 240  # Amazon: "usually within a few minutes"


def _scrape_reports_page(page, days: int, debug_dir: Path) -> list[dict]:
    """Drive an already-authenticated Associates Central page through the
    "Download Reports" popover and return parsed CSV rows. Shared by
    scrape_earnings() (replay of a saved session) and pull_earnings() (fresh
    interactive login).

    This is Amazon's async report-generation flow, not a simple export
    button: open the popover, pick report type + CSV format, click "Generate
    Reports", then poll the "Available Reports" table until a row's status
    reads ready, then download it. Selectors below are exact element IDs
    read from a live authenticated session's DOM (out/debug/*.html), not
    guessed text matches.

    The date range defaults to Amazon's own rolling "Last 30 Days" filter,
    which is what we want for the default days=30. A different `days` isn't
    wired to the date-range picker yet — flagged, not silently ignored.
    """
    if days != 30:
        raise ScrapeStructureError(
            f"days={days} requested, but only the default 30-day window (Amazon's "
            "built-in 'Last 30 Days' filter) is wired up — the custom date-range "
            "popover isn't implemented yet."
        )

    page.goto(REPORTS_URL, wait_until="domcontentloaded", timeout=30_000)

    current_url = page.url
    if any(pat in current_url for pat in LOGIN_PATTERNS):
        raise SessionExpiredError(
            f"Session expired — redirected to login: {current_url}"
        )

    _check_blocked(page)

    # Open the "Download Reports" popover
    try:
        page.click("#ac-report-download-launcher-osp", timeout=10_000)
    except PWTimeout:
        _fail_with_debug(page, debug_dir, "download-launcher",
                          "Could not find/click the 'Download Reports' launcher link.")

    # Pick "Tracking ID" report — per-site (per-affiliate-tag) commission
    # breakdown, matching how the fleet's ASINs are tagged across sites.
    try:
        page.wait_for_selector("#report-download-program-commission-trackingid", timeout=10_000)
        checkbox = page.locator("#report-download-program-commission-trackingid input[type=checkbox]")
        if not checkbox.is_checked():
            page.click("#report-download-program-commission-trackingid label", timeout=10_000)
    except PWTimeout:
        _fail_with_debug(page, debug_dir, "report-type-checkbox",
                          "Could not find/select the 'Tracking ID' report checkbox in the download popover.")

    # Select CSV export format (defaults to XLSX)
    try:
        page.click("#report-download-export-format-csv label", timeout=10_000)
    except PWTimeout:
        _fail_with_debug(page, debug_dir, "export-format",
                          "Could not select the CSV export format radio.")

    # Kick off report generation
    try:
        page.click("#ac-reports-download-generate-osp-announce", timeout=10_000)
    except PWTimeout:
        _fail_with_debug(page, debug_dir, "generate-reports",
                          "Could not click 'Generate Reports'.")

    # Poll the "Available Reports" table until a row's status shows ready.
    # Amazon's own localization key names this state's display text
    # "Download" (reports-download-status-ready), distinct from "Preparing...".
    ready_row = None
    deadline = time.monotonic() + REPORT_GENERATE_TIMEOUT_S
    while time.monotonic() < deadline:
        rows = page.locator(".ac-report-download-tbl-content-osp table tbody tr")
        for i in range(rows.count()):
            row = rows.nth(i)
            row_text = row.inner_text()
            if "Download" in row_text and "Preparing" not in row_text and "Loading" not in row_text:
                ready_row = row
                break
        if ready_row is not None:
            break
        page.wait_for_timeout(5_000)

    if ready_row is None:
        _fail_with_debug(page, debug_dir, "report-not-ready",
                          f"Report generation didn't finish within {REPORT_GENERATE_TIMEOUT_S}s.")

    # The Download link opens a target=_blank popup that Chrome immediately
    # closes once it resolves the file as an attachment (observed live) — the
    # "download" event fires on that transient popup page, not on `page`, so
    # page.expect_download() (page-scoped) misses it. Listen at the
    # browser-context level instead, which catches downloads from any page
    # opened within it.
    csv_text: str = ""
    try:
        with page.context.expect_event("download", timeout=30_000) as dl_info:
            ready_row.get_by_text("Download", exact=True).click()
        download = dl_info.value
        path = download.path()
        if path:
            csv_text = _extract_csv_text(Path(path))
    except PWTimeout:
        _fail_with_debug(page, debug_dir, "csv-download",
                          "Report showed ready but clicking its Download link triggered no file download.")

    return parse_earnings_csv(csv_text)


def scrape_earnings(session_file: Path, days: int = 30) -> list[dict]:
    """Download daily earnings CSV from Associates Central using a saved session.

    NOTE: Associates Central's reports page enforces OpenID `pape.max_auth_age`
    (observed at 3600s) — it demands a login within roughly the last hour,
    independent of whether the session cookie is otherwise valid. A
    storage_state saved more than ~1h ago will reliably redirect to signin
    here even though the cookie itself hasn't "expired" in the usual sense.
    That makes this function unsuitable as the primary path for a daily/
    weekly cron — use pull_earnings() (fresh interactive login immediately
    followed by scrape, same browser session) for reliable unattended-adjacent
    pulls. This function is kept for the case where a cron tick happens to
    land inside a still-fresh auth window.

    Raises SessionExpiredError if session file missing or page redirects to login.
    Returns list of daily dicts from parse_earnings_csv().
    """
    if not session_file.exists():
        raise SessionExpiredError(f"Session file not found: {session_file}")

    debug_dir = session_file.parent / "debug"

    with sync_playwright() as pw:
        # headless=False, same as save_session(). Associates Central's bot
        # defense fingerprints headless Chromium distinctly from a headed one
        # (navigator.webdriver, missing plugins/mimeTypes, CDP artifacts) and
        # serves an "Access Denied" block page even with valid session cookies
        # — this bit us in production. Run this job under `xvfb-run` in the
        # container (see crontab.docker) so headless=False works without a
        # real display.
        browser = pw.chromium.launch(headless=False, args=["--disable-blink-features=AutomationControlled"])
        try:
            ctx = browser.new_context(storage_state=str(session_file))
            ctx.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
            )
            page = ctx.new_page()
            rows = _scrape_reports_page(page, days, debug_dir)
        finally:
            browser.close()

    return rows


def pull_earnings(session_file: Path, days: int = 30) -> list[dict]:
    """Interactive login immediately followed by a same-session scrape.

    This is the reliable path: login and scrape happen in the same browser
    context back-to-back, so Associates Central's ~1h auth-freshness
    requirement (see scrape_earnings() docstring) is always satisfied. As a
    bonus, storage_state is saved afterward so an opportunistic
    scrape_earnings() cron run within the next hour can reuse it.
    """
    session_file.parent.mkdir(parents=True, exist_ok=True)
    debug_dir = session_file.parent / "debug"

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=False, args=["--disable-blink-features=AutomationControlled"])
        try:
            ctx = browser.new_context()
            ctx.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
            )
            page = ctx.new_page()
            page.goto(f"{ASSOC_CENTRAL}/ap/signin", wait_until="domcontentloaded", timeout=30_000)

            print("\nComplete login in the browser window. Press Enter when done...")
            input()

            rows = _scrape_reports_page(page, days, debug_dir)

            ctx.storage_state(path=str(session_file))
        finally:
            browser.close()

    return rows


def _fail_with_debug(page, debug_dir: Path, tag: str, message: str) -> None:
    """Save a screenshot + HTML dump for post-mortem, then raise loudly.

    A silently-empty result here is indistinguishable from 'genuinely zero
    rows this period' — that ambiguity is exactly what let scrape-earnings
    fail unnoticed for months. Fail loud instead.
    """
    debug_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    try:
        page.screenshot(path=str(debug_dir / f"{ts}-{tag}.png"))
        (debug_dir / f"{ts}-{tag}.html").write_text(page.content(), encoding="utf-8")
    except Exception:
        pass  # debug capture is best-effort; the real error below still raises
    raise ScrapeStructureError(f"{message} Debug artifacts: {debug_dir}/{ts}-{tag}.*")


def save_session(session_file: Path) -> None:
    """Launch headed Chromium and prompt user to log in to Associates Central.

    Saves browser storage state to session_file once the user confirms login
    is complete. Prints instructions to stdout.
    """
    session_file.parent.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=False)
        ctx = browser.new_context()
        page = ctx.new_page()

        page.goto(f"{ASSOC_CENTRAL}/ap/signin", wait_until="domcontentloaded", timeout=30_000)

        print(
            "\nComplete login in the browser window. "
            "Press Enter when done..."
        )
        input()

        ctx.storage_state(path=str(session_file))
        browser.close()

    print(f"Session saved to {session_file}")
