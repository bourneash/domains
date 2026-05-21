"""Tests for scripts.render_domains_index."""
from __future__ import annotations

import shutil
from pathlib import Path

from site_tracker.scripts import render_domains_index


def test_renders_active_and_parked_sections(tmp_path: Path):
    src = Path(__file__).parent / "fixtures" / "sites.yml"
    sy = tmp_path / "sites.yml"
    out = tmp_path / "DOMAINS_INDEX.md"
    shutil.copy(src, sy)
    render_domains_index.render(sy, out)
    text = out.read_text()
    assert "Active sites" in text
    assert "alpha.test" in text
    assert "Parked" in text
    assert "parked.test" in text
