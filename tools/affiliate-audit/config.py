"""Load fleet-default + per-site affiliate-audit config, deep-merged."""
from pathlib import Path

import yaml

_DEFAULT_PATH = Path(__file__).resolve().parent / "config.default.yaml"


def _deep_merge(base: dict, override: dict) -> dict:
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_config(site_dir: Path) -> dict:
    """site_dir is a site's repo root, e.g. sites/totaljerks.com/."""
    default = yaml.safe_load(_DEFAULT_PATH.read_text()) or {}
    override_path = Path(site_dir) / "ops" / "affiliate-audit.yaml"
    if override_path.exists():
        override = yaml.safe_load(override_path.read_text()) or {}
        return _deep_merge(default, override)
    return default
