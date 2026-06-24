"""Associates Central earnings scraper — Playwright session-based."""
from __future__ import annotations

import csv
import io
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

ASSOC_CENTRAL = "https://affiliate-program.amazon.com"
REPORTS_URL = f"{ASSOC_CENTRAL}/home/reports"
LOGIN_PATTERNS = ("/ap/signin", "/ap/login")


class SessionExpiredError(Exception):
    """Raised when session file is missing or Associates Central redirects to login."""


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


def scrape_earnings(session_file: Path, days: int = 30) -> list[dict]:
    """Download daily earnings CSV from Associates Central.

    Uses a saved Playwright browser storage state (session_file) to authenticate.
    Raises SessionExpiredError if session file missing or page redirects to login.
    Returns list of daily dicts from parse_earnings_csv().
    """
    if not session_file.exists():
        raise SessionExpiredError(f"Session file not found: {session_file}")

    end_date = datetime.now(timezone.utc).date()
    start_date = end_date - timedelta(days=days - 1)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            ctx = browser.new_context(storage_state=str(session_file))
            page = ctx.new_page()

            # Navigate to reports page
            page.goto(REPORTS_URL, wait_until="domcontentloaded", timeout=30_000)

            # Check for login redirect
            current_url = page.url
            if any(pat in current_url for pat in LOGIN_PATTERNS):
                raise SessionExpiredError(
                    f"Session expired — redirected to login: {current_url}"
                )

            # Select "Daily Summary" report type
            try:
                # Look for a dropdown or select with report type options
                page.select_option("select[name*='reportType'], select[id*='reportType']",
                                   label="Daily Summary", timeout=10_000)
            except PWTimeout:
                # Try clicking via visible text as fallback
                try:
                    page.click("text=Daily Summary", timeout=5_000)
                except PWTimeout:
                    pass  # Best effort — page structure may vary

            # Set date range inputs
            start_str = start_date.strftime("%m/%d/%Y")
            end_str = end_date.strftime("%m/%d/%Y")

            for sel, val in [
                ("input[name*='startDate'], input[id*='startDate'], input[placeholder*='Start']", start_str),
                ("input[name*='endDate'], input[id*='endDate'], input[placeholder*='End']", end_str),
            ]:
                try:
                    page.fill(sel, val, timeout=5_000)
                except PWTimeout:
                    pass

            # Trigger CSV download
            csv_text: str = ""
            try:
                with page.expect_download(timeout=30_000) as dl_info:
                    # Click the export/download button
                    page.click(
                        "button:has-text('Export'), "
                        "a:has-text('Export'), "
                        "button:has-text('Download'), "
                        "a:has-text('Download'), "
                        "input[value*='Export'], "
                        "input[value*='Download']",
                        timeout=10_000,
                    )
                download = dl_info.value
                path = download.path()
                if path:
                    csv_text = Path(path).read_text(encoding="utf-8-sig")
            except PWTimeout:
                # Fallback: try reading page content as CSV if no download triggered
                content = page.content()
                if "Date" in content and "Clicks" in content:
                    # Page may render CSV inline in a <pre> or table — extract text
                    csv_text = page.inner_text("pre, .report-data, table") or ""
        finally:
            browser.close()

    if not csv_text:
        return []

    return parse_earnings_csv(csv_text)


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
