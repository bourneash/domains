"""Tests for amz_stats.earnings — no Playwright required."""
from __future__ import annotations

from pathlib import Path

import pytest

from amz_stats.earnings import SessionExpiredError, parse_earnings_csv, scrape_earnings


# ---------------------------------------------------------------------------
# Sample CSV matching realistic Associates Central column names
# ---------------------------------------------------------------------------
SAMPLE_CSV = """\
Date,Clicks,Ordered Items,Shipped Items,Returns,Revenue,Conversion,Earnings Per Click,Commission Income
06/01/2024,120,5,4,0,$49.95,4.17%,$0.012,$3.50
06/02/2024,95,3,3,1,$29.99,3.16%,$0.009,$2.10
06/03/2024,200,10,9,0,$149.90,5.00%,$0.020,$12.00
"""


class TestParseEarningsCsv:
    def test_row_count(self):
        rows = parse_earnings_csv(SAMPLE_CSV)
        assert len(rows) == 3

    def test_snake_case_keys(self):
        rows = parse_earnings_csv(SAMPLE_CSV)
        row = rows[0]
        # All keys must be lower snake_case with no spaces
        for key in row:
            assert key == key.lower(), f"Key {key!r} is not lowercase"
            assert " " not in key, f"Key {key!r} contains a space"
        # Spot-check expected key names
        assert "date" in row
        assert "clicks" in row
        assert "ordered_items" in row
        assert "shipped_items" in row
        assert "returns" in row
        assert "revenue" in row
        assert "conversion" in row
        assert "earnings_per_click" in row
        assert "commission_income" in row

    def test_date_iso_format(self):
        rows = parse_earnings_csv(SAMPLE_CSV)
        assert rows[0]["date"] == "2024-06-01"
        assert rows[1]["date"] == "2024-06-02"
        assert rows[2]["date"] == "2024-06-03"

    def test_clicks_is_numeric(self):
        rows = parse_earnings_csv(SAMPLE_CSV)
        assert rows[0]["clicks"] == 120
        assert isinstance(rows[0]["clicks"], int)

    def test_ordered_items_is_numeric(self):
        rows = parse_earnings_csv(SAMPLE_CSV)
        assert rows[0]["ordered_items"] == 5
        assert isinstance(rows[0]["ordered_items"], int)

    def test_revenue_is_float(self):
        rows = parse_earnings_csv(SAMPLE_CSV)
        # $49.95 → 49.95
        assert rows[0]["revenue"] == pytest.approx(49.95)
        assert isinstance(rows[0]["revenue"], float)

    def test_commission_income_is_float(self):
        rows = parse_earnings_csv(SAMPLE_CSV)
        assert rows[0]["commission_income"] == pytest.approx(3.50)
        assert isinstance(rows[0]["commission_income"], float)

    def test_empty_csv_returns_empty_list(self):
        assert parse_earnings_csv("") == []

    def test_header_only_csv_returns_empty_list(self):
        header_only = "Date,Clicks,Commission Income\n"
        assert parse_earnings_csv(header_only) == []

    def test_already_iso_date_passes_through(self):
        csv_text = "Date,Clicks\n2024-06-15,10\n"
        rows = parse_earnings_csv(csv_text)
        assert rows[0]["date"] == "2024-06-15"


class TestScrapeEarningsSessionMissing:
    def test_raises_session_expired_error_when_file_absent(self, tmp_path: Path):
        missing = tmp_path / "no-such-session.json"
        assert not missing.exists()
        with pytest.raises(SessionExpiredError):
            scrape_earnings(missing, days=7)

    def test_error_message_contains_path(self, tmp_path: Path):
        missing = tmp_path / "no-such-session.json"
        with pytest.raises(SessionExpiredError, match=str(missing)):
            scrape_earnings(missing, days=7)
