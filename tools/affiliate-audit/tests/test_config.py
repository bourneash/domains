import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import config  # noqa: E402


def test_load_config_defaults_only():
    site_dir = Path(tempfile.mkdtemp())
    cfg = config.load_config(site_dir)
    assert cfg["checks"]["min_rating"] == 4.0
    assert cfg["pacing"]["min_delay_s"] == 12
    assert cfg["resolution"]["max_agent_turns"] == 20
    assert cfg["registry"]["path"] == "site/src/lib/affiliate.ts"


def test_load_config_site_override_merges_not_replaces():
    site_dir = Path(tempfile.mkdtemp())
    (site_dir / "ops").mkdir()
    (site_dir / "ops" / "affiliate-audit.yaml").write_text(
        "checks:\n  min_rating: 4.5\nregistry:\n  path: site/src/content/products\n"
    )
    cfg = config.load_config(site_dir)
    assert cfg["checks"]["min_rating"] == 4.5
    # untouched sibling keys survive the merge
    assert cfg["checks"]["oos_grace_runs"] == 2
    assert cfg["pacing"]["min_delay_s"] == 12
    assert cfg["registry"]["path"] == "site/src/content/products"
