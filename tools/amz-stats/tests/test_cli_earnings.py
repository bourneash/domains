"""Tests for the earnings-writing side of the CLI (_num, _write_earnings)."""
from __future__ import annotations

import json
from pathlib import Path

from amz_stats.cli import _num, _write_earnings

# Real row shape from a live "Tracking ID" commission report — see
# tests/test_earnings.py's TRACKING_ID_CSV for the source CSV.
SAMPLE_ROWS = [
    {"tracking_id": "aliencouncil-20", "clicks": 10.0, "items_ordered": "-",
     "total_earnings": "-", "bonus": 0.0},
    {"tracking_id": "Other", "clicks": 629.0, "items_ordered": 28.0,
     "total_earnings": 4.92, "bonus": 0.0},
]


class TestNum:
    def test_coerces_dash_to_zero(self):
        assert _num("-") == 0.0

    def test_coerces_none_to_zero(self):
        assert _num(None) == 0.0

    def test_passes_through_numeric(self):
        assert _num(4.92) == 4.92

    def test_coerces_bad_string_to_zero_not_raise(self):
        assert _num("not-a-number") == 0.0


class TestWriteEarnings:
    def test_writes_timestamped_snapshot_and_latest(self, tmp_path: Path):
        _write_earnings(SAMPLE_ROWS, tmp_path, days=30, quiet=True)

        snapshots = list(tmp_path.glob("earnings-pull-*.jsonl"))
        assert len(snapshots) == 1
        lines = snapshots[0].read_text(encoding="utf-8").splitlines()
        assert len(lines) == 2
        assert json.loads(lines[0])["tracking_id"] == "aliencouncil-20"

        latest = json.loads((tmp_path / "earnings-latest.json").read_text(encoding="utf-8"))
        assert latest["days"] == 30
        assert len(latest["rows"]) == 2
        assert "pulled_at" in latest

    def test_totals_use_real_field_names_and_skip_dash(self, tmp_path: Path, capsys):
        _write_earnings(SAMPLE_ROWS, tmp_path, days=30, quiet=False)
        out = capsys.readouterr().out
        assert "clicks=639" in out       # 10 + 629
        assert "orders=28" in out        # '-' coerced to 0, + 28
        assert "earnings=$4.92" in out
